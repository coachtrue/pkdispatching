/**
 * POST|GET /api/portal?action=<name> — the carrier-facing portal.
 *
 * Mirrors api/crm.js's single-function, ?action= sub-routing (same reason:
 * Vercel's Hobby plan caps serverless functions). Talks to a completely
 * separate credential system (api/_portal_auth.js) from the admin CRM.
 *
 * Public:
 *   login            exchange a carrier's email + password for a session cookie
 *   session          is the current cookie still valid, and for whom?
 *
 * Authenticated (carrier's own session only):
 *   logout           clear the session
 *   transactions     this carrier's loads and payments — nothing else's
 */

'use strict';

const auth = require('./_portal_auth');
const supabase = require('./_supabase');
const { readJson, clean } = require('./_lib');

/**
 * The only place a carrier_id is ever decided. Reads the account fresh from
 * Supabase using the id out of the *signed* cookie token — never anything
 * the client sends — and rejects a disabled account even if its cookie is
 * still cryptographically valid.
 */
async function currentAccount(req, res) {
  const accountId = auth.verify(req, res);
  if (!accountId) return null;

  const rows = await supabase.select('carrier_accounts', `select=*&id=eq.${encodeURIComponent(accountId)}&limit=1`);
  const account = rows[0];
  if (!account || !account.is_active) {
    res.status(401).json({ error: 'Not signed in.' });
    return null;
  }
  return account;
}

async function handleLogin(req, res) {
  if (!auth.isConfigured()) {
    res.status(503).json({ error: 'The carrier portal is not configured. Set PORTAL_SESSION_SECRET and redeploy.' });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    res.status(400).json({ error: 'Invalid request.' });
    return;
  }

  const email = clean(body.email, 200).toLowerCase();
  const password = String(body.password || '');

  // A deliberate delay blunts online guessing, same reasoning as admin login.
  await new Promise((resolve) => setTimeout(resolve, 400));

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }

  const rows = await supabase.select('carrier_accounts', `select=*&email=eq.${encodeURIComponent(email)}&limit=1`);
  const account = rows[0];

  // Same "incorrect email or password" message either way — don't confirm
  // which part was wrong, and don't skip the hash check when there's no
  // account, so a valid vs. invalid email isn't distinguishable by timing.
  const hashToCheck = account ? account.password_hash : auth.hashPassword('not-a-real-account');
  const passwordOk = auth.checkPasswordHash(password, hashToCheck);

  if (!account || !account.is_active || !passwordOk) {
    res.status(401).json({ error: 'Incorrect email or password.' });
    return;
  }

  await supabase.update('carrier_accounts', `id=eq.${encodeURIComponent(account.id)}`, {
    last_login_at: new Date().toISOString()
  });

  res.setHeader('Set-Cookie', auth.loginCookie(account.id));
  res.status(200).json({ ok: true });
}

async function handleSession(req, res) {
  if (!auth.isConfigured()) {
    res.status(200).json({ configured: false, signedIn: false });
    return;
  }
  const account = await currentAccountQuiet(req);
  res.status(200).json({
    configured: true,
    signedIn: Boolean(account),
    email: account ? account.email : null
  });
}

/** Like currentAccount, but never writes a response — used by the one route
 *  (session) that reports signed-out as a normal 200, not a 401. */
async function currentAccountQuiet(req) {
  const jar = auth.parseCookies(req.headers.cookie);
  const accountId = auth.readToken(jar[auth.COOKIE]);
  if (!accountId) return null;
  const rows = await supabase.select('carrier_accounts', `select=*&id=eq.${encodeURIComponent(accountId)}&limit=1`);
  const account = rows[0];
  return account && account.is_active ? account : null;
}

function handleLogout(req, res) {
  res.setHeader('Set-Cookie', auth.logoutCookie());
  res.status(200).json({ ok: true });
}

async function handleTransactions(req, res) {
  const account = await currentAccount(req, res);
  if (!account) return;

  const filter = `carrier_id=eq.${encodeURIComponent(account.carrier_id)}`;
  const [carrierRows, loads, payments] = await Promise.all([
    supabase.select('carriers', `select=company_name,reference&id=eq.${encodeURIComponent(account.carrier_id)}&limit=1`),
    supabase.select('loads', `select=*&${filter}&order=created_at.desc&limit=500`),
    supabase.select('payments', `select=*&${filter}&order=created_at.desc&limit=500`)
  ]);

  res.status(200).json({
    carrier: carrierRows[0] || null,
    loads,
    payments
  });
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const PUBLIC_ACTIONS = new Set(['login', 'session']);

const ROUTES = {
  login: handleLogin,
  session: handleSession,
  logout: handleLogout,
  transactions: handleTransactions
};

module.exports = async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const action = url.searchParams.get('action') || '';
  const route = ROUTES[action];

  res.setHeader('Cache-Control', 'no-store');

  if (!route) {
    res.status(404).json({ error: `Unknown action "${action}".` });
    return;
  }

  if (action !== 'session' && !supabase.isConfigured()) {
    res.status(503).json({ error: 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then redeploy.' });
    return;
  }

  try {
    await route(req, res, url);
  } catch (err) {
    console.error(`[portal:${action}]`, err.message);
    res.status(500).json({ error: 'Something went wrong. Check the function logs.' });
  }
};

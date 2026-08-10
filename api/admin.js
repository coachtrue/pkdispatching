/**
 * POST|GET /api/admin?action=<name> — the CRM back end.
 *
 * One function with sub-routing rather than a dozen route files: Vercel's
 * Hobby plan caps serverless functions, and these all share auth and the same
 * Supabase client.
 *
 * Public:
 *   login            exchange the password for a session cookie
 *   session          is the current cookie still valid?
 *
 * Authenticated:
 *   logout           clear the session
 *   stats            dashboard counters
 *   contacts         search / filter the unified contact list
 *   contact          one contact: full record, documents, activity timeline
 *   log              record a call, text, email, or note
 *   update           change status, owner, or follow-up date
 */

'use strict';

const auth = require('./_auth');
const supabase = require('./_supabase');
const { readJson, clean } = require('./_lib');

const CARRIER_STATUSES = ['new', 'verifying', 'approved', 'active', 'paused', 'rejected'];
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'];
const ACTIVITY_KINDS = ['call', 'sms', 'email', 'note', 'status'];
const DIRECTIONS = ['inbound', 'outbound'];

/** PostgREST puts the total count in a Content-Range header when asked. */
function table(contactType) {
  return contactType === 'lead' ? 'leads' : 'carriers';
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

async function handleLogin(req, res) {
  if (!auth.isConfigured()) {
    res.status(503).json({ error: 'Admin access is not configured. Set ADMIN_PASSWORD and redeploy.' });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    res.status(400).json({ error: 'Invalid request.' });
    return;
  }

  // A deliberate delay blunts online guessing. Serverless instances are
  // ephemeral, so an in-memory attempt counter would not survive anyway.
  await new Promise((resolve) => setTimeout(resolve, 400));

  if (!auth.checkPassword(body.password || '')) {
    res.status(401).json({ error: 'Incorrect password.' });
    return;
  }

  res.setHeader('Set-Cookie', auth.loginCookie());
  res.status(200).json({ ok: true });
}

function handleSession(req, res) {
  const jar = auth.parseCookies(req.headers.cookie);
  res.status(200).json({
    configured: auth.isConfigured(),
    signedIn: auth.isConfigured() && auth.tokenValid(jar[auth.COOKIE])
  });
}

function handleLogout(req, res) {
  res.setHeader('Set-Cookie', auth.logoutCookie());
  res.status(200).json({ ok: true });
}

async function handleStats(req, res) {
  const today = new Date().toISOString().slice(0, 10);

  const [carriers, leads] = await Promise.all([
    supabase.select('carriers', 'select=status,created_at,next_follow_up&limit=2000'),
    supabase.select('leads', 'select=status,created_at,next_follow_up&limit=2000')
  ]);

  const isToday = (row) => String(row.created_at || '').slice(0, 10) === today;
  const dueBy = (row) => row.next_follow_up && row.next_follow_up <= today;

  res.status(200).json({
    carriers: {
      total: carriers.length,
      new: carriers.filter((c) => c.status === 'new').length,
      verifying: carriers.filter((c) => c.status === 'verifying').length,
      active: carriers.filter((c) => c.status === 'active' || c.status === 'approved').length,
      today: carriers.filter(isToday).length
    },
    leads: {
      total: leads.length,
      new: leads.filter((l) => l.status === 'new').length,
      today: leads.filter(isToday).length
    },
    followUpsDue: carriers.filter(dueBy).length + leads.filter(dueBy).length
  });
}

async function handleContacts(req, res, url) {
  const search = clean(url.searchParams.get('q'), 80);
  const type = url.searchParams.get('type');
  const status = clean(url.searchParams.get('status'), 40);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 300);

  const parts = ['select=*', `limit=${limit}`, 'order=created_at.desc'];

  if (type === 'lead' || type === 'carrier') {
    parts.push(`contact_type=eq.${type}`);
  }
  if (status) {
    parts.push(`status=eq.${encodeURIComponent(status)}`);
  }
  if (search) {
    // Commas and parens are PostgREST syntax inside or=(), so strip them
    // rather than let a search box alter the filter's shape.
    const safe = search.replace(/[(),*]/g, ' ').trim();
    if (safe) {
      const like = `*${encodeURIComponent(safe)}*`;
      parts.push(`or=(name.ilike.${like},contact_name.ilike.${like},email.ilike.${like},phone.ilike.${like},mc_number.ilike.${like},reference.ilike.${like})`);
    }
  }

  const rows = await supabase.select('crm_contacts', parts.join('&'));
  res.status(200).json({ contacts: rows });
}

async function handleContact(req, res, url) {
  const reference = clean(url.searchParams.get('reference'), 40);
  const contactType = url.searchParams.get('type') === 'lead' ? 'lead' : 'carrier';
  if (!reference) {
    res.status(400).json({ error: 'reference is required.' });
    return;
  }

  const filter = `reference=eq.${encodeURIComponent(reference)}`;
  const [records, activities] = await Promise.all([
    supabase.select(table(contactType), `select=*&${filter}&limit=1`),
    supabase.select('activities', `select=*&contact_ref=eq.${encodeURIComponent(reference)}&order=created_at.desc&limit=200`)
  ]);

  const record = records[0];
  if (!record) {
    res.status(404).json({ error: 'Contact not found.' });
    return;
  }

  // Documents get fresh 1-hour links, minted per view rather than stored, so
  // an old dashboard tab can't keep handing out access to a W-9.
  let documents = [];
  if (contactType === 'carrier') {
    const rows = await supabase.select('carrier_documents', `select=*&${filter}&order=created_at.asc`);
    documents = await Promise.all(rows.map(async (doc) => ({
      id: doc.id,
      category: doc.category,
      fileName: doc.file_name,
      bytes: doc.bytes,
      createdAt: doc.created_at,
      link: await supabase.signedUrl(doc.storage_path, 60 * 60)
    })));
  }

  res.status(200).json({ contactType, record, documents, activities });
}

async function handleLog(req, res) {
  const body = await readJson(req);
  const reference = clean(body.reference, 40);
  const contactType = body.contactType === 'lead' ? 'lead' : 'carrier';
  const kind = ACTIVITY_KINDS.includes(body.kind) ? body.kind : 'note';
  const direction = DIRECTIONS.includes(body.direction) ? body.direction : null;

  if (!reference) {
    res.status(400).json({ error: 'reference is required.' });
    return;
  }
  const text = clean(body.body, 4000);
  if (!text) {
    res.status(400).json({ error: 'Write something before saving.' });
    return;
  }

  const activity = await supabase.insert('activities', {
    contact_type: contactType,
    contact_ref: reference,
    kind,
    direction,
    subject: clean(body.subject, 200) || null,
    body: text,
    created_by: clean(body.createdBy, 80) || 'admin'
  });

  // Logging a real conversation counts as contact; a private note doesn't.
  if (kind !== 'note') {
    await supabase.update(table(contactType), `reference=eq.${encodeURIComponent(reference)}`, {
      last_contacted_at: new Date().toISOString()
    });
  }

  res.status(200).json({ ok: true, activity });
}

async function handleUpdate(req, res) {
  const body = await readJson(req);
  const reference = clean(body.reference, 40);
  const contactType = body.contactType === 'lead' ? 'lead' : 'carrier';
  if (!reference) {
    res.status(400).json({ error: 'reference is required.' });
    return;
  }

  const patch = {};
  const allowed = contactType === 'lead' ? LEAD_STATUSES : CARRIER_STATUSES;

  if (body.status !== undefined) {
    if (!allowed.includes(body.status)) {
      res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
      return;
    }
    patch.status = body.status;
  }
  if (body.owner !== undefined) patch.owner = clean(body.owner, 80) || null;
  if (body.nextFollowUp !== undefined) {
    const date = clean(body.nextFollowUp, 10);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Follow-up date must be YYYY-MM-DD.' });
      return;
    }
    patch.next_follow_up = date || null;
  }

  if (!Object.keys(patch).length) {
    res.status(400).json({ error: 'Nothing to update.' });
    return;
  }

  const record = await supabase.update(
    table(contactType),
    `reference=eq.${encodeURIComponent(reference)}`,
    patch
  );

  // A status change belongs in the timeline — it's how you reconstruct
  // what happened to a carrier three months later.
  if (patch.status) {
    await supabase.insert('activities', {
      contact_type: contactType,
      contact_ref: reference,
      kind: 'status',
      body: `Status changed to "${patch.status}".`,
      created_by: 'admin'
    });
  }

  res.status(200).json({ ok: true, record });
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const PUBLIC_ACTIONS = new Set(['login', 'session']);

const ROUTES = {
  login: handleLogin,
  session: handleSession,
  logout: handleLogout,
  stats: handleStats,
  contacts: handleContacts,
  contact: handleContact,
  log: handleLog,
  update: handleUpdate
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

  if (!PUBLIC_ACTIONS.has(action) && !auth.verify(req, res)) return;

  if (!PUBLIC_ACTIONS.has(action) && action !== 'logout' && !supabase.isConfigured()) {
    res.status(503).json({ error: 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then redeploy.' });
    return;
  }

  try {
    await route(req, res, url);
  } catch (err) {
    console.error(`[admin:${action}]`, err.message);
    res.status(500).json({ error: 'Something went wrong. Check the function logs.' });
  }
};

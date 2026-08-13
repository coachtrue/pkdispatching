/**
 * Admin session handling.
 *
 * The dashboard exposes carrier PII — MC numbers, phone numbers, and signed
 * links to W-9s and CDLs — so every admin endpoint goes through verify().
 *
 * Design: a single shared password (ADMIN_PASSWORD) is exchanged for a signed,
 * expiring session cookie. No session store, which suits serverless — the
 * cookie carries its own proof. Right for a small team; if you ever need
 * per-user logins and an audit trail per person, move to Supabase Auth and
 * swap this file out.
 *
 * Environment:
 *   ADMIN_PASSWORD        required — the dashboard password
 *   ADMIN_SESSION_SECRET  optional — HMAC key; derived from the password if unset
 */

'use strict';

const crypto = require('crypto');

const COOKIE = 'lp3_admin';
const TTL_SECONDS = 60 * 60 * 12; // 12 hours

function password() {
  return process.env.ADMIN_PASSWORD || '';
}

function isConfigured() {
  return password().length > 0;
}

function secret() {
  // Deriving from the password means changing the password invalidates every
  // existing session, which is the behaviour you want from a password change.
  return process.env.ADMIN_SESSION_SECRET || `derived:${password()}`;
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

/** Compare two strings without leaking length or content through timing. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, so hash first to equalise.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function checkPassword(attempt) {
  if (!isConfigured()) return false;
  return safeEqual(attempt, password());
}

/** token = <expiryEpoch>.<hmac(expiry)> */
function issueToken() {
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  return `${expires}.${sign(String(expires))}`;
}

function tokenValid(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;

  const expires = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  if (!/^\d+$/.test(expires)) return false;
  if (Number(expires) * 1000 < Date.now()) return false;

  return safeEqual(signature, sign(expires));
}

function parseCookies(header) {
  const jar = Object.create(null);
  if (!header) return jar;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    jar[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return jar;
}

function sessionCookie(token, maxAge) {
  const attrs = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`
  ];
  // Vercel is always HTTPS; localhost is not, and Secure would break dev.
  if (process.env.VERCEL) attrs.push('Secure');
  return attrs.join('; ');
}

function loginCookie() { return sessionCookie(issueToken(), TTL_SECONDS); }
function logoutCookie() { return sessionCookie('', 0); }

/**
 * Gate an admin request. Returns true when allowed; otherwise writes the
 * response itself and returns false, so callers can `if (!verify(...)) return;`
 */
function verify(req, res) {
  if (!isConfigured()) {
    res.status(503).json({ error: 'Admin access is not configured. Set ADMIN_PASSWORD and redeploy.' });
    return false;
  }
  const jar = parseCookies(req.headers.cookie);
  if (!tokenValid(jar[COOKIE])) {
    res.status(401).json({ error: 'Not signed in.' });
    return false;
  }
  return true;
}

module.exports = {
  COOKIE,
  TTL_SECONDS,
  isConfigured,
  checkPassword,
  issueToken,
  tokenValid,
  parseCookies,
  loginCookie,
  logoutCookie,
  verify
};

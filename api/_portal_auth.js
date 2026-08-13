/**
 * Carrier portal session handling.
 *
 * Separate from api/_auth.js on purpose: that file gates one shared admin
 * password behind one cookie. This one gates many carrier accounts, each
 * with its own scrypt-hashed password, behind a different cookie — so a
 * leak or bug in one system can't cross into the other's credential space.
 *
 * Design: verify() only checks the cookie's cryptographic validity (cheap,
 * no I/O) and hands back the account id it was issued for. It deliberately
 * does NOT confirm the account still exists or is still active — that
 * requires a Supabase lookup, which the caller (api/portal.js) already has
 * to do to fetch the carrier's own data, so it does the is_active check
 * there instead of paying for two round-trips. The carrier_id a request
 * ultimately reads from is always the one attached to that freshly-looked-up
 * account row — never anything the client sends — so one carrier can't ask
 * for another's data by editing a request.
 *
 * Environment:
 *   PORTAL_SESSION_SECRET  required — HMAC key for portal session tokens.
 *                           No derived fallback (unlike admin) because there
 *                           is no single password to derive one from.
 */

'use strict';

const crypto = require('crypto');

const COOKIE = 'lp3_portal';
const TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days — a carrier checking pay stubs, not an admin tool

function secret() {
  return process.env.PORTAL_SESSION_SECRET || '';
}

function isConfigured() {
  return secret().length > 0;
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

/** Compare two strings without leaking length or content through timing. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Password storage: scrypt with a random salt, stored as "salt:hash" hex.
 * No external dependency — scrypt is built into Node and is a reasonable,
 * modern choice for password hashing.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function checkPasswordHash(attempt, stored) {
  if (!attempt || !stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  let attemptHash;
  try {
    attemptHash = crypto.scryptSync(String(attempt), salt, 64);
  } catch {
    return false;
  }
  const storedHash = Buffer.from(hash, 'hex');
  if (attemptHash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(attemptHash, storedHash);
}

/** Generate a random password for staff to hand a carrier at account creation. */
function generatePassword() {
  // Base32-ish alphabet with ambiguous characters (0/O, 1/I/l) removed —
  // this gets read aloud or typed off a screen by hand.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/** token = <accountId>.<expiryEpoch>.<hmac(accountId + "." + expiry)> */
function issueToken(accountId) {
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  return `${accountId}.${expires}.${sign(`${accountId}.${expires}`)}`;
}

/** Returns the accountId the token was validly issued for, or null. */
function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [accountId, expires, signature] = parts;

  if (!accountId || !/^\d+$/.test(expires)) return null;
  if (Number(expires) * 1000 < Date.now()) return null;
  if (!safeEqual(signature, sign(`${accountId}.${expires}`))) return null;

  return accountId;
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
  if (process.env.VERCEL) attrs.push('Secure');
  return attrs.join('; ');
}

function loginCookie(accountId) { return sessionCookie(issueToken(accountId), TTL_SECONDS); }
function logoutCookie() { return sessionCookie('', 0); }

/**
 * Gate a portal request on cookie validity alone. Returns the accountId on
 * success; otherwise writes the response itself and returns null, so
 * callers can `const accountId = verify(...); if (!accountId) return;` —
 * then look the account up fresh to confirm it's still active and to get
 * its carrier_id.
 */
function verify(req, res) {
  if (!isConfigured()) {
    res.status(503).json({ error: 'The carrier portal is not configured. Set PORTAL_SESSION_SECRET and redeploy.' });
    return null;
  }
  const jar = parseCookies(req.headers.cookie);
  const accountId = readToken(jar[COOKIE]);
  if (!accountId) {
    res.status(401).json({ error: 'Not signed in.' });
    return null;
  }
  return accountId;
}

module.exports = {
  COOKIE,
  TTL_SECONDS,
  isConfigured,
  hashPassword,
  checkPasswordHash,
  generatePassword,
  issueToken,
  readToken,
  parseCookies,
  loginCookie,
  logoutCookie,
  verify
};

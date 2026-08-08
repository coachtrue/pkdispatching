/**
 * Minimal Supabase client over the REST API.
 *
 * Deliberately dependency-free: the whole project is zero-install, and the
 * Storage/PostgREST endpoints used here are small and stable. Swap in
 * @supabase/supabase-js later if you want the full SDK — only this file
 * would change.
 *
 * Requires (set in Vercel → Settings → Environment Variables):
 *   SUPABASE_URL               https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  service_role key — SERVER ONLY, never shipped
 *                              to the browser. It bypasses Row Level Security.
 */

'use strict';

const BUCKET = process.env.SUPABASE_BUCKET || 'carrier-packets';

function config() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { url, key, ready: Boolean(url && key) };
}

function isConfigured() {
  return config().ready;
}

function headers(extra) {
  const { key } = config();
  return Object.assign({
    apikey: key,
    Authorization: `Bearer ${key}`
  }, extra || {});
}

/** Insert a row and return it. Throws on failure so callers can degrade. */
async function insert(table, row) {
  const { url } = config();
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }),
    body: JSON.stringify(row)
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase insert into ${table} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const rows = text ? JSON.parse(text) : [];
  return Array.isArray(rows) ? rows[0] : rows;
}

/** Upload raw bytes to the private bucket. Returns the storage path. */
async function uploadObject(objectPath, data, contentType) {
  const { url } = config();
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');

  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${encoded}`, {
    method: 'POST',
    headers: headers({
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': '3600',
      'x-upsert': 'false'
    }),
    body: data
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Supabase upload failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  return objectPath;
}

/**
 * Mint a time-limited link to a private object. Used so the notification you
 * receive has clickable documents without making the bucket public.
 */
async function signedUrl(objectPath, expiresIn) {
  const { url } = config();
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');

  const res = await fetch(`${url}/storage/v1/object/sign/${BUCKET}/${encoded}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn: expiresIn || 60 * 60 * 24 * 7 })
  });

  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  if (!body.signedURL && !body.signedUrl) return null;
  const relative = body.signedURL || body.signedUrl;
  return `${url}/storage/v1${relative.startsWith('/') ? '' : '/'}${relative}`;
}

module.exports = { BUCKET, isConfigured, insert, uploadObject, signedUrl };

/**
 * POST /api/upload?name=<filename>&category=<doc key>&reference=<ref>
 *
 * Body: the raw file bytes (not multipart). One file per request.
 *
 * Why one file per request instead of one big multipart POST: Vercel
 * serverless functions cap the request body at ~4.5 MB, so a whole carrier
 * packet in a single request would fail. Uploading each document separately
 * keeps every request small and lets the UI show per-file progress.
 *
 * Files land in a PRIVATE Supabase Storage bucket. Nothing here is publicly
 * readable — the onboarding endpoint mints short-lived signed links.
 */

'use strict';

const supabase = require('./_supabase');

const MAX_FILE_BYTES = 4 * 1024 * 1024; // stay under Vercel's ~4.5 MB body cap

const ALLOWED = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.webp': 'image/webp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

const CATEGORIES = new Set(['authority', 'insurance', 'w9', 'noa', 'cdl', 'other']);

function extensionOf(name) {
  const i = String(name).lastIndexOf('.');
  return i === -1 ? '' : String(name).slice(i).toLowerCase();
}

function safeName(name) {
  const cleaned = String(name || 'file')
    .replace(/[\\/]/g, '_')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(-120);
  return cleaned && cleaned !== '.' ? cleaned : 'file';
}

async function readRaw(req) {
  // Vercel may have already buffered the body depending on content type.
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'binary');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const category = url.searchParams.get('category') || 'other';

    if (!CATEGORIES.has(category)) {
      res.status(400).json({ error: 'Unknown document category.' });
      return;
    }

    const name = safeName(url.searchParams.get('name') || 'document');
    const ext = extensionOf(name);
    if (!ALLOWED[ext]) {
      res.status(415).json({ error: 'Unsupported file type. Send PDF, JPG, PNG, HEIC, WEBP, DOC, or DOCX.' });
      return;
    }

    const data = await readRaw(req);
    if (!data.length) {
      res.status(400).json({ error: 'Empty file.' });
      return;
    }
    if (data.length > MAX_FILE_BYTES) {
      res.status(413).json({ error: 'File is larger than 4 MB. Email it to packets@pkdispatching.com instead.' });
      return;
    }

    if (!supabase.isConfigured()) {
      res.status(503).json({
        error: 'Document storage is not configured yet. Please email your packet to packets@pkdispatching.com.'
      });
      return;
    }

    const reference = /^(?:LP3|HV|PK)-\d{6}-[A-Z0-9]{5,6}$/.test(url.searchParams.get('reference') || '')
      ? url.searchParams.get('reference')
      : 'unfiled';

    // Random prefix keeps two carriers uploading "coi.pdf" from colliding.
    const unique = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const objectPath = `${reference}/${category}-${unique}-${name}`;

    await supabase.uploadObject(objectPath, data, ALLOWED[ext]);

    res.status(200).json({
      ok: true,
      path: objectPath,
      category,
      name,
      contentType: ALLOWED[ext],
      bytes: data.length
    });
  } catch (err) {
    console.error('[upload]', err.message);
    res.status(500).json({ error: 'Upload failed. Please try again, or email your packet.' });
  }
};

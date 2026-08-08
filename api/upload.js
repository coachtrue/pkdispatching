/**
 * POST /api/upload?name=<filename>&category=<doc key>
 *
 * Body: the raw file bytes (not multipart). One file per request.
 *
 * Why one file per request instead of one big multipart POST: Vercel
 * serverless functions cap the request body at ~4.5 MB, so a whole carrier
 * packet in a single request would fail. Uploading each document separately
 * keeps every request small and lets the UI show per-file progress.
 *
 * Files land in Vercel Blob. Requires a Blob store connected to the project,
 * which supplies BLOB_READ_WRITE_TOKEN automatically.
 */

'use strict';

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
  return String(name || 'file')
    .replace(/[\\/]/g, '_')
    .replace(/[^\w.\- ]+/g, '_')
    .slice(-120) || 'file';
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
    const rawName = url.searchParams.get('name') || 'document';
    const category = url.searchParams.get('category') || 'other';

    if (!CATEGORIES.has(category)) {
      res.status(400).json({ error: 'Unknown document category.' });
      return;
    }

    const name = safeName(rawName);
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

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      res.status(503).json({
        error: 'Document storage is not configured yet. Please email your packet to packets@pkdispatching.com.'
      });
      return;
    }

    let put;
    try {
      ({ put } = require('@vercel/blob'));
    } catch {
      res.status(503).json({ error: 'Document storage unavailable. Please email your packet instead.' });
      return;
    }

    const reference = (url.searchParams.get('reference') || 'unfiled').replace(/[^\w-]/g, '');
    const blob = await put(`carrier-packets/${reference}/${category}-${name}`, data, {
      access: 'public',        // unguessable random URL; see the privacy note in README
      addRandomSuffix: true,
      contentType: ALLOWED[ext]
    });

    res.status(200).json({
      ok: true,
      url: blob.url,
      pathname: blob.pathname,
      category,
      name,
      bytes: data.length
    });
  } catch (err) {
    console.error('[upload]', err);
    res.status(500).json({ error: 'Upload failed. Please try again or email your packet.' });
  }
};

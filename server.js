#!/usr/bin/env node
/**
 * PK Dispatching — static host + carrier intake API.
 *
 * Zero dependencies: run it with `node server.js` on any Node 18+ install.
 *
 *   GET  /*                serves the landing page and assets
 *   POST /api/leads        JSON      -> data/leads.ndjson
 *   POST /api/onboarding   multipart -> data/onboarding.ndjson + data/uploads/<ref>/
 *
 * Environment:
 *   PORT           listen port (default 3000)
 *   DATA_DIR       where submissions and uploads are written (default ./data)
 *   NOTIFY_WEBHOOK optional URL that receives a JSON summary of each submission
 *                  (Slack incoming webhook, Zapier catch hook, your CRM, etc.)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const NOTIFY_WEBHOOK = process.env.NOTIFY_WEBHOOK || '';

const MAX_JSON_BYTES = 512 * 1024;       // 512 KB of form fields
const MAX_FILE_BYTES = 4 * 1024 * 1024;  // 4 MB per file (matches the UI and Vercel's body cap)
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.webp', '.doc', '.docx']);
const CATEGORIES = new Set(['authority', 'insurance', 'w9', 'noa', 'cdl', 'other']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function reference() {
  const now = new Date();
  const stamp = String(now.getFullYear()).slice(2) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  return `PK-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Strip directories and anything that isn't a safe filename character. */
function safeFilename(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').trim();
  const trimmed = base.slice(-120) || 'file';
  return trimmed.startsWith('.') ? `file${trimmed}` : trimmed;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (chunk) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > limit) {
        // Stop buffering but leave the socket alive long enough to send a
        // real 413 — destroying it here would surface as a network error.
        overflowed = true;
        chunks.length = 0;
        req.pause();
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function appendRecord(file, record) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.appendFile(path.join(DATA_DIR, file), JSON.stringify(record) + '\n', 'utf8');
}

async function notify(summary) {
  if (!NOTIFY_WEBHOOK) return;
  try {
    await fetch(NOTIFY_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(summary)
    });
  } catch (err) {
    console.error('[notify] webhook failed:', err.message);
  }
}

/* ------------------------------------------------------------------ *
 * Route: POST /api/leads
 * ------------------------------------------------------------------ */

async function handleLead(req, res) {
  const raw = await readBody(req, MAX_JSON_BYTES);

  let data;
  try {
    data = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  if (data.website) {
    // Honeypot tripped — accept silently so the bot doesn't learn anything.
    return sendJson(res, 200, { ok: true });
  }

  const missing = ['name', 'email', 'phone'].filter((key) => !String(data[key] || '').trim());
  if (missing.length) {
    return sendJson(res, 400, { error: `Missing required field(s): ${missing.join(', ')}` });
  }

  const record = {
    reference: reference(),
    receivedAt: new Date().toISOString(),
    ip: req.socket.remoteAddress,
    ...data
  };
  delete record.website;

  await appendRecord('leads.ndjson', record);
  await notify({
    type: 'lead',
    reference: record.reference,
    name: record.name,
    phone: record.phone,
    email: record.email,
    equipment: record.equipment || null,
    topic: record.topic || null
  });

  console.log(`[lead] ${record.reference} — ${record.name} <${record.email}>`);
  sendJson(res, 200, { ok: true, reference: record.reference });
}

/* ------------------------------------------------------------------ *
 * Route: POST /api/onboarding
 * ------------------------------------------------------------------ */

/**
 * POST /api/upload?name=&category=&reference= — one raw file per request.
 * Mirrors the Vercel function so local and production behave identically;
 * here the bytes land on disk instead of in Supabase Storage.
 */
async function handleUpload(req, res, url) {
  const rawName = url.searchParams.get('name') || 'document';
  const category = url.searchParams.get('category') || 'other';

  if (!CATEGORIES.has(category)) {
    return sendJson(res, 400, { error: 'Unknown document category.' });
  }

  const name = safeFilename(rawName);
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return sendJson(res, 415, { error: 'Unsupported file type.' });
  }

  const data = await readBody(req, MAX_FILE_BYTES);
  if (!data.length) return sendJson(res, 400, { error: 'Empty file.' });

  const ref = /^PK-\d{6}-[A-Z0-9]{5,6}$/.test(url.searchParams.get('reference') || '')
    ? url.searchParams.get('reference')
    : 'unfiled';

  const targetDir = path.join(UPLOAD_DIR, ref);
  await fsp.mkdir(targetDir, { recursive: true });

  let stored = `${category}-${name}`;
  let attempt = 1;
  while (fs.existsSync(path.join(targetDir, stored))) {
    stored = `${category}-${attempt++}-${name}`;
  }
  await fsp.writeFile(path.join(targetDir, stored), data);

  console.log(`[upload] ${ref} — ${stored} (${data.length} bytes)`);
  sendJson(res, 200, {
    ok: true,
    path: `${ref}/${stored}`,
    localFile: path.resolve(targetDir, stored),
    category,
    name,
    bytes: data.length
  });
}

/** POST /api/onboarding — JSON carrier details plus already-uploaded document refs. */
async function handleOnboarding(req, res) {
  const raw = await readBody(req, MAX_JSON_BYTES);

  let fields;
  try {
    fields = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  if (fields.website) return sendJson(res, 200, { ok: true });

  const missing = ['companyName', 'contactName', 'phone', 'email', 'mcNumber', 'dotNumber']
    .filter((key) => !String(fields[key] || '').trim());
  if (missing.length) {
    return sendJson(res, 400, { error: `Missing required field(s): ${missing.join(', ')}` });
  }

  const ref = String(fields.reference || '').match(/^PK-\d{6}-[A-Z0-9]{5,6}$/)
    ? fields.reference
    : reference();

  const documents = Array.isArray(fields.documents) ? fields.documents : [];

  const record = {
    reference: ref,
    receivedAt: new Date().toISOString(),
    ip: req.socket.remoteAddress,
    fields: { ...fields },
    documents
  };
  delete record.fields.website;
  delete record.fields.documents;

  await appendRecord('onboarding.ndjson', record);
  const targetDir = path.join(UPLOAD_DIR, ref);
  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.writeFile(path.join(targetDir, 'submission.json'), JSON.stringify(record, null, 2), 'utf8');

  await notify({
    type: 'onboarding',
    reference: ref,
    company: fields.companyName,
    contact: fields.contactName,
    phone: fields.phone,
    email: fields.email,
    mc: fields.mcNumber,
    dot: fields.dotNumber,
    equipment: fields.equipment,
    trucks: fields.truckCount,
    documentsReceived: documents.length
  });

  console.log(`[onboarding] ${ref} — ${fields.companyName} (${documents.length} document(s))`);
  sendJson(res, 200, { ok: true, reference: ref, documentsReceived: documents.length });
}

/* ------------------------------------------------------------------ *
 * Static files
 * ------------------------------------------------------------------ */

async function serveStatic(req, res, pathname) {
  const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const filePath = path.join(ROOT, relative);

  // Refuse anything that escapes the site root or reaches into stored data.
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(ROOT) + path.sep) ||
      resolved.startsWith(path.resolve(DATA_DIR))) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  // Mirrors Vercel's cleanUrls: true — /admin serves admin.html — so local
  // dev and production agree on which URLs work.
  const candidates = path.extname(resolved)
    ? [resolved]
    : [resolved, `${resolved}.html`];

  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isDirectory()) continue;

      const ext = path.extname(candidate).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff'
      });
      fs.createReadStream(candidate).pipe(res);
      return;
    } catch {
      // Try the next candidate.
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h1>404 — Not found</h1><p><a href="/">Back to PK Dispatching</a></p>');
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'POST' && url.pathname === '/api/leads') {
      return await handleLead(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      return await handleUpload(req, res, url);
    }
    if (req.method === 'POST' && url.pathname === '/api/onboarding') {
      return await handleOnboarding(req, res);
    }
    // The admin CRM runs the very same handler Vercel will execute, wrapped
    // in a minimal res shim, so local behaviour matches production exactly.
    if (url.pathname === '/api/admin') {
      const shim = Object.assign(res, {
        status(code) { res.statusCode = code; return res; },
        json(payload) {
          const text = JSON.stringify(payload);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(text);
          return res;
        }
      });
      return await require('./api/admin.js')(req, shim);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, uptime: process.uptime() });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return await serveStatic(req, res, url.pathname);
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[error]', err.message);
    if (!res.headersSent) {
      sendJson(res, err.statusCode || 500, {
        error: err.statusCode === 413
          ? 'File is larger than 4 MB. Email it to packets@pkdispatching.com instead.'
          : 'Server error.'
      });
    }
    // The request body may still be arriving; close the socket once the
    // response has flushed so the client isn't left waiting.
    if (err.statusCode === 413) res.on('finish', () => req.destroy());
  }
});

server.listen(PORT, () => {
  console.log(`PK Dispatching running at http://localhost:${PORT}`);
  console.log(`Submissions -> ${DATA_DIR}`);
  if (!NOTIFY_WEBHOOK) console.log('Set NOTIFY_WEBHOOK to forward submissions to Slack/Zapier/your CRM.');
});

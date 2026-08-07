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

const MAX_JSON_BYTES = 256 * 1024;          // 256 KB
const MAX_UPLOAD_BYTES = 120 * 1024 * 1024; // 120 MB per submission
const MAX_FILE_BYTES = 15 * 1024 * 1024;    // 15 MB per file (matches the UI)
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.webp', '.doc', '.docx']);

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
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
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
 * multipart/form-data parser
 * ------------------------------------------------------------------ */

function parseMultipart(buffer, boundary) {
  const fields = Object.create(null);
  const files = [];

  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let position = buffer.indexOf(delimiter);

  while (position !== -1) {
    const start = position + delimiter.length;
    // Trailing "--" marks the final boundary.
    if (buffer.slice(start, start + 2).toString() === '--') break;
    const next = buffer.indexOf(delimiter, start);
    if (next === -1) break;
    // Skip the CRLF after the boundary and drop the CRLF before the next one.
    parts.push(buffer.slice(start + 2, next - 2));
    position = next;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headers = part.slice(0, headerEnd).toString('utf8');
    const content = part.slice(headerEnd + 4);

    const nameMatch = /name="([^"]*)"/i.exec(headers);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const filenameMatch = /filename="([^"]*)"/i.exec(headers);

    if (filenameMatch && filenameMatch[1]) {
      files.push({ field: name, filename: filenameMatch[1], data: content });
    } else {
      fields[name] = content.toString('utf8');
    }
  }

  return { fields, files };
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

async function handleOnboarding(req, res) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) {
    return sendJson(res, 400, { error: 'Expected multipart/form-data.' });
  }

  const raw = await readBody(req, MAX_UPLOAD_BYTES);
  const { fields, files } = parseMultipart(raw, (boundaryMatch[1] || boundaryMatch[2]).trim());

  if (fields.website) return sendJson(res, 200, { ok: true });

  const missing = ['companyName', 'contactName', 'phone', 'email', 'mcNumber', 'dotNumber']
    .filter((key) => !String(fields[key] || '').trim());
  if (missing.length) {
    return sendJson(res, 400, { error: `Missing required field(s): ${missing.join(', ')}` });
  }

  const ref = String(fields.reference || '').match(/^PK-\d{6}-[A-Z0-9]{5,6}$/)
    ? fields.reference
    : reference();

  const targetDir = path.join(UPLOAD_DIR, ref);
  await fsp.mkdir(targetDir, { recursive: true });

  const saved = [];
  const rejected = [];

  for (const file of files) {
    const name = safeFilename(file.filename);
    const ext = path.extname(name).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      rejected.push({ filename: file.filename, reason: 'unsupported file type' });
      continue;
    }
    if (file.data.length > MAX_FILE_BYTES) {
      rejected.push({ filename: file.filename, reason: 'exceeds 15 MB' });
      continue;
    }
    if (file.data.length === 0) continue;

    // Prefix with the document category so the folder reads at a glance.
    const category = file.field.replace(/^doc_/, '');
    let stored = `${category}-${name}`;
    let attempt = 1;
    while (fs.existsSync(path.join(targetDir, stored))) {
      stored = `${category}-${attempt++}-${name}`;
    }

    await fsp.writeFile(path.join(targetDir, stored), file.data);
    saved.push({ category, storedAs: stored, originalName: file.filename, bytes: file.data.length });
  }

  const record = {
    reference: ref,
    receivedAt: new Date().toISOString(),
    ip: req.socket.remoteAddress,
    fields: { ...fields },
    documents: saved,
    rejectedDocuments: rejected
  };
  delete record.fields.website;

  await appendRecord('onboarding.ndjson', record);
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
    documentsReceived: saved.length,
    documentsRejected: rejected.length
  });

  console.log(`[onboarding] ${ref} — ${fields.companyName} (${saved.length} document(s))`);
  sendJson(res, 200, {
    ok: true,
    reference: ref,
    documentsReceived: saved.length,
    rejectedDocuments: rejected
  });
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

  try {
    const stat = await fsp.stat(resolved);
    if (stat.isDirectory()) throw new Error('directory');

    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(resolved).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404 — Not found</h1><p><a href="/">Back to PK Dispatching</a></p>');
  }
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
    if (req.method === 'POST' && url.pathname === '/api/onboarding') {
      return await handleOnboarding(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, uptime: process.uptime() });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return await serveStatic(req, res, url.pathname);
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[error]', err);
    sendJson(res, err.statusCode || 500, { error: err.statusCode === 413 ? 'Upload too large.' : 'Server error.' });
  }
});

server.listen(PORT, () => {
  console.log(`PK Dispatching running at http://localhost:${PORT}`);
  console.log(`Submissions -> ${DATA_DIR}`);
  if (!NOTIFY_WEBHOOK) console.log('Set NOTIFY_WEBHOOK to forward submissions to Slack/Zapier/your CRM.');
});

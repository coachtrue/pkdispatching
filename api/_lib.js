/** Shared helpers for the LP3 Dispatching serverless functions. */

'use strict';

const crypto = require('crypto');

function reference() {
  const now = new Date();
  const stamp = String(now.getFullYear()).slice(2) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  return `LP3-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;

  let raw = req.body;
  if (!raw) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    raw = Buffer.concat(chunks);
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/**
 * Serverless has no disk, so the webhook IS the inbox. Without it a submission
 * survives only in the function logs — the README says so loudly.
 */
async function notify(summary) {
  const hook = process.env.NOTIFY_WEBHOOK;
  if (!hook) {
    console.warn('[notify] NOTIFY_WEBHOOK is not set — this submission exists only in these logs:',
      JSON.stringify(summary));
    return;
  }
  try {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(summary)
    });
    if (!res.ok) console.error('[notify] webhook returned', res.status);
  } catch (err) {
    console.error('[notify] webhook failed:', err.message);
  }
}

/** Trim and cap a user-supplied string so nothing unbounded reaches the webhook. */
function clean(value, max = 500) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((v) => clean(v, 120)).filter(Boolean).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : '';
  return String(value).trim().slice(0, max);
}

module.exports = { reference, readJson, notify, clean };

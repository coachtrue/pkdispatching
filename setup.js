#!/usr/bin/env node
/**
 * LP3 Dispatching — one-shot placeholder replacement.
 *
 * Swaps every placeholder phone number, email address, and domain across the
 * whole project in one pass, so you don't have to hunt through six files.
 *
 *   node setup.js --phone "(214) 555-8890" \
 *                 --email dispatch@pkdispatching.com \
 *                 --packets packets@pkdispatching.com \
 *                 --domain pkdispatching.com
 *
 * Only --phone is required; anything you leave out keeps its current value.
 * Run with --check to see what would change without writing anything.
 *
 * Safe to run repeatedly: it rewrites whatever the current values are, so you
 * can correct a typo by running it again with the fixed value.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const FILES = [
  'index.html',
  'app.js',
  'server.js',
  'api/upload.js',
  'api/leads.js',
  'api/onboarding.js',
  'README.md'
];

/* ------------------------------------------------------------------ *
 * Current values — what we're replacing.
 * Update these only if you've already changed them by hand.
 * ------------------------------------------------------------------ */
const CURRENT = {
  phoneDisplay: '(888) 489-5187',
  phoneE164: '+18884895187',
  phoneDashed: '+1-888-489-5187',
  email: 'dispatch@pkdispatching.com',
  packets: 'packets@pkdispatching.com',
  domain: 'pkdispatching.com'
};

/* ------------------------------------------------------------------ *
 * Argument parsing
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'check' || key === 'help') { args[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`--${key} needs a value.`);
    }
    args[key] = value;
    i++;
  }
  return args;
}

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function usage() {
  console.log(`
  LP3 Dispatching setup — replace the placeholder contact details.

    node setup.js --phone "(214) 555-8890" [options]

  Options
    --phone    <string>   Your dispatch number, any common format   (required)
    --email    <address>  General inbox        (default: keep ${CURRENT.email})
    --packets  <address>  Carrier packet inbox (default: keep ${CURRENT.packets})
    --domain   <host>     Live domain          (default: keep ${CURRENT.domain})
    --check               Show what would change; write nothing
    --help                This message
`);
}

/* ------------------------------------------------------------------ *
 * Validation and formatting
 * ------------------------------------------------------------------ */

/** Accepts "2145558890", "(214) 555-8890", "214-555-8890", "+1 214 555 8890". */
function normalizePhone(input) {
  const digits = String(input).replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;

  if (national.length !== 10) {
    fail(`"${input}" isn't a 10-digit US number (got ${national.length} digits).`);
  }
  return {
    display: `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`,
    e164: `+1${national}`,
    dashed: `+1-${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`
  };
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function validDomain(value) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) && !/^https?:/i.test(value);
}

/** Escape a string for use inside a RegExp. */
function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
const args = parseArgs(process.argv.slice(2));

if (args.help || (!args.phone && !args.email && !args.packets && !args.domain)) {
  usage();
  process.exit(args.help ? 0 : 1);
}

const phone = args.phone ? normalizePhone(args.phone) : null;

if (args.email && !validEmail(args.email)) fail(`"${args.email}" isn't a valid email address.`);
if (args.packets && !validEmail(args.packets)) fail(`"${args.packets}" isn't a valid email address.`);
if (args.domain && !validDomain(args.domain)) {
  fail(`"${args.domain}" should be a bare domain like pkdispatching.com — no https://, no trailing slash.`);
}

// Order matters: replace the longer, more specific strings first so a domain
// swap can't corrupt an email address that contains that same domain.
const replacements = [];
if (args.email)   replacements.push(['general email',  CURRENT.email,   args.email]);
if (args.packets) replacements.push(['packet email',   CURRENT.packets, args.packets]);
if (phone) {
  replacements.push(['phone (dashed)',  CURRENT.phoneDashed,  phone.dashed]);
  replacements.push(['phone (tel/sms)', CURRENT.phoneE164,    phone.e164]);
  replacements.push(['phone (display)', CURRENT.phoneDisplay, phone.display]);
}
if (args.domain)  replacements.push(['domain',         CURRENT.domain,  args.domain]);

if (!replacements.length) fail('Nothing to do — pass at least one of --phone, --email, --packets, --domain.');

console.log(`\n  LP3 Dispatching setup${args.check ? '  (dry run — nothing will be written)' : ''}\n`);

let grandTotal = 0;
const perLabel = new Map();

for (const relative of FILES) {
  const file = path.join(ROOT, relative);
  if (!fs.existsSync(file)) continue;

  const original = fs.readFileSync(file, 'utf8');
  let updated = original;
  let fileCount = 0;

  for (const [label, from, to] of replacements) {
    if (from === to) continue;
    const matches = updated.match(new RegExp(escapeRe(from), 'g'));
    if (!matches) continue;
    updated = updated.split(from).join(to);
    fileCount += matches.length;
    perLabel.set(label, (perLabel.get(label) || 0) + matches.length);
  }

  if (fileCount && !args.check) fs.writeFileSync(file, updated, 'utf8');
  if (fileCount) {
    console.log(`    ${relative.padEnd(20)} ${String(fileCount).padStart(3)} replaced`);
    grandTotal += fileCount;
  }
}

console.log('');
for (const [label, count] of perLabel) {
  const target = replacements.find((r) => r[0] === label)[2];
  console.log(`    ${label.padEnd(17)} → ${target}   (${count}×)`);
}

if (!grandTotal) {
  console.log('    Nothing matched. Values may already be updated.\n');
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * Record the new values as "current", so running this again to correct
 * a typo actually finds something to replace.
 * ------------------------------------------------------------------ */
if (!args.check && grandTotal) {
  const self = path.join(ROOT, 'setup.js');
  let source = fs.readFileSync(self, 'utf8');
  const next = {
    phoneDisplay: phone ? phone.display : CURRENT.phoneDisplay,
    phoneE164: phone ? phone.e164 : CURRENT.phoneE164,
    phoneDashed: phone ? phone.dashed : CURRENT.phoneDashed,
    email: args.email || CURRENT.email,
    packets: args.packets || CURRENT.packets,
    domain: args.domain || CURRENT.domain
  };
  const block = `const CURRENT = {\n` +
    Object.entries(next).map(([k, v]) => `  ${k}: '${v}'`).join(',\n') +
    `\n};`;
  const updated = source.replace(/const CURRENT = \{[\s\S]*?\n\};/, block);
  if (updated !== source) fs.writeFileSync(self, updated, 'utf8');
}

console.log(`\n  ${args.check ? 'Would replace' : '✓ Replaced'} ${grandTotal} occurrence(s) across the project.`);

if (!args.check) {
  console.log(`
  Next:
    1. node server.js        — check it locally at http://localhost:3000
    2. git commit -am "Set real contact details" && git push
    3. Vercel redeploys automatically
`);
}

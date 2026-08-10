#!/usr/bin/env node
/**
 * PK Dispatching — post-deploy smoke test.
 *
 * Confirms a live deployment is wired to Supabase correctly, so you find out
 * now rather than when a real carrier submits.
 *
 *   node verify-deployment.js https://your-project.vercel.app
 *
 * It submits clearly-labelled TEST records. Clean them up afterwards with the
 * SQL printed at the end.
 */

'use strict';

const BASE = (process.argv[2] || '').replace(/\/+$/, '');

if (!BASE || !/^https?:\/\//.test(BASE)) {
  console.error(`
  Usage: node verify-deployment.js https://your-project.vercel.app
`);
  process.exit(1);
}

const PASS = '  \x1b[32m✓\x1b[0m';
const FAIL = '  \x1b[31m✗\x1b[0m';
const WARN = '  \x1b[33m!\x1b[0m';

const results = [];
function record(ok, label, detail) {
  results.push(ok);
  console.log(`${ok ? PASS : FAIL} ${label}`);
  if (detail) console.log(`      ${detail}`);
}

// A tiny but structurally valid PDF, so the upload path gets a real file.
const TEST_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8'
);

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const testRef = `PK-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-TEST${(Math.random() * 10 | 0)}`;

async function main() {
  console.log(`\n  Verifying ${BASE}\n`);

  /* ---------------------------------------------------------------- */
  let html;
  try {
    const res = await fetch(BASE, { redirect: 'follow' });
    html = await res.text();
    record(res.ok && html.includes('PK Dispatching'),
      `Landing page loads (${res.status})`);
    if (html.includes('(555) 555-0123')) {
      console.log(`${WARN} Placeholder phone number is still live — run setup.js`);
    }
  } catch (err) {
    record(false, 'Landing page loads', err.message);
    console.log('\n  Cannot reach the site. Check the URL and that the deploy finished.\n');
    process.exit(1);
  }

  /* ---------------------------------------------------------------- */
  let leadRef = null;
  try {
    const res = await fetch(`${BASE}/api/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `ZZ TEST ${stamp}`,
        email: 'test@example.com',
        phone: '5555550100',
        equipment: 'Dry Van',
        formType: 'quick-callback',
        message: 'Automated deployment test — safe to delete.'
      })
    });
    const body = await res.json().catch(() => ({}));
    leadRef = body.reference;
    record(res.ok && body.ok, `Lead endpoint responds (${res.status})`,
      leadRef ? `reference ${leadRef}` : JSON.stringify(body));
  } catch (err) {
    record(false, 'Lead endpoint responds', err.message);
  }

  /* ---------------------------------------------------------------- */
  // The real canary: a successful upload proves SUPABASE_URL, the service
  // role key, and the carrier-packets bucket are all correct.
  let uploadedPath = null;
  try {
    const url = `${BASE}/api/upload?name=deployment-test.pdf&category=other&reference=${testRef}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: TEST_PDF
    });
    const body = await res.json().catch(() => ({}));
    uploadedPath = body.path;

    if (res.status === 503) {
      record(false, 'Supabase Storage upload',
        'Keys not visible to the function. Add SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, then REDEPLOY — env vars only apply to builds created after they are set.');
    } else if (res.status === 500) {
      record(false, 'Supabase Storage upload',
        'Reached Supabase but the write failed. Usual cause: the carrier-packets bucket does not exist — run supabase/schema.sql.');
    } else {
      record(res.ok && Boolean(uploadedPath), `Supabase Storage upload (${res.status})`,
        uploadedPath ? `stored at ${uploadedPath}` : JSON.stringify(body));
    }
  } catch (err) {
    record(false, 'Supabase Storage upload', err.message);
  }

  /* ---------------------------------------------------------------- */
  try {
    const res = await fetch(`${BASE}/api/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference: testRef,
        companyName: `ZZ TEST CARRIER ${stamp}`,
        contactName: 'Deployment Test',
        phone: '5555550100',
        email: 'test@example.com',
        mcNumber: 'MC-000000',
        dotNumber: '0000000',
        homeCity: 'Test',
        homeState: 'TX',
        truckCount: '1',
        equipment: ['Dry Van'],
        consentContact: true,
        consentDocs: true,
        consentTerms: true,
        signature: 'Deployment Test',
        notes: 'Automated deployment test — safe to delete.',
        documents: uploadedPath
          ? [{ category: 'other', name: 'deployment-test.pdf', bytes: TEST_PDF.length, path: uploadedPath, contentType: 'application/pdf' }]
          : []
      })
    });
    const body = await res.json().catch(() => ({}));
    record(res.ok && body.ok, `Onboarding endpoint responds (${res.status})`,
      body.reference ? `reference ${body.reference}, ${body.documentsReceived} document(s)` : JSON.stringify(body));
  } catch (err) {
    record(false, 'Onboarding endpoint responds', err.message);
  }

  /* ---------------------------------------------------------------- */
  // Rejections should still work in production.
  try {
    const res = await fetch(`${BASE}/api/upload?name=evil.exe&category=other`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('MZ')
    });
    record(res.status === 415, `Rejects unsupported file types (${res.status})`);
  } catch (err) {
    record(false, 'Rejects unsupported file types', err.message);
  }

  try {
    const res = await fetch(`${BASE}/api/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Missing contact details' })
    });
    record(res.status === 400, `Rejects incomplete submissions (${res.status})`);
  } catch (err) {
    record(false, 'Rejects incomplete submissions', err.message);
  }

  /* ---------------------------------------------------------------- */
  const passed = results.filter(Boolean).length;
  console.log(`\n  ${passed}/${results.length} checks passed.\n`);

  console.log(`  The HTTP checks above cannot see inside your database. Confirm the rows
  actually landed — Supabase → Table Editor, or run:

    select reference, company_name, created_at from carriers
    where reference = '${testRef}';

  If the endpoints returned 200 but no row exists, the tables are missing:
  run supabase/schema.sql. Your webhook payload will also say
  "savedToDatabase": false in that case.

  Remove the test data when you're done:

    delete from carrier_documents where reference = '${testRef}';
    delete from carriers          where reference = '${testRef}';
    delete from leads             where name like 'ZZ TEST %';
`);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${FAIL} Unexpected failure: ${err.message}\n`);
  process.exit(1);
});

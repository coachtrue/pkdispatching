#!/usr/bin/env node
/**
 * GoHighLevel one-time setup.
 *
 * Creates the freight custom fields on your sub-account, finds your pipelines,
 * and prints the environment variables to paste into Vercel. Run it once.
 *
 *   GHL_API_TOKEN=pit-xxxx GHL_LOCATION_ID=xxxx node ghl-setup.js
 *
 * Options
 *   --dry     show what it would create, change nothing
 *   --pipeline "Carrier Onboarding"   pick a pipeline by name
 *
 * Safe to re-run: existing fields are reused, never duplicated.
 *
 * The token is read from the environment, never a file and never an argument,
 * so it doesn't end up in your shell history or the repo.
 */

'use strict';

const ghl = require('./api/_ghl');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const pipelineArg = (() => {
  const i = args.indexOf('--pipeline');
  return i !== -1 ? args[i + 1] : null;
})();

const TOKEN = process.env.GHL_API_TOKEN || '';
const LOCATION = process.env.GHL_LOCATION_ID || '';

const g = '\x1b[32m', r = '\x1b[31m', y = '\x1b[33m', dim = '\x1b[2m', off = '\x1b[0m';

function bail(message, hint) {
  console.error(`\n  ${r}✗${off} ${message}`);
  if (hint) console.error(`    ${dim}${hint}${off}`);
  console.error('');
  process.exit(1);
}

if (!TOKEN || !LOCATION) {
  bail('GHL_API_TOKEN and GHL_LOCATION_ID must both be set.',
    'Example:\n    GHL_API_TOKEN=pit-… GHL_LOCATION_ID=… node ghl-setup.js');
}

async function main() {
  console.log(`\n  GoHighLevel setup${DRY ? `  ${dim}(dry run)${off}` : ''}\n`);

  /* ---- 1. Prove the token works and name the sub-account ---- */
  let location;
  try {
    const res = await ghl.call(`/locations/${encodeURIComponent(LOCATION)}`, {});
    location = res.location || res;
    console.log(`  ${g}✓${off} Connected to “${location.name || LOCATION}”`);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      bail('The token was rejected.',
        'Check it is a Private Integration token for THIS sub-account, and that\n' +
        '    it has the scopes: contacts.write, contacts.readonly, locations/customFields.write,\n' +
        '    opportunities.write, and locations.readonly.');
    }
    if (err.status === 404) bail('That Location ID does not exist.', 'Copy it from Settings → Business Profile.');
    bail(err.message);
  }

  /* ---- 2. Custom fields: reuse what exists, create what's missing ---- */
  let existing = [];
  try {
    const res = await ghl.call(`/locations/${encodeURIComponent(LOCATION)}/customFields`, {});
    existing = res.customFields || res.customField || [];
  } catch (err) {
    bail(`Could not read custom fields: ${err.message}`,
      'The token likely lacks the locations/customFields scopes.');
  }

  const byName = new Map(existing.map((f) => [String(f.name || '').trim().toLowerCase(), f]));
  const map = {};
  let created = 0, reused = 0;

  for (const [key, spec] of Object.entries(ghl.FIELDS)) {
    const match = byName.get(spec.name.toLowerCase());
    if (match) {
      map[key] = match.id;
      reused++;
      console.log(`  ${dim}·${off} ${spec.name} ${dim}already exists${off}`);
      continue;
    }
    if (DRY) {
      console.log(`  ${y}+${off} would create ${spec.name} (${spec.dataType})`);
      created++;
      continue;
    }
    try {
      const res = await ghl.call(`/locations/${encodeURIComponent(LOCATION)}/customFields`, {
        method: 'POST',
        body: { name: spec.name, dataType: spec.dataType, model: 'contact' }
      });
      const field = res.customField || res;
      map[key] = field.id;
      created++;
      console.log(`  ${g}+${off} created ${spec.name}`);
    } catch (err) {
      console.log(`  ${r}✗${off} ${spec.name}: ${err.message}`);
    }
  }

  console.log(`\n  ${created} created, ${reused} reused.`);

  /* ---- 3. Pipelines ---- */
  let pipelines = [];
  try {
    const res = await ghl.call(`/opportunities/pipelines?locationId=${encodeURIComponent(LOCATION)}`, {});
    pipelines = res.pipelines || [];
  } catch {
    console.log(`  ${y}!${off} Could not read pipelines (needs the opportunities scope) — skipping.`);
  }

  let chosen = null;
  if (pipelines.length) {
    chosen = pipelineArg
      ? pipelines.find((p) => String(p.name).toLowerCase() === pipelineArg.toLowerCase())
      : pipelines[0];

    if (pipelineArg && !chosen) {
      console.log(`  ${y}!${off} No pipeline named “${pipelineArg}”. Available: ${pipelines.map((p) => p.name).join(', ')}`);
      chosen = pipelines[0];
    }
    console.log(`\n  Pipelines found: ${pipelines.map((p) => p.name).join(', ')}`);
    console.log(`  Using: ${chosen.name}`);
  }

  const stage = chosen && (chosen.stages || [])[0];

  /* ---- 4. What to paste into Vercel ---- */
  if (DRY) {
    console.log(`\n  ${dim}Dry run — nothing was created. Re-run without --dry.${off}\n`);
    return;
  }

  console.log(`\n  ${g}Done.${off} Add these to Vercel → Settings → Environment Variables:\n`);
  console.log(`  GHL_LOCATION_ID=${LOCATION}`);
  console.log(`  GHL_API_TOKEN=${dim}(the token you just used — paste it there, not here)${off}`);
  console.log(`  GHL_FIELD_MAP=${JSON.stringify(map)}`);
  if (chosen) console.log(`  GHL_PIPELINE_ID=${chosen.id}`);
  if (stage) console.log(`  GHL_STAGE_ID=${stage.id}`);
  console.log(`\n  ${y}Then redeploy${off} — Vercel only applies env vars to builds created after they are set.\n`);
}

main().catch((err) => bail(err.message));

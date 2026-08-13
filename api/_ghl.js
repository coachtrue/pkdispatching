/**
 * GoHighLevel integration (API v2).
 *
 * Role split: GHL owns the relationship — contacts, conversations, pipeline,
 * automations. This site owns the paperwork — the freight-specific fields and
 * the carrier packet in private storage. Every submission is pushed into GHL
 * with the freight data mapped to custom fields and a link back to the packet.
 *
 * Dependency-free on purpose, matching the rest of the project.
 *
 * Environment (Vercel → Settings → Environment Variables):
 *   GHL_API_TOKEN        Private Integration token — SERVER ONLY
 *   GHL_LOCATION_ID      the sub-account this site feeds
 *   GHL_FIELD_MAP        JSON of {fieldKey: customFieldId} — `node ghl-setup.js` prints it
 *   GHL_PIPELINE_ID      optional — opens an opportunity per carrier
 *   GHL_STAGE_ID         optional — the stage new carriers land in
 *
 * Nothing here is allowed to fail a carrier's submission. Every call is
 * wrapped by the caller and logged rather than thrown.
 */

'use strict';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

/** The freight fields GHL has no native concept of. ghl-setup.js creates these. */
const FIELDS = {
  mc_number:        { name: 'MC Number',           dataType: 'TEXT' },
  dot_number:       { name: 'USDOT Number',        dataType: 'TEXT' },
  authority_age:    { name: 'Authority Age',       dataType: 'TEXT' },
  equipment:        { name: 'Equipment',           dataType: 'TEXT' },
  endorsements:     { name: 'Endorsements',        dataType: 'TEXT' },
  truck_count:      { name: 'Truck Count',         dataType: 'NUMERICAL' },
  home_base:        { name: 'Home Base',           dataType: 'TEXT' },
  operating_radius: { name: 'Operating Radius',    dataType: 'TEXT' },
  min_rate:         { name: 'Minimum Rate Per Mile', dataType: 'TEXT' },
  preferred_lanes:  { name: 'Preferred Lanes',     dataType: 'TEXT' },
  avoid_areas:      { name: 'Avoided Areas',       dataType: 'TEXT' },
  factoring:        { name: 'Factoring Company',   dataType: 'TEXT' },
  availability:     { name: 'Availability',        dataType: 'TEXT' },
  hv_reference:     { name: 'Haulvera Reference',        dataType: 'TEXT' },
  packet_url:       { name: 'Carrier Packet',      dataType: 'TEXT' },
  documents_on_file:{ name: 'Documents On File',   dataType: 'NUMERICAL' }
};

function config() {
  let fieldMap = {};
  try { fieldMap = JSON.parse(process.env.GHL_FIELD_MAP || '{}'); } catch { fieldMap = {}; }
  return {
    token: process.env.GHL_API_TOKEN || '',
    locationId: process.env.GHL_LOCATION_ID || '',
    pipelineId: process.env.GHL_PIPELINE_ID || '',
    stageId: process.env.GHL_STAGE_ID || '',
    fieldMap
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.token && c.locationId);
}

async function call(path, options) {
  const { token } = config();
  const res = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Version: VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await res.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }

  if (!res.ok) {
    const detail = parsed.message || parsed.error || text.slice(0, 200);
    throw Object.assign(new Error(`GHL ${path} failed (${res.status}): ${detail}`), { status: res.status });
  }
  return parsed;
}

/** Split "Jordan Reeves" into the first/last GHL expects. */
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** Only send fields that exist in the map, so an incomplete setup still works. */
function customFields(values) {
  const { fieldMap } = config();
  const out = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    const id = fieldMap[key];
    if (id) out.push({ id, field_value: String(value) });
  }
  return out;
}

/**
 * Create or update the contact. GHL matches on email/phone within the
 * location, so a lead who later onboards enriches the same record rather
 * than creating a duplicate.
 */
async function upsertContact(input) {
  const { locationId } = config();
  const { firstName, lastName } = splitName(input.contactName);

  const body = {
    locationId,
    firstName,
    lastName,
    name: input.contactName || undefined,
    email: input.email || undefined,
    phone: input.phone || undefined,
    companyName: input.companyName || undefined,
    city: input.city || undefined,
    state: input.state || undefined,
    source: input.source || 'haulvera.com',
    tags: (input.tags || []).filter(Boolean).map((t) => String(t).toLowerCase()),
    customFields: customFields(input.fields || {})
  };

  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  const result = await call('/contacts/upsert', { method: 'POST', body });
  return result.contact || result;
}

/** Timeline note — carries the packet links, which expire, so they live here. */
async function addNote(contactId, text) {
  if (!contactId || !text) return null;
  return call(`/contacts/${encodeURIComponent(contactId)}/notes`, {
    method: 'POST',
    body: { body: String(text).slice(0, 5000) }
  });
}

/** Optional: put the carrier into a sales pipeline so they can't be forgotten. */
async function createOpportunity(contactId, name, monetaryValue) {
  const { locationId, pipelineId, stageId } = config();
  if (!pipelineId || !contactId) return null;

  const body = {
    locationId,
    pipelineId,
    contactId,
    name: String(name || 'New carrier').slice(0, 200),
    status: 'open'
  };
  if (stageId) body.pipelineStageId = stageId;
  if (monetaryValue) body.monetaryValue = monetaryValue;

  return call('/opportunities/', { method: 'POST', body });
}

/* ------------------------------------------------------------------ *
 * High-level: push a submission into GHL
 * ------------------------------------------------------------------ */

/**
 * @param {'lead'|'carrier'} kind
 * @param {object} data   normalised submission
 * @param {string[]} documentLinks  signed URLs (carriers only)
 * @returns {object} { pushed, contactId, error }
 */
async function push(kind, data, documentLinks) {
  if (!isConfigured()) return { pushed: false, error: 'not configured' };

  const isCarrier = kind === 'carrier';
  const equipment = Array.isArray(data.equipment) ? data.equipment : (data.equipment ? [data.equipment] : []);

  const tags = ['haulvera.com', isCarrier ? 'carrier' : 'lead'];
  equipment.forEach((e) => tags.push(String(e).toLowerCase().replace(/[^a-z0-9]+/g, '-')));

  // "ready-now" is the tag worth automating on — a carrier sitting empty today
  // should get a call, not a drip sequence.
  const availability = data.startDate || data.availability || '';
  if (isCarrier && /immediat|empty now/i.test(availability)) tags.push('ready-now');

  const contact = await upsertContact({
    contactName: data.contactName || data.name,
    email: data.email,
    phone: data.phone,
    companyName: data.companyName,
    city: data.homeCity,
    state: data.homeState,
    source: isCarrier ? 'Express onboarding' : 'Website form',
    tags,
    fields: {
      hv_reference: data.reference,
      mc_number: data.mcNumber,
      dot_number: data.dotNumber,
      authority_age: data.authorityAge,
      equipment: equipment.join(', '),
      endorsements: Array.isArray(data.endorsements) ? data.endorsements.join(', ') : data.endorsements,
      truck_count: data.truckCount,
      home_base: [data.homeCity, data.homeState].filter(Boolean).join(', '),
      operating_radius: data.radius,
      min_rate: data.minRpm,
      preferred_lanes: data.preferredLanes,
      avoid_areas: data.avoidAreas,
      factoring: data.factoringCompany,
      availability: data.startDate,
      packet_url: data.packetUrl,
      documents_on_file: isCarrier ? (documentLinks || []).length : undefined
    }
  });

  const contactId = contact && (contact.id || contact.contactId);

  // A note keeps the detail readable inside GHL without needing every field
  // promoted to a custom field.
  const lines = [`${isCarrier ? 'Express onboarding' : 'Website enquiry'} — ${data.reference}`];
  if (data.notes || data.message) lines.push('', 'They wrote:', data.notes || data.message);
  if (isCarrier && documentLinks && documentLinks.length) {
    lines.push('', `Carrier packet (${documentLinks.length} document(s)) — links expire in 7 days:`);
    documentLinks.forEach((d) => lines.push(`• ${d.category}: ${d.link}`));
  }
  if (data.packetUrl) lines.push('', `Full packet, always current: ${data.packetUrl}`);

  await addNote(contactId, lines.join('\n')).catch(() => {});

  if (isCarrier) {
    await createOpportunity(contactId, `${data.companyName || data.contactName} — onboarding`).catch(() => {});
  }

  return { pushed: true, contactId };
}

module.exports = { FIELDS, BASE, VERSION, isConfigured, call, upsertContact, addNote, createOpportunity, push, splitName, customFields };

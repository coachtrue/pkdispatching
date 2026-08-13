/**
 * POST /api/onboarding — express onboarding submission.
 *
 * JSON only. Documents are uploaded first via /api/upload; this endpoint
 * receives their storage paths, writes the carrier row and document rows to
 * Supabase, and sends a notification with short-lived signed document links.
 */

'use strict';

const { reference, readJson, notify, clean } = require('./_lib');
const supabase = require('./_supabase');
const ghl = require('./_ghl');

const REQUIRED = ['companyName', 'contactName', 'phone', 'email', 'mcNumber', 'dotNumber'];

function toArray(value) {
  if (Array.isArray(value)) return value.map((v) => clean(v, 60)).filter(Boolean);
  const text = clean(value, 400);
  return text ? text.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let data;
  try {
    data = await readJson(req);
  } catch {
    res.status(400).json({ error: 'Invalid JSON body.' });
    return;
  }

  if (data.website) {
    res.status(200).json({ ok: true });
    return;
  }

  const missing = REQUIRED.filter((key) => !clean(data[key]));
  if (missing.length) {
    res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
    return;
  }

  const ref = /^(?:HV|PK)-\d{6}-[A-Z0-9]{5,6}$/.test(String(data.reference || ''))
    ? data.reference
    : reference();

  const documents = (Array.isArray(data.documents) ? data.documents : []).slice(0, 30);
  const truckCount = parseInt(data.truckCount, 10);

  const carrierRow = {
    reference: ref,
    company_name: clean(data.companyName, 200),
    dba: clean(data.dba, 200) || null,
    contact_name: clean(data.contactName, 160),
    contact_role: clean(data.role, 80) || null,
    phone: clean(data.phone, 40),
    email: clean(data.email, 200),
    mc_number: clean(data.mcNumber, 40),
    dot_number: clean(data.dotNumber, 40),
    authority_age: clean(data.authorityAge, 60) || null,
    home_city: clean(data.homeCity, 120) || null,
    home_state: clean(data.homeState, 4) || null,
    truck_count: Number.isFinite(truckCount) ? Math.max(0, Math.min(truckCount, 10000)) : null,
    equipment: toArray(data.equipment),
    endorsements: toArray(data.endorsements),
    operating_radius: clean(data.radius, 80) || null,
    min_rate_per_mile: clean(data.minRpm, 40) || null,
    preferred_lanes: clean(data.preferredLanes, 400) || null,
    avoid_areas: clean(data.avoidAreas, 400) || null,
    factoring_company: clean(data.factoringCompany, 200) || null,
    availability: clean(data.startDate, 80) || null,
    referral_source: clean(data.referralSource, 80) || null,
    notes: clean(data.notes, 4000) || null,
    signature: clean(data.signature, 160) || null,
    consent_contact: Boolean(data.consentContact),
    consent_documents: Boolean(data.consentDocs),
    consent_terms: Boolean(data.consentTerms),
    signed_at: new Date().toISOString(),
    ip: clean(req.headers['x-forwarded-for'], 60) || null,
    user_agent: clean(req.headers['user-agent'], 300) || null
  };

  let persisted = false;
  let carrierId = null;

  if (supabase.isConfigured()) {
    try {
      const saved = await supabase.insert('carriers', carrierRow);
      carrierId = saved && saved.id ? saved.id : null;
      persisted = true;

      if (documents.length) {
        await supabase.insert('carrier_documents', documents.map((doc) => ({
          carrier_id: carrierId,
          reference: ref,
          category: clean(doc.category, 40) || 'other',
          file_name: clean(doc.name, 200) || 'document',
          storage_path: clean(doc.path, 600),
          content_type: clean(doc.contentType, 120) || null,
          bytes: Number(doc.bytes) || null
        })));
      }
    } catch (err) {
      // Never fail the carrier's submission over a database problem — the
      // notification below still gets their details in front of a dispatcher.
      console.error('[onboarding] supabase write failed:', err.message);
    }
  } else {
    console.warn('[onboarding] Supabase is not configured — relying on the webhook only.');
  }

  // Short-lived links so documents are clickable from Slack/email without
  // making the storage bucket public.
  const documentLinks = [];
  if (supabase.isConfigured()) {
    for (const doc of documents) {
      const link = await supabase.signedUrl(clean(doc.path, 600), 60 * 60 * 24 * 7);
      documentLinks.push({
        category: clean(doc.category, 40),
        name: clean(doc.name, 200),
        bytes: Number(doc.bytes) || 0,
        link: link || '(sign failed — open it in the Supabase dashboard)'
      });
    }
  }

  // Push into GoHighLevel, which is where the relationship is worked. The
  // packet URL points back here, because signed document links expire.
  const origin = req.headers['x-forwarded-host'] || req.headers.host;
  const packetUrl = origin ? `https://${origin}/admin?ref=${encodeURIComponent(ref)}` : '';

  let crm = { pushed: false };
  if (ghl.isConfigured()) {
    try {
      crm = await ghl.push('carrier', {
        reference: ref,
        contactName: carrierRow.contact_name,
        companyName: carrierRow.company_name,
        email: carrierRow.email,
        phone: carrierRow.phone,
        mcNumber: carrierRow.mc_number,
        dotNumber: carrierRow.dot_number,
        authorityAge: carrierRow.authority_age,
        equipment: carrierRow.equipment,
        endorsements: carrierRow.endorsements,
        truckCount: carrierRow.truck_count,
        homeCity: carrierRow.home_city,
        homeState: carrierRow.home_state,
        radius: carrierRow.operating_radius,
        minRpm: carrierRow.min_rate_per_mile,
        preferredLanes: carrierRow.preferred_lanes,
        avoidAreas: carrierRow.avoid_areas,
        factoringCompany: carrierRow.factoring_company,
        startDate: carrierRow.availability,
        notes: carrierRow.notes,
        packetUrl
      }, documentLinks);
    } catch (err) {
      console.error('[onboarding] GHL push failed:', err.message);
      crm = { pushed: false, error: err.message };
    }
  }

  await notify({
    type: 'EXPRESS ONBOARDING',
    reference: ref,
    receivedAt: new Date().toISOString(),
    savedToDatabase: persisted,
    inGoHighLevel: crm.pushed,
    packetUrl,
    company: carrierRow.company_name,
    dba: carrierRow.dba,
    contact: carrierRow.contact_name,
    phone: carrierRow.phone,
    email: carrierRow.email,
    mcNumber: carrierRow.mc_number,
    dotNumber: carrierRow.dot_number,
    authorityAge: carrierRow.authority_age,
    homeBase: [carrierRow.home_city, carrierRow.home_state].filter(Boolean).join(', '),
    trucks: carrierRow.truck_count,
    equipment: carrierRow.equipment.join(', '),
    endorsements: carrierRow.endorsements.join(', '),
    operatingRadius: carrierRow.operating_radius,
    minRatePerMile: carrierRow.min_rate_per_mile,
    preferredLanes: carrierRow.preferred_lanes,
    avoidAreas: carrierRow.avoid_areas,
    factoringCompany: carrierRow.factoring_company,
    availability: carrierRow.availability,
    referralSource: carrierRow.referral_source,
    notes: carrierRow.notes,
    signature: carrierRow.signature,
    consented: carrierRow.consent_contact && carrierRow.consent_documents && carrierRow.consent_terms,
    documentCount: documents.length,
    documents: documentLinks.length ? documentLinks : documents.map((d) => ({
      category: clean(d.category, 40), name: clean(d.name, 200)
    }))
  });

  console.log(`[onboarding] ${ref} — ${carrierRow.company_name} (${documents.length} doc(s), saved=${persisted})`);
  res.status(200).json({ ok: true, reference: ref, documentsReceived: documents.length });
};

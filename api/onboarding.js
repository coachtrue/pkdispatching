/**
 * POST /api/onboarding — express onboarding submission.
 *
 * JSON only. Documents are uploaded first via /api/upload; this endpoint
 * receives their resulting blob URLs alongside the carrier's details.
 */

'use strict';

const { reference, readJson, notify, clean } = require('./_lib');

const REQUIRED = ['companyName', 'contactName', 'phone', 'email', 'mcNumber', 'dotNumber'];

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

  const ref = /^PK-\d{6}-[A-Z0-9]{5,6}$/.test(String(data.reference || ''))
    ? data.reference
    : reference();

  const documents = Array.isArray(data.documents) ? data.documents.slice(0, 30) : [];

  await notify({
    type: 'EXPRESS ONBOARDING',
    reference: ref,
    receivedAt: new Date().toISOString(),
    company: clean(data.companyName),
    dba: clean(data.dba),
    contact: clean(data.contactName),
    role: clean(data.role),
    phone: clean(data.phone),
    email: clean(data.email),
    mcNumber: clean(data.mcNumber),
    dotNumber: clean(data.dotNumber),
    authorityAge: clean(data.authorityAge),
    homeBase: [clean(data.homeCity), clean(data.homeState)].filter(Boolean).join(', '),
    trucks: clean(data.truckCount),
    equipment: clean(data.equipment),
    endorsements: clean(data.endorsements),
    radius: clean(data.radius),
    minRpm: clean(data.minRpm),
    preferredLanes: clean(data.preferredLanes),
    avoidAreas: clean(data.avoidAreas),
    factoringCompany: clean(data.factoringCompany),
    availability: clean(data.startDate),
    referralSource: clean(data.referralSource),
    notes: clean(data.notes, 2000),
    signature: clean(data.signature),
    consented: Boolean(data.consentContact && data.consentDocs && data.consentTerms),
    documentCount: documents.length,
    documents: documents.map((doc) => ({
      category: clean(doc.category, 40),
      name: clean(doc.name, 160),
      bytes: Number(doc.bytes) || 0,
      url: clean(doc.url, 600)
    }))
  });

  console.log(`[onboarding] ${ref} — ${clean(data.companyName)} (${documents.length} document(s))`);
  res.status(200).json({ ok: true, reference: ref, documentsReceived: documents.length });
};

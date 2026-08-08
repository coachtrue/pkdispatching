/**
 * POST /api/leads — quick call-back and general contact forms.
 * JSON in, JSON out. No files.
 */

'use strict';

const { reference, readJson, notify, clean } = require('./_lib');

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

  // Honeypot: accept silently so the bot learns nothing.
  if (data.website) {
    res.status(200).json({ ok: true });
    return;
  }

  const missing = ['name', 'email', 'phone'].filter((key) => !clean(data[key]));
  if (missing.length) {
    res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
    return;
  }

  const ref = reference();

  await notify({
    type: data.formType === 'contact' ? 'Contact form' : 'Call-back request',
    reference: ref,
    receivedAt: new Date().toISOString(),
    name: clean(data.name),
    phone: clean(data.phone),
    email: clean(data.email),
    company: clean(data.companyName),
    mcNumber: clean(data.mcNumber),
    equipment: clean(data.equipment),
    topic: clean(data.topic),
    message: clean(data.message, 2000)
  });

  console.log(`[lead] ${ref} — ${clean(data.name)} <${clean(data.email)}>`);
  res.status(200).json({ ok: true, reference: ref });
};

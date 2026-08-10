/**
 * POST /api/leads — quick call-back and general contact forms.
 * JSON in, JSON out. No files. Writes to Supabase and notifies.
 */

'use strict';

const { reference, readJson, notify, clean } = require('./_lib');
const supabase = require('./_supabase');
const ghl = require('./_ghl');

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

  const row = {
    reference: ref,
    form_type: data.formType === 'contact' ? 'contact' : 'callback',
    name: clean(data.name, 160),
    email: clean(data.email, 200),
    phone: clean(data.phone, 40),
    company_name: clean(data.companyName, 200) || null,
    mc_number: clean(data.mcNumber, 40) || null,
    equipment: clean(data.equipment, 120) || null,
    topic: clean(data.topic, 120) || null,
    message: clean(data.message, 4000) || null,
    ip: clean(req.headers['x-forwarded-for'], 60) || null,
    user_agent: clean(req.headers['user-agent'], 300) || null
  };

  let persisted = false;
  if (supabase.isConfigured()) {
    try {
      await supabase.insert('leads', row);
      persisted = true;
    } catch (err) {
      // A database hiccup must not cost you the lead — the webhook still fires.
      console.error('[lead] supabase write failed:', err.message);
    }
  } else {
    console.warn('[lead] Supabase is not configured — relying on the webhook only.');
  }

  // Never let a GHL hiccup cost the lead — this only ever logs on failure.
  try {
    await ghl.push('lead', {
      reference: ref,
      contactName: row.name,
      email: row.email,
      phone: row.phone,
      companyName: row.company_name,
      mcNumber: row.mc_number,
      equipment: row.equipment,
      notes: row.message
    }, []);
  } catch (err) {
    console.error('[lead] GHL push failed:', err.message);
  }

  await notify({
    type: row.form_type === 'contact' ? 'Contact form' : 'Call-back request',
    reference: ref,
    receivedAt: new Date().toISOString(),
    savedToDatabase: persisted,
    name: row.name,
    phone: row.phone,
    email: row.email,
    company: row.company_name,
    mcNumber: row.mc_number,
    equipment: row.equipment,
    topic: row.topic,
    message: row.message
  });

  console.log(`[lead] ${ref} — ${row.name} <${row.email}> (saved=${persisted})`);
  res.status(200).json({ ok: true, reference: ref });
};

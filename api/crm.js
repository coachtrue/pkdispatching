/**
 * POST|GET /api/crm?action=<name> — the CRM back end.
 *
 * One function with sub-routing rather than a dozen route files: Vercel's
 * Hobby plan caps serverless functions, and these all share auth and the same
 * Supabase client.
 *
 * Named crm.js, not admin.js, so it can never collide with the browser-side
 * admin.js at the project root — a flat upload would silently overwrite one
 * with the other.
 *
 * Public:
 *   login            exchange the password for a session cookie
 *   session          is the current cookie still valid?
 *
 * Authenticated:
 *   logout           clear the session
 *   stats            dashboard counters
 *   contacts         search / filter the unified contact list
 *   contact          one contact: full record, documents, activity timeline
 *   log              record a call, text, email, or note
 *   update           change status, owner, or follow-up date
 *   portalAccount    create or reset a carrier's portal login
 *   portalToggle     enable/disable an existing portal login
 *   loads            list a carrier's loads
 *   loadSave         create or update a load
 *   payments         list a carrier's payments
 *   paymentSave      create or update a payment
 */

'use strict';

const auth = require('./_auth');
const portalAuth = require('./_portal_auth');
const supabase = require('./_supabase');
const { readJson, clean } = require('./_lib');

const CARRIER_STATUSES = ['new', 'verifying', 'approved', 'active', 'paused', 'rejected'];
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'];
const ACTIVITY_KINDS = ['call', 'sms', 'email', 'note', 'status'];
const DIRECTIONS = ['inbound', 'outbound'];
const LOAD_STATUSES = ['booked', 'in_transit', 'delivered', 'paid', 'cancelled'];
const PAYMENT_STATUSES = ['pending', 'paid', 'failed'];

/** PostgREST puts the total count in a Content-Range header when asked. */
function table(contactType) {
  return contactType === 'lead' ? 'leads' : 'carriers';
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

async function handleLogin(req, res) {
  if (!auth.isConfigured()) {
    res.status(503).json({ error: 'Admin access is not configured. Set ADMIN_PASSWORD and redeploy.' });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    res.status(400).json({ error: 'Invalid request.' });
    return;
  }

  // A deliberate delay blunts online guessing. Serverless instances are
  // ephemeral, so an in-memory attempt counter would not survive anyway.
  await new Promise((resolve) => setTimeout(resolve, 400));

  if (!auth.checkPassword(body.password || '')) {
    res.status(401).json({ error: 'Incorrect password.' });
    return;
  }

  res.setHeader('Set-Cookie', auth.loginCookie());
  res.status(200).json({ ok: true });
}

function handleSession(req, res) {
  const jar = auth.parseCookies(req.headers.cookie);
  res.status(200).json({
    configured: auth.isConfigured(),
    signedIn: auth.isConfigured() && auth.tokenValid(jar[auth.COOKIE])
  });
}

function handleLogout(req, res) {
  res.setHeader('Set-Cookie', auth.logoutCookie());
  res.status(200).json({ ok: true });
}

async function handleStats(req, res) {
  const today = new Date().toISOString().slice(0, 10);

  const [carriers, leads] = await Promise.all([
    supabase.select('carriers', 'select=status,created_at,next_follow_up&limit=2000'),
    supabase.select('leads', 'select=status,created_at,next_follow_up&limit=2000')
  ]);

  const isToday = (row) => String(row.created_at || '').slice(0, 10) === today;
  const dueBy = (row) => row.next_follow_up && row.next_follow_up <= today;

  res.status(200).json({
    carriers: {
      total: carriers.length,
      new: carriers.filter((c) => c.status === 'new').length,
      verifying: carriers.filter((c) => c.status === 'verifying').length,
      active: carriers.filter((c) => c.status === 'active' || c.status === 'approved').length,
      today: carriers.filter(isToday).length
    },
    leads: {
      total: leads.length,
      new: leads.filter((l) => l.status === 'new').length,
      today: leads.filter(isToday).length
    },
    followUpsDue: carriers.filter(dueBy).length + leads.filter(dueBy).length
  });
}

async function handleContacts(req, res, url) {
  const search = clean(url.searchParams.get('q'), 80);
  const type = url.searchParams.get('type');
  const status = clean(url.searchParams.get('status'), 40);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 300);

  const parts = ['select=*', `limit=${limit}`, 'order=created_at.desc'];

  if (type === 'lead' || type === 'carrier') {
    parts.push(`contact_type=eq.${type}`);
  }
  if (status) {
    parts.push(`status=eq.${encodeURIComponent(status)}`);
  }
  if (search) {
    // Commas and parens are PostgREST syntax inside or=(), so strip them
    // rather than let a search box alter the filter's shape.
    const safe = search.replace(/[(),*]/g, ' ').trim();
    if (safe) {
      const like = `*${encodeURIComponent(safe)}*`;
      parts.push(`or=(name.ilike.${like},contact_name.ilike.${like},email.ilike.${like},phone.ilike.${like},mc_number.ilike.${like},reference.ilike.${like})`);
    }
  }

  const rows = await supabase.select('crm_contacts', parts.join('&'));
  res.status(200).json({ contacts: rows });
}

async function handleContact(req, res, url) {
  const reference = clean(url.searchParams.get('reference'), 40);
  const contactType = url.searchParams.get('type') === 'lead' ? 'lead' : 'carrier';
  if (!reference) {
    res.status(400).json({ error: 'reference is required.' });
    return;
  }

  const filter = `reference=eq.${encodeURIComponent(reference)}`;
  const [records, activities] = await Promise.all([
    supabase.select(table(contactType), `select=*&${filter}&limit=1`),
    supabase.select('activities', `select=*&contact_ref=eq.${encodeURIComponent(reference)}&order=created_at.desc&limit=200`)
  ]);

  const record = records[0];
  if (!record) {
    res.status(404).json({ error: 'Contact not found.' });
    return;
  }

  // Documents get fresh 1-hour links, minted per view rather than stored, so
  // an old dashboard tab can't keep handing out access to a W-9.
  let documents = [];
  let portalAccount = null;
  let loads = [];
  let payments = [];
  if (contactType === 'carrier') {
    const [docRows, accountRows, loadRows, paymentRows] = await Promise.all([
      supabase.select('carrier_documents', `select=*&${filter}&order=created_at.asc`),
      // Never select password_hash here — this response goes straight to the browser.
      supabase.select('carrier_accounts', `select=id,email,is_active,created_at,last_login_at&carrier_id=eq.${encodeURIComponent(record.id)}&limit=1`),
      supabase.select('loads', `select=*&${filter}&order=created_at.desc`),
      supabase.select('payments', `select=*&${filter}&order=created_at.desc`)
    ]);
    documents = await Promise.all(docRows.map(async (doc) => ({
      id: doc.id,
      category: doc.category,
      fileName: doc.file_name,
      bytes: doc.bytes,
      createdAt: doc.created_at,
      link: await supabase.signedUrl(doc.storage_path, 60 * 60)
    })));
    portalAccount = accountRows[0] || null;
    loads = loadRows;
    payments = paymentRows;
  }

  res.status(200).json({ contactType, record, documents, activities, portalAccount, loads, payments });
}

async function handleLog(req, res) {
  const body = await readJson(req);
  const reference = clean(body.reference, 40);
  const contactType = body.contactType === 'lead' ? 'lead' : 'carrier';
  const kind = ACTIVITY_KINDS.includes(body.kind) ? body.kind : 'note';
  const direction = DIRECTIONS.includes(body.direction) ? body.direction : null;

  if (!reference) {
    res.status(400).json({ error: 'reference is required.' });
    return;
  }
  const text = clean(body.body, 4000);
  if (!text) {
    res.status(400).json({ error: 'Write something before saving.' });
    return;
  }

  const activity = await supabase.insert('activities', {
    contact_type: contactType,
    contact_ref: reference,
    kind,
    direction,
    subject: clean(body.subject, 200) || null,
    body: text,
    created_by: clean(body.createdBy, 80) || 'admin'
  });

  // Logging a real conversation counts as contact; a private note doesn't.
  if (kind !== 'note') {
    await supabase.update(table(contactType), `reference=eq.${encodeURIComponent(reference)}`, {
      last_contacted_at: new Date().toISOString()
    });
  }

  res.status(200).json({ ok: true, activity });
}

async function handleUpdate(req, res) {
  const body = await readJson(req);
  const reference = clean(body.reference, 40);
  const contactType = body.contactType === 'lead' ? 'lead' : 'carrier';
  if (!reference) {
    res.status(400).json({ error: 'reference is required.' });
    return;
  }

  const patch = {};
  const allowed = contactType === 'lead' ? LEAD_STATUSES : CARRIER_STATUSES;

  if (body.status !== undefined) {
    if (!allowed.includes(body.status)) {
      res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
      return;
    }
    patch.status = body.status;
  }
  if (body.owner !== undefined) patch.owner = clean(body.owner, 80) || null;
  if (body.nextFollowUp !== undefined) {
    const date = clean(body.nextFollowUp, 10);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Follow-up date must be YYYY-MM-DD.' });
      return;
    }
    patch.next_follow_up = date || null;
  }

  if (!Object.keys(patch).length) {
    res.status(400).json({ error: 'Nothing to update.' });
    return;
  }

  const record = await supabase.update(
    table(contactType),
    `reference=eq.${encodeURIComponent(reference)}`,
    patch
  );

  // A status change belongs in the timeline — it's how you reconstruct
  // what happened to a carrier three months later.
  if (patch.status) {
    await supabase.insert('activities', {
      contact_type: contactType,
      contact_ref: reference,
      kind: 'status',
      body: `Status changed to "${patch.status}".`,
      created_by: 'admin'
    });
  }

  res.status(200).json({ ok: true, record });
}

/* ------------------------------------------------------------------ *
 * Carrier portal accounts
 * ------------------------------------------------------------------ */

/** Look up a carrier by reference, or write a 404 and return null. */
async function findCarrierByReference(res, reference) {
  const rows = await supabase.select('carriers', `select=id,reference,company_name,email&reference=eq.${encodeURIComponent(reference)}&limit=1`);
  if (!rows[0]) {
    res.status(404).json({ error: 'Carrier not found.' });
    return null;
  }
  return rows[0];
}

/**
 * Create a carrier's portal account, or reset the password on an existing
 * one — same action either way, distinguished by whether one already
 * exists. The generated password is returned once, in this response only;
 * it is never stored or logged anywhere in the clear, and there is no way
 * to retrieve it again later. If you lose it, reset it.
 */
async function handlePortalAccount(req, res) {
  if (!portalAuth.isConfigured()) {
    res.status(503).json({ error: 'The carrier portal is not configured. Set PORTAL_SESSION_SECRET and redeploy.' });
    return;
  }

  const body = await readJson(req);
  const reference = clean(body.reference, 40);
  if (!reference) {
    res.status(400).json({ error: 'reference is required.' });
    return;
  }

  const carrier = await findCarrierByReference(res, reference);
  if (!carrier) return;

  const email = clean(body.email, 200).toLowerCase() || String(carrier.email || '').toLowerCase();
  if (!email) {
    res.status(400).json({ error: 'This carrier has no email on file — pass one explicitly.' });
    return;
  }

  const password = portalAuth.generatePassword();
  const passwordHash = portalAuth.hashPassword(password);

  const existing = await supabase.select('carrier_accounts', `select=id,email&carrier_id=eq.${encodeURIComponent(carrier.id)}&limit=1`);

  let account;
  let created;
  if (existing[0]) {
    account = await supabase.update('carrier_accounts', `id=eq.${encodeURIComponent(existing[0].id)}`, {
      email,
      password_hash: passwordHash,
      is_active: true
    });
    created = false;
  } else {
    try {
      account = await supabase.insert('carrier_accounts', {
        carrier_id: carrier.id,
        reference: carrier.reference,
        email,
        password_hash: passwordHash
      });
    } catch (err) {
      if (/duplicate|unique/i.test(err.message)) {
        res.status(409).json({ error: `An account already exists for ${email}. Use a different email, or reset that carrier's account instead.` });
        return;
      }
      throw err;
    }
    created = true;
  }

  await supabase.insert('activities', {
    contact_type: 'carrier',
    contact_ref: reference,
    kind: 'system',
    body: created ? `Portal account created (${email}).` : `Portal password reset (${email}).`,
    created_by: 'admin'
  });

  // The one and only time this password is ever available — nothing
  // persists it in the clear, so hand it to the caller and move on.
  res.status(200).json({ ok: true, created, email, password, accountId: account.id });
}

/** Enable or disable an existing portal account without touching its password. */
async function handlePortalToggle(req, res) {
  const body = await readJson(req);
  const reference = clean(body.reference, 40);
  if (!reference) {
    res.status(400).json({ error: 'reference is required.' });
    return;
  }

  const carrier = await findCarrierByReference(res, reference);
  if (!carrier) return;

  const existing = await supabase.select('carrier_accounts', `select=id,is_active&carrier_id=eq.${encodeURIComponent(carrier.id)}&limit=1`);
  if (!existing[0]) {
    res.status(404).json({ error: 'This carrier has no portal account yet.' });
    return;
  }

  const nextActive = body.active !== undefined ? Boolean(body.active) : !existing[0].is_active;
  const account = await supabase.update('carrier_accounts', `id=eq.${encodeURIComponent(existing[0].id)}`, {
    is_active: nextActive
  });

  await supabase.insert('activities', {
    contact_type: 'carrier',
    contact_ref: reference,
    kind: 'system',
    body: `Portal account ${nextActive ? 'enabled' : 'disabled'}.`,
    created_by: 'admin'
  });

  res.status(200).json({ ok: true, isActive: nextActive, account });
}

/* ------------------------------------------------------------------ *
 * Loads and payments — staff side
 * ------------------------------------------------------------------ */

async function handleLoads(req, res, url) {
  const reference = clean(url.searchParams.get('reference'), 40);
  if (!reference) {
    res.status(400).json({ error: 'reference is required.' });
    return;
  }
  const rows = await supabase.select('loads', `select=*&reference=eq.${encodeURIComponent(reference)}&order=created_at.desc`);
  res.status(200).json({ loads: rows });
}

async function handleLoadSave(req, res) {
  const body = await readJson(req);
  const reference = clean(body.reference, 40);
  if (!reference) {
    res.status(400).json({ error: 'reference is required.' });
    return;
  }

  const status = body.status !== undefined ? body.status : 'booked';
  if (!LOAD_STATUSES.includes(status)) {
    res.status(400).json({ error: `Status must be one of: ${LOAD_STATUSES.join(', ')}` });
    return;
  }

  let rate = null;
  if (body.rate !== undefined && body.rate !== null && body.rate !== '') {
    rate = Number(body.rate);
    if (!Number.isFinite(rate) || rate < 0) {
      res.status(400).json({ error: 'Rate must be a positive number.' });
      return;
    }
  }

  const fields = {
    load_number: clean(body.loadNumber, 60) || null,
    broker: clean(body.broker, 120) || null,
    pickup_city: clean(body.pickupCity, 80) || null,
    pickup_state: clean(body.pickupState, 4) || null,
    pickup_date: clean(body.pickupDate, 10) || null,
    delivery_city: clean(body.deliveryCity, 80) || null,
    delivery_state: clean(body.deliveryState, 4) || null,
    delivery_date: clean(body.deliveryDate, 10) || null,
    rate,
    status,
    notes: clean(body.notes, 2000) || null
  };

  let record;
  if (body.id) {
    // Scope the update to this reference too, so a stray/tampered id from
    // one carrier's load can't be used to edit another carrier's row.
    record = await supabase.update(
      'loads',
      `id=eq.${encodeURIComponent(body.id)}&reference=eq.${encodeURIComponent(reference)}`,
      { ...fields, updated_at: new Date().toISOString() }
    );
    if (!record) {
      res.status(404).json({ error: 'Load not found for this carrier.' });
      return;
    }
  } else {
    const carrier = await findCarrierByReference(res, reference);
    if (!carrier) return;
    record = await supabase.insert('loads', {
      carrier_id: carrier.id,
      reference,
      ...fields,
      created_by: 'admin'
    });
  }

  res.status(200).json({ ok: true, load: record });
}

async function handlePayments(req, res, url) {
  const reference = clean(url.searchParams.get('reference'), 40);
  if (!reference) {
    res.status(400).json({ error: 'reference is required.' });
    return;
  }
  const rows = await supabase.select('payments', `select=*&reference=eq.${encodeURIComponent(reference)}&order=created_at.desc`);
  res.status(200).json({ payments: rows });
}

async function handlePaymentSave(req, res) {
  const body = await readJson(req);
  const reference = clean(body.reference, 40);
  if (!reference) {
    res.status(400).json({ error: 'reference is required.' });
    return;
  }

  const status = body.status !== undefined ? body.status : 'pending';
  if (!PAYMENT_STATUSES.includes(status)) {
    res.status(400).json({ error: `Status must be one of: ${PAYMENT_STATUSES.join(', ')}` });
    return;
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'Amount must be a positive number.' });
    return;
  }

  const fields = {
    load_id: body.loadId || null,
    amount,
    status,
    method: clean(body.method, 80) || null,
    paid_at: status === 'paid' ? (clean(body.paidAt, 30) || new Date().toISOString()) : null,
    notes: clean(body.notes, 2000) || null
  };

  let record;
  if (body.id) {
    record = await supabase.update(
      'payments',
      `id=eq.${encodeURIComponent(body.id)}&reference=eq.${encodeURIComponent(reference)}`,
      fields
    );
    if (!record) {
      res.status(404).json({ error: 'Payment not found for this carrier.' });
      return;
    }
  } else {
    const carrier = await findCarrierByReference(res, reference);
    if (!carrier) return;
    record = await supabase.insert('payments', {
      carrier_id: carrier.id,
      reference,
      ...fields,
      created_by: 'admin'
    });
  }

  res.status(200).json({ ok: true, payment: record });
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const PUBLIC_ACTIONS = new Set(['login', 'session']);

const ROUTES = {
  login: handleLogin,
  session: handleSession,
  logout: handleLogout,
  stats: handleStats,
  contacts: handleContacts,
  contact: handleContact,
  log: handleLog,
  update: handleUpdate,
  portalAccount: handlePortalAccount,
  portalToggle: handlePortalToggle,
  loads: handleLoads,
  loadSave: handleLoadSave,
  payments: handlePayments,
  paymentSave: handlePaymentSave
};

module.exports = async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const action = url.searchParams.get('action') || '';
  const route = ROUTES[action];

  res.setHeader('Cache-Control', 'no-store');

  if (!route) {
    res.status(404).json({ error: `Unknown action "${action}".` });
    return;
  }

  if (!PUBLIC_ACTIONS.has(action) && !auth.verify(req, res)) return;

  if (!PUBLIC_ACTIONS.has(action) && action !== 'logout' && !supabase.isConfigured()) {
    res.status(503).json({ error: 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then redeploy.' });
    return;
  }

  try {
    await route(req, res, url);
  } catch (err) {
    console.error(`[admin:${action}]`, err.message);
    res.status(500).json({ error: 'Something went wrong. Check the function logs.' });
  }
};

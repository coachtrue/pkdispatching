# Haulvera — Landing Page & Carrier Intake

A complete marketing site and carrier onboarding system for **Haulvera** (formerly PK
Dispatching) — carrier and logistics solutions for owner-operators and small fleets.

> **Move Smarter. Earn More.**

Plain HTML, CSS, and JavaScript — no build step, no framework, no bundler.
Deploys to Vercel as a static site plus four small serverless functions.

```
assets/            brand artwork + the guidelines document
index.html         the landing page
styles.css         all styling (responsive, dark-mode aware, print styles)
app.js             forms, validation, multi-step onboarding, file uploads
admin.html         Dispatch Desk — the admin CRM
admin.css          dashboard styling
admin.js           dashboard behaviour (textContent only — see note below)
vercel.json        routing + security headers
supabase/
  schema.sql       tables, indexes, private bucket, RLS — run this once
api/
  leads.js         quick call-back + contact form    -> leads table
  upload.js        one document per request          -> private Supabase bucket
  onboarding.js    express onboarding submission     -> carriers + carrier_documents
  crm.js           the CRM back end (auth + all admin actions)
  _auth.js         admin session signing and verification
  _ghl.js          GoHighLevel push (contacts, custom fields, pipeline)
  _supabase.js     tiny REST client (no dependencies)
  _lib.js          shared helpers
server.js          local dev server (same endpoints, saves to ./data)
```

Stack: **Vercel** hosts the site and functions, **Supabase** stores carrier records and
packet documents, **GitHub** triggers the deploy.

> **The `api/` and `supabase/` folders are not optional.** Vercel only turns a file into an
> API endpoint if it sits in a top-level `api/` directory. GitHub's drag-and-drop uploader
> flattens folders unless you drag the *directory* rather than the files inside it — if
> `api/leads.js` lands at the repo root, every form on the site returns 404 while the
> landing page still looks perfect. Push with git, or drag whole folders.

---

## Brand

Everything follows **Haulvera Brand Guidelines v1.0**, kept in
`assets/Haulvera-Brand-Guidelines.docx`.

| Token | Hex | Use |
|---|---|---|
| Ink Navy | `#0E1F33` | Primary — wordmark, badge fill, headers |
| Steel | `#445468` | Secondary text, tagline |
| Signal Amber | `#F3A73A` | **Accent only** — dividers, CTAs |
| Concrete | `#ECEAE3` | Backgrounds, section panels |

**Amber is never a large background field.** At that scale it reads as a warning label
rather than a brand colour, so it appears only as rules, small badges, and buttons — the
closing CTA band uses Concrete with an amber rule above it.

**Type** has three roles and body copy never uses the display face: Archivo Black / Arial
Black for the h1 and wordmark, Barlow / Arial Bold for headings, Inter / Arial for body.
Arial is the approved fallback for each, so the site loads **no webfonts**; adding the
Google Fonts later upgrades it without touching a single rule.

**The lockup is always the supplied artwork** — never re-set in type, never recoloured.
Three files ship:

| File | Where it's used |
|---|---|
| `haulvera-lockup.png` | Light grounds — header in light theme, login card |
| `haulvera-lockup-reversed.png` | Ink Navy grounds — footer, dark header, admin sidebar |
| `haulvera-icon.png` | Favicon and touch icon |

Both lockups carry a **solid background** rather than transparency — white and `#0E1F33`
respectively. That's why the dark header is opaque Ink Navy instead of translucent: any
alpha there composites the hero through the header and reveals the logo as a lighter
panel. If you ever swap in transparent artwork, that rule can relax.

Carrier reference numbers are now `HV-YYMMDD-XXXXX`. The API still accepts the old `PK-`
prefix, so anything issued before the rename continues to resolve.

---

## Setup, start to finish

### 1. Supabase — create the schema

Dashboard → SQL Editor → New query → paste all of `supabase/schema.sql` → Run.

That creates the `leads`, `carriers`, `carrier_documents`, and `activities` tables, the
`crm_contacts` and `carrier_intake_queue` views the dashboard reads, and a **private**
`carrier-packets` storage bucket. It's idempotent, so re-running it is safe — including
on an existing database, where it only adds what's missing.

### 2. Vercel — set the environment variables

Settings → Environment Variables:

| Variable | Where to find it | Required |
|---|---|---|
| `SUPABASE_URL` | Supabase → Settings → API → Project URL | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → `service_role` key | Yes |
| `ADMIN_PASSWORD` | Invent a strong one — it opens the CRM | Yes |
| `NOTIFY_WEBHOOK` | Your Slack incoming webhook or Zapier catch hook | Recommended |

> **The `service_role` key bypasses Row Level Security.** It is only ever read inside
> `api/` functions, which run on the server — it is never sent to the browser. Don't put
> it in any file under the site root, and don't prefix it with `NEXT_PUBLIC_`.

### 3. Deploy

Push to GitHub — Vercel builds automatically. Or `vercel --prod` from the CLI.
No build settings needed; there's nothing to compile.

### Where your submissions land

- **Supabase `carriers` / `leads` tables** — the durable record. Sort, filter, and work
  the queue from the Supabase dashboard, or query `carrier_intake_queue` for a
  ready-made list with document counts.
- **`NOTIFY_WEBHOOK`** — the real-time ping, so you know a carrier is waiting. The payload
  includes **7-day signed links** to each uploaded document, clickable straight from Slack.

If the database write ever fails, the submission is **not** lost — the carrier still gets a
success page and the webhook still fires, flagged `savedToDatabase: false`.

---

## GoHighLevel

GHL is the CRM. Every carrier and lead is pushed there on submission, and that is where
contact, follow-up, and automation happen. The site stays the system of record for the
things GHL has no concept of: the freight fields and the carrier packet.

**What gets pushed**

- The contact, upserted — GHL matches on email/phone, so a lead who later completes
  onboarding enriches the same record instead of creating a duplicate.
- Freight data mapped to custom fields: MC, USDOT, authority age, equipment, endorsements,
  truck count, home base, radius, rate floor, lanes, factoring, availability.
- Tags: `carrier` / `lead`, one per equipment type, and **`ready-now`** when a carrier says
  they're empty today — that's the one worth building an automation on.
- A note carrying the carrier's own words and 7-day signed links to their documents.
- An opportunity in your pipeline (optional — set `GHL_PIPELINE_ID`).
- A **Carrier Packet** field linking to `/admin?ref=…`, which opens straight to that
  carrier's documents with freshly minted links. Signed links expire; this one never does.

### Setup

1. Create a sub-account for Haulvera. Copy its **Location ID** from
   Settings → Business Profile.
2. Create a **Private Integration** token in that sub-account with these scopes:
   `contacts.write`, `contacts.readonly`, `locations/customFields.write`,
   `locations/customFields.readonly`, `locations.readonly`, `opportunities.write`.
3. Run the setup script — it creates all 16 custom fields for you and prints the
   environment variables:

```bash
GHL_API_TOKEN=pit-xxxx GHL_LOCATION_ID=xxxx node ghl-setup.js
```

   Add `--dry` to see what it would do first. Re-running is safe: existing fields are
   reused, never duplicated.

4. Paste the printed variables into Vercel and **redeploy**.

| Variable | Purpose |
|---|---|
| `GHL_API_TOKEN` | Private Integration token — server only, never sent to the browser |
| `GHL_LOCATION_ID` | The sub-account this site feeds |
| `GHL_FIELD_MAP` | `{fieldKey: customFieldId}` — printed by `ghl-setup.js` |
| `GHL_PIPELINE_ID` | Optional — opens an opportunity per carrier |
| `GHL_STAGE_ID` | Optional — which stage they land in |

> A GoHighLevel outage can never cost you a carrier. The push is wrapped: the carrier still
> gets their success page, the record still lands in Supabase, and the webhook still fires
> flagged `inGoHighLevel: false` so you know to add them by hand.

### Before you text carriers from GHL

US carriers require **A2P 10DLC registration** before SMS delivers reliably, and that
process asks for evidence of documented opt-in. The onboarding form already collects it —
*"I authorize Haulvera to contact me by phone, SMS, and email… Reply STOP to opt
out."* Point at the form when you register the campaign.

---

## Dispatch Desk — the admin CRM

Live at **`/admin`** on your deployment. Sign in with `ADMIN_PASSWORD`.

With GoHighLevel connected, this becomes the **packet viewer** rather than your daily
workspace — GHL is where you work the contacts. Its job is the carrier documents, which
GHL cannot hold safely, and `/admin?ref=HV-…` opens straight to one carrier from a GHL link.

**What it does**

- **Queue view** — every carrier and lead in one list, with status, equipment, document
  count, days since last contact, and follow-up date. Filter by type or status, or search
  name, MC number, phone, email, or reference.
- **Summary tiles** — new carriers, verifying, active, new leads, arrived today, and
  follow-ups due. Anything needing attention carries an amber rail.
- **Contact detail** — the full submission, one-tap Call / Text / Email, and the carrier's
  packet documents behind **fresh one-hour signed links**, minted per view rather than
  stored, so an old open tab can't keep handing out access to a W-9.
- **Communications log** — record calls, texts, emails, and private notes against a
  contact. Logging a real conversation stamps `last_contacted_at`; a private note doesn't.
- **Pipeline** — carriers move `new → verifying → approved → active → paused / rejected`,
  leads `new → contacted → qualified → converted / lost`. Every status change writes
  itself into the timeline, so you can reconstruct what happened months later.

**How access works**

One shared password is exchanged for a signed, expiring session cookie (12 hours,
HttpOnly, SameSite=Strict, Secure in production). There's no session table, which suits
serverless — the cookie carries its own proof. Changing `ADMIN_PASSWORD` invalidates every
existing session, because the signing key is derived from it.

That's the right shape for a small team. If you later need per-person logins and an audit
trail naming who did what, move to Supabase Auth — `api/_auth.js` is the only file that
would change.

> The dashboard renders text that carriers typed — company names, notes, file names. It's
> built entirely with `textContent`, never `innerHTML`, so a carrier can't inject script
> into your admin session. There's a test that proves it. **Keep it that way** if you edit
> `admin.js`.

### Document privacy

The `carrier-packets` bucket is **private**. Nothing is world-readable. Documents are
reached only through short-lived signed URLs the server mints, and RLS is enabled with no
policies, so the anon key can't read carrier PII even if it leaks. This matters — these are
W-9s, CDLs, and insurance certificates. Signed links still grant access to whoever holds
them, so treat the webhook channel as sensitive.

---

## Run it locally

```bash
node server.js      # http://localhost:3000
```

No `npm install` needed for local dev — `server.js` has zero dependencies and writes
submissions to `./data` instead of Blob storage:

```
data/
├─ leads.ndjson
├─ onboarding.ndjson
└─ uploads/HV-260812-A1B2C3/
   ├─ submission.json
   ├─ authority-mc-letter.pdf
   └─ w9-w9.pdf
```

`data/` is gitignored — carrier documents contain PII and must never be committed.

---

## ⚠️ Replace before going live

| Placeholder | Where | Status |
|---|---|---|
| `(555) 555-0123` / `+15555550123` | `index.html`, `app.js` | **Still a placeholder** |
| `dispatch@haulvera.com` | `index.html`, `app.js` | **Still a placeholder** |
| `packets@haulvera.com` | `index.html`, `app.js`, `api/upload.js` | **Still a placeholder** |
| `haulvera.com` (canonical + schema) | `index.html` | **Still a placeholder** |
| Dispatch fee — **10% of gross, single rate** | `index.html` → `#pricing` | ✅ Confirmed |
| Terms of Service / Privacy Policy | `app.js` → `MODAL_CONTENT` | Draft — have counsel review |

Pricing is a single 10% plan — no tiers. If you ever add a second plan, drop another
`<article class="plan">` into `.pricing` and remove the `pricing--solo` / `plan--solo`
classes; the grid goes back to side-by-side columns on its own.

---

## How carrier information is captured

Three capture points, in increasing depth:

1. **Hero quick form** — name, phone, email, MC/DOT, equipment. For carriers who want a call back.
2. **Contact form** — name, company, phone, email, topic, message. For questions.
3. **Express onboarding** — the full four-step flow below.

| Step | Captures |
|---|---|
| 1. Company | Legal name, DBA, contact, role, phone, email, MC, USDOT, authority age, home base |
| 2. Equipment & Lanes | Equipment types, truck count, radius, minimum RPM, preferred/avoided lanes, factoring company, availability, endorsements |
| 3. Documents | MC authority, COI, W-9, NOA, CDL & med card, plus anything else |
| 4. Review | Full read-back, notes, referral source, three consent checkboxes, typed e-signature |

Each step validates before advancing, and every earlier step is re-validated on submit so
nothing slips through. Carriers get a reference number (`HV-YYMMDD-XXXXX`) on success.

### How uploads work, and why

**Vercel caps a serverless function's request body at ~4.5 MB.** Posting a whole carrier
packet as one multipart request would fail, so documents go up **one per request**:

```
POST /api/upload?name=coi.pdf&category=insurance&reference=HV-260812-A1B2C3
     body: the raw file bytes  ->  { path, bytes, contentType }

POST /api/onboarding
     body: { ...carrier fields, documents: [{ category, name, bytes, path }] }
```

`path` points into the private bucket — it is not a link, and it is useless without a
signed URL minted by the server.

Each file is capped at **4 MB**, which comfortably covers a phone photo or a scanned PDF.
The UI tells carriers to email anything larger. Uploads run sequentially with a live
"Uploading document 2 of 4…" counter.

Validation happens on both ends — extension allowlist, size cap, and known-category check
client-side for fast feedback, and again server-side because the browser can't be trusted.
Filenames are stripped of path separators, so `../../evil.pdf` becomes `evil.pdf`.

If uploads or the API fail for any reason, the form falls back to opening a pre-filled
email with all the carrier's details and a list of documents to attach. The typed data is
never lost.

---

## Configuration

Front-end settings live at the top of `app.js`:

```js
var CONFIG = {
  leadEndpoint: '/api/leads',
  onboardEndpoint: '/api/onboarding',
  uploadEndpoint: '/api/upload',
  fallbackEmail: 'dispatch@haulvera.com',
  packetEmail: 'packets@haulvera.com',
  phone: '(555) 555-0123',
  maxFileBytes: 4 * 1024 * 1024,
  allowedExtensions: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'doc', 'docx', 'webp']
};
```

Server/function environment variables:

| Variable | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL` | `api/*` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `api/*` | Server-only key; bypasses RLS |
| `SUPABASE_BUCKET` | `api/upload.js` | Defaults to `carrier-packets` |
| `NOTIFY_WEBHOOK` | `api/*` | Real-time submission alerts |
| `PORT`, `DATA_DIR` | `server.js` | Local dev only |

---

## What's on the page

Hero with quick-capture form · service commitments strip · three-step express lane overview ·
nine dispatch services · six-stage process timeline · nine equipment types · a single 10%
pricing plan with an explicit "what's never included" list · carrier packet document checklist ·
the four-step onboarding form · an honest comparison section · ten-question FAQ · contact
section with a second form · sticky mobile call/signup bar · Terms and Privacy modals.

## Notes on how it's built

- **Accessibility**: skip link, labelled fields, `aria-invalid` on errors, keyboard-operable
  dropzones, focus-visible outlines, Escape-to-close modal with focus restore, live regions
  for status messages.
- **Anti-spam**: every form carries a hidden honeypot field, checked on both ends. A tripped
  honeypot returns success without firing the webhook, so the bot learns nothing.
- **Security**: uploads are extension-allowlisted and size-capped server-side, filenames
  sanitized against path traversal, submitted reference numbers pattern-checked before being
  used as a storage path, and webhook payloads length-capped. The local server confines
  static file serving to the site root and refuses to serve anything under `data/`.
- **SEO**: descriptive title and meta description, Open Graph tags, canonical URL, and
  `LocalBusiness` JSON-LD structured data.
- **Responsive**: single-column below 700px, hamburger nav and sticky action bar below
  1200px, verified with zero horizontal overflow at 390px.
- **Dark mode**: full palette via `prefers-color-scheme`.

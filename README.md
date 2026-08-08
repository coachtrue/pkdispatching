# PK Dispatching — Landing Page & Carrier Intake

A complete marketing site and carrier onboarding system for PK Dispatching, a freight
dispatch service for owner-operators and small fleets.

Plain HTML, CSS, and JavaScript — no build step, no framework, no bundler.
Deploys to Vercel as a static site plus three small serverless functions.

```
index.html         the landing page
styles.css         all styling (responsive, dark-mode aware, print styles)
app.js             forms, validation, multi-step onboarding, file uploads
vercel.json        routing + security headers
supabase/
  schema.sql       tables, indexes, private bucket, RLS — run this once
api/
  leads.js         quick call-back + contact form    -> leads table
  upload.js        one document per request          -> private Supabase bucket
  onboarding.js    express onboarding submission     -> carriers + carrier_documents
  _supabase.js     tiny REST client (no dependencies)
  _lib.js          shared helpers
server.js          local dev server (same three endpoints, saves to ./data)
```

Stack: **Vercel** hosts the site and functions, **Supabase** stores carrier records and
packet documents, **GitHub** triggers the deploy.

---

## Setup, start to finish

### 1. Supabase — create the schema

Dashboard → SQL Editor → New query → paste all of `supabase/schema.sql` → Run.

That creates the `leads`, `carriers`, and `carrier_documents` tables, a
`carrier_intake_queue` view for your dashboard, and a **private** `carrier-packets`
storage bucket. It's idempotent, so re-running it is safe.

### 2. Vercel — set three environment variables

Settings → Environment Variables:

| Variable | Where to find it | Required |
|---|---|---|
| `SUPABASE_URL` | Supabase → Settings → API → Project URL | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → `service_role` key | Yes |
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
└─ uploads/PK-260808-A1B2C3/
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
| `dispatch@pkdispatching.com` | `index.html`, `app.js` | **Still a placeholder** |
| `packets@pkdispatching.com` | `index.html`, `app.js`, `api/upload.js` | **Still a placeholder** |
| `pkdispatching.com` (canonical + schema) | `index.html` | **Still a placeholder** |
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
nothing slips through. Carriers get a reference number (`PK-YYMMDD-XXXXX`) on success.

### How uploads work, and why

**Vercel caps a serverless function's request body at ~4.5 MB.** Posting a whole carrier
packet as one multipart request would fail, so documents go up **one per request**:

```
POST /api/upload?name=coi.pdf&category=insurance&reference=PK-260808-A1B2C3
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
  fallbackEmail: 'dispatch@pkdispatching.com',
  packetEmail: 'packets@pkdispatching.com',
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

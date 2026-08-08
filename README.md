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
api/
  leads.js         quick call-back + contact form       (JSON)
  upload.js        one carrier document per request     (raw body -> Vercel Blob)
  onboarding.js    express onboarding submission        (JSON + document URLs)
  _lib.js          shared helpers
server.js          local dev server (same three endpoints, saves to ./data)
```

---

## Deploy to Vercel

```bash
npm i -g vercel     # if you don't have it
vercel              # preview deploy
vercel --prod       # production
```

Or push to GitHub and import the repo at vercel.com — it needs no build settings.

### Two things to set up in the Vercel dashboard

**1. Blob storage** (required for document uploads)
Storage → Create Database → **Blob** → connect it to this project. That injects
`BLOB_READ_WRITE_TOKEN` automatically. Until this exists, uploads return a clear
"storage not configured" message and carriers are told to email their packet instead —
the site still works, you just don't get uploads.

**2. `NOTIFY_WEBHOOK`** (strongly recommended)
Settings → Environment Variables. **Serverless has no disk, so this webhook is your
inbox.** Without it, submissions exist only in the Vercel function logs.

Point it at whatever you already use:
- **Slack** — an incoming webhook URL, and submissions land in a channel
- **Zapier / Make** — a catch hook, then route to email, Google Sheets, or a CRM

Every submission posts a JSON summary including clickable links to the uploaded documents.

### ⚠️ About uploaded document privacy

Uploaded files go to Vercel Blob with `access: 'public'` and a random suffix — the URL is
unguessable, but anyone holding the link can open it. **These are W-9s, CDLs, and insurance
certificates.** That's normally acceptable since the links only ever go to your webhook,
but treat those links as sensitive: don't paste them into public channels. If you need
stricter handling, move `api/upload.js` to a private store (S3 with signed URLs, or a
private Blob store) — it's the only file that would change.

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
| Percentage fee — **10%** | `index.html` → `#pricing` | ✅ Confirmed |
| Flat weekly — **$350/truck/week** | `index.html` → `#pricing` | **Unconfirmed guess** |
| Fleet tier — **Custom, 3+ trucks** | `index.html` → `#pricing` | **Unconfirmed guess** |
| Terms of Service / Privacy Policy | `app.js` → `MODAL_CONTENT` | Draft — have counsel review |

If you only sell the 10% percentage plan, delete the Flat Weekly and Fleet `<article
class="plan">` blocks — the grid reflows to whatever is left with no CSS changes.

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
     body: the raw file bytes    ->  { url, bytes }

POST /api/onboarding
     body: { ...carrier fields, documents: [{ category, name, bytes, url }] }
```

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
| `BLOB_READ_WRITE_TOKEN` | `api/upload.js` | Set automatically when you connect a Blob store |
| `NOTIFY_WEBHOOK` | all functions | Where submissions are delivered |
| `PORT`, `DATA_DIR` | `server.js` | Local dev only |

---

## What's on the page

Hero with quick-capture form · service commitments strip · three-step express lane overview ·
nine dispatch services · six-stage process timeline · nine equipment types · three pricing
tiers with an explicit "what's never included" list · carrier packet document checklist ·
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

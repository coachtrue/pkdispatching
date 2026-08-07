# PK Dispatching — Landing Page & Carrier Intake

A complete, self-contained marketing site and carrier onboarding system for PK Dispatching,
a freight dispatch service for owner-operators and small fleets.

Built with plain HTML, CSS, and JavaScript — no build step, no framework, no npm install.
The optional Node backend has **zero dependencies**.

```
index.html    the landing page
styles.css    all styling (responsive, dark-mode aware, print styles)
app.js        forms, validation, multi-step onboarding, file uploads
server.js     optional Node server: hosts the site + receives submissions
```

---

## ⚠️ Replace before going live

The site ships with placeholder business details. Search and replace these:

| Placeholder | Where | Notes |
|---|---|---|
| `(555) 555-0123` / `+15555550123` | `index.html`, `app.js` | Your real dispatch number |
| `dispatch@pkdispatching.com` | `index.html`, `app.js` | General inbox |
| `packets@pkdispatching.com` | `index.html`, `app.js` | Carrier packet inbox |
| `pkdispatching.com` | `index.html` (canonical + schema) | Your real domain |
| **`5%` / `$350/week` / `Custom`** | `index.html` → `#pricing` | **Confirm your actual fees** |
| Terms of Service / Privacy Policy | `app.js` → `MODAL_CONTENT` | Plain-language drafts — have counsel review |

The pricing tiers, the "24 hours" turnaround claims, and the service commitments in the
Terms/Privacy modals are reasonable industry defaults written as a starting point. They are
**your** promises once published — read them and adjust to what you actually do.

---

## Run it

```bash
node server.js              # http://localhost:3000
PORT=8080 node server.js    # different port
npm start                   # same thing
```

No install required (Node 18+).

---

## How carrier information is captured

There are three capture points, in increasing depth:

1. **Hero quick form** — name, phone, email, MC/DOT, equipment. For carriers who want a call back.
2. **Contact form** — name, company, phone, email, topic, message. For questions.
3. **Express onboarding** — the full four-step flow: company & authority details, equipment and
   lane preferences, carrier packet document uploads, then review, e-signature, and consent.

### Express onboarding flow

| Step | Captures |
|---|---|
| 1. Company | Legal name, DBA, contact, role, phone, email, MC, USDOT, authority age, home base |
| 2. Equipment & Lanes | Equipment types, truck count, radius, minimum RPM, preferred/avoided lanes, factoring company, availability, endorsements |
| 3. Documents | MC authority, COI, W-9, NOA, CDL & med card, plus anything else |
| 4. Review | Full read-back, notes, referral source, three consent checkboxes, typed e-signature |

Each step validates before advancing, and every step is re-validated on submit so nothing
slips through. Carriers get a reference number (`PK-YYMMDD-XXXXX`) on success.

### Document uploads

- Drag-and-drop or tap-to-browse (works with a phone camera).
- Accepts PDF, JPG, PNG, HEIC, WEBP, DOC, DOCX — max 15 MB per file.
- Rejects unsupported types and oversize files **client-side** with a clear message,
  and again **server-side** (never trust the browser).
- Files can be removed before submitting; duplicates are ignored.
- A running summary tells the carrier which required documents are still missing —
  but they can submit anyway, and you follow up.

---

## Where submissions go

With `server.js` running:

```
data/
├─ leads.ndjson              one JSON line per quick/contact form
├─ onboarding.ndjson         one JSON line per express submission
└─ uploads/
   └─ PK-260807-A1B2C3/
      ├─ submission.json     full record for this carrier
      ├─ authority-mc-letter.pdf
      ├─ insurance-coi.pdf
      └─ w9-w9.pdf
```

Uploaded files are prefixed with their document category so the folder reads at a glance.

`data/` is gitignored — carrier documents contain PII and must never be committed.

### Get notified

Set `NOTIFY_WEBHOOK` to any URL that accepts JSON — a Slack incoming webhook, a Zapier catch
hook, or your CRM — and every submission posts a summary there in real time:

```bash
NOTIFY_WEBHOOK="https://hooks.slack.com/services/..." node server.js
```

---

## Deploying

**Option A — Node host** (Railway, Render, Fly.io, a VPS): deploy the repo, run `npm start`.
Forms and uploads work out of the box. Put persistent storage or S3 behind `DATA_DIR` if the
host has an ephemeral filesystem.

**Option B — Static host** (Netlify, Vercel, GitHub Pages, S3): upload `index.html`,
`styles.css`, and `app.js`. The page works fully, but `/api/*` won't exist — so submissions
fall back to opening a pre-filled email to `packets@pkdispatching.com` with all the carrier's
details in the body, prompting them to attach their documents. Nothing is lost, but it's a
worse experience. To get real uploads on a static host, point `CONFIG.onboardEndpoint` in
`app.js` at a form service that accepts multipart (Formspree, Basin, Netlify Forms) or a
serverless function.

Serve over **HTTPS** in production — carriers are uploading authority letters, insurance
certificates, and W-9s.

---

## Configuration

Front-end settings live at the top of `app.js`:

```js
var CONFIG = {
  leadEndpoint: '/api/leads',
  onboardEndpoint: '/api/onboarding',
  fallbackEmail: 'dispatch@pkdispatching.com',
  packetEmail: 'packets@pkdispatching.com',
  phone: '(555) 555-0123',
  maxFileBytes: 15 * 1024 * 1024,
  allowedExtensions: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'doc', 'docx', 'webp']
};
```

Server settings are environment variables: `PORT`, `DATA_DIR`, `NOTIFY_WEBHOOK`.

---

## What's on the page

Hero with quick-capture form · service commitments strip · three-step express lane overview ·
nine dispatch services · six-stage process timeline · nine equipment types · three pricing tiers
with an explicit "what's never included" list · carrier packet document checklist ·
the four-step onboarding form · an honest comparison section · ten-question FAQ ·
contact section with a second form · sticky mobile call/signup bar · Terms and Privacy modals.

## Notes on how it's built

- **Accessibility**: skip link, labelled fields, `aria-invalid` on errors, keyboard-operable
  dropzones, focus-visible outlines, Escape-to-close modal with focus restore, live regions
  for status messages.
- **Anti-spam**: every form carries a hidden honeypot field, checked on both ends.
- **Security**: uploads are extension-allowlisted and size-capped server-side, filenames are
  sanitized against path traversal, static file serving is confined to the site root and
  refuses to serve anything under `data/`.
- **SEO**: descriptive title and meta description, Open Graph tags, canonical URL, and
  `LocalBusiness` JSON-LD structured data.
- **Responsive**: single-column below 700px, hamburger nav and sticky action bar below 1200px,
  verified with zero horizontal overflow at 390px.
- **Dark mode**: full palette via `prefers-color-scheme`.

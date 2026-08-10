-- =====================================================================
-- PK Dispatching — carrier intake schema
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: everything is IF NOT EXISTS / idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Storage: a PRIVATE bucket for carrier packet documents.
-- Private matters — these are W-9s, CDLs, and insurance certificates.
-- Nothing is world-readable; the app mints short-lived signed URLs.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('carrier-packets', 'carrier-packets', false)
on conflict (id) do update set public = false;

-- ---------------------------------------------------------------------
-- Leads: hero call-back form + general contact form
-- ---------------------------------------------------------------------
create table if not exists public.leads (
  id              uuid primary key default gen_random_uuid(),
  reference       text unique not null,
  form_type       text not null default 'lead',
  name            text not null,
  email           text not null,
  phone           text not null,
  company_name    text,
  mc_number       text,
  equipment       text,
  topic           text,
  message         text,
  status          text not null default 'new',
  ip              text,
  user_agent      text,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Carriers: express onboarding submissions
-- ---------------------------------------------------------------------
create table if not exists public.carriers (
  id                 uuid primary key default gen_random_uuid(),
  reference          text unique not null,

  company_name       text not null,
  dba                text,
  contact_name       text not null,
  contact_role       text,
  phone              text not null,
  email              text not null,

  mc_number          text not null,
  dot_number         text not null,
  authority_age      text,

  home_city          text,
  home_state         text,

  truck_count        integer,
  equipment          text[] not null default '{}',
  endorsements       text[] not null default '{}',
  operating_radius   text,
  min_rate_per_mile  text,
  preferred_lanes    text,
  avoid_areas        text,
  factoring_company  text,
  availability       text,

  referral_source    text,
  notes              text,

  signature          text,
  consent_contact    boolean not null default false,
  consent_documents  boolean not null default false,
  consent_terms      boolean not null default false,
  signed_at          timestamptz,

  -- Workflow: new -> verifying -> approved / rejected
  status             text not null default 'new',

  ip                 text,
  user_agent         text,
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Documents: one row per uploaded carrier packet file
-- ---------------------------------------------------------------------
create table if not exists public.carrier_documents (
  id            uuid primary key default gen_random_uuid(),
  carrier_id    uuid references public.carriers (id) on delete cascade,
  reference     text not null,
  category      text not null,
  file_name     text not null,
  storage_path  text not null,
  content_type  text,
  bytes         bigint,
  created_at    timestamptz not null default now()
);

create index if not exists leads_created_at_idx        on public.leads (created_at desc);
create index if not exists leads_status_idx            on public.leads (status);
create index if not exists carriers_created_at_idx     on public.carriers (created_at desc);
create index if not exists carriers_status_idx         on public.carriers (status);
create index if not exists carriers_mc_idx             on public.carriers (mc_number);
create index if not exists documents_reference_idx     on public.carrier_documents (reference);
create index if not exists documents_carrier_id_idx    on public.carrier_documents (carrier_id);

-- ---------------------------------------------------------------------
-- Row Level Security
--
-- RLS is ON with NO policies, which denies everything to the anon and
-- authenticated keys. The API functions use the service role key, which
-- bypasses RLS by design. Net effect: carrier PII is unreachable from the
-- browser even if the anon key leaks.
-- ---------------------------------------------------------------------
alter table public.leads             enable row level security;
alter table public.carriers          enable row level security;
alter table public.carrier_documents enable row level security;

-- =====================================================================
-- CRM
-- =====================================================================

-- Follow-up tracking on both contact types.
alter table public.leads    add column if not exists owner             text;
alter table public.leads    add column if not exists next_follow_up    date;
alter table public.leads    add column if not exists last_contacted_at timestamptz;

alter table public.carriers add column if not exists owner             text;
alter table public.carriers add column if not exists next_follow_up    date;
alter table public.carriers add column if not exists last_contacted_at timestamptz;

-- ---------------------------------------------------------------------
-- Activities: every call, text, email, note, and status change.
-- Keyed by reference rather than a foreign key so a single timeline works
-- across both leads and carriers, including a lead that later onboards.
-- ---------------------------------------------------------------------
create table if not exists public.activities (
  id            uuid primary key default gen_random_uuid(),
  contact_type  text not null check (contact_type in ('lead', 'carrier')),
  contact_ref   text not null,
  kind          text not null check (kind in ('call', 'sms', 'email', 'note', 'status', 'system')),
  direction     text check (direction in ('inbound', 'outbound')),
  subject       text,
  body          text,
  created_by    text not null default 'admin',
  created_at    timestamptz not null default now()
);

create index if not exists activities_ref_idx     on public.activities (contact_ref, created_at desc);
create index if not exists activities_created_idx on public.activities (created_at desc);

alter table public.activities enable row level security;

-- ---------------------------------------------------------------------
-- One list to work from, whichever door the contact came through.
-- ---------------------------------------------------------------------
create or replace view public.crm_contacts as
select
  'carrier'::text                as contact_type,
  c.reference,
  c.company_name                 as name,
  c.contact_name,
  c.phone,
  c.email,
  c.mc_number,
  c.status,
  c.owner,
  c.equipment,
  c.truck_count,
  c.home_city,
  c.home_state,
  c.next_follow_up,
  c.last_contacted_at,
  c.created_at,
  (select count(*) from public.carrier_documents d where d.reference = c.reference) as document_count,
  (select count(*) from public.activities a where a.contact_ref = c.reference)      as activity_count
from public.carriers c
union all
select
  'lead'::text,
  l.reference,
  coalesce(nullif(l.company_name, ''), l.name),
  l.name,
  l.phone,
  l.email,
  l.mc_number,
  l.status,
  l.owner,
  case when l.equipment is null or l.equipment = '' then '{}'::text[] else array[l.equipment] end,
  null::integer,
  null::text,
  null::text,
  l.next_follow_up,
  l.last_contacted_at,
  l.created_at,
  0,
  (select count(*) from public.activities a where a.contact_ref = l.reference)
from public.leads l;

-- ---------------------------------------------------------------------
-- Convenience view for your dashboard: carriers with a document count
-- ---------------------------------------------------------------------
create or replace view public.carrier_intake_queue as
select
  c.reference,
  c.created_at,
  c.status,
  c.company_name,
  c.contact_name,
  c.phone,
  c.email,
  c.mc_number,
  c.dot_number,
  c.home_city,
  c.home_state,
  c.truck_count,
  c.equipment,
  c.availability,
  count(d.id) as document_count
from public.carriers c
left join public.carrier_documents d on d.carrier_id = c.id
group by c.id
order by c.created_at desc;

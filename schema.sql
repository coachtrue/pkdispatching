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

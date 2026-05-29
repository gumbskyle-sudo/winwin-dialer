-- ════════════════════════════════════════════════════════════════
-- COMBINED SUPABASE SCHEMA — Dialer + CRM + SMS + Buyers + Recordings
-- Run this ONCE in Supabase SQL Editor → Run.
-- Safe to re-run (all statements use IF NOT EXISTS or ON CONFLICT).
--
-- Builds (in dependency order):
--   1. Base dialer:        properties, phones, leads
--   2. CRM:                deals, profiles, deal_notes
--   3. SMS / drips:        messages, drip_campaigns, opt-outs, config
--   4. v5 additions:       owner_last_name, va_notes, qualifier columns
--   5. v6 additions:       buyers + buyer_sends + va_recordings + storage
--   6. v6.2 patch:         q_callback_time
-- ════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────
-- 1. BASE DIALER SCHEMA
-- ──────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════
-- Real Estate Dialer — Supabase schema
-- Paste this whole file into Supabase → SQL Editor → Run.
-- Safe to re-run: uses IF NOT EXISTS / IF EXISTS where possible.
-- ════════════════════════════════════════════════════════════════

-- Properties (uploaded via CSV)
create table if not exists public.properties (
  id              text primary key,
  owners          text not null default '',
  property_address text not null default '',
  mailing_address text not null default '',
  custom_fields   jsonb not null default '{}'::jsonb,
  imported_at     timestamptz not null default now()
);
create index if not exists properties_imported_idx on public.properties(imported_at);

create table if not exists public.phones (
  id          serial primary key,
  property_id text not null references public.properties(id) on delete cascade,
  e164        text not null,
  display     text not null,
  type        text not null default ''
);
create index if not exists phones_property_idx on public.phones(property_id);

-- Lead state per property — shared across the team
create table if not exists public.leads (
  property_id text primary key references public.properties(id) on delete cascade,
  called      boolean not null default false,
  lead_status text not null default '',
  notes       text not null default '',
  updated_at  timestamptz not null default now()
);

-- Outbound calls (from Twilio) — for KPI dashboard
create table if not exists public.calls (
  id          bigserial primary key,
  twilio_sid  text unique not null,
  property_id text references public.properties(id) on delete set null,
  from_number text,
  to_number   text,
  status      text,
  duration    integer not null default 0,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);
create index if not exists calls_started_idx on public.calls(started_at desc);

-- ════════════════════════════════════════════════════════════════
-- Lock everything down. The Netlify Function uses the SERVICE_ROLE
-- key to bypass RLS; nobody else should touch this DB directly.
-- ════════════════════════════════════════════════════════════════

alter table public.properties enable row level security;
alter table public.phones     enable row level security;
alter table public.leads      enable row level security;
alter table public.calls      enable row level security;

-- No policies = no public access. Service role bypasses RLS by design.

-- ──────────────────────────────────────────────────────────────────
-- 2. CRM SCHEMA
-- ──────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════
-- CRM additions to the Call Booklet schema
-- Paste this whole file into Supabase → SQL Editor → Run.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════

-- ── Profiles (team members) ──────────────────────────────────
create table if not exists public.profiles (
  id          serial primary key,
  name        text not null unique,
  created_at  timestamptz not null default now()
);

-- ── Deals ────────────────────────────────────────────────────
create table if not exists public.deals (
  id              serial primary key,
  property_id     text references public.properties(id) on delete set null,

  -- Snapshot of property info at time of deal creation (so deals survive list replacement)
  owners          text not null default '',
  property_address text not null default '',
  mailing_address text not null default '',
  bed             integer,
  bath            numeric(3,1),
  sqft            integer,
  year_built      integer,
  source_list     text default '',

  -- Stage: hot, underwriting, offer, contract, closed
  stage           text not null default 'hot',
  deal_type       text not null default 'assignment',  -- 'assignment' or 'flip'

  -- Financials (all optional)
  arv             numeric(12,2),
  repairs         numeric(12,2),
  seller_asking   numeric(12,2),
  your_offer      numeric(12,2),
  mao_percent     numeric(5,2) default 70,  -- editable 70% rule

  -- Assignment-specific
  assignment_fee  numeric(12,2),
  buyer_closing_costs numeric(12,2),

  -- Flip-specific
  purchase_closing_costs numeric(12,2),
  holding_monthly numeric(12,2),
  holding_months  numeric(5,2),
  selling_costs_pct numeric(5,2),  -- as percent of resale
  resale_price    numeric(12,2),

  -- Assignment
  assigned_to_profile integer references public.profiles(id) on delete set null,
  created_by_profile  integer references public.profiles(id) on delete set null,

  -- Lifecycle
  closed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  archived        boolean not null default false
);
create index if not exists deals_stage_idx       on public.deals(stage);
create index if not exists deals_assigned_idx    on public.deals(assigned_to_profile);
create index if not exists deals_property_idx    on public.deals(property_id);
create index if not exists deals_updated_idx     on public.deals(updated_at desc);

-- ── Comps (link cards on a deal) ─────────────────────────────
create table if not exists public.deal_comps (
  id          serial primary key,
  deal_id     integer not null references public.deals(id) on delete cascade,
  label       text not null default '',
  url         text not null default '',
  sale_price  numeric(12,2),
  created_at  timestamptz not null default now()
);
create index if not exists deal_comps_deal_idx on public.deal_comps(deal_id);

-- ── Documents (link cards on a deal) ─────────────────────────
create table if not exists public.deal_docs (
  id          serial primary key,
  deal_id     integer not null references public.deals(id) on delete cascade,
  label       text not null default '',
  url         text not null default '',
  doc_type    text not null default 'other',  -- contract, photos, comps, other
  created_at  timestamptz not null default now()
);
create index if not exists deal_docs_deal_idx on public.deal_docs(deal_id);

-- ── Notes / activity ─────────────────────────────────────────
create table if not exists public.deal_notes (
  id          serial primary key,
  deal_id     integer not null references public.deals(id) on delete cascade,
  profile_id  integer references public.profiles(id) on delete set null,
  body        text not null default '',
  kind        text not null default 'note',  -- note, stage_change, offer, system
  created_at  timestamptz not null default now()
);
create index if not exists deal_notes_deal_idx on public.deal_notes(deal_id, created_at);

-- ── Add profile_id to calls table for per-rep attribution ────
alter table public.calls
  add column if not exists profile_id integer references public.profiles(id) on delete set null;

-- ── Touch deals.updated_at trigger ───────────────────────────
create or replace function public.deals_touch() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists deals_touch on public.deals;
create trigger deals_touch before update on public.deals
  for each row execute procedure public.deals_touch();

-- ── RLS: lock these tables down too ─────────────────────────
alter table public.profiles   enable row level security;
alter table public.deals      enable row level security;
alter table public.deal_comps enable row level security;
alter table public.deal_docs  enable row level security;
alter table public.deal_notes enable row level security;
-- Service role bypasses RLS; no public policies needed.

-- ──────────────────────────────────────────────────────────────────
-- 3. SMS / DRIP SCHEMA
-- ──────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════
-- SMS / Drip Campaign additions to the dialer CRM
-- Run AFTER supabase-schema.sql and supabase-crm-schema.sql.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════

-- ── Consent tracking on leads ────────────────────────────────
-- We add columns to existing tables. The "preferred cell" is the
-- specific phone number from the lead's phones[] that they consented
-- to be texted on.
alter table public.leads
  add column if not exists sms_consent       text not null default 'none',  -- 'none' | 'verbal' | 'written' | 'revoked'
  add column if not exists sms_consent_at    timestamptz,
  add column if not exists sms_consent_by    text default '',                -- caller name or note
  add column if not exists sms_cell          text default '';                -- E.164 cell they consented to

create index if not exists leads_sms_consent_idx on public.leads(sms_consent);

-- ── Two-way message log ──────────────────────────────────────
-- Every text in or out lives here. Drip messages + manual messages.
create table if not exists public.messages (
  id            bigserial primary key,
  twilio_sid    text unique,                          -- nullable for queued/draft
  deal_id       integer references public.deals(id) on delete set null,
  property_id   text references public.properties(id) on delete set null,
  to_number     text not null,                        -- E.164
  from_number   text not null,                        -- E.164 (your Twilio number)
  direction     text not null,                        -- 'outbound' | 'inbound'
  body          text not null,
  status        text not null default 'queued',       -- queued|sending|sent|delivered|failed|received
  error_message text,
  campaign_id   integer,                              -- nullable; ties to drip_campaigns.id
  step_index    integer,                              -- which step in the drip
  scheduled_for timestamptz,                          -- when this should send (if queued)
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists messages_deal_idx        on public.messages(deal_id, created_at desc);
create index if not exists messages_property_idx    on public.messages(property_id, created_at desc);
create index if not exists messages_to_idx          on public.messages(to_number, created_at desc);
create index if not exists messages_scheduled_idx   on public.messages(scheduled_for) where status = 'queued';
create index if not exists messages_inbound_unread_idx on public.messages(created_at desc) where direction = 'inbound';

-- ── Drip campaign instances ─────────────────────────────────
-- One row per (deal × campaign_kind) — represents "this lead is
-- in this drip series."
create table if not exists public.drip_campaigns (
  id            serial primary key,
  deal_id       integer not null references public.deals(id) on delete cascade,
  kind          text not null,                        -- 'reconsider' | 'comp' | 'three_month' | 'six_month'
  status        text not null default 'pending_approval', -- pending_approval|active|paused|completed|opted_out
  trigger_date  timestamptz not null,                 -- when this drip's day-0 begins
  started_at    timestamptz,
  paused_reason text default '',                      -- 'inbound_reply' | 'manual' | 'opted_out'
  created_at    timestamptz not null default now(),
  unique(deal_id, kind)                                -- one of each kind per deal
);
create index if not exists drip_deal_idx     on public.drip_campaigns(deal_id);
create index if not exists drip_status_idx   on public.drip_campaigns(status);

-- ── Per-number opt-out list (the iron-clad block list) ──────
-- Once a number replies STOP we never text it again, even
-- through a different deal/property.
create table if not exists public.sms_opt_outs (
  e164          text primary key,
  opted_out_at  timestamptz not null default now(),
  reason        text default 'stop_keyword'           -- 'stop_keyword' | 'manual' | 'complaint'
);

-- ── Twilio number used for SMS sending ──────────────────────
-- We're letting the admin pick which owned number is the "SMS sender"
-- (often different from the dialer caller-ID rotation). Lives in
-- user_prefs-style row but app-wide (single-tenant app).
create table if not exists public.app_config (
  key   text primary key,
  value text not null default ''
);
-- Pre-seed the keys we use
insert into public.app_config (key, value) values ('sms_from_number', '') on conflict (key) do nothing;
insert into public.app_config (key, value) values ('sms_business_name', '') on conflict (key) do nothing;

-- ── RLS ──────────────────────────────────────────────────────
alter table public.messages         enable row level security;
alter table public.drip_campaigns   enable row level security;
alter table public.sms_opt_outs     enable row level security;
alter table public.app_config       enable row level security;
-- service role bypasses RLS; no public policies needed.

-- ──────────────────────────────────────────────────────────────────
-- 4. v5 ADDITIONS
-- ──────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════
-- v5 additions: Deal Qualifier Form, Owner Last Name, VA Notes
-- Run AFTER the previous schemas. Safe to re-run.
-- ════════════════════════════════════════════════════════════════

-- ── Owner last name ─────────────────────────────────────────
-- New dedicated column on properties (and deals snapshot it on create)
alter table public.properties
  add column if not exists owner_last_name text default '';

alter table public.deals
  add column if not exists owner_last_name text default '';

create index if not exists properties_lastname_idx on public.properties(owner_last_name);

-- Helper: parse last name out of an "Owners" string like
--   "DAVID & AMY JENKINS" → "Jenkins"
--   "JANE DOE"             → "Doe"
--   "SMITH, JOHN"          → "Smith"
-- (Title-cased.)
create or replace function public.parse_last_name(owners text) returns text as $$
declare
  cleaned text;
  first_segment text;
  tokens text[];
  candidate text;
begin
  if owners is null or btrim(owners) = '' then return ''; end if;
  -- If "LAST, FIRST" comma format, take the first segment
  if position(',' in owners) > 0 then
    candidate := btrim(split_part(owners, ',', 1));
  else
    -- Otherwise take the first owner before "&" or "AND"
    cleaned := regexp_replace(owners, '\s+AND\s+', ' & ', 'gi');
    first_segment := btrim(split_part(cleaned, '&', 1));
    -- Last token is the last name
    tokens := regexp_split_to_array(first_segment, '\s+');
    if array_length(tokens, 1) >= 1 then
      candidate := tokens[array_length(tokens, 1)];
    else
      candidate := '';
    end if;
  end if;
  -- Title-case
  return initcap(lower(candidate));
end;
$$ language plpgsql immutable;

-- Backfill existing rows
update public.properties
  set owner_last_name = public.parse_last_name(owners)
  where (owner_last_name is null or owner_last_name = '') and owners is not null;

update public.deals
  set owner_last_name = public.parse_last_name(owners)
  where (owner_last_name is null or owner_last_name = '') and owners is not null;

-- ── VA Notes (free text) on leads ───────────────────────────
alter table public.leads
  add column if not exists va_notes text default '';

-- ── Deal Qualifier Form (standard wholesaler fields) ────────
alter table public.deals
  add column if not exists q_motivation       text default '',  -- why are they selling
  add column if not exists q_timeline         text default '',  -- when do they need to close
  add column if not exists q_condition        text default '',  -- 1-5 or free text
  add column if not exists q_asking_price     numeric(12,2),
  add column if not exists q_mortgage_balance numeric(12,2),
  add column if not exists q_monthly_payment  numeric(12,2),
  add column if not exists q_repairs_needed   text default '',  -- list/notes
  add column if not exists q_occupancy        text default '',  -- owner | tenant | vacant
  add column if not exists q_listed_with_agent boolean,
  add column if not exists q_decision_makers  text default '',  -- who else needs to sign off
  add column if not exists q_liens_or_back_taxes text default '',
  add column if not exists q_reason_to_choose_us text default '',  -- why us, not retail
  add column if not exists q_other_offers     text default '',     -- competing offers
  add column if not exists q_extra_notes      text default '',     -- catch-all
  add column if not exists q_completed_at     timestamptz,         -- when form was filled
  add column if not exists q_completed_by_profile integer references public.profiles(id) on delete set null;

-- ──────────────────────────────────────────────────────────────────
-- 5. v6 ADDITIONS (buyers + recordings + storage bucket)
-- ──────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════
-- v6 additions: Cash Buyers + VA Recordings (Phase 2)
-- Run AFTER all previous schemas. Safe to re-run.
-- ════════════════════════════════════════════════════════════════

-- ── Cash Buyers ─────────────────────────────────────────────
create table if not exists public.buyers (
  id           serial primary key,
  name         text not null,
  company      text default '',
  email        text default '',
  phone        text default '',           -- E.164 if available
  city         text default '',
  state        text default '',
  zip          text default '',

  -- Criteria (what they're looking for)
  buy_box      text default '',           -- free-text: "SFR 3/2, 1200-2000 sqft, ARV $200-400k"
  min_price    numeric(12,2),
  max_price    numeric(12,2),
  property_types text default '',         -- "SFR, Duplex, Townhome"
  rehab_level  text default '',           -- 'Light' | 'Medium' | 'Heavy' | 'Any'
  cash_only    boolean default true,
  funding_proof_on_file boolean default false,
  preferred_areas text default '',        -- zip codes / neighborhoods

  notes        text default '',
  active       boolean default true,
  rating       integer default 0,         -- 0-5 stars (your subjective grade)

  -- Stats (auto-maintained)
  deals_sent   integer default 0,
  deals_closed integer default 0,
  last_sent_at timestamptz,

  created_by_profile integer references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists buyers_active_idx on public.buyers(active);
create index if not exists buyers_rating_idx on public.buyers(rating desc);

-- Log of sent deals (so we don't double-send and can see history)
create table if not exists public.buyer_sends (
  id          bigserial primary key,
  buyer_id    integer not null references public.buyers(id) on delete cascade,
  deal_id     integer references public.deals(id) on delete set null,
  channel     text not null default 'email',  -- 'email' | 'sms' (future)
  subject     text default '',
  body        text default '',
  status      text not null default 'sent',   -- 'sent' | 'failed'
  error_msg   text default '',
  sent_by_profile integer references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists buyer_sends_buyer_idx on public.buyer_sends(buyer_id, created_at desc);
create index if not exists buyer_sends_deal_idx  on public.buyer_sends(deal_id, created_at desc);

-- Touch trigger for buyers
create or replace function public.buyers_touch() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists buyers_touch on public.buyers;
create trigger buyers_touch before update on public.buyers
  for each row execute procedure public.buyers_touch();

-- ── VA Recordings (audio) ───────────────────────────────────
-- Stores metadata. The actual audio file lives in Supabase
-- Storage under bucket "va-recordings" at path "{property_id}/{id}.{ext}"
create table if not exists public.va_recordings (
  id           bigserial primary key,
  property_id  text not null references public.properties(id) on delete cascade,
  storage_path text not null,                 -- e.g. "abc123/12345.m4a"
  filename     text not null default '',
  mime_type    text default '',
  size_bytes   bigint default 0,
  duration_sec integer,
  uploaded_by_profile integer references public.profiles(id) on delete set null,
  uploaded_at  timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '30 days'),
  deleted_at   timestamptz                    -- NULL = still active; set when cleanup runs
);
create index if not exists varec_property_idx on public.va_recordings(property_id, uploaded_at desc);
create index if not exists varec_expires_idx  on public.va_recordings(expires_at) where deleted_at is null;

-- ── RLS ─────────────────────────────────────────────────────
alter table public.buyers         enable row level security;
alter table public.buyer_sends    enable row level security;
alter table public.va_recordings  enable row level security;

-- ── Storage bucket setup (run separately in SQL Editor) ─────
-- Supabase Storage bucket creation must be done via dashboard or
-- this SQL. Bucket is PRIVATE by default — we serve files via
-- signed URLs from the backend, never public links.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('va-recordings', 'va-recordings', false, 26214400, array['audio/mpeg','audio/mp4','audio/m4a','audio/x-m4a','audio/wav','audio/webm','audio/ogg','audio/aac'])
  on conflict (id) do update set
    public = false,
    file_size_limit = 26214400,
    allowed_mime_types = array['audio/mpeg','audio/mp4','audio/m4a','audio/x-m4a','audio/wav','audio/webm','audio/ogg','audio/aac'];
-- Note: 26214400 bytes = 25 MB upload cap per file.

-- ──────────────────────────────────────────────────────────────────
-- 6. v6.2 PATCH
-- ──────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════
-- v6.2 patch: Quick qualifier callback time
-- Run AFTER v6 schema. Safe to re-run.
-- ════════════════════════════════════════════════════════════════

alter table public.deals
  add column if not exists q_callback_time text default '';

-- ════════════════════════════════════════════════════════════════
-- END
-- ════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════
-- v6.2 patch: Quick qualifier callback time
-- Run AFTER v6 schema. Safe to re-run.
-- ════════════════════════════════════════════════════════════════

alter table public.deals
  add column if not exists q_callback_time text default '';

-- =============================================================================
-- Per-vendor receipt layout templates.
--
-- A vendor's receipts all look the same. Paying a model to re-read that layout
-- on every email is both wasteful and non-deterministic — the same Walmart
-- receipt can parse differently twice. So the FIRST receipt from a vendor is
-- read by the model, the label that preceded the true total is captured
-- mechanically from that answer, and every later receipt from that vendor is
-- parsed deterministically against the learned label.
--
-- Same philosophy as merchant_map and vendor_signatures: the model teaches
-- once, code applies forever, and a correction is never re-asked.
-- =============================================================================

create table public.vendor_receipt_templates (
  id                 uuid primary key default gen_random_uuid(),
  vendor_key         text not null unique,   -- merchantKey(vendor), the join key
  vendor_name        text not null,
  sender_domain      text,

  -- The literal wording that precedes the amount actually charged, e.g.
  -- "Order total". Stored as text (not a compiled regex) so it is auditable
  -- and correctable by hand.
  total_label        text,
  last4_label        text,

  -- Provenance: which email taught this, and what the model said at the time.
  learned_from       text,
  learned_total      numeric(14,2),
  confidence         numeric,

  hits               int not null default 0,
  misses             int not null default 0,
  status             text not null default 'learned'
                     check (status in ('learned', 'failing', 'disabled')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index vendor_receipt_templates_status_idx
  on public.vendor_receipt_templates (status);

create trigger vendor_receipt_templates_updated_at
  before update on public.vendor_receipt_templates
  for each row execute function public.set_updated_at();

alter table public.vendor_receipt_templates enable row level security;
create policy owner_all on public.vendor_receipt_templates
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

grant select, insert, update, delete on public.vendor_receipt_templates
  to authenticated, service_role;

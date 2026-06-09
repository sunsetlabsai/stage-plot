-- Migration 008: chart calibration sidecar (realtime chart control, step 1)
-- Stores the navigation/timeline calibration graph for an owner-library PDF,
-- keyed by (chart_id, source_hash). source_hash is the sha256 of the PDF bytes
-- (computed client-side — the de-facto chart version; the library has none).
-- Perform applies a row only when the live PDF re-hashes to its source_hash AND
-- status = 'verified'. History is retained across hashes (revert + carry-forward).

create table chart_calibration (
  chart_id uuid not null references chart_library(id) on delete cascade,
  source_hash text not null,
  schema_version integer not null default 1,
  status text not null default 'draft' check (status in ('draft', 'verified')),
  graph jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (chart_id, source_hash)
);

alter table chart_calibration enable row level security;

create trigger set_chart_calibration_updated_at
  before update on chart_calibration
  for each row execute function extensions.moddatetime(updated_at);

create index chart_calibration_chart_idx on chart_calibration(chart_id);

-- RLS Policies — mirror chart_library ownership/collaborator access, joined
-- through chart_library. (Perform read for anonymous public shares goes through
-- the service-role admin client, like the public chart storage URLs; these
-- policies are defense-in-depth for any authenticated/anon direct access.)

create policy "Owner read calibration"
  on chart_calibration for select
  using (
    exists (
      select 1 from chart_library cl
      where cl.id = chart_calibration.chart_id
        and cl.owner_id = auth.uid()
    )
  );

create policy "Collaborator read calibration"
  on chart_calibration for select
  using (
    exists (
      select 1 from chart_library cl
      join shows s on s.owner_id = cl.owner_id
      join show_collaborators sc on sc.show_id = s.id
      where cl.id = chart_calibration.chart_id
        and sc.user_id = auth.uid()
    )
  );

create policy "Owner insert calibration"
  on chart_calibration for insert
  with check (
    exists (
      select 1 from chart_library cl
      where cl.id = chart_calibration.chart_id
        and cl.owner_id = auth.uid()
    )
  );

create policy "Owner update calibration"
  on chart_calibration for update
  using (
    exists (
      select 1 from chart_library cl
      where cl.id = chart_calibration.chart_id
        and cl.owner_id = auth.uid()
    )
  );

create policy "Owner delete calibration"
  on chart_calibration for delete
  using (
    exists (
      select 1 from chart_library cl
      where cl.id = chart_calibration.chart_id
        and cl.owner_id = auth.uid()
    )
  );

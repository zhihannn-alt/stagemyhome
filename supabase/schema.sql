create extension if not exists "pgcrypto";

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  external_id text unique,
  agent_number text not null,
  project_name text not null default 'WhatsApp Demo',
  status text not null default 'AWAITING_RESPONSES',
  payment_amount integer not null default 39,
  delivery_link text,
  generated_data jsonb not null default '{}'::jsonb,
  selected_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  room_index integer not null,
  room text not null,
  condition text not null default 'unknown',
  features jsonb not null default '[]'::jsonb,
  questions jsonb not null default '[]'::jsonb,
  suggested_prompt text not null default '',
  final_prompt text,
  source_path text,
  source_url text,
  source_mime text not null default 'image/jpeg',
  created_at timestamptz not null default now()
);

create table if not exists public.images (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete cascade,
  kind text not null check (kind in ('source', 'generated', 'selected')),
  variant integer,
  storage_path text not null,
  public_url text,
  selected boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists jobs_status_idx on public.jobs(status);
create index if not exists rooms_job_id_idx on public.rooms(job_id);
create index if not exists images_job_id_idx on public.images(job_id);
create index if not exists images_room_id_idx on public.images(room_id);

create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists jobs_touch_updated_at on public.jobs;
create trigger jobs_touch_updated_at
before update on public.jobs
for each row execute function public.touch_updated_at();

alter table public.jobs enable row level security;
alter table public.rooms enable row level security;
alter table public.images enable row level security;

-- Hackathon operator dashboard policy.
-- Keep writes server-side with SUPABASE_SERVICE_ROLE_KEY.
-- If you expose anon reads from a deployed frontend, tighten this before production.
drop policy if exists "public_read_jobs" on public.jobs;
create policy "public_read_jobs" on public.jobs for select using (true);

drop policy if exists "public_read_rooms" on public.rooms;
create policy "public_read_rooms" on public.rooms for select using (true);

drop policy if exists "public_read_images" on public.images;
create policy "public_read_images" on public.images for select using (true);

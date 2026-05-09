-- Run this once against your existing Supabase project.
-- Adds the columns needed for job persistence (generated images, selected images, room mime type).

alter table public.jobs
  add column if not exists generated_data jsonb not null default '{}'::jsonb,
  add column if not exists selected_data  jsonb not null default '{}'::jsonb;

alter table public.rooms
  add column if not exists source_mime text not null default 'image/jpeg';

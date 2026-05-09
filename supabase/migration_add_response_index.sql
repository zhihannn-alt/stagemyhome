-- Tracks how many per-room text responses have been received from the agent.
-- Each WhatsApp text reply is applied to rooms[response_index] in order.
alter table public.jobs
  add column if not exists response_index integer not null default 0;

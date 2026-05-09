-- Adds agent_notes column to store the WhatsApp text reply from the agent.
alter table public.jobs
  add column if not exists agent_notes text;

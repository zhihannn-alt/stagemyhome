-- Adds columns needed for WhatsApp delivery via reverse-polling pattern.
-- reply_jid: the full WhatsApp JID (e.g. 154606105526520@lid) to reply to.
-- pending_whatsapp_message: non-empty when the bridge should send a message on next poll.
alter table public.jobs
  add column if not exists reply_jid text,
  add column if not exists pending_whatsapp_message text;

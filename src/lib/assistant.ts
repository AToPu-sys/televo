// Reserved user id for the built-in Televo Assistant (see
// scripts/sql/009_ai_assistant.sql). Hidden from chats/contacts/new-group/
// forward since the original Anthropic org went on hold; the backend
// (supabase/functions/ai-assistant-reply) now runs on Groq and works again,
// so un-hiding it is a product decision, not a technical blocker.
export const ASSISTANT_USER_ID = "00000000-0000-0000-0000-000000000001";

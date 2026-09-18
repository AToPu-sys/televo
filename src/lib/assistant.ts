// Reserved user id for the built-in Televo Assistant (see
// scripts/sql/009_ai_assistant.sql). The assistant's Anthropic org is
// currently on hold, so every reply falls back to "unavailable" — hidden
// from chats/contacts/new-group/forward until that's resolved.
export const ASSISTANT_USER_ID = "00000000-0000-0000-0000-000000000001";

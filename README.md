# Telegram Clone — Expo Messenger

A Telegram-style messenger built with Expo (React Native) and a Supabase backend:
real accounts, real chats, and messages that sync live between devices.

Built on **Expo SDK 54** (React Native 0.81, React 19.1). Runs on iOS via Expo Go
or an EAS build — no Mac required for development.

## Features

- **Auth** — email + password (works out of the box) and phone/SMS OTP (needs an
  SMS provider, see below). Sessions persist across restarts.
- **Chats** — chat list with last-message previews, unread badges, search, and
  pull-to-refresh.
- **Conversations** — Telegram-style bubbles, optimistic send with pending /
  failed states, and live delivery over Supabase Realtime.
- **Photos** — send images from the library; uploads go to a private Storage
  bucket and render through signed URLs.
- **Group chats** — create a group, name it, pick members; the creator is admin.
- **Delete** — long-press your own message to delete it for everyone.
- **Typing indicators** — live over Realtime broadcast (no DB writes).
- **Contacts** — user directory; tap anyone to open (or create) a direct chat.
- **Settings** — profile card, dark mode toggle with a "match system" option,
  sign out.
- **Theming** — light and dark palettes throughout, persisted between launches.

## Setup

```bash
npm install
cp .env.example .env   # then fill in your Supabase values
npm start
```

Press `a` for Android, `i` for iOS, or `w` for web.

### Environment

| Variable | Meaning |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Your project URL |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The publishable (`sb_publishable_…`) key |

Both are safe in a client app — the publishable key is designed for public use
and access is enforced by Row Level Security. Never ship the `service_role` key.

## Backend

This app runs against an existing Supabase project and **reuses its messaging
schema** rather than creating its own tables:

| Table | Role |
| --- | --- |
| `profiles` | username, display name, avatar, bio |
| `conversations` | `kind` is `direct` or `group` |
| `conversation_participants` | membership, `is_admin`, `last_read_at` (unread counts) |
| `messages` | `kind` is `text`/`image`/`video`/…, body, media URL |

RLS is enabled on all of them, scoped to conversation participants, and
`messages` is in the `supabase_realtime` publication.

### Gotchas worth knowing

These cost real debugging time; they are not obvious from the code:

1. **Realtime needs its own auth.** The realtime socket does not inherit the
   REST client's session. Without `supabase.realtime.setAuth(token)`,
   `postgres_changes` subscriptions connect fine and then silently deliver
   nothing. Handled in `src/lib/supabase.ts`.

2. **Don't chain `.select()` onto the conversation insert.** That makes
   PostgREST run `INSERT ... RETURNING`, and the `SELECT` policy on
   `conversations` only admits existing participants — which the creator is not
   until the participant rows exist. The id is generated client-side instead
   (`src/lib/uuid.ts`).

3. **Participant insert order matters.** The policy permits adding *yourself*,
   or adding anyone *once you are already a participant*. Insert your own row
   first, then the other person — a single batched insert fails on the second row.

4. **Profiles are created by a database trigger.** `handle_new_user` reads
   `username` and `display_name` from the sign-up metadata (and de-duplicates
   usernames). Pass them via `options.data` on sign-up; do not insert a profile
   row yourself.

5. **`conversation_participants.user_id` references `auth.users`, not
   `profiles`**, so PostgREST cannot embed profiles in that query. Profiles are
   fetched in a follow-up query (see `useChats` / `useConversation`).

6. **Storage paths are dictated by policy, not preference.** Chat media must be
   uploaded to `chat-media/<conversation_id>/<file>` — the policy reads the
   first folder segment and checks you participate in that conversation.
   Avatars must be `avatars/<user_id>/<file>`. Any other path fails RLS.
   `chat-media` is private, so reading requires a signed URL.

### Phone / SMS sign-in

The phone flow is fully wired but inert until an SMS provider (Twilio, etc.) is
configured in the Supabase dashboard under Authentication → Providers → Phone.
Until then, use email sign-in. The UI says so rather than failing silently.

### Email confirmation

If the project has email confirmation enabled without SMTP configured, sign-up
returns *"Error sending confirmation email"*. Either configure SMTP or disable
confirmation in Authentication → Providers → Email.

## Verifying the backend

`scripts/verify-backend.mjs` exercises the whole data layer against the live
database — sign-up, profile trigger, chat creation under RLS, two-way
messaging, realtime delivery, read tracking, and that a non-participant is
correctly blocked. It creates test users and deletes them afterwards.

```bash
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-backend.mjs
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-features.mjs
```

`verify-features.mjs` covers the later additions: group creation and group
messaging, media upload (including that a non-participant is blocked from both
uploading and reading), image messages, delete permissions, and the typing
broadcast.

The admin key is only needed to create pre-confirmed test users; it is read from
the environment and never written to `.env` or committed.

## Project layout

```
app/                      Expo Router routes
  (auth)/                 welcome, email sign-in/up, phone OTP
  (tabs)/                 chats, contacts, settings
  chat/[id].tsx           conversation screen
src/
  components/             Avatar, Button, TextField, MessageBubble
  hooks/                  useAuth, useChats, useMessages, useConversation,
                          useContacts, useTheme
  lib/                    supabase client, uuid
  theme/                  light/dark palettes, spacing, radii
  types/database.ts       generated from the live schema
```

Regenerate types after a schema change:

```bash
npx supabase gen types typescript --project-id <ref> --schema public > src/types/database.ts
```

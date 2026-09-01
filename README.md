# Telegram Clone — Expo Messenger

A Telegram-style messenger built with Expo (React Native) and a Supabase backend:
real accounts, real chats, and messages that sync live between devices.

Built on **Expo SDK 54** (React Native 0.81, React 19.1).

**Voice/video calling requires a custom dev build — this app no longer runs in
Expo Go.** `react-native-webrtc` needs native code Expo Go doesn't ship. See
"Running the app" below.

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
- **Voice & video calls** — real WebRTC peer connections. Signaling (offer/
  answer/ICE) over Realtime broadcast; a free public TURN relay handles NAT
  traversal. Ringing/incoming-call UI works from anywhere in the app.
- **Multi-device sync** — the same account on two devices shares chats,
  messages, and read state live; marking a chat read on one device clears its
  badge on the other in real time.
- **Contacts** — user directory; tap anyone to open (or create) a direct chat.
- **Settings** — profile card, dark mode toggle with a "match system" option,
  sign out.
- **Theming** — light and dark palettes throughout, persisted between launches.

## Running the app

WebRTC needs native code, so this is a **custom dev build**, not Expo Go.

```bash
npm install
cp .env.example .env   # then fill in your Supabase values

# Android (needs Android Studio / an emulator or a plugged-in device)
npx expo run:android

# iOS — requires a Mac with Xcode; on Windows/Linux use an EAS cloud build
# instead (see below)
npx expo run:ios
```

The first run does a native `prebuild` (creates `android/` and `ios/`,
gitignored) and installs the app on the emulator/device/simulator. After that,
`npx expo start --dev-client` reconnects to the already-installed build for
fast JS-only reloads — no need to rebuild natively every time.

### Building iOS without a Mac (EAS)

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --profile development --platform ios
```

This builds in the cloud and gives you an install link (or a simulator build).
Install `expo-dev-client` on the resulting build, then run
`npx expo start --dev-client` and scan/open to connect. See
https://docs.expo.dev/develop/development-builds/create-a-build/ for the full
walkthrough — an Apple Developer account is needed for a physical device,
not for a simulator build.

### Voice/video calls need a real device (or two)

The iOS Simulator and most Android emulators don't expose a real camera/mic to
apps in a way WebRTC can use reliably. Test calling on physical devices — you
can call between an iOS build and an Android build, or two of the same
platform, since it's standard WebRTC either way.

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

7. **A table has to be added to the `supabase_realtime` publication before any
   `postgres_changes` subscription on it can fire — RLS being correct is not
   enough.** `conversation_participants` was missing from the publication,
   which silently broke live read-state sync across devices even though the
   client code and RLS policies were both correct; found by writing a script
   that actually exercised two clients on the same account rather than
   trusting that "messages sync, so this probably does too."

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
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-calls.mjs
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-sync.mjs
```

- `verify-features.mjs` — group creation and messaging, media upload
  (including that a non-participant is blocked from both uploading and
  reading), image messages, delete permissions, typing broadcast.
- `verify-calls.mjs` — the `calls` table's RLS (participants only, both ways),
  incoming-call realtime notification, and the signaling broadcast channel
  carrying an offer + ICE candidate. Doesn't exercise actual audio/video —
  that needs a physical device with a camera/mic.
- `verify-sync.mjs` — two clients signed into the same account, confirming a
  chat marked read on one is reflected live on the other, and that another
  user's channel isn't notified by it.

## Database changes made in this project

Applied directly against the shared project (via `supabase db query --linked`)
and kept as plain SQL under `scripts/sql/` rather than forced into the fitness
app's own migration history, which this project never pulled locally:

- `001_calls.sql` — the `calls` table (kind, status, timestamps), RLS scoped
  to conversation participants via the existing
  `is_conversation_participant()` function, added to `supabase_realtime`.
- `002_realtime_participants.sql` — adds `conversation_participants` to the
  `supabase_realtime` publication (see gotcha #7 above).

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

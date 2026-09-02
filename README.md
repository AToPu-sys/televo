# Televo — Expo Messenger

A Telegram-style messenger built with Expo (React Native) and a Supabase backend:
real accounts, real chats, messages that sync live between devices, real voice/
video calls, and opt-in end-to-end encrypted chats.

Built on **Expo SDK 54** (React Native 0.81, React 19.1). **Runs entirely in
Expo Go** — `npx expo start`, scan the QR code, done. No custom dev build,
no native modules.

## Features

- **Auth** — email + password. Sessions persist across restarts. (Phone sign-in
  was removed — see "What was tried and removed" below.)
- **Chats** — chat list with last-message previews, unread badges, search, and
  pull-to-refresh.
- **Conversations** — Telegram-style bubbles, optimistic send with pending /
  failed states, and live delivery over Supabase Realtime.
- **Secret Chats (E2E encryption)** — opt-in per direct conversation. Message
  bodies are encrypted on-device (X25519 + XSalsa20-Poly1305 via tweetnacl);
  the server only ever stores ciphertext. See "End-to-end encryption" below.
- **Photos** — send images from the library; uploads go to a private Storage
  bucket and render through signed URLs.
- **Group chats** — create a group, name it, pick members; the creator is admin.
- **Delete** — long-press your own message to delete it for everyone.
- **Typing indicators** — live over Realtime broadcast (no DB writes).
- **Voice & video calls** — real WebRTC peer connections (real audio/video,
  not a stub), running inside Expo Go. Signaling (offer/answer/ICE) over
  Realtime broadcast; a free public TURN relay handles NAT traversal.
- **Multi-device sync** — the same account on two devices shares chats,
  messages, and read state live.
- **Contacts** — user directory; tap anyone to open (or create) a direct chat.
- **Find friends** — opt-in phone-number matching against your device
  contacts, gated by a contacts permission prompt. Only finds people who've
  added a phone number in Settings — see "Contact discovery" below.
- **Settings** — profile card, phone number field, dark mode toggle, sign out.
- **Theming** — light and dark palettes throughout, persisted between launches.

## Running the app

```bash
npm install
cp .env.example .env   # then fill in your Supabase values
npx expo start
```

Scan the QR code with Expo Go (Android) or the Camera app (iOS, opens Expo
Go). That's it — no native build step, no `expo run:*`, no Xcode/Android
Studio required.

### How calling works in Expo Go without a native WebRTC module

`react-native-webrtc` requires native code Expo Go doesn't ship, so it isn't
used. Instead, `src/components/WebRtcBridge.tsx` renders a hidden
`react-native-webview` — which Expo Go *does* ship — hosting a tiny local HTML
page (`src/lib/webrtcBridgeHtml.ts`) that runs plain browser
`getUserMedia`/`RTCPeerConnection`. That's the WebView engine's own built-in
WebRTC (WKWebView on iOS, Chromium WebView on Android), not a React Native
native module, so no linking or dev build is needed.

React Native and the WebView talk over `postMessage`/`injectJavaScript`, JSON
only — `src/hooks/useCall.ts` owns the call state machine and forwards
offer/answer/ICE between the WebView and the Realtime signaling channel; it
never touches a WebRTC type directly.

Camera/mic permission prompting differs by platform inside a WebView:
`mediaCapturePermissionGrantType="grant"` handles iOS; on Android, Expo Go's
own WebView host auto-grants `getUserMedia` without any extra code.

### Voice/video calls need a real device (or two)

Simulators/emulators don't reliably expose a camera/mic. Test on physical
devices.

### Environment

| Variable | Meaning |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Your project URL |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The publishable (`sb_publishable_…`) key |

Both are safe in a client app — the publishable key is designed for public use
and access is enforced by Row Level Security. Never ship the `service_role` key.

## End-to-end encryption ("Secret Chats")

Opt-in per direct conversation, via the lock icon in a chat's header. Modeled
on Telegram's own Secret Chats:

1. Each device generates an X25519 keypair on first use
   (`src/lib/e2e.ts` → `getOrCreateDeviceKeyPair`). The private key is stored
   in `expo-secure-store` and **never leaves the device**; only the public key
   is published (`profiles.e2e_public_key`).
2. Starting a Secret Chat generates one random session key, then wraps a copy
   of it to each participant's public key (`nacl.box`) and stores those
   wrapped copies in `encrypted_session_keys` — RLS restricts each row to the
   one recipient it was wrapped for.
3. Every message body sent in that conversation is
   `nacl.secretbox(sessionKey, plaintext)` client-side before it's ever sent
   to Supabase. `scripts/verify-e2e.mjs` proves the stored row is genuinely
   ciphertext — including from a service-role client that bypasses RLS
   entirely and can still only read the encrypted bytes.

**Honest limitations, stated plainly:**
- This is a from-scratch implementation using audited primitives
  (tweetnacl.js, Cure53-reviewed), not a professionally audited *protocol*
  like Signal's. It has no forward secrecy / key ratcheting.
- Scope is direct chats only — group chats are not encrypted.
- Existing messages in a conversation stay plaintext when you turn encryption
  on; only messages sent afterward are encrypted.
- Multi-device: a new device generates its own keypair and won't automatically
  decrypt history from other devices' Secret Chats — there's no key backup/sync.
- Calls use WebRTC's own built-in transport encryption (DTLS-SRTP), which is
  separate from this and always on regardless of Secret Chat status.

## Contact discovery ("Find friends")

Settings → Find friends. Requests the device's contacts permission
(`expo-contacts`, Expo Go compatible), reads phone numbers from the address
book, and matches them against `profiles.phone` for every user who has added
one (Settings → Phone number, or during sign-up). No number is uploaded
anywhere as part of this — the matching query runs the other direction: it
pulls *registered* phone numbers down and compares them locally against the
device's contact list.

`profiles.phone` is optional and unique-if-present
(`scripts/sql/003_profile_phone.sql`); nothing about it is used for
authentication.

## What was tried and removed

**Phone number sign-in** (type a number, no SMS code) was built, then removed
at the user's request once real testing surfaced two blockers: this shared
Supabase project has the Phone auth provider disabled entirely (not just
missing an SMS provider — a dashboard toggle only the project owner can
flip), and a no-verification phone flow means anyone can sign in as any
number they type. `profiles.phone` and contact discovery were kept, since
those don't require phone-based *authentication* — see above.

## Backend

This app runs against an existing Supabase project and **reuses its messaging
schema** rather than creating its own tables:

| Table | Role |
| --- | --- |
| `profiles` | username, display name, avatar, bio, phone, e2e_public_key |
| `conversations` | `kind` is `direct` or `group`; `is_encrypted` for Secret Chats |
| `conversation_participants` | membership, `is_admin`, `last_read_at` (unread counts) |
| `messages` | `kind` is `text`/`image`/`video`/…, body (plaintext or E2E envelope), media URL |
| `calls` | call history/state — kind, status, timestamps |
| `encrypted_session_keys` | per-recipient wrapped Secret Chat session keys |

RLS is enabled on all of them, scoped to conversation participants (or, for
`encrypted_session_keys`, to the specific recipient a key was wrapped for).
`messages`, `calls`, `conversation_participants`, and `encrypted_session_keys`
are all in the `supabase_realtime` publication.

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
   row yourself. It doesn't know about `phone` or `e2e_public_key` (added
   later), so those are set via a follow-up `update` once a session exists.

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
   client code and RLS policies were both correct.

8. **A CommonJS package's named exports can break under Node's native ESM
   loader even when the bundler handles it fine.** `tweetnacl-util` is CJS;
   `import { decodeBase64 } from "tweetnacl-util"` type-checks and bundles
   correctly under Metro, but fails at runtime in a plain `node script.mjs`.
   Import the default and destructure instead — done in both `src/lib/e2e.ts`
   and the verify script, for consistency.

### Email confirmation / SMTP

Email confirmation is on. SMTP is configured via **Resend**
(`smtp.resend.com`, sender `onboarding@resend.dev`). That sandbox sender can
**only deliver to the Resend account owner's own email address** until a
domain is verified on resend.com/domains — every other address will fail
sign-up with "Error sending confirmation email" until that's done.

## Verifying the backend

Every script below exercises real behavior against the live database — no
mocks. Each creates its own test users and deletes them afterward.

```bash
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-backend.mjs
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-features.mjs
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-calls.mjs
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-sync.mjs
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-contact-discovery.mjs
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-e2e.mjs
```

- `verify-backend.mjs` — sign-up, profile trigger, chat creation under RLS,
  two-way messaging, realtime delivery, read tracking, RLS isolation.
- `verify-features.mjs` — group creation and messaging, media upload
  (including that a non-participant is blocked from both uploading and
  reading), image messages, delete permissions, typing broadcast.
- `verify-calls.mjs` — the `calls` table's RLS (participants only, both ways),
  incoming-call realtime notification, and the full offer/answer/ICE signal
  round trip over the per-call broadcast channel. Doesn't exercise the
  WebView's actual getUserMedia/media stream — that needs a physical device.
- `verify-sync.mjs` — two clients signed into the same account, confirming a
  chat marked read on one is reflected live on the other.
- `verify-contact-discovery.mjs` — the phone-uniqueness constraint, and that
  the discovery query finds a matching user while excluding the caller and
  users without a phone number.
- `verify-e2e.mjs` — key wrapping/unwrapping, message encrypt/decrypt, RLS on
  wrapped session keys, and — the actual point of E2E — that the raw stored
  row (read via a service-role client that bypasses RLS entirely) never
  contains the plaintext.

The admin key is only needed to create pre-confirmed test users; it is read
from the environment and never written to `.env` or committed.

## Database changes made in this project

Applied directly against the shared project (via `supabase db query --linked`)
and kept as plain SQL under `scripts/sql/` rather than forced into the fitness
app's own migration history, which this project never pulled locally:

- `001_calls.sql` — the `calls` table, RLS scoped to conversation participants
  via the existing `is_conversation_participant()` function, added to
  `supabase_realtime`.
- `002_realtime_participants.sql` — adds `conversation_participants` to the
  `supabase_realtime` publication (see gotcha #7 above).
- `003_profile_phone.sql` — optional, unique-if-present `phone` column on
  `profiles`, for contact discovery only (not auth).
- `004_e2e_encryption.sql` — `profiles.e2e_public_key`,
  `conversations.is_encrypted`, and the `encrypted_session_keys` table.

## Project layout

```
app/                      Expo Router routes
  (auth)/                 welcome, email sign-in/up
  (tabs)/                 chats, contacts, settings
  chat/[id].tsx           conversation screen (messages, encryption, calling)
  new-group.tsx           group chat creation
  find-friends.tsx        contact-discovery screen
  _layout.tsx             providers + the global call overlay
src/
  components/             Avatar, Button, TextField, MessageBubble,
                          CallButton, CallOverlay, WebRtcBridge
  hooks/                  useAuth, useChats, useMessages, useConversation,
                          useContacts, useTheme, useTyping, useE2ee,
                          useCall, useCallManager, useIncomingCalls,
                          useContactDiscovery
  lib/                    supabase client, uuid, media (Storage uploads),
                          webrtc (ICE/TURN config), webrtcBridgeHtml, e2e
  theme/                  light/dark palettes, spacing, radii
  types/database.ts       generated from the live schema
scripts/
  sql/                    raw SQL applied directly to the shared project
  verify-*.mjs            live end-to-end checks against the real database
```

Regenerate types after a schema change:

```bash
npx supabase gen types typescript --project-id <ref> --schema public > src/types/database.ts
```

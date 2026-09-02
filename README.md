# Televo — Expo Messenger

A messenger built with Expo (React Native) and a Supabase backend, targeting
rough feature parity with Telegram circa 2016: real accounts, real chats
synced live across devices, voice/video calls, opt-in end-to-end encrypted
"Secret Chats" with self-destruct timers, message edit/reply/forward,
document sending, privacy controls (last seen, read receipts), blocking, an
app passcode lock, and Two-Step Verification (TOTP).

Built on **Expo SDK 54** (React Native 0.81, React 19.1). **Runs entirely in
Expo Go** — `npx expo start`, scan the QR code, done. No custom dev build,
no native modules.

## Features

- **Auth** — email + password. Sessions persist across restarts. (Phone
  sign-in was tried and removed — see "What was tried and removed.")
- **Chats** — chat list with last-message previews, unread badges, search,
  pull-to-refresh.
- **Conversations** — Telegram-style bubbles, optimistic send, reply-with-quote,
  edit, forward (with "Forwarded from" attribution), and live delivery over
  Supabase Realtime.
- **Secret Chats (E2E encryption)** — opt-in per direct conversation, with a
  self-destruct timer. See "End-to-end encryption" below.
- **Photos & documents** — images from the library, or any file type, sent to
  a private Storage bucket and rendered/downloaded through signed URLs.
- **Group chats** — create a group, name it, pick members; the creator is admin.
- **Delete** — long-press your own message to delete it for everyone.
- **Typing indicators** — live over Realtime broadcast (no DB writes).
- **Voice & video calls** — real WebRTC peer connections (real audio/video,
  not a stub), running inside Expo Go. Signaling over Realtime broadcast; a
  free public TURN relay handles NAT traversal. A **Calls tab** shows history
  (incoming/outgoing/missed/declined) with tap-to-call-back.
- **Privacy** — toggle whether others see your Last Seen (reciprocal — turning
  it off also hides theirs from you, matching Telegram) and whether you send
  read receipts. **Blocking** is enforced server-side (RLS on the `messages`
  INSERT policy) — a blocked relationship stops messages in both directions,
  not just hidden client-side.
- **AI Assistant** — a pinned "Televo Assistant" contact every user gets
  automatically. Messages to it are answered by Claude, generated
  server-side by a Supabase Edge Function — the app never holds an API key.
  See "AI Assistant" below.
- **App security** — a local 4-digit **Passcode Lock** (optional biometric
  unlock) that gates the whole app after backgrounding, and **Two-Step
  Verification** via TOTP (an authenticator app code required at login, on
  top of the password).
- **Multi-device sync** — the same account on two devices shares chats,
  messages, and read state live.
- **Contacts & Find friends** — a user directory, plus opt-in phone-number
  matching against your device contacts.
- **Settings** — profile card, phone number, dark mode, Privacy & Security.
- **Theming** — light and dark palettes throughout, persisted between launches.
- **Push notifications** — full server-side pipeline (see "Push
  notifications" below). Works today on iOS in Expo Go; Android needs one
  custom dev build, an Expo platform restriction, not a gap in this code.

## Running the app

```bash
npm install
cp .env.example .env   # then fill in your Supabase values
npx expo start
```

Scan the QR code with Expo Go (Android) or the Camera app (iOS, opens Expo
Go). No native build step, no `expo run:*`, no Xcode/Android Studio required.

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
never touches a WebRTC type directly. Voice/video calls need a real device
(or two) — simulators/emulators don't reliably expose a camera/mic.

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
4. **Self-destruct timer** (chat header → overflow menu, encrypted chats
   only): sets `conversations.self_destruct_seconds`; every message sent
   afterward gets an `expires_at`. A client-side sweep (1s interval, while the
   chat screen is open) hides and deletes expired messages. Deletion is RLS-
   gated to rows that are *actually* past `expires_at` — any participant can
   clean those up, not just the sender, so a message doesn't linger forever
   in the recipient's copy either (`scripts/sql/007_self_destruct_cleanup.sql`).

**Honest limitations, stated plainly:**
- From-scratch implementation using audited primitives (tweetnacl.js,
  Cure53-reviewed), not a professionally audited *protocol* like Signal's. No
  forward secrecy / key ratcheting.
- Scope is direct chats only — group chats are not encrypted.
- Existing messages stay plaintext when encryption is turned on; only
  messages sent afterward are encrypted.
- No key backup/sync — a new device generates its own keypair and can't
  decrypt another device's Secret Chat history.
- Self-destruct is enforced by a live client sweep, not a server-side cron —
  a message with an elapsed timer is deleted the next time either
  participant's chat screen is open, not to-the-second everywhere.
- Calls use WebRTC's own transport encryption (DTLS-SRTP), separate from this
  and always on regardless of Secret Chat status.

## Two-Step Verification & Passcode Lock

- **Two-Step Verification** (Settings → Privacy & Security) uses Supabase's
  native TOTP MFA — scan a QR code into an authenticator app, then every
  future password sign-in requires a 6-digit code before the session reaches
  AAL2 (`src/hooks/useAuth.tsx` → `needsMfaChallenge` / `verifyMfaCode`).
  Real Telegram's own "Two-Step Verification" is a bespoke password field
  rather than TOTP; this uses the actual audited standard instead, since
  Supabase has it built in.
- **Passcode Lock** (`src/lib/passcode.ts`, `src/hooks/useAppLock.tsx`) is a
  local-only 4-digit PIN (SHA-256 hashed in `expo-secure-store`, never sent
  anywhere) that re-locks the app after ~30s backgrounded, with optional
  biometric unlock via `expo-local-authentication`.

## Push notifications

Uses Expo's push service (`expo-notifications`, `getExpoPushTokenAsync`) —
not a raw FCM/APNs integration, so no Firebase/Apple developer console setup
is needed for it to work.

1. On sign-in, the device requests notification permission and registers an
   Expo push token in `push_tokens` (`src/hooks/usePushNotifications.ts`).
   RLS scopes each row to its owner — nobody can read or register a token for
   someone else (`scripts/sql/011_push_tokens.sql`).
2. `notify_new_message_push()` (a trigger on `messages` INSERT, same async
   `pg_net` webhook pattern as the AI assistant) fires the
   `send-push-notification` Edge Function whenever a message lands.
3. The function resolves every other participant's push tokens and POSTs to
   Expo's push API (`https://exp.host/--/api/v2/push/send`) — no API key
   required by default. **Secret Chat message bodies are never sent as
   notification text** — an encrypted conversation's push always reads
   "sent a message" instead, since the notification pipeline runs
   server-side and must not become a way to exfiltrate what E2E encryption
   is specifically protecting.

**Platform limitation, not a bug in this code:** remote push notifications
are unavailable in Expo Go on Android from SDK 53 onward — Expo's own
restriction. This means:
- **iOS in Expo Go**: works as-is, no extra steps.
- **Android**: needs one custom dev build (`eas build --profile development`
  or `npx expo run:android`) instead of Expo Go. Everything else in the app
  keeps working the same either way — this is the one feature gated by that
  choice.

`scripts/verify-push-notifications.mjs` verifies token RLS and that the
webhook successfully reaches Expo's push API (confirmed via
`net._http_response`, since actual delivery needs a real device's push token).

## AI Assistant

Every user automatically gets a pinned direct conversation with "Televo
Assistant" (a reserved system account, fixed id
`00000000-0000-0000-0000-000000000001`), created by a database trigger
(`on_profile_created_add_assistant`) the moment their profile row exists.

Replies are generated **server-side**, never on the client:

1. `notify_ai_assistant()` (a trigger on `messages` INSERT) fires an async
   `pg_net` HTTP POST to the `ai-assistant-reply` Edge Function whenever a
   non-assistant message lands in a conversation the assistant participates in.
2. The Edge Function re-validates the conversation, pulls recent history,
   calls the Claude API (`claude-haiku-4-5`) with the Anthropic key stored as
   an Edge Function **secret** (`supabase secrets set`, never in `.env`, the
   app, or git), and inserts the reply using the service-role key.
3. The webhook call itself is gated by a shared-secret header
   (`x-webhook-secret`) since the function is deployed with
   `--no-verify-jwt` (the caller is Postgres, not a client with a Supabase
   session).

Call/block/self-destruct/E2E-encryption UI is hidden for this conversation in
the chat screen — none of those apply to a bot contact.

**Live-verified**: a new user gets the conversation + welcome message
automatically, and a real message triggers a real Claude-generated reply,
confirmed via `scripts/verify-ai-assistant.mjs` end to end through the full
webhook → Edge Function → Claude API → insert pipeline.

## Contact discovery ("Find friends")

Settings → Find friends. Requests the device's contacts permission
(`expo-contacts`, Expo Go compatible), reads phone numbers from the address
book, and matches them against `profiles.phone` for every user who has added
one. Nothing is uploaded from the device — the match pulls registered numbers
down and compares them locally against the contact list.

## What was tried and removed

**Phone number sign-in** (type a number, no SMS code) was built, then removed
once live testing showed the shared Supabase project has the Phone auth
provider disabled entirely (a dashboard-only toggle), and that a
no-verification phone flow lets anyone sign in as any number they type.
`profiles.phone` was kept, since contact discovery doesn't require phone
*authentication*.

## Backend

This app runs against an existing Supabase project and **reuses its messaging
schema** rather than creating its own tables:

| Table | Role |
| --- | --- |
| `profiles` | username, display name, avatar, bio, phone, e2e_public_key, last_seen_at, show_last_seen, show_read_receipts |
| `conversations` | `kind` (direct/group), `is_encrypted`, `self_destruct_seconds` |
| `conversation_participants` | membership, `is_admin`, `last_read_at` (unread counts) |
| `messages` | kind (incl. `document`), body, media_url, reply_to_id, edited_at, forwarded_from_*, expires_at, document_name/size |
| `calls` | call history/state — kind, status, timestamps |
| `encrypted_session_keys` | per-recipient wrapped Secret Chat session keys |
| `blocked_users` | blocker_id/blocked_id pairs, enforced in the messages RLS policy |

RLS is enabled on every one of these. `messages`, `calls`,
`conversation_participants`, and `encrypted_session_keys` are all in the
`supabase_realtime` publication.

### Gotchas worth knowing

These cost real debugging time; they are not obvious from the code.

1. **Realtime needs its own auth.** The realtime socket does not inherit the
   REST client's session. Without `supabase.realtime.setAuth(token)`,
   `postgres_changes` subscriptions connect fine and then silently deliver
   nothing. Handled in `src/lib/supabase.ts`.

2. **Don't chain `.select()` onto the conversation insert.** `INSERT ...
   RETURNING` requires the SELECT policy to already admit you, which for
   `conversations` means being a participant — not true yet at creation
   time. The id is generated client-side instead (`src/lib/uuid.ts`).

3. **Participant insert order matters.** The policy permits adding *yourself*,
   or adding anyone *once you are already a participant*. Insert your own row
   first, then the other person.

4. **Profiles are created by a database trigger.** `handle_new_user` reads
   `username`/`display_name` from sign-up metadata. It predates `phone` and
   `e2e_public_key`, so those are set via a follow-up `update` once a session
   exists — never insert a profile row directly.

5. **`conversation_participants.user_id` references `auth.users`, not
   `profiles`** — PostgREST can't embed profiles in that query; fetch them in
   a follow-up query (see `useChats` / `useConversation`).

6. **Storage paths are dictated by policy, not preference.** Chat media
   (images, documents) must be uploaded under
   `chat-media/<conversation_id>/...` — the policy reads the first folder
   segment. Avatars must be `avatars/<user_id>/<file>`.

7. **Realtime publication membership is separate from RLS correctness.**
   `conversation_participants` was missing from `supabase_realtime`, which
   silently broke live read-state sync even with correct RLS and correct
   client code.

8. **A CommonJS package's named exports can break under Node's native ESM
   loader even when the bundler handles it fine.** `tweetnacl-util` is CJS;
   `import { decodeBase64 } from "tweetnacl-util"` type-checks and bundles
   under Metro, but fails at runtime in a plain `node script.mjs`. Import the
   default and destructure instead.

9. **A check constraint can silently omit a new enum value.** Adding
   `'document'` to `message_kind` didn't update the pre-existing
   `message_has_content` CHECK constraint, so every document message insert
   failed — caught by `verify-telegram-features.mjs`, fixed in
   `008_fix_document_constraint.sql`. Adding an enum value is not enough on
   its own if a CHECK constraint enumerates kinds explicitly.

10. **A `SECURITY DEFINER` function is a public RPC endpoint by default.**
    `is_blocked_between()` (used inside the messages INSERT policy) was
    callable directly via `/rest/v1/rpc/is_blocked_between` by `anon` until
    its default `PUBLIC` execute grant was explicitly revoked
    (`006_block_enforcement.sql`). Caught by Supabase's own advisor
    (`supabase db advisors`), not by testing the app's own flows — run
    advisors after any `SECURITY DEFINER` function.

11. **Blocking is bidirectional, matching real Telegram** — once either party
    blocks, *neither* can message the other until unblocked. This was a
    deliberate design decision (confirmed with the user), not an accident of
    the RLS logic.

12. **Expo Router's typed-routes generation can silently miss a route file**
    even though it bundles and navigates correctly at runtime (observed with
    `forward-message.tsx`, cause not identified — not a stale cache, not file
    encoding, not naming pattern). Worked around with a narrow `as never`
    cast on that one `router.push` call rather than fighting the generator.

### Email confirmation / SMTP

Email confirmation is on. SMTP is Gmail (`smtp.gmail.com`, an App Password —
not the account password), sender `ryvvoofficial@gmail.com`. Supabase's own
per-project **email rate limit** (Authentication → Rate Limits → "Rate limit
for sending emails") is separate from whatever the SMTP provider allows and
defaults very low (2/hour was the blocker here) — raise it if sign-ups start
failing with "email rate limit exceeded" even though SMTP itself is fine.
`Site URL` / redirect allow-list must point at the app's own scheme
(`televo://`, plus `exp://**` for Expo Go testing) — the default
`http://127.0.0.1:3000` sends confirmation links to a browser localhost that
doesn't exist for a mobile app.

## Verifying the backend

Every script below exercises real behavior against the live database — no
mocks. Each creates its own test users and deletes them afterward.

```bash
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-backend.mjs
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-features.mjs
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-calls.mjs
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-contact-discovery.mjs
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-e2e.mjs
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/verify-telegram-features.mjs
```

- `verify-backend.mjs` — sign-up, profile trigger, chat creation under RLS,
  two-way messaging, realtime delivery, read tracking, RLS isolation.
- `verify-features.mjs` — group creation/messaging, media upload (a
  non-participant is blocked from both uploading and reading), delete
  permissions, typing broadcast.
- `verify-calls.mjs` — `calls` RLS, incoming-call realtime notification, the
  offer/answer/ICE round trip. Doesn't exercise the WebView's actual media
  stream — that needs a physical device.
- `verify-contact-discovery.mjs` — phone uniqueness, discovery query
  correctness.
- `verify-e2e.mjs` — key wrap/unwrap, encrypt/decrypt, RLS on wrapped keys,
  and that the raw stored row (read via service-role, bypassing RLS) never
  contains plaintext.
- `verify-telegram-features.mjs` — reply/edit/forward, document messages,
  **blocking enforced server-side in both directions**, that
  `is_blocked_between` isn't callable by `anon`, self-destruct cleanup
  permissions (any participant can delete an *expired* message; nobody can
  delete one that hasn't expired yet unless they sent it), privacy toggles.

The admin key is only needed to create pre-confirmed test users; it is read
from the environment and never written to `.env` or committed.

## Database changes made in this project

Applied directly against the shared project (via `supabase db query --linked`)
and kept as plain SQL under `scripts/sql/` — this project never pulled the
fitness app's own local migration history, so these are additive files, not
tracked migrations:

- `001_calls.sql` — the `calls` table.
- `002_realtime_participants.sql` — adds `conversation_participants` to
  `supabase_realtime` (gotcha #7).
- `003_profile_phone.sql` — optional, unique-if-present `profiles.phone`.
- `004_e2e_encryption.sql` — `profiles.e2e_public_key`,
  `conversations.is_encrypted`, `encrypted_session_keys`.
- `005_privacy_and_features.sql` — message edit/reply/forward columns,
  self-destruct columns, the `document` message kind, last-seen/read-receipt
  privacy columns, the `blocked_users` table.
- `006_block_enforcement.sql` — `is_blocked_between()` and the updated
  messages INSERT policy that actually enforces blocking (gotchas #10, #11).
- `007_self_destruct_cleanup.sql` — lets any participant delete an expired
  message, not just the sender.
- `008_fix_document_constraint.sql` — fixes `message_has_content` to account
  for the `document` kind (gotcha #9).

## Project layout

```
app/                      Expo Router routes
  (auth)/                 welcome, email sign-in/up
  (tabs)/                 chats, calls, contacts, settings
  chat/[id].tsx           conversation screen (messages, encryption, calling)
  new-group.tsx           group chat creation
  find-friends.tsx        contact-discovery screen
  forward-message.tsx     forward-to picker
  privacy-security.tsx    passcode / 2FA / last-seen / blocked-users hub
  set-passcode.tsx        passcode entry (enter + confirm)
  two-factor.tsx          TOTP MFA enroll/verify/remove
  privacy-last-seen.tsx   last-seen & read-receipt toggles
  blocked-users.tsx       manage blocked users
  mfa-challenge.tsx       TOTP challenge gate after password sign-in
  _layout.tsx             providers + passcode/MFA/call overlays
src/
  components/             Avatar, Button, TextField, MessageBubble,
                          CallButton, CallOverlay, WebRtcBridge, PasscodeScreen
  hooks/                  useAuth, useChats, useMessages, useConversation,
                          useContacts, useTheme, useTyping, useE2ee,
                          useCall, useCallManager, useIncomingCalls,
                          useContactDiscovery, useAppLock, useBlockedUsers,
                          useCallLog, useParticipantNames
  lib/                    supabase client, uuid, media (Storage uploads incl.
                          documents), webrtc (ICE/TURN config),
                          webrtcBridgeHtml, e2e, passcode
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

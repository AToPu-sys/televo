# Televo — App Store submission

Everything below marked **YOU** requires an account, a browser, or a device
and cannot be done from the codebase.

---

## 1. Blockers — the app WILL be rejected without these

### 1.1 Host the two legal documents  **YOU**

`src/lib/legal.ts` points at:

- `https://televo.app/terms`   ← `TERMS_OF_SERVICE.md`
- `https://televo.app/privacy` ← `PRIVACY_POLICY.md`

**Those URLs do not exist yet.** App Review opens them; a dead link is a
rejection. Publish both (GitHub Pages, Vercel, Notion — anything public and
stable), then update the two constants if the final URLs differ.

### 1.2 Demo account  **YOU**

Guideline 2.1: sign-in is required, so Review needs working credentials.
Create a real account, seed it with a few conversations so the app isn't
empty, and put the email + password in **App Review Information → Sign-In
Required**.

Do **not** enable 2FA on that account — the reviewer cannot pass a TOTP
prompt.

### 1.3 Privacy Nutrition Labels  **YOU**

In App Store Connect → App Privacy, declare what the app actually collects:

| Data | Collected | Linked to user | Purpose |
|---|---|---|---|
| Email address | Yes | Yes | Account |
| Phone number | Yes | Yes | Account, contact discovery |
| Name / username / photo | Yes | Yes | App functionality |
| Contacts | Yes | No | Contact discovery (hashed before upload) |
| Photos / videos | Yes | Yes | Message content |
| User content (messages) | Yes | Yes | App functionality |
| Device ID (push token) | Yes | Yes | Notifications |

Nothing is used for tracking or advertising — answer **No** to tracking.

### 1.4 Age rating  **YOU**

Unrestricted web access: **No**. User-generated content with moderation:
**Yes**. This lands at 12+ or 17+ depending on the questionnaire; do not
claim 4+ for a messenger.

---

## 2. Done in the codebase

- **Account deletion** — Settings → Delete account (Guideline 5.1.1(v)).
- **Content reporting** — long-press a message → Report; the report stores a
  copy of the content, since an encrypted message may be deleted before
  review.
- **Blocking** — chat menu → Block, enforced server-side and bidirectionally.
- **Terms + Privacy** — agreed to at sign-up, linked from Settings.
- **Encryption declaration** — `ITSAppUsesNonExemptEncryption: true` with the
  Category 5 Part 2 note 4 exemption. This app ships its own E2E crypto, so
  declaring "no encryption" would have been a false statement.
- **Permission strings** — microphone, camera, photo library (read + add),
  contacts, Face ID. iOS terminates the app on first use of a permission with
  no declared purpose.
- **Bundle id** — `com.televo.app` (was `com.tgclone.app`, which read as
  "Telegram clone" and invited a trademark rejection).

---

## 3. Known gaps to decide on before submitting

### 3.1 The AI assistant does not generate replies

The Anthropic organisation behind `ANTHROPIC_API_KEY` is **disabled**
(`organization_on_hold`). Verified directly against the API.

The assistant chat now answers "The assistant is unavailable right now…"
instead of staying silent, and the welcome message no longer promises
Claude-powered answers — so it degrades honestly rather than looking broken.

**Your options:**
1. Resolve the hold at <https://console.anthropic.com/appeal>, or
2. Remove the assistant before submitting.

Shipping it in the current degraded state is defensible but weak: a reviewer
may still read "assistant that can't assist" as an incomplete feature.

### 3.2 Push notifications need a real build

Expo Go cannot receive push notifications on Android since SDK 53, and on iOS
they require a provisioned build. This only affects Expo Go testing — a
TestFlight/App Store build handles push normally.

### 3.3 Calls are not verified on real hardware

The signaling layer passes its automated suite (8/8), but a two-device audio
and video call has never been confirmed end to end. **Test this before
submitting** — a reviewer who taps Call and gets nothing is a Guideline 2.1
rejection.

### 3.4 No forward secrecy

Encryption uses long-term X25519 keys with no ratcheting, so a compromised
private key decrypts that user's entire history. This is weaker than Signal
or Telegram Secret Chats. It does not block review, and no in-app copy claims
otherwise — but do not market it as equivalent to Signal.

---

## 4. Build and submit

```bash
npx expo install --check      # confirm SDK-matched versions
npx tsc --noEmit              # must be clean
eas build --platform ios --profile production
eas submit --platform ios
```

`.npmrc` sets `legacy-peer-deps` — Expo pins react 19.1.0 while a transitive
react-dom wants 19.2.8, so a plain `npm install` fails without it.

---

## 5. Rotate these credentials  **YOU**

These were pasted into a chat transcript and must be treated as compromised:

- Supabase `service_role` key
- Supabase personal access token
- Anthropic API key
- Resend API key
- Gmail app password

The service-role key in particular bypasses every RLS policy in the project.

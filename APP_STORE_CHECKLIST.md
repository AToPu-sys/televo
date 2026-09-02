# App Store submission checklist — Televo

Status of each requirement. Items marked **YOU** need action outside the
codebase and cannot be done from here.

## Done in the app

- [x] **In-app account deletion** (Guideline 5.1.1(v)) — Settings → Delete
      account, double-confirmed, cascades to all data. Apple rejects apps
      that support sign-up without this.
- [x] **Report offensive content** (Guideline 1.2) — long-press any message
      from another person → Report, with categories. Stored in
      `content_reports`.
- [x] **Block abusive users** (Guideline 1.2) — chat menu → Block, enforced
      server-side in both directions.
- [x] **Permission purpose strings** — camera, microphone, photos, contacts,
      each explaining why in plain language (`app.json` → `infoPlist` and the
      plugin config).
- [x] **Encryption declaration** — `ITSAppUsesNonExemptEncryption: false`.
      The app uses only standard algorithms (TLS, NaCl), which is exempt.
      Without this key every build stops to ask.
- [x] **Privacy policy text** — `PRIVACY_POLICY.md`.

## YOU must do before submitting

- [ ] **Host the privacy policy at a public URL.** Apple requires a working
      link, and it must stay reachable. GitHub Pages or any static host is
      fine. Then paste the URL into App Store Connect → App Privacy.
- [ ] **Create a demo account** (Guideline 2.1) and put the credentials in
      App Store Connect → App Review Information. Reviewers cannot sign up
      with a real email, so without this they can't get past the login screen
      and will reject the app. Seed it with a couple of conversations so the
      app doesn't look empty.
- [ ] **Fill in App Privacy "nutrition labels"** in App Store Connect. Based
      on what this app actually collects, declare:
      - Contact Info → Email Address (linked to identity, app functionality)
      - Contact Info → Phone Number (linked, app functionality) — only if the
        user provides one
      - User Content → Photos, Other User Content (linked, app functionality)
      - Contacts (not linked — hashes only, never stored)
      - Identifiers → User ID (linked, app functionality)
      - Usage Data → Product Interaction (linked, app functionality)
      Do **not** declare tracking; the app does no advertising or tracking.
- [ ] **Screenshots** for each required device size, and app description /
      keywords / support URL.
- [ ] **French encryption declaration** — App Store Connect asks a separate
      question about French law for apps with encryption. Answer it; standard
      crypto qualifies for the exemption.
- [ ] **Age rating questionnaire** — an app with unmoderated user-to-user
      communication usually lands at 17+. Answer honestly; understating it is
      a common rejection cause.

## Known gaps a reviewer may notice

Be aware of these before submitting — better to fix or expect questions:

- **Push notifications don't work on Android in Expo Go.** They need a
  custom dev build. iOS is fine. If you submit an Android build this must be
  a real build anyway, so this resolves itself.
- **Voice/video calls are not verified on real devices yet.** Test a call
  between two physical phones before submitting — a reviewer will try it.
- **Two-Step Verification requires TOTP to be enabled** in the Supabase
  dashboard (Authentication → Auth Settings → MFA). Until then the setup
  screen returns an error, which a reviewer would hit.
- **Group calls ring every member** and only the first to answer connects;
  the rest keep ringing. Consider hiding call buttons in group chats until
  this is properly handled.
- **No message search, voice messages, stickers, or channels.** Not required,
  but a reviewer comparing against the description will notice if the
  description promises them — keep the App Store description to what exists.

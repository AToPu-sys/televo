/**
 * Public URLs for the legal documents. App Review requires both to be
 * reachable from inside the app (Guideline 1.2 for user-generated content,
 * and 5.1.1 for the privacy policy).
 *
 * Served from the televo-site repo (https://github.com/AToPu-sys/televo-site)
 * via GitHub Pages behind Cloudflare, whose privacy.html/terms.html are the
 * published copies of PRIVACY_POLICY.md and TERMS_OF_SERVICE.md in this
 * repo's root. Update both places together, or the app links to text that no
 * longer matches what the app actually does — the exact mismatch App Review
 * checks for.
 *
 * Extensionless on purpose: GitHub Pages resolves /privacy to privacy.html
 * itself, so these stay stable if the site ever moves to a host that renders
 * the documents some other way.
 */
export const TERMS_URL = "https://gettelevo.space/terms";
export const PRIVACY_URL = "https://gettelevo.space/privacy";
/** The FAQ page — Settings' Contact Support row sends users here first,
 * not straight to a mail composer. Most support questions (lost sign-in
 * code, a reinstalled device losing Secret Chat history, a call with no
 * audio) already have an answer there, so this saves a round trip through
 * email for the common case while still linking to it at the bottom. */
export const SUPPORT_URL = "https://gettelevo.space/support";
export const SUPPORT_EMAIL = "ssirojov@gmail.com";

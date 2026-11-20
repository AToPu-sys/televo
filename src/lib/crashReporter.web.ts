import Constants from "expo-constants";

import { supabase } from "./supabase";

// Web build of crashReporter.ts: no file system, so reports are sent right
// away (best effort) instead of being written to disk first. The same
// redaction applies — decrypted chat text and tokens must never leave the
// device through an error report.

const LONG_QUOTED_LITERAL = /(["'`])((?:(?!\1).){41,})\1/g;
const TOKEN_LIKE = /\b[A-Za-z0-9_-]{60,}\b/g;
function redact(text: string): string {
  return text.replace(LONG_QUOTED_LITERAL, (_m, q) => `${q}[redacted]${q}`).replace(TOKEN_LIKE, "[redacted]");
}

let currentScreen: string | null = null;
let installed = false;
let sentThisSession = 0;

export function setCrashContextScreen(screen: string | null) {
  currentScreen = screen;
}

export function recordError(error: unknown, isFatal: boolean) {
  try {
    if (sentThisSession >= 20) return;
    sentThisSession += 1;
    const err = error instanceof Error ? error : new Error(String(error));
    void (async () => {
      const { data } = await supabase.auth.getSession();
      await supabase.from("client_crash_reports").insert({
        user_id: data.session?.user.id ?? null,
        occurred_at: new Date().toISOString(),
        is_fatal: isFatal,
        platform: "web",
        app_version: Constants.expoConfig?.version ?? null,
        build_number: "web",
        message: redact(`${err.name}: ${err.message}`).slice(0, 2000),
        stack: err.stack ? redact(err.stack).slice(0, 20000) : null,
        screen: currentScreen,
      });
    })().catch(() => {});
  } catch {
    // Reporting must never be the thing that throws.
  }
}

export function installCrashReporter() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => recordError(e.error ?? e.message, false));
  window.addEventListener("unhandledrejection", (e) => recordError(e.reason, false));
}

export async function uploadPendingCrashReports() {
  // Nothing is queued on the web; reports are sent as they happen.
}

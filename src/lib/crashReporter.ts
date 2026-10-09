import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import { supabase } from "./supabase";

/**
 * Records JavaScript errors so they can actually be diagnosed.
 *
 * In a release build an unhandled JS error makes React Native abort the app
 * (RCTExceptionsManager raises an Objective-C exception), and the resulting
 * crash log contains no trace of the JS message or stack — which is why
 * repeated SIGABRT crashes on test devices had no visible cause. The global
 * handler below writes the error to disk SYNCHRONOUSLY (File.write) before
 * the default handler takes the app down, and the next launch uploads it to
 * client_crash_reports (scripts/sql/070_client_crash_reports.sql).
 */

type PendingReport = {
  occurredAt: string;
  isFatal: boolean;
  message: string;
  stack: string | null;
  screen: string | null;
};

const reportsDir = new Directory(Paths.document, "crash-reports");
let currentScreen: string | null = null;
let installed = false;

export function setCrashContextScreen(screen: string | null) {
  currentScreen = screen;
}

export function recordError(error: unknown, isFatal: boolean) {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const report: PendingReport = {
      occurredAt: new Date().toISOString(),
      isFatal,
      message: `${err.name}: ${err.message}`.slice(0, 2000),
      stack: err.stack ? err.stack.slice(0, 20000) : null,
      screen: currentScreen,
    };
    if (!reportsDir.exists) reportsDir.create({ intermediates: true, idempotent: true });
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    new File(reportsDir, name).write(JSON.stringify(report));
  } catch {
    // Reporting must never be the thing that throws.
  }
}

type ErrorUtilsShape = {
  getGlobalHandler: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => void;
};

export function installCrashReporter() {
  if (installed) return;
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsShape }).ErrorUtils;
  if (!errorUtils) return;
  installed = true;
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    recordError(error, !!isFatal);
    previous?.(error, isFatal);
  });
}

/** Uploads reports left by earlier runs. Best-effort: anything that fails to
 * send stays on disk and is retried next launch. */
export async function uploadPendingCrashReports() {
  try {
    if (!reportsDir.exists) return;
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user.id ?? null;

    for (const entry of reportsDir.list()) {
      if (!(entry instanceof File)) continue;
      let report: PendingReport;
      try {
        report = JSON.parse(entry.textSync()) as PendingReport;
      } catch {
        entry.delete();
        continue;
      }
      const { error } = await supabase.from("client_crash_reports").insert({
        user_id: userId,
        occurred_at: report.occurredAt,
        is_fatal: report.isFatal,
        platform: Platform.OS,
        app_version: Constants.expoConfig?.version ?? null,
        build_number:
          Platform.OS === "ios"
            ? (Constants.expoConfig?.ios?.buildNumber ?? null)
            : String(Constants.expoConfig?.android?.versionCode ?? ""),
        message: report.message,
        stack: report.stack,
        screen: report.screen,
      });
      // A check violation means the row itself is malformed — retrying will
      // never succeed, so drop it rather than resend it forever.
      if (!error || error.code === "23514") entry.delete();
    }
  } catch {
    // Next launch will try again.
  }
}

// Resolves and records the approximate country a device signed in from, for
// the Devices screen (app/devices.tsx) — Telegram-style "Uzbekistan" under
// each session.
//
// This has to be an Edge Function, not a plain RPC: the real client IP is
// only available from the x-forwarded-for header Supabase's edge network
// sets on the incoming request, which SQL/PostgREST has no access to at
// all. auth.sessions itself carries no IP column either (IP only exists
// buried in auth.audit_log_entries as opaque JSON, not meant for app
// queries) — so this function is the one place that ever sees it.
//
// Called by the client right after claim_expo_push_token/
// claim_voip_push_token (src/hooks/usePushNotifications.ts,
// src/hooks/useCallManager.tsx), i.e. whenever a device "appears" — not on
// every request, so this stays a one-shot lookup per session rather than a
// per-message cost.
//
// REWRITTEN 2026-10-03: previously called ip-api.com, a third-party service,
// over plain HTTP — meaning the client's real sign-in IP travelled
// unencrypted to an external host on every lookup, and the free tier's
// terms only cover non-commercial use. Replaced with an offline lookup
// against a DB-IP Lite country database (CC-BY-4.0 — see PRIVACY_POLICY.md
// and the site's privacy page for the required attribution): the IP now
// never leaves Supabase's own infrastructure at all. Trade-off: DB-IP's
// City Lite edition (closer to what ip-api.com returned) is ~60MB — even
// Country Lite's ~8MB turned out too large to deploy bundled WITH the
// function (every attempt hit a flat 413 "request entity too large" on the
// deploy request itself, both via Docker and --use-api). It instead lives
// in a private Storage bucket (geoip-data) and is fetched + cached once per
// function instance below, the documented fallback for exactly this case.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Reader, type CountryResponse } from "mmdb-lib";

type Payload = { session_id: string };

// Fetched once per function instance (cold start), not per request —
// Supabase keeps an instance warm across requests, so this only actually
// runs occasionally, not on every sign-in. A failed fetch here must not
// crash every request forever: geoReaderPromise is retried lazily (not
// memoized on failure) by re-running this function the next time it's null.
let geoReaderPromise: Promise<Reader<CountryResponse>> | null = null;
function getGeoReader(): Promise<Reader<CountryResponse>> {
  if (!geoReaderPromise) {
    geoReaderPromise = (async () => {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const admin = createClient(supabaseUrl, serviceRoleKey);
      const { data, error } = await admin.storage
        .from("geoip-data")
        .download("dbip-country-lite.mmdb");
      if (error || !data) {
        geoReaderPromise = null;
        throw error ?? new Error("geoip-data download returned no data");
      }
      const dbBytes = new Uint8Array(await data.arrayBuffer());
      return new Reader<CountryResponse>(dbBytes);
    })();
  }
  return geoReaderPromise;
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response("unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  // Verifies the caller actually holds a valid session — this function
  // only ever records a location for the session_id the caller names, and
  // set_session_location (SQL) has no ownership check of its own (it's
  // service_role-only, not client-callable), so this is the one place that
  // stands between "any request" and "write to an arbitrary session_id".
  const {
    data: { user },
  } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
  if (!user) {
    return new Response("unauthorized", { status: 401 });
  }

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!payload.session_id) {
    return new Response("missing session_id", { status: 400 });
  }

  // Confirms the named session actually belongs to the caller — without
  // this, an authenticated user could pass ANY session_id and overwrite
  // someone else's recorded location with whatever city they choose.
  // auth.sessions isn't reachable through PostgREST directly (not in the
  // exposed schema list), hence the RPC rather than a table query.
  const { data: owns } = await admin.rpc("session_belongs_to_user", {
    p_session_id: payload.session_id,
    p_user_id: user.id,
  });
  if (!owns) {
    return new Response("not your session", { status: 403 });
  }

  // Supabase's edge network sets this; the LEFTMOST address is the actual
  // client, everything after it is intermediate proxies.
  const forwardedFor = req.headers.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim();
  if (!clientIp) {
    return new Response("no client ip available", { status: 200 });
  }

  // Offline lookup — see the file header for why this replaced ip-api.com.
  // Fails soft (200 with no location set), same as before: a VPN or
  // carrier-NAT range that DB-IP has no data for is routine, not an error.
  let country: string | null = null;
  try {
    const geoReader = await getGeoReader();
    const result = geoReader.get(clientIp);
    country = result?.country?.names?.en ?? null;
  } catch (error) {
    console.warn("[register-device-location] geolocation lookup failed:", error);
  }

  if (!country) {
    return new Response("could not resolve location", { status: 200 });
  }

  // city is always null now — set_session_location's signature is
  // unchanged (still takes p_city) so the SQL/schema side needed no
  // migration; the column just stays unset going forward. app/devices.tsx
  // already renders country-only when city is null (see its own comment).
  const { error } = await admin.rpc("set_session_location", {
    p_session_id: payload.session_id,
    p_city: null,
    p_country: country,
  });
  if (error) {
    console.error("[register-device-location] set_session_location failed:", error.message);
    return new Response("failed to record location", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});

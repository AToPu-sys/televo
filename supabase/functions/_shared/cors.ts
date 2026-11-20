// CORS for the few functions the web app calls directly. Requests carry the
// user's bearer token (never cookies), so CORS is not what protects them —
// auth is — but only Televo's own web origins are allowed anyway.
const ALLOWED_ORIGINS = new Set([
  "https://web.gettelevo.space",
  "http://localhost:8081",
  "http://localhost:8765",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function withCors(handler: (req: Request) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const extra = corsHeaders(req.headers.get("Origin"));
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: extra });
    const res = await handler(req);
    if (Object.keys(extra).length === 0) return res;
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

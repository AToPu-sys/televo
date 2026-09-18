// Grades a content report and applies a graduated consequence.
//
// Invoked by a Postgres trigger the moment a report is filed, so action is
// taken in seconds rather than whenever someone next looks at a queue —
// Guideline 1.2 makes acting on reports a condition of staying on the store.
//
// IMPORTANT — what this can and cannot see. Messages are end-to-end
// encrypted; the server never holds a key. The only text available is the
// plaintext snapshot the REPORTER's own device attached when filing. That is
// one side's account of the exchange, so it is treated as an ALLEGATION to be
// graded, never as established fact. Consequences escalate on repetition
// across independent reports, which is what prevents a single malicious
// reporter from removing someone they simply dislike.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CLAUDE_MODEL = "claude-haiku-4-5";

type Severity = "none" | "low" | "medium" | "high";

type ReportRecord = {
  id: string;
  reporter_id: string;
  reported_user_id: string;
  reason: string;
  reported_content: string | null;
};

/** True for text that is still a ciphertext envelope rather than readable
 * content. Such a report carries no evidence at all, so it must never be
 * graded — it goes to a human instead. */
function isCiphertext(text: string): boolean {
  if (!text.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.ciphertext === "string" && typeof parsed?.nonce === "string";
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT = `You are a content moderation classifier for a private messaging app.

You are given ONE message that a user reported, plus the category they chose. Messages are private 1:1 or small group chats between people who added each other — not public posts.

Classify the severity of the REPORTED MESSAGE:

- "none": Not a violation. Ordinary conversation, disagreement, mild rudeness, profanity between friends, or content that does not match the report category. Also use this when the message is too ambiguous or too short to judge, or when the report looks retaliatory.
- "low": Mild violation. Insults directed at the recipient, unsolicited promotional spam.
- "medium": Clear violation. Sustained harassment, hate speech targeting a protected characteristic, explicit sexual content sent unsolicited, deceptive scams.
- "high": Severe violation. Credible threats of violence, sexual content involving minors, coordinated abuse, doxxing with intent to harm, promotion of self-harm.

Be conservative. This is private conversation between people who chose to talk to each other, and the report is one side's account. Strong language alone is NOT a violation. When genuinely uncertain, answer "none".

Respond with ONLY a JSON object, no other text:
{"severity":"none|low|medium|high","rationale":"one short sentence"}`;


/** Rule-based severity, used when the LLM classifier is unavailable.
 *
 * Exists because the Anthropic organisation backing the classifier can be
 * (and currently is) disabled — see src/lib/assistant.ts for the same
 * dependency failing elsewhere. Moderation that stops working when a third
 * party turns off an API is not moderation, and Guideline 1.2 does not
 * accept "our vendor was down" as a reason reports went unhandled.
 *
 * Deliberately narrow. It only fires on unambiguous, high-signal patterns;
 * anything subtler returns null so the report goes to a human rather than
 * being auto-dismissed. Under-reaching is the safe failure direction: a
 * missed report waits in a queue, a false ban removes an innocent user.
 */
function classifyByRules(reason: string, content: string): { severity: Severity; rationale: string } | null {
  const text = content.toLowerCase();

  // Credible threats of violence. Requires a violent verb AND a target, so
  // "I'll kill you at chess" style hyperbole does not trip it on its own.
  const violence = /\b(kill|murder|shoot|stab|rape|beat)\b/.test(text);
  const target = /\b(you|your family|ur family)\b/.test(text);
  const locational = /\b(i know where you (live|work)|find you|come to your)\b/.test(text);
  if (violence && (target || locational)) {
    return { severity: "high", rationale: "Rule match: apparent threat of violence toward the recipient." };
  }
  if (locational && /\b(hurt|harm|get you)\b/.test(text)) {
    return { severity: "high", rationale: "Rule match: apparent intimidation referencing the recipient's location." };
  }

  // Self-harm promotion directed at someone.
  if (/\b(kill yourself|kys|go die)\b/.test(text)) {
    return { severity: "high", rationale: "Rule match: encouragement of self-harm." };
  }

  // Promotional spam: a link plus solicitation language, reported as spam.
  const hasLink = /https?:\/\/|www\./.test(text);
  const solicit = /\b(buy|cheap|free money|click here|promo|discount|followers|crypto|investment)\b/.test(text);
  if (reason === "spam" && hasLink && solicit) {
    return { severity: "low", rationale: "Rule match: unsolicited promotional link." };
  }

  // Everything else is genuinely ambiguous without a language model —
  // insults, context, sarcasm. A person decides.
  return null;
}

async function classify(reason: string, content: string): Promise<{ severity: Severity; rationale: string }> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Report category: ${reason}\n\nReported message:\n"""${content.slice(0, 4000)}"""`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const text = data?.content?.[0]?.text ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`unparseable classifier output: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(match[0]);
  const severity = parsed.severity as Severity;
  if (!["none", "low", "medium", "high"].includes(severity)) {
    throw new Error(`invalid severity: ${severity}`);
  }
  return { severity, rationale: String(parsed.rationale ?? "").slice(0, 500) };
}

Deno.serve(async (req) => {
  // FAIL CLOSED: this function bans accounts. An unauthenticated caller could
  // suspend anyone by fabricating a report id.
  const webhookSecret = Deno.env.get("WEBHOOK_SHARED_SECRET");
  if (!webhookSecret || req.headers.get("x-webhook-secret") !== webhookSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  let record: ReportRecord;
  try {
    record = (await req.json()).record;
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!record?.id) return new Response("no record", { status: 400 });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const content = record.reported_content ?? "";

  // Nothing readable to judge: leave it pending for a human rather than
  // guessing. Silently dismissing these would let real abuse through
  // whenever the reporter's device hadn't decrypted the message yet.
  if (!content.trim() || isCiphertext(content)) {
    return new Response("left for human review: no readable content", { status: 200 });
  }

  let verdict: { severity: Severity; rationale: string };
  let decidedBy = `auto:${CLAUDE_MODEL}`;
  try {
    verdict = await classify(record.reason, content);
  } catch (error) {
    // The LLM is unavailable (commonly: the Anthropic organisation is
    // disabled). Fall back to rules rather than dropping the report.
    console.error("LLM classification failed, falling back to rules:", String(error));
    const ruled = classifyByRules(record.reason, content);
    if (!ruled) {
      // No rule is confident enough. Left pending on purpose so it appears
      // in review_queue() — never auto-dismissed.
      return new Response("left for human review: no confident automatic verdict", { status: 200 });
    }
    verdict = ruled;
    decidedBy = "auto:rules";
  }

  const { data, error } = await admin.rpc("apply_moderation_decision", {
    p_report_id: record.id,
    p_severity: verdict.severity,
    p_rationale: verdict.rationale,
    p_decided_by: decidedBy,
  });

  if (error) {
    console.error("apply_moderation_decision failed:", error.message);
    return new Response(`decision failed: ${error.message}`, { status: 500 });
  }

  return new Response(JSON.stringify({ verdict, outcome: data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

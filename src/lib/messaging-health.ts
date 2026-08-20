/**
 * Messaging channel health — failure-rate evaluation + MSG91 template audit.
 *
 * Why this exists
 * ---------------
 * On 7 Aug 2026 the MSG91 WhatsApp plan expired. Every outbound WhatsApp call
 * began returning `"There is no subscription assigned to this number"`, and it
 * stayed that way for nine days across 178 messages — payment reminders, lead
 * alerts, booking confirmations, GST invoices — with nothing anywhere
 * surfacing it. The failures were written to whatsapp_messages.status =
 * 'failed' and read by no one. A near-identical outage ran through most of
 * July (a trailing newline on the sender env var, ~1700 failures).
 *
 * Both were invisible for the same reason: a per-send failure is logged, but
 * nothing ever looks at the *rate*. These helpers do, and are deliberately
 * pure so the thresholds can be unit-tested without a database.
 *
 * The MSG91 side is checked too, because a template silently flipping to
 * REJECTED breaks one message type while the channel as a whole looks fine —
 * which is exactly the state `booking_access_pin` was found in.
 */

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Trailing window the failure rate is computed over. */
export const HEALTH_WINDOW_HOURS = 6;

/**
 * Below this many sends in the window the rate is statistical noise — three
 * sends and one network blip is not a 33% outage. Reported as "idle" instead,
 * which never alerts. Overnight lulls routinely sit under this.
 */
export const MIN_SAMPLE_SIZE = 5;

/** At or above this failure rate the channel is considered fully down. */
export const DOWN_THRESHOLD = 0.8;

/** At or above this failure rate the channel is degraded. */
export const DEGRADED_THRESHOLD = 0.4;

export type ChannelStatus = "ok" | "degraded" | "down" | "idle";

export interface MessageRow {
  status: string;
  error_message: string | null;
}

export interface ChannelHealth {
  status: ChannelStatus;
  failRate: number;
  sampleSize: number;
  failedCount: number;
  dominantError: string | null;
  /** Human-readable cause, when the dominant error maps to a known category. */
  diagnosis: string | null;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Maps a raw MSG91 error string to an operator-actionable cause.
 *
 * The categories are drawn from errors actually observed in production —
 * guessing at MSG91's error taxonomy would produce a diagnosis nobody can act
 * on. Anything unrecognised returns null and the raw string is shown instead.
 */
export function diagnoseError(error: string | null | undefined): string | null {
  if (!error) return null;

  if (/no subscription assigned/i.test(error)) {
    return "MSG91 WhatsApp plan has expired or the number's subscription lapsed. Renew it in the MSG91 dashboard (WhatsApp → plan).";
  }
  if (/not integrated/i.test(error)) {
    // Historically caused by a trailing newline on MSG91_WHATSAPP_SENDER.
    return "MSG91 does not recognise the sender number. Check MSG91_WHATSAPP_SENDER for stray whitespace and confirm the number is still integrated.";
  }
  if (/template.*(not exist|does not exist|invalid)/i.test(error)) {
    return "Template name is not present/approved in MSG91. Check the template audit below.";
  }
  if (/next line|not supported for body value/i.test(error)) {
    return "A template parameter contains a newline or tab. Usually a trailing newline on an env var used to build the value.";
  }
  if (/fetch failed|ETIMEDOUT|ECONNRESET|network/i.test(error)) {
    return "Network error reaching MSG91. Transient if isolated; sustained means an MSG91 outage.";
  }
  if (/authkey|unauthor|invalid key/i.test(error)) {
    return "MSG91 rejected the auth key. Check MSG91_AUTH_KEY.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Failure-rate evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluates one channel's outbound rows from the trailing window.
 *
 * `rows` must already be filtered to a single channel and to outbound
 * direction — inbound messages have no meaningful success/failure.
 */
export function evaluateChannel(rows: MessageRow[]): ChannelHealth {
  const sampleSize = rows.length;
  const failures = rows.filter((r) => r.status === "failed");
  const failedCount = failures.length;

  if (sampleSize < MIN_SAMPLE_SIZE) {
    return {
      status: "idle",
      failRate: sampleSize === 0 ? 0 : failedCount / sampleSize,
      sampleSize,
      failedCount,
      dominantError: null,
      diagnosis: null,
    };
  }

  const failRate = failedCount / sampleSize;

  // Most frequent error string, so the alert names the actual cause rather
  // than whichever failure happened to be most recent.
  const tally = new Map<string, number>();
  for (const f of failures) {
    if (!f.error_message) continue;
    const key = f.error_message.slice(0, 200);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  let dominantError: string | null = null;
  let best = 0;
  for (const [err, count] of tally) {
    if (count > best) { best = count; dominantError = err; }
  }

  const status: ChannelStatus =
    failRate >= DOWN_THRESHOLD ? "down"
    : failRate >= DEGRADED_THRESHOLD ? "degraded"
    : "ok";

  return {
    status,
    failRate,
    sampleSize,
    failedCount,
    dominantError,
    diagnosis: diagnoseError(dominantError),
  };
}

/**
 * True when the change from `previous` to `current` is worth an email.
 *
 * Alerts on any move into or between bad states, and on full recovery to ok.
 * Deliberately silent on ok→idle and idle→ok: traffic simply stopping
 * overnight is not an incident, and treating it as one would email every night.
 */
export function shouldAlert(previous: ChannelStatus | null, current: ChannelStatus): boolean {
  if (current === "idle") return false;
  if (previous === null) return current === "down" || current === "degraded";
  if (previous === current) return false;
  if (current === "down" || current === "degraded") return true;
  // current === "ok" — only announce recovery from a state we alerted on.
  return previous === "down" || previous === "degraded";
}

// ---------------------------------------------------------------------------
// MSG91 template audit
// ---------------------------------------------------------------------------

/**
 * WhatsApp templates this codebase sends. Kept here rather than derived at
 * runtime because the names are string literals at their call sites and
 * nothing can enumerate them from inside the process.
 *
 * `src/lib/__tests__/messaging-health.test.ts` parses the source for
 * `template: "..."` literals and fails if any drift out of this list, so it
 * cannot silently fall behind.
 */
export const MONITORED_WA_TEMPLATES = [
  "billing_statement_ready",
  "booking_checkin",
  "booking_checkout",
  "booking_confirmation",
  "booking_confirmation_doc",
  "gst_invoice_doc",
  "internal_new_lead",
  "lead_followup_reminder",
  "payment_reminder",
  "twv_proposal_doc",
] as const;

export interface TemplateIssue {
  name: string;
  status: string;
  reason?: string;
}

export interface RemoteTemplate {
  name: string;
  status: string;
  rejectionReason?: string;
  disabled?: boolean;
}

/**
 * Fetches the template list for an integrated number.
 *
 * Endpoint verified against the live account: the documented v5 routes for
 * balance and integrated-numbers both 404, but this one returns the full list
 * with per-language approval status. It 308-redirects to an internal host, so
 * redirects must be followed.
 */
export async function fetchMsg91Templates(
  sender: string,
  authKey: string,
  timeoutMs = 15_000
): Promise<RemoteTemplate[]> {
  const res = await fetch(
    `https://control.msg91.com/api/v5/whatsapp/get-template/${encodeURIComponent(sender)}/`,
    {
      headers: { authkey: authKey, accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    }
  );

  if (!res.ok) throw new Error(`MSG91 template API returned HTTP ${res.status}`);

  const json = (await res.json()) as {
    data?: Array<{
      name: string;
      is_disabled?: number | boolean;
      languages?: Array<{ status?: string; rejection_reason?: string; is_disabled?: number | boolean }>;
    }>;
  };

  const out: RemoteTemplate[] = [];
  for (const t of json.data ?? []) {
    // A template can carry several languages; only "en" is ever sent, but the
    // API does not guarantee ordering, so take the first with a status.
    const lang = (t.languages ?? []).find((l) => l.status) ?? (t.languages ?? [])[0];
    out.push({
      name: t.name,
      status: String(lang?.status ?? "unknown"),
      rejectionReason:
        lang?.rejection_reason && lang.rejection_reason !== "NONE" ? lang.rejection_reason : undefined,
      disabled: Boolean(t.is_disabled) || Boolean(lang?.is_disabled),
    });
  }
  return out;
}

/**
 * Templates the code sends that MSG91 will not deliver — missing, unapproved
 * or disabled. `extra` carries the env-configured facility template names,
 * which are not literals in the source.
 */
export function findTemplateIssues(
  remote: RemoteTemplate[],
  extra: string[] = []
): TemplateIssue[] {
  const byName = new Map(remote.map((r) => [r.name, r]));
  const monitored = [...MONITORED_WA_TEMPLATES, ...extra.filter(Boolean)];
  const issues: TemplateIssue[] = [];

  for (const name of new Set(monitored)) {
    const r = byName.get(name);
    if (!r) {
      issues.push({ name, status: "missing", reason: "Not present in MSG91" });
    } else if (r.disabled) {
      issues.push({ name, status: "disabled", reason: "Disabled in MSG91" });
    } else if (r.status !== "approved") {
      issues.push({ name, status: r.status, reason: r.rejectionReason });
    }
  }
  return issues;
}

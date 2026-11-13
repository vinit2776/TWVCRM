// Shared display helpers for approval-related UI surfaces (header bell,
// /approvals page, bill detail). Kept dependency-free so they can be
// imported from server- or client-side files.

export interface PoValidity {
  label: string;
  tone: "ok" | "warn" | "danger" | "neutral";
}

/**
 * Returns a short label for the PO's "days left to process" based on
 * expected_delivery_date. Use to nudge users toward acting before the
 * PO becomes stale.
 *
 * Today / future:  "Due in Nd"  (ok if >3d, warn if ≤3d)
 * Past:            "Overdue Nd" (danger)
 * Missing:         null
 */
export function poValidity(expectedDeliveryDate: string | null | undefined): PoValidity | null {
  if (!expectedDeliveryDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(expectedDeliveryDate);
  if (isNaN(target.getTime())) return null;
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) {
    return { label: `Overdue ${Math.abs(diffDays)}d`, tone: "danger" };
  }
  if (diffDays === 0) return { label: "Due today", tone: "warn" };
  if (diffDays <= 3) return { label: `Due in ${diffDays}d`, tone: "warn" };
  return { label: `Due in ${diffDays}d`, tone: "ok" };
}

export const PO_VALIDITY_CLASS: Record<PoValidity["tone"], string> = {
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warn: "bg-amber-50 text-amber-800 border-amber-200",
  danger: "bg-red-50 text-red-800 border-red-200",
  neutral: "bg-muted text-muted-foreground border-border",
};

/**
 * Returns "Waiting Nd Nh" since the given ISO timestamp.
 * Used as the approval SLA timer on pending bill rows.
 */
export function waitingSince(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || isNaN(ms)) return "";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `Waiting ${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) {
    const m = totalMinutes % 60;
    return m > 0 ? `Waiting ${hours}h ${m}m` : `Waiting ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `Waiting ${days}d ${h}h` : `Waiting ${days}d`;
}

/**
 * If a PO's expected_delivery_date is more than `staleDays` days in the
 * past, returns a banner-ready string. Used on bill detail to warn
 * approvers that the underlying PO is old.
 */
export function staleBannerFor(
  expectedDeliveryDate: string | null | undefined,
  staleDays = 30,
): string | null {
  if (!expectedDeliveryDate) return null;
  const target = new Date(expectedDeliveryDate);
  if (isNaN(target.getTime())) return null;
  const diffDays = Math.floor((Date.now() - target.getTime()) / 86_400_000);
  if (diffDays < staleDays) return null;
  return `This PO's expected delivery date (${expectedDeliveryDate}) was ${diffDays} days ago. Verify the goods/services were actually delivered before approving payment.`;
}

export interface VoFloorMeta {
  quoted_rate?: number | null;
  floor_rate?: number | null;
  guide_rate?: number | null;
  term_months?: number | null;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * One-line "quoted vs floor" summary for a vo_below_floor approval request, e.g.
 * "Quoted ₹8,000 vs floor ₹9,000 (₹1,000 below), 12 months". Rates above 12 months are per year.
 */
export function voFloorSummary(raw: VoFloorMeta | Record<string, unknown> | null | undefined): string {
  // approval_requests.metadata is untyped JSON; trust only numeric values.
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const meta = { term_months: num(raw?.term_months) };
  const quoted = num(raw?.quoted_rate);
  const floor = num(raw?.floor_rate);
  if (quoted === null) return "Below-floor Virtual Office quote";
  const term = meta.term_months ? `, ${meta.term_months} months${meta.term_months > 12 ? " (per-year rate)" : ""}` : "";
  if (floor === null) return `Quoted ${inr(quoted)}${term}`;
  const gap = Math.max(0, floor - quoted);
  return `Quoted ${inr(quoted)} vs floor ${inr(floor)}${gap > 0 ? ` (${inr(gap)} below)` : ""}${term}`;
}

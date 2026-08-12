/**
 * Vendor-email nag — Finance Intelligence feature
 *
 * Triggers a persistent reminder for the accounts team to populate
 * `procurement_vendors.contact_email` for vendors who currently lack one.
 * Uses the shared `finance_suggestion_log` audit table to track
 * dismissals and escalations.
 *
 * Escalation rule (default 3 dismissals in last 7 days → "escalated"):
 *   level "normal"     — amber banner, polite copy
 *   level "escalated"  — red banner, count-of-skips visible
 *
 * Snooze rule (default 4 hours):
 *   If a 'dismissed' row exists for this vendor within the last 4 hours,
 *   the banner does NOT show.
 *
 * Resolution: when the vendor's email is set, we close all open log rows
 * for that vendor with action='fixed'.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const FEATURE = "vendor_email_missing" as const;

export interface NagStatus {
  should_show: boolean;
  level: "normal" | "escalated";
  dismissals_in_window: number;
  snoozed_until: string | null;          // ISO timestamp if currently snoozed
  escalate_after: number;                // threshold (from settings)
  escalate_window_days: number;          // window (from settings)
}

interface NagSettings {
  enabled: boolean;
  snooze_hours: number;
  escalate_after: number;
  escalate_window_days: number;
  digest_enabled: boolean;
}

/** Read just the keys this feature needs (fewer than the full FI config). */
export async function loadVendorEmailNagSettings(supabase: SupabaseClient): Promise<NagSettings> {
  const { data } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", [
      "finance_intelligence_enabled",
      "fi_feature_vendor_email_nag",
      "fi_vendor_email_snooze_hours",
      "fi_vendor_email_escalate_after",
      "fi_vendor_email_escalate_window_days",
      "fi_vendor_email_digest_enabled",
    ]);
  const map = new Map<string, string>((data ?? []).map((r) => [r.key, r.value ?? ""]));
  const master = map.get("finance_intelligence_enabled") !== "false";
  const feat = map.get("fi_feature_vendor_email_nag") !== "false";
  return {
    enabled: master && feat,
    snooze_hours: parseInt(map.get("fi_vendor_email_snooze_hours") || "4", 10),
    escalate_after: parseInt(map.get("fi_vendor_email_escalate_after") || "3", 10),
    escalate_window_days: parseInt(map.get("fi_vendor_email_escalate_window_days") || "7", 10),
    digest_enabled: map.get("fi_vendor_email_digest_enabled") !== "false",
  };
}

/**
 * Compute the nag status for a single vendor — call from API routes when the
 * UI asks "should I show the banner for vendor X to user Y right now?".
 *
 * Caller has already verified the vendor has no contact_email.
 */
export async function getNagStatus(
  supabase: SupabaseClient,
  vendorId: string,
  userId: string,
): Promise<NagStatus> {
  const cfg = await loadVendorEmailNagSettings(supabase);

  if (!cfg.enabled) {
    return {
      should_show: false,
      level: "normal",
      dismissals_in_window: 0,
      snoozed_until: null,
      escalate_after: cfg.escalate_after,
      escalate_window_days: cfg.escalate_window_days,
    };
  }

  // Look for an active snooze (most recent dismissal within snooze window)
  const snoozeCutoff = new Date(Date.now() - cfg.snooze_hours * 60 * 60 * 1000).toISOString();
  const { data: recentDismissal } = await supabase
    .from("finance_suggestion_log")
    .select("triggered_at")
    .eq("feature", FEATURE)
    .eq("entity_id", vendorId)
    .eq("user_action", "dismissed")
    .eq("triggered_by", userId)
    .gte("triggered_at", snoozeCutoff)
    .order("triggered_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const snoozedUntil = recentDismissal
    ? new Date(
        new Date(recentDismissal.triggered_at).getTime() + cfg.snooze_hours * 60 * 60 * 1000,
      ).toISOString()
    : null;

  // Count dismissals for this vendor across ALL users in escalation window
  const escalateCutoff = new Date(
    Date.now() - cfg.escalate_window_days * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { count: dismissalCount } = await supabase
    .from("finance_suggestion_log")
    .select("id", { count: "exact", head: true })
    .eq("feature", FEATURE)
    .eq("entity_id", vendorId)
    .eq("user_action", "dismissed")
    .gte("triggered_at", escalateCutoff);

  const dismissals = dismissalCount ?? 0;
  const level: NagStatus["level"] = dismissals >= cfg.escalate_after ? "escalated" : "normal";
  const should_show = snoozedUntil === null; // banner shows when not actively snoozed

  return {
    should_show,
    level,
    dismissals_in_window: dismissals,
    snoozed_until: snoozedUntil,
    escalate_after: cfg.escalate_after,
    escalate_window_days: cfg.escalate_window_days,
  };
}

/** Record a dismissal — called when user clicks "Skip this time". */
export async function recordDismissal(
  supabase: SupabaseClient,
  vendorId: string,
  userId: string,
): Promise<void> {
  await supabase.from("finance_suggestion_log").insert({
    feature: FEATURE,
    entity_type: "vendor_bill",   // we attach to the workflow context (vendor_bill payment)
    entity_id: vendorId,           // misuse entity_id as vendor_id — feature is scoped
    suggestion: { reason: "missing_contact_email" },
    user_action: "dismissed",
    context: { vendor_id: vendorId },
    triggered_by: userId,
    resolved_at: new Date().toISOString(),
  });
}

/** Record a shown event (without snooze). Used for analytics. */
export async function recordShown(
  supabase: SupabaseClient,
  vendorId: string,
  userId: string,
): Promise<void> {
  await supabase.from("finance_suggestion_log").insert({
    feature: FEATURE,
    entity_type: "vendor_bill",
    entity_id: vendorId,
    suggestion: { reason: "missing_contact_email" },
    user_action: "shown",
    context: { vendor_id: vendorId },
    triggered_by: userId,
  });
}

/** Record a fix — close all open log rows for this vendor. */
export async function recordFix(
  supabase: SupabaseClient,
  vendorId: string,
  userId: string,
  newEmail: string,
): Promise<void> {
  // Insert a fix entry
  await supabase.from("finance_suggestion_log").insert({
    feature: FEATURE,
    entity_type: "vendor_bill",
    entity_id: vendorId,
    suggestion: { reason: "missing_contact_email" },
    user_action: "accepted",
    user_value: { contact_email: newEmail },
    context: { vendor_id: vendorId },
    triggered_by: userId,
    resolved_at: new Date().toISOString(),
  });
}

/**
 * Bulk audit query — returns every vendor without an email, with their
 * recent bill activity for sorting by impact.
 */
export interface VendorEmailGap {
  vendor_id: string;
  vendor_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  pending_bills_count: number;          // bills approval=approved, payment != paid
  bills_last_90d: number;
  total_billed_last_90d: number;
  last_bill_date: string | null;
  dismissals_in_window: number;          // for sorting / surface effort
}

export async function listVendorsMissingEmail(
  supabase: SupabaseClient,
): Promise<VendorEmailGap[]> {
  const { data: vendors } = await supabase
    .from("procurement_vendors")
    .select("id, name, contact_name, contact_phone, contact_email")
    .or("contact_email.is.null,contact_email.eq.");
  if (!vendors?.length) return [];

  const vendorIds = vendors.map((v) => v.id);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0];

  // Full bill history — pending_bills_count must see every unpaid approved bill,
  // not just recent ones, or an old overdue bill silently drops its vendor off
  // the high-priority list. The 90-day window is applied client-side below,
  // scoped only to the bills_last_90d / total_billed_last_90d recency stats.
  const { data: bills } = await supabase
    .from("vendor_bills")
    .select("vendor_id, total_amount, invoice_date, approval_status, payment_status")
    .in("vendor_id", vendorIds);

  // Dismissal counts within current escalation window
  const cfg = await loadVendorEmailNagSettings(supabase);
  const dismissCutoff = new Date(
    Date.now() - cfg.escalate_window_days * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: logs } = await supabase
    .from("finance_suggestion_log")
    .select("entity_id")
    .eq("feature", FEATURE)
    .eq("user_action", "dismissed")
    .gte("triggered_at", dismissCutoff)
    .in("entity_id", vendorIds);

  const dismissalCounts = new Map<string, number>();
  (logs ?? []).forEach((l) => {
    const k = l.entity_id;
    if (!k) return;
    dismissalCounts.set(k, (dismissalCounts.get(k) ?? 0) + 1);
  });

  const gaps: VendorEmailGap[] = vendors.map((v) => {
    const myBills = (bills ?? []).filter((b) => b.vendor_id === v.id);
    const pending = myBills.filter(
      (b) => b.approval_status === "approved" && b.payment_status !== "paid",
    ).length;
    const recentBills = myBills.filter((b) => (b.invoice_date ?? "") >= ninetyDaysAgo);
    const totalBilled = recentBills.reduce((s, b) => s + Number(b.total_amount ?? 0), 0);
    const lastDate = myBills.length
      ? myBills.map((b) => b.invoice_date).sort().slice(-1)[0]
      : null;
    return {
      vendor_id: v.id,
      vendor_name: v.name,
      contact_name: v.contact_name ?? null,
      contact_phone: v.contact_phone ?? null,
      pending_bills_count: pending,
      bills_last_90d: recentBills.length,
      total_billed_last_90d: totalBilled,
      last_bill_date: lastDate,
      dismissals_in_window: dismissalCounts.get(v.id) ?? 0,
    };
  });

  // Sort: highest pending bills first, then highest dismissals, then most recent
  gaps.sort((a, b) => {
    if (b.pending_bills_count !== a.pending_bills_count) {
      return b.pending_bills_count - a.pending_bills_count;
    }
    if (b.dismissals_in_window !== a.dismissals_in_window) {
      return b.dismissals_in_window - a.dismissals_in_window;
    }
    return (b.last_bill_date ?? "").localeCompare(a.last_bill_date ?? "");
  });

  return gaps;
}

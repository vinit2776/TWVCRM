import { decidePrepaidRestore, hoursBeforeStart } from "@/lib/prepaid";
import { logAudit } from "@/lib/audit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseAny = any;

export interface PrepaidCancellationInput {
  bookingId: string;
  bookingDate: string;
  startTime: string;
  trigger: "cancel" | "no_show";
  actorId: string;
  /** Manager override of the default rule. The reason is mandatory. */
  override?: { restore: boolean; reason: string };
}

export interface PrepaidCancellationResult {
  outcome: "restored" | "forfeited";
  creditsRestored: number;
  hoursBeforeStart: number;
  windowHours: number | null;
  isOverride: boolean;
}

/**
 * If the booking consumed package credits, decide whether they go back and
 * record it. Returns null for bookings that did not use a package, or that
 * were already recorded. Failures are logged, never thrown: the status change
 * that triggered this must not be rolled back.
 */
export async function applyPrepaidCancellation(
  supabase: SupabaseAny,
  input: PrepaidCancellationInput,
): Promise<PrepaidCancellationResult | null> {
  try {
    const { data: redemption } = await supabase
      .from("prepaid_redemptions")
      .select("purchase_id")
      .eq("booking_id", input.bookingId)
      .limit(1)
      .maybeSingle();
    if (!redemption) return null;

    const { data: purchase } = await supabase
      .from("prepaid_purchases")
      .select("cancellation_window_hours")
      .eq("id", redemption.purchase_id)
      .single();
    const windowHours: number | null =
      purchase?.cancellation_window_hours == null ? null : Number(purchase.cancellation_window_hours);

    const hours = hoursBeforeStart(input.bookingDate, input.startTime);
    const decision = decidePrepaidRestore({ trigger: input.trigger, hoursBeforeStart: hours, windowHours });
    const restore = input.override ? input.override.restore : decision.restore;

    const { data: rows, error } = await supabase.rpc("record_prepaid_cancellation", {
      p_booking_id: input.bookingId,
      p_trigger: input.trigger,
      p_hours_before_start: hours,
      p_window_hours: windowHours,
      p_restore: restore,
      p_override: !!input.override,
      p_override_reason: input.override?.reason ?? null,
      p_actor: input.actorId,
    });
    if (error) {
      console.error("[prepaid-cancellation] record failed:", error.message);
      return null;
    }
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row?.applied) return null;

    logAudit(supabase, {
      entityType: "prepaid_purchase",
      entityId: redemption.purchase_id,
      action: "update",
      performedBy: input.actorId,
      changes: {
        booking_cancellation: {
          old: null,
          new: `${restore ? "restored" : "forfeited"} (${hours} hrs before start, window ${windowHours ?? "none"})${input.override ? " override" : ""}`,
        },
      },
    });

    return {
      outcome: restore ? "restored" : "forfeited",
      creditsRestored: Number(row.credits_restored),
      hoursBeforeStart: hours,
      windowHours,
      isOverride: !!input.override,
    };
  } catch (err) {
    console.error("[prepaid-cancellation] unexpected failure:", err);
    return null;
  }
}

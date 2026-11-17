import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";

/**
 * Switches a contract's auto-renewal off and records why. A no-op for a contract
 * that never had it on, which is every contract until a person switches one on.
 *
 * Best effort by design: the exit and decline flows that call this must never
 * fail because of it. It also tolerates the columns not existing yet (the
 * migration has not reached that database), in which case nothing happens.
 *
 * Returns true when it actually switched something off.
 */
export async function stopAutoRenewal(
  admin: SupabaseClient,
  contractId: string,
  actorId: string,
  reason: string,
): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("contracts")
      .update({
        auto_renew: false,
        auto_renew_stopped_at: new Date().toISOString(),
        auto_renew_stopped_by: actorId,
        auto_renew_stop_reason: reason,
      })
      .eq("id", contractId)
      .eq("auto_renew", true)
      .select("id");

    if (error) {
      // 42703 undefined_column: migration 00662 not applied here yet. Expected, silent.
      if (error.code !== "42703") console.error("[auto-renewal] could not stop auto-renewal:", error.message);
      return false;
    }
    if (!data || data.length === 0) return false;

    logAudit(admin, {
      entityType: "contract",
      entityId: contractId,
      action: "auto_renewal_stopped",
      performedBy: actorId,
      changes: { auto_renew: { old: true, new: false }, reason: { old: null, new: reason } },
    });
    return true;
  } catch (err) {
    console.error("[auto-renewal] could not stop auto-renewal:", err instanceof Error ? err.message : "unknown error");
    return false;
  }
}

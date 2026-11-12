import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";

// Set app_settings.electricity_auto_approve_enabled to 'false' to bring back the manual
// Approve and Confirm clicks. A missing row means auto-approve is on.
const SETTING_KEY = "electricity_auto_approve_enabled";

/**
 * Whether approving a landlord bill at this location would generate a customer bill. Same contract
 * filter as approve_electricity_landlord_bill(). When it is false the RPC auto-approves the landlord
 * payable instead, which stays with an admin or manager.
 */
export async function hasBillableContract(supabase: SupabaseClient, locationId: string): Promise<boolean | "error"> {
  const { data, error } = await supabase
    .from("contract_electricity_config")
    .select("contract_id, contracts!inner(status)")
    .eq("location_id", locationId)
    .eq("enabled", true)
    .in("contracts.status", ["active", "renewal_in_progress"])
    .limit(1);
  if (error) {
    console.error("[eb] contract lookup failed:", error.message);
    return "error";
  }
  return (data ?? []).length > 0;
}

export interface AutoApproveResult {
  approved: boolean;
  customerBillIds: string[];
  /** Why nothing was auto-approved, when `approved` is false. */
  skippedReason?: string;
}

/**
 * Approves a freshly captured landlord bill and confirms the customer bills it generates,
 * so only the "Bill & Send" click is left. Never throws: the capture has already succeeded,
 * and anything skipped here is still doable by hand from the Electricity screen.
 *
 * Skips when no enabled contract is mapped at the location. The approve step would otherwise
 * auto-approve the landlord's payable (migration 00340), and that approval stays with an
 * admin or manager.
 */
export async function autoApproveCapturedBill(
  supabase: SupabaseClient,
  params: { landlordBillId: string; locationId: string; performedBy: string },
): Promise<AutoApproveResult> {
  const { landlordBillId, locationId, performedBy } = params;

  const { data: setting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", SETTING_KEY)
    .maybeSingle();
  if (setting?.value === "false") return { approved: false, customerBillIds: [], skippedReason: "disabled" };

  const mapped = await hasBillableContract(supabase, locationId);
  if (mapped === "error") return { approved: false, customerBillIds: [], skippedReason: "lookup_failed" };
  if (!mapped) return { approved: false, customerBillIds: [], skippedReason: "no_contract_mapped" };

  const { data: result, error } = await supabase.rpc("approve_electricity_landlord_bill", {
    p_landlord_bill_id: landlordBillId,
    p_approved_by: performedBy,
  });
  if (error) {
    console.error("[eb] auto-approve failed:", error.message);
    return { approved: false, customerBillIds: [], skippedReason: "approve_failed" };
  }

  const customerBillIds = ((result as { customer_bill_ids?: string[] | null }).customer_bill_ids ?? []);

  await logAudit(supabase, {
    entityType: "electricity_bill",
    entityId: landlordBillId,
    action: "update",
    performedBy,
    changes: {
      status: { old: "draft", new: "invoiced" },
      customer_bills_generated: { old: null, new: customerBillIds.length },
      note: { old: null, new: "Auto-approved on capture" },
    },
  });

  const now = new Date().toISOString();
  for (const id of customerBillIds) {
    const { error: confirmErr } = await supabase
      .from("electricity_bills")
      .update({ status: "invoiced", confirmed_by: performedBy, confirmed_at: now })
      .eq("id", id)
      .eq("status", "draft");
    if (confirmErr) {
      console.error("[eb] auto-confirm failed:", confirmErr.message);
      continue;
    }
    await logAudit(supabase, {
      entityType: "electricity_bill",
      entityId: id,
      action: "update",
      performedBy,
      changes: {
        status: { old: "draft", new: "invoiced" },
        confirmed_by: { old: null, new: performedBy },
        note: { old: null, new: "Auto-confirmed on capture" },
      },
    });
  }

  return { approved: true, customerBillIds };
}

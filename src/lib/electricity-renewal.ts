import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";

// Columns that identify the row rather than describe the settings; everything
// else (location, switch, split, rates, GST, billing profile, and any column
// added later) rides along to the renewal untouched.
const IDENTITY_COLUMNS = ["id", "contract_id", "created_at", "updated_at"] as const;

export function electricityConfigForRenewal(
  source: Record<string, unknown>,
  newContractId: string,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  for (const col of IDENTITY_COLUMNS) delete copy[col];
  return { ...copy, contract_id: newContractId };
}

/**
 * A renewal is a new contract row, and electricity re-billing is keyed on the
 * contract. Without this the renewed contract silently drops out of the monthly
 * landlord-bill approval ("No contracts enabled") and nothing is billed to the
 * customer. Returns true when a config was carried.
 */
export async function carryElectricityConfigToRenewal(
  admin: SupabaseClient,
  params: { sourceContractId: string; newContractId: string; actorId: string },
): Promise<boolean> {
  const { data: source, error: readErr } = await admin
    .from("contract_electricity_config")
    .select("*")
    .eq("contract_id", params.sourceContractId)
    .maybeSingle();
  if (readErr) {
    console.error("[electricity-renewal] could not read parent config:", readErr.message);
    return false;
  }
  if (!source) return false;

  const { error: insertErr } = await admin
    .from("contract_electricity_config")
    .insert(electricityConfigForRenewal(source as Record<string, unknown>, params.newContractId));
  if (insertErr) {
    console.error("[electricity-renewal] carry-over failed:", insertErr.message);
    return false;
  }

  await logAudit(admin, {
    entityType: "contract",
    entityId: params.newContractId,
    action: "update",
    performedBy: params.actorId,
    changes: { electricity_config: { old: null, new: "carried from parent contract" } },
  });
  return true;
}

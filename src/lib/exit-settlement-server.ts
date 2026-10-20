import type { SupabaseClient } from "@supabase/supabase-js";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import type { SettlementStatus } from "@/lib/exit-settlement";

export const LIVE_SETTLEMENT_STATUSES = ["pending_approval", "approved", "paid", "closed"];

export interface SettlementRow {
  id: string;
  exit_id: string;
  contract_id: string;
  lead_id: string;
  status: SettlementStatus;
  outcome: "refund" | "owed" | "nil";
  deposit_amount: number;
  charges_total: number;
  retained_amount: number;
  refund_amount: number;
  owed_amount: number;
  snapshot: { charges?: Array<{ charge_type: string; description: string; amount: number; added_by_name: string | null; edited_after_add: boolean }> };
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  cleared_by: string | null; cleared_at: string;
  approved_by: string | null; approved_at: string | null;
  returned_by: string | null; returned_at: string | null; return_reason: string | null;
  paid_by: string | null; paid_at: string | null; payment_date: string | null;
  payment_reference: string | null; paid_from_account: string | null; payment_notes: string | null;
  owed_invoice_reference: string | null; owed_handled_at: string | null;
  created_at: string;
}

const NUM = ["deposit_amount", "charges_total", "retained_amount", "refund_amount", "owed_amount"] as const;
export function normalizeSettlement(r: Record<string, unknown>): SettlementRow {
  const out = { ...r } as Record<string, unknown>;
  for (const k of NUM) out[k] = Number(r[k] ?? 0);
  return out as unknown as SettlementRow;
}

/** The settlement that currently locks the exit's charges, if any. */
export async function getLiveSettlement(admin: SupabaseClient, exitId: string): Promise<SettlementRow | null> {
  const { data } = await admin.from("exit_settlements").select("*").eq("exit_id", exitId).in("status", LIVE_SETTLEMENT_STATUSES).maybeSingle();
  return data ? normalizeSettlement(data) : null;
}

/** Latest settlement of any status, so a returned one can still explain itself. */
export async function getLatestSettlement(admin: SupabaseClient, exitId: string): Promise<SettlementRow | null> {
  const { data } = await admin.from("exit_settlements").select("*").eq("exit_id", exitId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data ? normalizeSettlement(data) : null;
}

export async function notifyRoles(
  admin: SupabaseClient,
  roles: string[],
  extraUserIds: Array<string | null>,
  n: { title: string; body: string; url: string; contractId: string }
): Promise<void> {
  const { data } = await admin.from("users").select("id").in("role", roles).eq("is_active", true);
  const ids = [...new Set([...(data ?? []).map((u) => u.id as string), ...(extraUserIds.filter(Boolean) as string[])])];
  if (ids.length === 0) return;
  await createNotificationsForUsers(ids, { type: "exit_settlement", title: n.title, body: n.body, url: n.url, entityType: "contract", entityId: n.contractId });
}

export function customerLabel(lead: { first_name?: string | null; last_name?: string | null; company?: string | null } | null | undefined): string {
  return lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || "Customer";
}

/** Signed-in user and their role, or an error to return as-is. */
export async function requireRole(roles: readonly string[], message: string) {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { NextResponse } = await import("next/server");
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const { data: me } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!me || !roles.includes(me.role)) return { error: NextResponse.json({ error: message }, { status: 403 }) } as const;
  return { me } as const;
}

export async function loadSettlementForAction(admin: SupabaseClient, id: string) {
  const { data } = await admin
    .from("exit_settlements")
    .select("*, contract:contracts!exit_settlements_contract_id_fkey(contract_number, lead:leads!contracts_lead_id_fkey(first_name, last_name, company))")
    .eq("id", id).single();
  if (!data) return null;
  const { contract, ...rest } = data as Record<string, unknown> & { contract?: { contract_number: string; lead: { first_name: string | null; last_name: string | null; company: string | null } | null } | null };
  return { settlement: normalizeSettlement(rest), contractNumber: contract?.contract_number ?? "", customer: customerLabel(contract?.lead) };
}

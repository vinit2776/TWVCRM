import { DEAD_BILL_STATUSES_FILTER } from "@/lib/constants";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanAliases, nameKey } from "@/lib/electricity-connections";
import { connectionConflictMessages } from "@/lib/electricity-connections-server";
import { invoiceKey, type ElectricityContextFacts, type VendorConnection } from "@/lib/electricity-bill-match";
import { logAudit } from "@/lib/audit";

/**
 * Loads everything decideElectricityContext needs. Reads only: the vendor's flag, the
 * chosen location, and the vendor's active connections at every location.
 */
export async function loadElectricityFacts(
  admin: SupabaseClient,
  args: { vendorId: string; hasPo: boolean; billCompanyId: string | null; locationId: string | null }
): Promise<ElectricityContextFacts> {
  const { data: vendor, error: vErr } = await admin
    .from("procurement_vendors")
    .select("is_electricity_provider")
    .eq("id", args.vendorId)
    .maybeSingle();
  if (vErr) throw new Error(vErr.message);
  const vendorIsElectricityProvider = Boolean(vendor?.is_electricity_provider);

  // Nothing further is read for an ordinary bill.
  if (!vendorIsElectricityProvider || args.hasPo) {
    return { vendorIsElectricityProvider, hasPo: args.hasPo, billCompanyId: args.billCompanyId, location: null, connections: [] };
  }

  const [{ data: loc, error: lErr }, { data: conns, error: cErr }] = await Promise.all([
    args.locationId
      ? admin.from("locations").select("id, name, company_id, is_active").eq("id", args.locationId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    admin
      .from("location_electricity_connections")
      .select("id, location_id, vendor_id, consumer_number, bill_aliases, is_active, location:locations(name)")
      .eq("vendor_id", args.vendorId)
      .eq("is_active", true),
  ]);
  if (lErr) throw new Error(lErr.message);
  if (cErr) throw new Error(cErr.message);

  const connections: VendorConnection[] = (conns ?? []).map((c) => ({
    id: c.id as string,
    location_id: c.location_id as string,
    vendor_id: c.vendor_id as string,
    consumer_number: (c.consumer_number as string | null) ?? null,
    bill_aliases: (c.bill_aliases as string[]) ?? [],
    is_active: Boolean(c.is_active),
    location_name: (c.location as unknown as { name?: string } | null)?.name ?? "another location",
  }));

  return {
    vendorIsElectricityProvider,
    hasPo: args.hasPo,
    billCompanyId: args.billCompanyId,
    location: loc ? { id: loc.id as string, name: loc.name as string, company_id: (loc.company_id as string | null) ?? null, is_active: Boolean(loc.is_active) } : null,
    connections,
  };
}

/**
 * Adds a wording to a connection's remembered names, after the bill is saved. Best-effort:
 * a clash (another connection already uses it) or any failure returns a warning and never
 * undoes the bill. Anyone who can record a bill may add a wording; creating, editing or
 * deactivating a connection stays admin-only.
 */
export async function rememberConnectionName(
  admin: SupabaseClient,
  args: { connectionId: string; name: string; userId: string; billId: string }
): Promise<{ added: boolean; warning?: string }> {
  const { data: conn, error } = await admin
    .from("location_electricity_connections")
    .select("id, vendor_id, consumer_number, bill_aliases")
    .eq("id", args.connectionId)
    .eq("is_active", true)
    .maybeSingle();
  if (error || !conn) return { added: false, warning: "Could not remember that name: the connection was not found." };

  const existing = (conn.bill_aliases as string[]) ?? [];
  if (existing.some((a) => nameKey(a) === nameKey(args.name))) return { added: false };

  const next = cleanAliases([...existing, args.name]);
  const clashes = await connectionConflictMessages(
    admin,
    { vendor_id: conn.vendor_id as string, consumer_number: (conn.consumer_number as string | null) ?? null, bill_aliases: next },
    conn.id as string
  );
  if (clashes.length) return { added: false, warning: `Name not remembered: ${clashes[0]}` };

  const { error: upErr } = await admin.from("location_electricity_connections").update({ bill_aliases: next }).eq("id", conn.id as string);
  if (upErr) return { added: false, warning: "Could not remember that name." };

  await logAudit(admin, {
    entityType: "electricity_connection",
    entityId: conn.id as string,
    action: "update",
    performedBy: args.userId,
    changes: { bill_aliases: { old: existing, new: next }, _learned_from_vendor_bill: { old: null, new: args.billId } },
  });
  return { added: true };
}

export interface DuplicateBill {
  id: string;
  bill_number: string;
  invoice_number: string | null;
  invoice_date: string;
  total_amount: number;
  approval_status: string;
}

/**
 * An existing non-rejected bill from the same vendor whose number matches ignoring case,
 * spacing and punctuation ("EB/09/2026/00418" = "eb-09-2026-00418"). Rejected bills are
 * excluded so a corrected re-submission is allowed. Used by the electricity paths, which
 * create or link payables and so must not double-book a bill that already exists.
 */
export async function findDuplicateVendorBill(
  admin: SupabaseClient,
  vendorId: string,
  invoiceNumber: string | null | undefined
): Promise<DuplicateBill | null> {
  const key = invoiceKey(invoiceNumber);
  if (!key) return null;
  const { data, error } = await admin
    .from("vendor_bills")
    .select("id, bill_number, invoice_number, invoice_date, total_amount, approval_status")
    .eq("vendor_id", vendorId)
    .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER)
    .not("invoice_number", "is", null)
    .limit(2000);
  if (error) throw new Error(error.message);
  const hit = (data ?? []).find((b) => invoiceKey(b.invoice_number as string) === key);
  return hit ? ({ ...hit, total_amount: Number(hit.total_amount) } as DuplicateBill) : null;
}

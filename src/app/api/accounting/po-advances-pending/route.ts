import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/accounting/po-advances-pending
 *
 * Pending PO advances surfaced into Finance > Acc Payables. Returns the PO
 * vendor + the matching vendor's MR quotation (the proforma the advance is
 * being paid against — option (b) from the design discussion).
 *
 * Visible to admin / accounts / office_admin / manager (manager can view but
 * cannot record; the role gate lives on the process_advance PATCH).
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { data: pos, error } = await supabase
    .from("purchase_orders")
    .select(`
      id, po_number, advance_amount, advance_payment_mode, payment_terms,
      created_at, status, vendor_id,
      procurement_vendors(id, name, contact_email, bank_name, bank_account_number, bank_ifsc),
      purchase_requests(id, pr_number)
    `)
    .eq("advance_status", "pending")
    .gt("advance_amount", 0)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Fetch the matching vendor's quotation file for each PO, in parallel.
  // We only surface the winning vendor's quotation (the one that ended up
  // becoming the PO) — that's the proforma the advance is being released
  // against.
  const enriched = await Promise.all(
    (pos ?? []).map(async (po) => {
      const prId = (po.purchase_requests as unknown as { id?: string } | null)?.id;
      const vendor = po.procurement_vendors as unknown as { id: string; name: string } | null;
      let proforma: { file_name: string; file_path: string; amount: number; signed_url: string | null } | null = null;

      if (prId && vendor) {
        const { data: quotes } = await supabase
          .from("material_request_quotations")
          .select("file_path, file_name, amount, vendor_name")
          .eq("pr_id", prId);

        // Match by vendor_name (free-text on the quotation; exact match on
        // vendor.name first, then case-insensitive contains as a fallback).
        const winning = (quotes ?? []).find((q) => q.vendor_name === vendor.name)
          ?? (quotes ?? []).find((q) =>
            q.vendor_name?.toLowerCase().includes(vendor.name.toLowerCase())
          );

        if (winning) {
          const { data: signed } = await supabase.storage
            .from("crm-documents")
            .createSignedUrl(winning.file_path, 3600);
          proforma = {
            file_name: winning.file_name,
            file_path: winning.file_path,
            amount: Number(winning.amount),
            signed_url: signed?.signedUrl ?? null,
          };
        }
      }

      return { ...po, proforma };
    })
  );

  return NextResponse.json({ data: enriched });
}

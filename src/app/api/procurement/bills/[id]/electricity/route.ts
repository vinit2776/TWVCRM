import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

// Read-only: what the vendor-bill page needs to offer "Add electricity details". For an
// ordinary bill this answers { eligible: false } after one cheap lookup and reads nothing
// else, and a database that predates the electricity columns degrades to the same answer
// rather than an error, so the page never depends on the migration having been applied.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();

  const { data: bill, error: bErr } = await admin
    .from("vendor_bills")
    .select("id, vendor_id, company_id, po_id, approval_status, total_amount, invoice_number, invoice_date, electricity_bill_id")
    .eq("id", id)
    .maybeSingle();
  if (bErr || !bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });

  const { data: vendor, error: vErr } = await admin
    .from("procurement_vendors")
    .select("id, name, is_electricity_provider")
    .eq("id", bill.vendor_id)
    .maybeSingle();
  const notApplicable = { data: { eligible: false, reason: null as string | null, link: null } };
  if (vErr || !vendor?.is_electricity_provider) return NextResponse.json(notApplicable);

  let reason: string | null = null;
  if (bill.po_id) reason = "This bill is linked to a purchase order, so it takes its details from the PO.";
  else if (bill.approval_status === "rejected") reason = "This bill was rejected.";
  else if (bill.electricity_bill_id) reason = "This bill was created through electricity capture and already has its details.";

  const { data: link, error: lErr } = await admin
    .from("electricity_bills")
    .select("*, electricity_bill_lines(*), locations(id, name), connection:location_electricity_connections(id, consumer_number, onegrid_device_id)")
    .eq("source_vendor_bill_id", id)
    .neq("status", "revised")
    .maybeSingle();
  if (lErr) return NextResponse.json(notApplicable);

  if (link || reason) return NextResponse.json({ data: { eligible: false, reason, link: link ?? null, vendor_name: vendor.name } });

  const [{ data: locations }, { data: connections }] = await Promise.all([
    admin.from("locations").select("id, name, company_id, is_active").eq("company_id", bill.company_id).eq("is_active", true).order("name"),
    admin
      .from("location_electricity_connections")
      .select("id, location_id, consumer_number, onegrid_device_id, bill_aliases")
      .eq("vendor_id", bill.vendor_id)
      .eq("is_active", true),
  ]);

  return NextResponse.json({
    data: {
      eligible: true,
      reason: null,
      link: null,
      vendor_name: vendor.name,
      bill: { id: bill.id, total_amount: Number(bill.total_amount), invoice_number: bill.invoice_number, invoice_date: bill.invoice_date },
      locations: locations ?? [],
      connections: connections ?? [],
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  // ── 1. Fetch the bill ─────────────────────────────────────────────────────
  const { data: bill, error: billError } = await supabase
    .from("vendor_bills")
    .select(`
      *,
      creator:users!vendor_bills_created_by_fkey(id, full_name),
      approver:users!vendor_bills_approved_by_fkey(id, full_name),
      gst_setter:users!vendor_bills_gst_set_by_fkey(id, full_name),
      gst_zero_confirmer:users!vendor_bills_gst_zero_confirmed_by_fkey(id, full_name),
      vendor_bill_payments(*, recorder:users!vendor_bill_payments_recorded_by_fkey(id, full_name)),
      vendor_bill_documents(id, file_url, file_name, doc_type, created_at, uploader:users!vendor_bill_documents_uploaded_by_fkey(id, full_name)),
      electricity_bill:electricity_bills!vendor_bills_electricity_bill_id_fkey(bill_month, bill_year, landlord_total_amount, landlord_gst_applicable, landlord_gst_rate, landlord_gst_amount, electricity_bill_lines(line_type, meter_label, label, units, rate, amount, sort_order))
    `)
    .eq("id", id)
    .single();

  if (billError || !bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });

  // ── 2. Fetch the vendor (including KYC docs) ──────────────────────────────
  const { data: vendor } = await supabase
    .from("procurement_vendors")
    .select("id, name, category, contact_name, contact_phone, contact_email, gstin, pan_number, is_approved, pan_doc_path, gst_cert_path, reg_cert_path, aadhar_doc_path, msme_cert_path, bank_name, bank_account_holder, bank_account_number, bank_ifsc")
    .eq("id", bill.vendor_id)
    .single();

  // ── 3. Fetch the PO + its PR (MR) ────────────────────────────────────────
  let po = null;
  let mr = null;
  let deliveryChallans: unknown[] = [];
  let serviceReports: unknown[] = [];

  if (bill.po_id) {
    const { data: poData } = await supabase
      .from("purchase_orders")
      .select(`
        id, po_number, status, po_type, created_at, total_ordered_amount,
        expected_delivery_date, actual_delivery_date, notes,
        payment_terms, terms_and_conditions,
        advance_amount, advance_status, advance_payment_mode,
        advance_payment_reference, advance_payment_date,
        location:locations!purchase_orders_location_id_fkey(id, name),
        orderer:users!purchase_orders_ordered_by_fkey(id, full_name),
        purchase_requests(
          id, pr_number, department, total_estimated_amount, created_at,
          approved_at, approval_code,
          requester:users!purchase_requests_requested_by_fkey(id, full_name),
          approver:users!purchase_requests_approved_by_fkey(id, full_name),
          purchase_request_items(id, item_name, quantity, unit, estimated_price, total_estimated, notes)
        ),
        purchase_order_items(id, item_name, quantity_ordered, unit_price, unit)
      `)
      .eq("id", bill.po_id)
      .single();

    if (poData) {
      po = poData;
      mr = (poData.purchase_requests as unknown) ?? null;

      // Fetch delivery challans (goods) or service reports (services) in parallel
      const [dcRes, srRes] = await Promise.all([
        supabase
          .from("po_delivery_receipts")
          .select(`
            id, dc_number, dc_date, file_url, notes, received_at,
            receiver:users!po_delivery_receipts_received_by_fkey(id, full_name),
            po_delivery_receipt_items(id, po_item_id, qty_received, purchase_order_items(item_name, unit))
          `)
          .eq("po_id", bill.po_id)
          .order("received_at", { ascending: true }),

        supabase
          .from("po_service_reports")
          .select(`
            id, cycle_number, period_from, period_to, report_file_url, notes, created_at,
            recorder:users!po_service_reports_recorded_by_fkey(id, full_name)
          `)
          .eq("po_id", bill.po_id)
          .order("cycle_number", { ascending: true }),
      ]);

      deliveryChallans = dcRes.data ?? [];
      serviceReports = srRes.data ?? [];
    }
  }

  // ── 4. Build signed URLs for KYC docs ────────────────────────────────────
  const KYC_FIELDS = ["pan_doc_path", "gst_cert_path", "reg_cert_path", "aadhar_doc_path", "msme_cert_path"] as const;
  const KYC_LABELS: Record<string, string> = {
    pan_doc_path: "PAN Card",
    gst_cert_path: "GST Certificate",
    reg_cert_path: "Registration Certificate",
    aadhar_doc_path: "Director / Proprietor Aadhar",
    msme_cert_path: "MSME Certificate",
  };

  const kycDocs: Array<{ label: string; field: string; path: string; signedUrl: string | null }> = [];
  if (vendor) {
    for (const field of KYC_FIELDS) {
      const path = (vendor as Record<string, unknown>)[field] as string | null;
      if (path) {
        const { data: signed } = await supabase.storage
          .from("vendor-documents")
          .createSignedUrl(path, 3600);
        kycDocs.push({ label: KYC_LABELS[field], field, path, signedUrl: signed?.signedUrl ?? null });
      }
    }
  }

  // Generate signed URL for invoice file
  let invoiceSignedUrl: string | null = null;
  if (bill.invoice_file_url) {
    try {
      const urlPath = new URL(bill.invoice_file_url).pathname.split("/object/public/")[1];
      if (urlPath) {
        const [bucket, ...rest] = urlPath.split("/");
        const { data: signed } = await supabase.storage
          .from(bucket)
          .createSignedUrl(rest.join("/"), 3600);
        invoiceSignedUrl = signed?.signedUrl ?? bill.invoice_file_url;
      }
    } catch {
      invoiceSignedUrl = bill.invoice_file_url;
    }
  }

  // Generate signed URLs for delivery challans
  const challansWithUrls = await Promise.all(
    (deliveryChallans as Array<Record<string, unknown>>).map(async (dc) => {
      if (!dc.file_url) return { ...dc, signed_url: null };
      try {
        const urlPath = new URL(dc.file_url as string).pathname.split("/object/public/")[1];
        if (urlPath) {
          const [bucket, ...rest] = urlPath.split("/");
          const { data: signed } = await supabase.storage.from(bucket).createSignedUrl(rest.join("/"), 3600);
          return { ...dc, signed_url: signed?.signedUrl ?? dc.file_url };
        }
      } catch { /* ignore */ }
      return { ...dc, signed_url: dc.file_url };
    })
  );

  // Generate signed URLs for service reports
  const reportsWithUrls = await Promise.all(
    (serviceReports as Array<Record<string, unknown>>).map(async (sr) => {
      if (!sr.report_file_url) return { ...sr, signed_url: null };
      try {
        const urlPath = new URL(sr.report_file_url as string).pathname.split("/object/public/")[1];
        if (urlPath) {
          const [bucket, ...rest] = urlPath.split("/");
          const { data: signed } = await supabase.storage.from(bucket).createSignedUrl(rest.join("/"), 3600);
          return { ...sr, signed_url: signed?.signedUrl ?? sr.report_file_url };
        }
      } catch { /* ignore */ }
      return { ...sr, signed_url: sr.report_file_url };
    })
  );

  // ── 5. Fetch full audit trail (bill + PO + MR) ────────────────────────────
  const entityIds = [id];
  if (bill.po_id) entityIds.push(bill.po_id);
  const mrId = mr && typeof mr === "object" && "id" in (mr as object) ? (mr as { id: string }).id : null;
  if (mrId) entityIds.push(mrId);

  const { data: auditRows } = await supabase
    .from("audit_trail")
    .select(`
      id, entity_type, entity_id, action, changes, created_at,
      performer:users!audit_trail_performed_by_fkey(id, full_name)
    `)
    .in("entity_id", entityIds)
    .order("created_at", { ascending: true });

  return NextResponse.json({
    data: {
      bill: { ...bill, invoice_signed_url: invoiceSignedUrl },
      vendor,
      po,
      mr,
      deliveryChallans: challansWithUrls,
      serviceReports: reportsWithUrls,
      kycDocs,
      auditTrail: auditRows ?? [],
    },
  });
}

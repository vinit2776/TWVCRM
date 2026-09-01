import { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";

export interface CreateVendorBillInput {
  company_id: string;
  vendor_id: string;
  invoice_number?: string | null;
  invoice_date: string;
  due_date?: string | null;
  total_amount: number;
  gst_amount?: number;
  notes?: string | null;
  invoice_file_url?: string | null;
  po_id?: string | null;
  service_report_id?: string | null;
  replaces_bill_id?: string | null;
  electricity_bill_id?: string | null;
  amount_paid?: number;
  payment_status?: string;
  created_by: string;
}

export interface CreateVendorBillResult {
  id: string;
  bill_number: string;
}

export async function createVendorBill(
  supabase: SupabaseClient,
  input: CreateVendorBillInput
): Promise<CreateVendorBillResult> {
  // bill_number is generated atomically by the trg_generate_vendor_bill_number
  // DB trigger (00397_fix_vendor_bill_number_race.sql) — computing it here
  // via SELECT COUNT(*) raced under concurrent/double-submitted requests.
  const gstAmount = Math.round((input.gst_amount ?? 0) * 100) / 100;

  const { data: bill, error: billError } = await supabase
    .from("vendor_bills")
    .insert({
      company_id: input.company_id,
      po_id: input.po_id ?? null,
      vendor_id: input.vendor_id,
      invoice_number: input.invoice_number ?? null,
      invoice_date: input.invoice_date,
      due_date: input.due_date ?? null,
      total_amount: input.total_amount,
      gst_rate: 0,
      gst_amount: gstAmount,
      base_amount: input.total_amount,
      notes: input.notes ?? null,
      invoice_file_url: input.invoice_file_url ?? null,
      service_report_id: input.service_report_id ?? null,
      electricity_bill_id: input.electricity_bill_id ?? null,
      amount_paid: input.amount_paid ?? 0,
      payment_status: input.payment_status ?? "unpaid",
      approval_status: "pending",
      replaces_bill_id: input.replaces_bill_id ?? null,
      created_by: input.created_by,
    })
    .select("id, bill_number")
    .single();

  if (billError) throw new Error(billError.message);

  // Update PO status to invoice_received for goods POs
  if (input.po_id && input.invoice_file_url) {
    const { data: linkedPo } = await supabase
      .from("purchase_orders")
      .select("po_type")
      .eq("id", input.po_id)
      .single();
    if (linkedPo?.po_type !== "service") {
      await supabase
        .from("purchase_orders")
        .update({ status: "invoice_received" })
        .eq("id", input.po_id)
        .not("status", "eq", "cancelled");
    }
  }

  await logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: bill.id,
    action: "create",
    performedBy: input.created_by,
    changes: {
      bill_number: { old: null, new: bill.bill_number },
      vendor_id: { old: null, new: input.vendor_id },
      po_id: { old: null, new: input.po_id ?? null },
      total_amount: { old: null, new: input.total_amount },
      invoice_file_uploaded: { old: null, new: !!input.invoice_file_url },
      ...(input.electricity_bill_id
        ? { electricity_bill_id: { old: null, new: input.electricity_bill_id } }
        : {}),
    },
  });

  return { id: bill.id, bill_number: bill.bill_number };
}

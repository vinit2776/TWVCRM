import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { sendPushToAll } from "@/lib/push";
import { generateSignedApprovalCode } from "@/lib/procurement/approval-code";
import { z } from "zod";

const BANK_MODES = ["bank_transfer", "neft", "rtgs", "imps", "cheque"] as const;
const ALL_PAYMENT_MODES = [...BANK_MODES, "cash"] as const;

const patchBillSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("record_payment"),
    amount: z.number().positive("Payment amount must be greater than 0"),
    payment_mode: z.enum(ALL_PAYMENT_MODES),
    payment_reference: z.string().nullish(),
    payment_date: z.string().nullish(),
  }),
  z.object({
    action: z.literal("approve"),
  }),
  z.object({
    action: z.literal("reject"),
    rejection_reason: z.string().min(1, "Rejection reason is required"),
    rejection_outcome: z.enum(["return", "replacement"]).optional(),
  }),
]);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data, error } = await supabase
    .from("vendor_bills")
    .select(
      `*, procurement_vendors(id, name, contact_name, contact_phone),
       purchase_orders(id, po_number, status, po_type, advance_status, advance_amount, advance_payment_mode, advance_payment_reference, advance_payment_date),
       approver:users!vendor_bills_approved_by_fkey(id, full_name)`
    )
    .eq("id", id)
    .single();

  if (error || !data) return NextResponse.json({ error: "Bill not found" }, { status: 404 });

  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const canAct = ["admin", "manager", "office_admin", "accounts"].includes(dbUser.role);
  if (!canAct) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  // Approval actions require admin or manager
  const canApproveOrReject = ["admin", "manager"].includes(dbUser.role);

  const { data: bill, error: fetchError } = await supabase
    .from("vendor_bills")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });

  const body = await request.json();
  const parsed = patchBillSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  let updatePayload: Record<string, unknown> = {};

  switch (parsed.data.action) {
    case "record_payment": {
      // Role-based payment mode gate
      // - accounts: bank modes only (primary payment processor)
      // - admin: all modes (bank + cash, standby)
      // - office_admin: cash only (petty cash exception, procurement context)
      // - everyone else: no payment access
      const mode = parsed.data.payment_mode;
      const isBankMode = BANK_MODES.includes(mode as typeof BANK_MODES[number]);
      if (dbUser.role === "accounts" && !isBankMode) {
        return NextResponse.json({ error: "Accounts team can only record bank payments (NEFT, RTGS, IMPS, Bank Transfer, Cheque)" }, { status: 403 });
      }
      if (dbUser.role === "office_admin" && mode !== "cash") {
        return NextResponse.json({ error: "Petty cash payments only — bank payments must be processed by the Accounts team" }, { status: 403 });
      }
      if (dbUser.role === "manager") {
        return NextResponse.json({ error: "Payment recording is handled by the Accounts team (bank) or Office Admin (petty cash)" }, { status: 403 });
      }
      if (!["admin", "office_admin", "accounts"].includes(dbUser.role)) {
        return NextResponse.json({ error: "You do not have permission to record payments" }, { status: 403 });
      }

      // Gate: must be approved before payment
      if (bill.approval_status !== "approved") {
        return NextResponse.json(
          { error: "Invoice must be approved before recording a payment" },
          { status: 422 }
        );
      }

      if (bill.payment_status === "paid") {
        return NextResponse.json({ error: "This bill is already fully paid" }, { status: 422 });
      }

      const newAmountPaid = Number(bill.amount_paid) + parsed.data.amount;
      const paymentStatus =
        newAmountPaid >= Number(bill.total_amount)
          ? "paid"
          : newAmountPaid > 0
          ? "partially_paid"
          : "unpaid";

      const today = new Date().toISOString().split("T")[0];

      updatePayload = {
        amount_paid: newAmountPaid,
        payment_status: paymentStatus,
        payment_mode: parsed.data.payment_mode,
        payment_reference: parsed.data.payment_reference ?? null,
        payment_date: parsed.data.payment_date ?? today,
      };
      break;
    }

    case "approve": {
      if (!canApproveOrReject) {
        return NextResponse.json({ error: "Only admin or manager can approve bills" }, { status: 403 });
      }
      if (bill.approval_status !== "pending") {
        return NextResponse.json(
          { error: "Only pending bills can be approved" },
          { status: 422 }
        );
      }

      const { count: billApprovalCount } = await supabase
        .from("vendor_bills")
        .select("*", { count: "exact", head: true })
        .eq("approval_status", "approved");
      const billApprovalCode = generateSignedApprovalCode("bill", (billApprovalCount ?? 0) + 1, id);

      updatePayload = {
        approval_status: "approved",
        approved_by: dbUser.id,
        approved_at: new Date().toISOString(),
        approval_code: billApprovalCode,
        rejection_reason: null,
        rejection_outcome: null,
      };

      // For goods POs: advance status to invoice_approved
      if (bill.po_id) {
        const { data: linkedPo } = await supabase
          .from("purchase_orders")
          .select("po_type, status")
          .eq("id", bill.po_id)
          .single();
        if (linkedPo?.po_type !== "service" && linkedPo?.status === "invoice_received") {
          await supabase
            .from("purchase_orders")
            .update({ status: "invoice_approved" })
            .eq("id", bill.po_id);
        }
      }

      sendPushToAll({
        title: "Invoice Approved",
        body: `${bill.bill_number} approved by ${dbUser.full_name ?? "manager"}`,
        url: `/procurement/bills/${id}`,
        tag: `bill-approval-${id}`,
      }).catch((err) => console.error("[push] approve notification failed:", err));

      break;
    }

    case "reject": {
      if (!canApproveOrReject) {
        return NextResponse.json({ error: "Only admin or manager can reject bills" }, { status: 403 });
      }
      if (bill.approval_status !== "pending") {
        return NextResponse.json(
          { error: "Only pending bills can be rejected" },
          { status: 422 }
        );
      }

      // Determine PO type to decide outcome handling
      let poType: string | null = null;
      if (bill.po_id) {
        const { data: linkedPo } = await supabase
          .from("purchase_orders")
          .select("po_type, status")
          .eq("id", bill.po_id)
          .single();
        poType = linkedPo?.po_type ?? null;

        if (poType === "service") {
          // Service PO: void the bill (delete it so the cycle can accept a new invoice)
          await supabase.from("vendor_bills").delete().eq("id", id);

          await logAudit(supabase, {
            entityType: "vendor_bill",
            entityId: id,
            action: "delete",
            performedBy: dbUser.id,
            changes: {
              approval_status: { old: "pending", new: "rejected (voided)" },
              rejection_reason: { old: null, new: parsed.data.rejection_reason },
            },
          });

          sendPushToAll({
            title: "Service Invoice Rejected",
            body: `${bill.bill_number} voided — a new invoice can be uploaded for this cycle`,
            url: bill.po_id ? `/procurement/orders/${bill.po_id}` : `/procurement/bills`,
            tag: `bill-approval-${id}`,
          }).catch((err) => console.error("[push] service rejection notification failed:", err));

          return NextResponse.json({
            data: null,
            message: "Invoice rejected and voided. A new invoice can be uploaded for this service cycle.",
          });
        }

        // Goods PO: require rejection outcome
        if (!parsed.data.rejection_outcome) {
          return NextResponse.json(
            { error: "Rejection outcome is required for goods invoices (return or replacement)" },
            { status: 400 }
          );
        }

        // If return: cancel the PO
        if (parsed.data.rejection_outcome === "return") {
          await supabase
            .from("purchase_orders")
            .update({ status: "cancelled" })
            .eq("id", bill.po_id)
            .in("status", ["invoice_received"]);
        }
      }

      updatePayload = {
        approval_status: "rejected",
        approved_by: dbUser.id,
        approved_at: new Date().toISOString(),
        rejection_reason: parsed.data.rejection_reason,
        rejection_outcome: parsed.data.rejection_outcome ?? null,
      };

      const outcomeLabel = parsed.data.rejection_outcome === "return"
        ? "Goods to be returned"
        : parsed.data.rejection_outcome === "replacement"
        ? "Replacement requested"
        : "Invoice rejected";

      sendPushToAll({
        title: "Invoice Rejected",
        body: `${bill.bill_number} rejected — ${outcomeLabel}`,
        url: `/procurement/bills/${id}`,
        tag: `bill-approval-${id}`,
      }).catch((err) => console.error("[push] reject notification failed:", err));

      break;
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from("vendor_bills")
    .update(updatePayload)
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: diffChanges(bill as Record<string, unknown>, { ...bill, ...updatePayload } as Record<string, unknown>),
  });

  return NextResponse.json({ data: updated });
}

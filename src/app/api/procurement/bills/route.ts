import { invoiceCheckRecordSchema } from "@/lib/procurement/invoice-check";
import { chainLockedResponse } from "@/lib/procurement/chain-lock";
import { DEAD_BILL_STATUSES_FILTER } from "@/lib/constants";
import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { sendPushToProcurementRoles } from "@/lib/push";
import { z } from "zod";
import { queryEntityDef } from "@/lib/queries/registry";
import { canSeeQuery } from "@/lib/queries/audience";
import { summarizeBillsByMonth } from "@/lib/bills-monthly-summary";
import { applyBillFilters, resolveFreeTextIds } from "@/lib/bills-query";
import { createVendorBill, type ToleranceFacts } from "@/lib/vendor-bills";
import { clampTolerancePercent, evaluateInvoiceTolerance } from "@/lib/procurement/price-tolerance";
import { tryAutoApproveBill } from "@/lib/procurement/recurring-bill-rules-server";
import { tryAutoApproveAmcBill } from "@/lib/procurement/amc-bill-auto-approve";
import { decideElectricityContext, type ElectricityBillExtra, type RememberName } from "@/lib/electricity-bill-match";
import { findDuplicateVendorBill, loadElectricityFacts, rememberConnectionName } from "@/lib/electricity-bill-context-server";
import { checkJoin } from "@/lib/procurement/shared-invoice";
import {
  applySharePlan,
  cannotJoinReason,
  distinctPoValues,
  findSameInvoiceBills,
  type SharePlan,
} from "@/lib/procurement/shared-invoice-server";

// Any 8-4-4-4-12 hex id, which is what Postgres accepts. Zod's strict .uuid() also demands an RFC version
// nibble, which would reject perfectly valid database ids (e.g. a hand-seeded location).
const idShaped = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid id");

const createBillSchema = z.object({
  po_id: z.string().uuid().nullish(),
  // Required when there's no po_id — a bill can be created standalone (just
  // vendor_id + invoice_date + total_amount), so company can't always be
  // inherited via po_id -> purchase_orders.company_id. When po_id IS present,
  // this is cross-checked against the PO's own company_id below.
  company_id: z.string().uuid().nullish(),
  vendor_id: z.string().uuid(),
  invoice_number: z.string().nullish(),
  invoice_date: z.string().min(1, "Invoice date is required"),
  due_date: z.string().nullish(),
  total_amount: z.number().positive("Total amount must be greater than 0"),
  gst_amount: z.number().min(0).default(0),
  notes: z.string().nullish(),
  invoice_file_url: z.string().url().nullish(),
  invoice_check: invoiceCheckRecordSchema.nullish(),
  service_report_id: z.string().uuid().nullish(),
  replaces_bill_id: z.string().uuid().nullish(),
  // Lets the uploader opt a specific AMC cycle back into manual review (e.g.
  // an amount or date that looks off) even though later cycles on an
  // approved AMC contract would otherwise auto-approve.
  amc_manual_review_requested: z.boolean().default(false),
  // Electricity-provider vendors only (ignored for every other vendor). The location is chosen by the
  // person recording the bill; the consumer number and printed name only help identify the connection.
  location_id: idShaped.nullish(),
  connection_id: idShaped.nullish(),
  consumer_number: z.string().max(60).nullish(),
  printed_name: z.string().max(120).nullish(),
  // The bill prints an identifier that belongs to a different location than the one chosen, and the person confirmed.
  acknowledge_mismatch: z.boolean().default(false),
  // Required when the invoice falls outside the PO's price tolerance.
  tolerance_exception_reason: z.string().trim().max(500).optional().nullable(),
  // One vendor invoice covering several POs: total_amount is then this PO's share, and
  // invoice_total is what the vendor's invoice adds up to.
  invoice_total: z.number().positive().nullish(),
  // The person confirmed this is the same invoice as bills already recorded under the number.
  join_existing_invoice: z.boolean().default(false),
  // Teach the connection this wording so the next bill carrying it is recognised by itself.
  remember_name: z.boolean().default(false),
}).refine(
  (d) => (d.gst_amount ?? 0) <= Math.round(d.total_amount * 0.28 * 100) / 100,
  {
    message: "GST amount exceeds the maximum allowed (28% of invoice base). Please verify the invoice.",
    path: ["gst_amount"],
  },
).refine(
  (d) => {
    const today = new Date().toISOString().split("T")[0];
    return d.invoice_date >= today;
  },
  {
    message: "Invoice date cannot be in the past. Only today or a future date is allowed.",
    path: ["invoice_date"],
  },
).refine(
  (d) => !!d.po_id || !!d.company_id,
  { message: "Select which company this bill is for", path: ["company_id"] }
);


export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;
  const includeTotals = searchParams.get("include_totals") === "true";
  const includeMonthly = searchParams.get("include_monthly") === "true";

  // Resolve free-text → vendor + PO ids first so both queries share the result
  const { vendorIds, poIds } = await resolveFreeTextIds(supabase, searchParams.get("q"));

  let query = supabase
    .from("vendor_bills")
    .select(
      `*, procurement_vendors(id, name, contact_email, gstin),
       purchase_orders(id, po_number, po_type, expected_delivery_date, purchase_requests(department, expenditure_type)),
       companies(id, name, brand_name),
       approver:users!vendor_bills_approved_by_fkey(id, full_name),
       vendor_bill_payments(id, payment_reference, reversed_at)`,
      { count: "exact" }
    )
    // Scoped to one vendor the page groups rows by invoice month, so rows
    // must arrive in invoice-date order or a month would be split across the list.
    .order(searchParams.get("vendor_id") ? "invoice_date" : "created_at", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = applyBillFilters(query as any, searchParams, { vendorIdsFromQ: vendorIds, poIdsFromQ: poIds }) as typeof query;

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Aggregate totals over the filtered result set
  let totals = null;
  if (includeTotals) {
    let totalsQuery = supabase
      .from("vendor_bills")
      .select("total_amount, amount_paid, due_date, payment_status")
      .neq("approval_status", "withdrawn");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    totalsQuery = applyBillFilters(totalsQuery as any, searchParams, { vendorIdsFromQ: vendorIds, poIdsFromQ: poIds }) as typeof totalsQuery;

    const { data: allBills } = await totalsQuery;
    const todayStr = new Date().toISOString().split("T")[0];
    totals = {
      totalPayable: allBills?.reduce((s, b) => s + Number(b.total_amount), 0) ?? 0,
      totalPaid: allBills?.reduce((s, b) => s + Number(b.amount_paid), 0) ?? 0,
      overdueCount: allBills?.filter(
        (b) => b.due_date && b.due_date < todayStr && b.payment_status !== "paid"
      ).length ?? 0,
    };
  }

  // Month-by-month rollup over the whole filtered set (not just this page).
  let monthly = null;
  if (includeMonthly) {
    let monthlyQuery = supabase
      .from("vendor_bills")
      .select("id, invoice_date, total_amount, payment_status, approval_status")
      .range(0, 4999);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    monthlyQuery = applyBillFilters(monthlyQuery as any, searchParams, { vendorIdsFromQ: vendorIds, poIdsFromQ: poIds }) as typeof monthlyQuery;
    const { data: monthlyBills, error: monthlyError } = await monthlyQuery;
    if (monthlyError) return NextResponse.json({ error: monthlyError.message }, { status: 500 });

    // Open queries raised on these bills, limited to the ones this viewer may
    // read (visibility follows the entity — see canSeeQuery).
    const openQueriesByBill = new Map<string, number>();
    const def = queryEntityDef("vendor_bill");
    if (def && monthlyBills?.length) {
      const billIds = new Set(monthlyBills.map((b) => b.id));
      const { data: openQueries, error: queriesError } = await createAdminClient()
        .from("queries")
        .select("entity_id, created_by")
        .eq("entity_type", "vendor_bill")
        .eq("status", "open");
      if (queriesError) return NextResponse.json({ error: queriesError.message }, { status: 500 });
      for (const q of openQueries ?? []) {
        if (!billIds.has(q.entity_id)) continue;
        if (!canSeeQuery(def, { id: dbUser.id, role: dbUser.role }, q.created_by)) continue;
        openQueriesByBill.set(q.entity_id, (openQueriesByBill.get(q.entity_id) ?? 0) + 1);
      }
    }
    monthly = {
      ...summarizeBillsByMonth(monthlyBills ?? [], openQueriesByBill),
      openQueriesByBill: Object.fromEntries(openQueriesByBill),
    };
  }

  return NextResponse.json({
    data,
    pagination: {
      page,
      limit,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
    totals,
    monthly,
  });
}


export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createBillSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  // A new bill can't be added to a closed cycle — an admin must reopen it first.
  if (parsed.data.po_id) {
    const lockedChain = await chainLockedResponse(supabase, { poId: parsed.data.po_id });
    if (lockedChain) return lockedChain;
  }

  // ── PO validation ──────────────────────────────────────────────────────────
  let poTotalAmount: number | null = null;
  let poAdvanceCredit = 0;
  let toleranceFacts: ToleranceFacts | null = null;
  // Price tolerance (goods POs only): how far past the PO value / received value
  // the invoice may go before it needs a special approval. 0 = firm price.
  let tolerancePercent = 0;
  let allGoodsReceived = true;
  let priorInvoiced = 0;
  let toleranceBase: number | null = null;
  // Company: inherited from the PO when one is linked (cross-checked against
  // any company_id the client also sent), otherwise taken directly from the
  // request — enforced by the schema refine() above.
  let billCompanyId = parsed.data.company_id ?? null;
  // For the shared-invoice checks further down (poTotalAmount may be lowered to the received value).
  let linkedPoType: string | null = null;
  let linkedPoValue: number | null = null;
  if (parsed.data.po_id) {
    const { data: po } = await supabase
      .from("purchase_orders")
      .select("id, company_id, po_type, total_ordered_amount, status, unit_cost_per_cycle, cycle_count, advance_status, advance_amount, tolerance_percent")
      .eq("id", parsed.data.po_id)
      .single();

    if (!po) {
      return NextResponse.json({ error: "Linked purchase order not found" }, { status: 404 });
    }
    if (["cancelled"].includes(po.status)) {
      return NextResponse.json({ error: "Cannot create an invoice for a cancelled purchase order" }, { status: 422 });
    }
    if (parsed.data.company_id && parsed.data.company_id !== po.company_id) {
      return NextResponse.json({ error: "Company does not match the linked purchase order" }, { status: 422 });
    }
    billCompanyId = po.company_id;
    linkedPoType = po.po_type;
    linkedPoValue = Number(po.total_ordered_amount);

    poTotalAmount = Number(po.total_ordered_amount);
    if (po.po_type !== "service") tolerancePercent = clampTolerancePercent(po.tolerance_percent);

    // Invoice file is mandatory when linked to a PO
    if (!parsed.data.invoice_file_url) {
      return NextResponse.json({ error: "Invoice file upload is required when linking to a purchase order" }, { status: 422 });
    }

    if (po.po_type === "service") {
      // ── Service PO: must have a service_report_id ─────────────────────────
      if (!parsed.data.service_report_id) {
        return NextResponse.json({ error: "A service report must be selected before uploading an invoice" }, { status: 422 });
      }
      // Validate service report belongs to this PO
      const { data: sr } = await supabase
        .from("po_service_reports")
        .select("id")
        .eq("id", parsed.data.service_report_id)
        .eq("po_id", parsed.data.po_id)
        .single();
      if (!sr) {
        return NextResponse.json({ error: "Service report not found for this purchase order" }, { status: 404 });
      }
      // Ensure no existing bill is linked to this service report
      const { count: existingBillCount } = await supabase
        .from("vendor_bills")
        .select("*", { count: "exact", head: true })
        .eq("service_report_id", parsed.data.service_report_id)
        .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER);
      if (existingBillCount && existingBillCount > 0) {
        return NextResponse.json({ error: "An invoice has already been uploaded for this service report cycle" }, { status: 422 });
      }

      // A contract is only worth cycle_count x unit_cost_per_cycle in total, so it
      // cannot carry more invoices than it has cycles. Without this, a 12-month AMC
      // accepts a 13th monthly invoice — each one individually under the per-cycle
      // ceiling, but together exceeding the PO. Cancelled bills free their cycle back up.
      const cycleCap = Number(po.cycle_count ?? 0);
      if (cycleCap > 0) {
        const { count: liveBillCount } = await supabase
          .from("vendor_bills")
          .select("*", { count: "exact", head: true })
          .eq("po_id", parsed.data.po_id)
          .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER);
        if ((liveBillCount ?? 0) >= cycleCap) {
          return NextResponse.json({
            error: `All ${cycleCap} billing cycle${cycleCap > 1 ? "s" : ""} on this purchase order have already been invoiced. Raise a new PO to bill beyond the contract term.`,
          }, { status: 422 });
        }
      }
    } else {
      // ── Goods PO: must have a delivery receipt ────────────────────────────
      const { data: deliveryReceipts } = await supabase
        .from("po_delivery_receipts")
        .select("po_delivery_receipt_items(po_item_id, qty_received)")
        .eq("po_id", parsed.data.po_id)
        .is("reversed_at", null);
      if (!deliveryReceipts || deliveryReceipts.length === 0) {
        return NextResponse.json({ error: "A delivery must be recorded before uploading a vendor invoice" }, { status: 422 });
      }

      // Calculate proportionate received value for shortfall detection
      const { data: poItems } = await supabase
        .from("purchase_order_items")
        .select("id, unit_price")
        .eq("po_id", parsed.data.po_id);

      const priceMap: Record<string, number> = {};
      for (const item of poItems ?? []) {
        priceMap[item.id] = Number(item.unit_price ?? 0);
      }

      let receivedValue = 0;
      for (const receipt of deliveryReceipts) {
        for (const ri of receipt.po_delivery_receipt_items ?? []) {
          receivedValue += (priceMap[ri.po_item_id] ?? 0) * Number(ri.qty_received);
        }
      }

      // If there is a shortfall, cap invoice at the received value (not the full PO value)
      if (receivedValue < (poTotalAmount ?? 0)) {
        allGoodsReceived = false;
        if (tolerancePercent === 0 && parsed.data.total_amount > receivedValue) {
          return NextResponse.json({
            error: `Invoice amount (₹${parsed.data.total_amount.toLocaleString("en-IN")}) exceeds the proportionate value of goods received (₹${receivedValue.toLocaleString("en-IN")}). Only goods worth ₹${receivedValue.toLocaleString("en-IN")} have been received against the PO value of ₹${(poTotalAmount ?? 0).toLocaleString("en-IN")}.`,
          }, { status: 422 });
        }
        // Override poTotalAmount so the generic ceiling check below does not fire on the full PO value
        poTotalAmount = receivedValue;
      }
    }

    // Amount must not exceed ceiling (per cycle for service POs, full PO value for goods)
    const ceiling = po.po_type === "service" && po.unit_cost_per_cycle
      ? Number(po.unit_cost_per_cycle)
      : poTotalAmount;
    if (tolerancePercent === 0 && ceiling !== null && ceiling > 0 && parsed.data.total_amount > ceiling) {
      return NextResponse.json({
        error: `Invoice amount (₹${parsed.data.total_amount.toLocaleString("en-IN")}) cannot exceed the ${po.po_type === "service" ? "cycle cost" : "PO value"} (₹${ceiling.toLocaleString("en-IN")})`,
      }, { status: 422 });
    }

    // Goods POs: the per-bill ceiling above stops one oversized invoice, but not
    // several that together exceed the PO — which is how a duplicate upload slips
    // through. Rejected bills free their value back up, and so does the bill this
    // one replaces.
    if (po.po_type !== "service" && ceiling !== null && ceiling > 0) {
      const { data: liveBills } = await supabase
        .from("vendor_bills")
        .select("id, total_amount, bill_number")
        .eq("po_id", parsed.data.po_id)
        .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER);
      const invoiced = (liveBills ?? [])
        .filter((b) => b.id !== parsed.data.replaces_bill_id)
        .reduce((sum, b) => sum + Number(b.total_amount), 0);
      priorInvoiced = invoiced;
      toleranceBase = ceiling;
      if (tolerancePercent === 0 && invoiced + parsed.data.total_amount > ceiling + 0.01) {
        const remaining = Math.max(0, ceiling - invoiced);
        return NextResponse.json({
          error: `This PO already has ₹${invoiced.toLocaleString("en-IN")} invoiced of ₹${ceiling.toLocaleString("en-IN")} (${(liveBills ?? []).map((b) => b.bill_number).join(", ")}). Only ₹${remaining.toLocaleString("en-IN")} is left to invoice — if this is a corrected invoice, edit the rejected one instead.`,
        }, { status: 422 });
      }
    }

    // A flexible PO lets the invoice drift past the PO value; outside the band it is
    // flagged (not blocked) and needs a reason now and an admin acknowledgement at approval.
    if (tolerancePercent > 0 && toleranceBase !== null) {
      const outcome = evaluateInvoiceTolerance({
        invoiceTotal: parsed.data.total_amount,
        base: toleranceBase,
        tolerancePercent,
        priorInvoiced,
        fullyReceived: allGoodsReceived,
      });
      if (outcome.kind !== "ok") {
        toleranceFacts = {
          variance_amount: outcome.varianceAmount,
          variance_percent: outcome.variancePercent,
          out_of_tolerance: outcome.kind === "exception",
          tolerance_exception_reason: null,
        };
        if (outcome.kind === "exception") {
          const reason = parsed.data.tolerance_exception_reason?.trim();
          if (!reason) {
            const range = `₹${(toleranceBase * (1 - tolerancePercent / 100)).toLocaleString("en-IN")} – ₹${(toleranceBase * (1 + tolerancePercent / 100)).toLocaleString("en-IN")}`;
            return NextResponse.json({
              error: `Invoiced total on this PO would be ${Math.abs(outcome.variancePercent)}% ${outcome.direction === "above" ? "above" : "below"} the PO value, outside the ±${tolerancePercent}% allowance (${range}). Add a reason so an admin can review it.`,
              code: "TOLERANCE_REASON_REQUIRED",
            }, { status: 422 });
          }
          toleranceFacts.tolerance_exception_reason = reason;
        }
      }
    }

    // Pre-credit advance if already processed
    if (po.advance_status === "processed" && po.advance_amount) {
      poAdvanceCredit = Math.min(Number(po.advance_amount), parsed.data.total_amount);
    }
  }

  // ── Duplicate invoices — and one invoice shared across several POs ───────
  // Same vendor + company + invoice number on any live bill is a duplicate, unless the person
  // confirms it is one vendor invoice covering several goods POs: then this bill is the next
  // PO's share of it. Rejected/withdrawn bills are ignored so a re-submission is allowed.
  const invoiceNo = parsed.data.invoice_number?.trim() ?? "";
  const shareAdmin = createAdminClient();
  let sharePlan: SharePlan | null = null;
  let existingForShare: Awaited<ReturnType<typeof findSameInvoiceBills>> = [];
  if (invoiceNo) {
    try {
      existingForShare = await findSameInvoiceBills(shareAdmin, {
        vendorId: parsed.data.vendor_id,
        companyId: billCompanyId!,
        invoiceNumber: invoiceNo,
        excludeBillId: parsed.data.replaces_bill_id,
      });
    } catch (err) {
      console.error("[bills] same-invoice lookup failed:", err instanceof Error ? err.message : "unknown error");
      return NextResponse.json({ error: "Could not check this invoice number" }, { status: 500 });
    }
    const share = parsed.data.total_amount;
    const askedTotal = parsed.data.invoice_total ?? null;
    const next = { poId: parsed.data.po_id ?? null, poType: linkedPoType };

    if (existingForShare.length === 0) {
      // First PO on an invoice that is bigger than this PO's share.
      if (askedTotal !== null && askedTotal > share + 0.01) {
        const why = cannotJoinReason([], next);
        if (why) return NextResponse.json({ error: why }, { status: 422 });
        sharePlan = { kind: "open", invoiceTotal: askedTotal };
      }
    } else {
      const why = cannotJoinReason(existingForShare, next);
      if (!parsed.data.join_existing_invoice || why) {
        return NextResponse.json(
          {
            error: why ?? `Invoice number "${invoiceNo}" already exists for this vendor. Check Vendor Payments to avoid duplicate processing.`,
            code: why ? "DUPLICATE_INVOICE" : "INVOICE_NUMBER_EXISTS",
          },
          { status: 409 }
        );
      }

      const groupIds = [...new Set(existingForShare.map((b) => b.invoice_group_id).filter((g): g is string => !!g))];
      if (groupIds.length > 1) {
        return NextResponse.json({ error: "These bills belong to different shared invoices. Ask an admin to look at it." }, { status: 409 });
      }
      let currentTotal = existingForShare.reduce((s, b) => s + b.total_amount, 0);
      if (groupIds[0]) {
        const { data: group } = await shareAdmin.from("vendor_invoice_groups").select("invoice_total").eq("id", groupIds[0]).single();
        if (group) currentTotal = Number(group.invoice_total);
      }
      const newTotal = askedTotal ?? currentTotal;
      const check = checkJoin({
        currentTotal,
        newTotal,
        otherShares: existingForShare.map((b) => b.total_amount),
        share,
        poValues: distinctPoValues([...existingForShare, { po_id: next.poId, po_value: linkedPoValue }]),
      });
      if (!check.ok) return NextResponse.json({ error: check.message, code: check.code }, { status: 422 });
      sharePlan = {
        kind: "join",
        groupId: groupIds[0] ?? null,
        invoiceTotal: newTotal,
        currentTotal,
        attachBillIds: existingForShare.filter((b) => !b.invoice_group_id).map((b) => b.id),
      };
    }
  }

  // ── Electricity-provider vendors: tie a standalone bill to a location ─────
  // For any other vendor (or a PO-linked bill) this changes nothing and stores nothing extra.
  let electricityExtra: ElectricityBillExtra | null = null;
  let rememberName: RememberName = null;
  {
    const admin = createAdminClient();
    let decision;
    try {
      const facts = await loadElectricityFacts(admin, {
        vendorId: parsed.data.vendor_id,
        hasPo: !!parsed.data.po_id,
        billCompanyId,
        locationId: parsed.data.location_id ?? null,
      });
      decision = decideElectricityContext(
        {
          location_id: parsed.data.location_id ?? null,
          connection_id: parsed.data.connection_id ?? null,
          consumer_number: parsed.data.consumer_number ?? null,
          printed_name: parsed.data.printed_name ?? null,
          acknowledge_mismatch: parsed.data.acknowledge_mismatch,
          remember_name: parsed.data.remember_name,
        },
        facts
      );
      if (decision.ok && decision.extra) {
        // The exact-match guard above is case-sensitive; electricity bills are re-keyed from paper in
        // varying punctuation, so also catch "EB/09/2026/00418" vs "eb-09-2026-00418".
        const dup = await findDuplicateVendorBill(admin, parsed.data.vendor_id, parsed.data.invoice_number);
        if (dup) {
          return NextResponse.json(
            { error: `A bill with number "${dup.invoice_number}" already exists for this vendor (${dup.bill_number}, ${dup.approval_status}). Open it instead of recording it again.` },
            { status: 409 }
          );
        }
      }
    } catch (err) {
      console.error("[bills] electricity context failed:", err instanceof Error ? err.message : "unknown error");
      return NextResponse.json({ error: "Could not check the electricity details for this bill" }, { status: 500 });
    }
    if (!decision.ok) return NextResponse.json({ error: decision.error, code: decision.code }, { status: decision.status });
    electricityExtra = decision.extra;
    rememberName = decision.rememberName;
  }

  // ── Create the bill (number generation, insert, PO status update, audit) ───
  const initialPaymentStatus =
    poAdvanceCredit >= parsed.data.total_amount ? "paid" :
    poAdvanceCredit > 0 ? "partially_paid" :
    "unpaid";

  let invoiceGroupId: string | null = null;
  if (sharePlan) {
    try {
      invoiceGroupId = await applySharePlan(shareAdmin, sharePlan, {
        companyId: billCompanyId!,
        vendorId: parsed.data.vendor_id,
        invoiceNumber: invoiceNo,
        userId: dbUser.id,
        existingBillIds: existingForShare.map((b) => b.id),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not set up the shared invoice";
      return NextResponse.json({ error: msg }, { status: msg.startsWith("Someone just") ? 409 : 500 });
    }
  }

  let bill: { id: string; bill_number: string };
  try {
    bill = await createVendorBill(supabase, {
      invoice_group_id: invoiceGroupId,
      company_id: billCompanyId!,
      po_id: parsed.data.po_id ?? null,
      vendor_id: parsed.data.vendor_id,
      invoice_number: parsed.data.invoice_number ?? null,
      invoice_date: parsed.data.invoice_date,
      due_date: parsed.data.due_date ?? null,
      total_amount: parsed.data.total_amount,
      gst_amount: parsed.data.gst_amount ?? 0,
      notes: parsed.data.notes ?? null,
      invoice_file_url: parsed.data.invoice_file_url ?? null,
      invoice_check: parsed.data.invoice_check ?? null,
      service_report_id: parsed.data.service_report_id ?? null,
      replaces_bill_id: parsed.data.replaces_bill_id ?? null,
      amount_paid: poAdvanceCredit,
      payment_status: initialPaymentStatus,
      created_by: dbUser.id,
      ...(toleranceFacts ?? {}),
      ...(electricityExtra ?? {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create bill";
    // Two people adding to the same invoice at once: the database lets one through and stops the other.
    if (msg.includes("SHARED_INVOICE_OVER_ALLOCATED")) {
      return NextResponse.json(
        { error: "Someone else just added a bill to this invoice and there is no longer enough left for this share. Reload and check the balance." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // If this vendor has an active recurring bill rule, see if it clears the
  // guardrails to skip manual approval entirely.
  // An out-of-tolerance bill always waits for a human; no rule may wave it through.
  // A bill on a shared invoice does too: the approval gate looks at the whole invoice.
  const needsHumanReview = !!toleranceFacts?.out_of_tolerance || !!invoiceGroupId;
  let autoApproval: { autoApproved: boolean; note?: string } = { autoApproved: false };
  if (!needsHumanReview) autoApproval = await tryAutoApproveBill(supabase, bill.id, parsed.data.vendor_id);
  let autoApprovalSource: "recurring_rule" | "amc_cycle" | null = autoApproval.autoApproved ? "recurring_rule" : null;

  // Otherwise, for a service PO that's an AMC contract, a later cycle's
  // invoice can skip approval once the contract's first invoice has already
  // been through one manual approval — see tryAutoApproveAmcBill for why.
  if (!autoApproval.autoApproved && parsed.data.po_id && !needsHumanReview) {
    autoApproval = await tryAutoApproveAmcBill(
      supabase, bill.id, parsed.data.po_id, parsed.data.amc_manual_review_requested
    );
    if (autoApproval.autoApproved) autoApprovalSource = "amc_cycle";
  }

  if (autoApproval.autoApproved) {
    sendPushToProcurementRoles({
      title: "Invoice Auto-Approved",
      body: autoApprovalSource === "amc_cycle"
        ? `${bill.bill_number} — ₹${parsed.data.total_amount.toLocaleString("en-IN")} auto-approved (AMC contract already approved)`
        : `${bill.bill_number} — ₹${parsed.data.total_amount.toLocaleString("en-IN")} auto-approved under a recurring bill rule`,
      url: `/procurement/bills/${bill.id}`,
      tag: `bill-approval-${bill.id}`,
    }).catch((err) => console.error("[push] auto-approve notification failed:", err));
  } else {
    sendPushToProcurementRoles({
      title: "Invoice Pending Payment Approval",
      body: `${bill.bill_number} — ₹${parsed.data.total_amount.toLocaleString("en-IN")} requires payment approval`,
      url: `/procurement/bills/${bill.id}`,
      tag: `bill-approval-${bill.id}`,
    }).catch((err) => console.error("[push] new bill notification failed:", err));
  }

  // Teach the connection the wording on this bill, if asked. Best-effort: it never undoes the bill.
  const warnings: string[] = [];
  if (sharePlan) {
    const allocated = existingForShare.reduce((s, b) => s + b.total_amount, 0) + parsed.data.total_amount;
    const unallocated = Math.round((sharePlan.invoiceTotal - allocated) * 100) / 100;
    if (unallocated > 0.01) {
      warnings.push(`₹${unallocated.toLocaleString("en-IN")} of this invoice is not on any PO yet. Add the other PO by uploading the same invoice number.`);
    }
  }
  if (rememberName) {
    const r = await rememberConnectionName(createAdminClient(), {
      connectionId: rememberName.connection_id,
      name: rememberName.name,
      userId: dbUser.id,
      billId: bill.id,
    });
    if (r.warning) warnings.push(r.warning);
  }

  return NextResponse.json({
    data: {
      id: bill.id,
      bill_number: bill.bill_number,
      auto_approved: autoApproval.autoApproved,
      ...(electricityExtra ? { location_id: electricityExtra.location_id, connection_id: electricityExtra.connection_id } : {}),
    },
    ...(warnings.length ? { warnings } : {}),
  }, { status: 201 });
}

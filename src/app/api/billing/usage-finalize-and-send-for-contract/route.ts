import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { generateUsageStatements } from "@/lib/billing";
import { dispatchProforma, dispatchGstDirect } from "@/lib/send-proforma";
import { handleStatementFinalized } from "@/lib/tally-handoff-server";
import { logAudit } from "@/lib/audit";
import { calcGst } from "@/lib/tax";

/**
 * POST /api/billing/usage-finalize-and-send-for-contract
 *
 * Per-contract atomic "Verify & Send" for the Usage tab. The operator
 * reviewed the line items in the expanded row and clicks Verify & Send —
 * one call does the lot:
 *
 *   1. If no draft usage statement exists for (contract, month):
 *        runs generateUsageStatements({contractId, month, year}) which
 *        gathers all pending usage_charges + service_usage_records into a
 *        single draft statement.
 *   2. If a draft already exists (e.g. created by batch Generate Drafts
 *      earlier) and isn't yet sent: continues with it.
 *   3. Flips status → finalized, stamps finalized_at + due_date (= today + 7d).
 *   4. Dispatches the proforma (Razorpay link + PDF + email + WhatsApp).
 *
 * Failure handling: if dispatch fails, status rolls back to draft so the
 * operator can fix the underlying issue (e.g. missing customer email) and
 * retry without the statement being stuck in finalized-but-unsent limbo.
 *
 * Body: { contract_id, year, month, additional_cc?: string[] }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin / Manager / Accounts access required" }, { status: 403 });
  }

  interface OverrideItem { source: string; item_id: string; amount: number; reason: string }
  interface CarryForward { usage_charge_ids?: string[]; service_record_ids?: string[] }
  const body = await request.json().catch(() => ({})) as {
    contract_id?: string; year?: number; month?: number; additional_cc?: string[];
    overrides?: OverrideItem[];
    carry_forward?: CarryForward;
  };
  const contractId = body.contract_id;
  const year  = Number(body.year);
  const month = Number(body.month);
  if (!contractId) return NextResponse.json({ error: "contract_id is required" }, { status: 400 });
  if (!year || !month || month < 1 || month > 12) {
    return NextResponse.json({ error: "year + month (1-12) are required" }, { status: 400 });
  }
  const additionalCc = Array.isArray(body.additional_cc) ? body.additional_cc.filter(Boolean) : [];
  const overrides: OverrideItem[] = Array.isArray(body.overrides) ? body.overrides : [];
  const cfChargeIds: string[]  = Array.isArray(body.carry_forward?.usage_charge_ids)  ? body.carry_forward!.usage_charge_ids!  : [];
  const cfServiceIds: string[] = Array.isArray(body.carry_forward?.service_record_ids) ? body.carry_forward!.service_record_ids! : [];

  const admin = createAdminClient();

  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  // ── 1. Find or create the usage draft for this (contract, month) ───────
  let { data: existing } = await admin
    .from("billing_statements")
    .select("id, status, voided_at, total_amount")
    .eq("contract_id", contractId)
    .eq("statement_type", "usage")
    .gte("period_start", monthStart)
    .lte("period_start", monthEnd)
    .is("voided_at", null)
    .maybeSingle();

  if (existing && existing.status !== "draft") {
    return NextResponse.json({ error: `Usage statement already ${existing.status} for this month` }, { status: 400 });
  }

  if (!existing) {
    // No draft yet — generate one for just this contract.
    const result = await generateUsageStatements(admin, { contractId, month, year });
    if (result.errors.length > 0) {
      return NextResponse.json({ error: `Could not generate usage draft: ${result.errors.join("; ")}` }, { status: 500 });
    }
    if (result.statementIds.length === 0) {
      return NextResponse.json({ error: "No usage charges found for this contract in the selected month — nothing to bill" }, { status: 400 });
    }
    const newStmtId = result.statementIds[0];
    const { data: created } = await admin
      .from("billing_statements")
      .select("id, status, voided_at, total_amount")
      .eq("id", newStmtId)
      .single();
    existing = created;
  }
  if (!existing) return NextResponse.json({ error: "Failed to obtain a draft statement" }, { status: 500 });

  // ── 2. Apply overrides (waive / adjust line items) ─────────────────────
  if (overrides.length > 0) {
    const { data: stmtFull } = await admin
      .from("billing_statements")
      .select("line_items, tax_percentage, is_interstate")
      .eq("id", existing.id)
      .single();

    if (stmtFull?.line_items) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sections: any[] = JSON.parse(JSON.stringify(stmtFull.line_items));

      for (const ov of overrides) {
        for (const section of sections) {
          if (!Array.isArray(section.items)) continue;
          for (const item of section.items) {
            const matched =
              (ov.source === "ad_hoc"  && item.usage_charge_id === ov.item_id) ||
              (ov.source === "service" && item.service_id       === ov.item_id);
            if (matched) {
              item.original_amount = item.amount;
              item.amount          = ov.amount;
              item.waived          = ov.amount === 0;
              item.override_reason = ov.reason;
            }
          }
          // Recalculate section subtotal
          section.subtotal = section.items.reduce((s: number, i: { amount: number }) => s + (i.amount || 0), 0);
        }
      }

      // Recalculate statement-level totals
      const newSubtotal = sections.reduce((s: number, sec: { subtotal: number }) => s + (sec.subtotal || 0), 0);
      const taxRate     = Number(stmtFull.tax_percentage || 0);
      // Always intra-state Tamil Nadu — use calcGst (CGST+SGST only, IGST=0)
      const gst         = calcGst(newSubtotal, taxRate);
      const { cgst, sgst, igst, grandTotal: newTotal } = gst;
      const newTax      = gst.taxAmount;

      const usageSec   = sections.find((s: { type: string }) => s.type === "ad_hoc_charges"  || s.type === "facility_usage");
      const serviceSec = sections.find((s: { type: string }) => s.type === "service_usage");
      const bookingSec = sections.find((s: { type: string }) => s.type === "booking_usage");

      await admin.from("billing_statements").update({
        line_items:           sections,
        subtotal:             newSubtotal,
        tax_amount:           newTax,
        cgst_amount:          cgst,
        sgst_amount:          sgst,
        igst_amount:          igst,
        total_amount:         newTotal,
        usage_amount:         (usageSec?.subtotal   ?? 0),
        service_usage_amount: (serviceSec?.subtotal ?? 0),
        booking_usage_amount: (bookingSec?.subtotal ?? 0),
      }).eq("id", existing.id);

      // Mark waived usage_charges in DB for audit trail
      const waivedAdHocIds = overrides
        .filter((o) => o.source === "ad_hoc" && o.amount === 0)
        .map((o) => o.item_id);
      if (waivedAdHocIds.length > 0) {
        const nowIsoWaive = new Date().toISOString();
        await admin.from("usage_charges").update({
          status: "waived",
          waive_reason: overrides.find((o) => waivedAdHocIds.includes(o.item_id))?.reason ?? "Waived at PI dispatch",
          waived_at: nowIsoWaive,
          waived_by: dbUser.id,
        }).in("id", waivedAdHocIds);
      }

      // Refresh total_amount for the zero-amount guard below
      existing = { ...existing, total_amount: newTotal };
    }
  }

  // ── 2b. Attach carry-forward items to the draft statement ─────────────
  // These are items from previous months the operator chose to include.
  // We link them to the statement and fold their amounts into the totals.
  if ((cfChargeIds.length > 0 || cfServiceIds.length > 0) && existing) {
    const stmtId = existing.id;

    // Fetch current statement line_items + totals
    const { data: stmtForCf } = await admin
      .from("billing_statements")
      .select("line_items, subtotal, tax_percentage, tax_amount, total_amount, cgst_amount, sgst_amount, igst_amount, usage_amount, service_usage_amount")
      .eq("id", stmtId)
      .single();

    if (stmtForCf) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sections: any[] = JSON.parse(JSON.stringify(stmtForCf.line_items || []));

      let cfAdHocTotal = 0;
      let cfServiceTotal = 0;

      // Fetch and add carry-forward usage_charges
      if (cfChargeIds.length > 0) {
        const { data: cfCharges } = await admin
          .from("usage_charges")
          .select("id, description, total")
          .in("id", cfChargeIds)
          .eq("contract_id", contractId)
          .is("billing_statement_id", null);

        if (cfCharges && cfCharges.length > 0) {
          let adHocSec = sections.find((s: { type: string }) => s.type === "ad_hoc_charges");
          if (!adHocSec) {
            adHocSec = { type: "ad_hoc_charges", label: "Ad-hoc Charges", items: [], subtotal: 0 };
            sections.push(adHocSec);
          }
          for (const c of cfCharges) {
            const amt = Number(c.total || 0);
            adHocSec.items.push({ usage_charge_id: c.id, description: c.description, amount: amt });
            adHocSec.subtotal = (adHocSec.subtotal || 0) + amt;
            cfAdHocTotal += amt;
          }
          await admin.from("usage_charges").update({ billing_statement_id: stmtId, status: "billed" }).in("id", cfChargeIds);
        }
      }

      // Fetch and add carry-forward service_usage_records
      if (cfServiceIds.length > 0) {
        const { data: cfSvc } = await admin
          .from("service_usage_records")
          .select("id, service_id, amount, overage_quantity, overage_rate_snapshot, notes, service:service_catalog(name, printer_column)")
          .in("id", cfServiceIds)
          .eq("contract_id", contractId)
          .eq("is_billed", false);

        if (cfSvc && cfSvc.length > 0) {
          let svcSec = sections.find((s: { type: string }) => s.type === "service_usage");
          if (!svcSec) {
            svcSec = { type: "service_usage", label: "Service Usage", items: [], subtotal: 0 };
            sections.push(svcSec);
          }
          for (const s of cfSvc) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const svcInfo = (s as any).service as { name?: string; printer_column?: string | null } | null;
            let desc = svcInfo?.name || (s as { notes?: string }).notes || "Service charge";
            if (svcInfo?.printer_column === "bw")     desc = "Print - B/W";
            if (svcInfo?.printer_column === "colour") desc = "Print - Colour";
            const amt = Number(s.amount || 0);
            svcSec.items.push({
              service_id: s.service_id,
              description: desc,
              qty: Number((s as unknown as { overage_quantity?: number }).overage_quantity || 0),
              unit_price: Number((s as unknown as { overage_rate_snapshot?: number }).overage_rate_snapshot || 0),
              amount: amt,
            });
            svcSec.subtotal = (svcSec.subtotal || 0) + amt;
            cfServiceTotal += amt;
          }
          await admin.from("service_usage_records").update({ billing_statement_id: stmtId, is_billed: true }).in("id", cfServiceIds);
        }
      }

      if (cfAdHocTotal + cfServiceTotal > 0) {
        const newSubtotal = Number(stmtForCf.subtotal || 0) + cfAdHocTotal + cfServiceTotal;
        const taxRate = Number(stmtForCf.tax_percentage || 0);
        const { calcGst } = await import("@/lib/tax");
        const gst = calcGst(newSubtotal, taxRate);
        await admin.from("billing_statements").update({
          line_items:           sections,
          subtotal:             newSubtotal,
          tax_amount:           gst.taxAmount,
          cgst_amount:          gst.cgst,
          sgst_amount:          gst.sgst,
          igst_amount:          gst.igst,
          total_amount:         gst.grandTotal,
          usage_amount:         Number(stmtForCf.usage_amount || 0)   + cfAdHocTotal,
          service_usage_amount: Number(stmtForCf.service_usage_amount || 0) + cfServiceTotal,
        }).eq("id", stmtId);
        existing = { ...existing, total_amount: gst.grandTotal };
      }
    }
  }

  if (Number(existing.total_amount) <= 0) {
    // If the caller explicitly passed overrides that reduced the total to zero, the charges have
    // already been marked waived above. Clean up the zero-value draft and return a success so the
    // UI can close normally. Without overrides this is a free-quota contract — block it.
    if (overrides.length > 0) {
      await admin.from("billing_statements").delete().eq("id", existing.id);
      return NextResponse.json({ ok: true, all_waived: true, statement_id: existing.id });
    }
    return NextResponse.json({ error: "Draft is zero-amount — nothing to bill (charges may all be free quota)" }, { status: 400 });
  }

  // ── 3. Finalize + due_date + audit ──────────────────────────────────────
  const nowIso = new Date().toISOString();
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  istNow.setUTCDate(istNow.getUTCDate() + 7);
  const dueDate = istNow.toISOString().slice(0, 10);

  const { error: updErr } = await admin
    .from("billing_statements")
    .update({ status: "finalized", finalized_at: nowIso, due_date: dueDate })
    .eq("id", existing.id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: existing.id,
    action: "update",
    performedBy: dbUser.id,
    changes: { status: { old: "draft", new: "finalized" }, due_date: { old: null, new: dueDate } },
  });

  // ── 3. Dispatch. GST Direct contracts skip the PI and either issue a tax
  //     invoice directly or (v2 handoff) route to the Tally Inbox instead. ──
  const { data: contract } = await admin
    .from("contracts")
    .select("billing_mode")
    .eq("id", contractId)
    .single();
  const isGstDirect = (contract?.billing_mode as string | null) === "gst_direct";

  const handoff = await handleStatementFinalized(
    admin,
    existing.id,
    (contract?.billing_mode as "proforma_first" | "gst_direct" | null) ?? null,
    "usage_finalize_and_send_for_contract",
  );

  const r = handoff.skipLegacyDispatch
    ? { success: true, noContact: false, emailedTo: null, razorpayLinkUrl: null, proformaRef: null, totalAmount: existing.total_amount, error: undefined }
    : isGstDirect
      ? await dispatchGstDirect(admin, existing.id, dbUser.id, additionalCc)
      : await dispatchProforma(admin, existing.id, dbUser.id, additionalCc);
  if (!r.success) {
    await admin.from("billing_statements")
      .update({ status: "draft", finalized_at: null })
      .eq("id", existing.id);
    return NextResponse.json({
      error: `Finalize succeeded but dispatch failed (rolled back to draft): ${r.error || "unknown"}`,
      rolled_back: true,
    }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    statement_id: existing.id,
    statement_number: r.proformaRef,
    total_amount: r.totalAmount,
    due_date: dueDate,
    razorpay_link_url: r.razorpayLinkUrl,
    emailed_to: r.emailedTo,
    no_contact: r.noContact,
  });
}

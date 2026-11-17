import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { lineItemSchema } from "@/lib/validations";
import { escalateUnitPrice } from "@/lib/line-item-escalation";
import { firstBillingAnchor } from "@/lib/billing-months";
import { normalizeRenewalNote } from "@/lib/renewal-note";
import { DEFAULT_ESCALATION_PERCENTAGE, programmedEscalation } from "@/lib/auto-renewal";
import { createRenewalDraft } from "@/lib/renewal-draft";

/**
 * POST /api/contracts/[id]/renew
 *
 * Creates a new draft contract from an existing active/expired contract
 * with escalation applied to the monthly fixed rental.
 *
 * Carries over: lead, location, seats, billing_cycle, tenure, items
 *   (escalated), terms, workspace description, complimentary items,
 *   signatory, department ID, KYC docs, contract facilities, space
 *   allocations. Security deposit rolls over (no re-collection).
 *
 * Body (all optional overrides):
 *   { tenure_months?, seats?, start_date?, billing_cycle?,
 *     escalation_percentage?, notice_period_months?, lock_in_months?,
 *     agreed_note? }
 *
 * `agreed_note` is an optional internal note (max 1000 chars) on what was
 * agreed in the negotiation, stored on the renewal as renewal_agreed_note. It
 * is never rendered into the agreement or any invoice.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  // Role gate: only admin, manager, sales_rep can renew.
  // Floor managers must request a renewal through their manager.
  const renewAllowedRoles = ["admin", "manager", "sales_rep"];
  if (!renewAllowedRoles.includes(dbUser.role)) {
    return NextResponse.json({
      error: "You do not have permission to renew contracts. Please ask your manager or admin to initiate the renewal.",
    }, { status: 403 });
  }

  // 1. Fetch the source contract
  const { data: source, error: fetchErr } = await supabase
    .from("contracts")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !source) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const result = await createRenewalDraft(createAdminClient(), source, body, dbUser);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, ...result.extra }, { status: result.status });
  }
  return NextResponse.json({ data: result.data }, { status: 201 });
}

/**
 * PATCH /api/contracts/[id]/renew
 *
 * Two actions on a draft renewal contract:
 *
 * 1. Edit renewal terms (admin, manager, sales_rep) — correct or renegotiate
 *    any field before the addendum is finalized.
 *    Body: { edit_terms: true, tenure_months?, start_date?, billing_cycle?,
 *            escalation_percentage?, seats?, items? }
 *    `items`, when provided, fully replaces the line items (description/
 *    qty/unit price editable per row) — totals are always recomputed
 *    server-side from quantity × unit_price, never trusted from the client.
 *
 * 2. Waive/restore escalation (admin-only).
 *    Body: { waive_escalation: true, waiver_reason: "..." }
 *       or { waive_escalation: false }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const body = await request.json();

  // Fetch the renewal contract
  const admin = createAdminClient();
  const { data: contract } = await admin
    .from("contracts")
    .select("*")
    .eq("id", id)
    .single();

  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (!contract.is_renewal) return NextResponse.json({ error: "Not a renewal contract" }, { status: 400 });
  if (contract.status !== "draft") return NextResponse.json({ error: "Can only modify a draft renewal" }, { status: 400 });

  // Fetched separately rather than via an embedded PostgREST join — the
  // self-referencing FK relationship isn't resolvable through the embed
  // syntax in this project's schema cache.
  type ParentSummary = {
    id: string; items: unknown; subtotal: number; seats: number;
    escalation_percentage: number | null; agreement_escalation_percentage?: number | null; contract_number: string;
  };
  let parent: ParentSummary | null = null;
  if (contract.parent_contract_id) {
    // "*" rather than a column list: agreement_escalation_percentage only exists
    // after migration 00662, and a named column that is missing fails the whole read.
    const { data: parentData } = await admin
      .from("contracts")
      .select("*")
      .eq("id", contract.parent_contract_id)
      .single();
    parent = parentData;
  }

  // ── Edit renewal terms ──────────────────────────────────────────────────
  if (body.edit_terms === true) {
    const editAllowedRoles = ["admin", "manager", "sales_rep"];
    if (!editAllowedRoles.includes(dbUser.role)) {
      return NextResponse.json({
        error: "You do not have permission to edit renewal terms. Please ask your manager or admin.",
      }, { status: 403 });
    }

    // Optional: only touched when the caller sends `agreed_note`; an empty
    // string clears it.
    const noteResult = body.agreed_note !== undefined ? normalizeRenewalNote(body.agreed_note) : null;
    if (noteResult && !noteResult.ok) {
      return NextResponse.json({ error: noteResult.error }, { status: 400 });
    }
    const noteChange =
      noteResult && noteResult.ok && noteResult.value !== (contract.renewal_agreed_note ?? null)
        ? noteResult.value
        : undefined;

    type Item = { description: string; quantity: number; unit_price: number; total: number; unit?: string; escalates?: boolean };

    let newItems: Item[] | null = null;
    if (body.items !== undefined) {
      const parsed = z.array(lineItemSchema).min(1, "At least one line item is required").safeParse(body.items);
      if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid line items" }, { status: 400 });
      }
      // Recompute totals server-side — never trust client-supplied totals.
      newItems = parsed.data.map((item) => ({
        ...item,
        total: Math.round(item.quantity * item.unit_price * 100) / 100,
      }));
    }

    const tenureMonths = body.tenure_months != null ? Number(body.tenure_months) : Number(contract.tenure_months);
    const seats = body.seats != null ? Number(body.seats) : Number(contract.seats || 1);
    const billingCycle = body.billing_cycle || contract.billing_cycle || "monthly";
    const programmedPct = parent ? programmedEscalation(parent) : DEFAULT_ESCALATION_PERCENTAGE;
    const escalationPct = body.escalation_percentage != null
      ? Number(body.escalation_percentage)
      : contract.escalation_percentage != null
        ? Number(contract.escalation_percentage)
        : programmedPct;
    const startDateStr = body.start_date || contract.start_date;

    if (!startDateStr || !tenureMonths || tenureMonths < 1) {
      return NextResponse.json({ error: "Invalid start date or tenure" }, { status: 400 });
    }

    // Recompute end date + next billing date (mirrors POST /renew logic)
    const startDate = new Date(startDateStr + "T00:00:00Z");
    const endDate = new Date(startDate);
    endDate.setUTCMonth(endDate.getUTCMonth() + tenureMonths);
    endDate.setUTCDate(endDate.getUTCDate() - 1);
    const endDateStr = endDate.toISOString().slice(0, 10);

    const nextBillingDateYmd = firstBillingAnchor(startDate.toISOString().slice(0, 10));

    const items = newItems || ((contract.items || []) as Item[]);
    const subtotal = items.reduce((sum, i) => sum + i.total, 0);
    const taxPercentage = Number(contract.tax_percentage || 18);
    const discountPercentage = Number(contract.discount_percentage || 0);
    const discountAmount = Math.round(subtotal * (discountPercentage / 100) * 100) / 100;
    const taxableAmount = subtotal - discountAmount;
    const taxAmount = Math.round(taxableAmount * (taxPercentage / 100) * 100) / 100;
    const totalAmount = taxableAmount + taxAmount;

    // Deposit shortfall vs. parent's original rate
    const parentSubtotal = Number(parent?.subtotal) || 0;
    const secDepMonths = Number(contract.security_deposit_months || 3);
    const oldDeposit = parentSubtotal * secDepMonths;
    const newDeposit = subtotal * secDepMonths;
    const depositShortfall = Math.max(0, Math.round((newDeposit - oldDeposit) * 100) / 100);

    const updates = {
      tenure_months: tenureMonths,
      seats,
      billing_cycle: billingCycle,
      escalation_percentage: escalationPct,
      ...("agreement_escalation_percentage" in contract ? { agreement_escalation_percentage: programmedPct } : {}),
      start_date: startDateStr,
      end_date: endDateStr,
      next_billing_date: nextBillingDateYmd,
      items,
      subtotal,
      tax_amount: taxAmount,
      discount_amount: discountAmount,
      total_amount: totalAmount,
      deposit_shortfall: depositShortfall,
      ...(noteChange !== undefined ? { renewal_agreed_note: noteChange } : {}),
    };

    const { error: updateErr } = await admin.from("contracts").update(updates).eq("id", id);
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    logAudit(admin, {
      entityType: "contract",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        edit_reason: { old: null, new: "renewal_terms_correction" },
        tenure_months: { old: Number(contract.tenure_months), new: tenureMonths },
        seats: { old: Number(contract.seats || 1), new: seats },
        billing_cycle: { old: contract.billing_cycle, new: billingCycle },
        escalation_percentage: { old: Number(contract.escalation_percentage || 0), new: escalationPct },
        start_date: { old: contract.start_date, new: startDateStr },
        end_date: { old: contract.end_date, new: endDateStr },
        items: { old: contract.items, new: items },
        subtotal: { old: Number(contract.subtotal), new: subtotal },
        total_amount: { old: Number(contract.total_amount), new: totalAmount },
        deposit_shortfall: { old: Number(contract.deposit_shortfall || 0), new: depositShortfall },
        // Negotiation detail stays out of the audit trail; only that it changed.
        ...(noteChange !== undefined
          ? {
              renewal_agreed_note: {
                old: contract.renewal_agreed_note ? "set" : "empty",
                new: noteChange ? "set" : "empty",
              },
            }
          : {}),
      },
    });

    // Same rule as at creation: a reduced or zero escalation set by a
    // non-admin needs admin approval. Editing the draft afterwards must not
    // be a way around it.
    const parentEscPct = programmedPct;
    const escalationChanged = escalationPct !== Number(contract.escalation_percentage || 0);
    const needsApproval = dbUser.role !== "admin" && (escalationPct < parentEscPct || escalationPct === 0);
    let approvalStatus: string | null = contract.escalation_approval_status ?? null;

    if (needsApproval && escalationChanged) {
      const approvalType = escalationPct === 0 ? "escalation_waiver" : "escalation_reduction";
      const { data: approvalReq } = await admin
        .from("approval_requests")
        .insert({
          approval_type: approvalType,
          entity_type: "contract",
          entity_id: id,
          entity_reference: contract.contract_number,
          requested_by: dbUser.id,
          reason: `${approvalType === "escalation_waiver" ? "Escalation waiver" : "Escalation reduction"} from ${parentEscPct}% to ${escalationPct}% on renewal of ${parent?.contract_number ?? "parent contract"}`,
          metadata: {
            parent_contract_id: contract.parent_contract_id,
            parent_contract_number: parent?.contract_number,
            parent_escalation_percentage: parentEscPct,
            proposed_escalation_percentage: escalationPct,
            parent_subtotal: parentSubtotal,
            proposed_subtotal: subtotal,
            requested_by_name: null,
          },
        })
        .select("id")
        .single();

      if (approvalReq) {
        await admin
          .from("contracts")
          .update({ escalation_approval_status: "pending", escalation_approval_id: approvalReq.id })
          .eq("id", id);
        approvalStatus = "pending";
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        subtotal,
        tax_amount: taxAmount,
        total_amount: totalAmount,
        deposit_shortfall: depositShortfall,
        end_date: endDateStr,
        escalation_approval_status: approvalStatus,
      },
    });
  }

  // ── Waive / restore escalation (admin-only) ─────────────────────────────
  if (dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admins can waive escalation" }, { status: 403 });
  }
  if (typeof body.waive_escalation !== "boolean") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const waive = body.waive_escalation;

  if (waive) {
    if (!body.waiver_reason?.trim()) {
      return NextResponse.json({ error: "Waiver reason is required" }, { status: 400 });
    }

    // Restore parent contract's original prices (no escalation)
    if (!parent) return NextResponse.json({ error: "Parent contract not found" }, { status: 400 });

    type Item = { description: string; quantity: number; unit_price: number; total: number; unit?: string; escalates?: boolean };
    const parentItems = (parent.items as Item[]) || [];
    const parentSeatsWaive = Number(parent.seats) || 1;
    const renewalSeatsWaive = Number(contract.seats || 1);

    // Adjust parent item quantities to match renewal seat count
    const adjustedItems = parentItems.map((item: Item) => {
      const newQuantity = item.quantity === parentSeatsWaive ? renewalSeatsWaive : item.quantity;
      const newTotal = Math.round(item.unit_price * newQuantity * 100) / 100;
      return { ...item, quantity: newQuantity, total: newTotal };
    });
    const adjustedSubtotal = adjustedItems.reduce((sum: number, i: Item) => sum + i.total, 0);

    const taxPercentage = Number(contract.tax_percentage || 18);
    const discountPercentage = Number(contract.discount_percentage || 0);
    const discountAmount = Math.round(adjustedSubtotal * (discountPercentage / 100) * 100) / 100;
    const taxableAmount = adjustedSubtotal - discountAmount;
    const taxAmount = Math.round(taxableAmount * (taxPercentage / 100) * 100) / 100;
    const totalAmount = taxableAmount + taxAmount;

    // Deposit shortfall: compare against parent's subtotal at parent's seat count
    const parentSubtotal = Number(parent.subtotal) || 0;
    const secDepMonths = Number(contract.security_deposit_months || 3);
    const oldDeposit = parentSubtotal * secDepMonths;
    const newDeposit = adjustedSubtotal * secDepMonths;
    const depositShortfall = Math.max(0, Math.round((newDeposit - oldDeposit) * 100) / 100);

    await admin
      .from("contracts")
      .update({
        items: adjustedItems,
        subtotal: adjustedSubtotal,
        tax_amount: taxAmount,
        discount_amount: discountAmount,
        total_amount: totalAmount,
        escalation_waived: true,
        escalation_waiver_reason: body.waiver_reason.trim(),
        escalation_waived_by: dbUser.id,
        deposit_shortfall: depositShortfall,
      })
      .eq("id", id);

    logAudit(admin, {
      entityType: "contract",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        escalation_waived: { old: false, new: true },
        waiver_reason: body.waiver_reason.trim(),
        subtotal: { old: Number(contract.subtotal), new: adjustedSubtotal },
      },
    });

    return NextResponse.json({ success: true, escalation_waived: true, new_subtotal: adjustedSubtotal });
  } else {
    // Restore escalation — re-apply from parent's prices
    if (!parent) return NextResponse.json({ error: "Parent contract not found" }, { status: 400 });

    type Item = { description: string; quantity: number; unit_price: number; total: number; unit?: string; escalates?: boolean };
    const parentItems = (parent.items as Item[]) || [];
    const parentSeatsRestore = Number(parent.seats) || 1;
    const renewalSeatsRestore = Number(contract.seats || 1);
    const escalationPct = Number(contract.escalation_percentage || 10);
    const multiplier = 1 + escalationPct / 100;

    const newItems: Item[] = parentItems.map((item: Item) => {
      const newQuantity = item.quantity === parentSeatsRestore ? renewalSeatsRestore : item.quantity;
      const newUnitPrice = escalateUnitPrice(item, multiplier, (n) => Math.round(n * 100) / 100);
      const newTotal = Math.round(newUnitPrice * newQuantity * 100) / 100;
      return { ...item, quantity: newQuantity, unit_price: newUnitPrice, total: newTotal };
    });

    const newSubtotal = newItems.reduce((sum, i) => sum + i.total, 0);
    const taxPercentage = Number(contract.tax_percentage || 18);
    const discountPercentage = Number(contract.discount_percentage || 0);
    const discountAmount = Math.round(newSubtotal * (discountPercentage / 100) * 100) / 100;
    const taxableAmount = newSubtotal - discountAmount;
    const taxAmount = Math.round(taxableAmount * (taxPercentage / 100) * 100) / 100;
    const totalAmount = taxableAmount + taxAmount;

    const secDepMonths = Number(contract.security_deposit_months || 3);
    const parentSub = Number(parent.subtotal) || 0;
    const oldDeposit = parentSub * secDepMonths;
    const newDeposit = newSubtotal * secDepMonths;
    const depositShortfall = Math.max(0, Math.round((newDeposit - oldDeposit) * 100) / 100);

    await admin
      .from("contracts")
      .update({
        items: newItems,
        subtotal: newSubtotal,
        tax_amount: taxAmount,
        discount_amount: discountAmount,
        total_amount: totalAmount,
        escalation_waived: false,
        escalation_waiver_reason: null,
        escalation_waived_by: null,
        deposit_shortfall: depositShortfall,
      })
      .eq("id", id);

    logAudit(admin, {
      entityType: "contract",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        escalation_waived: { old: true, new: false },
        subtotal: { old: Number(contract.subtotal), new: newSubtotal },
      },
    });

    return NextResponse.json({ success: true, escalation_waived: false, new_subtotal: newSubtotal });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { lineItemSchema } from "@/lib/validations";

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
 *     escalation_percentage?, notice_period_months?, lock_in_months? }
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

  if (!["active", "expired", "renewal_in_progress"].includes(source.status)) {
    return NextResponse.json({
      error: `Cannot renew a contract with status "${source.status}". Contract must be active or expired.`,
    }, { status: 400 });
  }

  // 2. Check no existing renewal already exists
  const { data: existingRenewal } = await supabase
    .from("contracts")
    .select("id, contract_number, status")
    .eq("parent_contract_id", id)
    .eq("is_renewal", true)
    .not("status", "in", '("terminated","rejected")')
    .maybeSingle();

  if (existingRenewal) {
    return NextResponse.json({
      error: `A renewal already exists: ${existingRenewal.contract_number} (${existingRenewal.status})`,
      existing_renewal_id: existingRenewal.id,
    }, { status: 409 });
  }

  // 3. Parse optional overrides
  const body = await request.json().catch(() => ({}));
  const tenureMonths = body.tenure_months ? Number(body.tenure_months) : Number(source.tenure_months || 12);
  const seats = body.seats ? Number(body.seats) : Number(source.seats || 1);
  const billingCycle = body.billing_cycle || source.billing_cycle || "monthly";

  // Start date: day after old contract ends (or override)
  const oldEndDate = new Date(source.end_date + "T00:00:00Z");
  const defaultStartDate = new Date(oldEndDate);
  defaultStartDate.setUTCDate(defaultStartDate.getUTCDate() + 1);
  const startDateStr = body.start_date || defaultStartDate.toISOString().slice(0, 10);

  // Calculate end date: start + N months, minus 1 day.
  // e.g. Nov 1 + 11 months = Oct 1 → subtract 1 day → Sep 30.
  const startDate = new Date(startDateStr + "T00:00:00Z");
  const endDate = new Date(startDate);
  endDate.setUTCMonth(endDate.getUTCMonth() + tenureMonths);
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  const endDateStr = endDate.toISOString().slice(0, 10);

  // Calculate next billing date.
  // If the renewal starts mid-month (not the 1st), snap to the 1st of the
  // following month so the partial first month is billed as pro-rata and
  // subsequent cycles align to clean calendar months.
  const nextBillingDate = new Date(startDate);
  if (startDate.getUTCDate() !== 1) {
    nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 1);
    nextBillingDate.setUTCDate(1);
  } else {
    switch (billingCycle) {
      case "monthly": nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 1); break;
      case "quarterly": nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 3); break;
      case "half_yearly": nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 6); break;
      case "yearly": nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 12); break;
    }
  }

  // 4. Apply escalation to items
  // Allow custom escalation % override — negotiation may result in a different rate
  const escalationPct = body.escalation_percentage != null
    ? Number(body.escalation_percentage)
    : Number(source.escalation_percentage || 10);
  const escalationMultiplier = 1 + escalationPct / 100;

  // Round to nearest Rupee.
  const roundToRupee = (n: number) => Math.round(n);

  type Item = { description: string; quantity: number; unit_price: number; total: number; unit?: string };
  const oldSeats = Number(source.seats || 1);
  const oldItems = (source.items || []) as Item[];
  const newItems: Item[] = oldItems.map((item) => {
    // Scale seat-based items proportionally; leave flat-fee items (quantity !== oldSeats) unchanged.
    const newQuantity = item.quantity === oldSeats ? seats : item.quantity;
    const rawUnitPrice = item.unit_price * escalationMultiplier;
    const newUnitPrice = roundToRupee(rawUnitPrice);
    const newTotal = newUnitPrice * newQuantity;
    return { ...item, quantity: newQuantity, unit_price: newUnitPrice, total: newTotal };
  });

  const newSubtotal = newItems.reduce((sum, i) => sum + i.total, 0);
  const taxPercentage = Number(source.tax_percentage || 18);
  const discountPercentage = Number(source.discount_percentage || 0);
  const discountAmount = Math.round(newSubtotal * (discountPercentage / 100) * 100) / 100;
  const taxableAmount = newSubtotal - discountAmount;
  const taxAmount = Math.round(taxableAmount * (taxPercentage / 100) * 100) / 100;
  const totalAmount = taxableAmount + taxAmount;

  // 5. Calculate deposit shortfall
  const securityDepositMonths = Number(source.security_deposit_months || 3);
  const oldDeposit = Number(source.subtotal || 0) * securityDepositMonths;
  const newDeposit = newSubtotal * securityDepositMonths;
  const depositShortfall = Math.max(0, Math.round((newDeposit - oldDeposit) * 100) / 100);

  // Renewal sequence
  const renewalSequence = Number(source.renewal_sequence || 1) + 1;

  // 6. Create the new contract
  const admin = createAdminClient();
  const { data: newContract, error: insertErr } = await admin
    .from("contracts")
    .insert({
      lead_id: source.lead_id,
      location_id: source.location_id,
      title: source.title,
      status: "draft",
      items: newItems,
      subtotal: newSubtotal,
      tax_percentage: taxPercentage,
      tax_amount: taxAmount,
      discount_percentage: discountPercentage,
      discount_amount: discountAmount,
      total_amount: totalAmount,
      billing_cycle: billingCycle,
      tenure_months: tenureMonths,
      start_date: startDateStr,
      end_date: endDateStr,
      next_billing_date: nextBillingDate.toISOString().slice(0, 10),
      seats,
      terms_and_conditions: source.terms_and_conditions,
      notes: `Renewal of ${source.contract_number} (V${renewalSequence})`,
      workspace_description: source.workspace_description,
      parking_space: source.parking_space,
      complimentary_services: source.complimentary_services,
      complimentary_items: source.complimentary_items,
      security_deposit_months: securityDepositMonths,
      escalation_percentage: escalationPct,
      notice_period_months: body.notice_period_months != null
        ? Number(body.notice_period_months)
        : source.notice_period_months,
      member_signatory_name: source.member_signatory_name,
      member_signatory_designation: source.member_signatory_designation,
      member_signatory_pan: source.member_signatory_pan,
      member_signatory_id_type: source.member_signatory_id_type || "pan",
      agreement_date: new Date().toISOString().slice(0, 10),
      department_id: null, // can't copy — parent still holds the (location_id, department_id) pair until it moves to "renewed"
      // Renewal-specific fields
      parent_contract_id: id,
      is_renewal: true,
      renewal_sequence: renewalSequence,
      deposit_carried_from: id,
      deposit_shortfall: depositShortfall,
      created_by: dbUser.id,
      // Pro-rata gate: mid-month starts require collecting the partial first month
      // before activation. 1st-of-month starts are not applicable.
      prorata_payment_status: startDate.getUTCDate() !== 1 ? "pending" : "not_applicable",
    })
    .select("id, contract_number")
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // 7. Mark parent as "renewal_in_progress" — signals that a renewal
  //    negotiation is underway, but the parent is still the active contract.
  //    Transitions to "renewed" only when the renewal draft is activated
  //    (see PATCH /api/contracts/[id] hook). If the draft is deleted, the
  //    parent should be restored to "active" (see DELETE handler).
  try {
    await admin
      .from("contracts")
      .update({ status: "renewal_in_progress" })
      .eq("id", id);
  } catch (err) {
    console.error("[renew] failed to mark parent as renewal_in_progress:", err);
  }

  // 8. Copy approved, deferred and waived KYC documents.
  // Deferred docs carry over with their deferral metadata so they remain
  // visible as still-pending-collection on the renewal contract. Waived docs
  // carry their waiver too — the decision was about the customer, not the
  // contract term, and re-raising it every renewal is what turned deferral
  // into a permanent-waiver workaround in the first place.
  const { data: kycDocs } = await admin
    .from("contract_documents")
    .select("document_id, document_type, label, is_required, status, reviewed_by, reviewed_at, notes, deferred_by, deferred_at, deferred_reason, deferred_until, waived_by, waived_at, waived_reason")
    .eq("contract_id", id)
    .in("status", ["approved", "deferred", "waived"]);

  if (kycDocs && kycDocs.length > 0) {
    const kycInserts = kycDocs.map((doc) => ({
      contract_id: newContract.id,
      document_id: doc.document_id,
      document_type: doc.document_type,
      label: doc.label,
      is_required: doc.is_required,
      status: doc.status,
      reviewed_by: doc.reviewed_by,
      reviewed_at: doc.reviewed_at,
      notes: doc.notes ? `${doc.notes} [carried from ${source.contract_number}]` : `Carried from ${source.contract_number}`,
      ...(doc.status === "deferred"
        ? {
            deferred_by: doc.deferred_by,
            deferred_at: doc.deferred_at,
            deferred_reason: doc.deferred_reason,
            deferred_until: doc.deferred_until,
          }
        : {}),
      ...(doc.status === "waived"
        ? {
            waived_by: doc.waived_by,
            waived_at: doc.waived_at,
            waived_reason: doc.waived_reason,
          }
        : {}),
    }));
    await admin.from("contract_documents").insert(kycInserts).select("id");
  }

  // 9. Copy contract facilities (complimentary quotas)
  const { data: facilities } = await admin
    .from("contract_facilities")
    .select("name, unit, cost_per_unit, free_quota, is_active")
    .eq("contract_id", id)
    .eq("is_active", true);

  if (facilities && facilities.length > 0) {
    const facInserts = facilities.map((f) => ({
      contract_id: newContract.id,
      name: f.name,
      unit: f.unit,
      cost_per_unit: f.cost_per_unit,
      free_quota: f.free_quota,
      is_active: true,
      created_by: dbUser.id,
    }));
    await admin.from("contract_facilities").insert(facInserts).select("id");
  }

  // 10. Copy space allocations
  const { data: allocations } = await admin
    .from("contract_space_allocations")
    .select("space_unit_id, notes")
    .eq("contract_id", id)
    .eq("status", "active");

  if (allocations && allocations.length > 0) {
    const allocInserts = allocations.map((a) => ({
      contract_id: newContract.id,
      space_unit_id: a.space_unit_id,
      start_date: startDateStr,
      end_date: endDateStr,
      status: "active",
      notes: a.notes || null,
    }));
    // Insert one-by-one to handle unique constraint gracefully
    for (const alloc of allocInserts) {
      await admin.from("contract_space_allocations").insert(alloc).select("id");
    }
  }

  // 11. Copy service quotas from parent contract
  const { data: parentQuotas } = await admin
    .from("contract_service_quotas")
    .select("service_id, monthly_quota, overage_rate")
    .eq("contract_id", id);

  if (parentQuotas && parentQuotas.length > 0) {
    const renewalQuotas = parentQuotas.map(q => ({
      contract_id: newContract.id,
      service_id: q.service_id,
      monthly_quota: q.monthly_quota,
      overage_rate: q.overage_rate,
      created_by: dbUser.id,
    }));
    await admin.from("contract_service_quotas").insert(renewalQuotas);
  }

  // 13. Audit trail
  logAudit(admin, {
    entityType: "contract",
    entityId: newContract.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      type: { old: null, new: "renewal" },
      parent_contract_id: { old: null, new: id },
      parent_contract_number: { old: null, new: source.contract_number },
      escalation_percentage: { old: 0, new: escalationPct },
      subtotal: { old: Number(source.subtotal), new: newSubtotal },
      deposit_shortfall: { old: 0, new: depositShortfall },
    },
  });

  logAudit(admin, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      renewal_draft_created: { old: null, new: newContract.contract_number },
      renewal_contract_id: { old: null, new: newContract.id },
    },
  });

  // 14. Escalation approval workflow
  // If escalation is reduced or waived (and requester is not admin), create
  // an approval request. The draft is created with the proposed rate, but
  // the contract is flagged as pending approval. If rejected, the rate
  // reverts to the default escalation.
  const parentEscPct = Number(source.escalation_percentage || 10);
  const needsApproval = dbUser.role !== "admin" && (escalationPct < parentEscPct || escalationPct === 0);
  let approvalStatus: string | null = null;

  if (needsApproval) {
    const approvalType = escalationPct === 0 ? "escalation_waiver" : "escalation_reduction";
    const { data: approvalReq } = await admin
      .from("approval_requests")
      .insert({
        approval_type: approvalType,
        entity_type: "contract",
        entity_id: newContract.id,
        entity_reference: newContract.contract_number,
        requested_by: dbUser.id,
        reason: `${approvalType === "escalation_waiver" ? "Escalation waiver" : "Escalation reduction"} from ${parentEscPct}% to ${escalationPct}% on renewal of ${source.contract_number}`,
        metadata: {
          parent_contract_id: id,
          parent_contract_number: source.contract_number,
          parent_escalation_percentage: parentEscPct,
          proposed_escalation_percentage: escalationPct,
          parent_subtotal: Number(source.subtotal),
          proposed_subtotal: newSubtotal,
          requested_by_name: dbUser.full_name,
        },
      })
      .select("id")
      .single();

    if (approvalReq) {
      await admin
        .from("contracts")
        .update({
          escalation_approval_status: "pending",
          escalation_approval_id: approvalReq.id,
        })
        .eq("id", newContract.id);
      approvalStatus = "pending";
    }
  }

  // Calculate gap between parent end and renewal start (0 = seamless)
  const parentEndMs = new Date(source.end_date + "T00:00:00Z").getTime();
  const renewalStartMs = startDate.getTime();
  const gapDays = Math.max(0, Math.round((renewalStartMs - parentEndMs) / 86_400_000) - 1);

  return NextResponse.json({
    data: {
      id: newContract.id,
      contract_number: newContract.contract_number,
      parent_contract_number: source.contract_number,
      escalation_percentage: escalationPct,
      old_subtotal: Number(source.subtotal),
      new_subtotal: newSubtotal,
      deposit_shortfall: depositShortfall,
      renewal_sequence: renewalSequence,
      start_date: startDateStr,
      end_date: endDateStr,
      gap_days: gapDays,
      escalation_approval_status: approvalStatus,
    },
  }, { status: 201 });
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
  type ParentSummary = { id: string; items: unknown; subtotal: number; seats: number };
  let parent: ParentSummary | null = null;
  if (contract.parent_contract_id) {
    const { data: parentData } = await admin
      .from("contracts")
      .select("id, items, subtotal, seats")
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

    type Item = { description: string; quantity: number; unit_price: number; total: number; unit?: string };

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
    const escalationPct = body.escalation_percentage != null ? Number(body.escalation_percentage) : Number(contract.escalation_percentage || 0);
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

    const nextBillingDate = new Date(startDate);
    if (startDate.getUTCDate() !== 1) {
      nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 1);
      nextBillingDate.setUTCDate(1);
    } else {
      switch (billingCycle) {
        case "monthly": nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 1); break;
        case "quarterly": nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 3); break;
        case "half_yearly": nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 6); break;
        case "yearly": nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 12); break;
      }
    }

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
      start_date: startDateStr,
      end_date: endDateStr,
      next_billing_date: nextBillingDate.toISOString().slice(0, 10),
      items,
      subtotal,
      tax_amount: taxAmount,
      discount_amount: discountAmount,
      total_amount: totalAmount,
      deposit_shortfall: depositShortfall,
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
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        subtotal,
        tax_amount: taxAmount,
        total_amount: totalAmount,
        deposit_shortfall: depositShortfall,
        end_date: endDateStr,
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

    type Item = { description: string; quantity: number; unit_price: number; total: number; unit?: string };
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

    type Item = { description: string; quantity: number; unit_price: number; total: number; unit?: string };
    const parentItems = (parent.items as Item[]) || [];
    const parentSeatsRestore = Number(parent.seats) || 1;
    const renewalSeatsRestore = Number(contract.seats || 1);
    const escalationPct = Number(contract.escalation_percentage || 10);
    const multiplier = 1 + escalationPct / 100;

    const newItems: Item[] = parentItems.map((item: Item) => {
      const newQuantity = item.quantity === parentSeatsRestore ? renewalSeatsRestore : item.quantity;
      const newUnitPrice = Math.round(item.unit_price * multiplier * 100) / 100;
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

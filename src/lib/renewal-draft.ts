import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import { firstBillingAnchor } from "@/lib/billing-months";

/**
 * Creates a draft renewal contract from an existing active/expired contract.
 *
 * Shared by POST /api/contracts/[id]/renew (a person clicking Renew) and the
 * daily /api/cron/renewal-autodraft job, so both paths produce an identical
 * draft. This is the body of the route's POST handler moved here as it was,
 * except:
 *   - reads use the admin client (the route has already done its role check);
 *   - `actor.system` marks a scheduled run: audit is attributed to "system"
 *     and no escalation-approval request is raised (a system draft never
 *     deviates from the contract's own escalation);
 *   - `autoCreated` stamps renewal_auto_created so the draft must be validated
 *     by a person before it can be sent to the customer.
 */

export interface RenewalActor {
  id: string | null;
  role: string;
  full_name: string | null;
  system?: boolean;
}

export interface RenewalOverrides {
  tenure_months?: number | string;
  seats?: number | string;
  start_date?: string;
  billing_cycle?: string;
  escalation_percentage?: number | string | null;
  notice_period_months?: number | string | null;
  lock_in_months?: number | string | null;
}

export type RenewalDraftResult =
  | {
      ok: true;
      data: {
        id: string;
        contract_number: string;
        parent_contract_number: string;
        escalation_percentage: number;
        old_subtotal: number;
        new_subtotal: number;
        deposit_shortfall: number;
        renewal_sequence: number;
        start_date: string;
        end_date: string;
        gap_days: number;
        escalation_approval_status: string | null;
      };
    }
  | { ok: false; status: number; error: string; existing_renewal_id?: string };

export async function createRenewalDraft(
  admin: SupabaseClient,
  sourceId: string,
  actor: RenewalActor,
  body: RenewalOverrides,
  autoCreated = false
): Promise<RenewalDraftResult> {
  // 1. Fetch the source contract
  const { data: source, error: fetchErr } = await admin
    .from("contracts")
    .select("*")
    .eq("id", sourceId)
    .single();

  if (fetchErr || !source) {
    return { ok: false, status: 404, error: "Contract not found" };
  }

  if (!["active", "expired", "renewal_in_progress"].includes(source.status)) {
    return {
      ok: false, status: 400,
      error: `Cannot renew a contract with status "${source.status}". Contract must be active or expired.`,
    };
  }

  // Renewal window: only open up within 45 days of expiry (an "expired"
  // contract is already past that window by definition). Prevents
  // accidental early clicks from locking the parent into
  // "renewal_in_progress" years ahead of the actual renewal conversation.
  if (source.status === "active") {
    const endDate = new Date(source.end_date + "T00:00:00Z");
    const daysUntilExpiry = Math.ceil((endDate.getTime() - Date.now()) / 86_400_000);
    if (daysUntilExpiry > 45) {
      return {
        ok: false, status: 400,
        error: `Renewal can only be started within 45 days of the contract's expiry (${source.end_date}). ${daysUntilExpiry} days remain.`,
      };
    }
  }

  // 2. Check no existing renewal already exists
  const { data: existingRenewal } = await admin
    .from("contracts")
    .select("id, contract_number, status")
    .eq("parent_contract_id", sourceId)
    .eq("is_renewal", true)
    .not("status", "in", '("terminated","rejected")')
    .maybeSingle();

  if (existingRenewal) {
    return {
      ok: false, status: 409,
      error: `A renewal already exists: ${existingRenewal.contract_number} (${existingRenewal.status})`,
      existing_renewal_id: existingRenewal.id,
    };
  }

  // 3. Parse optional overrides
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
  // Mid-month renewals already opened on the 1st of the following month; a
  // renewal starting ON the 1st used to jump a whole cycle ahead, which for an
  // advance-billed contract skipped billing its first cycle. Both cases now go
  // through the same helper.
  const nextBillingDateYmd = firstBillingAnchor(startDate.toISOString().slice(0, 10));

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
      next_billing_date: nextBillingDateYmd,
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
      parent_contract_id: sourceId,
      is_renewal: true,
      renewal_sequence: renewalSequence,
      deposit_carried_from: sourceId,
      // Invoicing preference follows the customer, not the term — a GST Direct
      // customer must not silently reset to PI-first on renewal.
      billing_mode: source.billing_mode ?? "proforma_first",
      deposit_shortfall: depositShortfall,
      created_by: actor.id,
      ...(autoCreated
        ? { renewal_auto_created: true, renewal_auto_created_at: new Date().toISOString() }
        : {}),
      // Pro-rata gate: mid-month starts require collecting the partial first month
      // before activation. 1st-of-month starts are not applicable.
      prorata_payment_status: startDate.getUTCDate() !== 1 ? "pending" : "not_applicable",
    })
    .select("id, contract_number")
    .single();

  if (insertErr) {
    return { ok: false, status: 500, error: insertErr.message };
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
      .eq("id", sourceId);
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
    .eq("contract_id", sourceId)
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
    .eq("contract_id", sourceId)
    .eq("is_active", true);

  if (facilities && facilities.length > 0) {
    const facInserts = facilities.map((f) => ({
      contract_id: newContract.id,
      name: f.name,
      unit: f.unit,
      cost_per_unit: f.cost_per_unit,
      free_quota: f.free_quota,
      is_active: true,
      created_by: actor.id,
    }));
    await admin.from("contract_facilities").insert(facInserts).select("id");
  }

  // 10. Copy space allocations
  const { data: allocations } = await admin
    .from("contract_space_allocations")
    .select("space_unit_id, notes")
    .eq("contract_id", sourceId)
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
    .eq("contract_id", sourceId);

  if (parentQuotas && parentQuotas.length > 0) {
    const renewalQuotas = parentQuotas.map(q => ({
      contract_id: newContract.id,
      service_id: q.service_id,
      monthly_quota: q.monthly_quota,
      overage_rate: q.overage_rate,
      created_by: actor.id,
    }));
    await admin.from("contract_service_quotas").insert(renewalQuotas);
  }

  // 13. Audit trail
  logAudit(admin, {
    entityType: "contract",
    entityId: newContract.id,
    action: "create",
    performedBy: actor.system ? "system" : actor.id,
    changes: {
      type: { old: null, new: "renewal" },
      parent_contract_id: { old: null, new: sourceId },
      parent_contract_number: { old: null, new: source.contract_number },
      escalation_percentage: { old: 0, new: escalationPct },
      subtotal: { old: Number(source.subtotal), new: newSubtotal },
      deposit_shortfall: { old: 0, new: depositShortfall },
    },
  });

  logAudit(admin, {
    entityType: "contract",
    entityId: sourceId,
    action: "update",
    performedBy: actor.system ? "system" : actor.id,
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
  const needsApproval = !actor.system && actor.role !== "admin" && (escalationPct < parentEscPct || escalationPct === 0);
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
        requested_by: actor.id,
        reason: `${approvalType === "escalation_waiver" ? "Escalation waiver" : "Escalation reduction"} from ${parentEscPct}% to ${escalationPct}% on renewal of ${source.contract_number}`,
        metadata: {
          parent_contract_id: sourceId,
          parent_contract_number: source.contract_number,
          parent_escalation_percentage: parentEscPct,
          proposed_escalation_percentage: escalationPct,
          parent_subtotal: Number(source.subtotal),
          proposed_subtotal: newSubtotal,
          requested_by_name: actor.full_name,
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

  return {
    ok: true,
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
  };
}

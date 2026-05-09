import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

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
 *   { tenure_months?, seats?, start_date?, billing_cycle? }
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
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  // 1. Fetch the source contract
  const { data: source, error: fetchErr } = await supabase
    .from("contracts")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !source) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (!["active", "expired"].includes(source.status)) {
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

  // Calculate next billing date
  const nextBillingDate = new Date(startDate);
  switch (billingCycle) {
    case "monthly": nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 1); break;
    case "quarterly": nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 3); break;
    case "half_yearly": nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 6); break;
    case "yearly": nextBillingDate.setUTCMonth(nextBillingDate.getUTCMonth() + 12); break;
  }

  // 4. Apply escalation to items
  const escalationPct = Number(source.escalation_percentage || 10);
  const escalationMultiplier = 1 + escalationPct / 100;

  type Item = { description: string; quantity: number; unit_price: number; total: number; unit?: string };
  const oldItems = (source.items || []) as Item[];
  const newItems: Item[] = oldItems.map((item) => {
    const newUnitPrice = Math.round(item.unit_price * escalationMultiplier * 100) / 100;
    const newTotal = Math.round(newUnitPrice * item.quantity * 100) / 100;
    return { ...item, unit_price: newUnitPrice, total: newTotal };
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
      notice_period_months: source.notice_period_months,
      member_signatory_name: source.member_signatory_name,
      member_signatory_designation: source.member_signatory_designation,
      member_signatory_pan: source.member_signatory_pan,
      member_signatory_id_type: source.member_signatory_id_type || "pan",
      agreement_date: new Date().toISOString().slice(0, 10),
      department_id: source.department_id,
      // Renewal-specific fields
      parent_contract_id: id,
      is_renewal: true,
      renewal_sequence: renewalSequence,
      deposit_carried_from: id,
      deposit_shortfall: depositShortfall,
      created_by: dbUser.id,
    })
    .select("id, contract_number")
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // 7. Set source contract status to "renewed"
  await admin
    .from("contracts")
    .update({ status: "renewed", renewed_at: new Date().toISOString() })
    .eq("id", id);

  // 8. Copy approved KYC documents
  const { data: kycDocs } = await admin
    .from("contract_documents")
    .select("document_id, document_type, label, is_required, status, reviewed_by, reviewed_at, notes")
    .eq("contract_id", id)
    .eq("status", "approved");

  if (kycDocs && kycDocs.length > 0) {
    const kycInserts = kycDocs.map((doc) => ({
      contract_id: newContract.id,
      document_id: doc.document_id,
      document_type: doc.document_type,
      label: doc.label,
      is_required: doc.is_required,
      status: "approved",
      reviewed_by: doc.reviewed_by,
      reviewed_at: doc.reviewed_at,
      notes: doc.notes ? `${doc.notes} [carried from ${source.contract_number}]` : `Carried from ${source.contract_number}`,
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

  // 11. Audit trail
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
      status: { old: source.status, new: "renewed" },
      renewal_contract_id: { old: null, new: newContract.id },
      renewal_contract_number: { old: null, new: newContract.contract_number },
    },
  });

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
    },
  }, { status: 201 });
}

/**
 * PATCH /api/contracts/[id]/renew
 *
 * Admin-only: waive escalation on a renewal draft, or restore it.
 *
 * Body: { waive_escalation: true, waiver_reason: "..." }
 *    or { waive_escalation: false }
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
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admins can waive escalation" }, { status: 403 });
  }

  const body = await request.json();
  const waive = body.waive_escalation === true;

  // Fetch the renewal contract
  const admin = createAdminClient();
  const { data: contract } = await admin
    .from("contracts")
    .select("*, parent:contracts!contracts_parent_contract_id_fkey(id, items, subtotal)")
    .eq("id", id)
    .single();

  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (!contract.is_renewal) return NextResponse.json({ error: "Not a renewal contract" }, { status: 400 });
  if (contract.status !== "draft") return NextResponse.json({ error: "Can only modify escalation on draft renewals" }, { status: 400 });

  if (waive) {
    if (!body.waiver_reason?.trim()) {
      return NextResponse.json({ error: "Waiver reason is required" }, { status: 400 });
    }

    // Restore parent contract's original prices (no escalation)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parent = contract.parent as any;
    if (!parent) return NextResponse.json({ error: "Parent contract not found" }, { status: 400 });

    type Item = { description: string; quantity: number; unit_price: number; total: number; unit?: string };
    const parentItems = (Array.isArray(parent) ? parent[0]?.items : parent.items) as Item[] || [];
    const parentSubtotal = Number(Array.isArray(parent) ? parent[0]?.subtotal : parent.subtotal) || 0;

    const taxPercentage = Number(contract.tax_percentage || 18);
    const discountPercentage = Number(contract.discount_percentage || 0);
    const discountAmount = Math.round(parentSubtotal * (discountPercentage / 100) * 100) / 100;
    const taxableAmount = parentSubtotal - discountAmount;
    const taxAmount = Math.round(taxableAmount * (taxPercentage / 100) * 100) / 100;
    const totalAmount = taxableAmount + taxAmount;

    // Recalculate deposit shortfall (0 when no escalation)
    const secDepMonths = Number(contract.security_deposit_months || 3);
    const oldDeposit = parentSubtotal * secDepMonths;
    const newDeposit = parentSubtotal * secDepMonths;
    const depositShortfall = Math.max(0, Math.round((newDeposit - oldDeposit) * 100) / 100);

    await admin
      .from("contracts")
      .update({
        items: parentItems,
        subtotal: parentSubtotal,
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
        subtotal: { old: Number(contract.subtotal), new: parentSubtotal },
      },
    });

    return NextResponse.json({ success: true, escalation_waived: true, new_subtotal: parentSubtotal });
  } else {
    // Restore escalation — re-apply from parent's prices
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parent = contract.parent as any;
    if (!parent) return NextResponse.json({ error: "Parent contract not found" }, { status: 400 });

    type Item = { description: string; quantity: number; unit_price: number; total: number; unit?: string };
    const parentItems = (Array.isArray(parent) ? parent[0]?.items : parent.items) as Item[] || [];
    const escalationPct = Number(contract.escalation_percentage || 10);
    const multiplier = 1 + escalationPct / 100;

    const newItems: Item[] = parentItems.map((item) => {
      const newUnitPrice = Math.round(item.unit_price * multiplier * 100) / 100;
      const newTotal = Math.round(newUnitPrice * item.quantity * 100) / 100;
      return { ...item, unit_price: newUnitPrice, total: newTotal };
    });

    const newSubtotal = newItems.reduce((sum, i) => sum + i.total, 0);
    const taxPercentage = Number(contract.tax_percentage || 18);
    const discountPercentage = Number(contract.discount_percentage || 0);
    const discountAmount = Math.round(newSubtotal * (discountPercentage / 100) * 100) / 100;
    const taxableAmount = newSubtotal - discountAmount;
    const taxAmount = Math.round(taxableAmount * (taxPercentage / 100) * 100) / 100;
    const totalAmount = taxableAmount + taxAmount;

    const secDepMonths = Number(contract.security_deposit_months || 3);
    const parentSub = Number(Array.isArray(parent) ? parent[0]?.subtotal : parent.subtotal) || 0;
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

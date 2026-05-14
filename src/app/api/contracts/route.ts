import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createContractSchema } from "@/lib/validations";
import { autoUpdateLeadStatus } from "@/lib/auto-status";
import { logAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const status = searchParams.get("status");
  const leadId = searchParams.get("lead_id");
  const search = searchParams.get("search");
  const expiringSoon = searchParams.get("expiring_soon"); // "30" or "60"
  const parentContractId = searchParams.get("parent_contract_id");
  const isRenewal = searchParams.get("is_renewal");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("contracts")
    .select("*, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email), location:locations!contracts_location_id_fkey(id, name, code), service_quotas:contract_service_quotas(count)", { count: "exact" });

  if (status) query = query.eq("status", status);
  if (leadId) query = query.eq("lead_id", leadId);
  if (parentContractId) query = query.eq("parent_contract_id", parentContractId);
  if (isRenewal === "true") query = query.eq("is_renewal", true);
  if (search) query = query.or(`contract_number.ilike.%${search}%,title.ilike.%${search}%`);

  // "Expiring soon" filter: active contracts ending within N days
  if (expiringSoon) {
    const days = parseInt(expiringSoon) || 60;
    const todayStr = new Date().toISOString().split("T")[0];
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);
    const futureStr = futureDate.toISOString().split("T")[0];
    query = query.eq("status", "active").gte("end_date", todayStr).lte("end_date", futureStr);
  }

  const orderCol = expiringSoon ? "end_date" : "created_at";
  query = query.order(orderCol, { ascending: !!expiringSoon }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const result = createContractSchema.safeParse(body);
  if (!result.success) {
    const fieldErrors = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    return NextResponse.json({ error: `Validation failed: ${fieldErrors}`, details: result.error.issues }, { status: 400 });
  }

  const d = result.data;
  let title = d.workspace_description;
  let items = [{ description: d.workspace_description, quantity: d.seats, unit_price: d.monthly_membership_fee / d.seats, total: d.monthly_membership_fee }];
  let subtotal = d.monthly_membership_fee;
  let taxPercentage = 18;
  let taxAmount = subtotal * (taxPercentage / 100);
  let discountPercentage = 0;
  let discountAmount = 0;
  let totalAmount = d.monthly_membership_fee;
  let proposalLocationId: string | null = null;

  // If proposal provided, inherit financials from it
  if (d.proposal_id) {
    const { data: proposal, error: proposalError } = await supabase
      .from("proposals")
      .select("*")
      .eq("id", d.proposal_id)
      .single();

    if (proposalError || !proposal) {
      return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    }
    if (proposal.status !== "accepted") {
      return NextResponse.json({ error: "Proposal must be accepted before creating a contract" }, { status: 400 });
    }

    title = proposal.title;
    items = proposal.items;
    subtotal = proposal.subtotal;
    taxPercentage = proposal.tax_percentage;
    taxAmount = proposal.tax_amount;
    discountPercentage = proposal.discount_percentage;
    discountAmount = proposal.discount_amount;
    totalAmount = proposal.total_amount;
    proposalLocationId = proposal.location_id;
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  // Calculate end_date from start_date + tenure_months, minus 1 day.
  // A contract starting Nov 1 for 11 months ends Sep 30 (last day of month 11),
  // not Oct 1 (which is the start of month 12).
  const startDate = new Date(d.start_date);
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + d.tenure_months);
  endDate.setDate(endDate.getDate() - 1);

  // Calculate next_billing_date based on billing_cycle
  const nextBillingDate = new Date(startDate);
  switch (d.billing_cycle) {
    case "monthly": nextBillingDate.setMonth(nextBillingDate.getMonth() + 1); break;
    case "quarterly": nextBillingDate.setMonth(nextBillingDate.getMonth() + 3); break;
    case "half_yearly": nextBillingDate.setMonth(nextBillingDate.getMonth() + 6); break;
    case "yearly": nextBillingDate.setMonth(nextBillingDate.getMonth() + 12); break;
  }

  const { data, error } = await supabase
    .from("contracts")
    .insert({
      lead_id: d.lead_id,
      proposal_id: d.proposal_id || null,
      title,
      status: "draft",
      items,
      subtotal,
      tax_percentage: taxPercentage,
      tax_amount: taxAmount,
      discount_percentage: discountPercentage,
      discount_amount: discountAmount,
      total_amount: totalAmount,
      billing_cycle: d.billing_cycle,
      tenure_months: d.tenure_months,
      start_date: d.start_date,
      end_date: endDate.toISOString().split("T")[0],
      next_billing_date: nextBillingDate.toISOString().split("T")[0],
      seats: d.seats,
      terms_and_conditions: d.terms_and_conditions,
      notes: d.notes,
      location_id: d.location_id || proposalLocationId || null,
      // Membership agreement fields
      workspace_description: d.workspace_description,
      parking_space: d.parking_space,
      complimentary_services: d.complimentary_services,
      security_deposit_months: d.security_deposit_months,
      escalation_percentage: d.escalation_percentage,
      notice_period_months: d.notice_period_months,
      member_signatory_name: d.member_signatory_name,
      member_signatory_designation: d.member_signatory_designation,
      member_signatory_pan: d.member_signatory_pan ?? null,
      member_signatory_id_type: d.member_signatory_id_type ?? 'pan',
      agreement_date: d.agreement_date,
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (data && dbUser?.id) {
    logAudit(supabase, {
      entityType: "contract",
      entityId: data.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: data } },
    });

    // Direct (no proposal) contract with a future start date — flag for review.
    // The UI warns the user, but we also log server-side so there is an
    // immutable audit trail regardless of how the request was made.
    const today = new Date().toISOString().slice(0, 10);
    if (!d.proposal_id && d.start_date > today) {
      logAudit(supabase, {
        entityType: "contract",
        entityId: data.id,
        action: "direct_future_contract",
        performedBy: dbUser.id,
        changes: {
          note: {
            old: null,
            new: `Direct contract created without a proposal and with a future start date (${d.start_date}). No deposit or pro-rata was collected through the CRM.`,
          },
        },
      });
    }
  }

  // ── Copy proposal_service_quotas → contract_service_quotas ────────────────
  // This is the primary path: quotas negotiated on the proposal carry over to
  // the contract so the Service Quotas section is pre-populated without any
  // manual re-entry. Billing uses contract_service_quotas for overage charges.
  if (data && d.proposal_id) {
    try {
      const { data: psqRows } = await supabase
        .from("proposal_service_quotas")
        .select("service_id, monthly_quota, overage_rate")
        .eq("proposal_id", d.proposal_id);

      if (psqRows && psqRows.length > 0) {
        const csqRows = psqRows.map(q => ({
          contract_id: data.id,
          service_id: q.service_id,
          monthly_quota: q.monthly_quota,
          overage_rate: q.overage_rate,
          created_by: dbUser?.id ?? null,
        }));
        await supabase.from("contract_service_quotas").insert(csqRows);
      }
    } catch (err) {
      console.error("[contracts] Failed to copy proposal_service_quotas:", err);
    }
  }

  // ── Legacy: seed contract_facilities from proposal complimentary_items ─────
  // Kept for backward compatibility with proposals created before service quotas
  // were wired up. New proposals write to proposal_service_quotas instead.
  if (data && d.proposal_id) {
    try {
      const { data: proposalData } = await supabase
        .from("proposals")
        .select("complimentary_items")
        .eq("id", d.proposal_id)
        .single();

      type ComplimentaryItem = {
        name: string;
        unit: string;
        quantity: number;
        price_per_unit: number;
        service_id?: string;
      };

      const legacyItems = proposalData?.complimentary_items as ComplimentaryItem[] | null;

      if (legacyItems && legacyItems.length > 0) {
        const facilitiesToInsert = legacyItems
          .filter((item) => item.name?.trim() && item.unit?.trim())
          .map((item) => ({
            contract_id: data.id,
            name: item.name.trim(),
            unit: item.unit.trim(),
            free_quota: Number(item.quantity) || 0,
            cost_per_unit: Number(item.price_per_unit) || 0,
            created_by: dbUser?.id ?? null,
          }));

        if (facilitiesToInsert.length > 0) {
          await supabase.from("contract_facilities").insert(facilitiesToInsert);
        }
      }
    } catch (err) {
      console.error("[contracts] Failed to seed contract_facilities from proposal:", err);
    }
  }

  return NextResponse.json({ data }, { status: 201 });
}

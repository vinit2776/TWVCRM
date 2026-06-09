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
  const terminatedAfter = searchParams.get("terminated_after"); // ISO date — include terminated contracts after this date

  const offset = (page - 1) * limit;

  // ── Search path: use RPC for cross-table full-text search ────────────────────
  // Supabase's .or() cannot filter on embedded relation columns (leads, locations).
  // The search_contracts RPC does a proper JOIN with ILIKE across contract_number,
  // title, lead first/last name, company, email, and location name/code.
  // Non-search queries (lead_id, parent_contract_id, is_renewal) still use the
  // direct query path because the RPC doesn't support those filters.
  const useRpc = !!(search || expiringSoon || status) && !leadId && !parentContractId && !isRenewal;

  if (useRpc) {
    const expiringDays = expiringSoon ? (parseInt(expiringSoon) || 60) : null;
    const { data: rpcRows, error: rpcErr } = await supabase.rpc("search_contracts", {
      p_search:        search   || null,
      p_status:        status   || null,
      p_expiring_days: expiringDays,
      p_limit:         limit,
      p_offset:        offset,
    });
    if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 });

    const rows = (rpcRows ?? []) as { data: Record<string, unknown>; total_count: number }[];
    const total = rows[0]?.total_count ?? 0;
    return NextResponse.json({
      data: rows.map(r => r.data),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  }

  // ── Direct query path (lead_id, parent_contract_id, is_renewal filters) ──────
  let query = supabase
    .from("contracts")
    .select(`
      *,
      lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email),
      location:locations!contracts_location_id_fkey(id, name, code),
      facility_quotas:contract_facilities(count)
    `, { count: "exact" });

  if (status) query = query.eq("status", status);
  if (terminatedAfter) query = query.gte("terminated_at", terminatedAfter);
  if (leadId) query = query.eq("lead_id", leadId);
  if (parentContractId) query = query.eq("parent_contract_id", parentContractId);
  if (isRenewal === "true") query = query.eq("is_renewal", true);

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

  // Proposal is mandatory — all financials come from it.
  const { data: proposal, error: proposalError } = await supabase
    .from("proposals")
    .select("*")
    .eq("id", d.proposal_id)
    .single();

  if (proposalError || !proposal) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }
  if (proposal.status !== "accepted") {
    return NextResponse.json(
      { error: "Proposal must be accepted (and deposit + pro-rata collected) before creating a contract" },
      { status: 400 }
    );
  }

  const title = proposal.title;
  const items = proposal.items;
  const subtotal = proposal.subtotal;
  const taxPercentage = proposal.tax_percentage;
  const taxAmount = proposal.tax_amount;
  const discountPercentage = proposal.discount_percentage;
  const discountAmount = proposal.discount_amount;
  const totalAmount = proposal.total_amount;
  const proposalLocationId: string | null = proposal.location_id;

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  // End date: use the explicit end_date when the form supplies one (the
  // start/end-date picker). Otherwise derive it from start_date + tenure_months
  // minus 1 day — a contract starting Nov 1 for 11 months ends Sep 30.
  const startDate = new Date(d.start_date);
  let endDateStr: string;
  if (d.end_date) {
    endDateStr = d.end_date;
  } else {
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + d.tenure_months);
    endDate.setDate(endDate.getDate() - 1);
    endDateStr = endDate.toISOString().split("T")[0];
  }

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
      proposal_id: d.proposal_id,
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
      end_date: endDateStr,
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
      lock_in_months: d.lock_in_months ?? null,
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

  }

  // ── Copy proposal_service_quotas → contract_service_quotas ────────────────
  if (data) {
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
  if (data) {
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

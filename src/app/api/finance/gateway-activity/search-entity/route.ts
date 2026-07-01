import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/finance/gateway-activity/search-entity
 *
 * Searches across contracts, bookings, and billing statements for
 * manual link target selection. Returns a unified list of matches.
 *
 * Query params:
 *   q     string  (min 2 chars)
 *   type  "contract" | "booking" | "billing_statement" | "all"  (default: all)
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  const ALLOWED = ["admin", "manager", "accounts"];
  if (!dbUser || !ALLOWED.includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const q    = (searchParams.get("q") || "").trim();
  const type = searchParams.get("type") || "all";

  if (q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const admin = createAdminClient();
  const like  = `%${q}%`;

  type SearchResult = {
    entity_type: "contract" | "booking" | "billing_statement";
    entity_id:   string;
    ref:         string;
    customer:    string;
    detail:      string;
    status:      string | null;
  };

  const results: SearchResult[] = [];

  // Find lead IDs matching the search term (used by contracts + bookings)
  const { data: matchedLeads } = await admin
    .from("leads")
    .select("id, first_name, last_name, company")
    .or(`first_name.ilike.${like},last_name.ilike.${like},company.ilike.${like}`)
    .limit(50);

  const leadMap = new Map<string, { name: string }>();
  for (const l of matchedLeads ?? []) {
    const name = [l.first_name, l.last_name].filter(Boolean).join(" ") || l.company || "—";
    leadMap.set(l.id, { name });
  }
  const matchedLeadIds = [...leadMap.keys()];

  // ── Contracts ─────────────────────────────────────────────────────────────
  if (type === "all" || type === "contract") {
    // Search by contract_number
    const { data: byRef } = await admin
      .from("contracts")
      .select("id, contract_number, status, monthly_rent, start_date, lead_id")
      .ilike("contract_number", like)
      .limit(10);

    // Search by lead name (if any leads matched)
    const { data: byLeadId } = matchedLeadIds.length > 0
      ? await admin
          .from("contracts")
          .select("id, contract_number, status, monthly_rent, start_date, lead_id")
          .in("lead_id", matchedLeadIds)
          .limit(10)
      : { data: [] };

    // Also fetch lead info for contract_number matches that may not be in leadMap
    const refLeadIds = (byRef ?? []).map(c => c.lead_id).filter(Boolean) as string[];
    const extraLeadMap = new Map<string, { name: string }>();
    if (refLeadIds.length > 0) {
      const { data: extraLeads } = await admin
        .from("leads")
        .select("id, first_name, last_name, company")
        .in("id", refLeadIds);
      for (const l of extraLeads ?? []) {
        const name = [l.first_name, l.last_name].filter(Boolean).join(" ") || l.company || "—";
        extraLeadMap.set(l.id, { name });
      }
    }
    const allLeadMap = new Map([...extraLeadMap, ...leadMap]);

    const seen = new Set<string>();
    for (const c of [...(byRef ?? []), ...(byLeadId ?? [])]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const leadInfo = c.lead_id ? allLeadMap.get(c.lead_id) : undefined;
      results.push({
        entity_type: "contract",
        entity_id:   c.id,
        ref:         c.contract_number,
        customer:    leadInfo?.name ?? "—",
        detail:      `₹${c.monthly_rent?.toLocaleString("en-IN") ?? "—"}/mo · from ${c.start_date ?? "—"}`,
        status:      c.status ?? null,
      });
    }
  }

  // ── Bookings ──────────────────────────────────────────────────────────────
  if (type === "all" || type === "booking") {
    const { data: byRef } = await admin
      .from("bookings")
      .select("id, booking_number, status, total_amount, booking_date, lead_id")
      .ilike("booking_number", like)
      .limit(10);

    const { data: byLeadId } = matchedLeadIds.length > 0
      ? await admin
          .from("bookings")
          .select("id, booking_number, status, total_amount, booking_date, lead_id")
          .in("lead_id", matchedLeadIds)
          .limit(10)
      : { data: [] };

    // Fetch lead info for booking_number matches
    const refLeadIds = (byRef ?? []).map(b => b.lead_id).filter(Boolean) as string[];
    const extraLeadMap = new Map<string, { name: string }>();
    if (refLeadIds.length > 0) {
      const { data: extraLeads } = await admin
        .from("leads")
        .select("id, first_name, last_name, company")
        .in("id", refLeadIds);
      for (const l of extraLeads ?? []) {
        const name = [l.first_name, l.last_name].filter(Boolean).join(" ") || l.company || "—";
        extraLeadMap.set(l.id, { name });
      }
    }
    const allLeadMap = new Map([...extraLeadMap, ...leadMap]);

    const seen = new Set<string>();
    for (const b of [...(byRef ?? []), ...(byLeadId ?? [])]) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      const leadInfo = b.lead_id ? allLeadMap.get(b.lead_id) : undefined;
      results.push({
        entity_type: "booking",
        entity_id:   b.id,
        ref:         b.booking_number,
        customer:    leadInfo?.name ?? "—",
        detail:      `₹${b.total_amount?.toLocaleString("en-IN") ?? "—"} · ${b.booking_date ?? "—"}`,
        status:      b.status ?? null,
      });
    }
  }

  // ── Billing Statements ────────────────────────────────────────────────────
  if (type === "all" || type === "billing_statement") {
    const { data: stmts } = await admin
      .from("billing_statements")
      .select(`
        id, statement_number, status, total_amount, billing_period_start,
        contracts!billing_statements_contract_id_fkey(
          contract_number,
          leads!contracts_lead_id_fkey(first_name, last_name, company)
        )
      `)
      .ilike("statement_number", like)
      .limit(10);

    const seen = new Set<string>();
    for (const s of stmts ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contract = Array.isArray((s as any).contracts) ? (s as any).contracts[0] : (s as any).contracts;
      const lead = contract?.leads
        ? (Array.isArray(contract.leads) ? contract.leads[0] : contract.leads)
        : null;
      const name = lead
        ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company || "—"
        : "—";
      results.push({
        entity_type: "billing_statement",
        entity_id:   s.id,
        ref:         s.statement_number,
        customer:    name,
        detail:      `₹${s.total_amount?.toLocaleString("en-IN") ?? "—"} · ${s.billing_period_start ?? "—"}`,
        status:      s.status ?? null,
      });
    }
  }

  return NextResponse.json({ results: results.slice(0, 20) });
}

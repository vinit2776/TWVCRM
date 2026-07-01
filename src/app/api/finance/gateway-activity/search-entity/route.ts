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

  // ── Contracts ─────────────────────────────────────────────────────────────
  if (type === "all" || type === "contract") {
    const { data: contracts } = await admin
      .from("contracts")
      .select(`
        id, contract_number, status, monthly_rent, start_date,
        leads(first_name, last_name, company)
      `)
      .or(`contract_number.ilike.${like}`)
      .limit(10);

    // Also search by lead name/company
    const { data: byLead } = await admin
      .from("contracts")
      .select(`
        id, contract_number, status, monthly_rent, start_date,
        leads!inner(first_name, last_name, company)
      `)
      .or(`leads.first_name.ilike.${like},leads.last_name.ilike.${like},leads.company.ilike.${like}`)
      .limit(10);

    const seen = new Set<string>();
    for (const c of [...(contracts ?? []), ...(byLead ?? [])]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = Array.isArray((c as any).leads) ? (c as any).leads[0] : (c as any).leads;
      const name = lead
        ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company || "—"
        : "—";
      results.push({
        entity_type: "contract",
        entity_id:   c.id,
        ref:         c.contract_number,
        customer:    name,
        detail:      `₹${c.monthly_rent?.toLocaleString("en-IN") ?? "—"}/mo · from ${c.start_date ?? "—"}`,
        status:      c.status ?? null,
      });
    }
  }

  // ── Bookings ──────────────────────────────────────────────────────────────
  if (type === "all" || type === "booking") {
    const { data: bookings } = await admin
      .from("bookings")
      .select(`
        id, booking_number, status, total_amount, booking_date,
        leads(first_name, last_name, company)
      `)
      .or(`booking_number.ilike.${like}`)
      .limit(10);

    const { data: byLeadB } = await admin
      .from("bookings")
      .select(`
        id, booking_number, status, total_amount, booking_date,
        leads!inner(first_name, last_name, company)
      `)
      .or(`leads.first_name.ilike.${like},leads.last_name.ilike.${like},leads.company.ilike.${like}`)
      .limit(10);

    const seen = new Set<string>();
    for (const b of [...(bookings ?? []), ...(byLeadB ?? [])]) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = Array.isArray((b as any).leads) ? (b as any).leads[0] : (b as any).leads;
      const name = lead
        ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company || "—"
        : "—";
      results.push({
        entity_type: "booking",
        entity_id:   b.id,
        ref:         b.booking_number,
        customer:    name,
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
        contracts(
          contract_number,
          leads(first_name, last_name, company)
        )
      `)
      .or(`statement_number.ilike.${like}`)
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

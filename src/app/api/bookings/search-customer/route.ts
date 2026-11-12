import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isContractOperational } from "@/lib/constants";

/**
 * GET /api/bookings/search-customer?q=<phone_or_name_or_company>
 * Searches across leads (phone/mobile/name/company), past bookings
 * (booker_phone/guest_name/guest_phone/guest_company), and voucher issuances
 * (seat_occupant_email) to find repeat customers.
 * Returns a unified list of customer suggestions with their details.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  if (!q || q.length < 3) {
    return NextResponse.json({ data: [] });
  }

  // Fire all three search queries in parallel — they're independent.
  // The trgm GIN indexes on leads (first_name, last_name, phone, company) and
  // bookings (guest_name, guest_phone, booker_phone) make each ILIKE
  // use the index instead of a sequential scan.
  const [
    { data: leads },
    { data: pastBookings },
    { data: matchingLeadIds },
  ] = await Promise.all([
    // 1. Search leads by phone, mobile, name, or company
    supabase
      .from("leads")
      .select("id, first_name, last_name, company, email, phone, mobile")
      .is("archived_at", null)
      .or(`phone.ilike.%${q}%,mobile.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%,company.ilike.%${q}%`)
      .limit(10),
    // 2. Search past bookings for repeat walk-in / guest customers
    supabase
      .from("bookings")
      .select("booker_phone, guest_name, guest_email, guest_phone, guest_company, customer_type, lead_id")
      .or(`booker_phone.ilike.%${q}%,guest_phone.ilike.%${q}%,guest_name.ilike.%${q}%,guest_company.ilike.%${q}%`)
      .is("lead_id", null)
      .order("created_at", { ascending: false })
      .limit(20),
    // 3. Find lead IDs matching the search (for contract lookup)
    supabase
      .from("leads")
      .select("id")
      .is("archived_at", null)
      .or(`phone.ilike.%${q}%,mobile.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%,company.ilike.%${q}%`)
      .limit(20),
  ]);

  // 4. Fetch contracts only for matching leads (instead of all active + JS filter)
  const leadIdList = (matchingLeadIds || []).map((l) => l.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let matchingContracts: any[] = [];
  if (leadIdList.length > 0) {
    const { data: contracts } = await supabase
      .from("contracts")
      .select("id, contract_number, status, end_date, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile)")
      .in("status", ["active", "renewal_in_progress"])
      .in("lead_id", leadIdList)
      .limit(20);
    matchingContracts = (contracts || []).filter(isContractOperational);
  }

  // Build unified results
  type CustomerSuggestion = {
    type: "lead" | "past_guest" | "contract";
    id?: string;
    name: string;
    phone?: string;
    email?: string;
    company?: string;
    contract_id?: string;
    contract_number?: string;
    lead_id?: string;
  };

  const results: CustomerSuggestion[] = [];
  const seen = new Set<string>(); // dedupe by phone
  const leadIdsWithContract = new Set<string>(); // suppress the redundant plain-lead row below

  // Add matching contracts first — a contract is the strongest, most specific
  // match for a customer and should outrank a plain lead row in the picker so
  // staff don't accidentally book a contract holder as a walk-in because an
  // unrelated/duplicate lead record with the same phone number sorted first.
  for (const c of matchingContracts) {
    const lead = c.lead as unknown as { id: string; first_name: string; last_name: string; company?: string; email?: string; phone?: string; mobile?: string } | null;
    if (!lead) continue;
    const key = `contract-${c.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      leadIdsWithContract.add(lead.id);
      results.push({
        type: "contract",
        id: c.id,
        contract_id: c.id,
        contract_number: c.contract_number,
        lead_id: lead.id,
        name: `${lead.first_name} ${lead.last_name}`,
        phone: lead.mobile || lead.phone || undefined,
        email: lead.email || undefined,
        company: lead.company || undefined,
      });
    }
  }

  // Add leads — skip any lead already represented by a contract suggestion
  // above, so the same contract holder doesn't show up twice in the picker.
  for (const l of leads || []) {
    if (leadIdsWithContract.has(l.id)) continue;
    const phone = l.mobile || l.phone || "";
    const key = `lead-${l.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({
        type: "lead",
        id: l.id,
        lead_id: l.id,
        name: `${l.first_name} ${l.last_name}`,
        phone,
        email: l.email || undefined,
        company: l.company || undefined,
      });
    }
  }

  // Add past guests (no lead association)
  for (const b of pastBookings || []) {
    if (!b.guest_name) continue;
    const phone = b.booker_phone || b.guest_phone || "";
    const key = `guest-${phone}-${b.guest_name}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({
        type: "past_guest",
        name: b.guest_name,
        phone,
        email: b.guest_email || undefined,
        company: b.guest_company || undefined,
      });
    }
  }

  return NextResponse.json({ data: results.slice(0, 20) });
}

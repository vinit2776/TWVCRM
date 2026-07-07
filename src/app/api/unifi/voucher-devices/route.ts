/**
 * GET /api/unifi/voucher-devices?location_id=<id>
 *
 * Resolves UniFi guest-portal sessions back to the CRM customer that
 * voucher was issued to, and groups devices by customer, in three tiers:
 *
 *  1. "confirmed" — resolved via an explicit database link:
 *     - contract seat vouchers: note = "{contract_number}_seat{N}"
 *       (src/app/api/contracts/[id]/vouchers/route.ts)
 *     - booking seat vouchers:  note = "booking_{bookingId}_seat{N}"
 *       (src/app/api/bookings/[id]/vouchers/route.ts)
 *     - ad-hoc vouchers explicitly linked to a contract at issuance time
 *       (unifi_device_labels... no — unifi_adhoc_voucher_links, populated
 *       when staff pick a contract in the "Issue Ad-hoc" dialog)
 *  2. "suggested" — ad-hoc vouchers with a free-text note that isn't linked
 *     to anything, but loosely resolved via one of two best-effort passes,
 *     shown separately so staff can verify rather than treating it as
 *     ground truth:
 *       a. token overlap against a contract's lead/company name at this
 *          location (e.g. "BDart_Rajesh" ~ "BDART TECHNOLOGIES ... LTD")
 *       b. cabin/seat name match — the note references a physical space
 *          (e.g. "cabin04", "Acko cabin 8") that has a currently-active
 *          contract allocation at this location
 *  3. "unmatched" — no signal at all.
 *
 * Sessions carry the voucher's `name` field (mirrors UniFi's `note`); `code`
 * is used as a fallback since some consoles don't populate it reliably.
 * A manual label from unifi_device_labels overrides the displayed device
 * name regardless of tier.
 *
 * Auth required: admin, manager, it_manager, it_technician.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cachedUnifiRequest, siteConfigFromLocation } from "@/lib/unifi";

interface UnifiGuestSession {
  mac: string;
  hostname?: string;
  name?: string;
  code?: string;
  bytes?: number;
  start?: number;
  end?: number;
}

type ParsedNote =
  | { kind: "contract"; contractNumber: string; seatNumber: number }
  | { kind: "booking"; bookingId: string; seatNumber: number }
  | null;

function parseVoucherNote(note: string | undefined): ParsedNote {
  if (!note) return null;
  const bookingMatch = note.match(/^booking_(.+)_seat(\d+)$/);
  if (bookingMatch) {
    return { kind: "booking", bookingId: bookingMatch[1], seatNumber: parseInt(bookingMatch[2], 10) };
  }
  const contractMatch = note.match(/^(.+)_seat(\d+)$/);
  if (contractMatch) {
    return { kind: "contract", contractNumber: contractMatch[1], seatNumber: parseInt(contractMatch[2], 10) };
  }
  return null;
}

interface GroupInfo {
  customer_name: string | null;
  sub_label: string | null;
  contract_number: string | null;
  booking_number: string | null;
  group_key: string;
}

interface DeviceLabelRow {
  mac: string;
  label: string;
}

function anonymizeMac(mac: string): string {
  const parts = mac.split(":");
  if (parts.length !== 6) return mac;
  return `••:••:••:••:${parts[4]}:${parts[5]}`;
}

function leadName(lead: { first_name: string | null; last_name: string | null; company: string | null } | null): string | null {
  if (!lead) return null;
  const name = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();
  return name || lead.company || null;
}

// Normalize for fuzzy comparison: lowercase, strip punctuation/digits/# noise.
function normalizeForFuzzy(s: string): string {
  return s.toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

// Generic words that appear in many legal entity names — excluded from token
// matching so e.g. "private limited" doesn't spuriously match "private" in
// an unrelated note.
const STOPWORDS = new Set([
  "private", "limited", "pvt", "ltd", "llp", "llc", "inc", "co", "company",
  "technologies", "technology", "solutions", "services", "systems", "corp",
  "corporation", "enterprises", "industries", "international", "and", "the",
  "opc", "associates", "group",
]);

function significantTokens(normalized: string): string[] {
  return normalized.split(" ").filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

// Cabin/seat name normalization: lowercase, strip everything but letters and
// digits (so "Cabin 04", "cabin04", "CABIN_4" all reduce comparably), then
// strip leading zeros from any trailing digit run so "cabin04" == "cabin4".
function normalizeCabin(s: string): string {
  const stripped = s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return stripped.replace(/0+(\d)$/, "$1");
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const allowed = ["admin", "manager", "it_manager", "it_technician"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }
  const isAdmin = dbUser.role === "admin";

  const locationId = request.nextUrl.searchParams.get("location_id");
  let siteCfg = undefined;
  if (locationId) {
    const { data: loc } = await supabase
      .from("locations").select("unifi_console_id, unifi_site_id").eq("id", locationId).single();
    if (loc) siteCfg = siteConfigFromLocation(loc);
  }

  try {
    const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    const sessions = await cachedUnifiRequest<UnifiGuestSession[]>(
      `/stat/guest?_start=${sevenDaysAgo}`,
      {},
      60,
      siteCfg
    );

    const parsedBySession = sessions.map((s) => ({ session: s, note: s.name ?? s.code, parsed: parseVoucherNote(s.name ?? s.code) }));

    const contractNumbers = Array.from(new Set(
      parsedBySession.map((p) => p.parsed).filter((p): p is Extract<ParsedNote, { kind: "contract" }> => p?.kind === "contract").map((p) => p.contractNumber)
    ));
    const bookingIds = Array.from(new Set(
      parsedBySession.map((p) => p.parsed).filter((p): p is Extract<ParsedNote, { kind: "booking" }> => p?.kind === "booking").map((p) => p.bookingId)
    ));
    const adhocNotes = Array.from(new Set(
      parsedBySession.filter((p) => !p.parsed && p.note).map((p) => p.note as string)
    ));

    // Tier 1a: contract-seat + booking-seat exact matches via voucher_issuances.
    const issuanceByKey = new Map<string, GroupInfo>();

    if (contractNumbers.length > 0) {
      const { data: contracts } = await supabase
        .from("contracts")
        .select("id, contract_number")
        .in("contract_number", contractNumbers);

      const contractIds = (contracts ?? []).map((c) => c.id);
      if (contractIds.length > 0) {
        const { data: issuances } = await supabase
          .from("voucher_issuances")
          .select(`
            contract_id, seat_number,
            contract:contracts!voucher_issuances_contract_id_fkey(contract_number),
            lead:leads!voucher_issuances_lead_id_fkey(first_name, last_name, company),
            member:contract_members!voucher_issuances_member_id_fkey(name)
          `)
          .in("contract_id", contractIds);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const i of (issuances ?? []) as any[]) {
          const contractNumber = i.contract?.contract_number;
          if (!contractNumber) continue;
          issuanceByKey.set(`contract:${contractNumber}:${i.seat_number}`, {
            customer_name: leadName(i.lead),
            sub_label: i.member?.name ?? null,
            contract_number: contractNumber,
            booking_number: null,
            group_key: `contract:${i.contract_id}`,
          });
        }
      }
    }

    if (bookingIds.length > 0) {
      const { data: issuances } = await supabase
        .from("voucher_issuances")
        .select(`
          booking_id, seat_number,
          booking:bookings!voucher_issuances_booking_id_fkey(booking_number, guest_name)
        `)
        .in("booking_id", bookingIds);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const i of (issuances ?? []) as any[]) {
        if (!i.booking_id) continue;
        issuanceByKey.set(`booking:${i.booking_id}:${i.seat_number}`, {
          customer_name: i.booking?.guest_name ?? null,
          sub_label: null,
          contract_number: null,
          booking_number: i.booking?.booking_number ?? null,
          group_key: `booking:${i.booking_id}`,
        });
      }
    }

    // Tier 1b: ad-hoc vouchers explicitly linked to a contract at issuance time.
    const adhocContractByNote = new Map<string, string>(); // note -> contract_id
    if (adhocNotes.length > 0 && locationId) {
      const { data: links } = await supabase
        .from("unifi_adhoc_voucher_links")
        .select("note, contract_id, created_at")
        .eq("location_id", locationId)
        .in("note", adhocNotes)
        .not("contract_id", "is", null)
        .order("created_at", { ascending: false });
      for (const l of links ?? []) {
        if (!adhocContractByNote.has(l.note)) adhocContractByNote.set(l.note, l.contract_id as string);
      }
    }

    const linkedContractIds = Array.from(new Set(adhocContractByNote.values()));
    const contractInfoById = new Map<string, GroupInfo>();
    if (linkedContractIds.length > 0) {
      const { data: contracts } = await supabase
        .from("contracts")
        .select(`
          id, contract_number,
          lead:leads!contracts_lead_id_fkey(first_name, last_name, company)
        `)
        .in("id", linkedContractIds);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const c of (contracts ?? []) as any[]) {
        contractInfoById.set(c.id, {
          customer_name: leadName(c.lead),
          sub_label: null,
          contract_number: c.contract_number,
          booking_number: null,
          group_key: `contract:${c.id}`,
        });
      }
    }

    // Tier 2: fuzzy match remaining ad-hoc notes (no explicit link) against
    // this location's contracts' company/lead names.
    const notesNeedingFuzzy = adhocNotes.filter((n) => !adhocContractByNote.has(n));
    const fuzzyInfoByNote = new Map<string, GroupInfo>();
    if (notesNeedingFuzzy.length > 0 && locationId) {
      const { data: locContracts } = await supabase
        .from("contracts")
        .select(`
          id, contract_number,
          lead:leads!contracts_lead_id_fkey(first_name, last_name, company)
        `)
        .eq("location_id", locationId);

      const candidates = (locContracts ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => {
          const normalized = c.lead?.company ? normalizeForFuzzy(c.lead.company) : null;
          return {
            id: c.id as string,
            contract_number: c.contract_number as string,
            // Show the company name, not the personal contact name — that's
            // the actual text the match was based on, so it's what staff need
            // to see to verify the suggestion.
            name: c.lead?.company ?? leadName(c.lead),
            normalized,
            tokens: normalized ? significantTokens(normalized) : [],
          };
        })
        .filter((c) => c.tokens.length > 0);

      for (const note of notesNeedingFuzzy) {
        const normNote = normalizeForFuzzy(note);
        if (!normNote) continue;
        const noteTokens = new Set(significantTokens(normNote));
        // Full-substring match first (higher confidence), then fall back to
        // any shared distinctive word (catches e.g. "BDart_Rajesh" against
        // "BDART TECHNOLOGIES (OPC) PRIVATE LIMITED" — the note only shares
        // one word with the company name, not the whole string).
        const match =
          candidates.find((c) => c.normalized && (normNote.includes(c.normalized) || c.normalized.includes(normNote))) ??
          candidates.find((c) => c.tokens.some((t) => noteTokens.has(t)));
        if (match) {
          fuzzyInfoByNote.set(note, {
            customer_name: match.name,
            sub_label: null,
            contract_number: match.contract_number,
            booking_number: null,
            group_key: `suggested:${match.id}`,
          });
        }
      }
    }

    // Tier 3: cabin/seat name match — for notes still unresolved, check
    // whether the note references a physical space unit at this location
    // that currently has an active contract allocation.
    const notesNeedingCabin = notesNeedingFuzzy.filter((n) => !fuzzyInfoByNote.has(n));
    const cabinInfoByNote = new Map<string, GroupInfo>();
    if (notesNeedingCabin.length > 0 && locationId) {
      const { data: spaceUnits } = await supabase
        .from("space_units")
        .select(`
          id, name,
          active_allocations:contract_space_allocations(
            status,
            contract:contracts(id, contract_number, lead_id, lead:leads(first_name, last_name, company))
          )
        `)
        .eq("location_id", locationId)
        .eq("active_allocations.status", "active");

      const cabinCandidates = (spaceUnits ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .flatMap((u: any) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const alloc = (u.active_allocations ?? []).find((a: any) => a.status === "active" && a.contract);
          if (!alloc?.contract) return [];
          return [{
            normalized: normalizeCabin(u.name),
            cabinName: u.name as string,
            contractId: alloc.contract.id as string,
            contractNumber: alloc.contract.contract_number as string,
            // Prefer company name, consistent with the token-overlap pass —
            // if this cabin match and a company-name match resolve to the
            // same contract, they share a group_key and should display the
            // same, more-recognizable name regardless of which note the
            // group happened to be created from first.
            customerName: alloc.contract.lead?.company ?? leadName(alloc.contract.lead),
          }];
        })
        .filter((c) => c.normalized.length >= 3);

      for (const note of notesNeedingCabin) {
        const normNote = normalizeCabin(note);
        if (!normNote) continue;
        const match = cabinCandidates.find((c) => normNote.includes(c.normalized) || c.normalized.includes(normNote));
        if (match) {
          cabinInfoByNote.set(note, {
            customer_name: match.customerName,
            sub_label: `Matched via ${match.cabinName}`,
            contract_number: match.contractNumber,
            booking_number: null,
            group_key: `suggested:${match.contractId}`,
          });
        }
      }
    }

    let labels: DeviceLabelRow[] = [];
    if (locationId) {
      const { data } = await supabase
        .from("unifi_device_labels")
        .select("mac, label")
        .eq("location_id", locationId);
      labels = data ?? [];
    }
    const labelByMac = new Map(labels.map((l) => [l.mac, l.label]));

    interface Group {
      key: string;
      customer_name: string | null;
      sub_label: string | null;
      contract_number: string | null;
      booking_number: string | null;
      tier: "confirmed" | "suggested" | "unmatched";
      devices: {
        mac: string;
        hostname: string | null;
        label: string | null;
        last_seen: string | null;
        connected_now: boolean;
        bytes: number | null;
      }[];
    }
    const groups = new Map<string, Group>();

    for (const { session: s, note, parsed } of parsedBySession) {
      let info: GroupInfo | null = null;
      let tier: "confirmed" | "suggested" | "unmatched" = "unmatched";

      if (parsed?.kind === "contract") {
        info = issuanceByKey.get(`contract:${parsed.contractNumber}:${parsed.seatNumber}`) ?? null;
        if (info) tier = "confirmed";
      } else if (parsed?.kind === "booking") {
        info = issuanceByKey.get(`booking:${parsed.bookingId}:${parsed.seatNumber}`) ?? null;
        if (info) tier = "confirmed";
      } else if (note) {
        const linkedContractId = adhocContractByNote.get(note);
        if (linkedContractId) {
          info = contractInfoById.get(linkedContractId) ?? null;
          if (info) tier = "confirmed";
        } else {
          info = fuzzyInfoByNote.get(note) ?? cabinInfoByNote.get(note) ?? null;
          if (info) tier = "suggested";
        }
      }

      const key = info?.group_key ?? "unmatched";

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          customer_name: info?.customer_name ?? null,
          sub_label: info?.sub_label ?? null,
          contract_number: info?.contract_number ?? null,
          booking_number: info?.booking_number ?? null,
          tier,
          devices: [],
        });
      }

      const mac = isAdmin ? s.mac : anonymizeMac(s.mac);
      groups.get(key)!.devices.push({
        mac,
        hostname: s.hostname ?? null,
        label: labelByMac.get(s.mac) ?? null,
        last_seen: s.end ? new Date(s.end * 1000).toISOString() : (s.start ? new Date(s.start * 1000).toISOString() : null),
        connected_now: Boolean(s.end === undefined || s.end === null),
        bytes: s.bytes ?? null,
      });
    }

    const tierOrder = { confirmed: 0, suggested: 1, unmatched: 2 };
    const result = Array.from(groups.values()).sort((a, b) => {
      if (a.tier !== b.tier) return tierOrder[a.tier] - tierOrder[b.tier];
      const aLatest = Math.max(...a.devices.map((d) => (d.last_seen ? new Date(d.last_seen).getTime() : 0)));
      const bLatest = Math.max(...b.devices.map((d) => (d.last_seen ? new Date(d.last_seen).getTime() : 0)));
      return bLatest - aLatest;
    });

    return NextResponse.json({ data: result });
  } catch (err) {
    console.error("[api/unifi/voucher-devices] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach UniFi device" },
      { status: 502 }
    );
  }
}

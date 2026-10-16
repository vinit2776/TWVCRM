import type { SupabaseClient } from "@supabase/supabase-js";
import { computeJourney } from "./compute";
import type { Journey, JourneyInput } from "./types";

const ENROLLED = ["biometric_enrolled", "card_enrolled", "fully_enrolled"];
// Contracts that never went live or are over: not a journey to follow.
const DEAD_CONTRACT_STATUSES = ["terminated", "rejected"];

export interface LoadJourneyOptions {
  proposalId?: string | null;
  contractId?: string | null;
}

type Row = Record<string, unknown>;

/**
 * Builds the journey for one lead. Read-only. Callers must have checked the
 * session first; the client passed in should be the admin client because the
 * door-access and voucher tables are not all readable by every staff role, and
 * we only return derived counts, never rows.
 */
export async function loadJourney(
  admin: SupabaseClient,
  leadId: string,
  opts: LoadJourneyOptions = {},
): Promise<Journey | null> {
  const { data: lead } = await admin.from("leads").select("id, status").eq("id", leadId).maybeSingle();
  if (!lead) return null;

  const [enquiryRes, proposalsRes, contractsRes] = await Promise.all([
    admin
      .from("lead_enquiries")
      .select("claimed_by, resolution_outcome")
      .eq("lead_id", leadId)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("proposals")
      .select(
        "id, proposal_number, status, security_deposit_months, deposit_payment_status, payment_status, deposit_waiver_verified_at, created_at",
      )
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false }),
    admin
      .from("contracts")
      .select(
        "id, contract_number, status, proposal_id, deposit_carried_from, seats, signed_document_id, stamp_reference, activated_at, location_id, created_at",
      )
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false }),
  ]);

  const proposals = (proposalsRes.data ?? []) as Row[];
  const contracts = (contractsRes.data ?? []) as Row[];

  // Focus contract: the one asked for, else the one tied to the focus proposal,
  // else the newest that is still alive.
  let contract: Row | undefined = opts.contractId
    ? contracts.find((c) => c.id === opts.contractId)
    : undefined;
  let proposal: Row | undefined = opts.proposalId
    ? proposals.find((p) => p.id === opts.proposalId)
    : undefined;
  if (!contract && proposal) {
    contract = contracts.find((c) => c.proposal_id === proposal!.id && !DEAD_CONTRACT_STATUSES.includes(c.status as string));
  }
  if (!contract && !opts.proposalId) {
    contract = contracts.find((c) => !DEAD_CONTRACT_STATUSES.includes(c.status as string));
  }
  if (!proposal && contract?.proposal_id) {
    proposal = proposals.find((p) => p.id === contract!.proposal_id);
  }
  if (!proposal && !contract) {
    proposal = proposals.find((p) => !["rejected", "expired"].includes(p.status as string)) ?? proposals[0];
  }

  const input: JourneyInput = {
    leadId,
    leadStatus: lead.status as string,
    enquiry: enquiryRes.data
      ? {
          claimed: !!enquiryRes.data.claimed_by,
          resolved: !!enquiryRes.data.resolution_outcome,
        }
      : null,
    proposal: null,
    contract: null,
  };

  if (proposal) {
    const { data: pi } = await admin
      .from("billing_statements")
      .select("id")
      .eq("proposal_id", proposal.id as string)
      .eq("created_via", "proposal_pi")
      .neq("status", "voided")
      .limit(1)
      .maybeSingle();
    input.proposal = {
      id: proposal.id as string,
      number: (proposal.proposal_number as string) ?? null,
      status: proposal.status as string,
      depositMonths: Number(proposal.security_deposit_months ?? 0),
      depositStatus: (proposal.deposit_payment_status as string) ?? null,
      paymentStatus: (proposal.payment_status as string) ?? null,
      waiverVerified: !!proposal.deposit_waiver_verified_at,
      prorataInvoiceSent: !!pi,
    };
  }

  if (contract) {
    const cid = contract.id as string;
    const today = new Date().toISOString().slice(0, 10);

    const [docs, spaces, members, vouchers, devices, rent] = await Promise.all([
      admin.from("contract_documents").select("status, is_required, deferred_until").eq("contract_id", cid),
      admin
        .from("contract_space_allocations")
        .select("id", { count: "exact", head: true })
        .eq("contract_id", cid)
        .eq("status", "active"),
      admin.from("contract_members").select("id").eq("contract_id", cid).eq("is_active", true),
      admin.from("voucher_issuances").select("id", { count: "exact", head: true }).eq("contract_id", cid).eq("is_active", true),
      contract.location_id
        ? admin
            .from("cosec_devices")
            .select("id", { count: "exact", head: true })
            .eq("location_id", contract.location_id as string)
            .eq("is_enabled", true)
            .eq("device_category", "entry_point")
        : Promise.resolve({ count: 0 }),
      admin
        .from("billing_statements")
        .select("id", { count: "exact", head: true })
        .eq("contract_id", cid)
        .in("statement_type", ["rent", "combined"])
        .neq("status", "voided"),
    ]);

    const required = ((docs.data ?? []) as Row[]).filter((d) => d.is_required !== false);
    // approved, uploaded and waived count as received; a deferral counts only
    // while its promised date is still in the future.
    const kycOutstanding = required.filter((d) => {
      if (d.status === "pending" || d.status === "rejected") return true;
      if (d.status === "deferred") return !d.deferred_until || (d.deferred_until as string) <= today;
      return false;
    }).length;

    const memberIds = ((members.data ?? []) as Row[]).map((m) => m.id as string);
    let membersWithAccess = 0;
    if (memberIds.length > 0) {
      const { data: access } = await admin
        .from("cosec_access_users")
        .select("entity_id, enrollment_status")
        .eq("user_type", "member")
        .in("entity_id", memberIds);
      const enrolled = new Set(
        ((access ?? []) as Row[]).filter((a) => ENROLLED.includes(a.enrollment_status as string)).map((a) => a.entity_id as string),
      );
      membersWithAccess = enrolled.size;
    }

    const { data: unifi } = await admin.from("contracts").select("unifi_voucher_id").eq("id", cid).maybeSingle();

    input.contract = {
      id: cid,
      number: (contract.contract_number as string) ?? null,
      status: contract.status as string,
      isRenewal: !!contract.deposit_carried_from,
      seats: Number(contract.seats ?? 0),
      signedDocumentId: (contract.signed_document_id as string) ?? null,
      stamped: !!contract.stamp_reference,
      activated: !!contract.activated_at,
      kycTotal: required.length,
      kycOutstanding,
      spacesAllocated: spaces.count ?? 0,
      members: memberIds.length,
      vouchersActive: vouchers.count ?? 0,
      hasContractLevelVoucher: !!unifi?.unifi_voucher_id,
      accessDevices: devices.count ?? 0,
      membersWithAccess,
      rentStatementExists: (rent.count ?? 0) > 0,
    };
  }

  return computeJourney(input);
}

// DB side of enquiry-progress.ts: gathers a lead's enquiries, proposals and contracts, derives
// each enquiry's stage, and applies the automatic resolutions. Server only (service client).

import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import {
  autoResolutions,
  deriveProgress,
  type EnquiryProgress,
  type ProgressContract,
  type ProgressEnquiry,
  type ProgressProposal,
} from "@/lib/enquiry-progress";

/** app_settings key: only enquiries received on/after this are ever auto-resolved. */
export const AUTO_RESOLVE_EFFECTIVE_FROM_KEY = "enquiry_auto_resolve_effective_from";

type LeadFacts = {
  enquiries: ProgressEnquiry[];
  progress: Map<string, EnquiryProgress>;
  leadStatus: string | null;
  leadId: string;
};

/** Facts for each lead (every one of its enquiries, even those a list has filtered out, so
 *  proposals attach to the right enquiry). */
export async function loadLeadFacts(admin: SupabaseClient, leadIds: string[]): Promise<Map<string, LeadFacts>> {
  const out = new Map<string, LeadFacts>();
  if (leadIds.length === 0) return out;

  const [{ data: enqRows }, { data: propRows }, { data: contractRows }, { data: leadRows }] = await Promise.all([
    admin.from("lead_enquiries").select("id, lead_id, received_at, claimed_at, resolved_at, payload").in("lead_id", leadIds),
    admin
      .from("proposals")
      .select("id, lead_id, proposal_number, sent_at, viewed_at, deposit_payment_received_at, payment_received_at, payment_status")
      .in("lead_id", leadIds),
    admin
      .from("contracts")
      .select("id, lead_id, contract_number, proposal_id, is_renewal, sent_at, signed_at, accepted_at, activated_at")
      .in("lead_id", leadIds),
    admin.from("leads").select("id, status").in("id", leadIds),
  ]);

  const enquiryIds = (enqRows ?? []).map((e) => e.id as string);
  const lastUpdate = new Map<string, string>();
  if (enquiryIds.length > 0) {
    const { data: updates } = await admin
      .from("enquiry_updates")
      .select("enquiry_id, created_at")
      .in("enquiry_id", enquiryIds)
      .order("created_at", { ascending: false });
    for (const u of updates ?? []) if (!lastUpdate.has(u.enquiry_id as string)) lastUpdate.set(u.enquiry_id as string, u.created_at as string);
  }

  const status = new Map((leadRows ?? []).map((l) => [l.id as string, (l.status as string) ?? null]));
  for (const leadId of leadIds) {
    const enquiries: ProgressEnquiry[] = (enqRows ?? [])
      .filter((e) => e.lead_id === leadId)
      .map((e) => {
        const messages = ((e.payload as { messages?: { at?: string }[] } | null)?.messages ?? []).map((m) => m.at).filter(Boolean) as string[];
        const touches = [...messages, lastUpdate.get(e.id as string)].filter(Boolean) as string[];
        return {
          id: e.id as string,
          received_at: e.received_at as string,
          claimed_at: (e.claimed_at as string | null) ?? null,
          resolved_at: (e.resolved_at as string | null) ?? null,
          last_touch_at: touches.length ? touches.sort().at(-1)! : null,
        };
      });
    const proposals: ProgressProposal[] = (propRows ?? [])
      .filter((p) => p.lead_id === leadId)
      .map((p) => ({
        id: p.id as string,
        proposal_number: p.proposal_number as string | null,
        sent_at: (p.sent_at as string | null) ?? null,
        viewed_at: (p.viewed_at as string | null) ?? null,
        paid_at:
          (p.deposit_payment_received_at as string | null) ??
          (p.payment_status === "paid" ? ((p.payment_received_at as string | null) ?? null) : null),
      }));
    const contracts: ProgressContract[] = (contractRows ?? [])
      .filter((c) => c.lead_id === leadId)
      .map((c) => ({
        id: c.id as string,
        contract_number: c.contract_number as string | null,
        proposal_id: (c.proposal_id as string | null) ?? null,
        is_renewal: !!c.is_renewal,
        sent_at: (c.sent_at as string | null) ?? null,
        signed_at: ((c.signed_at ?? c.accepted_at) as string | null) ?? null,
        activated_at: (c.activated_at as string | null) ?? null,
      }));
    out.set(leadId, { leadId, enquiries, progress: deriveProgress(enquiries, proposals, contracts), leadStatus: status.get(leadId) ?? null });
  }
  return out;
}

/** enquiryId -> progress, for every enquiry of the given leads. */
export async function loadEnquiryProgress(admin: SupabaseClient, leadIds: string[]): Promise<Map<string, EnquiryProgress>> {
  const facts = await loadLeadFacts(admin, Array.from(new Set(leadIds)));
  const out = new Map<string, EnquiryProgress>();
  for (const f of facts.values()) for (const [id, p] of f.progress) out.set(id, p);
  return out;
}

async function loadCutoff(admin: SupabaseClient): Promise<string | null> {
  const { data } = await admin.from("app_settings").select("value").eq("key", AUTO_RESOLVE_EFFECTIVE_FROM_KEY).maybeSingle();
  return (data?.value as string | undefined) ?? null;
}

/** Resolves any of these leads' open enquiries that the rules say are finished. Idempotent and
 *  race-safe (only rows still unresolved are written). Returns how many were resolved. */
export async function reconcileLeadEnquiries(admin: SupabaseClient, leadIds: string[], now: Date = new Date()): Promise<number> {
  const cutoff = await loadCutoff(admin);
  if (!cutoff) return 0; // fail-safe: no cut-off, no automatic resolving
  const facts = await loadLeadFacts(admin, Array.from(new Set(leadIds)));
  let resolved = 0;
  for (const f of facts.values()) {
    for (const r of autoResolutions(f.enquiries, f.progress, f.leadStatus, now, cutoff)) {
      const { data } = await admin
        .from("lead_enquiries")
        .update({ resolved_at: now.toISOString(), resolved_by: null, resolution_outcome: r.outcome })
        .eq("id", r.enquiryId)
        .is("resolved_at", null)
        .select("reference")
        .maybeSingle();
      if (!data) continue;
      resolved += 1;
      void logAudit(admin, {
        entityType: "lead",
        entityId: f.leadId,
        action: "update",
        performedBy: "system:enquiry-auto-resolve",
        changes: {
          enquiry: { old: data.reference, new: data.reference },
          resolution_outcome: { old: null, new: r.outcome },
          auto_resolved_because: { old: null, new: r.reason },
        },
      });
    }
  }
  return resolved;
}

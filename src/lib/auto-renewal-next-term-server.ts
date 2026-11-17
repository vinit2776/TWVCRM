import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import type { planAutoRenewals } from "@/lib/auto-renewal-plan";
import { createRenewalDraft } from "@/lib/renewal-draft";
import { decideNextTerm, rentMatchesNotice } from "@/lib/auto-renewal-next-term";

export interface NextTermLine {
  contractNumber: string;
  customer: string;
  detail?: string;
}

export interface NextTermJobResult {
  prepared: NextTermLine[];
  /** Could not be created: a person needs to renew it by hand. */
  failed: NextTermLine[];
  /** Created, but its rent is not the figure the customer was sent. */
  mismatched: NextTermLine[];
}

/**
 * Creates the next term for every opted-in contract that is ready: the customer has
 * been sent the rate, the 45-day renewal window is open and nothing holds it. It is
 * the same draft the Renew button makes (createRenewalDraft), at the rent that was
 * noticed, carrying the original signed agreement because that agreement is what
 * renews it. Activating it stays with a person (part 4b-1).
 */
export async function runNextTermJob(
  admin: SupabaseClient,
  plan: ReturnType<typeof planAutoRenewals>,
  today: string,
): Promise<NextTermJobResult> {
  const out: NextTermJobResult = { prepared: [], failed: [], mismatched: [] };

  const ids = plan.items.map((i) => i.facts.id);
  if (ids.length === 0) return out;
  const { data: sent, error } = await admin
    .from("auto_renewal_notices")
    .select("contract_id, term_end_date, escalation_percentage, new_rent, approved_by, sent_by")
    .in("contract_id", ids)
    .eq("kind", "notice")
    .eq("status", "sent");
  if (error) {
    // 42P01: migration 00672 not applied here yet. Nothing was ever noticed, so nothing to prepare.
    if (error.code !== "42P01") console.error("[auto-renew next term] could not read notices:", error.message);
    return out;
  }

  for (const item of plan.items) {
    const f = item.facts;
    const notice = (sent ?? []).find((n) => n.contract_id === f.id && String(n.term_end_date).slice(0, 10) === f.endDate);
    const decision = decideNextTerm({
      today,
      endDate: f.endDate,
      held: item.holds.length > 0,
      hasRenewal: !!f.renewalDraft,
      rateNoticeSent: !!notice,
    });
    if (!decision.prepare || !notice) continue;

    const line: NextTermLine = { contractNumber: f.contractNumber, customer: f.customer };
    const actorId = (notice.approved_by ?? notice.sent_by) as string | null;
    if (!actorId) {
      out.failed.push({ ...line, detail: "the notice has no person on record to create the term under" });
      continue;
    }

    try {
      const { data: source } = await admin.from("contracts").select("*").eq("id", f.id).maybeSingle();
      if (!source) {
        out.failed.push({ ...line, detail: "contract not found" });
        continue;
      }
      const res = await createRenewalDraft(
        admin,
        source,
        {
          escalation_percentage: Number(notice.escalation_percentage),
          agreed_note: "Auto-renewal: rent as emailed to the customer in the renewal notice.",
        },
        { id: actorId, role: "system" },
        { skipEscalationApproval: true },
      );
      if (!res.ok) {
        // 409 = a renewal already exists (made by hand meanwhile): not a failure.
        if (res.status !== 409) out.failed.push({ ...line, detail: res.error });
        continue;
      }

      const draftId = res.data.id as string;
      const draftNumber = res.data.contract_number as string;
      // The original signed agreement is what renews this term (clause 18). Carrying it lets the
      // usual accept and activate steps run, and lets vouchers be issued on activation.
      if (source.signed_document_id) {
        await admin.from("contracts").update({ signed_document_id: source.signed_document_id }).eq("id", draftId);
      }

      logAudit(admin, {
        entityType: "contract",
        entityId: f.id,
        action: "auto_renewal_next_term_prepared",
        performedBy: actorId,
        changes: { next_term: { old: null, new: draftNumber } },
      });
      out.prepared.push({ ...line, detail: draftNumber });
      if (!rentMatchesNotice(Number(res.data.new_subtotal), Number(notice.new_rent))) {
        out.mismatched.push({
          ...line,
          detail: `${draftNumber} is ₹${Math.round(Number(res.data.new_subtotal)).toLocaleString("en-IN")}, the customer was sent ₹${Math.round(Number(notice.new_rent)).toLocaleString("en-IN")}`,
        });
      }
    } catch (err) {
      out.failed.push({ ...line, detail: err instanceof Error ? err.message : "unknown error" });
    }
  }
  return out;
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * Are the VO proposal columns (migration 00683) present in this database?
 *
 * Vercel deploys the moment a PR merges, but migrations are applied by hand, so
 * for a while the code is live and the columns are not. Same approach as
 * waiverColumnsPresent() in kyc-waiver.ts: 42703 (unknown column) is the one
 * answer that means "not migrated yet"; any other failure is not evidence
 * either way, so it counts as unavailable but is not cached.
 *
 * 00682 (enum values) is applied before 00683, so columns present implies the
 * new statuses exist.
 */
let cached: { value: boolean; at: number } | null = null;
const NEGATIVE_TTL_MS = 60_000;

export async function voProposalColumnsPresent(): Promise<boolean> {
  if (cached?.value) return true;
  if (cached && Date.now() - cached.at < NEGATIVE_TTL_MS) return false;
  try {
    const { error } = await createAdminClient().from("proposals").select("kind, public_token").limit(1);
    if (!error) {
      cached = { value: true, at: Date.now() };
      return true;
    }
    if (["42703", "42P01", "PGRST204", "PGRST205"].includes(error.code ?? "")) {
      cached = { value: false, at: Date.now() };
      return false;
    }
    console.error("[vo-proposal] probe failed:", error.message);
    return false;
  } catch (err) {
    console.error("[vo-proposal] probe threw:", err);
    return false;
  }
}

export const VO_PROPOSAL_NOT_READY = "Virtual Office proposals are not available yet (database update pending).";

interface RetirableProposal {
  id: string;
  deposit_razorpay_link_id?: string | null;
  razorpay_payment_link_id?: string | null;
}

const PI_PAID_MESSAGE = "A payment is already recorded against this proposal's pro-rata invoice. Talk to accounts first.";

/** The unpaid pro-rata invoice raised from this proposal, if any. */
async function latestProposalPi(admin: SupabaseClient, proposalId: string) {
  const { data } = await admin
    .from("billing_statements")
    .select("id, razorpay_payment_link_id, notes")
    .eq("proposal_id", proposalId)
    .eq("created_via", "proposal_pi")
    .neq("status", "voided")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/** Message if a payment already sits on the pro-rata invoice (check BEFORE changing anything). */
export async function proposalPiPaymentBlock(admin: SupabaseClient, proposalId: string): Promise<string | null> {
  const pi = await latestProposalPi(admin, proposalId);
  if (!pi) return null;
  const { data: payments } = await admin.from("billing_payments").select("id").eq("billing_statement_id", pi.id).limit(1);
  return payments && payments.length > 0 ? PI_PAID_MESSAGE : null;
}

/**
 * Take a VO proposal's payment demands out of circulation: void the unpaid
 * pro-rata invoice and cancel the live Razorpay links, mirroring
 * POST /api/proposals/[id]/revise. Best effort and non-fatal; link ids stay on
 * the record so a late payment is still matched by the webhook.
 */
export async function retireProposalPayments(
  admin: SupabaseClient,
  proposal: RetirableProposal,
  actorId: string,
  reason: string,
): Promise<void> {
  const pi = await latestProposalPi(admin, proposal.id);
  if (pi) {
    await admin
      .from("billing_statements")
      .update({
        status: "voided",
        voided_at: new Date().toISOString(),
        voided_by: actorId,
        void_reason: reason,
        notes: [pi.notes, `--- VOIDED — ${reason} ---`].filter(Boolean).join("\n"),
      })
      .eq("id", pi.id);
  }

  const linkIds = [proposal.deposit_razorpay_link_id, proposal.razorpay_payment_link_id, pi?.razorpay_payment_link_id as string | null | undefined].filter(
    (l): l is string => !!l,
  );
  if (linkIds.length === 0) return;
  try {
    const { data: settings } = await admin
      .from("app_settings")
      .select("key, value")
      .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
    const rzp: Record<string, string> = {};
    (settings || []).forEach((s: { key: string; value: string }) => { rzp[s.key] = s.value; });
    if (rzp.razorpay_enabled === "true" && rzp.razorpay_key_id && rzp.razorpay_key_secret) {
      const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");
      for (const linkId of linkIds) {
        const res = await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
          method: "POST",
          headers: { Authorization: `Basic ${auth}` },
        });
        if (!res.ok) console.warn(`[vo-proposal] Razorpay refused to cancel ${linkId} (${res.status})`);
      }
    }
  } catch (err) {
    console.warn("[vo-proposal] Razorpay cancel error (non-fatal):", err);
  }
}

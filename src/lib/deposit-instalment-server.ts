import type { SupabaseClient } from "@supabase/supabase-js";
import { RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";
import { DEFAULT_MIN_FIRST_PART_PERCENT, depositPosition, requiredDeposit } from "@/lib/deposit-instalments";
import { partialDepositState, type PartialDepositState } from "@/lib/deposit-activation";
import { buildContractDepositSnapshot } from "@/lib/proposal-deposit-claim";

/**
 * Server-side helpers for the staged deposit. Money state changes go through the
 * RPCs in migration 00649; this file only talks to Razorpay and reads settings.
 */

export interface InstalmentSettings {
  enabled: boolean;
  minFirstPartPercent: number;
}

/** Read straight from app_settings (not cached): an admin flipping the switch must take effect at once. */
export async function getInstalmentSettings(admin: SupabaseClient): Promise<InstalmentSettings> {
  const { data } = await admin
    .from("app_settings")
    .select("key, value")
    .in("key", ["deposit_instalments_enabled", "deposit_min_first_part_percent"]);
  const map: Record<string, string> = {};
  (data || []).forEach((s) => { map[s.key as string] = s.value as string; });
  const pct = Number(map.deposit_min_first_part_percent);
  return {
    enabled: map.deposit_instalments_enabled === "true",
    minFirstPartPercent: Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : DEFAULT_MIN_FIRST_PART_PERCENT,
  };
}

/** True once any part has been asked for (and not withdrawn) or paid — the legacy single-deposit paths stand down. */
export async function hasLiveInstalments(admin: SupabaseClient, proposalId: string): Promise<boolean> {
  const { count } = await admin
    .from("proposal_deposit_instalments")
    .select("id", { count: "exact", head: true })
    .eq("proposal_id", proposalId)
    .in("status", ["requested", "paid"]);
  return (count ?? 0) > 0;
}

interface RazorpayCreds { auth: string }

export async function getRazorpayCreds(admin: SupabaseClient): Promise<RazorpayCreds | null> {
  const { data } = await admin
    .from("app_settings")
    .select("key, value")
    .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
  const m: Record<string, string> = {};
  (data || []).forEach((s) => { m[s.key as string] = s.value as string; });
  if (m.razorpay_enabled !== "true" || !m.razorpay_key_id || !m.razorpay_key_secret) return null;
  return { auth: Buffer.from(`${m.razorpay_key_id}:${m.razorpay_key_secret}`).toString("base64") };
}

export interface InstalmentLinkInput {
  amount: number;
  proposalId: string;
  proposalNumber: string;
  instalmentId: string;
  seq: number;
  customer: { name?: string; email?: string | null; phone?: string | null };
}

/**
 * One fresh link per ask, fixed at that ask's amount. notify stays off: telling
 * the customer is a deliberate step (and Razorpay would otherwise message them
 * the moment the link exists).
 */
export async function createInstalmentPaymentLink(
  creds: RazorpayCreds,
  input: InstalmentLinkInput,
): Promise<{ id: string; url: string } | { error: string }> {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = {
    amount: Math.round(input.amount * 100),
    currency: "INR",
    description: `Security Deposit (part ${input.seq}) — ${input.proposalNumber} — The WorkVilla`,
    reference_id: `${input.proposalNumber}-DEP${input.seq}-${Date.now()}`,
    expire_by: Math.floor(Date.now() / 1000) + RAZORPAY_MAX_LINK_VALIDITY_SECONDS,
    notify: { sms: false, email: false },
    reminder_enable: true,
    notes: {
      proposal_id: input.proposalId,
      proposal_number: input.proposalNumber,
      instalment_id: input.instalmentId,
      type: "security_deposit_part",
    },
    callback_url: `${appUrl}/proposals`,
    callback_method: "get",
  };
  const { name, email, phone } = input.customer;
  if (name || email || phone) {
    payload.customer = {};
    if (name) payload.customer.name = name;
    if (email) payload.customer.email = email;
    if (phone) payload.customer.contact = phone.replace(/\s/g, "");
  }

  try {
    const res = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { Authorization: `Basic ${creds.auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      console.error("[deposit-instalment] Razorpay link creation failed:", err?.error?.description || res.status);
      return { error: err?.error?.description || "Failed to create the payment link" };
    }
    const link = await res.json();
    return { id: link.id, url: link.short_url };
  } catch (err) {
    console.error("[deposit-instalment] Razorpay link creation error:", err);
    return { error: "Could not reach Razorpay" };
  }
}

/**
 * Best-effort cancel at Razorpay. Deliberately non-fatal and run after our own
 * state is saved: a late payment on a link that failed to cancel is still caught
 * by the webhook (record_deposit_payment_for_link records it whatever the state).
 */
export async function cancelRazorpayLink(admin: SupabaseClient, linkId: string | null | undefined): Promise<void> {
  if (!linkId) return;
  try {
    const creds = await getRazorpayCreds(admin);
    if (!creds) return;
    const res = await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Basic ${creds.auth}` },
    });
    if (!res.ok) console.warn(`[deposit-instalment] Razorpay refused to cancel ${linkId} (${res.status})`);
  } catch (err) {
    console.warn("[deposit-instalment] Razorpay cancel failed:", err);
  }
}

export interface PartReceivableState {
  /** Money received across paid parts. */
  paid: number;
  /** Every open (unpaid) ask, oldest first. Several can be out at once. */
  open: Array<{ id: string; seq: number; amount: number; due_date: string | null; link_url: string | null }>;
}

/**
 * For proposals whose deposit is collected in parts: what has been received and
 * which ask is still out. Receivables show this instead of one all-or-nothing
 * deposit line; the automatic reminder ladder skips these proposals (it would
 * chase the whole amount) and each part is followed up from the proposal.
 */
export async function loadPartReceivableState(
  client: SupabaseClient,
  proposalIds: string[],
): Promise<Map<string, PartReceivableState>> {
  const out = new Map<string, PartReceivableState>();
  if (proposalIds.length === 0) return out;
  const { data } = await client
    .from("proposal_deposit_instalments")
    .select("id, seq, proposal_id, amount, status, paid_amount, due_date, razorpay_link_url")
    .in("proposal_id", proposalIds)
    .in("status", ["paid", "requested"])
    .order("seq", { ascending: true });
  for (const r of data || []) {
    const s = out.get(r.proposal_id) ?? { paid: 0, open: [] };
    if (r.status === "paid") s.paid = Math.round((s.paid + Number(r.paid_amount ?? r.amount)) * 100) / 100;
    else s.open.push({ id: r.id, seq: r.seq, amount: Number(r.amount), due_date: r.due_date, link_url: r.razorpay_link_url });
    out.set(r.proposal_id, s);
  }
  return out;
}

/**
 * What has been received against a proposal's deposit collected in parts, and
 * whether that is enough (more than half) to activate the contract with a
 * pending-balance warning. Only paid parts count.
 */
export async function loadDepositCollection(
  client: SupabaseClient,
  proposal: { id: string; security_deposit_amount?: number | string | null; deposit_exception_amount?: number | string | null; deposit_credit_amount?: number | string | null },
): Promise<PartialDepositState> {
  const { data: rows } = await client
    .from("proposal_deposit_instalments")
    .select("amount, status, paid_amount")
    .eq("proposal_id", proposal.id);
  const required = requiredDeposit(proposal);
  return partialDepositState(required, depositPosition(required, rows || []).paid);
}

/**
 * A contract can be activated while the deposit is still part-paid; it then
 * holds a pending deposit snapshot and the claim on the proposal's deposit.
 * When the last part is paid and the proposal's deposit completes, bring the
 * contract's own deposit record up to date so the pool, exits and receivables
 * see it as paid. No-op unless the proposal is complete and a contract holds
 * the claim with a deposit that is still marked pending.
 */
export async function syncContractDepositFromParts(
  admin: SupabaseClient,
  proposalId: string,
): Promise<{ synced: boolean; contractId?: string }> {
  const { data: p } = await admin
    .from("proposals")
    .select("security_deposit_amount, security_deposit_months, deposit_payment_status, deposit_payment_amount, deposit_payment_reference, deposit_payment_medium, deposit_payment_received_at, deposit_internal_notes, deposit_claimed_by_contract_id")
    .eq("id", proposalId)
    .maybeSingle();
  if (!p || p.deposit_payment_status !== "paid" || !p.deposit_claimed_by_contract_id) return { synced: false };

  const { data: c } = await admin
    .from("contracts")
    .select("id, status, deposit_payment_status")
    .eq("id", p.deposit_claimed_by_contract_id)
    .maybeSingle();
  if (!c || c.deposit_payment_status === "paid") return { synced: false };

  const fields = buildContractDepositSnapshot(p, true);
  const { error } = await admin
    .from("contracts")
    .update(fields)
    .eq("id", c.id)
    .neq("deposit_payment_status", "paid");
  if (error) {
    console.error("[deposit-parts] could not bring the contract's deposit up to date:", error.message);
    return { synced: false };
  }
  return { synced: true, contractId: c.id as string };
}

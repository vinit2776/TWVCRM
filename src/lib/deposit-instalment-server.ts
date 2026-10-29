import type { SupabaseClient } from "@supabase/supabase-js";
import { RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";
import { DEFAULT_MIN_FIRST_PART_PERCENT } from "@/lib/deposit-instalments";

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

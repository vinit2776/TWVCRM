import type { SupabaseClient } from "@supabase/supabase-js";
import { RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";

export interface NocLinkArgs {
  totalRupees: number;
  invoiceNumber: string;
  title: string;
  invoiceId: string;
  nocId: string;
  nocNumber: string;
  token: string;
  appUrl: string;
  customer: { name?: string; email?: string; phone?: string };
  nowSeconds?: number;
}

/**
 * The Razorpay payment-link request for a NOC fee. Pure so it can be tested without calling the gateway.
 * - amount is the exact total in paise (the customer cannot pay a different amount);
 * - notify is OFF: we do our own messaging, so the gateway never emails or texts anyone;
 * - the notes carry `type: adhoc_invoice` so the existing webhook books it like any ad-hoc invoice;
 * - the callback brings the customer back to the same NOC page, which then shows the confirmation.
 */
export function buildNocLinkPayload(a: NocLinkArgs) {
  const payload: Record<string, unknown> = {
    amount: Math.round(a.totalRupees * 100),
    currency: "INR",
    description: `${a.invoiceNumber} — ${a.title} — The WorkVilla`,
    reference_id: `${a.invoiceNumber}-${a.nowSeconds ?? Math.floor(Date.now() / 1000)}`,
    expire_by: (a.nowSeconds ?? Math.floor(Date.now() / 1000)) + RAZORPAY_MAX_LINK_VALIDITY_SECONDS,
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: { invoice_id: a.invoiceId, invoice_number: a.invoiceNumber, type: "adhoc_invoice", noc_id: a.nocId, noc_number: a.nocNumber },
    callback_url: `${a.appUrl.replace(/\/$/, "")}/noc/${a.token}?razorpay_callback=true`,
    callback_method: "get",
  };
  const c = a.customer;
  if (c.name || c.email || c.phone) {
    payload.customer = {
      ...(c.name ? { name: c.name } : {}),
      ...(c.email ? { email: c.email } : {}),
      ...(c.phone ? { contact: c.phone.replace(/\s/g, "") } : {}),
    };
  }
  return payload;
}

export type NocLinkResult =
  | { ok: true; id: string; url: string; expiresAt: number | null }
  | { ok: false; reason: "disabled" | "gateway"; error: string };

/** Creates the link at the gateway. `disabled` when online payment is not set up (staging), `gateway` on a gateway error. */
export async function createNocPaymentLink(admin: SupabaseClient, args: NocLinkArgs): Promise<NocLinkResult> {
  const { data: rows } = await admin.from("app_settings").select("key, value").in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
  const m: Record<string, string> = {};
  (rows ?? []).forEach((r: { key: string; value: string }) => { m[r.key] = r.value; });
  if (m.razorpay_enabled !== "true" || !m.razorpay_key_id || !m.razorpay_key_secret) {
    return { ok: false, reason: "disabled", error: "Online payment is not switched on in this environment." };
  }
  const auth = Buffer.from(`${m.razorpay_key_id}:${m.razorpay_key_secret}`).toString("base64");
  try {
    const res = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildNocLinkPayload(args)),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.id || !j?.short_url) return { ok: false, reason: "gateway", error: j?.error?.description ?? "The payment gateway refused the request." };
    return { ok: true, id: j.id as string, url: j.short_url as string, expiresAt: typeof j.expire_by === "number" ? j.expire_by : null };
  } catch (e) {
    return { ok: false, reason: "gateway", error: e instanceof Error ? e.message : "Could not reach the payment gateway." };
  }
}

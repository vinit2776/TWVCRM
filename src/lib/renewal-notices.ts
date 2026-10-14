import type { SupabaseClient } from "@supabase/supabase-js";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";

/**
 * Staff notices for the renewal auto-draft flow. Staff only — nothing here
 * ever goes to a customer.
 */

export interface Person { id: string; full_name: string | null; email: string | null }

/** Managers for a location (falling back to every active admin/manager). */
export async function managersFor(admin: SupabaseClient, locationId: string | null): Promise<Person[]> {
  const pick = async (ids?: string[]) => {
    let q = admin.from("users").select("id, full_name, email").in("role", ["admin", "manager"]).eq("is_active", true);
    if (ids) q = q.in("id", ids);
    const { data } = await q;
    return (data ?? []) as Person[];
  };
  if (locationId) {
    const { data: links } = await admin.from("user_locations").select("user_id").eq("location_id", locationId);
    const ids = (links ?? []).map((l) => l.user_id as string);
    if (ids.length > 0) {
      const scoped = await pick(ids);
      if (scoped.length > 0) return scoped;
    }
  }
  return pick();
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function notifyDraftReady(
  admin: SupabaseClient,
  p: {
    contractId: string; parentNumber: string; draftId: string; draftNumber: string;
    customer: string; endDate: string; escalationPct: number; newSubtotal: number;
    rep: Person | null; managers: Person[]; reminder: boolean;
  }
): Promise<void> {
  const people = [...(p.rep ? [p.rep] : []), ...p.managers];
  const ids = [...new Set(people.map((x) => x.id))];
  const title = p.reminder
    ? `Renewal draft still needs validating: ${p.customer}`
    : `Renewal draft ready: ${p.customer} (${p.parentNumber})`;
  const body = p.reminder
    ? `${p.draftNumber} was created automatically a week ago and has not been validated. The customer cannot be sent it until it is.`
    : `${p.parentNumber} ends ${p.endDate}. A renewal draft (${p.draftNumber}) is ready for you to check and validate.`;
  await createNotificationsForUsers(ids, {
    type: "renewal_draft", title, body, url: `/contracts/${p.draftId}`, entityType: "contract", entityId: p.draftId,
  });

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://twv-crm.vercel.app").trim();
  const to = (p.rep?.email ? [p.rep.email] : p.managers.map((m) => m.email).filter(Boolean)) as string[];
  const cc = p.rep?.email ? (p.managers.map((m) => m.email).filter(Boolean) as string[]) : [];
  if (to.length === 0) return;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #015E65; padding: 18px 28px;"><h1 style="color:#fff;margin:0;font-size:18px;">The WorkVilla</h1></div>
      <div style="padding: 24px 28px; color:#333; font-size:14px; line-height:1.6;">
        <p>${esc(body)}</p>
        <p>New rent: <strong>₹${Math.round(p.newSubtotal).toLocaleString("en-IN")}</strong> a month (${p.escalationPct}% increase).</p>
        <p>Please check the rate, seats and dates, then validate it so it can be sent to the customer.</p>
        <p style="margin:24px 0;"><a href="${appUrl}/contracts/${p.draftId}" style="background:#015E65;color:#fff;text-decoration:none;padding:10px 22px;border-radius:6px;font-weight:bold;">Open draft</a></p>
      </div>
    </div>`;
  const { error } = await resend.emails.send({
    from: EMAIL_FROM, replyTo: EMAIL_REPLY_TO, to, ...(cc.length ? { cc } : {}), subject: title, html,
  });
  if (error) console.error("[renewal-notices] email failed:", error.message);
}

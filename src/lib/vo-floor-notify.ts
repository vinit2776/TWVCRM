import type { SupabaseClient } from "@supabase/supabase-js";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { resend, EMAIL_FROM } from "@/lib/mailer";
import { voFloorSummary, type VoFloorMeta } from "@/lib/approval-display";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Tell active admins and managers that a below-floor VO quote is waiting for a decision: an in-app
 * notification plus an internal email, the same two channels comp requests use. Staff only, never
 * the customer. Never throws: the approval row already exists and a failed notice must not undo it.
 */
export async function notifyFloorApprovers(
  admin: SupabaseClient,
  input: { approvalId: string; proposalId: string; proposalNumber: string | null; requestedBy: string; reason: string; meta: VoFloorMeta },
): Promise<void> {
  try {
    const [{ data: approvers }, { data: requester }] = await Promise.all([
      admin.from("users").select("id, email").in("role", ["admin", "manager"]).eq("is_active", true),
      admin.from("users").select("full_name").eq("id", input.requestedBy).maybeSingle(),
    ]);
    const list = approvers ?? [];
    if (list.length === 0) return;

    const who = requester?.full_name || "A sales user";
    const ref = input.proposalNumber || "a proposal";
    const summary = voFloorSummary(input.meta);

    await createNotificationsForUsers(list.map((u) => u.id as string), {
      type: "vo_below_floor",
      title: `Below-floor VO quote: ${ref}`,
      body: `${who} needs approval. ${summary}. Reason: ${input.reason}`,
      url: "/approvals",
      entityType: "proposal",
      entityId: input.proposalId,
    });

    const emails = list.map((u) => u.email).filter(Boolean) as string[];
    if (emails.length === 0) return;
    const link = `${process.env.NEXT_PUBLIC_APP_URL || "https://crm.theworkvilla.com"}/approvals`;
    await resend.emails
      .send({
        from: EMAIL_FROM,
        to: emails,
        subject: `Approval needed: below-floor Virtual Office quote ${ref}`,
        html: `<div style="font-family: system-ui, sans-serif; max-width: 560px; color: #111;">
  <p style="font-size:14px;"><strong>${esc(who)}</strong> quoted ${esc(ref)} below the floor price and needs your approval before it can be sent.</p>
  <p style="font-size:13px;">${esc(summary)}<br/>Reason: ${esc(input.reason)}</p>
  <p><a href="${link}" style="display:inline-block; padding:10px 20px; background:#015E65; color:#fff; border-radius:6px; text-decoration:none; font-size:13px; font-weight:600;">Review in CRM</a></p>
  <p style="font-size:12px; color:#6b7280;">Nothing has been sent to the customer.</p>
</div>`,
      })
      .catch((err) => console.error("[vo-floor-notify] email failed:", err));
  } catch (err) {
    console.error("[vo-floor-notify] failed:", err instanceof Error ? err.message : err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { createProposalSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";
import { revisionBlockedReason, revisionProposalNumber, revisionTotals } from "@/lib/proposal-revision";
import { hasLiveInstalments } from "@/lib/deposit-instalment-server";

const REVISE_ROLES = ["admin", "manager", "sales_rep"];

/**
 * POST /api/proposals/[id]/revise
 *
 * Once a proposal has been sent its terms are not edited in place. This
 * creates the revision (PROP-0231 -> PROP-0231-R2) as a fresh draft from the
 * full new content in the body, marks the original `superseded`, and withdraws
 * its payment demands (deposit link, monthly link, unpaid pro-rata invoice) so
 * the customer can't pay or accept the old terms.
 *
 * Refused (409) when the original is not sent/viewed, or when any money has
 * been collected or credited — that needs accounts, not a silent move.
 *
 * Nothing is sent to the customer here. The revision is a draft; staff send it
 * the usual way.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!actor || !REVISE_ROLES.includes(actor.role)) {
    return NextResponse.json({ error: "You don't have permission to revise a proposal." }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: old } = await admin.from("proposals").select("*").eq("id", id).single();
  if (!old) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  const blocked = revisionBlockedReason({ ...old, deposit_parts_active: await hasLiveInstalments(admin, id) });
  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });

  // The pro-rata invoice is its own record; a payment against it also locks the terms.
  const { data: piStatement } = await admin
    .from("billing_statements")
    .select("id, razorpay_payment_link_id, notes")
    .eq("proposal_id", id)
    .eq("created_via", "proposal_pi")
    .neq("status", "voided")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (piStatement) {
    const { data: payments } = await admin.from("billing_payments").select("id").eq("billing_statement_id", piStatement.id).limit(1);
    if (payments && payments.length > 0) {
      return NextResponse.json(
        { error: "A payment is already recorded against this proposal's pro-rata invoice, so its terms are locked. Talk to accounts before changing anything." },
        { status: 409 },
      );
    }
  }

  const parsed = createProposalSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const fieldErrors = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return NextResponse.json({ error: `Validation failed: ${fieldErrors}`, details: parsed.error.issues }, { status: 400 });
  }
  if (parsed.data.lead_id !== old.lead_id) {
    return NextResponse.json({ error: "A revision must stay on the same lead." }, { status: 400 });
  }

  const nextRevision = Number(old.revision_number ?? 1) + 1;
  const newNumber = revisionProposalNumber(old.proposal_number, Number(old.revision_number ?? 1));
  const { service_quotas, ...fields } = parsed.data;

  // The unique proposal_number is the guard against a double-click or two
  // people revising the same proposal at once: the second insert is refused.
  const { data: revision, error: insertErr } = await admin
    .from("proposals")
    .insert({
      ...fields,
      ...revisionTotals(parsed.data),
      proposal_number: newNumber,
      status: "draft",
      revision_of: old.id,
      revision_number: nextRevision,
      created_by: actor.id,
    })
    .select("*")
    .single();
  if (insertErr || !revision) {
    if (insertErr?.code === "23505") {
      return NextResponse.json({ error: "This proposal has already been revised. Refresh to see the latest version." }, { status: 409 });
    }
    return NextResponse.json({ error: insertErr?.message ?? "Failed to create the revision" }, { status: 500 });
  }

  if (service_quotas && service_quotas.length > 0) {
    await admin.from("proposal_service_quotas").insert(
      service_quotas.map((q) => ({
        proposal_id: revision.id,
        service_id: q.service_id,
        monthly_quota: q.monthly_quota,
        overage_rate: q.overage_rate,
      })),
    );
  }

  // Supersede the original. The status guard means a customer accepting or
  // paying between our check and now wins, and the revision is rolled back.
  const now = new Date().toISOString();
  const reason = `Superseded by ${newNumber}`;
  const hadDepositLink = old.deposit_razorpay_link_id as string | null;
  const hadMonthlyLink = old.razorpay_payment_link_id as string | null;
  const { data: superseded, error: supErr } = await admin
    .from("proposals")
    .update({
      status: "superseded",
      superseded_by: revision.id,
      superseded_at: now,
      // Link ids stay on the dead record on purpose: if a customer pays in the
      // instant before Razorpay cancels, the webhook can still find this
      // proposal and record the money (without changing its status).
      ...(hadDepositLink || old.deposit_razorpay_link_url
        ? { deposit_link_cancelled_at: now, deposit_link_cancelled_by: actor.id, deposit_link_cancel_reason: reason }
        : {}),
    })
    .eq("id", id)
    .in("status", ["sent", "viewed"])
    // Null-safe: a plain neq would silently drop rows where the column is NULL.
    .or("deposit_payment_status.is.null,deposit_payment_status.neq.paid")
    .or("payment_status.is.null,payment_status.neq.paid")
    .select("id")
    .maybeSingle();

  if (supErr || !superseded) {
    await admin.from("proposal_service_quotas").delete().eq("proposal_id", revision.id);
    await admin.from("proposals").delete().eq("id", revision.id);
    return NextResponse.json(
      { error: "This proposal changed while you were revising it (it may have just been accepted or paid). Refresh and check before trying again." },
      { status: 409 },
    );
  }

  // Void the unpaid pro-rata invoice, then cancel every live payment link at
  // Razorpay. Best effort and non-fatal, matching the existing cancel flows: our
  // own state is what the receivables screens read, and a late payment on a link
  // Razorpay failed to cancel is recorded by the webhook without changing status.
  if (piStatement) {
    await admin
      .from("billing_statements")
      .update({
        status: "voided",
        voided_at: now,
        voided_by: actor.id,
        void_reason: "Proposal revised before payment",
        notes: [piStatement.notes, "--- VOIDED — proposal revised before payment ---"].filter(Boolean).join("\n"),
      })
      .eq("id", piStatement.id);
  }

  const linkIds = [hadDepositLink, hadMonthlyLink, piStatement?.razorpay_payment_link_id as string | null | undefined].filter(
    (l): l is string => !!l,
  );
  if (linkIds.length > 0) {
    try {
      const { data: settings } = await admin
        .from("app_settings")
        .select("key, value")
        .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
      const rzp: Record<string, string> = {};
      (settings || []).forEach((s: { key: string; value: string }) => {
        rzp[s.key] = s.value;
      });
      if (rzp.razorpay_enabled === "true" && rzp.razorpay_key_id && rzp.razorpay_key_secret) {
        const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");
        for (const linkId of linkIds) {
          const res = await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
            method: "POST",
            headers: { Authorization: `Basic ${auth}` },
          });
          if (!res.ok) console.warn(`[proposal-revise] Razorpay refused to cancel ${linkId} (${res.status})`);
        }
      }
    } catch (err) {
      console.warn("[proposal-revise] Razorpay cancel error (non-fatal):", err);
    }
  }

  logAudit(supabase, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: {
      action: { old: null, new: "superseded_by_revision" },
      status: { old: old.status, new: "superseded" },
      superseded_by: { old: null, new: revision.id },
    },
  });
  logAudit(supabase, {
    entityType: "proposal",
    entityId: revision.id,
    action: "create",
    performedBy: actor.id,
    changes: { record: { old: null, new: revision }, revision_of: { old: null, new: id } },
  });

  return NextResponse.json({ data: revision }, { status: 201 });
}

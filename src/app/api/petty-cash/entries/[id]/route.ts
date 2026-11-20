import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { canDecideEntry, nextStatusOnApprove, resubmitStage, type EntryStage } from "@/lib/petty-cash-approval";
import { createNotification } from "@/lib/in-app-notifications";
import { getPettyCashPolicy } from "@/lib/petty-cash-policy-server";

type Params = { params: Promise<{ id: string }> };

const endSentence = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);

/**
 * GET /api/petty-cash/entries/[id]
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("petty_cash_entries")
    .select(
      `*, book:petty_cash_books!petty_cash_entries_book_id_fkey(id, user_id, current_balance, owner:users!petty_cash_books_user_id_fkey(id, full_name, email)), category:petty_cash_categories!petty_cash_entries_category_id_fkey(id, name), submitter:users!petty_cash_entries_submitted_by_fkey(id, full_name, email), purchase_order:purchase_orders!petty_cash_entries_po_id_fkey(id, po_number)`
    )
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 404 });

  // Also fetch approval history
  const { data: approvals } = await supabase
    .from("petty_cash_approvals")
    .select("*, approver:users!petty_cash_approvals_approver_id_fkey(id, full_name)")
    .eq("entry_id", id)
    .order("decided_at", { ascending: true });

  return NextResponse.json({ data, approvals: approvals || [] });
}

const approveSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().optional(),
});

const resubmitSchema = z.object({
  action: z.literal("resubmit"),
  date: z.string().min(1),
  amount: z.number().positive(),
  category_id: z.string().uuid().optional().nullable(),
  description: z.string().min(1),
});

/**
 * PATCH /api/petty-cash/entries/[id] — approve or reject a spend entry
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();

  // Fetch current entry
  const { data: entry, error: fetchErr } = await supabase
    .from("petty_cash_entries")
    .select("*, book:petty_cash_books!petty_cash_entries_book_id_fkey(id, current_balance)")
    .eq("id", id)
    .single();

  if (fetchErr || !entry) return NextResponse.json({ error: "Entry not found" }, { status: 404 });

  // Handle resubmit — only the original submitter can resubmit a rejected entry
  if (body.action === "resubmit") {
    const resubmit = resubmitSchema.safeParse(body);
    if (!resubmit.success) return NextResponse.json({ error: resubmit.error.issues[0].message }, { status: 400 });

    if (entry.status !== "rejected") {
      return NextResponse.json({ error: "Only rejected entries can be resubmitted" }, { status: 400 });
    }
    if (entry.withdrawn_at) {
      return NextResponse.json({ error: "You withdrew this expense. Log a new expense instead." }, { status: 400 });
    }
    if (entry.submitted_by !== dbUser.id) {
      return NextResponse.json({ error: "Only the original submitter can resubmit" }, { status: 403 });
    }

    const { date, amount, category_id, description } = resubmit.data;

    // Back to the stage that rejected it (see resubmitStage for when it restarts at the manager).
    const { data: lastRejection } = await supabase
      .from("petty_cash_approvals").select("approval_level")
      .eq("entry_id", id).eq("decision", "rejected")
      .order("decided_at", { ascending: false }).limit(1).maybeSingle();
    const policy = await getPettyCashPolicy(createAdminClient());
    const backTo = resubmitStage({
      rejectedLevel: (lastRejection?.approval_level as "manager" | "admin" | undefined) ?? null,
      oldAmount: Number(entry.amount), newAmount: amount, threshold: policy.secondApprovalAmount,
    });

    await supabase.from("petty_cash_entries").update({
      date,
      amount,
      category_id: category_id || null,
      description,
      status: backTo,
      rejection_note: null,
    }).eq("id", id);

    logAudit(supabase, {
      entityType: "pc_entry",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { status: { old: "rejected", new: backTo }, amount: { old: entry.amount, new: amount }, description: { old: entry.description, new: description } },
    });

    return NextResponse.json({ success: true, status: backTo });
  }

  // Withdraw — the person closes a rejected expense they no longer want to pursue.
  if (body.action === "withdraw") {
    if (entry.status !== "rejected" || entry.withdrawn_at) {
      return NextResponse.json({ error: "Only a rejected expense that is still open can be withdrawn." }, { status: 400 });
    }
    if (entry.submitted_by !== dbUser.id) {
      return NextResponse.json({ error: "Only the person who logged this expense can withdraw it." }, { status: 403 });
    }
    await supabase.from("petty_cash_entries").update({ withdrawn_at: new Date().toISOString() }).eq("id", id);
    logAudit(supabase, { entityType: "pc_entry", entityId: id, action: "update", performedBy: dbUser.id, changes: { withdrawn: { old: false, new: true } } });
    return NextResponse.json({ success: true });
  }

  const parsed = approveSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });

  const { action, note } = parsed.data;

  if (entry.status !== "pending_manager" && entry.status !== "pending_admin") {
    return NextResponse.json({ error: `Entry is in '${entry.status}' state and cannot be approved/rejected` }, { status: 400 });
  }
  // One place decides who may act: not your own expense, and only the right role for this stage.
  const decision = canDecideEntry(dbUser.role, dbUser.id, entry);
  if (!decision.ok) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const stage = entry.status as EntryStage;
  const policy = await getPettyCashPolicy(createAdminClient());
  const amount = Number(entry.amount);

  const admin = createAdminClient();
  // Two people acting on the same stage at once: the database refuses the second one.
  const changed = () => NextResponse.json({ error: "Someone else just decided this expense. Refresh to see its current state." }, { status: 409 });
  const failed = (msg: string) => msg.includes("ENTRY_CHANGED") ? changed() : NextResponse.json({ error: msg }, { status: 500 });

  if (action === "reject") {
    const { error } = await admin.rpc("pc_reject_entry", {
      p_entry_id: id, p_approver_id: dbUser.id, p_expected_status: stage,
      p_level: stage === "pending_manager" ? "manager" : "admin", p_note: note || null,
    });
    if (error) return failed(error.message);
    logAudit(supabase, { entityType: "pc_entry", entityId: id, action: "update", performedBy: dbUser.id, changes: { status: { old: stage, new: "rejected" } } });
    // Tell the person now, with the reason, so they do not have to discover it by opening the list.
    await createNotification({
      userId: entry.submitted_by,
      type: "petty_cash_rejected",
      title: `Expense ${entry.entry_number} was rejected`,
      body: `${endSentence(note || "No reason was given")} Open it to fix and resubmit, or withdraw it.`,
      url: "/petty-cash?tab=entries",
      entityType: "pc_entry",
      entityId: id,
    });
    return NextResponse.json({ success: true, status: "rejected" });
  }

  const nextStatus = nextStatusOnApprove(dbUser.role, stage, amount, policy.secondApprovalAmount);
  // An admin approving a large amount at stage 1 covers both stages, so record it as an admin approval.
  const adminOneStep = stage === "pending_manager" && nextStatus === "approved" && amount >= policy.secondApprovalAmount;

  // Status change, approval record and balance deduction happen in one locked transaction.
  const { error } = await admin.rpc("pc_approve_entry", {
    p_entry_id: id, p_approver_id: dbUser.id, p_expected_status: stage, p_next_status: nextStatus,
    p_level: stage === "pending_manager" && !adminOneStep ? "manager" : "admin",
    p_note: adminOneStep ? [note, "Admin approved in one step (covers both approval stages)"].filter(Boolean).join(" — ") : note || null,
  });
  if (error) return failed(error.message);

  logAudit(supabase, { entityType: "pc_entry", entityId: id, action: "update", performedBy: dbUser.id, changes: { status: { old: stage, new: nextStatus } } });
  return NextResponse.json({ success: true, status: nextStatus });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/petty-cash/requests/[id]
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("petty_cash_requests")
    .select(
      `*, book:petty_cash_books!petty_cash_requests_book_id_fkey(id, user_id, current_balance, owner:users!petty_cash_books_user_id_fkey(id, full_name, email)), requester:users!petty_cash_requests_created_by_fkey(id, full_name, email), approver:users!petty_cash_requests_approved_by_fkey(id, full_name), issuer:users!petty_cash_requests_issued_by_fkey(id, full_name)`
    )
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json({ data });
}

const approveSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().optional(),
});

const issueSchema = z.object({
  action: z.literal("issue"),
  issuance_method: z.enum(["cash", "upi", "bank_transfer", "cheque"]),
  issuance_reference: z.string().optional(),
  issuance_proof_url: z.string().optional(),
});

/**
 * PATCH /api/petty-cash/requests/[id]
 * Actions: approve, reject, issue
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
  const action = body.action;

  // Fetch current request
  const { data: req, error: fetchErr } = await supabase
    .from("petty_cash_requests")
    .select("*, book:petty_cash_books!petty_cash_requests_book_id_fkey(id, current_balance)")
    .eq("id", id)
    .single();

  if (fetchErr || !req) return NextResponse.json({ error: "Request not found" }, { status: 404 });

  if (action === "approve" || action === "reject") {
    const parsed = approveSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });

    if (!["admin", "manager", "accounts"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Only managers/admins can approve requests" }, { status: 403 });
    }
    if (req.status !== "pending") {
      return NextResponse.json({ error: "Request is not in pending state" }, { status: 400 });
    }

    const newStatus = action === "approve" ? "approved" : "rejected";
    const now = new Date().toISOString();

    const updates: Record<string, unknown> = {
      status: newStatus,
      approved_by: dbUser.id,
      approved_at: now,
    };
    if (action === "reject") updates.rejection_note = parsed.data.note || null;

    const { error: updateErr } = await supabase
      .from("petty_cash_requests").update(updates).eq("id", id);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    // Log approval
    await supabase.from("petty_cash_approvals").insert({
      approval_type: "request",
      request_id: id,
      approver_id: dbUser.id,
      approval_level: dbUser.role === "manager" ? "manager" : "admin",
      decision: action === "approve" ? "approved" : "rejected",
      note: parsed.data.note || null,
    });

    logAudit(supabase, {
      entityType: "pc_request",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { status: { old: req.status, new: newStatus }, ...(action === "reject" && parsed.data.note ? { rejection_note: { old: null, new: parsed.data.note } } : {}) },
    });

    return NextResponse.json({ success: true, status: newStatus });
  }

  if (action === "issue") {
    const parsed = issueSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });

    if (!["admin", "accounts"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Only admin/accounts can issue cash" }, { status: 403 });
    }
    if (req.status !== "approved") {
      return NextResponse.json({ error: "Request must be approved before issuing" }, { status: 400 });
    }

    const now = new Date().toISOString();

    // Update request to issued
    const { error: updateErr } = await supabase
      .from("petty_cash_requests")
      .update({
        status: "issued",
        issued_by: dbUser.id,
        issued_at: now,
        issuance_method: parsed.data.issuance_method,
        issuance_reference: parsed.data.issuance_reference || null,
        issuance_proof_url: parsed.data.issuance_proof_url || null,
      })
      .eq("id", id);

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    // Increase book balance
    const book = req.book as { id: string; current_balance: number };
    const newBalance = Number(book.current_balance) + Number(req.amount_requested);
    await supabase
      .from("petty_cash_books")
      .update({ current_balance: newBalance })
      .eq("id", req.book_id);

    logAudit(supabase, {
      entityType: "pc_request",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { status: { old: "approved", new: "issued" }, issuance_method: { old: null, new: parsed.data.issuance_method }, balance: { old: book.current_balance, new: newBalance } },
    });

    return NextResponse.json({ success: true, status: "issued", new_balance: newBalance });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

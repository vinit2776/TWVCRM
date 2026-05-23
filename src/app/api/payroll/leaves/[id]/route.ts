import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const reviewSchema = z.object({
  status:      z.enum(["approved", "rejected", "cancelled"]),
  review_note: z.string().nullable().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin, manager, or office_admin can review leave requests" }, { status: 403 });
  }

  const parsed = reviewSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();
  const now = new Date().toISOString();

  // Fetch existing request
  const { data: existing } = await admin
    .from("employee_leave_requests")
    .select("id, status, employee_id, leave_type, days_count")
    .eq("id", id)
    .single();

  if (!existing) return NextResponse.json({ error: "Leave request not found" }, { status: 404 });
  if (existing.status !== "pending") {
    return NextResponse.json({ error: "Only pending requests can be reviewed" }, { status: 400 });
  }

  const { data, error } = await admin
    .from("employee_leave_requests")
    .update({
      status: parsed.data.status,
      review_note: parsed.data.review_note ?? null,
      reviewed_by: dbUser.id,
      reviewed_at: now,
      updated_at: now,
    })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Update leave balance when approved
  if (parsed.data.status === "approved") {
    const year = new Date().getFullYear();
    const { data: balance } = await admin
      .from("employee_leave_balances")
      .select("id, cl_used, sl_used, lop_days")
      .eq("employee_id", existing.employee_id)
      .eq("policy_year", year)
      .single();

    if (balance) {
      const updates: Record<string, number> = {};
      if (existing.leave_type === "cl") updates.cl_used = (balance.cl_used ?? 0) + existing.days_count;
      if (existing.leave_type === "sl") updates.sl_used = (balance.sl_used ?? 0) + existing.days_count;
      if (existing.leave_type === "lop") updates.lop_days = (balance.lop_days ?? 0) + existing.days_count;
      if (Object.keys(updates).length > 0) {
        await admin
          .from("employee_leave_balances")
          .update({ ...updates, updated_at: now })
          .eq("id", balance.id);
      }
    }
  }

  logAudit(admin, {
    entityType: "leave_request",
    entityId: id,
    action: "update",
    performedBy: user.id,
    changes: {
      status: { old: existing.status, new: parsed.data.status },
      review_note: { old: null, new: parsed.data.review_note ?? null },
    },
  });

  return NextResponse.json({ data });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin, manager, or accounts can confirm electricity bills" }, { status: 403 });
  }

  const { data: bill } = await supabase
    .from("electricity_bills")
    .select("id, status")
    .eq("id", id)
    .single();

  if (!bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });
  if (bill.status !== "draft") {
    return NextResponse.json({ error: `Bill is already ${bill.status} — only draft bills can be confirmed` }, { status: 422 });
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("electricity_bills")
    .update({ status: "invoiced", confirmed_by: dbUser.id, confirmed_at: now })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "electricity_bill",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "draft", new: "invoiced" },
      confirmed_by: { old: null, new: dbUser.id },
      confirmed_at: { old: null, new: now },
    },
  });

  return NextResponse.json({ data: { id, status: "invoiced" } });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("voucher_repository")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Voucher not found" }, { status: 404 });

  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check if current user is admin
  const { data: currentUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser || currentUser.role !== "admin") {
    return NextResponse.json({ error: "Only admins can update vouchers" }, { status: 403 });
  }

  const body = await request.json();
  const allowedFields: Record<string, unknown> = {};

  if (body.status) allowedFields.status = body.status;
  if (body.metadata !== undefined) allowedFields.metadata = body.metadata;
  if (body.validity_days !== undefined) allowedFields.validity_days = body.validity_days;

  if (Object.keys(allowedFields).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { data: oldVoucher } = await supabase
    .from("voucher_repository")
    .select("*")
    .eq("id", id)
    .single();

  const { data, error } = await supabase
    .from("voucher_repository")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (currentUser.id && oldVoucher) {
    logAudit(supabase, {
      entityType: "voucher",
      entityId: id,
      action: "update",
      performedBy: currentUser.id,
      changes: diffChanges(oldVoucher as Record<string, unknown>, allowedFields),
    });
  }

  return NextResponse.json({ data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check if current user is admin
  const { data: currentUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser || currentUser.role !== "admin") {
    return NextResponse.json({ error: "Only admins can delete vouchers" }, { status: 403 });
  }

  // Only allow deletion if status is "available"
  const { data: voucher } = await supabase
    .from("voucher_repository")
    .select("*")
    .eq("id", id)
    .single();

  if (!voucher) {
    return NextResponse.json({ error: "Voucher not found" }, { status: 404 });
  }

  if (voucher.status !== "available") {
    return NextResponse.json(
      { error: "Only vouchers with status 'available' can be deleted" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("voucher_repository")
    .delete()
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "voucher",
    entityId: id,
    action: "delete",
    performedBy: currentUser.id,
    changes: { record: { old: voucher, new: null } },
  });

  return NextResponse.json({ message: "Voucher deleted successfully" });
}

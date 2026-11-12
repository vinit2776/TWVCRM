import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";

async function authorise() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return { error: NextResponse.json({ error: "User not found" }, { status: 403 }) };
  if (dbUser.role === ENQUIRY_VIEWER_ROLE) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { dbUser };
}

// GET /api/whatsapp/number-labels   numbers someone labelled, newest first
export async function GET() {
  const auth = await authorise();
  if (auth.error) return auth.error;
  const admin = await createAdminClient();
  const { data, error } = await admin
    .from("whatsapp_number_labels")
    .select("last10, label, name, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

// DELETE /api/whatsapp/number-labels?last10=...   forget a label; the number is judged by its words again
export async function DELETE(request: NextRequest) {
  const auth = await authorise();
  if (auth.error) return auth.error;
  const last10 = request.nextUrl.searchParams.get("last10") ?? "";
  if (!/^\d{10}$/.test(last10)) return NextResponse.json({ error: "last10 must be 10 digits" }, { status: 400 });
  const admin = await createAdminClient();
  const { error } = await admin.from("whatsapp_number_labels").delete().eq("last10", last10);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

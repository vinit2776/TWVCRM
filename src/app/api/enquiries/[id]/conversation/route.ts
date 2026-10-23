import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { lastTenDigits } from "@/lib/enquiry-row";

const PAGE = 20;

// GET /api/enquiries/[id]/conversation?before=<iso>
// The WhatsApp conversation for an enquiry's number, read from the message log (not the
// 20 messages kept on the enquiry), oldest first, PAGE at a time. `before` pages backwards.
// Read-only. Returns an empty list for an enquiry with no number or no logged messages.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (dbUser.role === ENQUIRY_VIEWER_ROLE) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const before = request.nextUrl.searchParams.get("before");
  if (before && Number.isNaN(Date.parse(before))) return NextResponse.json({ error: "Invalid before" }, { status: 400 });

  const admin = await createAdminClient();
  const { data: enquiry } = await admin.from("lead_enquiries").select("lead_id, payload").eq("id", id).maybeSingle();
  if (!enquiry) return NextResponse.json({ error: "Enquiry not found" }, { status: 404 });

  let last10 = lastTenDigits((enquiry.payload as { mobile?: string } | null)?.mobile);
  if (!last10 && enquiry.lead_id) {
    const { data: lead } = await admin.from("leads").select("mobile, phone").eq("id", enquiry.lead_id).maybeSingle();
    last10 = lastTenDigits(lead?.mobile) ?? lastTenDigits(lead?.phone);
  }
  if (!last10) return NextResponse.json({ data: [], hasMore: false });

  let query = admin
    .from("whatsapp_messages")
    .select("id, direction, message_body, template_name, created_at")
    .eq("channel", "whatsapp")
    .or(`and(direction.eq.inbound,from_number.ilike.%${last10}),and(direction.neq.inbound,to_number.ilike.%${last10})`)
    .order("created_at", { ascending: false })
    .limit(PAGE + 1);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const hasMore = rows.length > PAGE;
  return NextResponse.json({ data: rows.slice(0, PAGE).reverse(), hasMore });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveAttachmentUrls } from "@/lib/communications-log";

export const dynamic = "force-dynamic";

/**
 * GET /api/communications?entity_type=billing_statement&entity_id=...
 *
 * Feeds <RecentCommunicationsCard> — the persistent, always-visible
 * counterpart to the post-send confirmation modal on a record page.
 *
 * Auth: admin, manager, accounts — mirrors /api/leads/[id]/billing-communications.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const entityType = searchParams.get("entity_type");
  const entityId = searchParams.get("entity_id");
  if (!entityType || !entityId) {
    return NextResponse.json({ error: "entity_type and entity_id are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("communications_log")
    .select("*")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const resolved = await resolveAttachmentUrls(data || []);
  return NextResponse.json({ data: resolved });
}

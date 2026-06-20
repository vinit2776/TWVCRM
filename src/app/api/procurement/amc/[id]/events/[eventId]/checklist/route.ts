import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";

const bulkUpsertSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid().optional(),
    label: z.string().min(1).max(300),
    checked: z.boolean(),
    notes: z.string().max(500).optional(),
    is_custom: z.boolean().optional(),
  })),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> }
) {
  const { eventId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("amc_event_checklist_items")
    .select(`
      id, event_id, label, checked, notes, is_custom,
      checked_by, checked_at, created_at,
      checker:users!amc_event_checklist_items_checked_by_fkey(id, full_name)
    `)
    .eq("event_id", eventId)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> }
) {
  const { eventId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const allowed = ["admin", "manager", "fms", "accounts", "office_admin"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = bulkUpsertSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });

  const admin = createAdminClient();
  const now = new Date().toISOString();

  const toUpdate = parsed.data.items.filter(i => i.id);
  const toInsert = parsed.data.items.filter(i => !i.id);

  const errors: string[] = [];

  for (const item of toUpdate) {
    const { error } = await admin
      .from("amc_event_checklist_items")
      .update({
        checked: item.checked,
        notes: item.notes || null,
        checked_by: item.checked ? dbUser.id : null,
        checked_at: item.checked ? now : null,
      })
      .eq("id", item.id!)
      .eq("event_id", eventId);
    if (error) errors.push(error.message);
  }

  if (toInsert.length > 0) {
    const { error } = await admin
      .from("amc_event_checklist_items")
      .insert(toInsert.map(item => ({
        event_id: eventId,
        label: item.label,
        checked: item.checked,
        notes: item.notes || null,
        is_custom: item.is_custom ?? true,
        checked_by: item.checked ? dbUser.id : null,
        checked_at: item.checked ? now : null,
      })));
    if (error) errors.push(error.message);
  }

  if (errors.length) return NextResponse.json({ error: errors.join("; ") }, { status: 500 });

  const { data } = await admin
    .from("amc_event_checklist_items")
    .select("*")
    .eq("event_id", eventId)
    .order("created_at", { ascending: true });

  return NextResponse.json({ data: data || [] });
}

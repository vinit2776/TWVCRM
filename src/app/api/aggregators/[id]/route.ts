import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { updateAggregatorSchema } from "@/lib/validations";
import { logAudit, diffChanges } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("aggregators")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  // Fetch related contacts and rate cards
  const [contactsRes, rateCardsRes] = await Promise.all([
    supabase
      .from("aggregator_contacts")
      .select("*")
      .eq("aggregator_id", id)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true }),
    supabase
      .from("aggregator_rate_cards")
      .select("*, location:locations!aggregator_rate_cards_location_id_fkey(id, name, code)")
      .eq("aggregator_id", id)
      .order("created_at", { ascending: false }),
  ]);

  return NextResponse.json({
    data: {
      ...data,
      contacts: contactsRes.data || [],
      rate_cards: rateCardsRes.data || [],
    },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const result = updateAggregatorSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  // Fetch current state for audit diff
  const { data: oldAggregator } = await supabase
    .from("aggregators")
    .select("*")
    .eq("id", id)
    .single();

  // Remove contacts from the update payload — they are managed via their own endpoint
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { contacts: _contacts, ...updateData } = result.data;

  const { data, error } = await supabase
    .from("aggregators")
    .update(updateData)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Audit log
  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  if (dbUser?.id && oldAggregator) {
    logAudit(supabase, {
      entityType: "aggregator",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(
        oldAggregator as Record<string, unknown>,
        updateData as Record<string, unknown>
      ),
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
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Capture before delete for audit
  const { data: oldAggregator } = await supabase
    .from("aggregators")
    .select("*")
    .eq("id", id)
    .single();

  const { error } = await supabase.from("aggregators").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "aggregator",
      entityId: id,
      action: "delete",
      performedBy: dbUser.id,
      changes: { record: { old: oldAggregator, new: null } },
    });
  }

  return NextResponse.json({ message: "Aggregator deleted" });
}

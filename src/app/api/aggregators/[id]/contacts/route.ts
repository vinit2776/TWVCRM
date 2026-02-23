import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const createContactSchema = z.object({
  name: z.string().min(1, "Contact name is required"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  designation: z.string().optional(),
  is_primary: z.boolean().default(false),
});

const updateContactSchema = createContactSchema.partial().extend({
  id: z.string().uuid(),
});

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
    .from("aggregator_contacts")
    .select("*")
    .eq("aggregator_id", id)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

export async function POST(
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
  const result = createContactSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  // If this contact is primary, un-primary existing ones
  if (result.data.is_primary) {
    await supabase
      .from("aggregator_contacts")
      .update({ is_primary: false })
      .eq("aggregator_id", id)
      .eq("is_primary", true);
  }

  const { data, error } = await supabase
    .from("aggregator_contacts")
    .insert({
      aggregator_id: id,
      ...result.data,
      email: result.data.email || null,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data }, { status: 201 });
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
  const result = updateContactSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  const { id: contactId, ...updateData } = result.data;

  // If making this contact primary, un-primary existing ones
  if (updateData.is_primary) {
    await supabase
      .from("aggregator_contacts")
      .update({ is_primary: false })
      .eq("aggregator_id", id)
      .eq("is_primary", true);
  }

  const { data, error } = await supabase
    .from("aggregator_contacts")
    .update({ ...updateData, email: updateData.email || null })
    .eq("id", contactId)
    .eq("aggregator_id", id)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

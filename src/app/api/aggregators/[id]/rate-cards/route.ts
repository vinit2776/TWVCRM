import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const createRateCardSchema = z.object({
  purpose: z.enum([
    "gst_registration",
    "mca_registration",
    "branch_office",
    "mail_handling",
    "business_address",
  ]),
  location_id: z
    .string()
    .uuid()
    .optional()
    .or(z.literal(""))
    .transform((v) => v || undefined),
  rate: z.number().positive("Rate must be positive"),
  tenure_months: z.number().int().positive().default(12),
  description: z.string().optional(),
  effective_from: z.string().min(1, "Effective from date is required"),
  effective_until: z.string().optional(),
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
    .from("aggregator_rate_cards")
    .select(
      "*, location:locations!aggregator_rate_cards_location_id_fkey(id, name, code)"
    )
    .eq("aggregator_id", id)
    .eq("is_active", true)
    .order("purpose", { ascending: true })
    .order("created_at", { ascending: false });

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
  const result = createRateCardSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  // Deactivate any existing rate card for the same purpose + location combo
  const deactivateQuery = supabase
    .from("aggregator_rate_cards")
    .update({ is_active: false })
    .eq("aggregator_id", id)
    .eq("purpose", result.data.purpose)
    .eq("is_active", true);

  if (result.data.location_id) {
    deactivateQuery.eq("location_id", result.data.location_id);
  } else {
    deactivateQuery.is("location_id", null);
  }

  await deactivateQuery;

  const { data, error } = await supabase
    .from("aggregator_rate_cards")
    .insert({
      aggregator_id: id,
      ...result.data,
    })
    .select(
      "*, location:locations!aggregator_rate_cards_location_id_fkey(id, name, code)"
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data }, { status: 201 });
}

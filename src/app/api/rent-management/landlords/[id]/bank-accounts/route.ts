import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { RENT_MANAGEMENT_ROLES } from "@/lib/constants";
import { zodErrorResponse } from "@/lib/validations";

const createBankAccountSchema = z.object({
  bank_name: z.string().min(1, "Bank name is required"),
  account_number: z.string().min(1, "Account number is required"),
  ifsc_code: z.string().min(1, "IFSC code is required"),
  account_holder_name: z.string().nullish(),
  is_primary: z.boolean().default(false),
  is_verified: z.boolean().default(false),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !RENT_MANAGEMENT_ROLES.includes(dbUser.role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("landlord_bank_accounts")
    .select("*")
    .eq("landlord_id", id)
    .order("is_primary", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = createBankAccountSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  // If setting as primary, unset any existing primary
  if (parsed.data.is_primary) {
    await supabase
      .from("landlord_bank_accounts")
      .update({ is_primary: false })
      .eq("landlord_id", id);
  }

  const { data, error } = await supabase
    .from("landlord_bank_accounts")
    .insert({ ...parsed.data, landlord_id: id })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}

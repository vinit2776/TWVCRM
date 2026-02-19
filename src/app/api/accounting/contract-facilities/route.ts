import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createContractFacilitySchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const contractId = searchParams.get("contract_id");

  if (!contractId) {
    return NextResponse.json({ error: "contract_id is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("contract_facilities")
    .select("*")
    .eq("contract_id", contractId)
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const result = createContractFacilitySchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  const { data: facility, error: insertError } = await supabase
    .from("contract_facilities")
    .insert({
      ...result.data,
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      return NextResponse.json({ error: "A facility with this name already exists for this contract" }, { status: 409 });
    }
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  if (facility && dbUser?.id) {
    logAudit(supabase, {
      entityType: "contract_facility",
      entityId: facility.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: facility } },
    });
  }

  return NextResponse.json({ data: facility }, { status: 201 });
}

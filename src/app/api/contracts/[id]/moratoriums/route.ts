import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const MAX_MORATORIUMS_PER_CONTRACT = 1;

const CreateSchema = z.object({
  moratorium_month: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/, "Must be first of month (YYYY-MM-01)"),
  reason: z.string().min(10, "Reason must be at least 10 characters"),
});

// GET /api/contracts/[id]/moratoriums — list all moratoriums for a contract
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("contract_billing_moratoriums")
    .select(`
      *,
      requested_by_user:users!contract_billing_moratoriums_requested_by_fkey(full_name),
      authorized_by_user:users!contract_billing_moratoriums_authorized_by_fkey(full_name)
    `)
    .eq("contract_id", contractId)
    .order("moratorium_month", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST /api/contracts/[id]/moratoriums — request a new moratorium
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Resolve auth user → internal users.id
  const { data: dbUser } = await admin
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User profile not found" }, { status: 403 });

  const body = await req.json();
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { moratorium_month, reason } = parsed.data;

  // --- Validation ---

  // 1. Contract must exist and be active
  const { data: contract } = await admin
    .from("contracts")
    .select("id, start_date, end_date, status")
    .eq("id", contractId)
    .single();

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  if (!["active", "renewal_in_progress"].includes(contract.status)) {
    return NextResponse.json(
      { error: "Moratoriums can only be requested for active contracts" },
      { status: 422 }
    );
  }

  // 2. Month must fall within contract tenure
  const contractStart = contract.start_date.slice(0, 7); // "YYYY-MM"
  const contractEnd = contract.end_date.slice(0, 7);
  const requestedMonth = moratorium_month.slice(0, 7);

  if (requestedMonth < contractStart || requestedMonth > contractEnd) {
    return NextResponse.json(
      { error: "Moratorium month must fall within the contract tenure" },
      { status: 422 }
    );
  }

  // 3. Cannot be first or last billing month
  if (requestedMonth === contractStart) {
    return NextResponse.json(
      { error: "Cannot waive the first billing month of a contract" },
      { status: 422 }
    );
  }
  if (requestedMonth === contractEnd) {
    return NextResponse.json(
      { error: "Cannot waive the last billing month — required for settlement" },
      { status: 422 }
    );
  }

  // 4. Cannot be retroactive — no finalized statement must exist for this month
  const { data: existingStatement } = await admin
    .from("billing_statements")
    .select("id, status")
    .eq("contract_id", contractId)
    .eq("period_start", moratorium_month)
    .in("status", ["finalized", "exported"])
    .maybeSingle();

  if (existingStatement) {
    return NextResponse.json(
      { error: "A finalized billing statement already exists for this month. Use the void flow instead." },
      { status: 422 }
    );
  }

  // 5. Max moratoriums per contract
  const { count } = await admin
    .from("contract_billing_moratoriums")
    .select("id", { count: "exact", head: true })
    .eq("contract_id", contractId)
    .eq("status", "approved");

  if ((count ?? 0) >= MAX_MORATORIUMS_PER_CONTRACT) {
    return NextResponse.json(
      { error: `This contract has already used its maximum of ${MAX_MORATORIUMS_PER_CONTRACT} approved moratorium(s)` },
      { status: 422 }
    );
  }

  // 6. No duplicate pending/approved for the same month
  const { data: duplicate } = await admin
    .from("contract_billing_moratoriums")
    .select("id, status")
    .eq("contract_id", contractId)
    .eq("moratorium_month", moratorium_month)
    .in("status", ["pending", "approved"])
    .maybeSingle();

  if (duplicate) {
    return NextResponse.json(
      { error: `A ${duplicate.status} moratorium already exists for this month` },
      { status: 422 }
    );
  }

  // --- Insert ---
  const { data: moratorium, error } = await admin
    .from("contract_billing_moratoriums")
    .insert({
      contract_id: contractId,
      moratorium_month,
      reason,
      status: "pending",
      requested_by: dbUser.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(admin, {
    entityType: "contract_billing_moratorium",
    entityId: moratorium.id,
    action: "moratorium_requested",
    performedBy: dbUser.id,
    changes: { moratorium_month: { old: null, new: moratorium_month }, reason: { old: null, new: reason } },
  });

  return NextResponse.json(moratorium, { status: 201 });
}

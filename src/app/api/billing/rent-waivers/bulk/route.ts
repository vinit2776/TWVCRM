import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";
import { createRentWaiver } from "@/lib/rent-waivers";

const BulkSchema = z.object({
  items: z.array(z.object({
    contract_id: z.string().uuid(),
    waived_month: z.string().regex(/^\d{4}-\d{2}-01$/, "Must be first of month (YYYY-MM-01)"),
  })).min(1).max(300),
  reason: z.string().trim().min(5, "Give a short reason (at least 5 characters)"),
});

/**
 * POST /api/billing/rent-waivers/bulk — admin only.
 *
 * "Waive all…" on Billing → Unbilled's "Before CRM billing" bucket: waives
 * many contract-months with one reason. Each item goes through the same
 * createRentWaiver() checks as a single waiver; one item failing (e.g.
 * already waived) never blocks the rest — the response lists what was
 * skipped and why. Nothing is sent to any customer.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: dbUser } = await admin.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can waive billing" }, { status: 403 });
  }

  const parsed = BulkSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const { items, reason } = parsed.data;

  let waived = 0;
  const skipped: { contract_id: string; waived_month: string; error: string }[] = [];
  for (const item of items) {
    const result = await createRentWaiver(admin, {
      contractId: item.contract_id, waivedMonth: item.waived_month, reason, userId: dbUser.id,
    });
    if (result.ok) waived++;
    else skipped.push({ ...item, error: result.error });
  }

  return NextResponse.json({ waived, skipped });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { RENT_MANAGEMENT_ROLES } from "@/lib/constants";

const updateLeaseSchema = z.object({
  landlord_id: z.string().uuid().nullish(),
  lease_number: z.string().nullish(),
  registered_deed_number: z.string().nullish(),
  lease_start_date: z.string().optional(),
  lease_end_date: z.string().optional(),
  lock_in_end_date: z.string().nullish(),
  base_rent_amount: z.number().positive().optional(),
  security_deposit_amount: z.number().min(0).optional(),
  rent_due_day: z.number().int().min(1).max(28).optional(),
  advance_months: z.number().int().min(0).optional(),
  escalation_type: z.enum(["none", "percentage", "flat", "step_up"]).optional(),
  escalation_value: z.number().nullish(),
  escalation_frequency: z.enum(["annual", "bi_annual", "custom"]).optional(),
  next_escalation_date: z.string().nullish(),
  tds_applicable: z.boolean().optional(),
  tds_section: z.enum(["194I", "194IB"]).optional(),
  tds_rate: z.number().min(0).max(100).optional(),
  status: z.enum(["active", "expired", "terminated", "on_hold"]).optional(),
  approval_mode: z.enum(["manual", "blanket"]).optional(),
  notes: z.string().nullish(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !RENT_MANAGEMENT_ROLES.includes(dbUser.role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("property_leases")
    .select(`
      *,
      location:locations(id, name, city, address),
      landlord:landlords(*, bank_accounts:landlord_bank_accounts(*))
    `)
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: "Lease not found" }, { status: 404 });

  // Viewers get a summary — no financial amounts, no bank details
  if (dbUser.role === "viewer") {
    const { base_rent_amount, security_deposit_amount, tds_rate, tds_section,
            escalation_value, advance_months, ...summary } = data as Record<string, unknown>;
    void base_rent_amount; void security_deposit_amount; void tds_rate;
    void tds_section; void escalation_value; void advance_months;
    if (summary.landlord && typeof summary.landlord === "object") {
      const l = summary.landlord as Record<string, unknown>;
      delete l.bank_accounts;
      delete l.pan_number;
    }
    return NextResponse.json({ data: summary, viewer_restricted: true });
  }

  return NextResponse.json({ data });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();

  // Only admin may change the approval_mode
  if (body.approval_mode !== undefined && dbUser.role !== "admin")
    return NextResponse.json({ error: "Only admin can change approval mode" }, { status: 403 });

  const parsed = updateLeaseSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { data, error } = await supabase
    .from("property_leases")
    .update(parsed.data)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(supabase, { entityType: "property_lease", entityId: id, action: "update", performedBy: dbUser.id });
  return NextResponse.json({ data });
}

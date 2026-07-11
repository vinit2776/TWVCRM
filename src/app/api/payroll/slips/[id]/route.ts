import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const patchSchema = z.object({
  lta_this_month:   z.number().min(0).optional(),
  other_deductions: z.number().min(0).optional(),
  override_note:    z.string().min(1),
});

/**
 * PATCH /api/payroll/slips/[id]
 * Allows HR/accounts to override LTA or other deductions on a draft slip.
 * Net payable is recomputed server-side. Locked (finalized) slips reject edits.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const admin = createAdminClient();

  const { data: slip } = await admin
    .from("payroll_slips")
    .select("*")
    .eq("id", id)
    .single();

  if (!slip) return NextResponse.json({ error: "Slip not found" }, { status: 404 });
  if (slip.is_locked) {
    return NextResponse.json({ error: "Slip is locked — payroll run is finalized" }, { status: 400 });
  }

  const ltaThisMonth   = parsed.data.lta_this_month   ?? slip.lta_this_month;
  const otherDeductions = parsed.data.other_deductions ?? slip.other_deductions;

  // Recompute totals
  const totalDeductions = round2(
    slip.lop_deduction + slip.pt_deduction + slip.tds_deduction +
    slip.pf_employee + slip.esi_employee + otherDeductions
  );
  const grossPayable = round2(slip.gross_payable - slip.lta_this_month + ltaThisMonth);
  const netPayable   = round2(grossPayable - totalDeductions);

  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("payroll_slips")
    .update({
      lta_this_month: ltaThisMonth,
      other_deductions: otherDeductions,
      gross_payable: grossPayable,
      total_deductions: totalDeductions,
      net_payable: netPayable,
      override_note: parsed.data.override_note,
      updated_at: now,
    })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(admin, {
    entityType: "payroll_slip",
    entityId: id,
    action: "update",
    performedBy: user.id,
    changes: {
      lta_this_month:   { old: slip.lta_this_month,   new: ltaThisMonth },
      other_deductions: { old: slip.other_deductions,  new: otherDeductions },
      net_payable:      { old: slip.net_payable,       new: netPayable },
      override_note:    { old: slip.override_note,     new: parsed.data.override_note },
    },
  });

  return NextResponse.json({ data });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

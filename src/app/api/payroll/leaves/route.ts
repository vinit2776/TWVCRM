import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { countWeekdaysInRange } from "@/lib/payroll";

const createSchema = z.object({
  employee_id: z.string().uuid(),
  leave_type:  z.enum(["cl", "sl", "lop"]),
  from_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to_date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason:      z.string().nullable().optional(),
});

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const p = request.nextUrl.searchParams;
  const status    = p.get("status");      // pending | approved | rejected | cancelled
  const empId     = p.get("employee_id");
  const from      = p.get("from");        // YYYY-MM-DD
  const to        = p.get("to");          // YYYY-MM-DD

  let query = supabase
    .from("employee_leave_requests")
    .select("*, employee:employees(id, full_name, department, designation)")
    .order("from_date", { ascending: false });

  if (status)  query = query.eq("status", status);
  if (empId)   query = query.eq("employee_id", empId);
  if (from)    query = query.gte("from_date", from);
  if (to)      query = query.lte("to_date", to);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { from_date, to_date, ...rest } = parsed.data;

  if (from_date > to_date) {
    return NextResponse.json({ error: "from_date must be on or before to_date" }, { status: 400 });
  }

  // Compute weekday count spanning the entire requested range
  const from = new Date(from_date);
  const to   = new Date(to_date);
  // Use a wide year/month window covering the whole range
  const fromYear = from.getFullYear();
  const toYear   = to.getFullYear();
  let days_count = 0;
  for (let y = fromYear; y <= toYear; y++) {
    for (let m = 0; m < 12; m++) {
      days_count += countWeekdaysInRange(from, to, y, m);
    }
  }

  if (days_count === 0) {
    return NextResponse.json({ error: "Selected dates contain no working days" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("employee_leave_requests")
    .insert({ ...rest, from_date, to_date, days_count })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(admin, {
    entityType: "leave_request",
    entityId: data.id,
    action: "create",
    performedBy: user.id,
    changes: { leave_request: { old: null, new: data } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

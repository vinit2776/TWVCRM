/**
 * Payroll computation engine for TWV CRM.
 *
 * Responsibilities:
 *   - Tamil Nadu Professional Tax (PT) slab calculation
 *   - Monthly working-day count (Mon–Sat, excludes Sundays)
 *   - LOP (Loss of Pay) deduction computation
 *   - Per-employee payslip generation from salary definition + attendance + leave data
 *   - Payroll run totals aggregation
 *
 * All monetary amounts are in INR (numeric, 2 decimal places).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Tamil Nadu Professional Tax Slabs ────────────────────────────────────────
//
// Tamil Nadu Tax on Professions, Trades, Callings and Employments Act, 1992.
// PT is deducted monthly and remitted half-yearly by the employer.
// Slab is based on monthly gross earnings.
//
// Max PT = ₹1,250/month (₹2,500/half-year).

const TN_PT_SLABS: { maxGross: number; pt: number }[] = [
  { maxGross: 21000, pt: 0 },
  { maxGross: 30000, pt: 135 },
  { maxGross: 45000, pt: 315 },
  { maxGross: 60000, pt: 690 },
  { maxGross: 75000, pt: 1025 },
  { maxGross: Infinity, pt: 1250 },
];

export function calculatePT(monthlyGross: number): number {
  for (const slab of TN_PT_SLABS) {
    if (monthlyGross <= slab.maxGross) return slab.pt;
  }
  return 1250;
}

// ── Working day helpers ───────────────────────────────────────────────────────

/**
 * Count Mon–Sat days (excludes Sundays) in a given month.
 * TWV treats Saturday as a working day; adjust if policy changes.
 */
export function workingDaysInMonth(year: number, month: number): number {
  // month is 0-indexed (JS Date convention)
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(year, month, d).getDay();
    if (day !== 0) count++; // 0 = Sunday
  }
  return count;
}

/**
 * Count weekday (Mon–Sat) days that fall within [from, to] inclusive
 * AND within the target [year, month]. Used for leave day counting.
 */
export function countWeekdaysInRange(from: Date, to: Date, year: number, month: number): number {
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);
  const start = from < monthStart ? monthStart : from;
  const end = to > monthEnd ? monthEnd : to;
  if (start > end) return 0;

  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    if (cur.getDay() !== 0) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ── Salary definition type ────────────────────────────────────────────────────

export interface SalaryDefinition {
  employee_id: string;
  basic: number;
  hra: number;
  da: number;
  special_allowance: number;
  mobile_reimbursement: number;
  other_reimbursements: number;
  lta_annual: number;
  tds_applicable: boolean;
  tds_monthly_amount: number;
  pf_applicable: boolean;
  esi_applicable: boolean;
  pan_number: string | null;
}

/** Monthly gross = all components except LTA (LTA is annual, paid separately). */
export function monthlyGross(def: Pick<SalaryDefinition, "basic" | "hra" | "da" | "special_allowance" | "mobile_reimbursement" | "other_reimbursements">): number {
  return def.basic + def.hra + def.da + def.special_allowance + def.mobile_reimbursement + def.other_reimbursements;
}

// ── Per-slip computation ──────────────────────────────────────────────────────

export interface SlipInput {
  employee: {
    id: string;
    full_name: string;
    department: string | null;
    designation: string | null;
  };
  salaryDef: SalaryDefinition;
  workingDays: number;      // calendar working days in the month
  daysPresent: number;      // from COSEC access_logs
  clDays: number;           // approved CL days this month
  slDays: number;           // approved SL days this month
  ltaThisMonth: number;     // HR marks which month LTA is disbursed (0 most months)
  otherDeductions: number;  // ad-hoc one-off deductions
}

export interface SlipResult {
  employee_id: string;
  employee_name: string;
  department: string | null;
  designation: string | null;

  working_days: number;
  days_present: number;
  cl_days: number;
  sl_days: number;
  lop_days: number;

  basic: number;
  hra: number;
  da: number;
  special_allowance: number;
  mobile_reimbursement: number;
  other_reimbursements: number;
  lta_this_month: number;
  gross_payable: number;

  lop_deduction: number;
  pt_deduction: number;
  tds_deduction: number;
  pf_employee: number;
  esi_employee: number;
  other_deductions: number;
  total_deductions: number;
  net_payable: number;
}

export function computeSlip(input: SlipInput): SlipResult {
  const { employee, salaryDef, workingDays, daysPresent, clDays, slDays, ltaThisMonth, otherDeductions } = input;

  const grossMonthly = monthlyGross(salaryDef);

  // LOP = unaccounted absent days (absent - (CL + SL available))
  // Attendance covers: present days + approved leave days = "paid days"
  const paidDays = daysPresent + clDays + slDays;
  const lopDays = Math.max(0, workingDays - paidDays);

  // LOP deduction: proportional to monthly gross
  const lopDeduction = workingDays > 0
    ? round2(grossMonthly / workingDays * lopDays)
    : 0;

  // Gross payable after LOP
  const grossPayable = round2(grossMonthly - lopDeduction + ltaThisMonth);

  // PT is on monthly gross (before LOP), TN statutory rule
  const ptDeduction = calculatePT(grossMonthly);

  const tdsDeduction = salaryDef.tds_applicable ? salaryDef.tds_monthly_amount : 0;

  // PF: 12% of basic (employee share), capped at ₹1,800/month — future
  const pfEmployee = salaryDef.pf_applicable
    ? Math.min(round2(salaryDef.basic * 0.12), 1800)
    : 0;

  // ESI: 0.75% of gross, only if gross ≤ ₹21,000 — future
  const esiEmployee = salaryDef.esi_applicable && grossMonthly <= 21000
    ? round2(grossMonthly * 0.0075)
    : 0;

  const totalDeductions = round2(lopDeduction + ptDeduction + tdsDeduction + pfEmployee + esiEmployee + otherDeductions);
  const netPayable = round2(grossPayable - totalDeductions);

  return {
    employee_id: employee.id,
    employee_name: employee.full_name,
    department: employee.department,
    designation: employee.designation,

    working_days: workingDays,
    days_present: daysPresent,
    cl_days: clDays,
    sl_days: slDays,
    lop_days: lopDays,

    basic: salaryDef.basic,
    hra: salaryDef.hra,
    da: salaryDef.da,
    special_allowance: salaryDef.special_allowance,
    mobile_reimbursement: salaryDef.mobile_reimbursement,
    other_reimbursements: salaryDef.other_reimbursements,
    lta_this_month: ltaThisMonth,
    gross_payable: grossPayable,

    lop_deduction: lopDeduction,
    pt_deduction: ptDeduction,
    tds_deduction: tdsDeduction,
    pf_employee: pfEmployee,
    esi_employee: esiEmployee,
    other_deductions: otherDeductions,
    total_deductions: totalDeductions,
    net_payable: netPayable,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Payroll run generation ────────────────────────────────────────────────────

export interface GeneratePayrollRunResult {
  run_id: string;
  run_month: string;       // YYYY-MM-DD (first of month)
  employee_count: number;
  total_gross: number;
  total_deductions: number;
  total_net: number;
  skipped: { employee_id: string; name: string; reason: string }[];
}

/**
 * Generate a payroll run for the given month.
 * - Idempotent: if a run already exists for the month, regenerates slips on top of it.
 * - Attendance is sourced from access_logs via COSEC (first IN per IST day = present).
 * - Leave is sourced from approved employee_leave_requests.
 * - Skips employees with no salary definition (reports them in `skipped`).
 */
export async function generatePayrollRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any>,
  year: number,
  month: number, // 0-indexed
): Promise<GeneratePayrollRunResult> {
  const runMonth = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const monthStart = runMonth;
  const monthEnd = `${year}-${String(month + 1).padStart(2, "0")}-${new Date(year, month + 1, 0).getDate()}`;
  const wDays = workingDaysInMonth(year, month);

  // 1. Upsert the payroll_run header
  const { data: run, error: runErr } = await admin
    .from("payroll_runs")
    .upsert({ run_month: runMonth, status: "draft" }, { onConflict: "run_month" })
    .select("id")
    .single();
  if (runErr || !run) throw new Error(`Failed to create payroll run: ${runErr?.message}`);

  // 2. Fetch all active employees with their salary definitions
  const { data: employees } = await admin
    .from("employees")
    .select("id, full_name, department, designation, employee_salary_definitions(*)")
    .eq("is_active", true);

  // 3. Fetch attendance for this month from access_logs
  //    First IN per employee per IST day = present
  const { data: attendanceRows } = await admin
    .from("access_logs")
    .select("entity_id, event_time")
    .eq("user_type", "employee")
    .eq("direction", "IN")
    .gte("event_time", `${monthStart}T00:00:00+05:30`)
    .lte("event_time", `${monthEnd}T23:59:59+05:30`);

  // Build a map: employee_id → count of distinct IST days with at least one IN
  const attendanceMap = new Map<string, number>();
  if (attendanceRows) {
    const daySetByEmployee = new Map<string, Set<string>>();
    for (const row of attendanceRows) {
      if (!row.entity_id) continue;
      const istDay = new Date(row.event_time)
        .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
      if (!daySetByEmployee.has(row.entity_id)) daySetByEmployee.set(row.entity_id, new Set());
      daySetByEmployee.get(row.entity_id)!.add(istDay);
    }
    for (const [empId, days] of daySetByEmployee) {
      attendanceMap.set(empId, days.size);
    }
  }

  // 4. Fetch all approved leave requests overlapping this month
  const { data: leaveRows } = await admin
    .from("employee_leave_requests")
    .select("employee_id, leave_type, from_date, to_date, days_count")
    .eq("status", "approved")
    .lte("from_date", monthEnd)
    .gte("to_date", monthStart);

  // Build leave map: employee_id → { cl, sl }
  const leaveMap = new Map<string, { cl: number; sl: number }>();
  if (leaveRows) {
    for (const lr of leaveRows) {
      const existing = leaveMap.get(lr.employee_id) ?? { cl: 0, sl: 0 };
      const daysInMonth = countWeekdaysInRange(
        new Date(lr.from_date),
        new Date(lr.to_date),
        year,
        month,
      );
      if (lr.leave_type === "cl") existing.cl += daysInMonth;
      else if (lr.leave_type === "sl") existing.sl += daysInMonth;
      leaveMap.set(lr.employee_id, existing);
    }
  }

  // 5. Compute slips
  const slipped: SlipResult[] = [];
  const skipped: GeneratePayrollRunResult["skipped"] = [];

  for (const emp of employees ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defs = (emp as any).employee_salary_definitions as SalaryDefinition[] | null;
    if (!defs || defs.length === 0) {
      skipped.push({ employee_id: emp.id, name: emp.full_name, reason: "No salary definition" });
      continue;
    }
    const salaryDef = defs[0]; // UNIQUE constraint ensures at most one

    const daysPresent = attendanceMap.get(emp.id) ?? 0;
    const leave = leaveMap.get(emp.id) ?? { cl: 0, sl: 0 };

    const slip = computeSlip({
      employee: emp,
      salaryDef,
      workingDays: wDays,
      daysPresent,
      clDays: leave.cl,
      slDays: leave.sl,
      ltaThisMonth: 0,
      otherDeductions: 0,
    });
    slipped.push(slip);
  }

  // 6. Upsert slips
  if (slipped.length > 0) {
    const rows = slipped.map(s => ({ payroll_run_id: run.id, ...s }));
    await admin
      .from("payroll_slips")
      .upsert(rows, { onConflict: "payroll_run_id,employee_id" });
  }

  // 7. Update run totals
  const totalGross = round2(slipped.reduce((s, r) => s + r.gross_payable, 0));
  const totalDeductions = round2(slipped.reduce((s, r) => s + r.total_deductions, 0));
  const totalNet = round2(slipped.reduce((s, r) => s + r.net_payable, 0));

  await admin
    .from("payroll_runs")
    .update({
      total_gross: totalGross,
      total_deductions: totalDeductions,
      total_net: totalNet,
      employee_count: slipped.length,
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  return {
    run_id: run.id,
    run_month: runMonth,
    employee_count: slipped.length,
    total_gross: totalGross,
    total_deductions: totalDeductions,
    total_net: totalNet,
    skipped,
  };
}

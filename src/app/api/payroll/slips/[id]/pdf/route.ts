/**
 * GET /api/payroll/slips/[id]/pdf
 *
 * Generates and returns a payslip PDF for a single payroll slip.
 * Requires: admin, accounts, manager, or office_admin.
 * Only available after the payroll run is finalized.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import jsPDF from "jspdf";
import { formatCurrency } from "@/lib/utils";

export const maxDuration = 30;

function fmt(n: number | null | undefined): string {
  return formatCurrency(Number(n ?? 0));
}


export async function GET(
  _req: NextRequest,
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

  if (!dbUser || !["admin", "accounts", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const admin = createAdminClient();

  const { data: slip, error } = await admin
    .from("payroll_slips")
    .select(`
      *,
      payroll_run:payroll_runs!payroll_slips_payroll_run_id_fkey(run_month, status),
      employee:employees!payroll_slips_employee_id_fkey(
        full_name, designation, department, date_of_joining,
        bank_account_number, bank_ifsc, bank_name, bank_account_holder_name,
        pan_number
      )
    `)
    .eq("id", id)
    .single();

  if (error || !slip) {
    return NextResponse.json({ error: "Slip not found" }, { status: 404 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = slip.payroll_run as any;
  if (run?.status !== "finalized") {
    return NextResponse.json({ error: "Payroll run is not yet finalized" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const emp = slip.employee as any;

  // Company details from app_settings
  const { data: settingRows } = await admin
    .from("app_settings")
    .select("key, value")
    .in("key", ["company_name", "company_address", "company_gstin"]);
  const settings: Record<string, string> = {};
  for (const s of settingRows ?? []) settings[s.key] = s.value;
  const companyName = settings.company_name ?? "The WorkVilla";
  const companyAddress = settings.company_address ?? "Chennai, Tamil Nadu";

  // Month label e.g. "June 2025"
  const runMonthDate = new Date(run.run_month);
  const monthLabel = runMonthDate.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  // Bank masking: show last 4 digits only
  const bankAcctRaw: string | null = emp?.bank_account_number ?? null;
  const bankDisplay = bankAcctRaw
    ? `XXXX XXXX ${bankAcctRaw.slice(-4)} — ${emp?.bank_name ?? ""} (${emp?.bank_ifsc ?? ""})`
    : "Not on file";

  // ── Build PDF ────────────────────────────────────────────────────────────────
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = 210;
  const margin = 15;
  const col2 = W - margin; // right-aligned value column
  const midX = W / 2;

  let y = 18;

  // Header
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(companyName, midX, y, { align: "center" });
  y += 6;
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(companyAddress, midX, y, { align: "center" });
  y += 5;
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text(`Salary Slip — ${monthLabel}`, midX, y, { align: "center" });
  y += 8;

  // Divider
  doc.setLineWidth(0.3);
  doc.line(margin, y, W - margin, y);
  y += 6;

  // Employee info block (left / right columns)
  const leftX = margin;
  const rightX = midX + 5;
  const col1ValueX = midX - 5;

  const infoRows: [string, string, string, string][] = [
    ["Employee Name", emp?.full_name ?? slip.employee_name, "Designation", emp?.designation ?? slip.designation ?? "—"],
    ["Department", emp?.department ?? slip.department ?? "—", "Date of Joining", emp?.date_of_joining ? new Date(emp.date_of_joining).toLocaleDateString("en-IN") : "—"],
    ["PAN", emp?.pan_number ?? "—", "Bank Transfer", bankDisplay],
  ];

  doc.setFontSize(9);
  for (const [lLabel, lValue, rLabel, rValue] of infoRows) {
    doc.setFont("helvetica", "bold");
    doc.text(lLabel + ":", leftX, y);
    doc.setFont("helvetica", "normal");
    doc.text(lValue, col1ValueX, y, { align: "right" });
    doc.setFont("helvetica", "bold");
    doc.text(rLabel + ":", rightX, y);
    doc.setFont("helvetica", "normal");
    doc.text(rValue, col2, y, { align: "right" });
    y += 5;
  }

  y += 3;
  doc.line(margin, y, W - margin, y);
  y += 6;

  // Attendance summary
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Attendance", leftX, y);
  y += 5;
  doc.setFontSize(9);

  const attRows: [string, string][] = [
    ["Working Days", String(slip.working_days)],
    ["Days Present", String(slip.days_present)],
    ["CL Taken", String(slip.cl_days)],
    ["SL Taken", String(slip.sl_days)],
    ["Loss of Pay Days", String(slip.lop_days)],
  ];
  for (const [label, value] of attRows) {
    doc.setFont("helvetica", "normal");
    doc.text(label, leftX + 4, y);
    doc.text(value, col1ValueX, y, { align: "right" });
    y += 5;
  }

  y += 3;
  doc.line(margin, y, W - margin, y);
  y += 6;

  // Earnings / Deductions side by side
  const earnX = leftX;
  const earnValX = col1ValueX;
  const dedX = rightX;
  const dedValX = col2;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Earnings", earnX, y);
  doc.text("Deductions", dedX, y);
  y += 5;
  doc.setFontSize(9);

  const earningsAll: [string, number][] = [
    ["Basic", Number(slip.basic)],
    ["HRA", Number(slip.hra)],
    ["DA", Number(slip.da)],
    ["Special Allowance", Number(slip.special_allowance)],
    ["Mobile Reimbursement", Number(slip.mobile_reimbursement)],
    ["Other Reimbursements", Number(slip.other_reimbursements)],
    ["LTA (this month)", Number(slip.lta_this_month)],
  ];
  const earnings = earningsAll.filter(([, v]) => v > 0);

  const deductionsAll: [string, number][] = [
    ["LOP Deduction", Number(slip.lop_deduction)],
    ["Professional Tax", Number(slip.pt_deduction)],
    ["TDS (Income Tax)", Number(slip.tds_deduction)],
    ["PF (Employee)", Number(slip.pf_employee)],
    ["ESI (Employee)", Number(slip.esi_employee)],
    ["Other Deductions", Number(slip.other_deductions)],
  ];
  const deductions = deductionsAll.filter(([, v]) => v > 0);

  const maxRows = Math.max(earnings.length, deductions.length);
  for (let i = 0; i < maxRows; i++) {
    doc.setFont("helvetica", "normal");
    if (earnings[i]) {
      doc.text(earnings[i][0], earnX + 4, y);
      doc.text(fmt(earnings[i][1]), earnValX, y, { align: "right" });
    }
    if (deductions[i]) {
      doc.text(deductions[i][0], dedX + 4, y);
      doc.text(fmt(deductions[i][1]), dedValX, y, { align: "right" });
    }
    y += 5;
  }

  y += 2;
  doc.setLineWidth(0.2);
  doc.line(margin, y, W - margin, y);
  y += 5;

  // Totals
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("Gross Payable", earnX + 4, y);
  doc.text(fmt(slip.gross_payable), earnValX, y, { align: "right" });
  doc.text("Total Deductions", dedX + 4, y);
  doc.text(fmt(slip.total_deductions), dedValX, y, { align: "right" });
  y += 7;

  // Net payable banner
  doc.setFillColor(30, 30, 30);
  doc.rect(margin, y - 4, W - margin * 2, 10, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.text("Net Pay", margin + 4, y + 3);
  doc.text(fmt(slip.net_payable), col2, y + 3, { align: "right" });
  doc.setTextColor(0, 0, 0);
  y += 14;

  // Footer note
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "italic");
  doc.text(
    "This is a computer-generated payslip and does not require a physical signature.",
    midX,
    y,
    { align: "center" },
  );

  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
  const empName = (emp?.full_name ?? slip.employee_name).replace(/\s+/g, "-");
  const filename = `Payslip-${empName}-${monthLabel.replace(" ", "-")}.pdf`;

  return new NextResponse(pdfBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}

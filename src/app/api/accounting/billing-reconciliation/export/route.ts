import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { buildBillingReconciliationReport, type ReconciliationCell, type ReconciliationCellType } from "@/lib/billing-reconciliation";
import { todayIst } from "@/lib/receivables";

// Fills mirror the on-screen legend exactly — same status, same color, so a
// printed/downloaded copy still reads the same way as the live report.
const FILL: Record<ReconciliationCellType, string> = {
  paid: "FFC6EFCE",
  partial: "FFFFEB9C",
  unpaid: "FFFFC7CE",
  future: "FFF2F2F2",
  projected: "FFE7E6E6",
  moratorium: "FFE4DFEC",
  terminated: "FFEDEDED",
  renewed_out: "FFDCE6F1",
  not_started: "FFEDEDED",
};
const FONT_COLOR: Partial<Record<ReconciliationCellType, string>> = {
  paid: "FF006100",
  partial: "FF9C6500",
  unpaid: "FF9C0006",
  renewed_out: "FF1F4E78",
};

function cellLabel(cell: ReconciliationCell): string | null {
  switch (cell.type) {
    case "moratorium": return `Moratorium — ${cell.reason ?? ""}`;
    case "terminated": return "No further billing";
    case "not_started": return "Not started yet";
    case "renewed_out": return `Renewed → ${cell.refContractNumber ?? "—"}`;
    default: return null;
  }
}

function appUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "";
  return base ? `${base.replace(/\/$/, "")}${path}` : path;
}

/**
 * GET /api/accounting/billing-reconciliation/export
 *
 * Same role gate and same data source as the JSON route — no duplicated
 * query, so the download can never disagree with what's on screen.
 */
export async function GET(_req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const report = await buildBillingReconciliationReport(supabase);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TWV CRM";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Billing Reconciliation");

  const monthHeaders = report.months.map((m) =>
    new Date(m.year, m.month - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "2-digit" })
  );
  const headerRow = sheet.addRow(["Contract", "Company", "Status", "Carried Fwd", ...monthHeaders, "12-Mo Total"]);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  });

  const writeAmountCell = (row: ExcelJS.Row, colIndex: number, cell: ReconciliationCell) => {
    const target = row.getCell(colIndex);
    const label = cellLabel(cell);
    if (label) {
      target.value = label;
      target.alignment = { horizontal: "center" };
    } else {
      // Kept as a plain number (not an ExcelJS hyperlink value) so the column
      // stays summable in Excel — the invoice link lives in the cell note instead.
      target.value = cell.amount;
      target.numFmt = '"₹"#,##0';
    }
    target.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[cell.type] } };
    const fontColor = FONT_COLOR[cell.type];
    if (fontColor) target.font = { color: { argb: fontColor } };
    if (cell.invoiceNumber) target.note = `Invoice: ${cell.invoiceNumber}`;
    else if (cell.type === "partial") target.note = `Collected ₹${Math.round(cell.collected).toLocaleString("en-IN")} of ₹${Math.round(cell.amount).toLocaleString("en-IN")}`;
  };

  const writeTotalCell = (row: ExcelJS.Row, colIndex: number, amount: number, owed: number) => {
    const target = row.getCell(colIndex);
    target.value = amount;
    target.numFmt = '"₹"#,##0';
    if (owed > 0) target.note = `₹${Math.round(owed).toLocaleString("en-IN")} due`;
  };

  for (const group of report.groups) {
    const groupRow = sheet.addRow([`${group.locationName} · ${group.contracts.length} contract${group.contracts.length === 1 ? "" : "s"}`]);
    groupRow.font = { bold: true, color: { argb: "FF1F4E78" } };
    groupRow.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } }; });

    for (const contract of group.contracts) {
      const row = sheet.addRow([
        contract.contractNumber,
        { text: contract.companyName, hyperlink: appUrl(`/contracts/${contract.id}`) },
        contract.status,
      ]);
      writeTotalCell(row, 4, contract.carriedForward.amount, contract.carriedForward.owed);
      if (contract.carriedForward.count > 0) row.getCell(4).note = `${contract.carriedForward.count} statement${contract.carriedForward.count === 1 ? "" : "s"} from before this window`;
      contract.cells.forEach((cell, i) => writeAmountCell(row, 5 + i, cell));
      writeTotalCell(row, 5 + contract.cells.length, contract.rowTotalAmount, contract.rowTotalOwed);
    }

    const subtotalRow = sheet.addRow([`${group.locationName} total`, "", ""]);
    subtotalRow.font = { bold: true };
    writeTotalCell(subtotalRow, 4, group.carriedForwardTotal.amount, group.carriedForwardTotal.owed);
    group.monthlyTotals.forEach((t, i) => writeTotalCell(subtotalRow, 5 + i, t.amount, t.owed));
    writeTotalCell(subtotalRow, 5 + group.monthlyTotals.length, group.totalAmount, group.totalOwed);
    subtotalRow.eachCell((cell) => { if (!cell.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } }; });
  }

  const overallRow = sheet.addRow([`Overall total · ${report.groups.length} center${report.groups.length === 1 ? "" : "s"}`, "", ""]);
  overallRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  writeTotalCell(overallRow, 4, report.overall.carriedForwardTotal.amount, report.overall.carriedForwardTotal.owed);
  report.overall.monthlyTotals.forEach((t, i) => writeTotalCell(overallRow, 5 + i, t.amount, t.owed));
  writeTotalCell(overallRow, 5 + report.overall.monthlyTotals.length, report.overall.totalAmount, report.overall.totalOwed);
  overallRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    if (!cell.font) cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  });

  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 28;
  sheet.getColumn(3).width = 16;
  sheet.getColumn(4).width = 16;
  for (let i = 5; i <= 5 + report.months.length; i++) sheet.getColumn(i).width = 16;
  sheet.views = [{ state: "frozen", xSplit: 4, ySplit: 1 }];

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `billing-reconciliation-${todayIst()}.xlsx`;

  return new NextResponse(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

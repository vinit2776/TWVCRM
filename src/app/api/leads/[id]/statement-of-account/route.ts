import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { buildStatementOfAccountPdf, loadStatementOfAccount } from "@/lib/statement-of-account-server";
import { currentFyStartYear, SOA_FY_COUNT } from "@/lib/statement-of-account";

export const maxDuration = 30;

const ALLOWED_ROLES = ["admin", "manager", "accounts", "sales_rep"];

/**
 * GET /api/leads/[id]/statement-of-account?fy=<start year, e.g. 2026 for FY 2026-27>
 *
 * Download-only PDF ledger of what the customer was billed (PIs and GST
 * invoices) and paid. Read-only: sends nothing to the customer.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: leadId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const cur = currentFyStartYear();
  const fy = Number(req.nextUrl.searchParams.get("fy") ?? cur);
  if (!Number.isInteger(fy) || fy > cur || fy <= cur - SOA_FY_COUNT) {
    return NextResponse.json({ error: "Invalid financial year" }, { status: 400 });
  }

  try {
    const result = await loadStatementOfAccount(createAdminClient(), leadId, fy);
    if (!result) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    const pdf = buildStatementOfAccountPdf(result);
    const admin = createAdminClient();
    void logAudit(admin, {
      entityType: "lead", entityId: leadId, action: "view", performedBy: dbUser.id,
      changes: { statement_of_account: { old: null, new: fy } },
    });
    const filename = `Statement-of-Account-${result.ledger.range.label.replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdf.length),
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to build statement" }, { status: 500 });
  }
}

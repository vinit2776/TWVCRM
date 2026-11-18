import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { buildPackageStatementPdf, loadPackageStatement } from "@/lib/package-statement-server";

export const maxDuration = 30;

const ALLOWED_ROLES = ["admin", "manager", "accounts", "sales_rep"];

/**
 * GET /api/prepaid-purchases/[id]/statement
 *
 * PDF ledger of one package: purchase, each booking that used it, and every
 * cancellation with the hours before start and whether credits were restored.
 * Read-only: sends nothing to the customer.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const admin = createAdminClient();
    const data = await loadPackageStatement(admin, id);
    if (!data) return NextResponse.json({ error: "Package not found" }, { status: 404 });
    const pdf = buildPackageStatementPdf(data);
    void logAudit(admin, {
      entityType: "prepaid_purchase", entityId: id, action: "view", performedBy: dbUser.id,
      changes: { package_statement: { old: null, new: "downloaded" } },
    });
    const filename = `Package-Statement-${data.party.name.replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;
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

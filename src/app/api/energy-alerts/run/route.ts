import { NextRequest, NextResponse } from "next/server";
import { zodErrorResponse } from "@/lib/validations";
import { appUrl, requireRole } from "@/lib/energy-alerts/auth";
import { ENERGY_ALERT_MANAGE_ROLES, runSchema } from "@/lib/energy-alerts/schema";
import { evaluateAllRules } from "@/lib/energy-alerts/evaluate";

/** "Check now" for one rule (or all). Same engine and same gates as the hourly cron: it can only email when
 *  the global mode is live AND the rule is Live. { dry: true } computes and writes nothing. */
export async function POST(request: NextRequest) {
  const auth = await requireRole(ENERGY_ALERT_MANAGE_ROLES);
  if ("error" in auth) return auth.error;
  let body: unknown = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }
  const parsed = runSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  try {
    const result = await evaluateAllRules(auth.admin, { ruleId: parsed.data.rule_id, dry: parsed.data.dry ?? false, appUrl: appUrl() });
    return NextResponse.json({ data: result });
  } catch (err) {
    console.error("[api/energy-alerts/run] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Check failed" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { generateDiscontinuationDraftsForCase } from "@/lib/vo-discontinuation";
import { statementCoversNextTerm } from "@/lib/vo-renewal-term";
import {
  VO_RENEWAL_GRACE_DAYS_SETTING,
  graceEndsAtFor,
  graceLastDay,
  parseGraceDays,
} from "@/lib/vo-renewal-desk";
import {
  LAPSE_DECIDABLE_STATUSES,
  LAPSE_DECISIONS,
  LAPSE_DECISION_LABELS,
  LAPSE_DECISION_ROLES,
  LAPSE_REASON_MIN_LENGTH,
  MAX_GRACE_EXTENSIONS,
  checkMoreTime,
  extensionsUsed,
  lapseDecisions,
  latestGraceDate,
  type LapseDecisionRecord,
} from "@/lib/vo-lapse-decision";

/**
 * GET  /api/cases/[id]/lapse-decision — what the lapsed-case panel needs.
 * POST /api/cases/[id]/lapse-decision — record a decision on a case whose
 *      term has ended unpaid: paid, more_time or discontinue.
 *
 * Nothing here contacts the client. "Discontinue" only prepares the drafts;
 * each one is approved and sent separately from the discontinuation screen.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z
  .object({
    decision: z.enum(LAPSE_DECISIONS),
    reason: z
      .string()
      .trim()
      .min(LAPSE_REASON_MIN_LENGTH, `Give a reason of at least ${LAPSE_REASON_MIN_LENGTH} characters`)
      .max(1000),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine((b) => b.decision !== "more_time" || !!b.until, {
    message: "Choose the new grace end date",
    path: ["until"],
  });

const CASE_SELECT =
  "*, location:locations!cases_location_id_fkey(name, address, city, state)";

/** Today in IST, the business's calendar day. */
function todayIst(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

type CaseRow = Record<string, unknown> & {
  id: string;
  status: string;
  end_date: string | null;
  renewal_grace_ends_at: string | null;
  metadata: unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openRenewalBill(admin: any, c: CaseRow) {
  const { data: bills } = await admin
    .from("billing_statements")
    .select("id, statement_number, total_amount, payment_status, period_start, created_at")
    .eq("case_id", c.id)
    .eq("statement_type", "vo_renewal")
    .is("voided_at", null)
    .neq("payment_status", "paid")
    .order("created_at", { ascending: false });
  const bill = ((bills ?? []) as Record<string, unknown>[]).find((b) =>
    statementCoversNextTerm(b.period_start as string | null, c.end_date),
  );
  if (!bill) return null;

  const { data: reports } = await admin
    .from("query_payment_reports")
    .select("id")
    .eq("claimed_statement_id", bill.id)
    .eq("status", "reported")
    .limit(1);
  return {
    id: bill.id as string,
    statement_number: bill.statement_number as string | null,
    total_amount: Number(bill.total_amount),
    payment_status: bill.payment_status as string,
    reported: (reports ?? []).length > 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function documentState(admin: any, caseId: string) {
  const { data } = await admin.from("vo_discontinuation_documents").select("status").eq("case_id", caseId);
  const rows = (data ?? []) as { status: string }[];
  return { count: rows.length, anySent: rows.some((r) => r.status !== "draft") };
}

async function authorise() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  return { dbUser: dbUser as { id: string; role: string; full_name: string | null } };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authorise();
  if ("error" in auth) return auth.error;

  const admin = await createAdminClient();
  const { data } = await admin
    .from("cases")
    .select("id, status, end_date, renewal_grace_ends_at, metadata")
    .eq("id", id)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const c = data as CaseRow;

  const today = todayIst();
  const settings = await getCachedSettings(admin, [VO_RENEWAL_GRACE_DAYS_SETTING]);
  const graceDays = parseGraceDays(settings[VO_RENEWAL_GRACE_DAYS_SETTING]);
  const ended = !!c.end_date && c.end_date < today;
  const decidable = ended && LAPSE_DECIDABLE_STATUSES.includes(c.status);

  const [bill, docs] = decidable
    ? await Promise.all([openRenewalBill(admin, c), documentState(admin, id)])
    : [null, { count: 0, anySent: false }];
  const used = extensionsUsed(c.metadata);

  return NextResponse.json({
    data: {
      today,
      status: c.status,
      end_date: c.end_date,
      decidable,
      can_decide: LAPSE_DECISION_ROLES.includes(auth.dbUser.role),
      grace_last_day: c.status === "lapsed" ? null : graceLastDay(c, graceDays),
      decisions: lapseDecisions(c.metadata),
      extensions_used: used,
      extensions_left: Math.max(MAX_GRACE_EXTENSIONS - used, 0),
      latest_grace_date: latestGraceDate(today),
      open_bill: bill,
      documents: docs.count,
      documents_sent: docs.anySent,
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authorise();
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;
  if (!LAPSE_DECISION_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Only an admin or manager can record this decision" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const body = parsed.data;

  const admin = await createAdminClient();
  const { data } = await admin.from("cases").select(CASE_SELECT).eq("id", id).maybeSingle();
  if (!data) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const c = data as unknown as CaseRow;

  const today = todayIst();
  if (!c.end_date || c.end_date >= today || !LAPSE_DECIDABLE_STATUSES.includes(c.status)) {
    return NextResponse.json(
      { error: "A decision can only be recorded on a live case whose term has ended." },
      { status: 409 },
    );
  }

  const docs = await documentState(admin, id);
  if (body.decision !== "discontinue" && docs.anySent) {
    return NextResponse.json(
      { error: "Discontinuation documents have already been approved or sent for this case, so it can't be reversed from here." },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const record: LapseDecisionRecord = {
    decision: body.decision,
    reason: body.reason,
    ...(body.decision === "more_time" ? { until: body.until } : {}),
    by: dbUser.id,
    by_name: dbUser.full_name,
    at: now,
  };
  const metadata =
    c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata)
      ? (c.metadata as Record<string, unknown>)
      : {};
  const nextMetadata = { ...metadata, lapse_decisions: [...lapseDecisions(c.metadata), record] };

  const update: Record<string, unknown> = { metadata: nextMetadata };

  if (body.decision === "more_time") {
    const problem = checkMoreTime({ today, until: body.until!, used: extensionsUsed(c.metadata) });
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    update.status = "grace_period";
    update.renewal_grace_ends_at = graceEndsAtFor(body.until!);
    update.lapsed_at = null;
  }

  if (body.decision === "discontinue") {
    if (docs.count === 0) {
      await generateDiscontinuationDraftsForCase(admin, c, c.end_date);
      const after = await documentState(admin, id);
      if (after.count === 0) {
        return NextResponse.json(
          { error: "The discontinuation documents could not be prepared. Nothing was changed; try again." },
          { status: 500 },
        );
      }
    }
    update.status = "lapsed";
    update.lapsed_at = c.status === "lapsed" && c.lapsed_at ? c.lapsed_at : now;
    update.renewal_grace_ends_at = null;
  }

  // Conditional on the status read above, so two people deciding at once
  // can't both win.
  const { data: updated, error } = await admin
    .from("cases")
    .update(update)
    .eq("id", id)
    .eq("status", c.status)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "The case changed while you were deciding. Reload and try again." }, { status: 409 });
  }

  logAudit(admin, {
    entityType: "case",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "renewal_lapse_decision" },
      decision: { old: null, new: LAPSE_DECISION_LABELS[body.decision] },
      reason: { old: null, new: body.reason },
      ...(update.status ? { status: { old: c.status, new: update.status } } : {}),
      ...("renewal_grace_ends_at" in update
        ? { renewal_grace_ends_at: { old: c.renewal_grace_ends_at, new: update.renewal_grace_ends_at } }
        : {}),
    },
  });

  return NextResponse.json({ data: { decision: body.decision, status: update.status ?? c.status } });
}

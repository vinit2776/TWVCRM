import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { queryEntityDef, type EntityRow } from "@/lib/queries/registry";
import {
  loadEntitySummaries,
  entityKey,
  fanOutQueryEvent,
  entityLabel,
  type QueryUser,
} from "@/lib/queries/server";
import { parseQueryRequest, storeAttachments } from "@/lib/queries/attachments";
import { UploadValidationError } from "@/lib/uploads/normalize-upload-server";
import { logAudit } from "@/lib/audit";
import { STATEMENT_PAYMENT_MODE_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import { reportableBalance, REPORT_TOLERANCE } from "@/lib/queries/payment-report-balance";
import {
  PAYMENT_REPORT_AUDIENCE_ROLES,
  PAYMENT_REPORT_ENTITY_TYPES,
  defaultNeededBy,
  describeReport,
  targetKindForEntity,
  validatePaymentReport,
  type PaymentReportEntityType,
} from "@/lib/queries/payment-reports";

/**
 * POST /api/queries/payment-reports — report a payment the customer made
 *                                     outside the CRM.
 * GET  /api/queries/payment-reports?status=reported — the unverified ones,
 *                                     for the AR page banner.
 *
 * Creates a `queries` thread (kind = 'payment_reported') plus the structured
 * row accounts reconcile against. Separate from POST /api/queries because
 * this payload is validated, not prose — see src/lib/queries/payment-reports.ts.
 */
export const dynamic = "force-dynamic";

/** How long a settled report keeps showing on the transaction it was raised on. */
const SETTLED_WINDOW_DAYS = 14;

/**
 * Deliberately NOT requireQueryUser().
 *
 * Reporting is open to every authenticated user, like petty cash entry: the
 * customer sends their payment screenshot to whoever they deal with, and an
 * fms or IT technician holding that screenshot with nowhere to put it is the
 * exact gap this feature closes. Accounts remain the control point — nothing
 * here becomes money without their verification.
 */
async function requireAnyUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ dbUser: QueryUser } | { error: NextResponse }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!dbUser) return { error: NextResponse.json({ error: "User not found" }, { status: 404 }) };
  return { dbUser: dbUser as QueryUser };
}

const REPORT_SELECT = `
  id, query_id, status, amount, paid_on, payment_mode, payment_reference,
  payer_name, payer_differs, billing_payment_id, resolution_note,
  claimed_statement_id, target_kind, reviewed_at, created_at,
  reviewed_by:users!query_payment_reports_reviewed_by_fkey(id, full_name, role),
  created_by:users!query_payment_reports_created_by_fkey(id, full_name, role),
  query:queries!query_payment_reports_query_id_fkey(id, entity_type, entity_id, status)
`;

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const auth = await requireAnyUser(supabase);
  if ("error" in auth) return auth.error;

  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "reported";
  const entityType = url.searchParams.get("entity_type");
  const entityId = url.searchParams.get("entity_id");
  const admin = createAdminClient();

  // Scoped to one transaction: what the report dialog asks for, so it can
  // show what has already been claimed instead of silently letting someone
  // claim the same money twice.
  if (entityType && entityId) {
    const { data: scoped, error: scopedErr } = await admin
      .from("query_payment_reports")
      .select(`${REPORT_SELECT}, timeline:queries!query_payment_reports_query_id_fkey(
        messages:query_messages(
          id, event_type, body, created_at,
          author:users!query_messages_created_by_fkey(full_name, role)
        )
      )`)
      .order("created_at", { ascending: false })
      .limit(50);
    if (scopedErr) return NextResponse.json({ error: scopedErr.message }, { status: 500 });

    const mine = (scoped ?? []).filter((r) => {
      const q = (r as unknown as { query: { entity_type: string; entity_id: string } | null }).query;
      return q?.entity_type === entityType && q?.entity_id === entityId;
    });

    const balance = await reportableBalance(
      admin,
      entityType as Parameters<typeof reportableBalance>[1],
      entityId,
    );
    return NextResponse.json({ items: mine, balance });
  }

  /**
   * `status=recent` — still-pending reports plus anything settled in the last
   * fortnight.
   *
   * Filtering to 'reported' alone made a rejected report vanish the moment it
   * was answered: the AR row went back to looking untouched, and the person
   * who raised it had nowhere to see that accounts had looked and found
   * nothing. The outcome is the most useful part of the exchange, so the row
   * keeps it for a while rather than dropping it the instant it lands.
   */
  let query = admin.from("query_payment_reports").select(REPORT_SELECT);
  if (status === "recent") {
    const since = new Date(Date.now() - SETTLED_WINDOW_DAYS * 86_400_000).toISOString();
    query = query.or(`status.eq.reported,reviewed_at.gte.${since}`);
  } else {
    query = query.eq("status", status);
  }

  const { data, error } = await query.order("paid_on", { ascending: false }).limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as Array<{
    query: { entity_type: string; entity_id: string } | null;
  }>;

  const summaries = await loadEntitySummaries(
    admin,
    rows
      .map((r) => r.query)
      .filter((q): q is { entity_type: string; entity_id: string } => !!q)
      .map((q) => ({ entity_type: q.entity_type, entity_id: q.entity_id })),
  );

  const items = rows.map((r) => ({
    ...r,
    entity: r.query ? summaries.get(entityKey(r.query.entity_type, r.query.entity_id)) ?? null : null,
  }));

  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const auth = await requireAnyUser(supabase);
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;

  let body: Record<string, unknown>;
  let files: File[] = [];
  try {
    const parsed = await parseQueryRequest<Record<string, unknown>>(req);
    body = parsed.meta ?? {};
    files = parsed.files;
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const entityType = String(body.entity_type ?? "").trim();
  const entityId = String(body.entity_id ?? "").trim();
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const claimedStatementId =
    typeof body.claimed_statement_id === "string" && body.claimed_statement_id.trim()
      ? body.claimed_statement_id.trim()
      : null;

  if (!(PAYMENT_REPORT_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    return NextResponse.json(
      { error: "A payment can only be reported against a contract or a statement" },
      { status: 400 },
    );
  }
  if (!entityId) return NextResponse.json({ error: "entity_id is required" }, { status: 400 });

  const def = queryEntityDef(entityType as PaymentReportEntityType);
  if (!def) return NextResponse.json({ error: "Unknown entity type" }, { status: 400 });

  const validated = validatePaymentReport(body, new Date());
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });
  const fields = validated.value;

  const admin = createAdminClient();

  const { data: entityRow, error: entityErr } = await admin
    .from(def.table)
    .select(def.select)
    .eq("id", entityId)
    .maybeSingle();
  if (entityErr) return NextResponse.json({ error: entityErr.message }, { status: 500 });
  if (!entityRow) return NextResponse.json({ error: `${def.label} not found` }, { status: 404 });

  const targetKind = targetKindForEntity(entityType as PaymentReportEntityType);

  if (targetKind === "deposit" && claimedStatementId) {
    return NextResponse.json(
      { error: "A security deposit isn't settled against an invoice" },
      { status: 400 },
    );
  }

  // Validate the claimed invoice belongs to what the report hangs off, so a
  // mistyped id can't quietly point accounts at another customer's invoice.
  let claimedStatementNumber: string | null = null;
  if (claimedStatementId) {
    const { data: stmt } = await admin
      .from("billing_statements")
      .select("id, statement_number, contract_id")
      .eq("id", claimedStatementId)
      .maybeSingle();
    if (!stmt) {
      return NextResponse.json({ error: "That invoice doesn't exist" }, { status: 400 });
    }
    const belongs =
      entityType === "billing_statement" ? stmt.id === entityId : stmt.contract_id === entityId;
    if (!belongs) {
      return NextResponse.json(
        { error: "That invoice belongs to a different contract" },
        { status: 400 },
      );
    }
    claimedStatementNumber = (stmt.statement_number as string | null) ?? null;
  }

  // Refuse to let the same money be reported twice. The dialog hides the
  // form once nothing is left to claim, but a stale tab or a direct call
  // would otherwise still create a duplicate thread — and duplicates mean
  // two chases and two chances for accounts to record one payment twice.
  const balance = await reportableBalance(admin, entityType as PaymentReportEntityType, entityId)
    .catch(() => null);
  // When nothing is left to report, refuse outright. The tolerance exists to
  // absorb rounding on a partial claim, not to wave through a token amount on
  // a transaction that is already fully claimed — ₹1 past zero is still a
  // duplicate thread and a second chance to record the same money.
  const overReported =
    !!balance &&
    (balance.reportable <= 0 || fields.amount > balance.reportable + REPORT_TOLERANCE);
  if (overReported && balance) {
    return NextResponse.json(
      {
        error:
          balance.reportable <= 0
            ? `The full outstanding amount here is already reported and waiting for accounts to verify it. Open the existing report instead of raising another.`
            : `Only ₹${balance.reportable.toLocaleString("en-IN")} is left to report — ₹${balance.pending.toLocaleString("en-IN")} is already claimed and awaiting verification.`,
        reportable: balance.reportable,
        pending: balance.pending,
      },
      { status: 409 },
    );
  }

  const modeLabel = STATEMENT_PAYMENT_MODE_LABELS[fields.payment_mode] ?? fields.payment_mode;
  // describeReport() keeps the ISO date for the audit trail, where an
  // unambiguous machine-readable date is the point. The prose that people
  // read gets a formatted one.
  const summaryLine = describeReport(fields, modeLabel).replace(fields.paid_on, formatDate(fields.paid_on));

  // The thread's opening message reads as prose so the timeline is legible on
  // its own; the structured row below is what accounts actually filter and
  // reconcile on. Both, not either — a card with no words reads as a form
  // submission rather than someone telling you something.
  const messageBody = [
    targetKind === "deposit"
      ? `Customer reports paying the security deposit — ${summaryLine}.`
      : `Customer reports paying ${summaryLine}.`,
    claimedStatementNumber ? `Against invoice ${claimedStatementNumber}.` : null,
    fields.payer_differs && fields.payer_name
      ? `Paid from a different account: ${fields.payer_name}.`
      : null,
    note || null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const targeting = {
    audience: "roles" as const,
    audience_roles: [...PAYMENT_REPORT_AUDIENCE_ROLES],
    audience_user_ids: [] as string[],
  };

  const { data: created, error: insertErr } = await admin
    .from("queries")
    .insert({
      entity_type: def.type,
      entity_id: entityId,
      kind: "payment_reported",
      created_by: dbUser.id,
      needed_by: defaultNeededBy(new Date()),
      audience: targeting.audience,
      audience_roles: targeting.audience_roles,
      audience_user_ids: targeting.audience_user_ids,
    })
    .select("id")
    .single();
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  const { data: openingMessage, error: msgErr } = await admin
    .from("query_messages")
    .insert({
      query_id: created.id,
      event_type: "message",
      body: messageBody,
      created_by: dbUser.id,
    })
    .select("id")
    .single();
  if (msgErr) return NextResponse.json({ error: msgErr.message }, { status: 500 });

  const { data: report, error: reportErr } = await admin
    .from("query_payment_reports")
    .insert({
      query_id: created.id,
      amount: fields.amount,
      paid_on: fields.paid_on,
      payment_mode: fields.payment_mode,
      payment_reference: fields.payment_reference,
      payer_name: fields.payer_name,
      payer_differs: fields.payer_differs,
      claimed_statement_id: claimedStatementId,
      target_kind: targetKind,
      created_by: dbUser.id,
    })
    .select("id")
    .single();
  if (reportErr) {
    // A thread with no structured row is the unreconcilable prose this
    // feature exists to replace, so don't leave one behind.
    await admin.from("queries").delete().eq("id", created.id);
    return NextResponse.json({ error: reportErr.message }, { status: 500 });
  }

  const attachments = files.length
    ? await storeAttachments(admin, {
        queryId: created.id,
        messageId: openingMessage.id,
        files,
        uploadedBy: dbUser.id,
      })
    : { stored: 0, failed: [] as string[] };

  const entitySummary = def.toSummary(entityRow as unknown as EntityRow);

  await fanOutQueryEvent(admin, {
    queryId: created.id,
    def,
    targeting,
    entitySummary,
    entityId,
    author: dbUser,
    participantIds: [dbUser.id],
    headline:
      targetKind === "deposit"
        ? "Deposit payment reported — needs verification"
        : "Payment reported — needs verification",
    message: messageBody,
    notificationType: "payment_reported",
  });

  // Logged against the entity rather than left to the thread alone: a claimed
  // payment is something someone reading the contract's history months later
  // needs to see, whether or not it was ever verified.
  void logAudit(admin, {
    entityType: def.auditEntityType,
    entityId: def.auditEntityId(entityRow as unknown as EntityRow) ?? entityId,
    action: "payment_reported",
    performedBy: dbUser.id,
    changes: {
      query_id: { old: null, new: created.id },
      payment_report_id: { old: null, new: report.id },
      reported_payment: { old: null, new: summaryLine },
      context: { old: null, new: entityLabel(def, entitySummary) },
    },
  });

  return NextResponse.json(
    { id: report.id, query_id: created.id, attachments_failed: attachments.failed },
    { status: 201 },
  );
}

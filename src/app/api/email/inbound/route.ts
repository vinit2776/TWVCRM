import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getNewMessages, getGmailMessage } from "@/lib/gmail";
import { verifyPubSubPush } from "@/lib/gmail-push-auth";
import { parseAggregatorEmail, isHighConfidence } from "@/lib/email-parser";
import { DOCUMENT_CHECKLISTS, COMPLIANCE_CHECKLISTS } from "@/lib/constants";

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>;

/**
 * Gmail Pub/Sub webhook endpoint.
 * Called by Google Cloud Pub/Sub when new emails arrive.
 *
 * Flow:
 * 1. Verify the push really came from our Pub/Sub subscription
 * 2. Decode Pub/Sub notification to get historyId
 * 3. Fetch new messages since last historyId
 * 4. For each new message: parse with AI → record intake → create case
 * 5. Update stored historyId
 *
 * Auto-creation is gated on the app_settings flag
 * `gmail_auto_case_creation_enabled`, which is false until shadow-mode output
 * has been reviewed. While it is off every message is still fetched, parsed and
 * recorded in gmail_intake_log — nothing is written to cases. This pipeline has
 * never run against production, so its first exposure to real mail must not be
 * able to create rows in a live Cases module.
 */
export async function POST(request: NextRequest) {
  // Reject anything that is not our Pub/Sub subscription. `historyId` below is
  // caller-supplied and becomes the checkpoint, so an unauthenticated caller
  // could skip every future email permanently.
  const pushAuth = await verifyPubSubPush(request.headers.get("authorization"));
  if (!pushAuth.ok) {
    console.warn(`Rejected Gmail push: ${pushAuth.reason}`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    // Decode Pub/Sub message
    const pubsubMessage = body.message;
    if (!pubsubMessage?.data) {
      return NextResponse.json({ error: "Invalid Pub/Sub message" }, { status: 400 });
    }

    const decoded = JSON.parse(
      Buffer.from(pubsubMessage.data, "base64").toString("utf-8")
    );

    const emailAddress = decoded.emailAddress;
    const newHistoryId = decoded.historyId;

    // Verify this is for our watched email
    const watchEmail = process.env.GMAIL_WATCH_EMAIL || "cases@theworkvilla.com";
    if (emailAddress && emailAddress !== watchEmail) {
      return NextResponse.json({ message: "Not our watched email" });
    }

    // Use admin client since this is a webhook (no auth session)
    const supabase = await createAdminClient();

    const dryRun = !(await autoCreationEnabled(supabase));

    // Get the stored historyId
    const { data: setting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "gmail_history_id")
      .single();

    // First notification ever: there is no checkpoint to read forward from, and
    // Gmail's history API cannot look further back than the id we were handed.
    // Record it and start from the next message rather than silently treating
    // "everything before now" as processed.
    if (!setting?.value) {
      await upsertHistoryId(supabase, newHistoryId);
      return NextResponse.json({
        message: "Checkpoint initialised; processing starts from the next message",
      });
    }

    const lastHistoryId = setting.value;

    // Fetch new messages since last checkpoint
    let messageIds: string[] = [];
    try {
      messageIds = await getNewMessages(lastHistoryId);
    } catch (error) {
      // Do NOT advance the checkpoint here. This previously moved it forward on
      // failure "to prevent re-processing", which meant one transient Gmail
      // error dropped that batch of emails permanently. Returning non-2xx lets
      // Pub/Sub retry with backoff; configure a dead-letter topic on the
      // subscription to bound it.
      console.error("Failed to fetch new messages:", error);
      return NextResponse.json(
        { error: "History sync failed; checkpoint held for retry" },
        { status: 503 }
      );
    }

    // Process each new message
    const results: { messageId: string; action: string; caseId?: string }[] = [];

    for (const messageId of messageIds) {
      try {
        // Pub/Sub is at-least-once and we now return non-2xx on failure, so the
        // same message will legitimately arrive more than once.
        const { data: seen } = await supabase
          .from("gmail_intake_log")
          .select("id")
          .eq("gmail_message_id", messageId)
          .maybeSingle();

        if (seen) {
          results.push({ messageId, action: "skipped_already_processed" });
          continue;
        }

        const outcome = await processMessage(supabase, messageId, dryRun);
        results.push({ messageId, ...outcome });
      } catch (msgError) {
        console.error(`Failed to process message ${messageId}:`, msgError);
        await recordIntake(supabase, {
          gmail_message_id: messageId,
          action: "parse_failed",
          dry_run: dryRun,
          error: msgError instanceof Error ? msgError.message : "unknown error",
        });
        results.push({ messageId, action: "processing_error" });
      }
    }

    // Update the stored historyId
    await upsertHistoryId(supabase, newHistoryId);

    return NextResponse.json({
      dryRun,
      processed: messageIds.length,
      results,
    });
  } catch (error) {
    console.error("Email inbound webhook error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * Fetch, match and parse one message. Always records the outcome in
 * gmail_intake_log; only writes to cases when auto-creation is enabled.
 */
async function processMessage(
  supabase: AdminClient,
  messageId: string,
  dryRun: boolean
): Promise<{ action: string; caseId?: string }> {
  const gmailMsg = await getGmailMessage(messageId);

  // Skip non-relevant emails (outbound, spam, etc.)
  if (!gmailMsg.from || !gmailMsg.subject) {
    await recordIntake(supabase, {
      gmail_message_id: messageId,
      gmail_thread_id: gmailMsg.threadId,
      action: "skipped_incomplete",
      dry_run: dryRun,
    });
    return { action: "skipped_incomplete" };
  }

  // Try to match sender to an aggregator
  const senderEmail = extractEmail(gmailMsg.from);
  const senderDomain = senderEmail.split("@")[1];

  const { data: matchedAggregator } = await supabase
    .from("aggregators")
    .select("id, name, code, billing_method")
    .eq("email_domain", senderDomain)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (!matchedAggregator) {
    await recordIntake(supabase, {
      gmail_message_id: gmailMsg.id,
      gmail_thread_id: gmailMsg.threadId,
      from_email: senderEmail,
      subject: gmailMsg.subject,
      action: "skipped_no_aggregator",
      dry_run: dryRun,
    });
    return { action: "skipped_no_aggregator" };
  }

  // Check if this thread already has a case
  const { data: existingCaseEmail } = await supabase
    .from("case_emails")
    .select("case_id")
    .eq("gmail_thread_id", gmailMsg.threadId)
    .limit(1)
    .maybeSingle();

  if (existingCaseEmail) {
    if (!dryRun) {
      await supabase.from("case_emails").insert({
        case_id: existingCaseEmail.case_id,
        direction: "inbound",
        gmail_message_id: gmailMsg.id,
        gmail_thread_id: gmailMsg.threadId,
        from_email: senderEmail,
        to_emails: gmailMsg.to,
        cc_emails: gmailMsg.cc,
        subject: gmailMsg.subject,
        body_preview: gmailMsg.body.substring(0, 500),
        has_attachments: gmailMsg.hasAttachments,
        processed_at: new Date().toISOString(),
      });
    }

    await recordIntake(supabase, {
      gmail_message_id: gmailMsg.id,
      gmail_thread_id: gmailMsg.threadId,
      from_email: senderEmail,
      subject: gmailMsg.subject,
      matched_aggregator_id: matchedAggregator.id,
      action: dryRun ? "would_append_to_thread" : "appended_to_thread",
      dry_run: dryRun,
    });

    return {
      action: dryRun ? "would_append_to_thread" : "updated_existing_case",
      caseId: existingCaseEmail.case_id,
    };
  }

  // Parse the email with AI
  const parsed = await parseAggregatorEmail(gmailMsg.body, gmailMsg.subject);

  if (dryRun) {
    // Shadow mode: record exactly what would have been created so parse quality
    // can be judged against real mail, and stop.
    await recordIntake(supabase, {
      gmail_message_id: gmailMsg.id,
      gmail_thread_id: gmailMsg.threadId,
      from_email: senderEmail,
      subject: gmailMsg.subject,
      matched_aggregator_id: matchedAggregator.id,
      parsed: parsed.raw_extraction ?? parsed,
      ai_confidence: parsed.confidence,
      needs_manual_review: !isHighConfidence(parsed),
      action: "would_create_case",
      dry_run: true,
    });
    return { action: "would_create_case" };
  }

  const caseId = await createCaseFromEmail(
    supabase,
    gmailMsg,
    senderEmail,
    matchedAggregator,
    parsed
  );

  await recordIntake(supabase, {
    gmail_message_id: gmailMsg.id,
    gmail_thread_id: gmailMsg.threadId,
    from_email: senderEmail,
    subject: gmailMsg.subject,
    matched_aggregator_id: matchedAggregator.id,
    parsed: parsed.raw_extraction ?? parsed,
    ai_confidence: parsed.confidence,
    needs_manual_review: !isHighConfidence(parsed),
    action: caseId ? "created_case" : "parse_failed",
    dry_run: false,
    error: caseId ? undefined : "case insert failed",
  });

  return {
    action: !caseId
      ? "failed_case_creation"
      : isHighConfidence(parsed)
        ? "created_case_auto"
        : "created_case_needs_review",
    caseId: caseId ?? undefined,
  };
}

/**
 * Creates the case plus its document checklist, compliance checks and the
 * case_emails row. Unchanged from the original handler — only reachable once
 * auto-creation is enabled.
 */
async function createCaseFromEmail(
  supabase: AdminClient,
  gmailMsg: Awaited<ReturnType<typeof getGmailMessage>>,
  senderEmail: string,
  matchedAggregator: { id: string; billing_method: string | null },
  parsed: Awaited<ReturnType<typeof parseAggregatorEmail>>
): Promise<string | null> {
  const caseData: Record<string, unknown> = {
    aggregator_id: matchedAggregator.id,
    status: "intake_received",
    purpose: parsed.purpose,
    client_name: parsed.client_name,
    client_entity_type: parsed.client_entity_type,
    client_company_name: parsed.client_company_name,
    client_gst_number: parsed.client_gst_number,
    client_pan_number: parsed.client_pan_number,
    client_cin_number: parsed.client_cin_number,
    client_email: parsed.client_email,
    client_phone: parsed.client_phone,
    client_address: parsed.client_address,
    client_city: parsed.client_city,
    client_state: parsed.client_state,
    client_pincode: parsed.client_pincode,
    rate: parsed.rate,
    tenure_months: parsed.tenure_months || 12,
    start_date: parsed.start_date,
    notes: parsed.notes,
    source_email_id: gmailMsg.id,
    email_thread_id: gmailMsg.threadId,
    metadata: {
      ai_parsed: true,
      ai_confidence: parsed.confidence,
      ai_missing_fields: parsed.missing_fields,
      needs_manual_review: !isHighConfidence(parsed),
    },
  };

  const { data: newCase, error: caseError } = await supabase
    .from("cases")
    .insert(caseData)
    .select("id, case_number")
    .single();

  if (caseError || !newCase) {
    console.error("Failed to create case:", caseError?.message);
    return null;
  }

  // Auto-generate document checklist
  const docChecklist =
    DOCUMENT_CHECKLISTS[parsed.purpose]?.[parsed.client_entity_type] || [];
  const docRows = docChecklist.map((doc) => ({
    case_id: newCase.id,
    document_type: doc.type,
    label: doc.label,
    is_required: doc.required,
    status: "pending" as const,
  }));

  // Prepaid aggregators require an approved Payment Proof before the
  // Leave & License Agreement can be executed (see agreement/route.ts).
  if (matchedAggregator.billing_method === "prepaid") {
    docRows.push({
      case_id: newCase.id,
      document_type: "payment_proof",
      label: "Payment Proof",
      is_required: true,
      status: "pending" as const,
    });
  }

  if (docRows.length > 0) {
    await supabase.from("case_documents").insert(docRows);
  }

  // Auto-generate compliance checks
  const compChecklist = COMPLIANCE_CHECKLISTS[parsed.purpose] || [];
  if (compChecklist.length > 0) {
    const compRows = compChecklist.map((check) => ({
      case_id: newCase.id,
      check_name: check.check_name,
      check_category: check.check_category,
      sort_order: check.sort_order,
      status: "pending" as const,
    }));
    await supabase.from("case_compliance_checks").insert(compRows);
  }

  // Log the inbound email
  await supabase.from("case_emails").insert({
    case_id: newCase.id,
    direction: "inbound",
    gmail_message_id: gmailMsg.id,
    gmail_thread_id: gmailMsg.threadId,
    from_email: senderEmail,
    to_emails: gmailMsg.to,
    cc_emails: gmailMsg.cc,
    subject: gmailMsg.subject,
    body_preview: gmailMsg.body.substring(0, 500),
    has_attachments: gmailMsg.hasAttachments,
    parsed_data: parsed.raw_extraction,
    processed_at: new Date().toISOString(),
  });

  return newCase.id;
}

/** Reads the auto-creation flag. Anything other than an explicit "true" is off. */
async function autoCreationEnabled(supabase: AdminClient): Promise<boolean> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "gmail_auto_case_creation_enabled")
    .maybeSingle();

  return data?.value === "true";
}

/**
 * Records what the pipeline did with a message. Never throws — an intake-log
 * failure must not abort processing or the checkpoint update.
 */
async function recordIntake(
  supabase: AdminClient,
  row: {
    gmail_message_id: string;
    gmail_thread_id?: string | null;
    from_email?: string | null;
    subject?: string | null;
    matched_aggregator_id?: string | null;
    parsed?: unknown;
    ai_confidence?: number | null;
    needs_manual_review?: boolean | null;
    action: string;
    dry_run: boolean;
    error?: string;
  }
) {
  const { error } = await supabase
    .from("gmail_intake_log")
    .upsert(row, { onConflict: "gmail_message_id", ignoreDuplicates: true });

  if (error) console.error("Failed to record gmail intake:", error.message);
}

// Helper to extract email from "Name <email>" format
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

// Helper to upsert historyId in app_settings
async function upsertHistoryId(supabase: AdminClient, historyId: string) {
  const { data: existing } = await supabase
    .from("app_settings")
    .select("id")
    .eq("key", "gmail_history_id")
    .maybeSingle();

  if (existing) {
    await supabase
      .from("app_settings")
      .update({ value: historyId })
      .eq("key", "gmail_history_id");
  } else {
    await supabase.from("app_settings").insert({
      key: "gmail_history_id",
      value: historyId,
    });
  }
}

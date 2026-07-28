import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getNewMessages, getGmailMessage } from "@/lib/gmail";
import { parseAggregatorEmail, isHighConfidence } from "@/lib/email-parser";
import { DOCUMENT_CHECKLISTS, COMPLIANCE_CHECKLISTS } from "@/lib/constants";

/**
 * Gmail Pub/Sub webhook endpoint.
 * Called by Google Cloud Pub/Sub when new emails arrive.
 *
 * Flow:
 * 1. Decode Pub/Sub notification to get historyId
 * 2. Fetch new messages since last historyId
 * 3. For each new message: parse with AI → create/update case
 * 4. Update stored historyId
 */
export async function POST(request: NextRequest) {
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

    // Get the stored historyId
    const { data: setting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "gmail_history_id")
      .single();

    const lastHistoryId = setting?.value || newHistoryId;

    // Fetch new messages since last checkpoint
    let messageIds: string[] = [];
    try {
      messageIds = await getNewMessages(lastHistoryId);
    } catch (error) {
      console.error("Failed to fetch new messages:", error);
      // Update historyId anyway to prevent re-processing
      await upsertHistoryId(supabase, newHistoryId);
      return NextResponse.json({ message: "History sync failed, checkpoint updated" });
    }

    // Process each new message
    const results: { messageId: string; action: string; caseId?: string }[] = [];

    for (const messageId of messageIds) {
      try {
        const gmailMsg = await getGmailMessage(messageId);

        // Skip non-relevant emails (outbound, spam, etc.)
        if (!gmailMsg.from || !gmailMsg.subject) continue;

        // Try to match sender to an aggregator
        const senderEmail = extractEmail(gmailMsg.from);
        const senderDomain = senderEmail.split("@")[1];

        const { data: matchedAggregator } = await supabase
          .from("aggregators")
          .select("id, name, code, billing_method")
          .eq("email_domain", senderDomain)
          .eq("status", "active")
          .limit(1)
          .single();

        if (!matchedAggregator) {
          // Log as unmatched email
          results.push({ messageId, action: "skipped_no_aggregator" });
          continue;
        }

        // Check if this thread already has a case
        const { data: existingCaseEmail } = await supabase
          .from("case_emails")
          .select("case_id")
          .eq("gmail_thread_id", gmailMsg.threadId)
          .limit(1)
          .single();

        if (existingCaseEmail) {
          // Thread already linked to a case — log the email and update case
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

          results.push({
            messageId,
            action: "updated_existing_case",
            caseId: existingCaseEmail.case_id,
          });
          continue;
        }

        // Parse the email with AI
        const parsed = await parseAggregatorEmail(gmailMsg.body, gmailMsg.subject);

        // Create a new case
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

        if (caseError) {
          console.error("Failed to create case:", caseError.message);
          results.push({ messageId, action: "failed_case_creation" });
          continue;
        }

        // Auto-generate document checklist
        const docChecklist =
          DOCUMENT_CHECKLISTS[parsed.purpose]?.[parsed.client_entity_type] || [];
        if (newCase) {
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
        }

        // Auto-generate compliance checks
        const compChecklist = COMPLIANCE_CHECKLISTS[parsed.purpose] || [];
        if (compChecklist.length > 0 && newCase) {
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
        if (newCase) {
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
        }

        results.push({
          messageId,
          action: isHighConfidence(parsed)
            ? "created_case_auto"
            : "created_case_needs_review",
          caseId: newCase?.id,
        });
      } catch (msgError) {
        console.error(`Failed to process message ${messageId}:`, msgError);
        results.push({ messageId, action: "processing_error" });
      }
    }

    // Update the stored historyId
    await upsertHistoryId(supabase, newHistoryId);

    return NextResponse.json({
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

// Helper to extract email from "Name <email>" format
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

// Helper to upsert historyId in app_settings
async function upsertHistoryId(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  historyId: string
) {
  const { data: existing } = await supabase
    .from("app_settings")
    .select("id")
    .eq("key", "gmail_history_id")
    .single();

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

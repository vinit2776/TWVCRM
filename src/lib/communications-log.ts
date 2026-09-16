import { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import type { CommunicationEntityType, CommunicationChannel, CommunicationStatus, CommunicationLogEntry } from "@/types";

/**
 * Log an outbound email/WhatsApp/SMS send with its full content and
 * attachment reference. Unlike logAudit()/logEmailActivity(), this is
 * awaited and returns the inserted row — callers need the row back to show
 * the post-send confirmation dialog without a second fetch.
 *
 * Never throws: a logging failure must not fail the underlying send. On
 * error this logs to console and returns null.
 */
export async function logCommunication(
  supabase: SupabaseClient,
  params: {
    entityType: CommunicationEntityType;
    entityId: string;
    channel: CommunicationChannel;
    recipient: string;
    cc?: string[] | null;
    body: string;
    subject?: string | null;
    attachmentUrl?: string | null;
    attachmentName?: string | null;
    status?: CommunicationStatus;
    errorMessage?: string | null;
    sentBy?: string | null;
  }
): Promise<CommunicationLogEntry | null> {
  const {
    entityType, entityId, channel, recipient, cc = null, body,
    subject = null, attachmentUrl = null, attachmentName = null,
    status = "sent", errorMessage = null, sentBy = null,
  } = params;

  const { data, error } = await supabase
    .from("communications_log")
    .insert({
      entity_type: entityType,
      entity_id: entityId,
      channel,
      recipient,
      // Only send the column when there is something to write, so a send still
      // logs on an environment that hasn't applied migration 00562 yet.
      ...(cc && cc.length > 0 ? { cc } : {}),
      subject,
      body,
      attachment_url: attachmentUrl,
      attachment_name: attachmentName,
      status,
      error_message: errorMessage,
      sent_by: sentBy,
    })
    .select()
    .single();

  if (error) {
    console.error("Failed to log communication:", error.message);
    return null;
  }

  return data as CommunicationLogEntry;
}

/**
 * Swap stored crm-documents storage paths for fresh 1-hour signed URLs.
 * attachment_url in the table is a bucket-relative path, not a resolved
 * URL (the bucket is private) — this resolves it just before the client
 * needs to render an "Open attachment" link.
 */
export async function resolveAttachmentUrls<T extends { attachment_url: string | null }>(
  entries: T[],
): Promise<T[]> {
  const withPaths = entries.filter((e) => e.attachment_url);
  if (withPaths.length === 0) return entries;

  const adminSupabase = await createAdminClient();
  const signed = await Promise.all(
    withPaths.map((e) =>
      adminSupabase.storage.from("crm-documents").createSignedUrl(e.attachment_url as string, 3600)
    ),
  );
  const urlByPath = new Map<string, string>();
  withPaths.forEach((e, i) => {
    const url = signed[i].data?.signedUrl;
    if (url) urlByPath.set(e.attachment_url as string, url);
  });

  return entries.map((e) =>
    e.attachment_url && urlByPath.has(e.attachment_url)
      ? { ...e, attachment_url: urlByPath.get(e.attachment_url)! }
      : e,
  );
}

/** Resolve a single entry's attachment URL — convenience wrapper for callers
 *  returning one row (e.g. the send routes' JSON response). */
export async function resolveAttachmentUrl<T extends { attachment_url: string | null }>(
  entry: T,
): Promise<T> {
  const [resolved] = await resolveAttachmentUrls([entry]);
  return resolved;
}

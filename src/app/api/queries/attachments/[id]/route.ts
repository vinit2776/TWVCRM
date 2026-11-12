import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { queryEntityDef } from "@/lib/queries/registry";
import { requireQueryUser } from "@/lib/queries/server";
import { ATTACHMENT_BUCKET } from "@/lib/queries/attachments";

/**
 * GET /api/queries/attachments/[id]
 *
 * Hands back a short-lived signed URL for one attachment, after re-checking
 * that this viewer is authorized on the thread's entity type.
 *
 * The check matters: attachments are stored in a private bucket precisely so
 * that holding a file path isn't the same as being allowed to read it. An
 * attachment id is guessable-adjacent (it travels in API responses), so
 * authorization is re-derived here from attachment → message → query →
 * registry entry, rather than assumed from the fact that someone asked.
 */
export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_SECONDS = 300;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireQueryUser(supabase);
  if ("error" in auth) return auth.error;

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("query_attachments")
    .select("id, file_path, file_name, message:query_messages!query_attachments_message_id_fkey(query:queries!query_messages_query_id_fkey(entity_type))")
    .eq("id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });

  const row = data as unknown as {
    file_path: string;
    file_name: string;
    message: { query: { entity_type: string } | null } | null;
  };

  const entityType = row.message?.query?.entity_type;
  const def = entityType ? queryEntityDef(entityType) : null;
  // An attachment whose thread or entity type can't be resolved is not
  // something to hand out on the benefit of the doubt.
  if (!def) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });

  if (!(def.roles as readonly string[]).includes(auth.dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: signed, error: signErr } = await admin.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(row.file_path, SIGNED_URL_TTL_SECONDS, { download: row.file_name });

  if (signErr || !signed?.signedUrl) {
    return NextResponse.json(
      { error: signErr?.message ?? "Could not open this attachment." },
      { status: 500 },
    );
  }

  return NextResponse.redirect(signed.signedUrl);
}

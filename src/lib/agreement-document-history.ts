import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgreementDocumentVersion } from "@/types";

const STORAGE_BUCKET = "crm-documents";
const MAX_CHAIN_DEPTH = 25;

type DocumentRow = {
  id: string;
  file_name: string;
  file_path: string;
  version: number;
  parent_document_id: string | null;
  reupload_reason: AgreementDocumentVersion["reupload_reason"];
  reupload_notes: string | null;
  is_signed_sealed: boolean | null;
  uploaded_by: string | null;
  created_at: string;
  uploader: { id: string; full_name: string } | { id: string; full_name: string }[] | null;
};

/**
 * Walks the documents.parent_document_id chain backwards from `currentId`,
 * returning every version newest-first with a signed URL to view it.
 *
 * This chain (documents.version + parent_document_id, from
 * 00001_initial_schema) is the same version-history mechanism already used
 * by stamp-existing-document/route.ts — reupload just adds reason/notes/
 * is_signed_sealed metadata on top of it rather than introducing a parallel
 * table.
 */
export async function getAgreementDocumentHistory(
  admin: SupabaseClient,
  currentId: string | null
): Promise<AgreementDocumentVersion[]> {
  const chain: DocumentRow[] = [];
  let cursor = currentId;
  let guard = 0;

  while (cursor && guard < MAX_CHAIN_DEPTH) {
    guard++;
    const { data: doc } = await admin
      .from("documents")
      .select(
        "id, file_name, file_path, version, parent_document_id, reupload_reason, reupload_notes, is_signed_sealed, uploaded_by, created_at, uploader:users!documents_uploaded_by_fkey(id, full_name)"
      )
      .eq("id", cursor)
      .single();

    if (!doc) break;
    chain.push(doc as unknown as DocumentRow);
    cursor = doc.parent_document_id;
  }

  return Promise.all(
    chain.map(async (doc, index) => {
      const { data: signedUrlData } = await admin.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(doc.file_path, 3600);

      const uploader = Array.isArray(doc.uploader) ? doc.uploader[0] ?? null : doc.uploader;

      return {
        id: doc.id,
        file_name: doc.file_name,
        file_path: doc.file_path,
        version: doc.version,
        reupload_reason: doc.reupload_reason,
        reupload_notes: doc.reupload_notes,
        is_signed_sealed: doc.is_signed_sealed,
        uploaded_by: doc.uploaded_by,
        uploader,
        created_at: doc.created_at,
        is_current: index === 0,
        view_url: signedUrlData?.signedUrl ?? null,
      };
    })
  );
}

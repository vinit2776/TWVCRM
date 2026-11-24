import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/addendum/server";
import { loadNocSettings } from "@/lib/noc/server";

/** GET: the acceptance certificate PDF made when the customer accepted (staff only, read-only). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; nid: string }> }) {
  const { id, nid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  const admin = createAdminClient();
  if (!(await loadNocSettings(admin)).enabled) return NextResponse.json({ error: "The NOC service is not switched on." }, { status: 403 });
  const { data: noc } = await admin.from("noc_requests").select("acceptance_document_id, noc_number").eq("id", nid).eq("contract_id", id).maybeSingle();
  if (!noc?.acceptance_document_id) return NextResponse.json({ error: "The customer has not accepted the terms yet." }, { status: 404 });
  const { data: doc } = await admin.from("documents").select("file_path, file_name").eq("id", noc.acceptance_document_id).maybeSingle();
  if (!doc) return NextResponse.json({ error: "Certificate not found" }, { status: 404 });
  const dl = await admin.storage.from("crm-documents").download(doc.file_path);
  if (!dl.data) return NextResponse.json({ error: "Certificate file not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(await dl.data.arrayBuffer()), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${doc.file_name}"`, "Cache-Control": "no-store" },
  });
}

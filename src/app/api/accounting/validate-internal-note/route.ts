import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CHARGE_ALLOWED_ROLES } from "@/lib/constants";
import { checkInternalNote } from "@/lib/validate-internal-note";

// Advisory only from the client's point of view (this endpoint is used for the
// manual "Check wording" button and the pre-submit UX check) — but the same
// checkInternalNote() grading is also enforced server-side in the invoice
// create/update routes, so it can't be bypassed by calling those directly.
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !CHARGE_ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "You do not have permission to use this" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  const accountingHead = typeof body?.accounting_head === "string" ? body.accounting_head.trim() : "";
  const context = typeof body?.context === "string" ? body.context.trim() : "";

  if (!note) {
    return NextResponse.json({ error: "Nothing to check" }, { status: 400 });
  }
  if (note.length > 1000) {
    return NextResponse.json({ error: "Note is too long" }, { status: 400 });
  }

  const result = await checkInternalNote({ note, accountingHead, context });

  if (result.status === "unconfigured") {
    return NextResponse.json({ error: "Note checking isn't configured" }, { status: 503 });
  }
  if (result.status === "error") {
    return NextResponse.json({ error: "Couldn't check the note" }, { status: 502 });
  }

  return NextResponse.json({ ok: result.status === "ok", reason: result.reason });
}

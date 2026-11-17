import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { EXTRACTION_MEDIA_TYPES, extractAmcProposal, type ExtractionMediaType } from "@/lib/procurement/proposal-extraction";

// Read-only: reads an uploaded AMC proposal and returns what it says. Creates or changes no
// request and stores nothing. The wizard shows the result for the user to confirm.
// Same roles that can raise a request (POST /api/procurement/requests).
const ALLOWED_ROLES = ["admin", "manager", "office_admin", "coordinator"];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PER_MINUTE = 4;

// Per-instance throttle on top of the one-call-per-upload client trigger; bounds cost if a client misbehaves.
const recent = new Map<string, number[]>();
function throttled(userId: string): boolean {
  const now = Date.now();
  const hits = (recent.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= MAX_PER_MINUTE) {
    recent.set(userId, hits);
    return true;
  }
  hits.push(now);
  recent.set(userId, hits);
  return false;
}

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "You do not have permission to use this" }, { status: 403 });
  }

  // Missing key (e.g. Preview) is not an error: the wizard quietly offers typing instead.
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ status: "unavailable" });
  if (throttled(user.id)) return NextResponse.json({ status: "unavailable" });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (file.size === 0 || file.size > MAX_BYTES) return NextResponse.json({ error: "File must be under 10 MB" }, { status: 400 });
  if (!(EXTRACTION_MEDIA_TYPES as readonly string[]).includes(file.type)) {
    return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
  }

  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  return NextResponse.json(await extractAmcProposal(base64, file.type as ExtractionMediaType));
}

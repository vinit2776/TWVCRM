import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { InvoiceCheckReason } from "@/lib/procurement/invoice-check-reasons";
import { EXTRACTION_MEDIA_TYPES, extractInvoice, type ExtractionMediaType } from "@/lib/procurement/invoice-extraction";

// Read-only: reads the uploaded invoice and returns what it says. Creates or changes
// no bill, and stores nothing. The form shows the result as advice only.
const ALLOWED_ROLES = ["admin", "manager", "office_admin"];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PER_MINUTE = 6;

// Per-instance throttle on top of the one-call-per-upload client trigger; bounds cost
// if a client misbehaves. Serverless instances don't share it, which is acceptable here.
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

function fail(reason: InvoiceCheckReason, httpStatus: number) {
  console.error("[extract-route]", `reason=${reason}`);
  return NextResponse.json({ status: "unavailable", reason }, { status: httpStatus });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return fail("no_permission", 403);
  }

  // Missing key (e.g. Preview) is not an error: the form says the check isn't set up.
  if (!process.env.ANTHROPIC_API_KEY) return fail("not_configured", 200);

  if (throttled(user.id)) return fail("rate_limited", 429);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (file.size === 0 || file.size > MAX_BYTES) return fail("too_large", 413);
  if (!(EXTRACTION_MEDIA_TYPES as readonly string[]).includes(file.type)) {
    return fail("unsupported_type", 415);
  }

  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  const result = await extractInvoice(base64, file.type as ExtractionMediaType);
  return NextResponse.json(result);
}

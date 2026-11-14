import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { VO_RATE_PURPOSES } from "@/lib/constants";
import { isAllowedVoTerm } from "@/lib/vo-proposal";
import { priceVoQuote } from "@/lib/vo-pricing-server";

const ROLES = ["admin", "manager", "sales_rep"];

const querySchema = z.object({
  purpose: z.enum(VO_RATE_PURPOSES),
  location_id: z.guid("Invalid location ID").nullable(),
  term: z.coerce.number().int().refine(isAllowedVoTerm, { message: "Term must be 11, 12, 24, 36 or 48 months" }),
  quoted: z.coerce.number().positive().nullable(),
});

/**
 * GET /api/proposals/vo-pricing-preview?purpose=&location_id=&term=&quoted=
 * Read-only guide, floor, suggested ask and win trend for a VO proposal that is not saved yet.
 * Same numbers as GET /api/proposals/[id]/vo-pricing, computed by the same helper. Writes nothing.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!me || !ROLES.includes(me.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const sp = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse({
    purpose: sp.get("purpose"),
    location_id: sp.get("location_id") || null,
    term: sp.get("term"),
    quoted: sp.get("quoted") || null,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });

  const priced = await priceVoQuote(createAdminClient(), {
    purpose: parsed.data.purpose,
    locationId: parsed.data.location_id,
    termMonths: parsed.data.term,
    quotedRate: parsed.data.quoted,
  });
  if (!priced.setUp) return NextResponse.json({ data: { setUp: false, pricing: null } });
  return NextResponse.json({ data: { setUp: true, pricing: priced.result } });
}

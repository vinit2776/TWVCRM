import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getCachedSetting } from "@/lib/app-settings-cache";
import { AUTO_RENEW_MANAGE_ROLES } from "@/lib/auto-renewal";
import { NOTICE_MODE_SETTING, NOTICE_KINDS, parseNoticeMode } from "@/lib/auto-renewal-notice";
import { loadNotices, prepareNotice, NOTICES_UNAVAILABLE } from "@/lib/auto-renewal-notice-server";

const VIEW_ROLES = ["admin", "manager", "sales_rep", "floor_manager", "accounts"];

async function actor() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  return dbUser ?? null;
}

/** GET /api/contracts/[id]/auto-renewal/notices: this contract's customer notices, newest last. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await actor();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!VIEW_ROLES.includes(me.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const notices = await loadNotices(admin, [id]);
  if (notices === null) return NextResponse.json({ data: null, unavailable: NOTICES_UNAVAILABLE });
  const mode = parseNoticeMode(await getCachedSetting(admin, NOTICE_MODE_SETTING));
  return NextResponse.json({ data: { mode, notices } });
}

const prepareSchema = z.object({ kind: z.enum(NOTICE_KINDS) });

/**
 * POST /api/contracts/[id]/auto-renewal/notices: write a draft by hand, for when
 * the daily job has not (a late notice, or a contract it holds). Sends nothing.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await actor();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(AUTO_RENEW_MANAGE_ROLES as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "Only admins, managers and sales reps can prepare notices." }, { status: 403 });
  }
  const parsed = prepareSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const admin = createAdminClient();
  const res = await prepareNotice(admin, id, parsed.data.kind, { actorId: me.id, manual: true });
  if (res.result === "unavailable") return NextResponse.json({ error: NOTICES_UNAVAILABLE }, { status: 409 });
  if (res.result === "blocked") return NextResponse.json({ error: res.reason }, { status: 400 });
  if (res.result === "exists") return NextResponse.json({ error: "A notice of this kind already exists for this term." }, { status: 409 });
  return NextResponse.json({ data: res.notice });
}

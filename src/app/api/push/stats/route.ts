import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/push/stats
 * Returns rollup statistics for recent broadcasts:
 *   • subscriber count (devices currently eligible to receive a push)
 *   • last 20 batches with sent / failed / delivered / clicked counts
 *
 * Admin-only — exposes per-batch performance to the broadcast UI.
 */
export async function GET(_req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const admin = createAdminClient();

  const [{ count: subscribers }, { data: rows }] = await Promise.all([
    admin.from("push_subscriptions").select("*", { count: "exact", head: true }),
    admin
      .from("push_delivery_log")
      .select("batch_id, status, payload, created_at")
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);

  // Rollup per batch — last 20 batches by most recent activity.
  const map = new Map<string, {
    batchId: string;
    title: string;
    body: string;
    url?: string;
    createdAt: string;
    total: number;
    sent: number;
    failed: number;
    delivered: number;
    clicked: number;
  }>();

  for (const r of rows || []) {
    const id = r.batch_id as string;
    if (!map.has(id)) {
      const p = (r.payload || {}) as { title?: string; body?: string; url?: string };
      map.set(id, {
        batchId: id,
        title: p.title || "",
        body: p.body || "",
        url: p.url,
        createdAt: r.created_at as string,
        total: 0, sent: 0, failed: 0, delivered: 0, clicked: 0,
      });
    }
    const b = map.get(id)!;
    b.total++;
    // Status is the "highest reached" state — clicked implies delivered etc.
    if (r.status === "sent")      b.sent++;
    if (r.status === "failed")    b.failed++;
    if (r.status === "delivered") { b.sent++; b.delivered++; }
    if (r.status === "clicked")   { b.sent++; b.delivered++; b.clicked++; }
  }

  const batches = Array.from(map.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);

  return NextResponse.json({ subscribers: subscribers ?? 0, batches });
}

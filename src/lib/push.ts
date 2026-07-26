import { randomUUID } from "crypto";
import webPush from "web-push";
import { createAdminClient } from "@/lib/supabase/server";

const VAPID_PUBLIC  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY             || "";
// .trim() — VAPID_SUBJECT was stored in Vercel with a trailing newline, which
// went straight into the JWT `sub` claim. Apple Web Push validates that claim
// strictly and rejected every notification with 403 BadJwtToken, while FCM
// ignored it — so push worked on Android/Chrome and silently failed on
// Safari/iOS. The keys were already trimmed by stripVapidKey(); the subject
// was not.
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || "").trim() || "mailto:space@theworkvilla.com";

let vapidConfigured = false;

function stripVapidKey(key: string): string {
  return key.trim().replace(/=/g, "");
}

function ensureVapid() {
  if (vapidConfigured) return;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn("[push] VAPID keys not set — push notifications disabled. " +
      "Run: npx web-push generate-vapid-keys");
    return;
  }
  // web-push requires URL-safe base64 with NO "=" at all — not even trailing
  const pub = stripVapidKey(VAPID_PUBLIC);
  const priv = stripVapidKey(VAPID_PRIVATE);
  console.log("[push] VAPID configured, pub length:", pub.length, "has =:", pub.includes("="));
  webPush.setVapidDetails(VAPID_SUBJECT, pub, priv);
  vapidConfigured = true;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  // Optional — when present the SW will beacon delivered/clicked events
  // back to /api/push/track so we can measure reach + engagement.
  batchId?: string;
}

export interface BroadcastResult {
  batchId: string;
  total: number;
  sent: number;
  failed: number;
}

/**
 * Broadcast a push to every subscribed user AND log each attempt to
 * push_delivery_log so we can track delivered/clicked rates over time.
 *
 * The SW receives `batchId` and `endpoint` inside the payload and uses them
 * to beacon back to /api/push/track on `push` and `notificationclick`.
 */
export async function broadcastPush(payload: PushPayload): Promise<BroadcastResult> {
  ensureVapid();
  const batchId = (payload.batchId && payload.batchId.length > 0)
    ? payload.batchId
    : randomUUID();

  if (!vapidConfigured) return { batchId, total: 0, sent: 0, failed: 0 };

  const supabase = createAdminClient();
  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("user_id, endpoint, p256dh, auth");

  if (!subs?.length) return { batchId, total: 0, sent: 0, failed: 0 };

  // Pre-insert one log row per subscription as 'queued' so failures still
  // leave a trace. We use upsert on (batch_id, endpoint) for idempotency in
  // case the broadcast is ever re-run.
  const queuedRows = subs.map((sub) => ({
    batch_id: batchId,
    user_id: sub.user_id,
    endpoint: sub.endpoint,
    payload: { ...payload, batchId },
    status: "queued",
  }));
  await supabase.from("push_delivery_log").insert(queuedRows);

  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (sub) => {
      const enriched = JSON.stringify({ ...payload, batchId, endpoint: sub.endpoint });
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          enriched
        );
        sent++;
        await supabase
          .from("push_delivery_log")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("batch_id", batchId)
          .eq("endpoint", sub.endpoint);
      } catch (err: unknown) {
        failed++;
        const e = err as { statusCode?: number; body?: string; message?: string };
        await supabase
          .from("push_delivery_log")
          .update({
            status: "failed",
            error_code: e.statusCode || null,
            error_message: e.body || e.message || "unknown",
          })
          .eq("batch_id", batchId)
          .eq("endpoint", sub.endpoint);

        // 404 / 410 = subscription is permanently gone — clean it up so the
        // next broadcast doesn't waste an attempt and the user can re-subscribe.
        if (e.statusCode === 404 || e.statusCode === 410) {
          await supabase
            .from("push_subscriptions")
            .delete()
            .eq("endpoint", sub.endpoint);
        }
      }
    })
  );

  return { batchId, total: subs.length, sent, failed };
}

/**
 * Sends a Web Push notification to ALL subscribed users.
 * Fire-and-forget — invalid / expired subscriptions are silently skipped.
 */
export async function sendPushToAll(payload: PushPayload): Promise<void> {
  ensureVapid();
  if (!vapidConfigured) return;

  const supabase = await createAdminClient();
  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth");

  if (!subs?.length) return;

  const payloadStr = JSON.stringify(payload);

  await Promise.allSettled(
    subs.map((sub) =>
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payloadStr
      )
    )
  );
}

/**
 * Like sendPushToUsers, but logs each attempt to push_delivery_log under the
 * given batchId so delivered/clicked status can be read back later (the SW
 * beacons those events to /api/push/track using the batchId+endpoint baked
 * into the payload — see broadcastPush for the same mechanism at scale).
 */
export async function sendTrackedPushToUsers(
  userIds: string[],
  payload: PushPayload,
  batchId: string
): Promise<{ sent: number; failed: number }> {
  ensureVapid();
  if (!vapidConfigured || !userIds.length) return { sent: 0, failed: 0 };

  const supabase = createAdminClient();
  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("user_id, endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (!subs?.length) return { sent: 0, failed: 0 };

  const queuedRows = subs.map((sub) => ({
    batch_id: batchId,
    user_id: sub.user_id,
    endpoint: sub.endpoint,
    payload: { ...payload, batchId },
    status: "queued",
  }));
  await supabase.from("push_delivery_log").insert(queuedRows);

  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (sub) => {
      const enriched = JSON.stringify({ ...payload, batchId, endpoint: sub.endpoint });
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          enriched
        );
        sent++;
        await supabase
          .from("push_delivery_log")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("batch_id", batchId)
          .eq("endpoint", sub.endpoint);
      } catch (err: unknown) {
        failed++;
        const e = err as { statusCode?: number; body?: string; message?: string };
        await supabase
          .from("push_delivery_log")
          .update({
            status: "failed",
            error_code: e.statusCode || null,
            error_message: e.body || e.message || "unknown",
          })
          .eq("batch_id", batchId)
          .eq("endpoint", sub.endpoint);

        if (e.statusCode === 404 || e.statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        }
      }
    })
  );

  return { sent, failed };
}

/**
 * Roles that have access to the Procurement module (mirrors sidebar role arrays).
 * Used to scope procurement push notifications to relevant staff only.
 */
export const PROCUREMENT_ROLES = [
  "admin",
  "manager",
  "office_admin",
  "accounts",
  "viewer",
] as const;

/**
 * Sends a Web Push notification only to users whose role grants them
 * access to the Procurement module. Prevents IT, facility, and sales
 * staff from receiving procurement noise.
 */
export async function sendPushToProcurementRoles(payload: PushPayload): Promise<void> {
  ensureVapid();
  if (!vapidConfigured) return;

  const supabase = createAdminClient();

  // Fetch user IDs for procurement-eligible roles
  const { data: users } = await supabase
    .from("users")
    .select("id")
    .in("role", PROCUREMENT_ROLES as unknown as string[])
    .eq("is_active", true);

  if (!users?.length) return;

  const userIds = users.map((u) => u.id);

  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (!subs?.length) return;

  const payloadStr = JSON.stringify(payload);
  await Promise.allSettled(
    subs.map((sub) =>
      webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payloadStr
      )
    )
  );
}

/**
 * Sends a Web Push notification to a specific set of users (matched by
 * push_subscriptions.user_id). One user can have multiple subscriptions
 * across browsers/devices — we deliver to all of them.
 *
 * Returns the number of subscriptions actually delivered. Empty input or a
 * VAPID-misconfigured environment is a no-op (returns 0) so callers can
 * treat this as fire-and-forget.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload
): Promise<number> {
  ensureVapid();
  if (!vapidConfigured || !userIds.length) return 0;

  const supabase = await createAdminClient();
  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (!subs?.length) return 0;

  const payloadStr = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map((sub) =>
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payloadStr
      )
    )
  );
  return results.filter((r) => r.status === "fulfilled").length;
}

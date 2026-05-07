import webPush from "web-push";
import { createAdminClient } from "@/lib/supabase/server";

const VAPID_PUBLIC  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY             || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT                 || "mailto:space@theworkvilla.com";

let vapidConfigured = false;

function ensureVapid() {
  if (vapidConfigured) return;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn("[push] VAPID keys not set — push notifications disabled. " +
      "Run: npx web-push generate-vapid-keys");
    return;
  }
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  vapidConfigured = true;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
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

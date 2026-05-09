import { createAdminClient } from "@/lib/supabase/server";

export interface CreateNotificationParams {
  userId: string;
  type: string;
  title: string;
  body: string;
  url?: string;
  entityType?: string;
  entityId?: string;
}

/**
 * Insert one in-app notification row for a user.
 * Uses admin client so it bypasses RLS.
 */
export async function createNotification(params: CreateNotificationParams): Promise<void> {
  const supabase = await createAdminClient();
  const { error } = await supabase.from("notifications").insert({
    user_id: params.userId,
    type: params.type,
    title: params.title,
    body: params.body,
    url: params.url ?? null,
    entity_type: params.entityType ?? null,
    entity_id: params.entityId ?? null,
  });
  if (error) {
    console.error("[in-app-notify] insert failed:", error.message);
  }
}

/**
 * Insert in-app notifications for multiple users at once.
 */
export async function createNotificationsForUsers(
  userIds: string[],
  params: Omit<CreateNotificationParams, "userId">
): Promise<void> {
  if (userIds.length === 0) return;

  const supabase = await createAdminClient();
  const rows = userIds.map((uid) => ({
    user_id: uid,
    type: params.type,
    title: params.title,
    body: params.body,
    url: params.url ?? null,
    entity_type: params.entityType ?? null,
    entity_id: params.entityId ?? null,
  }));

  const { error } = await supabase.from("notifications").insert(rows);
  if (error) {
    console.error("[in-app-notify] bulk insert failed:", error.message);
  }
}

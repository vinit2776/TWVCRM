import { AsyncLocalStorage } from "node:async_hooks";
import type { User } from "@supabase/supabase-js";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import type { UserRole } from "@/types";

export interface DashboardAuth {
  user: User | null;
  dbUser: { id: string; role: UserRole } | null;
}

// One store per /api/dashboard/batch request. Every widget route in the batch
// runs inside it, so they share one auth.getUser() round trip and one users
// lookup instead of repeating both per widget.
const batchScope = new AsyncLocalStorage<{ auth?: Promise<DashboardAuth> }>();

export function runInDashboardBatch<T>(fn: () => Promise<T>): Promise<T> {
  return batchScope.run({}, fn);
}

async function resolveDashboardAuth(): Promise<DashboardAuth> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, dbUser: null };

  const { data: dbUser } = await createAdminClient()
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  return { user, dbUser: dbUser ?? null };
}

/**
 * Session user plus their `users` row, for /api/dashboard/* routes.
 * Called standalone it does the same getUser + users lookup each route used
 * to do inline; inside a batch the result is shared across all widgets.
 */
export function getDashboardAuth(): Promise<DashboardAuth> {
  const scope = batchScope.getStore();
  if (!scope) return resolveDashboardAuth();
  scope.auth ??= resolveDashboardAuth();
  return scope.auth;
}

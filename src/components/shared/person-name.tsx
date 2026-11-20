"use client";

import { useCurrentUser } from "@/providers/current-user-provider";
import { personLabel } from "@/lib/person-label";

/** A person's name, or "You" when it is the signed-in user, so nobody reads their own name as someone else's. */
export function PersonName({ id, name }: { id?: string | null; name?: string | null }) {
  const { user } = useCurrentUser();
  return <>{personLabel({ id, name }, user?.id)}</>;
}

import type { UserRole } from "@/types";
import type { JourneyOwner } from "./types";

/**
 * Which logged-in roles act on a step owned by `owner`. Admin is listed for
 * the steps only an admin can do; the admin dashboard deliberately has no
 * journey widget, so this does not add admin noise.
 */
export const OWNER_ROLES: Record<JourneyOwner, UserRole[]> = {
  sales: ["sales_rep", "manager"],
  accounts: ["accounts"],
  admin: ["admin"],
  manager: ["manager"],
  ops: ["floor_manager", "office_admin", "manager"],
  it: ["it_manager", "it_technician"],
};

export function ownersForRole(role: string): JourneyOwner[] {
  return (Object.keys(OWNER_ROLES) as JourneyOwner[]).filter((o) => (OWNER_ROLES[o] as string[]).includes(role));
}

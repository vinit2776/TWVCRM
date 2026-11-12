/**
 * Roles confined to a single page. They get a stripped-down shell (no sidebar, no
 * notification bells, no search) and are bounced back to their one page from anywhere else.
 */
export const ENQUIRY_VIEWER_ROLE = "enquiry_viewer";

/** The only dashboard page an enquiry_viewer may open. */
export const ENQUIRY_VIEWER_HOME = "/leads/enquiry-log";

/**
 * Coordinator sees Sales, Operations, Procurement and day-to-day Facility, but nothing under
 * Finance, HR & Payroll or Admin. The sidebar already hides those entries; this list is what
 * stops them being opened by typing the address. Writes are still refused by each API route.
 */
export const COORDINATOR_ROLE = "coordinator";

export const COORDINATOR_HOME = "/dashboard";

const COORDINATOR_BLOCKED_PREFIXES = [
  "/admin",
  "/settings",
  "/team",
  "/payroll",
  "/accounting",
  "/billing",
  "/finance",
  "/invoices",
  "/rent-management",
  "/audit-logs",
  "/infrastructure",
  "/support",
  "/analytics",
  "/locations",
  "/attendance",
  "/facility/settings",
  "/procurement/electricity",
  "/procurement/verify",
] as const;

export function isCoordinatorBlockedPath(pathname: string): boolean {
  // A person's own activity page lives under /team but isn't team management.
  if (/^\/team\/[^/]+\/activity\/?$/.test(pathname)) return false;
  return COORDINATOR_BLOCKED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

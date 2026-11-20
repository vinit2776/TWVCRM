/** The enquiry before and after this one in the list the panel steps through; null at either end or when it is not in the list. */
export function panelNeighbours(ids: string[], currentId: string): { prev: string | null; next: string | null; position: number | null } {
  const i = ids.indexOf(currentId);
  if (i < 0) return { prev: null, next: null, position: null };
  return { prev: i > 0 ? ids[i - 1] : null, next: i < ids.length - 1 ? ids[i + 1] : null, position: i + 1 };
}

/** The enquiry the panel opens next after one is finished: the one after it, else the one before, else none. */
export function afterFinishing(ids: string[], finishedId: string): string | null {
  const { next, prev } = panelNeighbours(ids, finishedId);
  return next ?? prev;
}

/**
 * Where "Call back" goes when the check panel is on: the Leads page with the enquiry in the address.
 * Already on Leads, the current view stays under the panel; anywhere else it opens over New enquiries.
 */
export function checkPanelHref(enquiryId: string, pathname: string, search: string): string {
  const params = new URLSearchParams(pathname === "/leads" ? search : "");
  if (pathname !== "/leads") params.set("view", "enquiries");
  params.set("enquiry", enquiryId);
  return `/leads?${params.toString()}`;
}

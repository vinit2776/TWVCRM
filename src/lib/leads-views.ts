/** The views of the Leads page. The URL's `?view=` picks one; no value means All leads. */
export const LEADS_VIEWS = ["home", "enquiries", "replies", "followups", "tours", "all", "whatsapp", "waiting", "channels"] as const;
export type LeadsView = (typeof LEADS_VIEWS)[number];

export const DEFAULT_LEADS_VIEW: LeadsView = "all";

export function parseLeadsView(value: string | null | undefined): LeadsView {
  return (LEADS_VIEWS as readonly string[]).includes(value ?? "") ? (value as LeadsView) : DEFAULT_LEADS_VIEW;
}

/** The Leads page address for a view. All leads is the bare page, so existing links keep working. */
export function leadsViewHref(view: LeadsView): string {
  return view === DEFAULT_LEADS_VIEW ? "/leads" : `/leads?view=${view}`;
}

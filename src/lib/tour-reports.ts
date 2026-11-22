// Rules for working a tour on the day: who may mark the customer arrived or write the visit report,
// and what a report must contain. Pure, so the routes and the screens agree.

export const TOUR_REPORT_OUTCOMES = ["keen", "thinking", "comparing", "not_a_fit"] as const;
export type TourReportOutcome = (typeof TOUR_REPORT_OUTCOMES)[number];
export const TOUR_REPORT_OUTCOME_LABELS: Record<TourReportOutcome, string> = {
  keen: "Keen to go ahead",
  thinking: "Wants time to think",
  comparing: "Comparing other places",
  not_a_fit: "Not a fit",
};

export const REPORT_MAX_PHOTOS = 12;

export interface TourPeople {
  hostId: string | null;
  accompanierId: string | null;
  createdBy: string | null;
  leadOwnerId: string | null;
  /** Users in charge of the centre the tour is at (locations.incharge_user_id_1 / _2). */
  inchargeIds: string[];
}

/** Roles that work every lead, so every tour: admin, manager and the sales roles. */
const HANDLER_ROLES = ["admin", "manager", "sales_rep"];

/**
 * May this person act on the tour (mark arrived, or no-show, or write its report)? Handlers always;
 * a floor incharge only at their own centre or when named host or accompanier. Nobody else.
 */
export function canWorkTour(role: string | null | undefined, userId: string, p: TourPeople): boolean {
  if (role && HANDLER_ROLES.includes(role)) return true;
  if (role === "floor_manager") return p.inchargeIds.includes(userId) || p.hostId === userId || p.accompanierId === userId;
  return false;
}

export interface ReportInput {
  outcome: string | null | undefined;
  comments: string | null | undefined;
  photoPaths: string[];
}

/** What is missing from a visit report, in plain words; null when it can be submitted. */
export function reportProblem(r: ReportInput): string | null {
  if (!r.outcome || !(TOUR_REPORT_OUTCOMES as readonly string[]).includes(r.outcome)) return "Pick how the visit went";
  if (!r.comments || r.comments.trim().length < 3) return "Add a comment about the visit";
  if (r.photoPaths.length < 1) return "Add at least one photo";
  if (r.photoPaths.length > REPORT_MAX_PHOTOS) return `At most ${REPORT_MAX_PHOTOS} photos`;
  return null;
}

/** Photos must sit under this tour's own folder, so a report can never point at another file. */
export function photoPathOk(tourId: string, path: string): boolean {
  return path.startsWith(`tour-reports/${tourId}/`) && !path.includes("..");
}

export type ArrivalState = "upcoming" | "here" | "reported" | "no_show";

/** Where a tour stands on the day: not yet, the customer is here (report due), reported, or did not come. */
export function arrivalState(t: { outcome: string | null; arrivedAt: string | null; hasReport: boolean }): ArrivalState {
  if (t.hasReport) return "reported";
  if (t.outcome === "no_show" || t.outcome === "cancelled") return "no_show";
  if (t.arrivedAt) return "here";
  return "upcoming";
}

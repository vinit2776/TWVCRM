/**
 * The Queries feature's visual identity — one accent, defined once.
 *
 * Queries appear on eight different surfaces (Tally Inbox rows, receivables
 * rows, vendor bill and contract detail pages, the /queries page…), and the
 * badge is how you spot at a glance which records are blocked on an answer.
 * That only works if it's the same colour everywhere.
 *
 * It drifted almost immediately: the Tally Inbox button was blue while the
 * detail-page button was amber, so the same feature read as two different
 * things depending on where you met it. These constants exist so there is
 * nowhere to disagree.
 *
 * Blue is deliberately *not* one of the semantic colours already in play
 * inside a thread — amber means overdue, green resolved, red action-needed.
 * Blue means "this is a query", independent of its state.
 */

/** Resting state: visibly the Queries feature, even with nothing open. */
export const QUERY_BUTTON_IDLE =
  "border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:text-blue-300";

/** Expanded / active. */
export const QUERY_BUTTON_ACTIVE =
  "bg-blue-50 border-blue-300 text-blue-800 dark:bg-blue-950 dark:border-blue-800 dark:text-blue-200";

/** Has open threads — same hue, more weight, so it reads as "needs you". */
export const QUERY_BUTTON_HAS_OPEN =
  "bg-blue-50 border-blue-300 text-blue-800 hover:bg-blue-100 dark:bg-blue-950 dark:border-blue-800 dark:text-blue-200";

/** The count pill. */
export const QUERY_BADGE = "bg-blue-700 text-white dark:bg-blue-500 dark:text-blue-950";

/** Icon accent wherever the feature is labelled rather than actioned. */
export const QUERY_ACCENT_TEXT = "text-blue-700 dark:text-blue-300";

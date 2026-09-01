// Versioned onboarding content for the employee dashboard: the first-login guided
// tour, and the "what's new" delta shown to already-onboarded employees after an
// update ships. Mirrors how i18n.js works — copy lives here, referenced by key, so
// it's reviewed in the same PR as the feature it describes.
//
// Whoever ships a feature that changes what an employee sees adds ONE entry below
// and bumps CURRENT_VERSION. Never renumber or reuse a past version number, even if
// an entry is later removed — a stale users.onboarding_seen_version must always mean
// the same set of past changes.
//
//   tourStep  — shown, in array order, to an employee going through the tour for the
//               first time (users.onboarding_seen_version = 0 on their next login).
//               anchor is a CSS selector for a real element already on the dashboard.
//   whatsNew  — shown as a delta item to an already-onboarded employee whose
//               onboarding_seen_version is below this entry's version. Omit it on an
//               entry that's only worth teaching a brand-new hire, not announcing to
//               someone who's already using the app.

const CURRENT_VERSION = 1;

const ENTRIES = [
  { id: 'hours-punch', version: 1, tourStep: { anchor: '#onbHoursCard', key: 'onboarding.step.hours' } },
  { id: 'leave-balance', version: 1, tourStep: { anchor: '#onbLeaveCard', key: 'onboarding.step.leave' } },
  { id: 'nav-calendar', version: 1, tourStep: { anchor: '#navCalendar', key: 'onboarding.step.calendar' } },
  { id: 'nav-requests', version: 1, tourStep: { anchor: '#navLeave', key: 'onboarding.step.requests' } },
  { id: 'lang-notifications', version: 1, tourStep: { anchor: '#navNotifications', key: 'onboarding.step.notifications' } },
];

module.exports = { CURRENT_VERSION, ENTRIES };

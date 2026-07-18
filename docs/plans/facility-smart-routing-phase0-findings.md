# Phase 0 Findings — Facility Work Order Misrouting & Language Mix

Read-only query against the `backup_user` replica (confirmed SELECT-only: no INSERT/UPDATE/
DELETE grant) on 2026-07-18. 115 total `facility_issues` rows, created 2026-05-02 to
2026-07-18.

## Headline: this is not a subtle classification problem

**90 of 100 non-test tickets are scoped `it`.** After stripping obvious seed/test rows
(demo batch of 15 IT titles each repeated exactly 4x, plus literal "Test"/"TEST ... safe to
delete" rows used to verify other features), 55 unique organic tickets remain. Of those,
at least **9–11 are unambiguous content-vs-scope mismatches — all misrouted *to* IT, zero
in the other direction**:

| Ticket | Scoped as | Actually is |
|---|---|---|
| Handle Broken | it | facility |
| Chair Handle broken | it | facility |
| Table Broken in Cabin No 2 | it | facility |
| Restroom Door | it | facility |
| Door Stopper fixing | it | facility |
| Light not working | it | electrical |
| In Server room Hole | it | facility |
| Wall mounted fan issue | it | electrical/facility |
| AC Cooling | it | hvac |
| Conference Room Casattee AC | it | hvac |
| Dust Claeaning | it (via earlier dump) | housekeeping |

Two of these are smoking-gun **twin pairs** — the same real-world complaint, reported by two
different people, scoped differently:
- `AC not cooling` → correctly scoped `hvac` (HV-2026-00001)
- `AC Cooling` → scoped `it` (IT-2026-00094)
- `Wall mounted fan` → correctly scoped `facility` (FA-2026-00006)
- `Wall mounted fan issue` → scoped `it` (IT-2026-00093)

Same words, same problem, opposite department, depending on who tapped the button. This
isn't a vocabulary gap a smarter model closes — it's a UI default problem.

## Root cause, confirmed against config

- `SCOPE_ORDER` in [report-wizard.tsx:52](../../src/components/facility/report-wizard.tsx#L52)
  puts `it` first in the 8-button grid — the easiest, most habitual tap.
- Of the 8 `facility_departments`, only **it, electrical, other** have a `head_user_id`
  configured. hvac, plumbing, housekeeping, security, facility have **no department head** —
  a correctly-scoped ticket in those five departments has nobody to auto-assign to and sits
  unclaimed. That's a plausible reinforcing loop: people learn "IT gets picked up, everything
  else doesn't," so they pick IT regardless of content.
- `category_id` is set on exactly the 22 oldest (seed-batch) tickets and **null on every
  organic ticket since** — confirms the earlier code-read finding that the wizard's category
  path is dead in practice, not just in theory.
- No `scope_changed` event type exists in `facility_issue_events` (only `status_changed,
  created, comment, resolved, assigned, photo_added, claimed, reopened, tat_extended,
  pass_card`) — the system has never recorded a manual scope correction, so a
  reassignment-based misroute signal isn't available. The content-vs-scope mismatch above is
  direct evidence instead, and it's stronger than an indirect signal would have been.

## Language mix: the Tamil/Tanglish assumption did not hold in this sample

**Zero tickets contained Tamil script or Tanglish vocabulary.** All 115 titles/descriptions
are English, including ones with English typos ("Claeaning", "Pedestral", "Gatway",
"Casattee") — consistent with English typed under time pressure, not translation.

The likely explanation is in `reported_via`: **65 walk_in, 17 phone, 16 whatsapp, 16
proactive, 1 self_service.** Only one ticket in 115 was filed by the affected person
directly through self-service — nearly everything is filed by an intermediary (front
desk/IT/office staff) who transcribes into English regardless of what language the original
complaint arrived in. This doesn't mean ground staff don't think or speak in Tamil; it means
the *tool itself* is almost never used directly by them today, so the tool's own history has
no Tamil to learn from.

This is a real tension worth deciding on explicitly, not silently:
- If Phase 3.6 (language toggle) is meant to serve the **technicians** who read/resolve
  tickets (my-issues, notifications) — the data doesn't contradict that; it's still
  reasonable they'd prefer Tamil for their own task list and WhatsApp updates.
- If it's meant to let **housekeeping/ground staff self-report** in Tamil — that's a
  before-the-fact bet, not something the data confirms, because self-service is barely used
  today (n=1) by anyone in any language. It may be under-used *because* it's English-only and
  intimidating, or it may just not be the habit regardless of language. Worth a quick check
  with a couple of actual housekeeping staff before building the wizard-side Tamil input,
  since that's the more expensive half of Phase 3.6.

Recommend: still build Phase 2's classifier with Tamil/Tanglish pattern support (cheap,
future-proof, doesn't hurt English matching), but hold the wizard-side Tamil *input* UI sizing
question until we've asked 2-3 housekeeping/security staff how they'd actually want to report
something today — a hallway conversation, not a build.

## What this changes in the plan

1. **Phase 1 (structural fixes) is now the highest-confidence, highest-value phase in the
   whole plan** — the data shows real, current, non-hypothetical misrouting caused exactly by
   the two bugs it targets (scope defaults / hidden picker) plus the missing department
   heads. Recommend building the department-head gap into Phase 1 too: at minimum, flag in
   the facility settings UI when a department has no head, since an unstaffed department is
   arguably a bigger lever than the classifier.
2. **Phase 2's rule table now has real seed vocabulary** — pull directly from this findings
   list rather than invented examples: "AC cooling/not cooling" → hvac, "chair/table/door/
   handle broken", "wall/hole/dust cleaning" → facility, "light not working/plug not working/
   fan" → electrical.
3. **Phase 4's 85% agreement bar is easy to sanity-check early**: the classifier should catch
   every ticket in the table above. If it doesn't, the rules aren't ready.
4. **Phase 3.6 scope needs one more data point** (a quick conversation with ground staff)
   before committing to full wizard-side Tamil input — flagged above, not blocking Phase 1–2.

## Volume caveat

115 tickets over ~2.5 months, ~40% of which are seed/test data, is a small sample from a
feature that only recently saw real usage growth (the misrouting cluster is concentrated in
the second half of the timeline, tickets #81 onward). Directionally clear, but re-run this
same query after another 4-6 weeks of real volume before trusting exact percentages.

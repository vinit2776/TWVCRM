# Enquiry handling: scenario test and operating routines

Tested 2026-11-23 on a staging preview of `main` (amber STAGING banner on screen throughout), as the staging admin, through the real UI only. Nothing was sent to a customer; every dialog that notifies someone says it tells staff only. Staging switches are as production: new Leads home, hand-over jobs, tour arrivals, waiting-for-space and loop-in ON; overdue review, escalation and space matching in dry run.

## 1. The daily enquiry cycle

| When | Step | Who | Where | Customer sees it? |
|---|---|---|---|---|
| Any time | Enquiry arrives (WhatsApp, Meta, Google, form, call) | system | New enquiries tab | No |
| Within 1 hour | Someone takes it ("I'll take this") | sales | New enquiries | No |
| Same hour | First call, log it (Spoke / No answer), set the next step | the taker | Lead page | Yes, the call |
| Same day | Name, requirement and seats captured on the lead | the taker | Lead page | No |
| As needed | Hand over a job (call back, tour, proposal) or loop someone in | the taker | Hand over / Keep someone informed | No |
| Tour day | Record the outcome (Came / Didn't come) | host | Tours tab, "Needs update" | No |
| Every morning | Clear the red "overdue follow-ups" card, then Today | each rep | Leads home | No |
| Weekly | Read Channels: junk rate, untouched enquiries, first-contact time | admin | Reports → Channels | No |

## 2. Scenario results

| # | Scenario | Result | What happened |
|---|---|---|---|
| 1 | Enquiry arrives and the team can see it | Pass | 13 enquiries across WhatsApp, Meta and Google Ads on one queue, each with age and an "Overdue ≥4h" or "Stale" badge; unclaimed count shown. |
| 2 | Someone takes it, and everyone sees who | Pass | "I'll take this" turned the card to "Staging Admin is on it" and cleared the overdue badge. |
| 3 | Call logged, next step set | Pass | "Spoke" with a note saying "Friday 4pm" filled the date and time (Fri 27 Nov, 4 PM). Status became Contacted; timeline shows the call. |
| 4 | No answer | Pass | Asks why, proposes a retry (Wed 25 Nov), and closes the old follow-up on the timeline ("replaced by No answer"). |
| 5 | Junk or spam | Pass | Not a lead offers four reasons, labels the number so future messages stop opening enquiries, and has an Undo. |
| 6 | Tour no-show | Pass | "Didn't come" forces a choice (book again, call to rebook, close) and a dated next step. Tour count in "Needs update" fell 3 to 2. |
| 7 | Hand over to a colleague | Pass with gaps | Dialog lists staff, says nothing goes to the customer, logs it on the timeline. The lead header does not show the open job afterwards. |
| 8 | No space for what they want | Pass with gaps | "Waiting for space" records area, reason and note and says nobody chases it. The lead still shows an amber "No next step" and stays in the Today list. |
| 9 | Admin view | Pass | Channels shows enquiries, junk, reached, tours, won and first-contact time per channel, and says honestly that 7 of 7 channels are too small to judge and 39% of enquiries were never touched. |
| 10 | Overdue follow-ups | Pass | Red card "4 overdue follow-ups need action (+1 due today)" with Review now. |
| 11 | Not interested, duplicate or re-enquiry, proposal send, loop-in | Not exercised | Re-enquiries show a badge (TWV-E-0009 "Re-enquiry · 2 messages"). The rest were not clicked in this pass. |
| 12 | Escalation of untaken enquiries, space matching, WhatsApp reply alerts | Cannot test | Timed jobs; escalation and space matching are in dry run in production. Behaviour read from the rules only. |

## 3. Where the flow still leaks

Ranked by how likely a real enquiry is lost.

1. **Taking an enquiry does not make you the lead's owner.** After taking and calling TWV-E-0113 the lead still read "Unassigned · Claim" on the list, and the lead page showed "Staging Admin is on the enquiry · Claim lead". If the taker goes on leave, the lead belongs to nobody. Same for Meera Kapoor's lead.
2. **The next step lives in two places.** Meera's enquiry card showed "Next: Call back with cabin pricing, overdue" while her lead showed "No next step". Whoever opens the lead sees no reminder.
3. **Call notes do not fill the requirement.** The note said "5-seat cabin from 1 Dec" but the lead still read "Wants no requirement recorded", and the name shows as "Rahul -" after the one-click name fix. Hand-over and proposals depend on that requirement.
4. **Old WhatsApp enquiries stay unassigned with no next step** (#1040 to #1042, 35 days old, status New). Escalation is in dry run, so nothing pushes them.
5. **Future tours with no next step** (#1120 to #1121) and one tour past due with no outcome: only the Tours tab catches these.
6. **Parked leads still look unworked** ("No next step", still listed in Today), which contradicts "nobody chases it" and trains people to ignore the amber chip.
7. **Hand-over is invisible on the lead header**, so a second person can start the same job.
8. **Labelling a number as not a lead is number-wide.** A real prospect labelled by mistake goes silent until someone uses Undo or the Possible leads list.

## 4. Routines (one page each)

**A. Take it (anyone in sales, within 1 hour)**
1. Open New enquiries. Take the oldest red card.
2. Add the name ("Use ..." chip) if it is empty.
3. If it is obviously not a lead, choose Not a lead and pick the reason.
4. Open it and log the first call within the hour.

**B. After every call**
1. Choose Spoke, No answer, Tour booked, Quote sent or Not interested.
2. Write what was said with a date or day. The next-step date fills from it.
3. Never leave a lead with "No next step". If nothing is due, set a check-in.
4. If you own it from now on, click Claim lead.

**C. Morning check (every rep, 10 minutes)**
1. Clear the red overdue card first: call, reschedule or close each lead.
2. Work Today, then the Tours tab "Needs update" list.
3. Record every tour outcome the same day.

**D. Hand over or loop in**
1. Use Hand over for a specific job; write what was discussed so they need not ask.
2. Use Keep someone informed to copy a colleague without giving them the job.
3. Check the timeline shows it before leaving.

**E. No space**
1. Choose Waiting for space, record area, reason and what they want.
2. Set a look-again date. Review the parked list every Monday.

**F. Weekly admin review (Monday)**
1. Reports → Channels, 30 days: read junk rate, "never touched" and first-contact minutes.
2. Open any channel whose first contact is over 60 minutes and ask why.
3. Review unclaimed enquiries older than 3 days.

## 5. Risk register

| # | Risk | Likelihood | Impact | Plan |
|---|---|---|---|---|
| 1 | Enquiry sits untaken for days | High (11 unclaimed on staging) | High | Turn escalation from dry run to live when a manager is ready to receive alerts; until then routine C. |
| 2 | Taker never claims the lead | High | Medium | Rule: Claim lead right after the first call (routine B). |
| 3 | Next step missing or only on the enquiry | High | High | Fix gap 2 so the lead shows the enquiry's next step; routine B. |
| 4 | Requirement not captured | Medium | Medium | Fix gap 3; copy the note into the requirement. |
| 5 | Tour outcome not recorded | Medium | Medium | Tours tab "Needs update" in routine C. |
| 6 | Hand-over forgotten | Medium | Medium | Show open jobs on the lead header (gap 7). |
| 7 | Wrongly labelled number | Low | High | Undo toast; check Possible leads weekly. |
| 8 | Parked leads forgotten | Medium | Medium | Look-again date and Monday review. |
| 9 | Channel numbers misread | Medium | Low | Report already says "too few to judge"; do not change spend on under 10 enquiries per channel. |
| 10 | Timed jobs (escalation, space match, reply alerts) not behaving | Unknown | High | Watch the dry-run output for a week before switching on. |

## 6. Not covered

- Production. This is staging with fake data.
- Phone width and any role other than admin (sales rep, coordinator).
- Proposal sending, Not interested, loop-in and duplicate handling.
- The timed jobs in section 2, row 12.

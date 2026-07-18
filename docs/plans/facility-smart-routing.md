# Facility Work Order — Smart Department Routing + Bilingual Support

Status: **Planned, not built.** Agreed with Vinit 2026-07-18.

## Problem

Reporters pick the wrong department when filing a facility work order, and Tamil-speaking
staff need to file in their own language while management reads in English.

## Diagnosis (from codebase exploration)

- There is no `department` column on `facility_issues`. Department is derived 1:1 from the
  `scope` enum (`it, hvac, plumbing, electrical, housekeeping, security, other, facility`)
  via `facility_departments.scope`.
- The wizard ([src/components/facility/report-wizard.tsx](../../src/components/facility/report-wizard.tsx))
  captures `scope` as one tap on an 8-button grid. That single tap is the entire routing
  signal — `category_id` is never sent by the wizard (made nullable in migration `00279`,
  intended to be filled at triage, but nobody fills it), so the more specific
  `category.default_assignee_id` routing branch in
  [src/app/api/facility/issues/route.ts:200](../../src/app/api/facility/issues/route.ts#L200)
  never fires. Every wizard ticket routes on `scope → facility_departments.head_user_id` alone.
- Selecting an asset in the wizard derives `scope` from `asset.category.scope` and **hides**
  the scope picker entirely (report-wizard.tsx:155) — a mis-categorized asset silently
  misroutes every ticket against it, with no way to see or override it in the moment.
- The delegate-task dialog
  ([src/components/facility/delegate-task-dialog.tsx](../../src/components/facility/delegate-task-dialog.tsx))
  sends no scope at all; the server defaults every delegated task to `scope: 'it'`.
- `facility_asset_categories.default_assignee_id` / `backup_assignee_id` are referenced
  throughout the code and typed at `src/types/index.ts:2869-2870`, but no migration file
  creates them — needs verification against the live schema before Phase 3 depends on it.
- The Anthropic SDK (`@anthropic-ai/sdk`) is already a dependency, used once today in
  `src/lib/email-parser.ts` for aggregator email parsing. No other LLM usage in the codebase.
- Internal staff only need Tamil: ground/housekeeping staff report in Tamil or "Tanglish"
  (Tamil typed in Roman script — e.g. "AC thanda pannala"), technicians receive work orders.
  Public QR-scan reporting and customer-facing surfaces stay English-only (out of scope).

## Guiding principles

1. **Suggest, never block.** Every AI output is a pre-fill one tap from being overridden.
   A wrong suggestion costs nothing; a wrong block costs trust and time.
2. **The classifier is language-agnostic by construction.** Rules match Tamil script,
   Tanglish, and English patterns directly — no translation call sits on the ticket-create
   critical path.
3. **The original text is sacred.** Translations are stored alongside the original, never
   overwriting it. ISO ticket registers and the reporter's own record must show what was
   actually written.
4. **Earn trust before spending it.** Ship the classifier dark (server-side only, telemetry
   recorded), validate against real resolution outcomes, only then reveal the UI.

## Phases

### Phase 0 — Measure (½ day, blocking on Phases 2-4)
Read-only query against the **BACKUP_DB_* read replica** (never the primary/service role) over
`facility_issues` + `facility_issue_events`:
- Misroute rate: how often scope/assigned department changed after creation, grouped by
  original scope, reporter, and location.
- Language split of historical titles: English / Tamil script / Tanglish / mixed.
- Top 30 misrouted titles, verbatim — seeds the rule table vocabulary.

Output: a findings note. Phases 2-4 are re-scoped against actual numbers, not assumptions.

### Phase 1 — Structural fixes (1 day, ships as its own PR)
Plain bugs, no intelligence, no waiting on Phase 0/4. Scope confirmed and expanded against
[Phase 0 findings](facility-smart-routing-phase0-findings.md):
- Add a scope picker to `delegate-task-dialog.tsx` (currently always defaults to IT).
- Keep the scope picker visible and overridable in `report-wizard.tsx` when an asset is
  selected, instead of hiding it — pre-select from the asset's category, but let the user
  correct it.
- Log when a ticket's resolving department differs from its asset's registered scope, as a
  signal that the *asset* is mis-categorized (fix once, fixes every future ticket on it).
- **Flag departments with no `head_user_id`** in `facility/settings`. Phase 0 found only
  3 of 8 departments (it, electrical, other) have a head — the other five have nobody to
  auto-assign to, a plausible reinforcing cause of the IT-default habit. A visible warning
  badge, not an auto-fix (staffing is an org decision, not a code fix).
- Verify `default_assignee_id` / `backup_assignee_id` columns actually exist in production
  (no creating migration found) before Phase 3 relies on them; write a catch-up migration
  if they were applied out-of-band or are missing.

### Phase 2 — Trilingual rule engine (2-3 days)
New pure module `src/lib/facility-classifier.ts`, no network call, imported by both client
(live suggestions) and server (authoritative re-check at create time).

```
classify(title, description, assetScope?) → {
  scope, confidence, matchedTerms[], categorySlug?,
  priorityFloor?, titleQuality, detectedLanguage
}
```

Every rule carries English, Tamil script, and Tanglish patterns, e.g.:
```
{ scope: 'hvac', weight: 3, patterns: [
    'ac not cooling', 'aircon', 'not cold',
    'ஏசி', 'குளிரவில்லை',
    'ac thanda', 'thanda pannala', 'ac velaila' ] }
```
- Normalize hard before matching (lowercase, strip diacritics, collapse Tanglish spelling
  variants like thanni/tanni/thanneer).
- Weighted scoring, not first-match — e.g. "power socket sparking" is Electrical not HVAC.
  Ties → no suggestion.
- Explicit confidence threshold — below it, show nothing rather than guess.
- Rule table lives in code (version-controlled, PR-reviewable), not the DB. Revisit only if
  ops need to edit it without a deploy.

### Phase 3 — Wire in, dark (2 days)
- **Client**: wizard Step 2, 400ms debounce on title/description. Pre-selects the scope
  button with a receipt ("✨ Routed to Electrical — matched 'socket', 'sparking'"). Vague-title
  coaching and a priority-sanity nudge (safety/outage language on Low, cosmetic language on
  Critical), both non-blocking, in the reporter's language.
- **Server**: re-runs `classify()` after validation in `issues/route.ts`, records both the
  suggestion and the user's actual choice — never overrides.
- New migration `00352_facility_classifier_telemetry.sql`: `suggested_scope`,
  `suggested_category_id`, `classifier_confidence`, `classifier_source`, `classifier_matched`,
  `user_accepted_suggestion`, `detected_language`.
- Category autofill (finally populating the always-blank `category_id`, which activates the
  currently-dead `default_assignee_id` routing) sits behind its own flag
  `facility_category_autofill_enabled`, separate from the suggestion UI flag — it's a real
  change in who gets assigned and deserves its own rollout.

### Phase 3.5 — Content translation for management visibility (1-2 days)
- Migration adds `title_en`, `description_en`, `original_language` to `facility_issues`.
- Non-English text translated to English asynchronously, fire-and-forget (same pattern as
  `logAudit()`), off the create critical path. Failure just leaves the toggle showing the
  original.
- `EN / த` toggle on ticket detail + list views. Manager defaults to English; one tap shows
  the original with a "translated" marker.
- ISO ticket register exports carry both columns.
- **PDF gotcha**: jsPDF's default fonts have no Tamil glyphs — Tamil renders as empty boxes.
  Registers/exports need an embedded Tamil font (Noto Sans Tamil, ~200KB) or export the
  English translation only. Decide when we get here.

### Phase 3.6 — Language preference + toggle (2 days)
- `users.preferred_language` (`'en' | 'ta'`, default `'en'`), set in profile.
- `next-intl`, scoped to **wizard + my-issues + ticket detail only** (~150 strings). Admin,
  settings, analytics, KPI screens, and every other module stay English.
- Persistent header toggle overrides the saved preference either direction — covers both
  "management wants to read Tamil-filed tickets in English" and the reverse.
- Notifications (push/WhatsApp/email via `src/lib/facility-notifications.ts`) go out in the
  **recipient's** preferred language, not the reporter's. Needs a Tamil MSG91 WhatsApp
  template variant registered — external dependency, start early.

**Held pending validation:** Phase 0 found only 1 of 115 tickets was ever self-filed — nearly
everything goes through an intermediary who transcribes into English, and zero tickets
contained Tamil or Tanglish. Wizard-side Tamil *input* is therefore a bet the data doesn't yet
confirm. Build the technician-facing half (my-issues, ticket detail, notifications) on
schedule; hold the wizard-side Tamil input until a quick conversation with 2-3 actual
housekeeping/security staff confirms they'd use it.

### Phase 4 — Shadow, validate, reveal (~2 weeks elapsed)
Ship Phases 2-3 with `facility_classifier_ui_enabled = false` — server classifies and
records, reporters see nothing. After ~2 weeks, compare `suggested_scope` against the
department that actually resolved each ticket. ≥85% agreement → turn the UI on. Lower →
tune rules against the real misses first.

### Phase 5 — Duplicate detection (1 day, independent)
`GET /api/facility/issues/similar` — open tickets at the same location/asset in the last 7
days, Postgres trigram match (`pg_trgm`, one migration). Dismissible card in Step 2, never
blocks.

### Phase 6 — LLM classifier fallback (1 day, deferred, build only if Phase 4 shows a gap)
Only for text no rule scores. Reuses the pattern at `src/lib/email-parser.ts:100-113`.
Output constrained to the 8 scope values, cached by normalized title hash, 3s timeout
failing open to "no suggestion". Tagged `classifier_source = 'llm'` so we can measure
whether it beats the rules.

## Explicitly not doing

- Blocking or hard-confirm dialogs on department mismatch.
- A separate `department` column — `scope` already is the department via
  `facility_departments`, 1:1. A second source of truth would be the actual bug.
- Restricting who can claim across departments — the roster is intentionally informational
  today; locking it down turns a routing annoyance into a work stoppage.
- Public-route or customer-facing Tamil (QR-scan report page stays English).
- App-wide i18n — facility module only (wizard, my-issues, ticket detail).

## Effort summary

| Phase | Effort | Independent? |
|---|---|---|
| 0 — Measure | ½ day | blocks 2-4 |
| 1 — Structural fixes | 1 day | ships alone |
| 2 — Rule engine | 2-3 days | |
| 3 — Wire in (dark) | 2 days | |
| 3.5 — Translation | 1-2 days | ships alone |
| 3.6 — Language toggle | 2 days | ships alone |
| 4 — Validate & reveal | 2 wks elapsed | |
| 5 — Duplicates | 1 day | ships alone |
| 6 — LLM fallback | 1 day | only if needed |

~10 working days of build, 2-week observation window before the classifier UI goes live.

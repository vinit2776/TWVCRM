# Leads

## Purpose and Business Context

The Leads module is the entry point of the TWV CRM sales pipeline. It captures and manages every potential customer of The WorkVilla coworking space — from initial enquiry through qualification, tour, proposal, and ultimately conversion to a paying contract or loss. The module surfaces real-time incoming form enquiries, enables full activity tracking (calls, meetings, tours, notes), KYC document collection, and integrates directly with the Proposals and Contracts modules.

A "lead" in this system always belongs to a person or business exploring coworking services. The lifecycle ends at `won` (a contract is activated) or `lost`/`junk` (the opportunity is dead or was invalid).

---

## All Routes

| Route | Purpose |
|---|---|
| `/leads` | Paginated leads list with filters, real-time enquiry banners, search |
| `/leads/new` | Create a new lead (form, POST `/api/leads`) |
| `/leads/[id]` | Lead detail — Overview, Activities, Tasks, Proposals, Contracts, Documents, Feedback tabs |
| `/leads/[id]/edit` | Edit a lead (form pre-filled, PATCH `/api/leads/[id]`) |

Both `/leads` and `/leads/[id]` are `"use client"` pages. There are no Server Components in this module.

---

## Key Source Files

### Pages
- `src/app/(dashboard)/leads/page.tsx` — list page
- `src/app/(dashboard)/leads/new/page.tsx` — create page
- `src/app/(dashboard)/leads/[id]/page.tsx` — detail page
- `src/app/(dashboard)/leads/[id]/edit/page.tsx` — edit page

### Components
- `src/components/leads/lead-form.tsx` — shared create/edit form (React Hook Form + Zod, `createLeadSchema`)
- `src/components/leads/lead-lifecycle.tsx` — visual journey stepper on Overview tab sidebar
- `src/components/leads/lead-contacts-panel.tsx` — multiple contact points per lead
- `src/components/leads/lead-cautions-banner.tsx` — warning/danger banner on overview + new-booking flow
- `src/components/leads/lead-billing-snippet.tsx` — lifetime/FY revenue snapshot on Activities tab (lazy-loaded)
- `src/components/leads/lead-proposals-tab.tsx` — proposals for this lead
- `src/components/leads/lead-contracts-tab.tsx` — contracts for this lead
- `src/components/leads/lead-documents-tab.tsx` — file attachments
- `src/components/leads/lead-tasks-tab.tsx` — tasks linked to this lead
- `src/components/leads/lead-feedbacks-tab.tsx` — booking feedback ratings
- `src/components/leads/lead-credits-card.tsx` — partial-checkout credit carry-forward
- `src/components/leads/import-leads-dialog.tsx` — CSV import dialog (lazy-loaded)
- `src/components/leads/overdue-followup-banner.tsx` — persistent "N overdue follow-ups" banner on the leads list; fetches `/api/leads/followup-summary` and links to a "Review now" action that clears all filters
- `src/components/activities/lead-timeline.tsx` — activity feed on Activities tab; its reschedule control uses `FollowUpDateTimeInput`
- `src/components/activities/activity-form.tsx` — log call/meeting/note/tour modal; follow-up picker uses `FollowUpDateTimeInput` and shows a "What happens when you log this" preview
- `src/components/shared/followup-datetime-input.tsx` — `FollowUpDateTimeInput` — shared date + 30-min time-slot picker (9:00 AM–8:00 PM) used by the Log Activity dialog, the dashboard Follow-ups widget, and the lead timeline reschedule control; replaces the native `datetime-local` input everywhere follow-up dates are set
- `src/components/dashboard/followups-widget.tsx` — dashboard "Follow-ups" widget; reschedule control also uses `FollowUpDateTimeInput`

### API Routes
- `GET|POST /api/leads` — list (paginated, filtered) + create. `GET` runs a separate priority query across the *entire* filtered set to find overdue/due-today follow-ups and merges them to the front of the page (see "Sort order in the list" below) — not just a re-sort of the fetched page.
- `GET|PATCH|DELETE /api/leads/[id]` — read, update, hard-delete (admin only)
- `POST /api/leads/[id]/archive` — soft-disable / re-enable
- `GET|POST /api/leads/[id]/activities` — activity timeline; logging an activity with a `follow_up_date` calls `createReminderEvent()` (Google Calendar sync) instead of sending an immediate email
- `GET /api/leads/followup-summary` — unfiltered `{ overdue, due_today }` counts across all non-archived leads, powering `OverdueFollowupBanner`
- `GET|POST|PATCH|DELETE /api/leads/[id]/contacts` — extra contact points
- `GET|POST /api/leads/[id]/proposals` — proposals for this lead
- `POST /api/leads/[id]/id-proof` — upload ID proof document
- `GET /api/leads/[id]/billing-summary` — lifetime/FY revenue snapshot
- `GET /api/leads/[id]/feedbacks` — booking feedback for this lead
- `POST /api/leads/import` — CSV bulk import (admin/manager only)
- `GET|POST /api/lead-cautions` — list and create cautions
- `PATCH /api/lead-cautions/[id]` — dismiss/edit a caution
- `POST /api/public/enquiry` — unauthenticated public form submission (creates lead or re-enquiry activity)
- `PATCH /api/activities/[id]` — reschedule/complete a follow-up; on reschedule, resets `followup_wa_reminder_sent_at` to `null` and calls `rescheduleReminderEvent()` (or atomically claims-and-creates a calendar event if one doesn't exist yet)
- `GET /api/cron/lead-reminder-digest` — daily cron (9:00 AM IST / `30 3 * * *` UTC), `CRON_SECRET`-protected; emails each activity owner a single grouped list of their follow-ups due today or overdue
- `GET /api/cron/lead-reminder-whatsapp` — every 5 minutes, `CRON_SECRET`-protected; sends a WhatsApp nudge via MSG91 template `lead_followup_reminder` ~10 minutes before a follow-up is due

### Lib Files
- `src/lib/auto-status.ts` — `autoUpdateLeadStatus()` — automatic status advancement triggered by activities, proposals, and contract activation
- `src/lib/validations.ts` — `createLeadSchema`, `updateLeadSchema`, `importLeadSchema`
- `src/lib/zoho-field-mapping.ts` — CSV row transformer (Zoho CRM export format → internal schema)
- `src/lib/constants.ts` — all lead status/source/rating/score constants, `SYSTEM_LEAD_STATUSES`, `MANUAL_LEAD_STATUSES`, `LOST_REASONS`, `ENTITY_TYPES`, `DOCUMENT_CHECKLISTS`
- `src/lib/whatsapp.ts` — `messaging.internalNewLead()` — fired on every manual lead create; also home of `sendWhatsApp()` used by the follow-up WhatsApp nudge cron
- `src/lib/google-calendar.ts` — `createReminderEvent()`, `rescheduleReminderEvent()`, `isWorkspaceEmail()` — Google Calendar domain-wide-delegation sync for lead follow-up reminders on the activity owner's own calendar. Scoped to `theworkvilla.com` / `chordia.co` / `chordia.asia` Workspace accounts (via `GOOGLE_CALENDAR_SA_EMAIL` / `GOOGLE_CALENDAR_SA_PRIVATE_KEY`); non-Workspace owners are skipped and rely on the daily digest email instead. Events are created popup-only (no `email` reminder override) to avoid duplicating the digest.

### Hooks
- `src/hooks/use-leads.ts` — `useLeads(options)`, `useLead(id)`, `useUsers()`

### Providers
- `src/providers/enquiry-notifications-provider.tsx` — real-time enquiry count + pinned cards for unread form leads and re-enquiries; wraps dashboard layout

---

## Data Model

### Table: `leads`

Primary table. RLS enabled.

| Column | Type | Constraints / Notes |
|---|---|---|
| `id` | UUID | PK, `uuid_generate_v4()` |
| `lead_number` | INTEGER | NOT NULL, UNIQUE, sequence `leads_number_seq` (starts 1001); added migration 00210 |
| `first_name` | VARCHAR(255) | NOT NULL |
| `last_name` | VARCHAR(255) | NOT NULL |
| `company` | VARCHAR(255) | nullable |
| `aggregator_contact_name` | VARCHAR(255) | nullable — name of the aggregator/broker who referred |
| `email` | VARCHAR(255) | nullable (optional per schema); used for dedup in CSV import |
| `phone` | VARCHAR(20) | nullable; also used for phone_exact lookup |
| `mobile` | VARCHAR(20) | nullable |
| `website` | VARCHAR(500) | nullable |
| `title` | VARCHAR(255) | nullable — job title |
| `secondary_email` | VARCHAR(255) | nullable |
| `status` | `lead_status` enum | DEFAULT `'new'` |
| `source` | `lead_source` enum | DEFAULT `'other'` |
| `industry` | VARCHAR(255) | nullable |
| `no_of_employees` | INTEGER | nullable |
| `rating` | `lead_rating` enum | DEFAULT `'none'` |
| `score` | INTEGER | DEFAULT 0; CHECK `score >= 0 AND score <= 100` |
| `workspace_type` | `workspace_type` enum | nullable |
| `seat_capacity` | INTEGER | nullable |
| `preferred_location` | VARCHAR(255) | nullable (free text) |
| `location_id` | UUID | nullable FK → `locations(id)` ON DELETE SET NULL; added migration 00006 |
| `working_hours` | VARCHAR(255) | nullable |
| `budget_per_seat` | DECIMAL(12,2) | nullable |
| `pan_number` | VARCHAR(20) | nullable; added migration 00007 |
| `gst_number` | VARCHAR(20) | nullable; added migration 00063 |
| `entity_type` | TEXT | nullable; enum-like but stored as TEXT; values: `individual`, `proprietorship`, `partnership`, `llp`, `pvt_ltd`, `public_ltd`, `trust`, `society`, `huf`, `other`; added migration 00061 |
| `id_proof_path` | TEXT | nullable; Backblaze B2 path; added migration 00087 |
| `id_proof_uploaded_at` | TIMESTAMPTZ | nullable; added migration 00087 |
| `street` | VARCHAR(500) | nullable |
| `city` | VARCHAR(255) | nullable |
| `state` | VARCHAR(255) | nullable |
| `zip_code` | VARCHAR(20) | nullable |
| `country` | VARCHAR(255) | nullable |
| `enquiry_form_google` | TEXT | nullable — URL of original Google form submission |
| `enquiry_form_direct` | TEXT | nullable — URL of original direct form submission |
| `description` | TEXT | nullable — free-text brief or lost reason notes |
| `tags` | TEXT[] | DEFAULT `'{}'`; indexed with GIN; used to mark form origin (`google-ads-form`, `meta-ads-form`, `walkin-form`) |
| `assigned_to` | UUID | nullable FK → `users(id)` ON DELETE SET NULL; FK name `leads_assigned_to_fkey` |
| `created_by` | UUID | nullable FK → `users(id)` ON DELETE SET NULL |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() |
| `updated_at` | TIMESTAMPTZ | auto-updated by trigger |
| `converted_at` | TIMESTAMPTZ | nullable; set when status→`won` (auto by API) |
| `lost_at` | TIMESTAMPTZ | nullable; set when status→`lost` (auto by API) |
| `lost_reason` | TEXT | nullable; one of the `LOST_REASONS` values (not a DB constraint, enforced by Zod) |
| `archived_at` | TIMESTAMPTZ | nullable; soft-disable; added migration 00209 |
| `archived_by` | UUID | nullable FK → `users(id)` ON DELETE SET NULL; added migration 00209 |
| `archive_reason` | TEXT | nullable; added migration 00209 |
| `search_vector` | TSVECTOR | auto-updated by trigger `leads_search_vector_update` from first_name, last_name, email, phone, company, tags |

#### Indexes on `leads`
- `idx_leads_status` — `(status)`
- `idx_leads_source` — `(source)`
- `idx_leads_assigned_to` — `(assigned_to)`
- `idx_leads_created_at` — `(created_at DESC)`
- `idx_leads_search` — GIN on `search_vector`
- `idx_leads_tags` — GIN on `tags`
- `idx_leads_archived_at` — `(archived_at)`
- `leads_lead_number_unique` — UNIQUE constraint

#### RLS Policies (leads table)
- `auth_read` — SELECT for any authenticated user (`auth.uid() IS NOT NULL`)
- `auth_insert` — INSERT for any authenticated user
- `auth_update` — UPDATE for any authenticated user
- DELETE is only via service role / admin-gated API (no DELETE RLS policy for anon)

#### Cascade Delete Chain
Hard delete on a lead cascades to:
- `proposals` (lead_id → CASCADE) → `contracts.proposal_id` → SET NULL
- `contracts` (lead_id → CASCADE) → `billing_statements` → CASCADE
- `contracts` → `usage_charges` → CASCADE
- `activities` (lead_id → CASCADE)
- `lead_contacts` (lead_id → CASCADE)
- `lead_cautions` (lead_id → CASCADE)
- `documents` / `lead_documents` (lead_id → CASCADE)
- `tasks` (lead_id → CASCADE)
This cascade is intentionally destructive — see "Soft-Disable vs Hard Delete" below.

---

### Table: `activities`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `lead_id` | UUID | NOT NULL FK → `leads(id)` ON DELETE CASCADE |
| `type` | `activity_type` enum | `call`, `meeting`, `note`, `email`, `tour` |
| `subject` | VARCHAR(500) | optional |
| `description` | TEXT | optional |
| `call_duration_seconds` | INTEGER | optional |
| `call_outcome` | `call_outcome` enum | `connected`, `no_answer`, `voicemail`, `busy`, `wrong_number`, `callback_scheduled` |
| `meeting_location` | VARCHAR(255) | optional |
| `meeting_start_at` | TIMESTAMPTZ | optional |
| `meeting_end_at` | TIMESTAMPTZ | optional; used to determine tour_completed vs tour_scheduled |
| `follow_up_date` | TIMESTAMPTZ | optional |
| `follow_up_notes` | TEXT | optional |
| `is_follow_up_done` | BOOLEAN | DEFAULT false |
| `follow_up_actioned_by` | UUID | FK → `users(id)`; added migration 00031 |
| `follow_up_actioned_at` | TIMESTAMPTZ | added migration 00031 |
| `calendar_event_id` | TEXT | nullable; Google Calendar event ID for the synced follow-up reminder, so reschedule updates the same event instead of creating a duplicate; added migration 00355 |
| `followup_wa_reminder_sent_at` | TIMESTAMPTZ | nullable; guard column for the WhatsApp nudge cron — set atomically (`UPDATE ... WHERE followup_wa_reminder_sent_at IS NULL`) before sending so overlapping cron runs can't double-send; reset to `null` on reschedule; added migration 00356 |
| `created_by` | UUID | FK → `users(id)` ON DELETE SET NULL |
| `created_at` / `updated_at` | TIMESTAMPTZ | auto-managed |

Partial index: `idx_activities_follow_up` on `(follow_up_date)` WHERE `follow_up_date IS NOT NULL AND is_follow_up_done = false` — used to compute follow-up flags efficiently.

---

### Table: `lead_contacts`

Multiple named contacts per lead (migration 00141).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `lead_id` | UUID | NOT NULL FK → `leads(id)` ON DELETE CASCADE |
| `full_name` | TEXT | NOT NULL |
| `designation` | TEXT | optional |
| `email` / `phone` / `mobile` | TEXT | optional |
| `contact_role` | TEXT | NOT NULL DEFAULT `'general'`; CHECK constraint: `primary`, `finance`, `occupant`, `signatory`, `escalation`, `it`, `general` |
| `notes` | TEXT | optional |
| `is_active` | BOOLEAN | NOT NULL DEFAULT true |
| `created_by` | UUID | FK → `users(id)` |
| `created_at` / `updated_at` | TIMESTAMPTZ | auto-managed |

RLS: authenticated users can SELECT, INSERT, UPDATE, DELETE.

---

### Table: `lead_cautions`

Warnings/alerts attached to a lead (migration 00133).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `lead_id` | UUID | NOT NULL FK → `leads(id)` ON DELETE CASCADE |
| `booking_id` | UUID | nullable FK → `bookings(id)` ON DELETE SET NULL; set when auto-created from booking cancellation |
| `note` | TEXT | NOT NULL |
| `severity` | `lead_caution_severity` enum | `info`, `warning`, `danger`; NOT NULL DEFAULT `'warning'` |
| `is_active` | BOOLEAN | NOT NULL DEFAULT true; soft-dismiss only, record stays |
| `created_by` | UUID | FK → `users(id)` ON DELETE SET NULL |
| `dismissed_by` | UUID | FK → `users(id)` ON DELETE SET NULL |
| `dismissed_at` | TIMESTAMPTZ | nullable |
| `created_at` / `updated_at` | TIMESTAMPTZ | auto-managed |

Partial index: `idx_lead_cautions_lead_active` on `(lead_id, severity, created_at DESC)` WHERE `is_active = TRUE`.

RLS: authenticated users can SELECT, INSERT, UPDATE (no DELETE policy — cautions are permanent for audit).

---

## Status Lifecycles

### Lead Status State Machine

DB enum `lead_status`:
```
new → contacted → tour_scheduled → tour_completed → proposal_sent → negotiating → won
                                                                               ↘ lost
                                                                               ↘ junk
```

`junk` added in migration 00233. It is a terminal state (spam / duplicate / invalid contact).

| Status | String value | How set |
|---|---|---|
| New | `new` | Default on create |
| Contacted | `contacted` | Auto: first non-tour activity logged (from `new`) |
| Tour Scheduled | `tour_scheduled` | Auto: tour activity logged with future/no end date |
| Tour Completed | `tour_completed` | Auto: tour activity with `meeting_end_at` in the past |
| Proposal Sent | `proposal_sent` | Auto: proposal created for this lead |
| Negotiating | `negotiating` | Manual only (sales rep) |
| Won | `won` | Auto: contract activated for this lead; sets `converted_at` |
| Lost | `lost` | Manual only; sets `lost_at`; requires `lost_reason` (Zod optional but UI shows it) |
| Junk | `junk` | Manual only; for spam/duplicate/invalid leads |

#### System vs Manual Statuses
- **`SYSTEM_LEAD_STATUSES`** (from `src/lib/constants.ts`): `tour_scheduled`, `tour_completed`, `proposal_sent`, `won` — these are removed from the edit form dropdown. Sales reps cannot set these manually.
- **`MANUAL_LEAD_STATUSES`**: `new`, `contacted`, `negotiating`, `lost`, `junk` — settable in the edit form.

#### Auto-Advance Rules (`src/lib/auto-status.ts`)
The function `autoUpdateLeadStatus(supabase, leadId, trigger, options)` is called server-side and **never downgrades**:

| Trigger | Condition | Target Status |
|---|---|---|
| `"activity"` (non-tour) | current is `new` | `contacted` |
| `"tour"` | `meeting_end_at` in future or absent | `tour_scheduled` (if current index < 2) |
| `"tour"` | `meeting_end_at` in the past | `tour_completed` (if current index < 3) |
| `"proposal"` | current index < 4 | `proposal_sent` |
| `"contract"` | current not `won` or `lost` | `won` + sets `converted_at` |

---

## Business Rules (Hard — Never Violate)

1. **Hard delete is admin-only.** All other roles must use `POST /api/leads/[id]/archive` (soft-disable). The UI shows a "Delete" button only when `userRole === "admin"`.

2. **Auto-status is one-way.** `autoUpdateLeadStatus` checks the current status index before writing. It will never revert a lead from `proposal_sent` back to `contacted` etc.

3. **`won` is set only via contract activation.** The PATCH route does set `converted_at` if the incoming status is `won`, but the canonical path is the contract activation trigger calling `autoUpdateLeadStatus(..., "contract")`.

4. **`lost_at` is set only via status transition.** The PATCH handler sets `lost_at = new Date().toISOString()` when the body includes `status: "lost"` and no explicit `lost_at` is provided.

5. **`junk` is a terminal status** in the UI — no automatic transitions away from it. A lead marked junk remains visible when `showDisabled` is false but is filtered out of active pipeline views.

6. **Public enquiry endpoint deduplicates by phone + email.** `POST /api/public/enquiry` checks `phone.eq OR mobile.eq OR email.eq` before inserting. A returning phone/email adds a `note` activity to the existing lead instead of creating a duplicate.

7. **WhatsApp notification fires on every manual lead create** (not on imports, not on public form submits). The `POST /api/leads` handler fires `messaging.internalNewLead()` to all users with a phone number — fire-and-forget, never blocks.

8. **Email + push notification fires on every public enquiry** (new and re-enquiry) to all admin/manager emails + `space@theworkvilla.com`.

9. **Follow-up reminders do NOT email immediately on log/reschedule.** That per-activity email was removed — reminders now go out only via the 9:00 AM IST daily digest cron (`/api/cron/lead-reminder-digest`) and the 5-minute WhatsApp nudge cron (`/api/cron/lead-reminder-whatsapp`), plus an optional Google Calendar sync for Workspace-domain owners. Do not reintroduce a synchronous send-on-log email.

10. **The WhatsApp nudge cron only ever matches strictly-future follow-ups** (`follow_up_date` in `(now, now+10min]`). It never backfills the existing overdue backlog — that's the daily digest's job. Do not widen this window without re-reading the anti-spam comment in `src/app/api/cron/lead-reminder-whatsapp/route.ts`; the very first run after a bad change would WhatsApp-blast every already-overdue reminder at once.

11. **`lead_number` is never reused.** The sequence `leads_number_seq` increments even if a lead is deleted. The sequence starts at 1001.

12. **Cautions are never hard-deleted.** `PATCH /api/lead-cautions/[id]` only sets `is_active=false` (soft-dismiss). There is no DELETE API for cautions.

---

## Validation Rules

All enforced server-side by Zod (`src/lib/validations.ts`) unless noted.

### `createLeadSchema` (POST /api/leads)
| Field | Rule | Enforcement |
|---|---|---|
| `first_name` | `min(1)` required | Server (Zod) + DB NOT NULL |
| `last_name` | `min(1)` required | Server (Zod) + DB NOT NULL |
| `email` | `min(1)` + `.email()` — **required, must be valid email** | Server (Zod) |
| `mobile` | `min(1)` required | Server (Zod) |
| `website` | `.url()` OR empty string (transforms to undefined) | Server (Zod) |
| `secondary_email` | `.email()` OR empty string | Server (Zod) |
| `gst_number` | regex `/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/` OR empty string | Server (Zod) |
| `score` | integer, 0–100 | Server (Zod) + DB CHECK |
| `no_of_employees` | positive integer | Server (Zod) |
| `seat_capacity` | positive integer | Server (Zod) |
| `budget_per_seat` | positive number | Server (Zod) |
| `location_id` | UUID or empty string (transforms to undefined) | Server (Zod) |
| `entity_type` | one of 10 values or null | Server (Zod) |
| `status` | full enum including system statuses | Server (Zod) |
| `source` | full source enum | Server (Zod) |
| `rating` | `none \| hot \| warm \| cold` | Server (Zod) |
| `tags` | array of strings | Server (Zod) |

**GOTCHA:** `email` is **required** in `createLeadSchema` (`.min(1, "Email is required").email()`). The public enquiry endpoint does NOT use this schema — it inserts directly with `email: normalisedEmail || null`. The import schema (`importLeadSchema`) makes email optional. So the strictness differs between routes.

### `updateLeadSchema`
`createLeadSchema.partial()` — all fields optional in a PATCH.

### `importLeadSchema`
- `email` optional (`.email().optional().or(z.literal(""))`)
- `mobile` optional
- `status` defaults to `"new"`
- `source` defaults to `"other"`
- `rating` defaults to `"none"`
- `score` defaults to `0`
- `tags` defaults to `[]`

### Public Enquiry (`/api/public/enquiry`)
Server-side validation (no Zod):
- `name` non-empty string
- `mobile` non-empty string; normalized to 10 digits; regex `/^[6-9]\d{9}$/` (Indian mobile)
- Honeypot field `hp_field` — if truthy, silently return success without DB write

---

## Role Permissions

| Action | Allowed Roles |
|---|---|
| View leads list | All authenticated |
| View lead detail | All authenticated |
| Create lead | All authenticated |
| Edit lead | All authenticated |
| Hard-delete lead | `admin` only |
| Soft-disable / re-enable lead | `admin`, `manager` |
| Log Print Usage (from lead detail) | `admin`, `accounts`, `manager` |
| Create caution manually | `admin`, `manager`, `floor_manager` |
| Dismiss/edit caution | `admin`, `manager`; or `floor_manager` who created it |
| CSV import | `admin`, `manager` |
| Upload ID proof | All authenticated (any role, no explicit gate in route) |

---

## Integration Points with Other Modules

### → Proposals
- `POST /api/leads/[id]/proposals` creates a proposal; triggers `autoUpdateLeadStatus(..., "proposal")` → sets lead to `proposal_sent`
- `GET /api/leads/[id]/proposals` returns all proposals for this lead
- `LeadProposalsTab` shows and links to proposals

### → Contracts
- Contracts carry `lead_id`; contract activation calls `autoUpdateLeadStatus(..., "contract")` → sets lead to `won`
- `LeadContractsTab` shows and links to contracts

### → Bookings
- Bookings carry `lead_id`; the new-booking flow does a `phone_exact` lookup (`GET /api/leads?phone_exact=...`) to pre-fill lead info
- Booking cancellation with reason `suspected_fake_booking` auto-creates a `danger` severity caution on the lead
- `lead_cautions` with `danger` severity block new booking creation until explicitly acknowledged
- `LeadFeedbacksTab` pulls `booking_feedbacks` linked to this lead

### → Billing / Finance
- `LeadBillingSnippet` (`GET /api/leads/[id]/billing-summary`) aggregates `booking_payments` + `contract_payments` for lifetime and FY views
- Print usage can be manually logged from the lead detail page (roles: admin, accounts, manager) via `ManualPrintEntryDialog`

### → Activities (cross-module)
- The dashboard `/api/dashboard/recent-leads` and `/api/dashboard/lead-funnel` aggregate leads data for KPI widgets
- `EnquiryNotificationsProvider` subscribes to Supabase realtime on the `leads` and `activities` tables to surface incoming enquiries live

### → KYC / Documents
- `entity_type` on a lead drives the KYC checklist shown in the Overview tab (constant `DOCUMENT_CHECKLISTS` in `src/lib/constants.ts`)
- `LeadDocumentsTab` manages file attachments; `id_proof_path` stores a single primary ID proof in Backblaze B2 at `leads/{id}/id_proof_{timestamp}.{ext}`

---

## Known Pitfalls and Gotchas

1. **`email` is required in the manual create form but optional in the DB and import.** When building features that create leads programmatically, do not assume `email` is always present. Use `lead.email || null` guards.

2. **`tags` can be `null` in legacy rows despite DB default `'{}'`.** The `GET /api/leads/[id]` route explicitly patches: `if (data) data.tags = data.tags ?? [];`. Do not assume `tags` is always an array in client code — guard with `lead.tags ?? []`.

3. **`_followup` is a computed virtual field, not a DB column.** The API attaches `_followup: { overdue, due_today, upcoming }` only if there are pending follow-up activities. It will be `undefined` or `null` if none exist. Do not look for it in the DB.

4. **Search by ID with `#` prefix.** `GET /api/leads?search=#uuid` does an exact `id` match instead of full-text. This is undocumented in the UI but used programmatically.

5. **Sort order in the list.** `GET /api/leads` runs a separate `activities` query across the *entire* filtered set (not just the current page) to find every lead with an overdue or due-today follow-up, then merges that priority list to the front of the paginated results — so an overdue follow-up always surfaces on page 1 even if it belongs to a lead created months ago. Leads outside that priority set are fetched as a second, normal paginated query (excluding the priority IDs) and are sorted with `upcoming`-followup leads floated ahead of no-followup leads within that remainder. The client page then re-sorts again client-side to put new form leads (status=`new` + `FORM_TAGS`) first, then re-enquiries. The three sort passes (server priority merge, server remainder sort, client re-sort) are independent.

6. **`archived_at` is excluded by default.** `GET /api/leads` adds `.is("archived_at", null)` unless `include_archived=true`. This means archived leads are invisible in all normal queries including follow-up computations. Pass `include_archived=true` explicitly if you need to see them.

7. **Hard delete cascades deeply.** Deleting a lead destroys proposals, contracts, billing statements, usage charges, activities, tasks, documents, cautions, contacts — all without a confirmation from the DB level. The API route is rightly admin-only. The error message says "Use Disable instead."

8. **`lead_number` starts at 1001** (not 1). The sequence was introduced after the database had existing rows, so those were backfilled in `created_at` order. New rows get the next sequence value.

9. **GST number regex is enforced only by Zod, not at DB level.** The DB column is `VARCHAR(20)` with no CHECK constraint. A direct Supabase insert bypasses this. The regex: `/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/`.

10. **Public enquiry only checks `phone` column for dedup, not `mobile`.** The dedup query is:
    ```
    .or(`phone.eq.${normalisedMobile},mobile.eq.${normalisedMobile}`)
    ```
    This means a re-submitter whose number is stored in `mobile` (not `phone`) will be correctly detected as returning. However, if both fields differ between the submission and the stored record, they may slip through as a new lead.

11. **WhatsApp notification on manual create is fire-and-forget.** If MSG91 is misconfigured, the lead is still saved and the error is only logged to `console.error`. No retry, no alerting.

12. **Auto-status never fires for `junk`.** The `autoUpdateLeadStatus` function's `STATUS_ORDER` array does not include `junk`. Setting a lead to `junk` must be done manually and stays sticky.

13. **`lost` can be set manually even if a contract exists.** There is no gate preventing marking a lead as `lost` if it already has an active contract. The two are independent.

14. **Activity `meeting_attendees` and `meeting_minutes` tables exist** (from initial schema) but their management UI is not surfaced in the current lead detail page's activity form — they are referenced in `src/types/index.ts` but the detail UI does not render them.

15. **All three follow-up date/time pickers block submit on "incomplete".** `FollowUpDateTimeInput` (`src/components/shared/followup-datetime-input.tsx`) reports `"empty" | "incomplete" | "valid"` via `onStatusChange`; the Log Activity dialog, dashboard Follow-ups widget, and lead timeline reschedule all disable their submit/confirm button while status is `"incomplete"` (date picked but no time, or vice versa) rather than silently defaulting the time to midnight the way the old native `datetime-local` input did.

16. **Google Calendar sync is best-effort and silently skipped, never blocking.** `createReminderEvent()`/`rescheduleReminderEvent()` return `null` (never throw) if the owner's email isn't on `theworkvilla.com`/`chordia.co`/`chordia.asia`, if `GOOGLE_CALENDAR_SA_EMAIL`/`GOOGLE_CALENDAR_SA_PRIVATE_KEY` aren't configured, or if the Calendar API call fails — the activity is still logged either way. Non-Workspace owners rely solely on the daily digest email and WhatsApp nudge.

---

## Environment / Config Dependencies

No feature flags or `app_settings` table keys are specific to the Leads module. All dependencies are standard:

| Dependency | What it enables |
|---|---|
| `MSG91_AUTH_KEY`, `MSG91_WHATSAPP_SENDER` | WhatsApp staff notification on manual lead create; also the transport for the follow-up WhatsApp nudge cron (MSG91 template `lead_followup_reminder`) |
| `RESEND_API_KEY` | Email notification on public enquiry form submission; also the transport for the daily follow-up reminder digest (`/api/cron/lead-reminder-digest`) |
| `NEXT_PUBLIC_APP_URL` / `APP_URL` | CRM deep-link in email/push alerts, the reminder digest email, the WhatsApp nudge message, and synced Google Calendar event descriptions |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENDPOINT` | ID proof file upload to Backblaze B2 |
| `GOOGLE_CALENDAR_SA_EMAIL`, `GOOGLE_CALENDAR_SA_PRIVATE_KEY` | Domain-wide-delegation service account for syncing lead follow-up reminders to the activity owner's own Google Calendar (`src/lib/google-calendar.ts`); only applies to `theworkvilla.com`/`chordia.co`/`chordia.asia` Workspace accounts, skipped otherwise |
| `CRON_SECRET` | Authorizes `/api/cron/lead-reminder-digest` (daily, 9:00 AM IST) and `/api/cron/lead-reminder-whatsapp` (every 5 minutes) |
| Supabase Realtime | `EnquiryNotificationsProvider` subscribes to `leads` and `activities` tables for live enquiry banners |

---

## Key User Flows

### 1. New Manual Lead
1. User clicks "Create Lead" → `/leads/new`
2. `LeadForm` renders with defaults: `status="new"`, `source="online_form"`, `rating="none"`, `score=0`, `country="India"`
3. Required fields: `first_name`, `last_name`, `email`, `mobile`
4. On submit → `POST /api/leads` → Zod validation → insert → `logAudit` → WhatsApp to all staff
5. Redirect to `/leads/{id}`

### 2. Public Enquiry Form Submission
1. External form POSTs to `POST /api/public/enquiry` (no auth)
2. Honeypot check — if `hp_field` truthy, silently return success
3. Phone normalisation (strips country code, leading 0)
4. Dedup check by phone + email
5. **New lead**: insert with `tags: [sourceTag]`, `status: "new"`, fire email + push alert
6. **Returning**: insert `note` activity on existing lead with full enquiry summary, fire email + push alert
7. `EnquiryNotificationsProvider` picks up the realtime insert and shows a pinned card on the leads list

### 3. Logging a Tour Activity
1. From lead detail → Quick Log → Tour, or Activities tab → Log Activity (type=`tour`)
2. `POST /api/leads/[id]/activities` → Zod validation → insert activity
3. API calls `autoUpdateLeadStatus(supabase, id, "tour", { meetingEndAt })`
4. If `meeting_end_at` is in the past → status → `tour_completed`; else → `tour_scheduled`

### 4. Marking a Lead as Lost
1. `/leads/[id]/edit` → status dropdown (shows only `MANUAL_LEAD_STATUSES`) → select `lost`
2. `lost_reason` dropdown appears (required in UI intent, optional in Zod)
3. On save → `PATCH /api/leads/[id]` → API sets `lost_at = now()`
4. Edit page also auto-logs a `note` activity if the lead wasn't already `lost` and `description` is non-empty

### 5. Soft-Disabling a Lead
1. From lead detail → Edit → `POST /api/leads/[id]/archive` with `{ archived: true, reason: "..." }`
2. Sets `archived_at`, `archived_by`, `archive_reason`
3. Lead disappears from list unless `showDisabled` toggle is on
4. Lead can be re-enabled: `POST /api/leads/[id]/archive` with `{ archived: false }`

### 6. CSV Import
1. List page → "Import CSV" → `ImportLeadsDialog`
2. `POST /api/leads/import` (admin/manager only, 10 MB max, `.csv` only)
3. Rows parsed with PapaParse, transformed via `transformZohoRow()` (Zoho CRM export format)
4. Validated with `importLeadSchema` (relaxed — email optional, defaults for status/source/rating/score)
5. Dedup by email (case-insensitive); existing emails are skipped (counted as `skipped`)
6. Bulk insert in batches of 100; fallback to row-by-row on batch failure
7. Returns `{ total, imported, skipped, errors[], warnings[] }` (errors capped at 50)
8. Audit logged as a single `"create"` entry with import summary

### 7. Adding a Lead Caution
1. From lead detail overview → `LeadCautionsBanner` → "Add Caution" button (admin/manager/floor_manager)
2. `POST /api/lead-cautions` with `{ lead_id, note, severity: "info"|"warning"|"danger" }`
3. Active cautions surface on the lead profile banner and in the new-booking flow when the phone matches
4. `danger` severity requires explicit staff acknowledgement before proceeding with a new booking
5. Dismiss: `PATCH /api/lead-cautions/{id}` with `{ is_active: false }` — sets `dismissed_by`, `dismissed_at`

### 8. Setting or Rescheduling a Follow-Up Reminder
1. Date + time are picked via `FollowUpDateTimeInput` — a plain date input plus a dropdown of fixed 30-min slots from 9:00 AM to 8:00 PM (no native OS picker, no silent midnight default); submit/confirm is disabled while only one side is picked
2. The Log Activity dialog additionally shows a live "What happens when you log this" preview summarizing the activity, call outcome, follow-up time, and the actual reminder channels
3. On log (`POST /api/leads/[id]/activities`) or reschedule (`PATCH /api/activities/[id]`) with a `follow_up_date`, the API calls `createReminderEvent()` / `rescheduleReminderEvent()` (`src/lib/google-calendar.ts`) — creates or updates a popup-only event on the owner's own Google Calendar if their email is on a Workspace domain; silently skipped otherwise
4. Reschedule also resets `followup_wa_reminder_sent_at` to `null` so the WhatsApp cron sends exactly one fresh nudge at the new time
5. **No immediate email is sent.** Reminders surface later via two crons: `/api/cron/lead-reminder-digest` (daily 9:00 AM IST, one grouped email per owner listing everything due today or overdue) and `/api/cron/lead-reminder-whatsapp` (every 5 minutes, WhatsApp nudge via MSG91 template `lead_followup_reminder` ~10 minutes before a strictly-future follow-up is due, claimed atomically to prevent double-sends)
6. The Leads list additionally surfaces overdue items directly: `OverdueFollowupBanner` shows an "N overdue follow-ups" banner (from `GET /api/leads/followup-summary`) with a "Review now" link that clears all list filters, and `GET /api/leads` itself merges every overdue/due-today lead across the whole filtered set to the front of page 1

---

## Lead Status Color Map

From `LEAD_STATUS_COLORS` in `src/lib/constants.ts`:

| Status | Tailwind classes |
|---|---|
| `new` | `bg-gray-100 text-gray-800` |
| `contacted` | `bg-blue-100 text-blue-800` |
| `tour_scheduled` | `bg-purple-100 text-purple-800` |
| `tour_completed` | `bg-indigo-100 text-indigo-800` |
| `proposal_sent` | `bg-yellow-100 text-yellow-800` |
| `negotiating` | `bg-orange-100 text-orange-800` |
| `won` | `bg-green-100 text-green-800` |
| `lost` | `bg-red-100 text-red-800` |
| `junk` | `bg-zinc-100 text-zinc-500` |

## Lead Sources

Enum values for `lead_source` (DB type), matched to `LEAD_SOURCES`/`LEAD_SOURCE_LABELS`:

| Value | Label |
|---|---|
| `meta_ads` | Meta Ads |
| `google_ads` | Google Ads |
| `direct_walkin` | Direct/Walk-in |
| `online_form` | Online Form |
| `referral` | Referral |
| `social_media` | Social Media |
| `advertisement` | Advertisement |
| `cold_call` | Cold Call |
| `event` | Event |
| `partner` | Partner |
| `other` | Other |

`google_ads` was added in migration 00016 (not in initial enum).

## Lead Scores

Fixed picklist (`LEAD_SCORES`): `0`, `25`, `50`, `75`, `100`

| Value | Short Label |
|---|---|
| 0 | Not Scored |
| 25 | Cold |
| 50 | Warm |
| 75 | Hot |
| 100 | Very Hot |

## Real-Time Enquiry Notification Tags

Leads created by public form have these specific tag values (used to identify "unread form leads"):

| Tag | Source |
|---|---|
| `google-ads-form` | Google Ads form submissions |
| `meta-ads-form` | Meta Ads form submissions |
| `walkin-form` | Direct walk-in form |

An "unread form lead" = `status === "new"` AND `tags` contains at least one of these values. These are pinned at the top of the leads list with a pulsing green indicator.

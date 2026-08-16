# Gmail inbound intake

Status: **not enabled.** Phase 1 (hardening + shadow mode) is implemented; the
pipeline has never processed a message in production.

## What it does

Mail sent to `cases@theworkvilla.com` is watched via a Gmail Pub/Sub push
subscription. Each new message is matched to an aggregator by sender domain,
parsed by Claude, and — once auto-creation is enabled — turned into a case with
its document checklist and compliance checks.

| Piece | Where |
|---|---|
| Gmail client + history API | `src/lib/gmail.ts` |
| Push authentication | `src/lib/gmail-push-auth.ts` |
| Webhook | `src/app/api/email/inbound/route.ts` |
| Watch setup / status | `src/app/api/email/watch/route.ts` |
| Daily watch renewal | `src/app/api/cron/gmail-watch-renew/route.ts` |
| AI extraction | `src/lib/email-parser.ts` |
| Shadow-mode log | `gmail_intake_log` (migration 00425) |

## Why it was dormant

It shipped in Feb 2026 with the Cases module but was never switched on: no
`GMAIL_*` variables in any Vercel environment, no `gmail_history_id` in
`app_settings`, and zero rows in `case_emails`. All 21 aggregators already have
`email_domain` populated, so the matching data was prepared — only the
activation was missed. There is no UI that starts the watch, so the step was
easy to forget, and nothing renders `case_emails`, so its absence was invisible.

## Shadow mode

`app_settings.gmail_auto_case_creation_enabled` defaults to `'false'`. While
off, every message is still fetched, matched and parsed, and the outcome is
written to `gmail_intake_log` with `dry_run = true` and an action of
`would_create_case` / `would_append_to_thread` / `skipped_no_aggregator` /
`skipped_incomplete`. **No row is written to `cases`.**

This exists so the parser's first contact with real mail cannot create rows in a
live Cases module (57 real cases at the time of writing). Review the log, then
enable.

`gmail_intake_log` holds AI-extracted client PII (name, PAN, GST, phone,
address) and is therefore admin-only under RLS.

## Enabling — order matters

1. **Google Cloud**
   - OAuth client (Web) → obtain a refresh token for `cases@theworkvilla.com`
     with scopes `gmail.readonly`, `gmail.send`, `gmail.modify`.
   - Pub/Sub topic, e.g. `projects/<project>/topics/gmail-notifications`.
   - Grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher**
     role on that topic, or Gmail cannot publish to it.
   - A service account for push auth, e.g. `gmail-push@<project>.iam.gserviceaccount.com`.
   - Push subscription to `https://twv-crm.vercel.app/api/email/inbound` with:
     ```
     --push-auth-service-account=gmail-push@<project>.iam.gserviceaccount.com
     --push-auth-token-audience=https://twv-crm.vercel.app/api/email/inbound
     ```
   - Set a **dead-letter topic** and retry policy. The webhook now returns 503
     when Gmail's history API fails, so Pub/Sub retries; without a dead letter
     a permanently failing message retries indefinitely.

2. **Vercel env** (Production + Preview): `GMAIL_CLIENT_ID`,
   `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_WATCH_EMAIL`,
   `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUBSUB_AUDIENCE`, `GMAIL_PUBSUB_SA_EMAIL`.

   Until the last two are set, `/api/email/inbound` rejects everything. That is
   deliberate — it fails closed.

3. **Start the watch.** There is no UI for this; POST as an admin:
   ```
   POST /api/email/watch
   ```
   `GET` on the same route reports current status and expiry.

4. **Leave it in shadow mode** for a representative sample of real mail. Then
   review:
   ```sql
   SELECT action, count(*), avg(ai_confidence)
   FROM gmail_intake_log
   WHERE dry_run
   GROUP BY action;
   ```
   Inspect `parsed` on a handful of `would_create_case` rows against the source
   emails before trusting it.

5. **Enable auto-creation** (Phase 3) — ideally for one or two aggregator
   domains first rather than all 21:
   ```sql
   UPDATE app_settings SET value = 'true'
   WHERE key = 'gmail_auto_case_creation_enabled';
   ```

## Operational notes

- **Watch expiry.** Gmail watches last 7 days. `/api/cron/gmail-watch-renew`
  runs daily (01:00 UTC / 06:30 IST) and renewal is idempotent, giving six days
  of slack. Failures are recorded in `cron_health` under `gmail-watch-renew`.
- **Checkpoint.** `app_settings.gmail_history_id`. The webhook does **not**
  advance it when the history fetch fails — an earlier version did, which meant
  one transient Gmail error dropped that batch of mail permanently.
- **Idempotency.** Pub/Sub is at-least-once and retries on non-2xx, so messages
  legitimately arrive twice. `gmail_intake_log.gmail_message_id` is unique and
  is checked before processing.
- **Cost.** Every parsed message is a Claude call. Shadow mode still incurs it.

## Not yet built (Phases 2–3)

- No UI renders `case_emails` — ingested mail is invisible in the app.
- **Attachments are dropped.** `gmail.ts` records `attachmentNames` but never
  downloads the bodies. Intake mail carrying KYC documents will leave the
  auto-generated document checklist pending, so someone still has to open the
  mailbox. This substantially limits the value until built.
- No review queue for low-confidence parses; `needs_manual_review` is recorded
  and surfaced nowhere.
- `sendGmailReply()` exists in `src/lib/gmail.ts` but nothing calls it.

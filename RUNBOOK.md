# TWV CRM — Emergency Runbook

**Internal tool for The WorkVilla.** This document describes what to do when things break. Keep it updated. When in doubt, call Vinit.

---

## Quick Reference

| Failure | RTO | Runbook |
|---|---|---|
| Broken deploy / feature regression | < 5 min | [Runbook C](#runbook-c--vercel-rollback) |
| Credential / key leaked | < 30 min | [Runbook D](#runbook-d--credential-compromise) |
| Razorpay webhook / payment not recorded | < 1 hour | [Runbook E](#runbook-e--razorpay-webhook-loss) |
| Storage files missing | 2–6 hours | [Runbook B](#runbook-b--storage-file-restore) |
| Database / full data loss | 2–4 hours | [Runbook A](#runbook-a--database-full-restore) |

**RPO (max data loss):** Up to 24 hours (last daily backup). Razorpay payments are always reconcilable from the Razorpay dashboard regardless of RPO.

---

## Where to Find Things

| Resource | Location |
|---|---|
| Production app | https://twv-crm.vercel.app |
| Vercel dashboard | https://vercel.com/vinit2776/twv-crm |
| Supabase dashboard | https://app.supabase.com → project: TWV CRM |
| Backblaze B2 backups | https://secure.backblaze.com → bucket: `twvcrmbackups` |
| Razorpay dashboard | https://dashboard.razorpay.com |
| GitHub repo | https://github.com/vinit2776/TWVCRM |
| Secrets vault | 1Password → "TWV CRM Production" |

---

## Runbook A — Database Full Restore

**Trigger:** Supabase project deleted, catastrophic data loss, or need to stand up a fresh copy.

### What's backed up

Daily JSON snapshots at `B2 > twvcrmbackups/db/YYYY-MM-DD/twvcrm-db-TIMESTAMP.json.gz`. Runs daily at 01:00 IST via `/api/cron/db-backup`. Also, the `scripts/backup/db-backup.sh` script can be run locally at any time to produce a SQL dump.

### Steps

1. **Log into Backblaze B2** → bucket `twvcrmbackups` → folder `db/` → pick the latest date folder.

2. **Create a fresh Supabase project** (if the original is gone) and apply schema:
   ```bash
   npx supabase db push --linked
   ```
   This applies all migrations in `supabase/migrations/` to create the empty schema.

3. **Get the new project's connection string** from Supabase dashboard → Settings → Database → Connection string (URI format).

4. **Run the restore script** from the repo root:
   ```bash
   # Dry run first — just lists what would be restored
   B2_KEY_ID=xxx B2_APPLICATION_KEY=xxx B2_BUCKET=twvcrmbackups B2_ENDPOINT=s3.us-east-005.backblazeb2.com \
   TARGET_DB_URL="postgresql://postgres:PASSWORD@HOST:5432/postgres" \
   node scripts/restore/db-restore.mjs --date 2025-12-01 --dry-run

   # Actual restore
   B2_KEY_ID=xxx B2_APPLICATION_KEY=xxx ... \
   node scripts/restore/db-restore.mjs --date 2025-12-01
   ```

5. **Verify** — spot-check row counts:
   ```sql
   SELECT 'contracts' AS t, count(*) FROM contracts
   UNION ALL SELECT 'billing_statements', count(*) FROM billing_statements
   UNION ALL SELECT 'users', count(*) FROM users
   UNION ALL SELECT 'booking_payments', count(*) FROM booking_payments;
   ```

6. **Point the app to the new project** — update Vercel environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   Then trigger a Vercel redeploy (push an empty commit or click "Redeploy" in the dashboard).

**RTO estimate:** 2–4 hours | **RPO:** Up to 24 hours

---

## Runbook B — Storage File Restore

**Trigger:** Supabase Storage files missing, bucket deleted, or contract/invoice PDFs returning 404.

### What's backed up

Daily sync of `crm-documents` and `vendor-invoices` buckets to `B2 > twvcrmbackups/storage/`. Runs daily at 01:30 IST via `/api/cron/storage-backup`.

### Steps

1. **Identify what's missing.** If it's a single file, check B2 directly:
   - `twvcrmbackups/storage/crm-documents/<path>`
   - `twvcrmbackups/storage/vendor-invoices/<path>`

2. **Run the restore script** from the repo root:
   ```bash
   # Dry run — lists files that would be uploaded
   B2_KEY_ID=xxx B2_APPLICATION_KEY=xxx B2_BUCKET=twvcrmbackups B2_ENDPOINT=s3.us-east-005.backblazeb2.com \
   NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
   SUPABASE_SERVICE_ROLE_KEY=xxx \
   node scripts/restore/storage-restore.mjs --dry-run

   # Restore a single bucket
   node scripts/restore/storage-restore.mjs --bucket crm-documents

   # Restore all buckets
   node scripts/restore/storage-restore.mjs

   # Restore specific path prefix only
   node scripts/restore/storage-restore.mjs --bucket crm-documents --prefix contracts/2025/
   ```

3. **Verify** — open a recently restored file from the CRM UI and confirm it loads.

**RTO estimate:** 2–6 hours (depending on file count) | **RPO:** Up to 24 hours

---

## Runbook C — Vercel Rollback

**Trigger:** A deploy broke something — feature not working, JS error in console, page crashing, layout broken.

### Steps

1. Go to **Vercel dashboard** → twv-crm project → **Deployments** tab.
2. Find the last deployment with status **"Ready"** before the bad one.
3. Click the three-dot menu → **"Promote to Production"**.
4. Wait ~30 seconds, then reload https://twv-crm.vercel.app and verify the broken thing is fixed.
5. **Fix the code** on a branch:
   ```bash
   git checkout -b fix/whatever-broke
   # make your fix
   npm run build    # must pass
   npm run lint     # must pass
   git push origin fix/whatever-broke
   gh pr create
   ```
6. Merge the fix PR → Vercel auto-deploys.

> **Tip:** If you're not sure which deployment is "last good", look at the CI status on GitHub — a green commit means the build passed before Vercel deployed it.

**RTO estimate:** < 5 minutes (rollback) + time to fix root cause

---

## Runbook D — Credential Compromise

**Trigger:** A secret key was exposed — in a git commit, a log file, a Slack message, a Vercel build log, or any public location.

**Act immediately. Every minute counts.**

### Steps by key type

#### Supabase Service Role Key (`SUPABASE_SERVICE_ROLE_KEY`)

1. **Supabase dashboard** → Settings → API → **Regenerate** service role key.
2. Copy the new key.
3. **Vercel dashboard** → twv-crm → Settings → Environment Variables → update `SUPABASE_SERVICE_ROLE_KEY`.
4. Trigger a redeploy (push an empty commit: `git commit --allow-empty -m "chore: rotate service role key"` then push).
5. **Audit for suspicious activity:**
   ```sql
   SELECT * FROM audit_trail
   WHERE performed_at > now() - interval '24 hours'
   ORDER BY performed_at DESC
   LIMIT 100;
   ```
   Look for changes made by unknown `performed_by` values or at unusual times.

#### Razorpay Webhook Secret (`razorpay_webhook_secret`)

1. **Razorpay dashboard** → Settings → Webhooks → edit the webhook → regenerate secret.
2. Copy the new secret.
3. Log into the CRM as admin → **Admin → Settings** → update `razorpay_webhook_secret`.
4. No redeploy needed (key is read from DB at runtime).
5. **Check for fraudulent payments** during the exposure window:
   ```sql
   SELECT * FROM booking_payments
   WHERE status = 'verified'
     AND payment_mode = 'razorpay'
     AND created_at > '<exposure_start_time>';
   ```
   Cross-reference each `razorpay_payment_id` against the Razorpay dashboard to confirm they're real.

#### Razorpay Key ID / Secret (`razorpay_key_id`, `razorpay_key_secret`)

1. **Razorpay dashboard** → Settings → API Keys → **Regenerate**.
2. Copy the new key ID and secret.
3. CRM admin → **Admin → Settings** → update both keys.
4. No redeploy needed.

#### B2 Backup Keys

1. **Backblaze B2** → My Account → App Keys → delete the compromised key → create a new one.
2. Update `B2_KEY_ID` and `B2_APPLICATION_KEY` in Vercel environment variables.
3. Redeploy.

---

## Runbook E — Razorpay Webhook Loss

**Trigger:** A customer paid via Razorpay but the invoice/booking is still showing as unpaid in the CRM.

This happens when Razorpay fires the webhook but our DB write fails (network error, timeout, Supabase outage).

### Steps

1. **Confirm payment in Razorpay dashboard** → Payments → search by amount or date → find the payment → note the `payment_id` (starts with `pay_`) and `payment_link_id` or `order_id`.

2. **Check the webhook log** in Supabase (as admin):
   ```sql
   SELECT * FROM razorpay_webhook_log
   WHERE razorpay_payment_id = 'pay_XXXXXXXX'
      OR razorpay_payment_link_id = 'plink_XXXXXXXX'
   ORDER BY received_at DESC;
   ```
   - If a row exists with `outcome = 'processed'` → the webhook was handled. Check the entity (proposal, booking, billing_statement) directly.
   - If no row exists → the webhook never reached us. Use option 3 (retry).
   - If a row exists with `outcome = 'error'` → webhook arrived but processing failed. Check Vercel logs for that timestamp.

3. **Retry the webhook** — Razorpay dashboard → Settings → Webhooks → Failed Events → find the event → click **Retry**.

4. **Manual reconciliation** (if retry doesn't work or the payment link isn't in webhook events):

   For a **billing statement** payment:
   ```sql
   -- First verify the payment_link_id matches
   SELECT id, total_amount, payment_status FROM billing_statements
   WHERE razorpay_payment_link_id = 'plink_XXXXXXXX';

   -- Insert the payment manually (get billing_statement_id from above)
   INSERT INTO billing_payments (billing_statement_id, amount, payment_date, payment_mode, payment_reference, razorpay_payment_id)
   VALUES ('<uuid>', <amount>, CURRENT_DATE, 'razorpay', 'pay_XXXXXXXX', 'pay_XXXXXXXX');

   -- Update status
   UPDATE billing_statements SET payment_status = 'paid' WHERE id = '<uuid>';
   ```

   For a **proposal** payment, update `proposals.payment_status = 'paid'` and `status = 'accepted'`.

5. **Log the manual action** in the audit trail (do this via the CRM UI or by recording in the notes field of the entity).

**RTO estimate:** < 1 hour

---

## Backup Health Check

Run this query in Supabase to see if backups are running:

```sql
SELECT key, last_run_at, status,
       now() - last_run_at AS age
FROM cron_health
WHERE key IN ('cron/db-backup', 'cron/storage-backup')
ORDER BY key;
```

If `age` is > 26 hours, the backup cron is stale. Check:
1. Vercel dashboard → Functions → look for errors in `api/cron/db-backup` or `api/cron/storage-backup`
2. Manually trigger: `node scripts/trigger-cron.mjs db-backup` (or `storage-backup`)

---

## Contacts

| Role | Name | Contact |
|---|---|---|
| CRM owner | Vinit Chordia | vinitchordia@gmail.com |
| Supabase support | — | https://supabase.com/support |
| Razorpay support | — | https://razorpay.com/support |
| Vercel support | — | https://vercel.com/help |
| Backblaze support | — | https://www.backblaze.com/help |

---

*Last updated: May 2026. Update this file whenever you change a secret rotation procedure, add a new backup target, or discover a new failure mode.*

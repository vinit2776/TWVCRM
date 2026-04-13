---
name: promote-to-production
description: Promote staging branch to production — merges staging into main and deploys
argument-hint: "[optional: --force to skip confirmation]"
---

# Promote to Production

Safely promotes the `staging` branch to `production` by merging into `main` and pushing to origin, which triggers an automatic Vercel deployment.

## Workflow

### Step 1: Check for Uncommitted Changes

Run the following using the GIT_DIR/GIT_WORK_TREE env vars (required because the project path contains spaces):

```bash
GIT_DIR="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM/.git" \
GIT_WORK_TREE="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM" \
git status --porcelain
```

If there is any output, **stop and tell the user** there are uncommitted changes. Do not proceed until the working tree is clean.

### Step 2: Fetch Latest from Origin

```bash
GIT_DIR="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM/.git" \
GIT_WORK_TREE="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM" \
git fetch origin
```

### Step 3: Check if There Is Anything to Promote

Check how many commits `staging` is ahead of `main`:

```bash
GIT_DIR="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM/.git" \
GIT_WORK_TREE="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM" \
git rev-list --count origin/main..origin/staging
```

If the count is `0`, tell the user: "staging is already up to date with production — nothing to promote." Stop here.

### Step 4: Show Commit Summary

Show the user exactly what commits will be promoted:

```bash
GIT_DIR="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM/.git" \
GIT_WORK_TREE="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM" \
git log origin/main..origin/staging --oneline --no-decorate
```

Present this list clearly to the user in a readable format, e.g.:

```
📦 Commits to be promoted to production:
  abc1234  feat(attendance): add ADMS biometric push endpoint
  def5678  fix(mailer): add Resend fallback transport
  ghi9012  feat(migrations): add cron_health table
```

### Step 5: Ask for Confirmation

Use the AskUserQuestion tool to ask:

> "These X commits will be merged from staging into production and deployed to https://twv-crm.vercel.app. Confirm? (yes / no)"

If the user says anything other than yes/y/confirm, abort and tell them: "Promotion cancelled. No changes were made."

### Step 6: Merge and Push

```bash
# Switch to main
GIT_DIR="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM/.git" \
GIT_WORK_TREE="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM" \
git checkout main

# Merge staging into main (fast-forward preferred, fall back to merge commit)
GIT_DIR="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM/.git" \
GIT_WORK_TREE="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM" \
git merge origin/staging --no-edit -m "chore: promote staging to production"

# Push to origin main (triggers Vercel deployment automatically)
GIT_DIR="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM/.git" \
GIT_WORK_TREE="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM" \
git push origin main
```

If any of these commands fail, show the error clearly and do not continue.

### Step 7: Report Completion

Tell the user:

```
✅ Promotion complete!

Production deployment triggered automatically.
Live at: https://twv-crm.vercel.app

Vercel will build and deploy in ~2 minutes.
Run /health-check to confirm once it's live.
```

Also run a quick check to confirm the push landed:

```bash
GIT_DIR="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM/.git" \
GIT_WORK_TREE="/Users/vinitchordia/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM" \
git log origin/main --oneline -3
```

Show the top 3 commits on main so the user can confirm their changes are there.

## Success Criteria

- [ ] Working tree was clean before promotion
- [ ] User saw and confirmed the commit list
- [ ] `git push origin main` succeeded with no errors
- [ ] Top commits on `origin/main` match what was promoted from staging

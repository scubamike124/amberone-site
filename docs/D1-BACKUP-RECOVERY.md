# AmberOne D1 — Backup & Recovery Runbook

**Database:** `amberone` (Cloudflare D1)
**Database ID:** `0b00c9b1-dbda-4be4-b603-1b5d3d16bc3a`
**Binding:** `DB` (see `wrangler.toml`)

This runbook covers routine backups, point-in-time exports, and full restore of the AmberOne production database. Follow the Amber Experience Blueprint: narrate each step, verify before/after, and never run a destructive command without a fresh export in hand.

## 1. Prerequisites

- `wrangler` CLI installed (already a devDependency: `npx wrangler --version`)
- Authenticated: `npx wrangler login`, or `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` set in the environment (see `.dev.vars`, never commit these)
- Confirm you're targeting the right database: `npx wrangler d1 info amberone`

## 2. Routine backup (export to SQL)

Cloudflare D1 does not (yet) offer automatic point-in-time snapshots on all plans, so **AmberOne treats a scheduled `wrangler d1 export` as the backup mechanism.**

```bash
# From the amberone-site project root
mkdir -p backups
npx wrangler d1 export amberone --remote --output=backups/amberone-$(date +%Y%m%d-%H%M%S).sql
```

Recommended cadence:

- **Daily** automated export (cron / CI job) while the product is in active development
- **Before every schema migration** (see §5)
- **Before any bulk data operation** (manual SQL against production)

Store exports outside the repo (e.g. private cloud storage bucket) — do not commit `.sql` dumps to git, since they contain full user data.

### Verify a backup

```bash
# Sanity-check the dump has real content and expected tables
grep -c "INSERT INTO" backups/amberone-<timestamp>.sql
grep "CREATE TABLE" backups/amberone-<timestamp>.sql
```

## 3. Ad-hoc table export (lighter weight)

To back up just one table (e.g. before a risky `reminders` migration):

```bash
npx wrangler d1 execute amberone --remote --command="SELECT * FROM reminders" --json > backups/reminders-snapshot.json
```

## 4. Cloudflare Dashboard backup path (no CLI)

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com/) → **Workers & Pages → D1**.
2. Select the `amberone` database (id `0b00c9b1-dbda-4be4-b603-1b5d3d16bc3a`).
3. Under **Settings**, use **Export database** to download a `.sqlite`/`.sql` snapshot.
4. Store the download in the same private backup location as CLI exports, named with a UTC timestamp.

## 5. Schema migrations

`schema.sql` is the source of truth. All statements are `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so re-running it is always safe (idempotent) against an existing database — it will never drop or truncate data.

```bash
# Take a backup first (see §2)
npx wrangler d1 export amberone --remote --output=backups/pre-migration-$(date +%Y%m%d-%H%M%S).sql

# Apply schema changes
npx wrangler d1 execute amberone --remote --file=./schema.sql

# Verify
npx wrangler d1 execute amberone --remote --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

`functions/_lib/core.js`'s `ensureSchema()` also runs the same `CREATE TABLE IF NOT EXISTS` statements on every cold start via `functions/_middleware.js`, so the schema self-heals even if a manual migration is skipped.

## 6. Restore from a backup

**Restoring overwrites data — always confirm with the Owner before running this against production.**

1. Confirm which backup file to restore from and its timestamp.
2. If restoring into the *same* database (disaster recovery), the cleanest path is a fresh D1 database + Pages binding swap, since D1 does not support "drop and reload" in place safely from the CLI:

   ```bash
   # Create a new database (or use an existing empty one for restore testing)
   npx wrangler d1 create amberone-restore

   # Load the backup SQL into it
   npx wrangler d1 execute amberone-restore --remote --file=backups/amberone-<timestamp>.sql

   # Verify row counts match expectations
   npx wrangler d1 execute amberone-restore --remote --command="SELECT COUNT(*) FROM users"
   npx wrangler d1 execute amberone-restore --remote --command="SELECT COUNT(*) FROM calendar_events"
   ```

3. Once verified, update `wrangler.toml`'s `database_id` / `preview_database_id` to point at the restored database, redeploy Pages, and re-run `scripts/verify-phase1-core.mjs` against the live URL to confirm the app is healthy.
4. Only after the app is confirmed healthy should the old (corrupted/lost) database be decommissioned.

### Restoring a single table

If only one table needs recovery (e.g. `reminders` accidentally truncated), extract just that table's `INSERT` statements from the backup SQL and replay them:

```bash
grep "INSERT INTO reminders" backups/amberone-<timestamp>.sql > restore-reminders.sql
npx wrangler d1 execute amberone --remote --file=restore-reminders.sql
```

## 7. Incident checklist

- [ ] Identify scope (which tables / which user rows affected)
- [ ] Pull the most recent backup *before* touching production
- [ ] Test the restore path against a scratch database first (`amberone-restore` above) when time allows
- [ ] Communicate to the Owner: what happened, what's being restored, expected downtime
- [ ] Restore, verify (`scripts/verify-phase1-core.mjs`, spot-check `/api/health`)
- [ ] Write up the incident + fix in `docs/MILESTONE-PROGRESS.md` so the Learning Brain captures it for next time

## 8. Secrets note

Never print or commit `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, or database dumps (they contain password hashes, emails, Stripe customer IDs). Treat all backup files as sensitive customer data.

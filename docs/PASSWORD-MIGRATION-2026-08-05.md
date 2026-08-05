# Password hashing migration — backup and rollback plan

**Shipped 2026-08-05.** Raises PBKDF2 from 10,000 iterations to 100,000, with a
per-row cost so it can be raised further later. **No user is locked out and no
bulk rewrite happens.**

## Why it could not be a one-line change

Every stored hash was derived at whatever `PBKDF2_ITERATIONS` said when it was
written, and nothing recorded which. Changing the constant alone would have made
every hash in the table unverifiable — **every existing user locked out
permanently, with no way back**, because we never hold the plaintext outside the
moment someone types it.

## How it works

1. `users.password_iterations INTEGER` — added by `ensureSchema`, **no DEFAULT,
   no backfill.** Existing rows read `NULL`, and `iterationsForStoredHash()` maps
   `NULL` to 10,000, which is what those hashes were genuinely made at. A default
   of the *new* value would have claimed otherwise and locked everyone out.
2. **Login verifies at the row's own cost**, so every existing password keeps
   working from the moment this deploys.
3. **On a correct password, if the stored cost is below target**, the password is
   re-derived at the target with a fresh salt and written back. Accounts upgrade
   as people sign in.
4. **Signup, password reset and magic-link account creation** all write at the
   current target and record it, so new accounts never need step 3.
5. The upgrade is wrapped in `try/catch`. A failed write leaves the old hash,
   which still verifies; the next login retries. **An upgrade can never cost
   someone a login.**

## Choosing the number

Measured on WebCrypto, one derivation, median of five runs:

| Iterations | Time |
|---:|---:|
| 10,000 *(old)* | 1.7 ms |
| 50,000 | 7.6 ms |
| **100,000 *(new default)*** | **15.2 ms** |
| 150,000 | 22.3 ms |
| 210,000 | 31.3 ms |
| 600,000 | 90.1 ms |

The original comment said the low value was "kept modest for Cloudflare Pages
Functions CPU limits", and that constraint is real: Workers' default CPU ceiling
is 10 ms per invocation on the free plan, and far higher on paid.

100,000 is a tenfold improvement and sits comfortably inside any paid plan's
budget. It is **read from the environment**, so no code change is needed to move
it:

```bash
npx wrangler pages secret put PBKDF2_ITERATIONS   # e.g. 310000
```

Because each row carries its own cost, changing this value is safe at any moment.
Raising it upgrades accounts on their next login. Lowering it leaves stronger
hashes untouched — it never downgrades anyone.

**If you are on the free plan**, set it to `50000` (7.6 ms) until you upgrade;
that is still five times the old cost.

## Before deploying: back up the users table

The migration only adds a column and rewrites hashes one at a time on successful
login, but take the snapshot anyway — it is one command and it is the difference
between an inconvenience and an incident.

```bash
npx wrangler d1 export amberone --remote --output ./backup-users-2026-08-05.sql
```

Verify it is real before proceeding:

```bash
grep -c "INSERT INTO users" ./backup-users-2026-08-05.sql
```

Keep it until you have seen real users signing in successfully for a few days.

## Rollback

Three levels, cheapest first.

**1. Turn the target down.** Nothing to deploy:

```bash
npx wrangler pages secret put PBKDF2_ITERATIONS    # 10000
```

Already-upgraded rows keep their stored cost and keep working — verification
always uses the row's own value. This stops further upgrades.

**2. Revert the code.** Safe by construction, and covered by a test. If this
commit is reverted, `hashPassword(password, salt)` falls back to its default
parameter of `PBKDF2_DEFAULT_ITERATIONS` = 100,000 — exactly what migrated rows
store, so **migrated users keep logging in against the old code.** Users still on
10,000 would break under a full revert, so if you revert, revert to a build that
still contains `iterationsForStoredHash`.

The test `rollback: the old code path against a migrated row` exists specifically
to hold this property still.

**3. Restore the table.** Only if something unrelated went wrong:

```bash
npx wrangler d1 execute amberone --remote --file ./backup-users-2026-08-05.sql
```

## Verification

`npm run test:password` — 25 checks, no D1 or network needed. It walks the real
lifecycle: a legacy row logging in the day this ships, the upgrade, the next
login, wrong passwords before and after, raising the target a second time,
lowering it, and the rollback path above.

```
npm run test:password   # password-migration: all checks passed
npm run test:auth       # auth-hardening: all checks passed
npm run build           # AmberOne production build check passed
```

## What to watch after deploying

`password rehash failed` in the Pages logs means step 3 is failing — logins still
work, but nobody is being upgraded. The likely cause is a schema problem, since
the write is the only new statement.

To see how the migration is progressing:

```sql
SELECT COALESCE(password_iterations, 10000) AS cost, COUNT(*)
FROM users GROUP BY 1 ORDER BY 1;
```

Accounts that never sign in again will sit at 10,000 indefinitely. That is the
correct trade — the alternative is locking them out — and a password reset
upgrades them too, so a reset campaign would finish the job if you ever want the
old rows gone.

# Ballast vs. the field — a reproducible benchmark

*Run 2026-07-10 · ballast-pg 0.2.0 vs squawk-cli 2.59.0 · corpus + commands in
[`bench/corpus/`](../bench/corpus/) — re-run it yourself, that's the point.*

Two labeled corpora, ground truth from the PostgreSQL docs (each claim in our
[verified catalog](catalog/) cites its source):

- **`dangerous.sql`** — 18 statements that genuinely block/rewrite/destroy on a
  large or hot table. Flagging one = **catch**; silence = **miss**.
- **`safe.sql`** — 14 statements that are safe on modern Postgres (11+), including
  the classic false-positive traps. Flagging one as a blocking danger = **false
  positive**.

```bash
npx ballast-pg check bench/corpus/dangerous.sql
npx squawk-cli bench/corpus/dangerous.sql        # same files, same day
```

## Headline

| | catches (of 18) | misses | false positives (of 14 safe) |
|---|---|---|---|
| **Ballast 0.2.0** | **18** | 0 | **0** |
| **Squawk 2.59.0** | 11 (+1 for the wrong reason) | 6 | 2 |

## What Squawk missed (silence on real danger)

| statement | reality | Ballast |
|---|---|---|
| `VACUUM FULL orders` | ACCESS EXCLUSIVE + full rewrite — blocks everything | ⛔ |
| `CLUSTER orders USING …` | ACCESS EXCLUSIVE + full rewrite | ⛔ |
| `ALTER TABLE … SET LOGGED` | full table rewrite under ACCESS EXCLUSIVE | ⛔ |
| `REFRESH MATERIALIZED VIEW` (non-concurrent) | blocks all reads of the matview for the whole rebuild | ⛔ |
| `TRUNCATE audit_log` | irreversible data loss under ACCESS EXCLUSIVE | ⛔ |
| `UPDATE orders SET migrated = true` (no WHERE) | unbatched backfill: row locks till commit, WAL bloat, replica lag | ⚠️ |
| `ADD COLUMN seq_no serial` | volatile default (`nextval`) → full table rewrite. Squawk flags it only as a *style* issue (`prefer-identity`), not the rewrite | ⛔ |

## Where Squawk cried wolf (and Ballast didn't)

`safe.sql` creates `brand_new` and then indexes/constrains it two lines later — an
empty relation nothing references yet. Squawk flags both
(`require-concurrent-index-creation`, `constraint-missing-not-valid`); Ballast
recognizes same-file creation and grades them safe. On a real 66-migration history
this one pattern was the difference between 93 findings and the 37 real ones.

Also noteworthy: Squawk attaches `prefer-robust-stmts` (a re-runnability style
nit) to nearly every statement in both corpora — in a hard-red CI gate, style
noise at that volume is what gets a linter deleted.

## Where Squawk is genuinely better (kept honest)

- **`require-timeout-settings`** — it flags migrations that don't `SET
  lock_timeout` before slow operations. At benchmark time (0.2.0) Ballast
  *advised* lock_timeout in every rewrite but had no rule requiring it — a real
  Squawk win this benchmark surfaced. **Closed in 0.2.1:** a script with any
  non-safe finding and no `SET lock_timeout` now gets the hygiene note
  (advisory, not a gate — bounding lock waits is our own incident-#1 advice).
- **Correct on the fast-default rule** — like Ballast, it did *not* flag
  `DEFAULT now()` (both tools got PG 11+ semantics right; several folk rules and
  at least one LLM don't).
- **Maturity** — years of production use, editor plugins, an established
  community. Ballast is weeks old; that difference is real.

## strong_migrations (rule mapping — it can't run this benchmark)

strong_migrations analyzes **ActiveRecord migration methods in Ruby**; raw SQL
requires a manual `safety_assured` bypass, so it cannot lint `.sql` files at all.
Mapping its 20 Postgres-relevant checks against Ballast:

- **17 / 20 covered** (indexes, FK incl. inline references, check/unique/exclusion
  constraints, NOT NULL, column type, volatile & auto-incrementing & generated
  columns, drop/rename column & table, destructive create-force).
- **Ballast goes further on backfills:** strong_migrations' own README states it
  does **not** detect dangerous backfills — Ballast's un-scoped UPDATE/DELETE
  check does.
- **3 honest gaps** (app-level breakage, not locks — backlog): `json` (vs `jsonb`)
  column equality quirk, `ALTER TYPE … RENAME VALUE`, schema renames.
- Its Rails-native ergonomics (auto-set lock timeouts, `safety_assured` workflow)
  are excellent *if you live in Rails*.

## The rest of the field

- **PostgresAI Migration Checker** — execution-based: runs your migration on a
  thin clone of production-scale data. Ground truth by definition, and the right
  tool if you can afford the clone infrastructure and CI minutes. Ballast's bet is
  the opposite trade: 90% of the signal from a read-only stats snapshot in 200ms.
- **pgfence** — unpublished from npm in Feb 2026. Gone.

## What none of them attempt

Every tool above (except PostgresAI's clones) reads only the SQL. Ballast's
`--dsn` mode weights each finding by *your* live table size, write rate, and
lock-holder state — the same `CREATE INDEX` grades safe on 10 rows and critical on
3M — plus `ballast audit` (rank your whole migration history) and an MCP server
(verdicts inside Cursor / Claude Code while the agent writes the migration).

## Reproduce

```bash
git clone https://github.com/davemutisya/ballast && cd ballast
npx ballast-pg check bench/corpus/dangerous.sql   # expect 15 danger, 3 caution
npx ballast-pg check bench/corpus/safe.sql        # expect 13 safe, 0 flagged
npx squawk-cli bench/corpus/dangerous.sql
npx squawk-cli bench/corpus/safe.sql
```

Found a case where Ballast is wrong and a competitor is right? That's exactly the
issue we most want filed.

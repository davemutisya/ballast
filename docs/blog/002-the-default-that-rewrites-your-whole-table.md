# The column default that quietly rewrites your whole table

*Incident encyclopedia · #2 · Postgres fast-defaults and the `now()` trap*

Here are two migrations. They look almost identical. One is instant on a billion-row
table. The other rewrites every row on disk under a lock that blocks all reads and
writes, for as long as that takes.

```sql
-- (a)
ALTER TABLE events ADD COLUMN source text NOT NULL DEFAULT 'web';

-- (b)
ALTER TABLE events ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
```

The difference is the default expression. And almost nobody clocks it in review.

## Why (a) is free — the fast-default

Since PostgreSQL 11, adding a column with a **constant** default is metadata-only. PG
doesn't touch a single existing row. It stores the default once in the catalog (the
`attmissingval` field) and hands that value back to any read of an old row that predates
the column. `NOT NULL` is satisfied automatically, because every existing row now
"reads as" `'web'` without being rewritten. On a billion-row table, migration (a)
finishes in milliseconds.

This is why the blanket advice "never add a `NOT NULL DEFAULT` column" is outdated. On
modern Postgres, with a constant default, it's one of the *safest* things you can do.

## Why (b) is an outage — the volatile default

`now()` is not a constant. Neither is `gen_random_uuid()`, `random()`, or
`clock_timestamp()`. Every row must get a **different** value, so there is no single
value Postgres can stash in the catalog. It has no choice but to fall back to the old
behavior: **rewrite the entire table**, row by row, computing the default for each one —
holding an `ACCESS EXCLUSIVE` lock the whole time.

`ACCESS EXCLUSIVE` is the strongest lock there is; it blocks even a plain `SELECT`. So
for the entire duration of the rewrite — which scales with the table's size **on disk**,
not its row count — the table is completely unavailable. On a 50 GB table that's not
milliseconds. That's minutes, and every query behind it piles into the lock queue (see
[incident #1](001-the-10ms-migration-that-took-down-prod.md)).

The two migrations differ by four characters: `'web'` vs `now()`. One is metadata. One
is a full-table rewrite. The SQL gives you almost no visual warning.

## The fix — split the volatile default into safe steps

You want the column, the default, and eventually the `NOT NULL`, without the rewrite:

```sql
-- 1. Add the column with NO default (metadata-only, instant).
ALTER TABLE events ADD COLUMN created_at timestamptz;

-- 2. Set the default going forward (also metadata-only — new rows get it).
ALTER TABLE events ALTER COLUMN created_at SET DEFAULT now();

-- 3. Backfill existing rows in batches, committing each batch, OUTSIDE one big txn:
--    UPDATE events SET created_at = now() WHERE created_at IS NULL AND id BETWEEN ...;

-- 4. Only once backfilled, enforce NOT NULL without a long scan:
ALTER TABLE events ADD CONSTRAINT events_created_at_nn CHECK (created_at IS NOT NULL) NOT VALID;
ALTER TABLE events VALIDATE CONSTRAINT events_created_at_nn;   -- SHARE UPDATE EXCLUSIVE, doesn't block
ALTER TABLE events ALTER COLUMN created_at SET NOT NULL;       -- PG 12+ reuses the validated CHECK
```

Steps 1, 2, and 4's `VALIDATE` never take a table-blocking lock for more than a moment.
The expensive part — touching every row — happens in step 3, in batches, with the table
fully online the whole time.

## Why static linters only half-catch this

Some linters do flag "`ADD COLUMN` with a volatile default." That's good — but it's
binary. What they can't tell you is *how bad*, because the cost of a rewrite is
`table_bytes ÷ your storage throughput`, and none of that is in the SQL. On a 10 MB
lookup table the rewrite is a non-event; on a 50 GB events table it's a page. "It's a
rewrite" and "it's a nine-minute outage" are very different review conversations, and
only one of them reads the live database.

## Ballast catches this — and quantifies it

Ballast classifies the default expression (constant → metadata-only; volatile →
`REWRITE`) from the same adversarially-verified catalog behind every finding, then, with
a read-only connection, multiplies the rewrite by your real table bytes and calibrated
throughput:

```
🔥 ADD_COLUMN_DEFAULT_VOLATILE on events: default now() forces a full table REWRITE
   under ACCESS EXCLUSIVE. events is ~48 GB → est. ~7–11 min of blocked reads+writes.
   Safe rewrite: add the column without a default; SET DEFAULT; backfill in batches;
   enforce NOT NULL via a validated CHECK.
```

Migration (a) it waves through as safe — because on PG 11+ it genuinely is. Migration
(b) it stops, with a time estimate you can bring to the deploy conversation. Same
statement shape; opposite verdicts; the difference is the thing only a load-aware tool
looks at.

```bash
npx ballast-pg check migrations/ --dsn "$DATABASE_URL"
```

*Next in the encyclopedia: `CREATE INDEX` vs `CREATE INDEX CONCURRENTLY` — why the
"safe" one can still wedge your writes, and the `INVALID` index it leaves behind when it
fails.*

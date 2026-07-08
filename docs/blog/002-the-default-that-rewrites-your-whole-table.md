# The column default that quietly rewrites your whole table

*Incident encyclopedia · #2 · Postgres fast-defaults and the volatility trap*

Here are two migrations. They look almost identical. We ran both on the same
2-million-row table. One took **0.9 milliseconds**. The other took **1,249
milliseconds** — holding a lock that blocks every read and every write on the table
for the whole time, scaling linearly with table size.

```sql
-- (a)  0.9 ms on 2M rows
ALTER TABLE events ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- (b)  1,249 ms on 2M rows — and it's just getting started
ALTER TABLE events ADD COLUMN uid uuid NOT NULL DEFAULT gen_random_uuid();
```

If you guessed that `now()` was the dangerous one — that's the trap, and you're in
good company. Most engineers (and several lint rules, and more than one AI coding
assistant) believe "function default = table rewrite." The real rule is sharper, and
knowing it precisely is the difference between shipping (a) with confidence and
turning (b) into an outage.

## The fast-default rule (PG 11+)

Since PostgreSQL 11, `ADD COLUMN ... DEFAULT <expr>` skips rewriting the table when
the default can be computed **once** and reused for every existing row. Postgres
stores that single value in the catalog (`pg_attribute.attmissingval`), and any read
of an old row just gets it for free. `NOT NULL` is satisfied automatically. Zero rows
touched — which is why (a) finishes in under a millisecond on 2 million rows.

What decides it is the expression's **volatility**:

- **`now()`, `CURRENT_TIMESTAMP`, `transaction_timestamp()`** — these are *STABLE*:
  fixed within a transaction. Postgres evaluates once at `ALTER` time, stores the
  result. **No rewrite.** (Every pre-existing row gets the migration's timestamp —
  which is almost always what you meant.)
- **`gen_random_uuid()`, `random()`, `clock_timestamp()`, `nextval()` (so: `serial`),
  identity and stored generated columns** — these are *VOLATILE* or must differ per
  row. There is no single value to store. Postgres has no choice but to **rewrite
  every row**, computing the value for each, under an `ACCESS EXCLUSIVE` lock — the
  strongest lock there is; it blocks even plain `SELECT`s.

Our 2M-row table is small. Scale (b) to a 200M-row, 50 GB events table and that
1.25 seconds becomes minutes of the table being completely unavailable — with every
arriving query piling into the lock queue behind it (see
[incident #1](001-the-10ms-migration-that-took-down-prod.md)).

Four characters of SQL difference. Three orders of magnitude of lock time. And the
"obviously scary" function is the safe one.

## The fix — split the volatile default into safe steps

You want the column, the per-row value, and eventually `NOT NULL`, without the
rewrite:

```sql
-- 1. Add the column with NO default (metadata-only, instant).
ALTER TABLE events ADD COLUMN uid uuid;

-- 2. Set the default going forward (metadata-only — NEW rows get it).
ALTER TABLE events ALTER COLUMN uid SET DEFAULT gen_random_uuid();

-- 3. Backfill existing rows in batches, committing each batch, OUTSIDE one big txn:
--    UPDATE events SET uid = gen_random_uuid() WHERE uid IS NULL AND id BETWEEN ...;

-- 4. Only once backfilled, enforce NOT NULL without a long blocking scan:
ALTER TABLE events ADD CONSTRAINT events_uid_nn CHECK (uid IS NOT NULL) NOT VALID;
ALTER TABLE events VALIDATE CONSTRAINT events_uid_nn;   -- SHARE UPDATE EXCLUSIVE: doesn't block
ALTER TABLE events ALTER COLUMN uid SET NOT NULL;       -- PG 12+ reuses the validated CHECK
```

The expensive part — touching every row — happens in step 3, in batches, with the
table fully online the whole time.

## Why "just lint it" only half-works

A static linter can pattern-match "volatile function in a default" — if its
volatility list is right (we found and fixed a wrong one in our own tool: it flagged
`now()` as volatile, exactly the folk belief). But even a correct static rule is
binary. It can't tell you *how bad*, because the cost of a rewrite is
`table bytes ÷ your storage throughput`, and neither is in the SQL. On a 10 MB
lookup table, (b) is a non-event. On 50 GB it's a page. "It's a rewrite" and "it's
nine minutes of blocked reads and writes" are very different review conversations,
and only one of them read the live database.

## Ballast classifies this from the parse tree — and quantifies it

Ballast uses PostgreSQL's own parser (`libpg_query`) to read the default expression
and applies the real volatility rule — the same one Postgres applies internally
(unknown functions are treated as volatile: a user-defined function can be volatile,
and we'd rather over-warn than lie). Then, with a read-only connection, it multiplies
the rewrite by your actual table bytes and calibrated throughput:

```
✅ ADD_COLUMN_DEFAULT_CONST on events — default now() is STABLE: evaluated once,
   stored as a fast default. No rewrite at any table size (PG 11+).

🔥 ADD_COLUMN_DEFAULT_VOLATILE on events — default gen_random_uuid() forces a full
   table REWRITE under ACCESS EXCLUSIVE. events ≈ 48 GB → est. minutes of blocked
   reads+writes. Safe rewrite: add column bare → SET DEFAULT → backfill in batches
   → NOT NULL via validated CHECK.
```

Same statement shape; opposite verdicts; both correct — because the judgment came
from the actual volatility semantics and the actual size of *your* table, not a folk
rule about scary-looking functions.

```bash
npx ballast-pg check migrations/ --dsn "$DATABASE_URL"
```

*Next in the encyclopedia: `CREATE INDEX` vs `CREATE INDEX CONCURRENTLY` — why the
"safe" one can still wedge your writes, and the `INVALID` index it leaves behind when
it fails.*

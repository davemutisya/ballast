# The 10-millisecond migration that took down production

*Incident encyclopedia · #1 · Postgres lock queue*

Here is a migration your AI coding agent will happily write, your CI will happily
pass, and your review will happily approve:

```sql
ALTER TABLE orders DROP COLUMN legacy_note;
```

Dropping a column in Postgres is **metadata-only**. It doesn't rewrite the table.
It doesn't scan the rows. On a 2-billion-row table it finishes in about **10
milliseconds**. Every migration linter on earth will tell you it's fine — because,
looking at the SQL alone, it is.

And then it takes your site down for three minutes.

## The lock queue

Here's the part the SQL doesn't tell you. `ALTER TABLE ... DROP COLUMN` needs an
`ACCESS EXCLUSIVE` lock — the strongest lock Postgres has, the only one that blocks
even a plain `SELECT`. To *get* that lock, it has to wait for every current holder
of a conflicting lock to finish.

So picture this, at 2:14pm on a normal Tuesday:

1. Some analytics query — a `SELECT` that takes 45 seconds — is running against
   `orders`. It holds a gentle `ACCESS SHARE` lock. Totally normal.
2. Your 10ms `DROP COLUMN` arrives. It asks for `ACCESS EXCLUSIVE`, which conflicts
   with that `ACCESS SHARE`. So it **waits** behind the 45-second query.
3. Here's the killer: **every query that arrives after the DROP now queues behind
   the DROP** — including fast `SELECT`s that only need `ACCESS SHARE` and don't
   conflict with the analytics query at all. Postgres locks are first-in-first-out.
   Your "instant" migration is now a wall, and all of production is stacking up
   behind it.

For the ~45 seconds until that analytics query finishes, your database is
effectively unavailable. The migration itself, when it finally runs, takes 10ms.
The outage was everything that piled up *waiting* for it.

## We measured it

We built a controlled reproduction. A single 500k-row table, one long-running
reader, and a stream of fast probe `SELECT`s while a "safe" metadata-only `ALTER`
tried to run:

| `lock_timeout` | fast SELECTs stalled >200ms | outcome |
|---|---|---|
| unset | **6 of 6 (100%)** | the ALTER blocked; everything queued behind it |
| `1s` | **2 of 68 (3%)** | the ALTER aborted after 1s; reads flowed |

100% of unrelated reads stalled during a migration that, on its own, is
instantaneous. This is not a big-table problem or a heavy-migration problem. It is
a *timing* problem, and it is invisible to anything that only reads your SQL.

## The fix

Two parts, and you want both:

1. **Bound the wait.** Set a short `lock_timeout` (values under 2 seconds are
   common) on the migration session, and retry with backoff. If the lock can't be
   had quickly, the migration steps out of the queue and lets traffic through
   instead of holding the door:

   ```sql
   SET lock_timeout = '2s';
   ALTER TABLE orders DROP COLUMN legacy_note;   -- retried by your migration tool on failure
   ```

2. **For `DROP COLUMN` specifically,** stop referencing the column in application
   code and deploy that first — ORMs cache the schema and will throw until they
   reconnect. Then drop it, under the short `lock_timeout` above.

## Why linters miss this

Squawk, strong_migrations, and friends are static: they read the migration file.
The migration file says `DROP COLUMN`, which is metadata-only, which is "safe." They
are not wrong about the SQL. They simply cannot see the 45-second analytics query
that turns a 10ms statement into an outage — because that information isn't in the
SQL. It's in the live database.

The danger of a migration is not a property of the migration. It's a property of
the migration **times the state of your database right now.**

## Ballast catches this automatically

[Ballast](https://github.com/Grumpy254/ballast) is load-aware. Before a migration
runs — including inside your coding agent, via MCP — it reads the live database:
table size, write throughput, and, crucially, **the age of the oldest running
transaction.** That last field is what catches this incident. Point it at the same
`DROP COLUMN` while a long query is running:

```
🔥 DROP_COLUMN on orders: holds ACCESS EXCLUSIVE ~10ms, blocking reads + writes.
   LOCK QUEUE: a txn has run 45.0s on orders; this ACCESS EXCLUSIVE will queue
   behind it and pile up ~324K queries (set lock_timeout <= 2s + retry to avoid).
```

A static linter calls that migration safe. Ballast calls it a 🔥 critical outage —
because it looked at your database, not just your SQL. The lock behavior it cites
is drawn from an adversarially-verified Postgres correctness catalog, so the
`ACCESS EXCLUSIVE` and queue mechanics above aren't a guess — they're checked
against the official docs.

```bash
npx ballast-pg check migrations/ --dsn "$DATABASE_URL"
```

*Next in the encyclopedia: why `ADD COLUMN ... NOT NULL DEFAULT` is safe on Postgres
11+ — unless the default is `now()`.*

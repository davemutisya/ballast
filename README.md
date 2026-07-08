# Ballast

**Load-aware migration safety for the AI-agent era.** Ballast keeps production
stable when your coding agent ships a database migration — it predicts the real
blast radius (lock dwell time, blocked queries, lock-queue pileup) *before* the
migration runs, and rides inside the agent loop (Cursor / Claude Code / Copilot)
via MCP so the agent rewrites an unsafe change before a human ever sees it.

Not a linter. The static "this takes a lock" checklist is free (Squawk, Atlas).
Ballast's wedge is the thing static tools structurally can't do: weight every
finding by *your* real table size and load, in the agent loop, and get
progressively more accurate on your database over time.

## Status: v0.1 — launch-ready, unproven in market
Built and validated end-to-end; adoption + willingness-to-pay is the open question.
- **CLI (`ballast check`)** — a superset of Squawk: catches non-concurrent indexes,
  unsafe type changes, `ADD CHECK`/`FK`/`PRIMARY KEY`/`UNIQUE` (with `NOT VALID`
  de-escalation), `RENAME`, `REINDEX`, `VACUUM FULL`, defaults — each bound to a
  verified catalog entry with a safe rewrite and a source citation. `--explain`
  shows the depth. Exits non-zero on danger → CI gate (`docs/ci/`). Won't cry wolf:
  an index/constraint on a table `CREATE`d in the same migration is empty-table-safe
  and graded accordingly.
- **`ballast audit`** — the forensic sweep. Points at your *whole* migration history
  and reports the dangerous changes already in the repo, ranked by real blast radius
  at today's scale (with `--dsn`). A report, not a gate — the best first run. On the
  66-migration BomaOS history it surfaces 18 genuine time-bombs out of 134 statements.
- **Load-aware (`--dsn`)** — a read-only snapshot weights each finding by real table
  size + live transaction state. Spike 1 validated the model (CV ~10%, predictions
  in-band); the same `CREATE INDEX` is safe on 10 rows, critical on 3M. See
  `SPIKE1-RESULTS.md`.
- **`ballast calibrate`** — learns your DB's real throughput (local, private);
  progressive backoff generalizes one run across table shapes.
- **Correctness catalog** — 124 PostgreSQL entries authored from primary docs and
  **adversarially verified**; MySQL + SQL Server scoped (`docs/catalog/`).
  **Validated on 66 real BomaOS migrations** (caught 50+ real dangers).
- **Calibration/telemetry** — hierarchical per-environment posterior over a global
  prior; strict opt-in, anonymized, redaction-boundary contract (`src/calibration/`).
- **MCP server** (`ballast-mcp`) — `analyze_migration` in the agent loop.
- Publishable as `ballast-pg@0.1.0` (MIT). Not yet published / no users — that's next.

## Layout
```
src/
  cli/            check.ts, audit.ts, calibrate.ts, scan.ts, index.ts   (the `ballast` command)
  analyze.ts, lockModel.ts, loadModel.ts, parse.ts, snapshot.ts, types.ts   core
  catalog/        124 verified entries (postgres.generated.json) + loader + matcher
  calibration/    redaction-boundary contract + hierarchical calibration + store
  mcp.ts          MCP server — the agent-loop wedge
bin/              ballast, ballast-mcp
.github/workflows/ci.yml   repo CI (typecheck + build + dogfood)
spike/            Spike 1 (load model) + calibration self-test + MCP smoke test
examples/         sample migrations
docs/
  MCP.md              set up Ballast in the agent loop (Cursor / Claude Code / VS Code)
  KNOWN-LIMITATIONS.md  honest caveats — read before trusting a verdict
  blog/               incident encyclopedia (SEO content)
  ci/                 GitHub Action for the migration gate
  architecture/       DESIGN.md (telemetry corpus + multi-DB abstraction)
  catalog/            verification results, MySQL + SQL Server catalogs
PLAN.md · SPIKE1-RESULTS.md
```

## Where this is going
OSS adoption now (the `audit` hook + agent-loop MCP + a free PR-comment GitHub Action),
paid enforcement + connected-mode accuracy later, migration-safety as CI infrastructure
eventually. What it can't do yet — and where the load-aware edge is still unproven — is
written down honestly in **[docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md)**.

## Use
```bash
npm install && npm run build          # bundle CLI + MCP to dist/ (plain node, catalog inlined)

ballast audit migrations/                        # forensic sweep: what's already dangerous in the repo
ballast audit migrations/ --dsn "$DATABASE_URL"  # ...ranked by real blast radius at today's scale
ballast check migrations/                        # gate one change (structural); --explain for verified detail
ballast check migrations/ --dsn "$DATABASE_URL"  # load-aware: weight by real size + live load
ballast calibrate --dsn "$DATABASE_URL"          # learn YOUR db's throughput (local, private)
```
(From the repo without a global install: `node bin/ballast.js check migrations/`, or
`npm run check -- migrations/`.) `ballast check` exits non-zero on a danger/critical
finding → drops into CI as a gate. The `ballast-mcp` bin exposes `analyze_migration`
for the agent loop — setup in **[docs/MCP.md](docs/MCP.md)** (Cursor / Claude Code / VS Code).

## Dev / validation
```bash
docker compose -f docker-compose.spike.yml up -d   # ephemeral Postgres
npm run spike                    # Spike 1: load-model validation
npm run calib                    # calibration convergence + catalog load
npm run mcp-smoke                # call the MCP server over the real protocol
npm run typecheck
```

## The moat (honest)
The code is not the moat — a competitor rebuilds it in an afternoon. The moat is
three things earned over time: (1) the **calibration corpus** (per-environment +
crowd-primed accuracy no clone can match), (2) the **correctness catalog** kept
right where a generic LLM is subtly wrong, and (3) **trust** — never wrong about a
dangerous migration. The honest caveat: today only the *local* calibration is built;
the cross-user corpus is unproven (see
[KNOWN-LIMITATIONS §3](docs/KNOWN-LIMITATIONS.md#3-the-telemetry-corpus-is-a-design-not-a-dataset--the-moat-is-unbuilt)).

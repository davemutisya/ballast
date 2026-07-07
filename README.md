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

## Status: early build (validated core)
- **Spike 1 (PASS)** — lock dwell time is a predictable, calibratable function of
  table stats (CV ~10%); predictions land in-band; the lock-queue pileup on a
  "fast" ALTER reproduces. See `SPIKE1-RESULTS.md`.
- **Correctness catalog** — 124 PostgreSQL entries authored from primary docs and
  **adversarially verified** (`src/catalog/`, `docs/catalog/verification.json`).
  MySQL + SQL Server scoped (`docs/catalog/`).
- **Calibration/telemetry moat** — hierarchical per-environment posterior over a
  global prior; strict opt-in, anonymized, redaction-boundary contract
  (`src/calibration/`). `npx tsx spike/calibration-test.ts` shows it converge from
  the seed to an environment's true throughput.
- **MCP server** — `analyze_migration` in the agent loop (`src/mcp.ts`).

## Layout
```
src/
  analyze.ts, lockModel.ts, loadModel.ts, parse.ts, snapshot.ts   core analyzer
  catalog/        verified correctness catalog (data + loader)
  calibration/    telemetry contract (redaction boundary) + hierarchical calibration
  mcp.ts          MCP server — the agent-loop wedge
spike/            Spike 1 (load model) + calibration self-test + MCP smoke test
docs/
  strategy/GTM.md         how Cursor won + the sequenced plan to become the AI DBA
  architecture/DESIGN.md  telemetry corpus + multi-DB abstraction design
  catalog/                verification results, MySQL + SQL Server catalogs
PLAN.md            product/build plan, competitive analysis, kill-signals
founder-strategy-2026.md  (repo root parent) the decision + do-not-build list
```

## Run
```bash
docker compose -f docker-compose.spike.yml up -d   # ephemeral Postgres
npm install
npm run spike                    # Spike 1: load-model validation
npx tsx spike/calibration-test.ts  # calibration convergence + catalog load
npx tsx spike/mcp-smoke.ts       # call the MCP server over the real protocol
```

## The moat (honest)
The code is not the moat — a competitor rebuilds it in an afternoon. The moat is
three things earned over time: (1) the **calibration corpus** (per-environment +
crowd-primed accuracy no clone can match), (2) the **correctness catalog** kept
right where a generic LLM is subtly wrong, and (3) **trust** — never wrong about a
dangerous migration. See `docs/strategy/GTM.md`.

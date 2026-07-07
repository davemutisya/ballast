# Ballast — Product & Build Plan

> **Name:** Ballast (working — see "Name" below). *Ballast keeps a ship stable under
> load; Ballast keeps your production database stable when your AI ships a migration.*
>
> **One-liner:** Ballast predicts the real-world blast radius of a Postgres migration —
> under *your* actual table sizes and write load — before it merges, and rides *inside*
> the coding-agent loop (Cursor / Claude Code / Copilot) via MCP.
>
> Status: pre-build, July 2026. Strategy context: `~/Dev/founder-strategy-2026.md`.

---

## 1. The problem (the wound)

- AI agents now author most schema changes (Neon: >80% of new databases are created by
  agents, not humans). They generate migrations faster than any human can review.
- A migration that passes CI can still take an `ACCESS EXCLUSIVE` lock and take prod down.
  The *same* statement is a non-event on a 10-row table and a 40-second outage on a 400 GB
  table at 8k writes/sec.
- Static linters catch "this takes a lock." They cannot tell you whether it will actually
  *hurt* given your real load — and the agent that wrote the migration never sees the
  warning anyway.

## 2. Who it's for (ICP)

- **Users:** teams shipping Postgres schema changes via AI coding agents — startups/
  scaleups on Cursor/Claude Code whose prod DB has grown past toy size.
- **Buyer:** the eng lead / platform / DBA who owns "we broke prod with a migration."

## 3. Competitive reality (post-diligence — do not forget)

| Tool | Does | Doesn't |
|---|---|---|
| Squawk / strong_migrations / Atlas lint (free) | static lock-mode rules | load-aware, agent loop |
| **pgfence** (indie, MIT, ~9★) | static + safe rewrites + crude row-count risk buckets | lock-*duration*-under-load prediction; MCP/agent integration |
| **PostgresAI Migration Checker** (established) | runs migration on a thin *clone* of real-size data; enforces `max_lock_duration` | lightweight/no-clone; agent-native |

**Ballast's defensible intersection (the only open door):**
1. **Agent-native** — MCP server; the agent gets the blast-radius verdict *as it writes the
   migration*, not at CI. Nobody does this. = the "why now" + the distribution wedge.
2. **Load-aware duration prediction, no clone** — predict lock *dwell time* + queue blast
   radius from a lightweight read-only stats snapshot (rows, size, bloat, write TPS, avg
   txn duration, lock type, rewrite/scan cost). Beats pgfence's buckets; lighter than
   PostgresAI's clone. **This is the technical bet, and where DBA depth is the moat.**
3. **Telemetry data moat** — opt-in anonymized predicted-vs-actual lock outcomes across
   users → a corpus static tools and coding-agent vendors have no data flow to replicate.

Honest read: sharp niche, not open water. pgfence proves one person can build this (good)
and that we're not first (move fast).

### 3b. Why the incumbents failed + the Cursor lesson

**The trap they all fell into:** they treated the *analysis* as the product, and the
analysis wants to be free. Squawk/strong_migrations gave it away ($0). PostgresAI has the
best tech (test on a real-size clone) but it's heavy (clone infra), OSS-purist by choice
($1k/mo sponsor goal), and built for CI, not agents. pgfence is another static linter with
no agent loop. Atlas **paywalled its linter and got instantly cloned by free alternatives.**
Lesson: never charge for "telling you it's unsafe."

**The Cursor move (our wedge):** every existing tool was built for the *human-review era* —
run a linter in CI, or clone-test, and a human reads it before merge. The AI wave created a
new thing: **the agent writes the migration at machine speed and nobody knows if it hurts
prod under load.** Like Cursor rebuilt the editor around the agent (not "VS Code + AI
sidebar"), Ballast is the safety layer built for the **agent loop, not CI** — the agent gets
an instant load-aware verdict via MCP and rewrites its own migration *before a human sees
it.* Give the analysis away (distribution); charge for the gate that blocks + governance +
the telemetry model (the parts that can't be cloned).

## 4. MVP scope (product surface)

- **`ballast` CLI** — analyze a migration file (raw SQL + Prisma/Drizzle/TypeORM/Rails/
  Django) → lock modes, **predicted lock duration + blast radius** (given a stats
  snapshot), risk level, safe rewrite, rollback.
- **Stats ingestion** — `--stats-file` (JSON snapshot of `pg_stat_user_tables` + table
  sizes + write rates) OR a **read-only `ballast snapshot`** command. Never needs write/DDL
  prod credentials — turning "agents shouldn't have prod access" into the safety story.
- **`ballast-mcp` MCP server** — exposes `analyze_migration` so Cursor/Claude Code call it
  inline and get "this locks `users` ~38s under current load — here's the safe rewrite"
  *before* proposing the migration.
- **GitHub Action / CI gate** — free tier warns; paid tier blocks.
- **(Later) Cloud** — dashboards, org policy, history, the telemetry-trained risk model.

## 5. Architecture (first cut — confirm in spike)

- CLI in TypeScript (ecosystem + ORM parsers) unless the load model argues for Go.
- Parser: SQL + ORM formats → normalized DDL statements.
- **Lock model:** statement → Postgres lock type + rewrite/scan cost.
- **Load model (the hard part):** lock type + table stats → predicted dwell time + queue
  blast radius. First spike.
- Read-only snapshot collector.
- MCP server wrapping the analyzer.
- Cloud (later): stats ingestion, anonymized telemetry aggregation, risk model, dashboards.

## 6. The moat mechanism (be explicit)

OSS CLI/MCP → adoption + agent-loop installs. Opt-in anonymized telemetry records
predicted-vs-actual lock duration + table shape → central corpus → risk model that beats
first-principles prediction → paid-tier value + the thing incumbents can't quickly copy.

## 7. Licensing (decide before first public commit)

Permissive (MIT/Apache) for CLI + MCP to maximize adoption and agent-loop distribution;
keep Cloud + telemetry model proprietary. Consider BSL/Elastic-License on the Cloud
components so a cloud DB can't offer Ballast-as-a-service.

## 8. Go-to-market (OSS-led; distribution IS the product)

- GitHub is the channel — ship CLI + MCP, earn stars.
- **Content authority:** David writes the definitive pieces on "the AI-generated migration
  that took down prod," lock dwell time, load-aware safety. Own the narrative.
- **Agent-loop distribution:** "add Ballast to Cursor/Claude Code so it stops writing
  migrations that lock prod." MCP directory + launch.
- Channels: HN, r/PostgreSQL, r/devops, Postgres Weekly, dev.to, Prisma/Drizzle communities.
- Land-and-expand: individual free → team CI gate paid → Cloud/telemetry tier.

## 9. Pricing / monetization

- **Free:** OSS CLI + MCP + basic size-aware analysis.
- **Team** (~Atlas/Bytebase: $/seat or per-CI-project + per-monitored-DB): CI gate (block),
  dashboards, org policy.
- **Pro (moat tier):** telemetry-trained load prediction, historical tracking.
- **(Later) Enterprise:** multi-DB, on-prem, audit. Do NOT lead with warehouse data+logic
  parity — that's Datafold's fight.

## 10. Honest risks / first-sprint spikes (what we must PROVE, not assume)

1. **Technical (the crux):** can we predict lock dwell time + blast radius from lightweight
   stats accurately enough to be *obviously* better than pgfence's buckets and lighter than
   PostgresAI's clone? → **Spike 1:** build the load model for the top 5 dangerous patterns,
   validate against a deliberately loaded test DB.
2. **Distribution:** will devs install an MCP server for this? → ship MCP early, measure.
3. **Moat:** will enough users opt into telemetry to build the corpus? → design opt-in day 1.
4. **Competitive:** pgfence (solo, moving) + PostgresAI (established). Monitor. If pgfence
   adds MCP + load-duration, the gap narrows — move fast.
5. **Licensing:** pick the license that allows wide adoption but blocks cloud-DB-as-a-service.

### Honest defensibility verdict + kill-signals (pivot early on data, not faith)

**Defensible enough to start — a race, not a wall.** The real threat is not Redgate/pgfence;
it's the coding-agent vendors (Cursor/GitHub/Claude Code) who own the loop and the cloud DBs
(Neon/PlanetScale) who own the production data. Defense: cross-agent + cross-DB neutrality
(they won't build it), Postgres lock-semantics depth (they're horizontal), and the telemetry
corpus (they lack the data flow) — real but not bulletproof.

**Three kill-signals, all visible inside the 90-day window:**
1. A coding-agent vendor ships native load-aware migration safety → door closing; reconsider.
2. Nobody installs the MCP server → the agent-loop thesis (our whole differentiation) is wrong.
3. Teams use the free CLI but won't pay for the gate → we're PostgresAI ($0); pivot.

If none fire + we see adoption + one "caught what Squawk didn't" + one team willing to pay →
push/raise. If one fires early → pivot cheaply, on data.

## 11. 90-day plan + kill/continue

- **Wk 1–2:** Spike 1 (load-model feasibility, top-5 patterns) + name/repo/license.
- **Wk 3–5:** OSS CLI (analyze + snapshot + top ORMs) → public GitHub.
- **Wk 5–7:** MCP server → agent-loop demo → launch (HN + Postgres communities).
- **Wk 7–12:** reach 10 real users running real migrations; telemetry opt-in live; first
  paid conversations.
- **Continue criteria (set exact numbers on day 1, e.g.):** 200+ stars; 10 weekly-returning
  users; ≥1 "this caught something Squawk/pgfence didn't"; ≥1 team willing to pay for the CI
  gate; telemetry opt-in from ≥N users. Hit → push/raise. Miss *after real launch effort* →
  pivot with data, not dread.

## Name

**Ballast** (recommended). Stability under load; ownable; on-theme. Alternates: *Keel*,
*Chock*, *Dwell* (lock dwell time), *Richter* (predicts the magnitude), *Blastgate*. Final
call is David's; folder uses `ballast` until decided.

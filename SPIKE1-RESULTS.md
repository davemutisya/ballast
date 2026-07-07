# Spike 1 — Results (PASS)

**Question:** can we predict lock dwell time + blast radius from lightweight stats
(no clone, no prod write access)? **Answer: yes.** Run: `npm run spike`.

## 1. Dwell is a predictable, calibratable function of table size ✅
Measured actual lock-hold time for two scan-bound migrations across 250K→2M rows:

| op | throughput | variation (CV) | verdict |
|---|---|---|---|
| SET NOT NULL | ~38M rows/s | 10% | PREDICTABLE |
| CREATE INDEX (non-concurrent) | ~1.8M rows/s | 9% | PREDICTABLE |

After calibrating the two constants from measurement, **all six predictions landed
in-band, −9% to +17% error.** Dwell scales ~linearly with size; the model's *shape*
is physics, the *constant* is storage-dependent.

## 2. Calibration is the moat, not a guess ✅
Our seed constant for SET NOT NULL was ~5× off (guessed 8M rows/s; real 38M). The
error was a wrong constant, not a wrong model — CV stayed ~10%. This is the empirical
case for auto-calibration + the telemetry corpus: measure per-environment, don't guess.
Also a product win: a static linter screams "SET NOT NULL is dangerous!" on a 4M-row
table where it takes 0.1s, while CREATE INDEX genuinely takes 2.3s. Load-awareness
right-sizes the warning; blanket linters cry wolf.

## 3. The lock-queue pileup reproduces and is quantifiable ✅ (the differentiator)
A *metadata-only* ALTER (which every static linter marks "safe/fast") behind a
long-running reader:

| lock_timeout | probe SELECTs stalled >200ms | outcome |
|---|---|---|
| unset | **6/6 (100%)** | DDL applied after the long txn released |
| 1s | **2/68 (3%)** | DDL aborted (55P03); reads flowed |

A "fast" op stalled 100% of unrelated reads because it queued behind a long txn and
everything piled up behind it — invisible to any tool that only looks at the SQL.
Ballast predicts this from **live transaction age** (a field in the stats snapshot),
and shows `lock_timeout` bounds the blast. No static linter captures this.

## Implications for the build
- The load model is real → proceed to the OSS CLI + MCP server.
- **Snapshot must include live activity** (longest-running txn on the table), not just
  size — the queue amplifier is where we're most differentiated.
- **Auto-calibration** (measure throughput on the user's own DB) is a first-class
  feature and the seed of the telemetry moat.

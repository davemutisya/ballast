# Known limitations & honest caveats

Ballast is v0.1. These are the things it does **not** yet do well — stated plainly so
nobody ships on a false sense of safety. Several came from an external code review;
they're real, and some strike at the core pitch.

## 1. Authoring-time vs deploy-time — the temporal gap (the big one)

The MCP verdict is computed **when the agent writes the migration.** The migration
usually **runs later** — minutes to days — at deploy time. So a live reading like
"a transaction has held a lock for 4.2s *right now*" has little predictive value for a
deploy that happens tomorrow at 2am.

- **Survives the gap:** table size, typical write/read TPS, catalog correctness, and
  the *education* that this statement is lock-queue-sensitive and needs a bounded
  `lock_timeout` + retry.
- **Does not survive:** the specific live-transaction reading — the very field we call
  our biggest differentiator.

**Consequence, stated honestly:** without a deploy-time check, the live-load edge
partly degrades toward *size-awareness*, which cheaper row-count-bucket tools already
approximate. The instantaneous-load story is only fully real if Ballast also runs at
deploy.

**The fix (roadmap — `ballast observe`):** a deploy-time guard that runs the same
snapshot *at migration time* (inside the migration tool / CI deploy step) and
aborts-or-injects-`lock_timeout` when the live state is hostile. Authoring-time =
advice; deploy-time = enforcement. Only authoring-time exists today.

## 2. Calibration extrapolates from small tables — the cache cliff

`ballast calibrate` measures throughput on ephemeral 100K–1M-row tables, often on
cached / tmpfs storage, then extrapolates **linearly** (dwell ∝ rows or bytes) to
100M-row / 50GB tables. Real systems have a **cache-residency cliff**: once the working
set exceeds RAM, per-row cost jumps and linearity breaks. Spike 1 already showed the
constant is ~5× storage-sensitive.

So today's predictions are most trustworthy in the regime where they matter least
(small / cached) and least trustworthy where they matter most (large / uncached).

**Mitigations (roadmap):** calibrate at multiple size points and fit the cliff; widen
the uncertainty band with size and when `bytes >> RAM`; prefer the real telemetry
corpus (actual production dwells) over synthetic extrapolation. **Until then:** treat
large-table dwell as an order-of-magnitude estimate, not a stopwatch, and trust the
qualitative verdict (safe / danger) more than the exact seconds.

## 3. The telemetry corpus is a design, not a dataset — the moat is unbuilt

The redaction contract, fingerprint, and hierarchical model are real, and the **local**
calibration path works end-to-end (measure → `~/.ballast/calibration.json` → Bayesian
combine → predictions). But:

- There is **no network ingestion** yet.
- More importantly, there is **no capture of predicted-vs-actual dwell** from real
  migrations — which is the gold training signal, and the thing a competitor can't
  copy. It isn't wired.
- The plan's own spike conclusion (local calibration captures most of the accuracy)
  implies the cross-user corpus may mostly help **cold starts** — a thin thing to hang
  an entire paid tier on until proven.

**Honest read:** local calibration is a genuine feature today; the compounding
cross-user data moat is *unproven and is the single biggest strategic risk.* Validate
it early — does connected accuracy beat local by enough that a team would pay? — before
betting the pricing on it. See [VISION §4](VISION.md) and the kill criteria in §7.

## 4. Smaller gaps (tracked)

- ~~**Unrecognized DDL passes the gate.**~~ **Resolved in 0.2.0:** Ballast now parses
  with `libpg_query` — PostgreSQL's own parser — so dollar-quoted bodies, multi-command
  ALTERs, and schema-qualified names are handled by the real grammar, and any statement
  we can't classify is *reported* ("N statements could NOT be analyzed"), never silently
  skipped. Still true: a statement type we haven't mapped isn't *analyzed* (it's
  disclosed), and ORM migration formats (Rails/Django/Prisma source files) aren't read —
  point Ballast at the generated SQL.
- **No credential-free stats path yet.** Load-aware mode needs a read-only DSN today;
  the `ballast snapshot` export + `--stats-file` (so an agent never needs *any* prod
  access) is designed but not built — it slightly undercuts the safety story until
  shipped. Roadmap.
- **Uncertainty band** (low/high) is computed but only partly surfaced in output.
- **No timeout-hygiene rule yet.** Squawk's `require-timeout-settings` flags
  migrations that don't `SET lock_timeout` before slow DDL; Ballast advises it in
  rewrites but doesn't enforce it as a rule (found in our own
  [benchmark](COMPARISON.md) — backlog).
- **App-level (non-lock) breakage checks** strong_migrations has and we don't:
  `json`-column equality quirk, `ALTER TYPE … RENAME VALUE`, schema renames. Backlog.
- **MCP setup:** see [MCP.md](MCP.md).

---

**The discipline:** Ballast would rather say "danger" and be annoying than say "safe"
and be wrong. Where it cannot know — large uncached tables, future deploy-time load —
it should widen the band and defer to the conservative verdict, **not fake precision.**
Every item above is a place we are not yet living up to that standard, written down so
we fix it instead of forgetting it.

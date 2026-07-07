I have full context now. Here is the design.

---

# Ballast — Design: (1) Telemetry/Calibration Corpus and (2) Multi-DB Abstraction

Grounded in the existing code: `predictDwell` already models dwell as `size / throughputConstant` per `CostClass`, `loadModel.ts` already hardcodes a `Calibration` struct and a `0.5×/2.5×` band, `snapshot.ts` is already read-only and flagged as "the ingestion point for the calibration corpus," and `SPIKE1-RESULTS.md` proves throughput is log-normal with CV ~10% and the seed constant was ~5× off. Both designs below plug into those seams without rewriting the core.

---

## PART 1 — THE TELEMETRY / CALIBRATION CORPUS (the moat)

### 1.1 The core idea in one paragraph

Dwell = `size / rate`. The *shape* (linear in rows or bytes per cost class) is physics and is fixed. The *rate* constant is storage-dependent and today is a guess (`DEFAULT_CALIBRATION`). The moat is turning that guess into (a) a **per-environment posterior** measured on the user's own DB, and (b) a **global prior** aggregated across all opt-in installs so a brand-new environment starts from the crowd's best estimate for its hardware/size class instead of our seed. The privacy-preserving unit of exchange is a **bucketed table fingerprint + predicted-vs-actual rate** — never SQL, names, or data.

### 1.2 What we collect — the observation record

One record per measured lock event. Two ingestion sources, same schema:
- **Calibration runs** — `ballast calibrate` builds ephemeral throwaway tables on the user's DB and times scan/index/rewrite ops. No prod data touched.
- **Real outcomes** — when a migration actually executes (CI gate or `ballast observe` wrapper), we measure actual held time and compare to what we predicted. This is the gold signal that trains the corpus.

```ts
// src/calibration/contract.ts  — the ONLY types that cross the network.
// Shared verbatim by client and (proprietary) server. Zod = the redaction boundary:
// anything not in this schema physically cannot leave.
import { z } from 'zod';

export const CostClass = z.enum(['METADATA_ONLY', 'SCAN', 'REWRITE']);
export const Engine    = z.enum(['postgres', 'mysql', 'sqlserver']);

// Bucketed, non-reversible. NO row/byte exact counts, NO names, NO SQL, NO values.
export const TableFingerprint = z.object({
  rowBucket:     z.enum(['0','<1e3','1e3-1e4','1e4-1e5','1e5-1e6','1e6-1e7','1e7-1e8','1e8-1e9','>=1e9']),
  byteBucket:    z.enum(['<1MB','1-10MB','10-100MB','100MB-1GB','1-10GB','10-100GB','100GB-1TB','>=1TB']),
  indexBucket:   z.enum(['0','1','2','3-5','6-10','>10']),
  storageClass:  z.enum(['local-nvme','local-ssd','ebs-gp3','ebs-io2','network-ssd','managed-cloud','unknown']),
  engineVersionMajor: z.string().regex(/^\d{1,2}$/),   // "16", "8", "15" — major only
});

export const DwellObservation = z.object({
  schemaVersion: z.literal(1),
  engine:        Engine,
  costClass:     CostClass,
  statementKind: z.string(),          // BOUNDED enum from our classifier, e.g. 'CREATE_INDEX' — never user text
  lockMode:      z.string(),          // bounded, e.g. 'ACCESS EXCLUSIVE'
  concurrent:    z.boolean(),
  fingerprint:   TableFingerprint,

  // The training signal:
  measuredRate:      z.number(),      // size / actualSeconds, in rows/s or bytes/s per costClass
  predictedSeconds:  z.number(),
  actualSeconds:     z.number(),
  rateSourceAtPredict: z.enum(['seed','global-prior','env-posterior']),
  observationSource:   z.enum(['calibration','real-migration']),

  installId: z.string().uuid(),       // salted, rotating (see 1.4) — NOT a user/account id
  ts:        z.number(),              // epoch ms, rounded to the hour (coarsened)
});
export type DwellObservation = z.infer<typeof DwellObservation>;
```

**Explicitly never collected:** schema/table/column names, SQL text, DSNs, hostnames, IPs (server drops them), any row values, exact sizes, query text. The `statementKind`/`lockMode` are closed enums produced by *our* classifier, so no user string ever transits. Bucketing gives **k-anonymity**: `1e8-1e9 rows / 10-100GB / ebs-gp3 / pg16` describes thousands of tables.

### 1.3 Bucketing / fingerprint module

```ts
// src/calibration/fingerprint.ts
export function bucketRows(n: number): TableFingerprint['rowBucket'] { /* log10 thresholds above */ }
export function bucketBytes(b: number): TableFingerprint['byteBucket'] { /* power-of-10 thresholds */ }
export function bucketIndex(k: number): TableFingerprint['indexBucket'] { /* 0,1,2,3-5,6-10,>10 */ }
export function fingerprint(stats: CatalogStats, engineVersionMajor: string): TableFingerprint;

// The bucket KEY used to look up priors and index the corpus (order-stable, hashable):
export function bucketKey(engine, costClass, statementKind, fp): string
  // e.g. "postgres|SCAN|CREATE_INDEX|1e7-1e8|1-10GB|3-5|ebs-gp3|16"
```

### 1.4 Opt-in + privacy model (production-adjacent, so strict)

1. **Off by default.** No network egress unless `telemetry.enabled: true` is written to `~/.ballast/config.json` or `BALLAST_TELEMETRY=1`. First run prints a one-screen notice and the exact fields (§1.2) with a link; nothing is sent during that run.
2. **Local-first.** Per-environment calibration (§1.5) works with telemetry **disabled** — you get auto-calibration on your own DB even if you never share. Sharing only buys you the global prior for cold starts. This makes opt-in a value trade, not a tax.
3. **Redaction by construction.** The only serializer is `DwellObservation.parse()`. There is no code path that puts SQL/names on the wire; a unit test asserts the payload matches the schema exactly.
4. **`--dry-run-telemetry`** prints the exact JSON batch that *would* be sent. Radical transparency.
5. **Anonymous, rotating `installId`.** `installId = HMAC(dailySalt, machineId)` rotated on a rolling window; it's a de-dup/rate key, not identity. No account linkage on the free tier. Paid tier can opt into a stable `orgId` for its *own* dashboards, stored separately from the anonymous corpus.
6. **Server-side k-anonymity gate.** A global prior for a `bucketKey` is only *served* once ≥ K distinct `installId`s (K=5) have contributed to it. Below K, clients fall back to the seed default. Prevents a bucket from fingerprinting a single environment.
7. **Coarsening & retention.** `ts` rounded to the hour; raw observations retained 90 days then collapsed into prior sufficient-statistics only (`n, Σx, Σx²` per bucket) and raw dropped.
8. **No PII, ever** — so no DSR/erasure surface on the free path; the paid `orgId` path is separately deletable.

### 1.5 How it feeds calibration — hierarchical (per-env posterior over a global prior)

Work in log space because throughput is log-normal (Spike 1: CV ~10%, multiplicative noise). For each `bucketKey` let `x = ln(rate)`.

- **Global prior** (from corpus): `N(μ_g, σ_g²)` — server aggregates all installs' `x`.
- **Per-environment posterior**: starts at the prior, updated by local calibration/real observations with measurement variance `τ²` (τ ≈ 0.10 from Spike 1 CV):

```
precisionPost = 1/σ_g²        + n_local / τ²
meanPost      = ( μ_g/σ_g²    + (Σ x_local)/τ² ) / precisionPost
rateForPredict = exp(meanPost)
bandSigma      = sqrt( 1/precisionPost + τ² )   // → principled DwellPrediction.low/high
```

This one formula delivers **both requirements**: cold start uses `μ_g` (or seed if the bucket is below k-anonymity); after a handful of local runs the `n_local/τ²` term dominates and the estimate becomes the environment's own constant. It also replaces the hardcoded `0.5×/2.5×` band in `loadModel.ts` with `exp(meanPost ± 2·bandSigma)`.

```ts
// src/calibration/model.ts
export interface RateEstimate { rate: number; logMean: number; logVar: number; n: number;
                                source: 'seed'|'global-prior'|'env-posterior'; }
export function combine(prior: Gaussian | null, seed: number, local: LocalStats): RateEstimate;
export function bandFrom(est: RateEstimate, tau = 0.10): { low: number; high: number };

// src/calibration/store.ts  — local per-env state, ~/.ballast/calibration.json
export interface CalibrationStore {
  get(bucketKey: string): LocalStats | null;      // { n, sumLogRate, sumLogRate2 }
  record(bucketKey: string, measuredRate: number): void;  // online update of sufficient stats
  toCalibration(engine): Calibration;              // adapts to loadModel's existing Calibration struct
}
```

Note: `loadModel.predictDwell(costClass, kind, stats, cal)` stays exactly as is. We just source `cal` per-`bucketKey` from the store instead of `DEFAULT_CALIBRATION`. The load model never learns telemetry exists.

### 1.6 Client → server contract

```
POST /v1/observations           # opt-in upload, batched, gzip
  body:  { batch: DwellObservation[] }         # ≤500/req, validated by contract.ts
  auth:  Bearer <anonymous install token>      # or org token (paid)
  200:   { accepted: n, priors?: PriorBundle }  # piggyback refreshed priors

GET  /v1/priors?engine=postgres&since=<etag>
  200:   PriorBundle  # only buckets past k-anonymity gate
         { updatedAt, priors: [{ bucketKey, logMean, logVar, n, contributors }] }
         # served with ETag; client caches to ~/.ballast/priors.json, refreshes daily
```

Client is fire-and-forget, capped (batch flush every N obs or 24h), never blocks analysis, silently no-ops offline. Server aggregation is a per-bucket streaming Gaussian: `μ_g, σ_g²` from `n, Σx, Σx²`; robustified with median/MAD trimming to resist a poisoned install.

```ts
// src/calibration/telemetry.ts  — the client
export interface Telemetry {
  enabled: boolean;
  observe(o: DwellObservation): void;   // buffer; parse()-gated; drop if disabled
  flush(): Promise<void>;
  refreshPriors(engine): Promise<PriorBundle>;
}
```

### 1.7 Measuring "actual" (so predicted-vs-actual is real)

- **Calibration path:** `adapter.calibrate()` times its own throwaway-table ops → exact `actualSeconds`.
- **Real-migration path:** `ballast observe` brackets the DDL — `t0` before, `t1` when the statement returns (≈ held time for SCAN/REWRITE). For the queue-pileup case it reads wait events from live activity (Postgres `pg_locks`/`pg_stat_activity`; adapter-specific, see Part 2). Both emit a `real-migration` observation, the highest-value corpus signal.

---

## PART 2 — THE MULTI-DATABASE ABSTRACTION

### 2.1 Principle: only lock semantics are DB-specific; the load math is universal

The load model is already engine-agnostic: it consumes `CostClass`, `rows`/`bytes`, `readTps`/`writeTps`, `longestRunningTxnSec`, and a throughput constant. None of that is Postgres-specific. What *is* Postgres-specific lives in three places that must move behind an adapter: **parsing** (dialect + ORMs), **lock facts** (which lock a statement takes and what it blocks — MySQL `ALGORITHM=INPLACE/COPY`, SQL Server `ONLINE=ON`, differ wildly), and **snapshot** (catalog queries). So: keep `loadModel.ts` and severity scoring in a shared core; put parse/lockFacts/snapshot/calibrate behind a `DbAdapter`.

### 2.2 Catalog data schema (DB-agnostic) — generalize `StatsSnapshot`

`StatsSnapshot` today is already almost engine-neutral. Rename to `CatalogStats` and add the fields the fingerprint and adapters need:

```ts
// src/types.ts  (extend)
export interface CatalogStats {
  engine: 'postgres' | 'mysql' | 'sqlserver';
  engineVersionMajor: string;    // "16" | "8" | "15"
  table: string;                 // used locally for messaging; NEVER leaves (fingerprint drops it)
  rows: number;
  bytes: number;
  indexCount: number;            // NEW — feeds fingerprint + some cost classes
  writeTps: number;
  readTps: number;
  longestRunningTxnSec: number;  // "oldest active statement" — universal concept, per-engine query
  lockTimeoutMs: number | null;  // pg lock_timeout / mysql lock_wait_timeout / mssql LOCK_TIMEOUT
  storageClass: CatalogStats extends never ? never : string; // declared in config or inferred
}
```

`LockMode` today is a Postgres string union. Generalize: the shared core treats lock identity as opaque + two booleans it already relies on:

```ts
export interface LockFacts {
  lockLabel: string;       // engine-native display, e.g. 'ACCESS EXCLUSIVE' | 'METADATA + COPY' | 'Sch-M'
  costClass: CostClass;    // the ONLY thing loadModel needs
  blocksReads: boolean;    // engine decides; core consumes
  blocksWrites: boolean;
  safeRewrite: string | null;
  online: boolean;         // NEW — engine did it without a rewrite/heavy lock (MySQL INPLACE, mssql ONLINE)
}
```

`Statement` gains `dialect` and keeps `kind` as a **normalized cross-engine enum** (`CREATE_INDEX`, `SET_NOT_NULL`, `ALTER_TYPE`, `ADD_COLUMN_DEFAULT_CONST/VOLATILE`, `DROP_COLUMN`, …). Each adapter's parser maps its dialect onto these shared kinds; unknown → `UNKNOWN` (adapter supplies the dangerous default, as `lockModel.ts` does today).

### 2.3 The adapter interface

```ts
// src/adapters/adapter.ts
export interface DbAdapter {
  readonly engine: 'postgres' | 'mysql' | 'sqlserver';

  // 1. dialect + ORM parse → normalized Statements (shared `kind` enum)
  parse(sql: string): Statement[];

  // 2. statement → lock facts (the engine-specific DBA depth)
  lockFacts(stmt: Statement, ctx: LockContext): LockFacts;
  //   ctx carries engineVersionMajor (PG12 skips SET NOT NULL rescan; MySQL 8 vs 5.7 online DDL differ)

  // 3. read-only live stats (SELECT-only creds; no data, no DDL)
  snapshot(conn: Connection, table: string): Promise<CatalogStats>;

  // 4. measure throughput constants on THIS environment (ephemeral throwaway tables)
  calibrate(conn: Connection, opts?: CalibrateOpts): Promise<Array<{
    bucketKey: string; costClass: CostClass; measuredRate: number; actualSeconds: number;
  }>>;

  // for the queue-amplifier + real-migration observation:
  observeLive(conn: Connection, table: string): Promise<LiveActivity>;
}

export interface LockContext { engineVersionMajor: string; }
export interface Connection { /* thin wrapper; adapter owns the driver (pg, mysql2, mssql) */ }

// registry — analyze() picks the adapter by DSN scheme or explicit engine
export function adapterFor(engine): DbAdapter;
export function adapterForDsn(dsn: string): DbAdapter;  // postgres:// mysql:// sqlserver://
```

### 2.4 How the shared load model stays DB-agnostic

The pipeline in `analyze.ts` becomes adapter-parameterized but otherwise unchanged:

```ts
// src/core/analyze.ts
export async function analyze(sql: string, conn: Connection, adapter: DbAdapter,
                              store: CalibrationStore): Promise<Finding[]> {
  const stmts = adapter.parse(sql);
  return Promise.all(stmts.map(async (stmt) => {
    const stats = await adapter.snapshot(conn, stmt.table!);
    const facts = adapter.lockFacts(stmt, { engineVersionMajor: stats.engineVersionMajor });

    // --- everything below is ENGINE-AGNOSTIC and already exists ---
    const cal   = store.toCalibration(stats.engine);         // Part 1 posterior, per bucketKey
    const dwell = predictDwell(facts.costClass, stmt.kind, stats, cal);   // unchanged fn
    const blast = predictBlast(facts.lockLabel, facts.blocksReads, facts.blocksWrites, dwell, stats);
    const severity = scoreSeverity(dwell.seconds, blast);
    // + emit DwellObservation on real-migration path (Part 1)
    return buildFinding(stmt, facts, dwell, blast, severity);
  }));
}
```

`loadModel.ts` and `severity`/`verdict` rendering **do not change** — they never mention Postgres. The only edits are: `predictBlast` takes `lockLabel: string` instead of the PG `LockMode` union, and `Calibration` is now sourced per-`bucketKey` instead of the constant. Engine differences (MySQL `INPLACE` = often `METADATA_ONLY`+brief lock; SQL Server `ONLINE=ON` index = `SCAN` cost but `blocksWrites:false`; SQL Server `Sch-M` = blocks everything like `ACCESS EXCLUSIVE`) are fully expressed by each adapter's `lockFacts` returning the right `costClass`/booleans/`online`.

### 2.5 Calibration corpus is engine-partitioned

`bucketKey` already begins with `engine` (§1.3), so Postgres, MySQL, and SQL Server priors never cross-contaminate — a MySQL `INPLACE` index build and a PG non-concurrent build are different rate populations and stay in different buckets. The hierarchical model (§1.5) runs identically per engine. One corpus, cleanly sharded by the key.

### 2.6 File / module layout

```
src/
  types.ts                     # CatalogStats, LockFacts, Statement(+dialect), CostClass, Finding
  core/
    loadModel.ts               # UNCHANGED math: predictDwell / predictBlast (predictBlast takes lockLabel:string)
    severity.ts                # scoreSeverity + renderVerdict (extracted from analyze.ts)
    analyze.ts                 # adapter-parameterized orchestration (§2.4)
  adapters/
    adapter.ts                 # DbAdapter, Connection, registry (adapterFor / adapterForDsn)
    postgres/
      index.ts                 # PostgresAdapter implements DbAdapter (wraps existing code)
      parse.ts                 # (existing parse.ts) + Prisma/Drizzle/TypeORM/Rails/Django
      lockModel.ts             # (existing) → returns LockFacts incl. online:false
      snapshot.ts              # (existing) + indexCount, engineVersionMajor, storageClass
      calibrate.ts             # ephemeral-table throughput measurement (from spike1)
    mysql/
      index.ts parse.ts lockModel.ts snapshot.ts calibrate.ts   # information_schema, ALGORITHM/LOCK
    sqlserver/
      index.ts parse.ts lockModel.ts snapshot.ts calibrate.ts   # sys.dm_*, ONLINE=ON, Sch-M
  calibration/
    contract.ts                # zod wire types (DwellObservation, TableFingerprint, PriorBundle) — redaction boundary
    fingerprint.ts             # bucketRows/Bytes/Index, bucketKey
    model.ts                   # hierarchical Gaussian combine() + band
    store.ts                   # ~/.ballast/calibration.json, local sufficient-stats, toCalibration()
    telemetry.ts               # opt-in client: observe/flush/refreshPriors, dry-run, install token
  mcp.ts                       # unchanged surface; now routes via adapterForDsn(dsn)
  cli/
    calibrate.ts observe.ts    # `ballast calibrate` / `ballast observe` (Part 1 ingestion points)

server/  (separate, proprietary package — BSL, per PLAN §7)
  ingest.ts                    # POST /v1/observations, contract.parse, k-anon gate
  prior.ts                     # streaming per-bucket Gaussian, MAD-trim, GET /v1/priors
```

### 2.7 Migration path (incremental, no big-bang)

1. Rename `StatsSnapshot`→`CatalogStats`, add `engine/indexCount/engineVersionMajor/storageClass`; change `predictBlast` param to `lockLabel: string`. (Postgres-only still works.)
2. Wrap existing `parse.ts`/`lockModel.ts`/`snapshot.ts` as `PostgresAdapter`; add the registry; MCP routes through it. No behavior change.
3. Land `calibration/` (store + model + fingerprint) with telemetry **off** — pure local auto-calibration; replaces the hardcoded band. Ship value before any network.
4. Turn on opt-in client + stand up `server/` behind the k-anon gate.
5. Add `mysql/` then `sqlserver/` adapters — each is ~4 files and reuses 100% of `core/` and `calibration/`.

### 2.8 Load-bearing engine gotchas the adapters must encode (so the moat is real DBA depth, not a shim)

- **Postgres:** already correct in `lockModel.ts`; add PG12+ `SET NOT NULL` fast-path via `LockContext.engineVersionMajor`, and `indexCount` for CREATE INDEX predictions.
- **MySQL/InnoDB:** `ALGORITHM=INPLACE, LOCK=NONE` → often `METADATA_ONLY` + brief metadata lock (`online:true`); `ALGORITHM=COPY` or implicit copy (e.g. `ADD COLUMN` on 5.7, `CHANGE COLUMN` type) → `REWRITE`, `blocksWrites:true`. The DBA value is knowing which ALTER silently falls back to COPY. `longestRunningTxnSec` from `information_schema.INNODB_TRX`.
- **SQL Server:** `CREATE INDEX ... WITH (ONLINE=ON)` → `SCAN` cost but `blocksWrites:false` (Enterprise only — adapter must check edition); offline index or most `ALTER COLUMN` → `Sch-M` lock = blocks *everything* (`blocksReads:true`), the direct analog of `ACCESS EXCLUSIVE`. `longestRunningTxnSec` from `sys.dm_exec_requests`.

Each of those maps cleanly onto the existing `{costClass, blocksReads, blocksWrites, online}` and flows into the unchanged load math — which is exactly why one analyzer core serves all three engines.

---

**Net:** Part 1 upgrades the existing `Calibration` constant into a hierarchical posterior (env-measured, globally-primed, bucket-anonymized) fed by a zod-gated wire contract that can only emit bucketed fingerprints. Part 2 factors the three Postgres-specific concerns (parse, lockFacts, snapshot/calibrate) behind a `DbAdapter` while `loadModel.ts` and severity scoring stay byte-for-byte engine-agnostic. Both are additive to the current tree and implementable file-by-file in the order in §2.7.
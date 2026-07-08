// ── Ballast Spike 1 ─────────────────────────────────────────────────────────
// The make-or-break question: can we predict lock dwell time + blast radius from
// lightweight stats (no clone, no prod write access)?
//
// Experiment A — Dwell predictability: measure actual lock-hold time for two
//   scan-bound migrations (SET NOT NULL, non-concurrent CREATE INDEX) across
//   several table sizes. If dwell is ~linear in rows, the model is calibratable
//   and the bet is real. We also grade the *product* prediction against truth.
//
// Experiment B — Blast radius: with a write probe at a known rate, does the
//   number of blocked writes ≈ rate × dwell (our formula)?
//
// Experiment C — Lock queue: prove that a *fast* metadata-only ALTER behind a
//   long-running txn stalls unrelated SELECTs — and that lock_timeout bounds it.
//   This is the load-aware insight no static linter captures.
//
// Run:  docker compose -f docker-compose.spike.yml up -d && npm run spike
// ────────────────────────────────────────────────────────────────────────────

import pg from 'pg';
const { Client } = pg;

import { analyzeStatement } from '../src/analyze.ts';
import { DEFAULT_CALIBRATION } from '../src/loadModel.ts';
import { parse } from '../src/parse.ts';
import type { StatsSnapshot } from '../src/types.ts';

const CONN = 'postgres://postgres:ballast@localhost:5433/ballast_spike';
const SIZES = [250_000, 1_000_000, 2_000_000];

const newClient = async () => { const c = new Client({ connectionString: CONN }); await c.connect(); return c; };
const ms = (fn: () => Promise<unknown>) => timed(fn);
async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t = process.hrtime.bigint(); await fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

async function setupTable(c: pg.Client, n: number) {
  await c.query('DROP TABLE IF EXISTS bench');
  await c.query(`CREATE TABLE bench (id bigint PRIMARY KEY, val text NOT NULL, n_col int)`);
  await c.query(`INSERT INTO bench SELECT g, md5(g::text), g FROM generate_series(1,$1) g`, [n]);
  await c.query('ANALYZE bench');
}

async function statsFor(c: pg.Client, writeTps: number, readTps: number): Promise<StatsSnapshot> {
  const { rows } = await c.query(
    `SELECT reltuples::bigint AS rows, pg_total_relation_size('bench') AS bytes FROM pg_class WHERE relname='bench'`,
  );
  return {
    table: 'bench', rows: Number(rows[0].rows), bytes: Number(rows[0].bytes),
    writeTps, readTps, longestRunningTxnSec: 0, lockTimeoutMs: null,
  };
}

function grade(predicted: number, low: number, high: number, actual: number): string {
  const inBand = actual >= low && actual <= high;
  const err = ((predicted - actual) / actual) * 100;
  return `${inBand ? 'IN-BAND ✅' : 'OUT ❌'}  (pred ${predicted.toFixed(2)}s [${low.toFixed(2)}–${high.toFixed(2)}], err ${err >= 0 ? '+' : ''}${err.toFixed(0)}%)`;
}

// ── Experiment A + B ────────────────────────────────────────────────────────
async function experimentA(c: pg.Client) {
  console.log('\n══ Experiment A — Dwell predictability (SET NOT NULL, CREATE INDEX) ══\n');
  const rec: { op: string; rows: number; dwellMs: number }[] = [];

  for (const n of SIZES) {
    await setupTable(c, n);
    const stats = await statsFor(c, 500 /*writeTps*/, 2000 /*readTps*/);

    // SET NOT NULL — ACCESS EXCLUSIVE, scan-bound.
    const setNotNull = `ALTER TABLE bench ALTER COLUMN n_col SET NOT NULL`;
    const d1 = await ms(() => c.query(setNotNull));
    rec.push({ op: 'SET_NOT_NULL', rows: stats.rows, dwellMs: d1 });
    await report(setNotNull, stats, d1);
    await c.query(`ALTER TABLE bench ALTER COLUMN n_col DROP NOT NULL`);

    // CREATE INDEX (non-concurrent) — SHARE, scan/build-bound.
    const createIdx = `CREATE INDEX bench_val_idx ON bench (val)`;
    const d2 = await ms(() => c.query(createIdx));
    rec.push({ op: 'CREATE_INDEX', rows: stats.rows, dwellMs: d2 });
    await report(createIdx, stats, d2);
    await c.query('DROP INDEX bench_val_idx');
  }

  // Linearity check: is dwell/rows (the implied throughput) stable across sizes?
  console.log('\n── Linearity (is dwell a predictable function of size?) ──');
  for (const op of ['SET_NOT_NULL', 'CREATE_INDEX']) {
    const pts = rec.filter((r) => r.op === op);
    const rates = pts.map((p) => (p.rows / (p.dwellMs / 1000)));
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    const cv = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length) / mean;
    console.log(
      `  ${op}: throughput ${(mean / 1e6).toFixed(1)}M rows/s, ` +
      `variation (CV) ${(cv * 100).toFixed(0)}%  →  ${cv < 0.35 ? 'PREDICTABLE ✅' : 'noisy ❌'}`,
    );
  }

  async function report(sql: string, stats: StatsSnapshot, actualMs: number) {
    const stmt = (await parse(sql))[0];
    const f = analyzeStatement(stmt, stats, DEFAULT_CALIBRATION);
    console.log(`  ${stmt.kind} @ ${(stats.rows / 1e6).toFixed(2)}M rows — actual ${(actualMs / 1000).toFixed(2)}s  ${grade(f.dwell.seconds, f.dwell.low, f.dwell.high, actualMs / 1000)}`);
  }
}

// ── Experiment C — the lock queue ───────────────────────────────────────────
async function experimentC(main: pg.Client) {
  console.log('\n══ Experiment C — Lock-queue pileup (the load-aware insight) ══\n');
  await setupTable(main, 500_000);

  for (const guard of [false, true]) {
    const longTxn = await newClient();
    const ddl = await newClient();
    const probe = await newClient();

    // 1. A long-running reader holds ACCESS SHARE on bench.
    await longTxn.query('BEGIN');
    await longTxn.query('SELECT count(*) FROM bench'); // holds ACCESS SHARE until commit

    // 2. Fire a fast metadata-only ALTER (ACCESS EXCLUSIVE). It will BLOCK behind
    //    the reader. With the guard, it fails fast via lock_timeout.
    if (guard) await ddl.query(`SET lock_timeout='1s'`);
    const ddlPromise = ddl
      .query(`ALTER TABLE bench ADD COLUMN tmp_col int`)
      .then(() => 'applied').catch((e) => `blocked/aborted (${String(e.code)})`);

    // 3. Meanwhile, fire fast SELECTs that only need ACCESS SHARE. They should
    //    queue *behind* the blocked ALTER even though they don't conflict with
    //    the reader — the pileup. statement_timeout so a queued probe returns
    //    (as "stalled") instead of hanging the harness forever.
    await probe.query(`SET statement_timeout='400ms'`);
    let stalled = 0, total = 0;
    const until = Date.now() + 2500;
    while (Date.now() < until) {
      total++;
      const t0 = Date.now();
      try { await probe.query('SELECT 1 FROM bench LIMIT 1'); } catch { /* timed out = queued */ }
      if (Date.now() - t0 > 200) stalled++;
      await sleep(20);
    }

    await longTxn.query('COMMIT'); // release; let the ALTER proceed (if not aborted)
    const ddlResult = await ddlPromise;

    console.log(
      `  lock_timeout ${guard ? '= 1s ' : 'unset'}: ${stalled}/${total} probe SELECTs stalled >200ms ` +
      `during a "fast" ALTER — DDL ${ddlResult}`,
    );

    await main.query('ALTER TABLE bench DROP COLUMN IF EXISTS tmp_col');
    for (const c of [longTxn, ddl, probe]) await c.end();
  }
  console.log('\n  → A metadata-only ALTER is a non-event alone, but behind a long txn it stalls\n' +
    '    unrelated reads. Ballast predicts this from live txn age; lock_timeout bounds it.');
}

async function main() {
  const c = await newClient();
  console.log('Ballast Spike 1 — is load-aware dwell/blast prediction feasible?');
  try {
    await experimentA(c);
    await experimentC(c);
    console.log('\n══ Spike verdict: read the IN-BAND rate + linearity + queue stall counts above. ══');
  } finally {
    await c.query('DROP TABLE IF EXISTS bench').catch(() => {});
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

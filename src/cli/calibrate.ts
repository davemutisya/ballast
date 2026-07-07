// `ballast calibrate` — measure THIS database's real lock throughput and record
// it into the local store, so predictions use your storage's constants instead of
// our seed. Runs on ephemeral throwaway tables (needs CREATE/DROP in some schema);
// never touches your data. This is the local half of the moat — it works with
// telemetry OFF and delivers value before any network.

import pg from 'pg';

import { bucketKey, fingerprint } from '../calibration/fingerprint.ts';
import { CalibrationStore } from '../calibration/store.ts';
import { DEFAULT_CALIBRATION } from '../loadModel.ts';

export async function runCalibrate(argv: string[]): Promise<number> {
  const val = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dsn = val('--dsn');
  if (!dsn) { console.error('usage: ballast calibrate --dsn <postgres-url> [--sizes 100000,1000000] [--storage ebs-gp3]'); return 2; }
  const sizes = (val('--sizes') ?? '100000,1000000').split(',').map(Number);
  const storage = val('--storage') ?? 'unknown';

  const c = new pg.Client({ connectionString: dsn });
  await c.connect();
  const major = (await c.query("SELECT (current_setting('server_version_num')::int / 10000)::text AS m")).rows[0].m;
  const store = new CalibrationStore();

  console.log(`Calibrating PostgreSQL ${major} (storage: ${storage}) at sizes ${sizes.map(fmtRows).join(', ')}...\n`);
  try {
    for (const n of sizes) {
      await setup(c, n);
      const s = await tableStats(c);
      const fp = fingerprint({ rows: s.rows, bytes: s.bytes, indexCount: s.idx, storageClass: storage, engineVersionMajor: major });

      const scanSec = await time(c, 'ALTER TABLE ballast_calib ALTER COLUMN n_col SET NOT NULL');
      store.observe(bucketKey('postgres', 'SCAN', 'SET_NOT_NULL', fp), s.rows / scanSec);
      await c.query('ALTER TABLE ballast_calib ALTER COLUMN n_col DROP NOT NULL');

      const idxSec = await time(c, 'CREATE INDEX bc_idx ON ballast_calib (val)');
      store.observe(bucketKey('postgres', 'SCAN', 'CREATE_INDEX', fp), s.rows / idxSec);
      await c.query('DROP INDEX bc_idx');

      const rwSec = await time(c, 'ALTER TABLE ballast_calib ALTER COLUMN n_col TYPE bigint');
      store.observe(bucketKey('postgres', 'REWRITE', 'ALTER_TYPE', fp), s.bytes / rwSec);

      const cal = store.toCalibration('postgres', fp);
      console.log(
        `  ${fmtRows(s.rows).padStart(6)}: scan ${(s.rows / scanSec / 1e6).toFixed(1)}M rows/s, ` +
        `index ${(s.rows / idxSec / 1e6).toFixed(1)}M rows/s, rewrite ${(s.bytes / rwSec / 1024 ** 2).toFixed(0)}MB/s` +
        `   → calibrated scan ${(cal.scanRowsPerSec / 1e6).toFixed(1)}M/s (seed ${(DEFAULT_CALIBRATION.scanRowsPerSec / 1e6).toFixed(0)}M)`,
      );
    }
  } finally {
    await c.query('DROP TABLE IF EXISTS ballast_calib').catch(() => {});
    await c.end();
  }
  console.log(`\n✓ Saved to ~/.ballast/calibration.json — ballast check --dsn now predicts with YOUR database's throughput.`);
  return 0;
}

async function setup(c: pg.Client, n: number) {
  await c.query('DROP TABLE IF EXISTS ballast_calib');
  await c.query('CREATE TABLE ballast_calib (id bigint PRIMARY KEY, val text NOT NULL, n_col int)');
  await c.query('INSERT INTO ballast_calib SELECT g, md5(g::text), g FROM generate_series(1,$1) g', [n]);
  await c.query('ANALYZE ballast_calib');
}
async function tableStats(c: pg.Client) {
  const r = await c.query(
    `SELECT reltuples::bigint AS rows, pg_total_relation_size('ballast_calib') AS bytes,
            (SELECT count(*) FROM pg_index i JOIN pg_class ic ON ic.oid = i.indrelid WHERE ic.relname='ballast_calib')::int AS idx
       FROM pg_class WHERE relname='ballast_calib'`);
  return { rows: Number(r.rows[0].rows), bytes: Number(r.rows[0].bytes), idx: Number(r.rows[0].idx) };
}
async function time(c: pg.Client, sql: string): Promise<number> {
  const t = process.hrtime.bigint(); await c.query(sql);
  return Number(process.hrtime.bigint() - t) / 1e9;
}
function fmtRows(n: number): string { return n >= 1e6 ? (n / 1e6) + 'M' : n >= 1e3 ? (n / 1e3) + 'K' : String(n); }

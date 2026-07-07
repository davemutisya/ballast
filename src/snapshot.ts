// Live, read-only stats snapshot. This is deliberately lightweight: it needs
// only SELECT on pg_catalog / pg_stat_* — no table data, no DDL, no write access.
// (That "we never touch your data or need write creds" property is both the
// safety story and, over time, the ingestion point for the calibration corpus.)

import pg from 'pg';
import type { StatsSnapshot } from './types.ts';

export async function snapshot(dsn: string, table: string): Promise<StatsSnapshot> {
  const c = new pg.Client({ connectionString: dsn });
  await c.connect();
  try {
    const size = await c.query(
      `SELECT c.reltuples::bigint AS rows, pg_total_relation_size(c.oid) AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND c.relkind IN ('r','p')
        ORDER BY (n.nspname = 'public') DESC LIMIT 1`,
      [table],
    );
    if (!size.rows[0]) throw new Error(`table "${table}" not found (grant SELECT on it and pg_catalog)`);

    // The lock-queue amplifier: the age of the oldest in-flight statement. If a
    // long query is running, an ACCESS EXCLUSIVE migration will queue behind it
    // and pile everything up. This single field is our biggest differentiation.
    const txn = await c.query(
      `SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - query_start))), 0)::float AS sec
         FROM pg_stat_activity
        WHERE state = 'active' AND pid <> pg_backend_pid() AND query_start IS NOT NULL`,
    );

    const { writeTps, readTps } = await sampleTps(c, table);

    const meta = await c.query(
      `SELECT (current_setting('server_version_num')::int / 10000)::text AS major,
              (SELECT count(*) FROM pg_index i JOIN pg_class ic ON ic.oid = i.indrelid WHERE ic.relname = $1)::int AS idx`,
      [table],
    );

    return {
      table,
      rows: Number(size.rows[0].rows),
      bytes: Number(size.rows[0].bytes),
      writeTps,
      readTps,
      longestRunningTxnSec: Number(txn.rows[0].sec),
      lockTimeoutMs: null,
      engineVersionMajor: String(meta.rows[0].major),
      indexCount: Number(meta.rows[0].idx),
    };
  } finally {
    await c.end();
  }
}

/** Sample per-table write/read op rates over a short window from pg_stat_user_tables. */
async function sampleTps(c: pg.Client, table: string): Promise<{ writeTps: number; readTps: number }> {
  const q = `SELECT COALESCE(n_tup_ins + n_tup_upd + n_tup_del, 0)::bigint AS writes,
                    COALESCE(seq_scan + idx_scan, 0)::bigint AS reads
               FROM pg_stat_user_tables WHERE relname = $1 LIMIT 1`;
  const a = await c.query(q, [table]);
  if (!a.rows[0]) return { writeTps: 0, readTps: 0 };
  await new Promise((r) => setTimeout(r, 800));
  const b = await c.query(q, [table]);
  const dt = 0.8;
  return {
    writeTps: Math.max(0, (Number(b.rows[0].writes) - Number(a.rows[0].writes)) / dt),
    readTps: Math.max(0, (Number(b.rows[0].reads) - Number(a.rows[0].reads)) / dt),
  };
}

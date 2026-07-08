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
    // Resolve to an OID up front. Accept schema-qualified ("public.orders") and
    // quoted names; prefer public then the search_path when the name is bare.
    const [schema, bare] = splitQualified(table);
    const rel = await c.query(
      `SELECT c.oid, n.nspname, c.relname, c.reltuples::bigint AS rows, pg_total_relation_size(c.oid) AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND ($2::text IS NULL OR n.nspname = $2) AND c.relkind IN ('r','p')
        ORDER BY (n.nspname = 'public') DESC, (n.nspname = ANY(current_schemas(true))) DESC
        LIMIT 1`,
      [bare, schema],
    );
    if (!rel.rows[0]) throw new Error(`table "${table}" not found (grant SELECT on it and pg_catalog)`);
    const oid = rel.rows[0].oid as number;

    // The lock-queue amplifier — our biggest differentiation. We want the oldest
    // OPEN TRANSACTION that holds ANY lock on *this* table, because an incoming
    // ACCESS EXCLUSIVE migration must queue behind it (and then everything queues
    // behind the migration). Three things the naive version got wrong:
    //   • include 'idle in transaction' — a session that ran a SELECT, holds its
    //     ACCESS SHARE, and now sits idle is the exact Spike-C hazard; state
    //     'active' would miss it entirely;
    //   • clock from xact_start, not query_start — the whole transaction holds the
    //     lock until commit, and query_start resets each statement;
    //   • scope to this table via pg_locks (relation = oid), not cluster-wide.
    const txn = await c.query(
      `SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - a.xact_start))), 0)::float AS sec
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.relation = $1
          AND l.locktype = 'relation'
          AND a.pid <> pg_backend_pid()
          AND a.xact_start IS NOT NULL
          AND a.state <> 'idle'`,
      [oid],
    );

    const { writeTps, readTps } = await sampleTps(c, rel.rows[0].relname);

    const meta = await c.query(
      `SELECT (current_setting('server_version_num')::int / 10000)::text AS major,
              current_setting('lock_timeout') AS lock_timeout,
              (SELECT count(*) FROM pg_index i WHERE i.indrelid = $1)::int AS idx`,
      [oid],
    );

    return {
      table,
      rows: Number(rel.rows[0].rows),
      bytes: Number(rel.rows[0].bytes),
      writeTps,
      readTps,
      longestRunningTxnSec: Number(txn.rows[0].sec),
      lockTimeoutMs: parseLockTimeout(meta.rows[0].lock_timeout),
      engineVersionMajor: String(meta.rows[0].major),
      indexCount: Number(meta.rows[0].idx),
    };
  } finally {
    await c.end();
  }
}

/** Split "schema.table" (each part optionally quoted) → [schema|null, table]. */
function splitQualified(name: string): [string | null, string] {
  const parts = name.match(/"[^"]*"|[^.]+/g) ?? [name];
  const unquote = (s: string) => s.replace(/^"|"$/g, '');
  return parts.length > 1 ? [unquote(parts[0]), unquote(parts[1])] : [null, unquote(parts[0])];
}

/** Postgres lock_timeout is ms or a unit string ('2s', '0' = disabled → null). */
function parseLockTimeout(v: string | null): number | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d+)\s*(ms|s|min)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (n === 0) return null;
  return m[2] === 's' ? n * 1000 : m[2] === 'min' ? n * 60000 : n;
}

/** Sample per-table write/read op rates over a short window from pg_stat_user_tables. */
async function sampleTps(c: pg.Client, table: string): Promise<{ writeTps: number; readTps: number }> {
  const q = `SELECT COALESCE(n_tup_ins + n_tup_upd + n_tup_del, 0)::bigint AS writes,
                    COALESCE(seq_scan + idx_scan, 0)::bigint AS reads
               FROM pg_stat_user_tables WHERE relname = $1 LIMIT 1`;
  const a = await c.query(q, [table]);
  if (!a.rows[0]) return { writeTps: 0, readTps: 0 };
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, 800));
  const b = await c.query(q, [table]);
  // Measure the real window (timer jitter + the second query's RTT), don't assume it.
  const dt = (performance.now() - t0) / 1000;
  return {
    writeTps: Math.max(0, (Number(b.rows[0].writes) - Number(a.rows[0].writes)) / dt),
    readTps: Math.max(0, (Number(b.rows[0].reads) - Number(a.rows[0].reads)) / dt),
  };
}

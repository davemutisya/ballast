// Ballast MCP server — the wedge. A coding agent (Cursor / Claude Code / Copilot)
// calls `analyze_migration` WHILE writing the migration and gets a load-aware
// verdict, so it rewrites the unsafe statement before a human sees it. Thin
// caller of the shared analyzer — identical logic and provenance to `ballast check`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { analyzeFinding, findingLines } from './analyze.ts';
import { CalibrationStore } from './calibration/store.ts';
import { fingerprintOf } from './calibration/fingerprint.ts';
import { isAnalyzable, parse } from './parse.ts';
import { snapshot } from './snapshot.ts';
import type { StatsSnapshot } from './types.ts';

const server = new McpServer({ name: 'ballast', version: '0.0.0' });
const store = new CalibrationStore();

server.tool(
  'analyze_migration',
  'Predict the PRODUCTION blast radius of a Postgres migration (lock mode, hold time ' +
    'under real load, blocked queries, lock-queue pileup) BEFORE running it. Call before ' +
    'proposing ANY DDL / schema migration, then apply the safe rewrite if the verdict is ' +
    'danger/critical. Pass `sql`. For a load-aware verdict also pass a read-only `dsn` ' +
    '(Ballast snapshots live table size + running transactions) or explicit `stats`.',
  {
    sql: z.string().describe('The migration SQL (DDL) to analyze.'),
    dsn: z.string().optional().describe('Read-only Postgres connection string; enables live load-aware analysis.'),
    table: z.string().optional().describe('Table to snapshot (defaults to the table in the SQL).'),
    stats: z.object({
      rows: z.number(), bytes: z.number().optional(), writeTps: z.number().optional(),
      readTps: z.number().optional(), longestRunningTxnSec: z.number().optional(),
    }).optional().describe('Explicit table stats, if no dsn is available.'),
  },
  async ({ sql, dsn, table, stats }) => {
    // A migration touches many tables; snapshot each statement's OWN table rather
    // than applying the first table's stats to everything (that was silently wrong).
    const all = await parse(sql);
    const stmts = all.filter(isAnalyzable);
    const unanalyzed = all.filter((s) => s.kind === 'UNANALYZED');
    const benign = all.length - stmts.length - unanalyzed.length;

    const lines: string[] = [];
    let anyLive = false;
    for (const stmt of stmts) {
      const tbl = table ?? stmt.table;
      let snap: StatsSnapshot | null = null;
      let note = '';
      try {
        if (dsn && tbl) { snap = await snapshot(dsn, tbl); anyLive = true; }
        else if (stats) { snap = fromStats(stats, tbl); }
      } catch (e) {
        note = `  ⚠️ (snapshot failed for ${tbl}: ${(e as Error).message}; structural only)`;
      }
      const cal = snap ? store.toCalibration('postgres', fingerprintOf(snap)) : undefined;
      const f = analyzeFinding(stmt, snap, cal);
      const load = snap ? ` — ${fmt(snap.rows)} rows` +
        (anyLive && snap.longestRunningTxnSec > 0 ? `, oldest blocking txn ${snap.longestRunningTxnSec.toFixed(1)}s` : '') : '';
      lines.push(findingLines(f).join('\n') + (load ? `\n     ↳ context: ${f.statement.table}${load}` : '') + note);
    }

    if (!lines.length && !unanalyzed.length) return text('No DDL statements to analyze.' + (benign ? ` (${benign} benign statement(s) — DML/functions/grants carry no table-lock risk.)` : ''));

    const header = anyLive
      ? 'Load-aware (live per-table snapshot):'
      : stats ? 'Stats-based analysis:'
      : 'Structural analysis — pass a read-only `dsn` or `stats` for the load-aware blast-radius verdict.';
    const tail: string[] = [];
    if (benign) tail.push(`(${benign} benign statement(s) not shown — no table-lock risk.)`);
    for (const u of unanalyzed)
      tail.push(`⚠️ NOT analyzed (${u.detail ?? 'unrecognized'}): ${u.raw.replace(/\s+/g, ' ').slice(0, 80)} — treat as unreviewed, do not assume safe.`);
    return text([header, '', ...lines, ...(tail.length ? ['', ...tail] : [])].join('\n'));
  },
);

function fromStats(
  s: { rows: number; bytes?: number; writeTps?: number; readTps?: number; longestRunningTxnSec?: number },
  table: string | null,
): StatsSnapshot {
  return {
    table: table ?? 'unknown', rows: s.rows, bytes: s.bytes ?? s.rows * 100,
    writeTps: s.writeTps ?? 0, readTps: s.readTps ?? 0,
    longestRunningTxnSec: s.longestRunningTxnSec ?? 0, lockTimeoutMs: null,
  };
}

function text(t: string) { return { content: [{ type: 'text' as const, text: t }] }; }
function fmt(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(Math.round(n));
}

await server.connect(new StdioServerTransport());

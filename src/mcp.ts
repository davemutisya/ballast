// Ballast MCP server — the wedge. A coding agent (Cursor / Claude Code / Copilot)
// calls `analyze_migration` WHILE writing the migration and gets a load-aware
// verdict, so it rewrites the unsafe statement before a human sees it. Thin
// caller of the shared analyzer — identical logic and provenance to `ballast check`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { analyze, findingLines } from './analyze.ts';
import { parse } from './parse.ts';
import { snapshot } from './snapshot.ts';
import type { StatsSnapshot } from './types.ts';

const server = new McpServer({ name: 'ballast', version: '0.0.0' });

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
    const targetTable = table ?? parse(sql).find((s) => s.table)?.table ?? null;

    let snap: StatsSnapshot | null = null;
    let mode = 'structural';
    try {
      if (dsn && targetTable) { snap = await snapshot(dsn, targetTable); mode = 'live'; }
      else if (stats) { snap = fromStats(stats, targetTable); mode = 'stats'; }
    } catch (e) {
      return text(`⚠️ Could not snapshot the database (${(e as Error).message}). Falling back to structural analysis.\n\n` + body(sql, null));
    }

    const header = snap
      ? `Load-aware (${mode}): ${targetTable} ≈ ${fmt(snap.rows)} rows` +
        (mode === 'live' ? `, ${snap.writeTps.toFixed(0)} w/s, oldest active query ${snap.longestRunningTxnSec.toFixed(1)}s` : '')
      : 'Structural analysis — pass a read-only `dsn` or `stats` for the load-aware blast-radius verdict.';
    return text(header + '\n\n' + body(sql, snap));
  },
);

function body(sql: string, snap: StatsSnapshot | null): string {
  const findings = analyze(sql, snap);
  if (!findings.length) return 'No recognized DDL statements.';
  return findings.map((f) => findingLines(f).join('\n')).join('\n');
}

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

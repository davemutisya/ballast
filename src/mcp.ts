// Ballast MCP server — the wedge. A coding agent (Cursor / Claude Code / Copilot)
// calls `analyze_migration` WHILE writing the migration and gets a load-aware
// verdict, so it rewrites the unsafe statement before a human sees it.
//
// This is a thin shell over the SAME pipeline `ballast check` runs
// (src/pipeline.ts) — exemptions, suppressions, snapshot handling identical by
// construction, so the agent can never see different verdicts than CI.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { analyzeStatement, findingLines } from './analyze.ts';
import { CalibrationStore } from './calibration/store.ts';
import { analyzeScript } from './pipeline.ts';
import { isAnalyzable, parse } from './parse.ts';
import type { StatsSnapshot, Statement } from './types.ts';

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
    table: z.string().optional().describe('Table to snapshot (defaults to each statement\'s own table).'),
    stats: z.object({
      rows: z.number(), bytes: z.number().optional(), writeTps: z.number().optional(),
      readTps: z.number().optional(), longestRunningTxnSec: z.number().optional(),
    }).optional().describe('Explicit table stats, if no dsn is available.'),
  },
  async ({ sql, dsn, table, stats }) => {
    // The dsn path is the shared pipeline verbatim. The explicit-stats path maps
    // the user-supplied numbers onto every statement (kept for agents without DB
    // access), still through parse+pipeline classification.
    if (dsn) {
      const r = await analyzeScript(sql, { dsn, table, store });
      return render('Load-aware (live per-table snapshot):', r.findings.map((f) => findingLines(f).join('\n')), r.benign, r.unanalyzed, r.notes);
    }
    if (stats) {
      const all = await parse(sql);
      const lines: string[] = [];
      for (const stmt of all.filter(isAnalyzable)) {
        lines.push(findingLines(analyzeStatement(stmt, fromStats(stats, table ?? stmt.table))).join('\n'));
      }
      return render('Stats-based analysis:', lines, all.filter((s) => !isAnalyzable(s) && s.kind !== 'UNANALYZED').length, all.filter((s) => s.kind === 'UNANALYZED'), []);
    }
    const r = await analyzeScript(sql, { store });
    return render(
      'Structural analysis — pass a read-only `dsn` or `stats` for the load-aware blast-radius verdict.',
      r.findings.map((f) => findingLines(f).join('\n')), r.benign, r.unanalyzed, r.notes,
    );
  },
);

function render(header: string, lines: string[], benign: number, unanalyzed: Statement[], notes: string[]) {
  if (!lines.length && !unanalyzed.length) {
    return text('No DDL statements to analyze.' + (benign ? ` (${benign} benign statement(s) — DML/functions/grants carry no table-lock risk.)` : ''));
  }
  const tail: string[] = [];
  for (const n of notes) tail.push(n.startsWith('⚠️') ? n : `· ${n}`);
  if (benign) tail.push(`(${benign} benign statement(s) not shown — no table-lock risk.)`);
  for (const u of unanalyzed)
    tail.push(`⚠️ NOT analyzed (${u.detail ?? 'unrecognized'}): ${u.raw.replace(/\s+/g, ' ').slice(0, 80)} — treat as unreviewed, do not assume safe.`);
  return text([header, '', ...lines, ...(tail.length ? ['', ...tail] : [])].join('\n'));
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

await server.connect(new StdioServerTransport());

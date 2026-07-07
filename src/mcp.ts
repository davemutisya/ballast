// Ballast MCP server — the wedge.
//
// This is what makes Ballast different from every CI linter: the coding agent
// (Cursor / Claude Code / Copilot) calls `analyze_migration` WHILE it writes the
// migration, gets a load-aware verdict, and rewrites the unsafe statement before
// a human ever sees it. Safety in the agent loop, not after merge.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { analyzeSql } from './analyze.ts';
import { parse } from './parse.ts';
import { snapshot } from './snapshot.ts';
import type { Finding, StatsSnapshot } from './types.ts';

const server = new McpServer({ name: 'ballast', version: '0.0.0' });

server.tool(
  'analyze_migration',
  'Predict the PRODUCTION blast radius of a Postgres migration (lock mode, how long ' +
    'the lock is held under real load, how many queries it blocks, and lock-queue ' +
    'pileup risk) BEFORE running it. Call this before proposing ANY DDL / schema ' +
    'migration, then apply the safe rewrite if the verdict is danger/critical. ' +
    'Pass `sql`. For a load-aware verdict, also pass a read-only `dsn` (Ballast ' +
    'snapshots live table size + running transactions) or explicit `stats`.',
  {
    sql: z.string().describe('The migration SQL (DDL) to analyze.'),
    dsn: z.string().optional().describe('Read-only Postgres connection string; enables live load-aware analysis.'),
    table: z.string().optional().describe('Table to snapshot (defaults to the table referenced in the SQL).'),
    stats: z
      .object({
        rows: z.number(),
        bytes: z.number().optional(),
        writeTps: z.number().optional(),
        readTps: z.number().optional(),
        longestRunningTxnSec: z.number().optional(),
      })
      .optional()
      .describe('Explicit table stats, if no dsn is available.'),
  },
  async ({ sql, dsn, table, stats }) => {
    const targetTable = table ?? parse(sql).find((s) => s.table)?.table ?? null;

    let snap: StatsSnapshot | null = null;
    let mode = 'structural-only';
    try {
      if (dsn && targetTable) {
        snap = await snapshot(dsn, targetTable);
        mode = 'live';
      } else if (stats) {
        snap = fromStats(stats, targetTable);
        mode = 'stats';
      }
    } catch (e) {
      return text(`⚠️ Ballast could not snapshot the database (${(e as Error).message}). ` +
        `Falling back to structural analysis.\n\n` + structural(sql));
    }

    if (!snap) {
      return text(structural(sql) +
        `\n\nℹ️ No dsn/stats provided — this is lock/rewrite advice only. Pass a read-only ` +
        `dsn or table stats for the load-aware blast-radius verdict (dwell time, blocked queries, queue risk).`);
    }

    const findings = analyzeSql(sql, snap);
    return text(render(findings, mode, snap));
  },
);

function fromStats(
  s: { rows: number; bytes?: number; writeTps?: number; readTps?: number; longestRunningTxnSec?: number },
  table: string | null,
): StatsSnapshot {
  return {
    table: table ?? 'unknown',
    rows: s.rows,
    bytes: s.bytes ?? s.rows * 100, // rough default row width
    writeTps: s.writeTps ?? 0,
    readTps: s.readTps ?? 0,
    longestRunningTxnSec: s.longestRunningTxnSec ?? 0,
    lockTimeoutMs: null,
  };
}

/** Lock-mode + safe-rewrite advice with no load data (linter-equivalent baseline). */
function structural(sql: string): string {
  return analyzeSql(sql, { table: 'unknown', rows: 0, bytes: 0, writeTps: 0, readTps: 0, longestRunningTxnSec: 0, lockTimeoutMs: null })
    .map((f) => `• ${f.statement.kind} on ${f.statement.table ?? '?'} → ${f.lockMode}` +
      (f.safeRewrite ? `\n  safe rewrite: ${f.safeRewrite}` : ' (already safe)'))
    .join('\n');
}

function render(findings: Finding[], mode: string, snap: StatsSnapshot): string {
  const header = mode === 'live'
    ? `Load-aware analysis (live): ${snap.table} ≈ ${fmt(snap.rows)} rows, ${snap.writeTps.toFixed(0)} writes/s, ` +
      `${snap.readTps.toFixed(0)} reads/s, oldest active query ${snap.longestRunningTxnSec.toFixed(1)}s\n`
    : `Load-aware analysis (stats): ${snap.table} ≈ ${fmt(snap.rows)} rows\n`;
  const body = findings.map((f) =>
    f.verdict + (f.safeRewrite && (f.severity === 'danger' || f.severity === 'critical')
      ? `\n   ↳ safe rewrite: ${f.safeRewrite}` : '')).join('\n');
  return header + '\n' + (body || 'No recognized DDL statements.');
}

function text(t: string) { return { content: [{ type: 'text' as const, text: t }] }; }
function fmt(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(Math.round(n));
}

await server.connect(new StdioServerTransport());

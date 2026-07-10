// The single statement-analysis pipeline. `ballast check`, `ballast audit`, AND
// the MCP server all run a SQL script through here — one code path, so the agent
// can never see different verdicts than CI (that divergence shipped once; this
// file is the structural fix).
//
// Responsibilities: parse once → same-file new-relation exemption →
// per-statement snapshot (memoized per table, crash-safe) → findings →
// `-- ballast-ignore` suppression → benign/unanalyzed accounting.

import { analyzeFinding } from './analyze.ts';
import { CalibrationStore } from './calibration/store.ts';
import { fingerprintOf } from './calibration/fingerprint.ts';
import { isAnalyzable, parse } from './parse.ts';
import { snapshot } from './snapshot.ts';
import type { Finding, Severity, StatsSnapshot, Statement } from './types.ts';

export interface ScriptAnalysis {
  findings: Finding[];
  /** Recognized statements with no table-lock risk (DML, functions, grants, CREATE TABLE…). */
  benign: number;
  /** Statements we could not classify — callers MUST show these. */
  unanalyzed: Statement[];
  /** Operational notes (snapshot failures, suppressions) — surface with the findings. */
  notes: string[];
}

// The escape hatch. A `-- ballast-ignore` comment on the line(s) immediately
// before a statement suppresses its finding: still shown (🔇, graded safe, so a
// human sees what was overridden) but it no longer trips the gate. Without this,
// one false positive in a hard-red CI gate means the team deletes the tool.
const IGNORE = /--[^\n]*\bballast-ignore\b/;

// Excluded from the new-relation exemption:
//  • DROP_TABLE / TRUNCATE — the destructive-recreate pattern (DROP TABLE x;
//    CREATE TABLE x;) destroys a PRE-EXISTING table's data, and the same-file
//    CREATE would mask it. Never under-warn on a destructive op.
// ADD_FOREIGN_KEY gets its own treatment below: a new (empty) child makes the
// validation scan instant, but the referenced parent — which may pre-exist —
// still takes a brief SHARE ROW EXCLUSIVE, so the verdict must SAY so.
const NEVER_EXEMPT = new Set(['DROP_TABLE', 'TRUNCATE']);

function bareName(t: string | null | undefined): string | null {
  return t ? t.replace(/^.*\./, '').toLowerCase() : null;
}

export async function analyzeScript(
  sql: string,
  opts: { dsn?: string; table?: string; store?: CalibrationStore } = {},
): Promise<ScriptAnalysis> {
  const store = opts.store ?? new CalibrationStore();
  const stmts = await parse(sql);
  const notes: string[] = [];

  // Relations born in this same script (tables AND matviews, from the parse
  // tree): changes against them run on an object nothing references yet, so no
  // pre-existing traffic can block or be blocked. Skipping this special case is
  // the #1 way a migration linter cries wolf.
  const created = new Set(
    stmts.filter((s) => s.kind === 'CREATE_TABLE' || s.kind === 'CREATE_MATVIEW')
      .map((s) => bareName(s.table)).filter((t): t is string => !!t),
  );

  // Snapshot memo: one live sample per table per run — not per statement (a
  // 40-statement migration must not cost 40 connections × 800ms sampling).
  const snaps = new Map<string, StatsSnapshot | null>();
  async function snapFor(table: string): Promise<StatsSnapshot | null> {
    if (snaps.has(table)) return snaps.get(table)!;
    let s: StatsSnapshot | null = null;
    try {
      s = await snapshot(opts.dsn!, table);
      notes.push(`snapshot ${table}: ~${fmtRows(s.rows)} rows, ${s.writeTps.toFixed(0)} w/s` +
        (s.longestRunningTxnSec > 0 ? `, oldest lock-holding txn ${s.longestRunningTxnSec.toFixed(1)}s` : ''));
    } catch (e) {
      // One bad table must not kill the run: degrade THAT statement to structural.
      notes.push(`⚠️ snapshot failed for ${table} (${(e as Error).message}) — analyzed structurally.`);
    }
    snaps.set(table, s);
    return s;
  }

  const findings: Finding[] = [];
  for (const stmt of stmts.filter(isAnalyzable)) {
    const tbl = opts.table ?? stmt.table;
    const stats = opts.dsn && tbl ? await snapFor(tbl) : null;
    const cal = stats ? store.toCalibration('postgres', fingerprintOf(stats)) : undefined;
    let f = analyzeFinding(stmt, stats, cal);
    f = exempt(f, created);
    f = suppress(f);
    findings.push(f);
  }

  // Timeout hygiene — our own #1 advice, enforced. If this script takes real
  // locks (any caution+ finding) and never bounds the wait with SET lock_timeout,
  // a blocked DDL sits in the lock queue and stalls ALL traffic behind it
  // (docs/blog/001). Advisory note, not a gate: hygiene ≠ danger.
  const risky = findings.some((f) => f.severity !== 'safe');
  const boundsWait = stmts.some((s) => s.detail === 'sets lock_timeout');
  if (risky && !boundsWait) {
    notes.push(
      "⚠️ no `SET lock_timeout` before lock-taking DDL — if a lock is contended, the migration queues and ALL traffic queues behind it. Add: SET lock_timeout = '2s'; and retry on failure.",
    );
  }

  return {
    findings,
    benign: stmts.filter((s) => !isAnalyzable(s) && s.kind !== 'UNANALYZED').length,
    unanalyzed: stmts.filter((s) => s.kind === 'UNANALYZED'),
    notes,
  };
}

function exempt(f: Finding, created: Set<string>): Finding {
  const t = bareName(f.statement.table);
  if (!t || !created.has(t) || NEVER_EXEMPT.has(f.statement.kind)) return f;
  if (f.statement.kind === 'ADD_FOREIGN_KEY') {
    // Child is brand-new and empty → the FK validation scan is instant. The
    // brief SHARE ROW EXCLUSIVE on the (possibly pre-existing, possibly large)
    // parent remains — same class as any brief lock: structurally safe, and
    // --dsn mode checks the parent's queue risk. Say all of that.
    return {
      ...f,
      severity: 'safe' as Severity,
      safeRewrite: null,
      verdict: `✅ ADD_FOREIGN_KEY on ${f.statement.table} — child table is CREATEd in this same migration (empty → validation scan is instant). The referenced parent is still briefly locked (SHARE ROW EXCLUSIVE); on a busy parent run with lock_timeout + retry (--dsn checks its live queue risk).`,
    };
  }
  return {
    ...f,
    severity: 'safe' as Severity,
    safeRewrite: null,
    verdict: `✅ ${f.statement.kind} on ${f.statement.table} — relation is CREATEd in this same migration (no live traffic yet), so nothing running can be blocked. Safe.`,
  };
}

function suppress(f: Finding): Finding {
  if (f.severity === 'safe' || !IGNORE.test(f.statement.raw)) return f;
  return {
    ...f,
    severity: 'safe' as Severity,
    safeRewrite: null,
    verdict: `🔇 ${f.statement.kind} on ${f.statement.table ?? '?'} — suppressed by ballast-ignore (would have been: ${f.severity}). ${f.verdict.replace(/^\S+\s*/, '')}`,
  };
}

function fmtRows(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(Math.round(n));
}

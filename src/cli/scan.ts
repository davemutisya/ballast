// Shared file-gathering + analysis used by both `check` (gate) and `audit`
// (report), so they can never diverge. Parses each file ONCE with the real
// grammar; benign and unanalyzed statements are counted and surfaced — nothing
// is silently skipped.

import fs from 'node:fs';
import path from 'node:path';

import { analyzeFinding } from '../analyze.ts';
import { CalibrationStore } from '../calibration/store.ts';
import { fingerprintOf } from '../calibration/fingerprint.ts';
import { isAnalyzable, parse } from '../parse.ts';
import { snapshot } from '../snapshot.ts';
import type { Finding, Severity, Statement } from '../types.ts';

export interface FileFindings {
  file: string;
  findings: Finding[];
  /** Recognized statements with no table-lock risk (DML, functions, grants, CREATE TABLE…). */
  benign: number;
  /** Statements we could not classify — callers MUST show these. */
  unanalyzed: Statement[];
}

const SEVERITIES: Severity[] = ['safe', 'caution', 'danger', 'critical'];

/** Reject a mistyped --fail-on (e.g. "daner") loudly instead of silently disabling the gate. */
export function validSeverity(v: string | undefined): Severity {
  if (v && (SEVERITIES as string[]).includes(v)) return v as Severity;
  throw new Error(`invalid severity "${v ?? ''}" — expected one of: ${SEVERITIES.join(', ')}`);
}

// Relations born in this same migration file (tables AND matviews, from the parse
// tree — not regex): any index/constraint/column change against them runs on an
// object nothing references yet, so no pre-existing traffic can block it or be
// blocked by it. Skipping this special case is the #1 way a migration linter
// cries wolf.
//
// Excluded from the exemption:
//  • ADD_FOREIGN_KEY — it also locks/validates the *referenced* parent, which may
//    be a large pre-existing table even when the child is new;
//  • DROP_TABLE / TRUNCATE — the destructive-recreate pattern (DROP TABLE x;
//    CREATE TABLE x;) destroys a PRE-EXISTING table's data, and the same-file
//    CREATE would mask it. Never under-warn on a destructive op.
const NEVER_EXEMPT = new Set(['ADD_FOREIGN_KEY', 'DROP_TABLE', 'TRUNCATE']);

function bareName(t: string | null | undefined): string | null {
  return t ? t.replace(/^.*\./, '').toLowerCase() : null;
}

function exemptOnNewTable(findings: Finding[], created: Set<string>): Finding[] {
  if (!created.size) return findings;
  return findings.map((f) => {
    const t = bareName(f.statement.table);
    if (!t || !created.has(t) || NEVER_EXEMPT.has(f.statement.kind)) return f;
    return {
      ...f,
      severity: 'safe' as Severity,
      safeRewrite: null,
      verdict: `✅ ${f.statement.kind} on ${f.statement.table} — relation is CREATEd in this same migration (no live traffic yet), so nothing running can be blocked. Safe.`,
    };
  });
}

export function collect(paths: string[]): { file: string; sql: string }[] {
  if (paths.length === 0) return [{ file: '<stdin>', sql: fs.readFileSync(0, 'utf8') }];
  const out: { file: string; sql: string }[] = [];
  for (const p of paths) {
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).filter((f) => f.endsWith('.sql')).sort())
        out.push({ file: path.join(p, f), sql: fs.readFileSync(path.join(p, f), 'utf8') });
    } else out.push({ file: p, sql: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

export async function scan(paths: string[], dsn?: string, table?: string): Promise<FileFindings[]> {
  const store = new CalibrationStore(); // env-calibrated constants from `ballast calibrate`
  const results: FileFindings[] = [];
  for (const { file, sql } of collect(paths)) {
    const stmts = await parse(sql);
    const created = new Set(
      stmts.filter((s) => s.kind === 'CREATE_TABLE' || s.kind === 'CREATE_MATVIEW')
        .map((s) => bareName(s.table)).filter((t): t is string => !!t),
    );
    const findings: Finding[] = [];
    for (const stmt of stmts.filter(isAnalyzable)) {
      // A migration file may touch several tables; snapshot per statement's table.
      const stats = dsn && stmt.table ? await snapshot(dsn, table ?? stmt.table) : null;
      const cal = stats ? store.toCalibration('postgres', fingerprintOf(stats)) : undefined;
      findings.push(analyzeFinding(stmt, stats, cal));
    }
    results.push({
      file,
      findings: exemptOnNewTable(findings, created),
      benign: stmts.filter((s) => !isAnalyzable(s) && s.kind !== 'UNANALYZED').length,
      unanalyzed: stmts.filter((s) => s.kind === 'UNANALYZED'),
    });
  }
  return results;
}

/** One consistent unanalyzed-statements block for check and audit. */
export function unanalyzedLines(results: FileFindings[]): string[] {
  const all = results.flatMap((r) => r.unanalyzed.map((s) => ({ file: r.file, s })));
  if (!all.length) return [];
  const out = [`⚠️  ${all.length} statement(s) could NOT be analyzed (shown so nothing is silently skipped):`];
  for (const { file, s } of all.slice(0, 10)) {
    out.push(`   ${path.relative(process.cwd(), file) || file}: ${s.raw.replace(/\s+/g, ' ').slice(0, 90)}${s.raw.length > 90 ? '…' : ''}`);
    if (s.detail) out.push(`     ↳ ${s.detail}`);
  }
  if (all.length > 10) out.push(`   … and ${all.length - 10} more`);
  return out;
}

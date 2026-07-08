// Shared file-gathering + analysis used by both `check` (gate) and `audit`
// (report), so they can never diverge.

import fs from 'node:fs';
import path from 'node:path';

import { analyze } from '../analyze.ts';
import { CalibrationStore } from '../calibration/store.ts';
import { fingerprintOf } from '../calibration/fingerprint.ts';
import { parse } from '../parse.ts';
import { snapshot } from '../snapshot.ts';
import type { Finding, Severity } from '../types.ts';

export interface FileFindings { file: string; findings: Finding[] }

const SEVERITIES: Severity[] = ['safe', 'caution', 'danger', 'critical'];

/** Reject a mistyped --fail-on (e.g. "daner") loudly instead of silently disabling the gate. */
export function validSeverity(v: string | undefined): Severity {
  if (v && (SEVERITIES as string[]).includes(v)) return v as Severity;
  throw new Error(`invalid severity "${v ?? ''}" — expected one of: ${SEVERITIES.join(', ')}`);
}

// Tables born in this same migration file: any index/constraint/column change
// against them runs on an empty table with no concurrent traffic → genuinely
// safe, however scary the statement looks in isolation. Static linters special-
// case this; skipping it is the #1 way a migration linter cries wolf.
const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?["']?([a-z0-9_.]+)/gi;

function createdTablesIn(sql: string): Set<string> {
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const out = new Set<string>();
  for (const m of s.matchAll(CREATE_TABLE)) out.add(m[1].replace(/^.*\./, '').toLowerCase());
  return out;
}

// FK is excluded: it also locks/validates the *referenced* parent, which may be a
// large pre-existing table even when the child is new. Never under-warn there.
function exemptOnNewTable(findings: Finding[], created: Set<string>): Finding[] {
  if (!created.size) return findings;
  return findings.map((f) => {
    const t = f.statement.table?.replace(/^.*\./, '').toLowerCase();
    if (!t || !created.has(t) || f.statement.kind === 'ADD_FOREIGN_KEY') return f;
    return {
      ...f,
      severity: 'safe',
      safeRewrite: null,
      verdict: `${f.statement.kind} on ${f.statement.table} — table is CREATEd in this same migration (empty, no live traffic), so this runs instantly and blocks nothing. Safe.`,
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
    const created = createdTablesIn(sql);
    const findings: Finding[] = [];
    for (const stmt of parse(sql).filter((s) => s.kind !== 'UNKNOWN')) {
      const stats = dsn && stmt.table ? await snapshot(dsn, table ?? stmt.table) : null;
      const cal = stats ? store.toCalibration('postgres', fingerprintOf(stats)) : undefined;
      findings.push(...analyze(stmt.raw, stats, cal));
    }
    results.push({ file, findings: exemptOnNewTable(findings, created) });
  }
  return results;
}

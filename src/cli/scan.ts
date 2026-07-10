// File gathering for `check` and `audit`. All analysis lives in the shared
// pipeline (src/pipeline.ts) — the same code path the MCP server uses.

import fs from 'node:fs';
import path from 'node:path';

import { analyzeScript, type ScriptAnalysis } from '../pipeline.ts';
import { CalibrationStore } from '../calibration/store.ts';
import type { Severity, Statement } from '../types.ts';

export interface FileFindings extends ScriptAnalysis { file: string }
export interface ScanResult { results: FileFindings[]; skipped: string[] }

const SEVERITIES: Severity[] = ['safe', 'caution', 'danger', 'critical'];

/** Reject a mistyped --fail-on (e.g. "daner") loudly instead of silently disabling the gate. */
export function validSeverity(v: string | undefined): Severity {
  if (v && (SEVERITIES as string[]).includes(v)) return v as Severity;
  throw new Error(`invalid severity "${v ?? ''}" — expected one of: ${SEVERITIES.join(', ')}`);
}

/** Same pattern for --format (a typo silently rendering text is the same bug class). */
export function validFormat(v: string | undefined): 'text' | 'json' | 'md' {
  if (v === 'text' || v === 'json' || v === 'md') return v;
  throw new Error(`invalid format "${v ?? ''}" — expected one of: text, json, md`);
}

/** Rollback/down migrations are not part of the applied history — auditing them double-counts. */
const DOWN_FILE = /(\.down\.sql|[._-]down\.sql|\.undo\.sql)$/i;

export function collect(paths: string[]): { entries: { file: string; sql: string }[]; skipped: string[] } {
  if (paths.length === 0) return { entries: [{ file: '<stdin>', sql: fs.readFileSync(0, 'utf8') }], skipped: [] };
  const entries: { file: string; sql: string }[] = [];
  const skipped: string[] = [];
  for (const p of paths) {
    if (fs.statSync(p).isDirectory()) {
      // Natural sort so 2_x.sql precedes 10_y.sql (lexicographic ordering lies).
      const files = fs.readdirSync(p).filter((f) => f.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      for (const f of files) {
        if (DOWN_FILE.test(f)) { skipped.push(path.join(p, f)); continue; }
        entries.push({ file: path.join(p, f), sql: fs.readFileSync(path.join(p, f), 'utf8') });
      }
    } else entries.push({ file: p, sql: fs.readFileSync(p, 'utf8') }); // explicit file: user's call, include even a .down.sql
  }
  return { entries, skipped };
}

export async function scan(paths: string[], dsn?: string, table?: string): Promise<ScanResult> {
  const store = new CalibrationStore(); // env-calibrated constants from `ballast calibrate`
  const { entries, skipped } = collect(paths);
  const results: FileFindings[] = [];
  for (const { file, sql } of entries) {
    results.push({ file, ...(await analyzeScript(sql, { dsn, table, store })) });
  }
  return { results, skipped };
}

/** One consistent disclosure block for check and audit: skipped files, snapshot notes, unanalyzed. */
export function disclosureLines(scanned: ScanResult): string[] {
  const out: string[] = [];
  if (scanned.skipped.length)
    out.push(`↷ skipped ${scanned.skipped.length} down-migration file(s): ${scanned.skipped.map((f) => path.basename(f)).join(', ')}`);
  const notes = scanned.results.flatMap((r) => r.notes.filter((n) => n.startsWith('⚠️')));
  out.push(...notes);
  const all = scanned.results.flatMap((r) => r.unanalyzed.map((s) => ({ file: r.file, s })));
  if (all.length) {
    out.push(`⚠️  ${all.length} statement(s) could NOT be analyzed (shown so nothing is silently skipped):`);
    for (const { file, s } of all.slice(0, 10)) {
      out.push(`   ${path.relative(process.cwd(), file) || file}: ${s.raw.replace(/\s+/g, ' ').slice(0, 90)}${s.raw.length > 90 ? '…' : ''}`);
      if (s.detail) out.push(`     ↳ ${s.detail}`);
    }
    if (all.length > 10) out.push(`   … and ${all.length - 10} more`);
  }
  return out;
}

export type { Statement };

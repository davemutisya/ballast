// The one analysis core. CLI and MCP both call this — so what the agent sees and
// what CI enforces can never drift. Two modes:
//   • load-aware  (stats present): predicted dwell + blast radius on a real table.
//   • structural  (no stats): conservative, pattern-based — never under-warns.
// Every finding carries a verified-source citation (provenance) from the catalog.

import { lockFactsFor, type LockFacts } from './lockModel.ts';
import { DEFAULT_CALIBRATION, predictBlast, predictDwell, type Calibration } from './loadModel.ts';
import { parse } from './parse.ts';
import { factsFromEntry, matchEntry } from './catalog/match.ts';
import type { BlastRadius, DwellPrediction, Finding, Severity, StatsSnapshot, Statement } from './types.ts';

/** Lock facts from the VERIFIED catalog when the statement matches; else the built-in fallback. */
function factsFor(stmt: Statement): LockFacts {
  const e = matchEntry(stmt);
  return e ? factsFromEntry(e) : lockFactsFor(stmt);
}

const ICON: Record<Severity, string> = { safe: '✅', caution: '⚠️', danger: '⛔', critical: '🔥' };

/** Dispatch: load-aware when we have stats, structural otherwise. */
export function analyze(sql: string, stats: StatsSnapshot | null, cal?: Calibration): Finding[] {
  return parse(sql)
    .filter((s) => s.kind !== 'UNKNOWN')
    .map((s) => (stats ? analyzeStatement(s, stats, cal) : structuralFinding(s)));
}

export function analyzeStatement(stmt: Statement, stats: StatsSnapshot, cal: Calibration = DEFAULT_CALIBRATION): Finding {
  const facts = factsFor(stmt);
  const dwell = predictDwell(facts.costClass, stmt.kind, stats, cal);
  const blast = predictBlast(facts.lockMode, facts.blocksReads, facts.blocksWrites, dwell, stats);
  return finalize(stmt, facts, dwell, blast, scoreSeverity(dwell.seconds, blast), false);
}

/** No DB: flag by lock/cost class, conservatively. The linter-parity baseline. */
export function structuralFinding(stmt: Statement): Finding {
  const facts = factsFor(stmt);
  const dwell: DwellPrediction = { costClass: facts.costClass, seconds: 0, low: 0, high: 0, basis: 'unknown size — connect --dsn to quantify' };
  const blast: BlastRadius = { blocksReads: facts.blocksReads, blocksWrites: facts.blocksWrites, blockedQueries: 0, queuePileupRisk: 'none', queueNote: null };
  return finalize(stmt, facts, dwell, blast, structuralSeverity(facts), true);
}

export function analyzeSql(sql: string, stats: StatsSnapshot, cal?: Calibration): Finding[] {
  return parse(sql).map((s) => analyzeStatement(s, stats, cal));
}

/** Shared rendering used by CLI and MCP — one voice everywhere. */
export function findingLines(f: Finding): string[] {
  const out = ['  ' + f.verdict];
  if (f.safeRewrite && (f.severity === 'danger' || f.severity === 'critical')) out.push(`     ↳ safe rewrite: ${f.safeRewrite}`);
  if (f.provenance) out.push(`     ✓ ${f.provenance}`);
  return out;
}

// ── internals ────────────────────────────────────────────────────────────────

function finalize(
  stmt: Statement, facts: LockFacts, dwell: DwellPrediction, blast: BlastRadius,
  severity: Severity, structural: boolean,
): Finding {
  return {
    statement: stmt, lockMode: facts.lockMode, dwell, blast, severity, safeRewrite: facts.safeRewrite,
    verdict: renderVerdict(stmt, facts.lockMode, dwell, blast, severity, structural),
    provenance: provenanceFrom(facts),
    catalogId: facts.catalogId,
  };
}

function provenanceFrom(facts: LockFacts): string | undefined {
  const src = facts.sources?.find((s) => s.includes('postgresql.org')) ?? facts.sources?.[0];
  return src ? `verified vs ${src.replace('https://www.postgresql.org', 'postgresql.org')}` : undefined;
}

function structuralSeverity(f: LockFacts): Severity {
  if (f.costClass === 'REWRITE') return 'danger';                          // rewrites are always heavy
  if (f.costClass === 'SCAN' && f.blocksWrites) return 'danger';           // scan-bound write block, unknown size
  if (!f.blocksReads && !f.blocksWrites) return 'safe';                    // blocks nothing (e.g. CONCURRENTLY) — safe even with hardening tips
  if (f.blocksReads && f.blocksWrites) return 'caution';                   // ACCESS EXCLUSIVE metadata — queue risk if a long txn is live
  return f.safeRewrite ? 'caution' : 'safe';
}

function scoreSeverity(
  dwellSec: number,
  blast: { blocksReads: boolean; blocksWrites: boolean; blockedQueries: number; queuePileupRisk: string },
): Severity {
  if (blast.queuePileupRisk === 'high') return 'critical';
  // Inherent risk: a long *blocking* lock is dangerous even at zero current load.
  const blockingDwell = blast.blocksReads || blast.blocksWrites ? dwellSec : 0;
  if (blockingDwell >= 10) return 'critical';
  if (blockingDwell >= 1) return 'danger';
  // Current-load risk amplifies on top.
  if (blast.blockedQueries >= 100) return 'critical';
  if (blast.blockedQueries >= 10) return 'danger';
  if (blast.blockedQueries >= 1 || blockingDwell >= 0.1) return 'caution';
  return 'safe';
}

function renderVerdict(
  stmt: Statement, lockMode: string, dwell: DwellPrediction, blast: BlastRadius, severity: Severity, structural: boolean,
): string {
  const what = blast.blocksReads && blast.blocksWrites ? 'reads + writes' : blast.blocksWrites ? 'writes' : blast.blocksReads ? 'reads' : 'nothing';
  const where = `${stmt.kind} on ${stmt.table ?? '?'}`;
  if (structural) {
    const held = dwell.costClass === 'METADATA_ONLY' ? 'briefly' : 'for the whole operation (scales with table size)';
    const tail = dwell.costClass === 'METADATA_ONLY'
      ? '  (danger rises sharply if a long-running txn is active — --dsn checks this)'
      : '  (connect --dsn to quantify blast radius)';
    return `${ICON[severity]} ${where} — ${lockMode}, blocks ${what} ${held}${tail}`;
  }
  const held = dwell.seconds < 0.05 ? `${Math.round(dwell.seconds * 1000)}ms` : `${dwell.seconds.toFixed(1)}s`;
  let line = `${ICON[severity]} ${where}: holds ${lockMode} ~${held}, blocking ${what}` +
    (blast.blockedQueries > 0 ? ` (~${blast.blockedQueries} queries at current load)` : '') + '.';
  if (blast.queueNote) line += `  LOCK QUEUE: ${blast.queueNote}`;
  return line;
}


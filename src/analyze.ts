// Top-level analyzer: statement + production stats → a load-aware Finding.
// This is the function `ballast-mcp` will expose so a coding agent gets the
// verdict *as it writes the migration*.

import { lockFactsFor } from './lockModel.ts';
import { DEFAULT_CALIBRATION, predictBlast, predictDwell, type Calibration } from './loadModel.ts';
import { parse } from './parse.ts';
import type { Finding, Severity, StatsSnapshot, Statement } from './types.ts';

export function analyzeStatement(
  stmt: Statement,
  stats: StatsSnapshot,
  cal: Calibration = DEFAULT_CALIBRATION,
): Finding {
  const facts = lockFactsFor(stmt);
  const dwell = predictDwell(facts.costClass, stmt.kind, stats, cal);
  const blast = predictBlast(facts.lockMode, facts.blocksReads, facts.blocksWrites, dwell, stats);
  const severity = scoreSeverity(dwell.seconds, blast);
  const verdict = renderVerdict(stmt, facts.lockMode, dwell, blast, severity);

  return { statement: stmt, lockMode: facts.lockMode, dwell, blast, severity, safeRewrite: facts.safeRewrite, verdict };
}

export function analyzeSql(sql: string, stats: StatsSnapshot, cal?: Calibration): Finding[] {
  return parse(sql).map((s) => analyzeStatement(s, stats, cal));
}

function scoreSeverity(dwellSec: number, blast: { blockedQueries: number; queuePileupRisk: string }): Severity {
  if (blast.queuePileupRisk === 'high') return 'critical';
  if (dwellSec >= 1 && blast.blockedQueries >= 100) return 'critical';
  if (dwellSec >= 0.2 && blast.blockedQueries >= 10) return 'danger';
  if (blast.blockedQueries >= 1) return 'caution';
  return 'safe';
}

const ICON: Record<Severity, string> = { safe: '✅', caution: '⚠️', danger: '⛔', critical: '🔥' };

function renderVerdict(
  stmt: Statement,
  lockMode: string,
  dwell: { seconds: number; basis: string },
  blast: { blocksReads: boolean; blocksWrites: boolean; blockedQueries: number; queueNote: string | null },
  severity: Severity,
): string {
  const what = blast.blocksReads && blast.blocksWrites ? 'ALL reads + writes'
    : blast.blocksWrites ? 'writes'
    : blast.blocksReads ? 'reads' : 'nothing';
  const held = dwell.seconds < 0.05 ? `${Math.round(dwell.seconds * 1000)}ms` : `${dwell.seconds.toFixed(1)}s`;
  let line = `${ICON[severity]} ${stmt.kind} on ${stmt.table ?? '?'}: holds ${lockMode} ~${held}, blocking ${what}` +
    (blast.blockedQueries > 0 ? ` (~${blast.blockedQueries} queries at current load)` : '') + '.';
  if (blast.queueNote) line += `  LOCK QUEUE: ${blast.queueNote}`;
  return line;
}

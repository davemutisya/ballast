// `ballast check` — the OSS CLI (Wedge 0). A thin caller of the shared analyzer:
//   • with --dsn, weights every finding by REAL table size + live load (kills
//     false positives on small tables, quantifies real ones);
//   • without a DB, stays a conservative linter that never under-warns;
//   • every rule cites its verified source.
// Non-zero exit when a finding meets --fail-on (default: danger) → CI gate.

import fs from 'node:fs';
import path from 'node:path';

import { analyze, findingLines } from '../analyze.ts';
import { byId } from '../catalog/index.ts';
import { CalibrationStore } from '../calibration/store.ts';
import { fingerprintOf } from '../calibration/fingerprint.ts';
import { snapshot } from '../snapshot.ts';
import { parse } from '../parse.ts';
import type { Finding, Severity } from '../types.ts';

const SEV_RANK: Record<Severity, number> = { safe: 0, caution: 1, danger: 2, critical: 3 };

interface Args { paths: string[]; dsn?: string; table?: string; failOn: Severity; format: 'text' | 'json'; explain: boolean; }

function parseArgs(argv: string[]): Args {
  const a: Args = { paths: [], failOn: 'danger', format: 'text', explain: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dsn') a.dsn = argv[++i];
    else if (t === '--table') a.table = argv[++i];
    else if (t === '--fail-on') a.failOn = argv[++i] as Severity;
    else if (t === '--format') a.format = argv[++i] as 'text' | 'json';
    else if (t === '--json') a.format = 'json';
    else if (t === '--explain') a.explain = true;
    else if (!t.startsWith('-')) a.paths.push(t);
  }
  return a;
}

/** Extra verified detail from the matched catalog entry (why it's unsafe, edge cases). */
function explainLines(f: Finding): string[] {
  const e = f.catalogId ? byId(f.catalogId) : undefined;
  if (!e) return [];
  const out: string[] = [`     · [${e.id}] ${e.title}`];
  const bullets = (label: string, xs?: string[]) => xs?.slice(0, 2).forEach((x) => out.push(`       ${label} ${x}`));
  bullets('unsafe:', e.unsafeWhen);
  bullets('edge:', e.edgeCases);
  bullets('version:', e.versionNotes);
  if (e._correction) out.push(`       ✎ verifier: ${e._correction.slice(0, 140)}`);
  return out;
}

function collect(paths: string[]): { file: string; sql: string }[] {
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

export async function runCheck(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const store = new CalibrationStore(); // env-calibrated constants from `ballast calibrate`
  const results: { file: string; findings: Finding[] }[] = [];

  for (const { file, sql } of collect(args.paths)) {
    // A migration file may touch several tables; snapshot per statement's table.
    const findings: Finding[] = [];
    for (const stmt of parse(sql).filter((s) => s.kind !== 'UNKNOWN')) {
      const stats = args.dsn && stmt.table ? await snapshot(args.dsn, args.table ?? stmt.table) : null;
      const cal = stats ? store.toCalibration('postgres', fingerprintOf(stats)) : undefined;
      findings.push(...analyze(stmt.raw, stats, cal));
    }
    results.push({ file, findings });
  }

  if (args.format === 'json') console.log(JSON.stringify(results, null, 2));
  else render(results, !!args.dsn, args.explain);

  const worst = Math.max(0, ...results.flatMap((r) => r.findings.map((f) => SEV_RANK[f.severity])));
  return worst >= SEV_RANK[args.failOn] ? 1 : 0;
}

function render(results: { file: string; findings: Finding[] }[], loadAware: boolean, explain: boolean) {
  const n = results.reduce((s, r) => s + r.findings.length, 0);
  console.log(`\nballast check — ${results.length} file(s), ${n} statement(s)${loadAware ? ' [load-aware]' : ' [structural — --dsn for load-aware]'}\n`);
  const tally: Record<Severity, number> = { safe: 0, caution: 0, danger: 0, critical: 0 };
  for (const { file, findings } of results) {
    if (!findings.length) continue;
    console.log(path.relative(process.cwd(), file) || file);
    for (const f of findings) {
      tally[f.severity]++;
      console.log(findingLines(f).join('\n'));
      if (explain) { const ex = explainLines(f); if (ex.length) console.log(ex.join('\n')); }
    }
    console.log();
  }
  const parts = (['critical', 'danger', 'caution', 'safe'] as Severity[]).filter((s) => tally[s]).map((s) => `${tally[s]} ${s}`);
  console.log(`Summary: ${parts.join(', ') || 'nothing recognized'}`);
}


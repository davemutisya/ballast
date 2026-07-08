// `ballast check` — the OSS CLI (Wedge 0). A thin caller of the shared analyzer:
//   • with --dsn, weights every finding by REAL table size + live load (kills
//     false positives on small tables, quantifies real ones);
//   • without a DB, stays a conservative linter that never under-warns;
//   • every rule cites its verified source.
// Non-zero exit when a finding meets --fail-on (default: danger) → CI gate.

import path from 'node:path';

import { findingLines } from '../analyze.ts';
import { byId } from '../catalog/index.ts';
import { scan } from './scan.ts';
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

export async function runCheck(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const results = await scan(args.paths, args.dsn, args.table);

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


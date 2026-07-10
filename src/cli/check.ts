// `ballast check` — the OSS CLI (Wedge 0). A thin caller of the shared analyzer:
//   • with --dsn, weights every finding by REAL table size + live load (kills
//     false positives on small tables, quantifies real ones);
//   • without a DB, stays a conservative linter that never under-warns;
//   • every rule cites its verified source.
// Non-zero exit when a finding meets --fail-on (default: danger) → CI gate.

import path from 'node:path';

import { findingLines } from '../analyze.ts';
import { byId } from '../catalog/index.ts';
import { disclosureLines, scan, validFormat, validSeverity, type FileFindings, type ScanResult } from './scan.ts';
import type { Finding, Severity } from '../types.ts';

const SEV_RANK: Record<Severity, number> = { safe: 0, caution: 1, danger: 2, critical: 3 };

type Format = 'text' | 'json' | 'md';
interface Args { paths: string[]; dsn?: string; table?: string; failOn: Severity; format: Format; explain: boolean; }

function parseArgs(argv: string[]): Args {
  const a: Args = { paths: [], failOn: 'danger', format: 'text', explain: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dsn') a.dsn = argv[++i];
    else if (t === '--table') a.table = argv[++i];
    else if (t === '--fail-on') a.failOn = validSeverity(argv[++i]);
    else if (t === '--format') a.format = validFormat(argv[++i]);
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
  const scanned = await scan(args.paths, args.dsn, args.table);
  const results = scanned.results;

  if (args.format === 'json') console.log(JSON.stringify(scanned, null, 2));
  else if (args.format === 'md') console.log(renderMarkdown(scanned, !!args.dsn));
  else render(scanned, !!args.dsn, args.explain);

  const worst = Math.max(0, ...results.flatMap((r) => r.findings.map((f) => SEV_RANK[f.severity])));
  return worst >= SEV_RANK[args.failOn] ? 1 : 0;
}

const ICON: Record<Severity, string> = { safe: '✅', caution: '⚠️', danger: '⛔', critical: '🔥' };

/** A PR-comment-shaped report. The marker on line 1 lets the Action update in place. */
function renderMarkdown(scanned: ScanResult, loadAware: boolean): string {
  const results: FileFindings[] = scanned.results;
  const all = results.flatMap((r) => r.findings.map((f) => ({ f, file: r.file })));
  const unTotal = results.reduce((s, r) => s + r.unanalyzed.length, 0);
  const tally: Record<Severity, number> = { safe: 0, caution: 0, danger: 0, critical: 0 };
  for (const { f } of all) tally[f.severity]++;

  const out: string[] = ['<!-- ballast -->', '### 🚢 Ballast — migration safety', ''];
  const badge = (['critical', 'danger', 'caution', 'safe'] as Severity[])
    .filter((s) => tally[s]).map((s) => `${ICON[s]} ${tally[s]} ${s}`).join(' · ');
  out.push(`**${badge || 'nothing recognized'}** — ${loadAware ? 'load-aware (live database)' : 'structural (no DB connected)'}`);

  const flagged = all.filter(({ f }) => f.severity !== 'safe')
    .sort((a, b) => SEV_RANK[b.f.severity] - SEV_RANK[a.f.severity]);
  if (!flagged.length) {
    out.push('', '✅ No blocking issues in the analyzed migrations.');
  } else {
    out.push('');
    for (const { f, file } of flagged) {
      const rel = path.relative(process.cwd(), file) || file;
      out.push(`${ICON[f.severity]} **\`${rel}\`** — \`${f.statement.kind}\` on \`${f.statement.table ?? '?'}\``);
      out.push(`> ${f.verdict}`);
      if (f.safeRewrite) out.push(`> <details><summary>safe rewrite</summary>\n>\n> ${f.safeRewrite}\n> </details>`);
      if (f.provenance) out.push(`> <sub>✓ ${f.provenance}</sub>`);
      out.push('');
    }
  }
  if (unTotal) out.push('', `⚠️ ${unTotal} statement(s) could not be analyzed — run \`ballast check\` locally for the list.`);
  out.push(
    '<sub>Ballast weights each finding by real table size + live load — the danger a static linter can’t see. ' +
    '[ballast-pg](https://github.com/davemutisya/ballast) · MIT</sub>',
  );
  return out.join('\n');
}

function render(scanned: ScanResult, loadAware: boolean, explain: boolean) {
  const results = scanned.results;
  const n = results.reduce((s, r) => s + r.findings.length, 0);
  const benign = results.reduce((s, r) => s + r.benign, 0);
  console.log(`\nballast check — ${results.length} file(s), ${n} DDL statement(s)${loadAware ? ' [load-aware]' : ' [structural — --dsn for load-aware]'}\n`);
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
  console.log(`Summary: ${parts.join(', ') || 'nothing recognized'}${benign ? `  (+ ${benign} benign statement(s))` : ''}`);
  const disc = disclosureLines(scanned);
  if (disc.length) console.log('\n' + disc.join('\n'));
}


// `ballast check` — the OSS CLI (Wedge 0). Catches dangerous Postgres migrations
// like Squawk/strong_migrations, but:
//   • with --dsn it weights every finding by REAL table size + live load (the
//     thing static linters can't do) — which KILLS false positives on small
//     tables and quantifies the real ones ("locks writes ~40s, ~2k queries").
//   • without a DB it stays a conservative linter that never under-warns.
//   • every rule cites its verified source (trust: no linter does this).
//
// Exit code is non-zero when a finding meets --fail-on (default: danger), so it
// drops straight into CI as a gate.

import fs from 'node:fs';
import path from 'node:path';

import { analyzeStatement } from '../analyze.ts';
import { lockFactsFor } from '../lockModel.ts';
import { find } from '../catalog/index.ts';
import { parse } from '../parse.ts';
import { snapshot } from '../snapshot.ts';
import type { Finding, Severity, StatsSnapshot, Statement } from '../types.ts';

const SEV_RANK: Record<Severity, number> = { safe: 0, caution: 1, danger: 2, critical: 3 };
const ICON: Record<Severity, string> = { safe: '✅', caution: '⚠️ ', danger: '⛔', critical: '🔥' };

interface Args { paths: string[]; dsn?: string; table?: string; failOn: Severity; format: 'text' | 'json'; }

function parseArgs(argv: string[]): Args {
  const a: Args = { paths: [], failOn: 'danger', format: 'text' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dsn') a.dsn = argv[++i];
    else if (t === '--table') a.table = argv[++i];
    else if (t === '--fail-on') a.failOn = argv[++i] as Severity;
    else if (t === '--format') a.format = argv[++i] as 'text' | 'json';
    else if (t === '--json') a.format = 'json';
    else if (!t.startsWith('-')) a.paths.push(t);
  }
  return a;
}

/** Collect .sql sources from files, directories, or stdin. */
function collect(paths: string[]): { file: string; sql: string }[] {
  if (paths.length === 0) return [{ file: '<stdin>', sql: fs.readFileSync(0, 'utf8') }];
  const out: { file: string; sql: string }[] = [];
  for (const p of paths) {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p).filter((f) => f.endsWith('.sql')).sort())
        out.push({ file: path.join(p, f), sql: fs.readFileSync(path.join(p, f), 'utf8') });
    } else out.push({ file: p, sql: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

/** Structural (no load data): conservative, pattern-based — must never under-warn. */
function structuralFinding(stmt: Statement): Finding {
  const f = lockFactsFor(stmt);
  let severity: Severity = 'safe';
  if (f.costClass === 'REWRITE') severity = 'danger';               // rewrites are always heavy
  else if (f.costClass === 'SCAN' && f.blocksWrites) severity = 'danger'; // scan-bound write block, unknown size
  else if (f.lockMode === 'ACCESS EXCLUSIVE') severity = 'caution'; // metadata, but queue risk if a long txn is live
  else if (f.safeRewrite) severity = 'caution';
  const held = f.costClass === 'METADATA_ONLY' ? 'briefly' : 'for the whole operation (scales with table size)';
  const what = f.blocksReads && f.blocksWrites ? 'reads + writes' : f.blocksWrites ? 'writes' : f.blocksReads ? 'reads' : 'nothing';
  return {
    statement: stmt, lockMode: f.lockMode,
    dwell: { costClass: f.costClass, seconds: 0, low: 0, high: 0, basis: 'unknown size — connect --dsn to quantify' },
    blast: { blocksReads: f.blocksReads, blocksWrites: f.blocksWrites, blockedQueries: 0, queuePileupRisk: 'none', queueNote: null },
    severity, safeRewrite: f.safeRewrite,
    verdict: `${ICON[severity]} ${stmt.kind} on ${stmt.table ?? '?'} — ${f.lockMode}, blocks ${what} ${held}` +
      (f.costClass !== 'METADATA_ONLY' ? '  (connect --dsn to quantify blast radius)' : '  (danger rises sharply if a long-running txn is active — --dsn checks this)'),
  };
}

/** The verified-catalog cross-reference — cite the source. */
function provenance(kind: string): string | null {
  const kw: Record<string, string> = {
    CREATE_INDEX: 'create-index-nonconcurrent', SET_NOT_NULL: 'not null', ALTER_TYPE: 'alter-column-type',
    DROP_COLUMN: 'drop-column-basic', ADD_COLUMN_DEFAULT_VOLATILE: 'volatile', ADD_COLUMN_DEFAULT_CONST: 'add-col',
  };
  const e = find(kw[kind] ?? kind)[0];
  const src = e?.sources?.find((s) => s.includes('postgresql.org')) ?? e?.sources?.[0];
  return src ? `verified vs ${src.replace('https://www.postgresql.org', 'postgresql.org')}` : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = collect(args.paths);
  const results: { file: string; findings: Finding[] }[] = [];

  for (const { file, sql } of sources) {
    const stmts = parse(sql).filter((s) => s.kind !== 'UNKNOWN');
    const findings: Finding[] = [];
    for (const stmt of stmts) {
      if (args.dsn && stmt.table) {
        const stats: StatsSnapshot = await snapshot(args.dsn, args.table ?? stmt.table);
        findings.push(analyzeStatement(stmt, stats));
      } else {
        findings.push(structuralFinding(stmt));
      }
    }
    results.push({ file, findings });
  }

  if (args.format === 'json') { console.log(JSON.stringify(results, null, 2)); }
  else render(results, !!args.dsn);

  const worst = Math.max(0, ...results.flatMap((r) => r.findings.map((f) => SEV_RANK[f.severity])));
  process.exit(worst >= SEV_RANK[args.failOn] ? 1 : 0);
}

function render(results: { file: string; findings: Finding[] }[], loadAware: boolean) {
  const n = results.reduce((s, r) => s + r.findings.length, 0);
  console.log(`\nballast check — ${results.length} file(s), ${n} recognized statement(s)${loadAware ? ' [load-aware]' : ' [structural — connect --dsn for load-aware]'}\n`);
  const tally: Record<Severity, number> = { safe: 0, caution: 0, danger: 0, critical: 0 };
  for (const { file, findings } of results) {
    if (!findings.length) continue;
    console.log(path.relative(process.cwd(), file) || file);
    for (const f of findings) {
      tally[f.severity]++;
      console.log('  ' + f.verdict);
      if (f.safeRewrite && (f.severity === 'danger' || f.severity === 'critical')) console.log(`     ↳ safe rewrite: ${f.safeRewrite}`);
      const p = provenance(f.statement.kind);
      if (p) console.log(`     ✓ ${p}`);
    }
    console.log();
  }
  const parts = (['critical', 'danger', 'caution', 'safe'] as Severity[]).filter((s) => tally[s]).map((s) => `${tally[s]} ${s}`);
  console.log(`Summary: ${parts.join(', ') || 'nothing recognized'}`);
}

main().catch((e) => { console.error('ballast: ' + (e as Error).message); process.exit(2); });

// `ballast audit` — the forensic sweep. Where `check` is a per-migration CI gate
// (does THIS change ship?), `audit` is a whole-repo assessment (what dangerous
// migrations are ALREADY in my history, and which matter most at today's scale?).
// It reuses the exact same analyzer as `check` (via scan()), then aggregates the
// findings into a prioritized report — the first-run "look at all this" moment.

import path from 'node:path';

import { scan } from './scan.ts';
import type { Finding, Severity } from '../types.ts';

const SEV_RANK: Record<Severity, number> = { safe: 0, caution: 1, danger: 2, critical: 3 };
const ICON: Record<Severity, string> = { safe: '✅', caution: '⚠️ ', danger: '⛔', critical: '🔥' };

interface Args { paths: string[]; dsn?: string; table?: string; top: number; failOn?: Severity }
interface Located { f: Finding; file: string }

function parseArgs(argv: string[]): Args {
  const a: Args = { paths: [], top: 10 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dsn') a.dsn = argv[++i];
    else if (t === '--table') a.table = argv[++i];
    else if (t === '--top') a.top = Math.max(1, parseInt(argv[++i], 10) || 10);
    else if (t === '--fail-on') a.failOn = argv[++i] as Severity;
    else if (!t.startsWith('-')) a.paths.push(t);
  }
  return a;
}

/** How bad is one finding, for ranking. Load-aware: real dwell dominates; else severity. */
function weight(f: Finding, loadAware: boolean): number {
  const sev = SEV_RANK[f.severity] * 1e9;
  if (loadAware) return sev + f.dwell.seconds * 1e6 + f.blast.blockedQueries;
  return sev + f.dwell.seconds * 1e3;
}

function tallyBy<T>(items: T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function rel(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

export async function runAudit(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const loadAware = !!args.dsn;
  const results = await scan(args.paths, args.dsn, args.table);

  const flat: Located[] = results.flatMap((r) => r.findings.map((f) => ({ f, file: r.file })));
  const risky = flat.filter((x) => SEV_RANK[x.f.severity] >= SEV_RANK.danger);
  const tally: Record<Severity, number> = { safe: 0, caution: 0, danger: 0, critical: 0 };
  for (const { f } of flat) tally[f.severity]++;
  const tables = new Set(flat.map((x) => x.f.statement.table ?? '?'));

  console.log(`\nBallast audit — ${rel(args.paths[0] ?? '<stdin>')}`);
  console.log(
    `Scanned ${results.length} migration(s), ${flat.length} recognized statement(s) across ` +
      `${tables.size} table(s).  ${loadAware ? '[load-aware — weighted by live production]' : '[structural — pass --dsn to weight by real size + load]'}\n`,
  );

  const headline = (['critical', 'danger', 'caution', 'safe'] as Severity[])
    .filter((s) => tally[s])
    .map((s) => `${ICON[s].trim()} ${tally[s]} ${s}`)
    .join('   ');
  console.log(headline || 'nothing recognized');

  if (!risky.length) {
    console.log('\nNo latent risks found in your migration history. Clean bill of health.\n');
    return decideExit(tally, args.failOn);
  }

  // ── By risk type ────────────────────────────────────────────────────────────
  console.log('\nBy risk type (most common first):');
  const repr = new Map<string, Finding>();
  for (const { f } of risky) if (!repr.has(f.statement.kind)) repr.set(f.statement.kind, f);
  for (const [kind, n] of tallyBy(risky, (x) => x.f.statement.kind)) {
    const r = repr.get(kind)!;
    console.log(`  ${String(n).padStart(3)} × ${kind.padEnd(24)} — ${r.dwell.costClass}, holds ${r.lockMode}`);
  }

  // ── Hottest tables ──────────────────────────────────────────────────────────
  console.log('\nHottest tables (most dangerous operations accumulated):');
  for (const [tbl, n] of tallyBy(risky, (x) => x.f.statement.table ?? '?').slice(0, 8)) {
    console.log(`  ${String(n).padStart(3)} × ${tbl}`);
  }

  // ── Top time-bombs ──────────────────────────────────────────────────────────
  const ranked = [...risky].sort((a, b) => weight(b.f, loadAware) - weight(a.f, loadAware));
  console.log(`\nTop ${Math.min(args.top, ranked.length)} time-bombs (fix these first):`);
  ranked.slice(0, args.top).forEach(({ f, file }, i) => {
    const where = `${rel(file)} — ${f.statement.kind} on ${f.statement.table ?? '?'}`;
    const cost = loadAware
      ? `~${f.dwell.seconds < 1 ? Math.round(f.dwell.seconds * 1000) + 'ms' : f.dwell.seconds.toFixed(1) + 's'} lock` +
        (f.blast.queuePileupRisk !== 'none' ? `, queue risk ${f.blast.queuePileupRisk}` : '')
      : f.dwell.costClass;
    console.log(`  ${String(i + 1).padStart(2)}. ${ICON[f.severity]} ${where}  [${cost}]`);
    console.log(`      ${f.verdict}`);
  });

  console.log('\nFix any one with:  ballast check <file> --explain   (shows the verified safe rewrite)');
  if (!loadAware) console.log('Re-run with --dsn "$DATABASE_URL" to rank these by real blast radius at today\'s scale.');
  console.log();

  return decideExit(tally, args.failOn);
}

/** Audit is informational by default (exit 0). --fail-on makes it a gate too. */
function decideExit(tally: Record<Severity, number>, failOn?: Severity): number {
  if (!failOn) return 0;
  const worst = (['critical', 'danger', 'caution', 'safe'] as Severity[]).find((s) => tally[s]);
  return worst && SEV_RANK[worst] >= SEV_RANK[failOn] ? 1 : 0;
}

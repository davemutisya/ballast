// Single CLI entrypoint: `ballast <check|calibrate>`. Bundled to dist/cli/index.js
// for `npx ballast`.

import { runAudit } from './audit.ts';
import { runCalibrate } from './calibrate.ts';
import { runCheck } from './check.ts';

const HELP = `ballast — load-aware migration safety for the AI-agent era

usage:
  ballast check [paths...] [--dsn <url>] [--explain] [--fail-on danger|critical] [--json]
      Lint migrations. With --dsn, weights each finding by real table size + live load.
      Exits non-zero when a finding meets --fail-on (default: danger) — drop into CI.

  ballast audit [paths...] [--dsn <url>] [--top 10] [--fail-on danger|critical]
      Forensic sweep of your whole migration history: what dangerous changes are
      already in the repo, ranked by real blast radius at today's scale. A report,
      not a gate (exit 0 unless --fail-on). The best first-run.

  ballast calibrate --dsn <url> [--sizes 100000,1000000] [--storage ebs-gp3]
      Measure this database's real lock throughput into ~/.ballast (local, private).`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'check': return runCheck(rest);
    case 'audit': return runAudit(rest);
    case 'calibrate': return runCalibrate(rest);
    case undefined:
    case '-h':
    case '--help': console.log(HELP); return cmd === undefined ? 1 : 0;
    default:
      if (!cmd.startsWith('-')) return runCheck(process.argv.slice(2)); // `ballast migrations/` → check
      console.error(HELP); return 2;
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error('ballast: ' + (e as Error).message); process.exit(2); });

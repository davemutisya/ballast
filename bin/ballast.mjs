#!/usr/bin/env node
// Thin launcher for the CLI during development (runs the TS directly via tsx).
// The shipped build will bundle this to plain JS (esbuild) — see PLAN.md.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const r = spawnSync('npx', ['tsx', path.join(root, 'src/cli/check.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);

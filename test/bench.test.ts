// docs/COMPARISON.md publishes reproducible numbers ("expect 15 danger, 3
// caution / 13 safe, 0 flagged"). Anyone can re-run them — so CI must guarantee
// they never silently drift. If a rule change legitimately moves these tallies,
// update BOTH this test and docs/COMPARISON.md in the same commit.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { analyzeScript } from '../src/pipeline.ts';

const corpus = (f: string) =>
  fs.readFileSync(path.join(import.meta.dirname, '../bench/corpus', f), 'utf8');

test('benchmark corpus: dangerous.sql tallies match the published numbers', async () => {
  const r = await analyzeScript(corpus('dangerous.sql'));
  const tally = { safe: 0, caution: 0, danger: 0, critical: 0 };
  for (const f of r.findings) tally[f.severity]++;
  assert.equal(tally.danger, 15, JSON.stringify(tally));
  assert.equal(tally.caution, 3, JSON.stringify(tally));
  assert.equal(r.unanalyzed.length, 0);
  // Every ground-truth danger line is flagged: nothing dangerous grades safe
  // except the dual-emitted ADD_COLUMN base whose FK half IS flagged.
  const safes = r.findings.filter((f) => f.severity === 'safe');
  assert.equal(safes.length, 1);
  assert.equal(safes[0].statement.kind, 'ADD_COLUMN');
});

test('benchmark corpus: safe.sql produces ZERO false positives', async () => {
  const r = await analyzeScript(corpus('safe.sql'));
  const flagged = r.findings.filter((f) => f.severity !== 'safe');
  assert.deepEqual(flagged.map((f) => [f.statement.kind, f.severity]), []);
  assert.equal(r.unanalyzed.length, 0);
});

// Pipeline-level contracts: the same-file exemption, its destructive-recreate
// guard, and the ballast-ignore escape hatch. These run through analyzeScript —
// the exact code path `check`, `audit`, and the MCP server share.

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeScript } from '../src/pipeline.ts';

test('index/constraint on a relation created in the same file is exempt', async () => {
  const r = await analyzeScript(`
    CREATE TABLE fresh (id int, v int);
    CREATE INDEX i ON fresh (v);
    ALTER TABLE fresh ADD CONSTRAINT c CHECK (v > 0);
  `);
  assert.ok(r.findings.every((f) => f.severity === 'safe'), JSON.stringify(r.findings.map((f) => [f.statement.kind, f.severity])));
});

test('matview created in the same file exempts its indexes (Sajili bug)', async () => {
  const r = await analyzeScript(`
    CREATE MATERIALIZED VIEW mv AS SELECT 1 AS x;
    CREATE INDEX i ON mv (x);
  `);
  const idx = r.findings.find((f) => f.statement.kind === 'CREATE_INDEX')!;
  assert.equal(idx.severity, 'safe');
});

test('destructive-recreate is NEVER exempted by the same-file CREATE', async () => {
  const r = await analyzeScript(`
    DROP TABLE users;
    CREATE TABLE users (id int);
    TRUNCATE audit_log;
    CREATE TABLE IF NOT EXISTS audit_log (id int);
  `);
  const bySev = Object.fromEntries(r.findings.map((f) => [f.statement.kind, f.severity]));
  assert.equal(bySev.DROP_TABLE, 'danger');
  assert.equal(bySev.TRUNCATE, 'danger');
});

test('FK on a same-file (empty) child grades safe but the verdict names the parent lock', async () => {
  const r = await analyzeScript(`
    CREATE TABLE child (id int);
    ALTER TABLE child ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES big_old_parent(id);
  `);
  const fk = r.findings.find((f) => f.statement.kind === 'ADD_FOREIGN_KEY')!;
  assert.equal(fk.severity, 'safe'); // empty child → instant validation scan
  assert.match(fk.verdict, /parent is still briefly locked/);
});

test('FK on a PRE-EXISTING child stays danger (real validation scan)', async () => {
  const r = await analyzeScript('ALTER TABLE old_child ADD CONSTRAINT fk FOREIGN KEY (x) REFERENCES p(id);');
  assert.equal(r.findings[0].severity, 'danger');
});

test('ballast-ignore suppresses the gate but stays visible', async () => {
  const r = await analyzeScript(`
    -- ballast-ignore: intentional, maintenance window booked
    CREATE INDEX i ON big_hot_table (v);
  `);
  const f = r.findings[0];
  assert.equal(f.severity, 'safe');
  assert.match(f.verdict, /suppressed by ballast-ignore/);
  assert.match(f.verdict, /would have been: danger/);
});

test('without the marker the same statement still gates', async () => {
  const r = await analyzeScript('CREATE INDEX i ON big_hot_table (v);');
  assert.equal(r.findings[0].severity, 'danger');
});

test('benign statements are counted, never dropped', async () => {
  const r = await analyzeScript(`
    SELECT 1;
    GRANT SELECT ON t TO someone;
  `);
  assert.equal(r.benign, 2);
  assert.equal(r.unanalyzed.length, 0);
});

test('a syntax error marks the WHOLE script unanalyzed — disclosed, not silent', async () => {
  // libpg_query parses all-or-nothing: one bad statement poisons the file. The
  // contract is that this is VISIBLE (unanalyzed, with the parse error), never a
  // silent pass. Per-chunk recovery is a possible future refinement.
  const r = await analyzeScript(`
    CREATE INDEX i ON t (x);
    ALTER TABLE x FROBNICATE y;
  `);
  assert.equal(r.findings.length, 0);
  assert.equal(r.unanalyzed.length, 1);
  assert.match(r.unanalyzed[0].detail ?? '', /did not parse/);
});

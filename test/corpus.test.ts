// The statement corpus: every (SQL → kind, structural severity) contract Ballast
// makes. Each entry exists because getting it wrong once cost trust — several
// were live bugs found by dogfooding or external audit. Add a case with every
// fix; never delete one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parse, isAnalyzable } from '../src/parse.ts';
import { structuralFinding } from '../src/analyze.ts';
import type { Severity } from '../src/types.ts';

interface Case { sql: string; kind: string; severity?: Severity; table?: string; why?: string }

const CASES: Case[] = [
  // ── indexes ──
  { sql: 'CREATE INDEX i ON orders (email);', kind: 'CREATE_INDEX', severity: 'danger' },
  { sql: 'CREATE INDEX CONCURRENTLY i ON orders (email);', kind: 'CREATE_INDEX', severity: 'safe' },
  { sql: 'CREATE UNIQUE INDEX CONCURRENTLY i ON orders (email);', kind: 'CREATE_INDEX', severity: 'safe' },
  { sql: 'DROP INDEX idx_old;', kind: 'DROP_INDEX', severity: 'safe', why: 'metadata-only; brief AE' },
  { sql: 'DROP INDEX CONCURRENTLY idx_old;', kind: 'DROP_INDEX', severity: 'safe' },
  { sql: 'REINDEX TABLE orders;', kind: 'REINDEX', severity: 'danger' },
  { sql: 'REINDEX TABLE CONCURRENTLY orders;', kind: 'REINDEX', severity: 'safe' },

  // ── the fast-default volatility rule (verified: 0.9ms vs 1249ms on 2M rows) ──
  { sql: 'ALTER TABLE t ADD COLUMN c timestamptz NOT NULL DEFAULT now();', kind: 'ADD_COLUMN_DEFAULT_CONST', severity: 'safe', why: 'now() is STABLE → fast default, no rewrite (PG11+)' },
  { sql: "ALTER TABLE t ADD COLUMN c text DEFAULT 'web';", kind: 'ADD_COLUMN_DEFAULT_CONST', severity: 'safe' },
  { sql: 'ALTER TABLE t ADD COLUMN c uuid DEFAULT gen_random_uuid();', kind: 'ADD_COLUMN_DEFAULT_VOLATILE', severity: 'danger', why: 'volatile → full rewrite' },
  { sql: 'ALTER TABLE t ADD COLUMN c float DEFAULT random();', kind: 'ADD_COLUMN_DEFAULT_VOLATILE', severity: 'danger' },
  { sql: 'ALTER TABLE t ADD COLUMN c serial;', kind: 'ADD_COLUMN_DEFAULT_VOLATILE', severity: 'danger', why: 'serial = nextval()' },
  { sql: 'ALTER TABLE t ADD COLUMN c int GENERATED ALWAYS AS IDENTITY;', kind: 'ADD_COLUMN_DEFAULT_VOLATILE', severity: 'danger' },
  { sql: 'ALTER TABLE t ADD COLUMN c timestamptz DEFAULT my_custom_fn();', kind: 'ADD_COLUMN_DEFAULT_VOLATILE', severity: 'danger', why: 'unknown fn → assume volatile, never under-warn' },
  { sql: 'ALTER TABLE t ADD COLUMN c text;', kind: 'ADD_COLUMN', severity: 'safe' },

  // ── USING INDEX must never be flagged: it IS our own safe rewrite (audit #4) ──
  { sql: 'ALTER TABLE t ADD CONSTRAINT k UNIQUE USING INDEX k_idx;', kind: 'ADD_UNIQUE_USING_INDEX', severity: 'safe' },
  { sql: 'ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY USING INDEX pk_idx;', kind: 'ADD_PK_USING_INDEX', severity: 'safe' },
  { sql: 'ALTER TABLE t ADD CONSTRAINT k UNIQUE (email);', kind: 'ADD_UNIQUE', severity: 'danger' },
  { sql: 'ALTER TABLE t ADD PRIMARY KEY (id);', kind: 'ADD_PRIMARY_KEY', severity: 'danger' },

  // ── constraints ──
  { sql: 'ALTER TABLE t ADD CONSTRAINT c CHECK (v > 0);', kind: 'ADD_CHECK', severity: 'danger' },
  { sql: 'ALTER TABLE t ADD CONSTRAINT c CHECK (v > 0) NOT VALID;', kind: 'ADD_CHECK', severity: 'safe' },
  { sql: 'ALTER TABLE t VALIDATE CONSTRAINT c;', kind: 'VALIDATE_CONSTRAINT', severity: 'safe' },
  { sql: 'ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (x) REFERENCES p(id);', kind: 'ADD_FOREIGN_KEY', severity: 'danger' },
  { sql: 'ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (x) REFERENCES p(id) NOT VALID;', kind: 'ADD_FOREIGN_KEY', severity: 'safe' },
  { sql: 'ALTER TABLE t ALTER COLUMN c SET NOT NULL;', kind: 'SET_NOT_NULL', severity: 'danger' },
  { sql: 'ALTER TABLE t ALTER COLUMN c TYPE bigint;', kind: 'ALTER_TYPE', severity: 'danger' },

  // ── metadata-only ops grade safe structurally (load risk is --dsn's job) ──
  { sql: 'ALTER TABLE t ALTER COLUMN c SET DEFAULT 5;', kind: 'SET_DEFAULT', severity: 'safe' },
  { sql: 'ALTER TABLE t ALTER COLUMN c DROP DEFAULT;', kind: 'DROP_DEFAULT', severity: 'safe' },
  { sql: 'ALTER TABLE t ALTER COLUMN c DROP NOT NULL;', kind: 'DROP_NOT_NULL', severity: 'safe' },
  { sql: 'ALTER TABLE t DROP CONSTRAINT c;', kind: 'DROP_CONSTRAINT', severity: 'safe' },

  // ── app-breakage floor: caution even though the lock is instant ──
  { sql: 'ALTER TABLE t DROP COLUMN c;', kind: 'DROP_COLUMN', severity: 'caution' },
  { sql: 'ALTER TABLE t RENAME COLUMN a TO b;', kind: 'RENAME_COLUMN', severity: 'caution' },
  { sql: 'ALTER TABLE t RENAME TO t2;', kind: 'RENAME_TABLE', severity: 'caution' },
  { sql: 'ALTER TABLE t RENAME CONSTRAINT a TO b;', kind: 'RENAME_CONSTRAINT', severity: 'safe' },
  { sql: 'ALTER INDEX i RENAME TO j;', kind: 'RENAME_INDEX', severity: 'safe' },

  // ── destructive: danger regardless of lock speed ──
  { sql: 'DROP TABLE users;', kind: 'DROP_TABLE', severity: 'danger' },
  { sql: 'DROP MATERIALIZED VIEW mv;', kind: 'DROP_TABLE', severity: 'danger' },
  { sql: 'TRUNCATE audit_log;', kind: 'TRUNCATE', severity: 'danger' },

  // ── heavy table ops ──
  { sql: 'VACUUM FULL orders;', kind: 'VACUUM_FULL', severity: 'danger' },
  { sql: 'CLUSTER orders USING idx;', kind: 'CLUSTER', severity: 'danger' },
  { sql: 'ALTER TABLE t SET LOGGED;', kind: 'SET_LOGGED', severity: 'danger', why: 'full rewrite — Squawk misses this' },
  { sql: 'ALTER TABLE t SET UNLOGGED;', kind: 'SET_UNLOGGED', severity: 'danger' },
  { sql: 'REFRESH MATERIALIZED VIEW mv;', kind: 'REFRESH_MATVIEW', severity: 'danger' },
  { sql: 'REFRESH MATERIALIZED VIEW CONCURRENTLY mv;', kind: 'REFRESH_MATVIEW', severity: 'safe' },

  // ── partitions ──
  { sql: "ALTER TABLE m ATTACH PARTITION p FOR VALUES FROM ('a') TO ('b');", kind: 'ATTACH_PARTITION', severity: 'caution' },
  { sql: 'ALTER TABLE m DETACH PARTITION p;', kind: 'DETACH_PARTITION', severity: 'safe' },

  // ── backfills (audit #16 — strong_migrations catches these; Squawk doesn't) ──
  { sql: 'UPDATE events SET processed = true;', kind: 'UNBATCHED_DML', severity: 'caution' },
  { sql: 'DELETE FROM events;', kind: 'UNBATCHED_DML', severity: 'caution' },

  // ── enum ──
  { sql: "ALTER TYPE mood ADD VALUE 'ok';", kind: 'ALTER_ENUM_ADD_VALUE', severity: 'safe' },
];

test('statement corpus: kind + structural severity', async () => {
  for (const c of CASES) {
    const stmts = (await parse(c.sql)).filter(isAnalyzable);
    const match = stmts.find((s) => s.kind === c.kind);
    assert.ok(match, `${c.sql}\n  expected kind ${c.kind}, got [${stmts.map((s) => s.kind).join(', ')}]${c.why ? `  (${c.why})` : ''}`);
    if (c.severity) {
      const f = structuralFinding(match);
      assert.equal(f.severity, c.severity, `${c.sql}\n  expected ${c.severity}, got ${f.severity}${c.why ? `  (${c.why})` : ''}`);
    }
    if (c.table) assert.equal(match.table, c.table, c.sql);
  }
});

test('inline FK on ADD COLUMN emits BOTH findings (audit #1 under-warn)', async () => {
  const stmts = (await parse('ALTER TABLE orders ADD COLUMN user_id bigint REFERENCES users(id);')).filter(isAnalyzable);
  const kinds = stmts.map((s) => s.kind).sort();
  assert.deepEqual(kinds, ['ADD_COLUMN', 'ADD_FOREIGN_KEY']);
  assert.equal(structuralFinding(stmts.find((s) => s.kind === 'ADD_FOREIGN_KEY')!).severity, 'danger');
});

test('CREATE TABLE with FK reports the parent lock (audit #2)', async () => {
  const stmts = await parse('CREATE TABLE child (id int, order_id bigint REFERENCES orders(id), FOREIGN KEY (id) REFERENCES other(id));');
  const fk = stmts.filter((s) => s.kind === 'CREATE_TABLE_FK').map((s) => s.table).sort();
  assert.deepEqual(fk, ['orders', 'other']);
  for (const s of stmts.filter((x) => x.kind === 'CREATE_TABLE_FK'))
    assert.equal(structuralFinding(s).severity, 'safe'); // brief parent lock: structural-safe, --dsn catches queue risk
});

test('multi-command ALTER decomposes into one finding per command', async () => {
  const stmts = (await parse('ALTER TABLE t ADD COLUMN a int, DROP COLUMN b, ALTER COLUMN c SET NOT NULL;')).filter(isAnalyzable);
  assert.deepEqual(stmts.map((s) => s.kind).sort(), ['ADD_COLUMN', 'DROP_COLUMN', 'SET_NOT_NULL']);
});

test('dollar-quoted function bodies are benign, not chopped', async () => {
  const sql = `CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN NEW.x := 1; RETURN NEW; END; $$ LANGUAGE plpgsql;
               CREATE INDEX i ON t (x);`;
  const stmts = await parse(sql);
  assert.equal(stmts.filter((s) => s.kind === 'BENIGN').length, 1);
  assert.equal(stmts.filter((s) => s.kind === 'CREATE_INDEX').length, 1);
});

test('unparseable SQL is UNANALYZED, never silently dropped', async () => {
  const stmts = await parse('ALTER TABLE x FROBNICATE y;');
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0].kind, 'UNANALYZED');
  assert.match(stmts[0].detail ?? '', /did not parse/);
});

test('byte-accurate slices survive unicode comments (NOT VALID binding)', async () => {
  const sql = `-- unicode → arrow and émoji 🚀 before the statement\nALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (x) REFERENCES p(id) NOT VALID;`;
  const stmts = (await parse(sql)).filter(isAnalyzable);
  assert.equal(structuralFinding(stmts[0]).severity, 'safe'); // NOT VALID must still be seen in raw
});

test('schema-qualified names are preserved', async () => {
  const stmts = (await parse('ALTER TABLE analytics.facts ADD COLUMN c int;')).filter(isAnalyzable);
  assert.equal(stmts[0].table, 'analytics.facts');
});

test('UPDATE with a WHERE clause is benign (selectivity unknowable statically)', async () => {
  const stmts = await parse('UPDATE events SET processed = true WHERE id < 1000;');
  assert.equal(stmts[0].kind, 'BENIGN');
});

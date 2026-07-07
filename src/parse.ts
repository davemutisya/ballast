// DDL recogniser. Covers the dangerous-operation surface a Postgres migration
// linter must catch (superset of Squawk's rule set), each classified to a
// canonical `kind` that binds to a verified catalog entry (see catalog/match.ts).
// Production will swap in a real SQL parser + ORM adapters; this proves coverage.

import type { Statement } from './types.ts';

const VOLATILE_DEFAULT = /\bdefault\b[^,)]*\b(now|gen_random_uuid|uuid_generate|random|clock_timestamp|current_timestamp|statement_timestamp|transaction_timestamp)\s*\(/i;

export function parse(sql: string): Statement[] {
  return sql.split(';').map((s) => s.trim()).filter(Boolean).map(classify);
}

function classify(raw: string): Statement {
  const s = raw.replace(/\s+/g, ' ').trim();
  return { raw: s, kind: kindOf(s), table: tableOf(s.toLowerCase()), concurrent: /\bconcurrently\b/i.test(s) };
}

function kindOf(s: string): string {
  const has = (re: RegExp) => re.test(s);
  // Statement-leading forms first.
  if (has(/^create\s+(unique\s+)?index\b/i)) return 'CREATE_INDEX';
  if (has(/^reindex\b/i)) return 'REINDEX';
  if (has(/^vacuum\s+full\b/i)) return 'VACUUM_FULL';
  if (has(/^cluster\b/i)) return 'CLUSTER';
  if (has(/^alter\s+index\b[^;]*\brename\b/i)) return 'RENAME_INDEX';
  // ALTER TABLE clauses (order: specific → general).
  if (has(/\brename\s+constraint\b/i)) return 'RENAME_CONSTRAINT';
  if (has(/\brename\s+column\b/i)) return 'RENAME_COLUMN';
  if (has(/\brename\s+to\b/i)) return 'RENAME_TABLE';
  if (has(/\bvalidate\s+constraint\b/i)) return 'VALIDATE_CONSTRAINT';
  if (has(/\badd\b[^;]*\bforeign\s+key\b/i) || (has(/\badd\s+constraint\b/i) && has(/\breferences\b/i))) return 'ADD_FOREIGN_KEY';
  if (has(/\badd\b[^;]*\bprimary\s+key\b/i)) return 'ADD_PRIMARY_KEY';
  if (has(/\badd\s+(constraint\s+\S+\s+)?unique\b/i)) return 'ADD_UNIQUE';
  if (has(/\badd\s+(constraint\s+\S+\s+)?check\b/i)) return 'ADD_CHECK';
  if (has(/\bset\s+not\s+null\b/i)) return 'SET_NOT_NULL';
  if (has(/\balter\s+column\b[^;]*\b(type|set\s+data\s+type)\b/i)) return 'ALTER_TYPE';
  if (has(/\bset\s+default\b/i)) return 'SET_DEFAULT';
  if (has(/\bdrop\s+default\b/i)) return 'DROP_DEFAULT';
  if (has(/\bdrop\s+column\b/i)) return 'DROP_COLUMN';
  if (has(/\badd\s+column\b/i)) {
    if (/\bdefault\b/i.test(s)) return VOLATILE_DEFAULT.test(s) ? 'ADD_COLUMN_DEFAULT_VOLATILE' : 'ADD_COLUMN_DEFAULT_CONST';
    return 'ADD_COLUMN';
  }
  return 'UNKNOWN';
}

function tableOf(lower: string): string | null {
  const m =
    lower.match(/\bon\s+(?:only\s+)?([a-z_][\w.]*)/) ||                                   // CREATE INDEX ... ON t
    lower.match(/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([a-z_][\w.]*)/) ||     // ALTER TABLE t
    lower.match(/\b(?:reindex\s+table|cluster|vacuum\s+full)\s+(?:concurrently\s+)?([a-z_][\w.]*)/) ||
    lower.match(/\balter\s+index\s+([a-z_][\w.]*)/);
  return m ? m[1].replace(/"/g, '') : null;
}

// Minimal DDL recogniser for Spike 1 — enough to classify the top-5 dangerous
// patterns. (Production will use a real SQL parser + ORM adapters; this proves
// the model, not the parser.)

import type { Statement } from './types.ts';

const VOLATILE_DEFAULT = /\bdefault\b[^,)]*\b(now|gen_random_uuid|uuid_generate|random|clock_timestamp)\s*\(/i;

export function parse(sql: string): Statement[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(classify);
}

function classify(raw: string): Statement {
  const s = raw.replace(/\s+/g, ' ').trim();
  const lower = s.toLowerCase();
  const table = tableOf(lower);
  const concurrent = /\bconcurrently\b/i.test(s);

  let kind = 'UNKNOWN';
  if (/^create\s+(unique\s+)?index\b/i.test(s)) {
    kind = 'CREATE_INDEX';
  } else if (/\balter\s+column\b.*\bset\s+not\s+null\b/i.test(s) || /\balter\s+.*\bset\s+not\s+null\b/i.test(s)) {
    kind = 'SET_NOT_NULL';
  } else if (/\balter\s+column\b.*\b(type|set\s+data\s+type)\b/i.test(s)) {
    kind = 'ALTER_TYPE';
  } else if (/\badd\s+column\b/i.test(s) && /\bdefault\b/i.test(s)) {
    kind = VOLATILE_DEFAULT.test(s) ? 'ADD_COLUMN_DEFAULT_VOLATILE' : 'ADD_COLUMN_DEFAULT_CONST';
  } else if (/\bdrop\s+column\b/i.test(s)) {
    kind = 'DROP_COLUMN';
  }

  return { raw: s, kind, table, concurrent };
}

function tableOf(lower: string): string | null {
  const idx = lower.match(/\bon\s+([a-z_][\w.]*)/) // CREATE INDEX ... ON <t>
    || lower.match(/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([a-z_][\w.]*)/);
  return idx ? idx[1].replace(/"/g, '') : null;
}

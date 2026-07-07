// Bind a parsed statement to its canonical VERIFIED catalog entry, so lock facts,
// safe rewrites, and provenance come from the adversarially-checked catalog — not
// a hand-coded switch that could drift from it. Unmatched kinds fall back to the
// built-in lockModel (which supplies the dangerous default).

import type { LockFacts } from '../lockModel.ts';
import type { CostClass, Statement } from '../types.ts';
import { byId, type CatalogEntry } from './index.ts';

// parser kind → canonical catalog entry id (for kinds without flag-dependent variants)
const MAP: Record<string, string> = {
  SET_NOT_NULL: 'set-not-null-naive',
  ALTER_TYPE: 'alter-column-type',
  DROP_COLUMN: 'drop-column-basic',
  ADD_COLUMN: 'add-col-nullable-no-default',
  ADD_COLUMN_DEFAULT_VOLATILE: 'add-col-volatile-default',
  ADD_COLUMN_DEFAULT_CONST: 'add-col-nullable-no-default',
  ADD_PRIMARY_KEY: 'add-col-inline-primary-key',
  ADD_UNIQUE: 'add-col-inline-unique',
  RENAME_TABLE: 'rename-table',
  RENAME_COLUMN: 'rename-column',
  RENAME_CONSTRAINT: 'rename-constraint',
  RENAME_INDEX: 'rename-index',
  SET_DEFAULT: 'set-default',
  DROP_DEFAULT: 'drop-default',
  VALIDATE_CONSTRAINT: 'validate-check-constraint',
  VACUUM_FULL: 'vacuum-full',
  CLUSTER: 'cluster-table',
};

export function matchEntry(stmt: Statement): CatalogEntry | undefined {
  const notValid = /\bnot\s+valid\b/i.test(stmt.raw);
  switch (stmt.kind) {
    case 'CREATE_INDEX': return byId(stmt.concurrent ? 'create-index-concurrently' : 'create-index-nonconcurrent');
    case 'REINDEX': return byId(stmt.concurrent ? 'reindex-concurrently' : 'reindex-table-plain');
    case 'ADD_FOREIGN_KEY': return byId(notValid ? 'add-fk-not-valid' : 'add-fk-validated-single-step');
    case 'ADD_CHECK': return byId(notValid ? 'add-check-not-valid' : 'add-check-validated-single-step');
  }
  const id = MAP[stmt.kind];
  return id ? byId(id) : undefined;
}

/** LockFacts sourced from a verified catalog entry. */
export function factsFromEntry(e: CatalogEntry): LockFacts {
  return {
    lockMode: e.lockMode,
    costClass: e.costClass as CostClass,
    blocksReads: e.blocksReads,
    blocksWrites: e.blocksWrites,
    safeRewrite: cleanRewrite(e.safeRewrite),
    catalogId: e.id,
    sources: e.sources,
  };
}

/**
 * Null out rewrites for operations the catalog itself calls already-safe, so they
 * grade `safe` instead of `caution` (don't cry wolf on a plain ADD COLUMN). The
 * genuinely-hazardous entries lead with an actual multi-step fix. Operational
 * lock_timeout tips on safe ops aren't shown anyway (only danger/critical print a
 * rewrite), so this only affects severity.
 */
function cleanRewrite(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t || /^(n\/?a|none|no rewrite|already( the)? safe|this is (the |already )?(a )?safe|the (catalog )?change (itself )?is safe|safe as[- ]is)/i.test(t)) return null;
  return t;
}

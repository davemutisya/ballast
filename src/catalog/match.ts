// Bind a parsed statement to its canonical VERIFIED catalog entry, so lock facts,
// safe rewrites, and provenance come from the adversarially-checked catalog — not
// a hand-coded switch that could drift from it. Unmatched kinds fall back to the
// built-in lockModel (which supplies the dangerous default).

import type { LockFacts } from '../lockModel.ts';
import type { CostClass, Statement } from '../types.ts';
import { byId, type CatalogEntry } from './index.ts';

// parser kind (+ flags) → canonical catalog entry id
const MAP: Record<string, string> = {
  SET_NOT_NULL: 'set-not-null-naive',
  ALTER_TYPE: 'alter-column-type',
  DROP_COLUMN: 'drop-column-basic',
  ADD_COLUMN_DEFAULT_VOLATILE: 'add-col-volatile-default',
  ADD_COLUMN_DEFAULT_CONST: 'add-col-nullable-no-default',
};

export function matchEntry(stmt: Statement): CatalogEntry | undefined {
  if (stmt.kind === 'CREATE_INDEX')
    return byId(stmt.concurrent ? 'create-index-concurrently' : 'create-index-nonconcurrent');
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

/** Entries that are already safe carry rewrite text like "n/a" / "already safe". */
function cleanRewrite(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t || /^(n\/?a|none|already safe|no rewrite)/i.test(t)) return null;
  return t;
}

// The correctness catalog: 124 PostgreSQL entries, each authored from primary
// docs and adversarially verified (see docs/catalog/verification.json). This is
// the "DBA depth" asset — the safe/unsafe calls a generic LLM gets subtly wrong.
// It is versioned data, not code, so it grows without touching the engine.

import catalogData from './postgres.generated.json' with { type: 'json' };

import type { CostClass } from '../types.ts';

export interface CatalogEntry {
  id: string;
  title: string;
  sqlPattern?: string;
  lockMode: string;
  costClass: CostClass;
  blocksReads: boolean;
  blocksWrites: boolean;
  safeWhen?: string[];
  unsafeWhen?: string[];
  versionNotes?: string[];
  safeRewrite: string;
  edgeCases?: string[];
  sources?: string[];
  _verdict?: string;      // VERIFIED (authored + adversarially checked + corrections merged)
  _confidence?: string;   // high | medium | low
  _correction?: string;   // the verifier's fix, attached for auditability
}

export function catalog(): CatalogEntry[] {
  return catalogData as unknown as CatalogEntry[];
}

/** Fuzzy lookup by id/title keyword — the matcher that binds parsed statements to catalog entries grows here. */
export function find(query: string): CatalogEntry[] {
  const q = query.toLowerCase();
  return catalog().filter((e) => e.id.toLowerCase().includes(q) || e.title.toLowerCase().includes(q));
}

export function byId(id: string): CatalogEntry | undefined {
  return catalog().find((e) => e.id === id);
}

export function stats() {
  const all = catalog();
  return {
    total: all.length,
    verified: all.filter((e) => e._verdict === 'VERIFIED').length,
    corrected: all.filter((e) => e._correction).length, // entries the verifier fixed
    byCostClass: all.reduce<Record<string, number>>((m, e) => ((m[e.costClass] = (m[e.costClass] ?? 0) + 1), m), {}),
  };
}

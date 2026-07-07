// The correctness catalog: 124 PostgreSQL entries, each authored from primary
// docs and adversarially verified (see docs/catalog/verification.json). This is
// the "DBA depth" asset — the safe/unsafe calls a generic LLM gets subtly wrong.
// It is versioned data, not code, so it grows without touching the engine.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  _verdict?: string;      // CONFIRMED | CORRECTED | UNCERTAIN
  _confidence?: string;   // high | medium | low
}

let cache: CatalogEntry[] | null = null;

export function catalog(): CatalogEntry[] {
  if (!cache) {
    const p = fileURLToPath(new URL('./postgres.generated.json', import.meta.url));
    cache = JSON.parse(fs.readFileSync(p, 'utf8')) as CatalogEntry[];
  }
  return cache;
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
    confirmed: all.filter((e) => e._verdict === 'CONFIRMED').length,
    corrected: all.filter((e) => e._verdict === 'CORRECTED').length,
    byCostClass: all.reduce<Record<string, number>>((m, e) => ((m[e.costClass] = (m[e.costClass] ?? 0) + 1), m), {}),
  };
}

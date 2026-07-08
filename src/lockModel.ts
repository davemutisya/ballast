// Maps a recognised DDL statement to its Postgres lock mode + cost class + safe
// rewrite. Deterministic, grounded in the pg docs lock table (13.3) and the
// well-known unsafe-operations catalog (strong_migrations, GoCardless, Xata).
//
// These facts are the "unfakeable DBA depth" — getting them exactly right is the
// difference between us and a generic LLM guessing.

import type { CostClass, LockMode, Statement } from './types.ts';

export interface LockFacts {
  lockMode: string; // engine-native label (verbose in the catalog); load model uses the booleans
  costClass: CostClass;
  blocksReads: boolean;
  blocksWrites: boolean;
  safeRewrite: string | null;
  /** Irreversible data/schema loss (DROP TABLE, TRUNCATE) — dangerous regardless of lock duration. */
  destructive?: boolean;
  catalogId?: string;
  sources?: string[];
}

/** Only ACCESS EXCLUSIVE blocks a plain SELECT (pg docs 13.3). */
function blocksReads(mode: LockMode): boolean {
  return mode === 'ACCESS EXCLUSIVE';
}

/** SHARE and stronger block writes (ROW EXCLUSIVE, taken by INSERT/UPDATE/DELETE). */
function blocksWrites(mode: LockMode): boolean {
  const writeBlocking: LockMode[] = [
    'SHARE',
    'SHARE ROW EXCLUSIVE',
    'EXCLUSIVE',
    'ACCESS EXCLUSIVE',
  ];
  return writeBlocking.includes(mode);
}

export function lockFactsFor(stmt: Statement): LockFacts {
  switch (stmt.kind) {
    // ── CREATE INDEX ────────────────────────────────────────────────────────
    // Non-concurrent: SHARE (blocks writes, allows reads) held for the full
    // index build → dwell scales with row count.
    case 'CREATE_INDEX':
      if (stmt.concurrent) {
        return mk('SHARE UPDATE EXCLUSIVE', 'SCAN', null); // safe already
      }
      return mk('SHARE', 'SCAN',
        `CREATE INDEX CONCURRENTLY ... (outside a transaction; retry on failure)`);

    // ── SET NOT NULL ────────────────────────────────────────────────────────
    // ACCESS EXCLUSIVE held while every row is scanned to validate → dwell
    // scales with row count, and it blocks reads AND writes.
    case 'SET_NOT_NULL':
      return mk('ACCESS EXCLUSIVE', 'SCAN',
        `ADD CONSTRAINT <c> CHECK (<col> IS NOT NULL) NOT VALID;  ` +
        `VALIDATE CONSTRAINT <c>;  ALTER COLUMN <col> SET NOT NULL;  (PG 12+ skips the re-scan)`);

    // ── ALTER COLUMN TYPE ───────────────────────────────────────────────────
    // Most type changes rewrite the whole heap under ACCESS EXCLUSIVE → dwell
    // scales with table BYTES; blocks everything.
    case 'ALTER_TYPE':
      return mk('ACCESS EXCLUSIVE', 'REWRITE',
        `Add a new column of the target type; backfill in batches; swap reads; drop the old column.`);

    // ── ADD COLUMN ... NOT NULL DEFAULT ─────────────────────────────────────
    // A *constant* default is metadata-only on PG 11+. A *volatile* default
    // (function call) rewrites the whole table under ACCESS EXCLUSIVE.
    case 'ADD_COLUMN_DEFAULT_VOLATILE':
      return mk('ACCESS EXCLUSIVE', 'REWRITE',
        `Add the column with no default; set the default separately; backfill in batches; then SET NOT NULL via a validated CHECK.`);
    case 'ADD_COLUMN_DEFAULT_CONST':
      return mk('ACCESS EXCLUSIVE', 'METADATA_ONLY', null); // safe on PG 11+, but still queues (see load model)

    // ── DROP COLUMN ─────────────────────────────────────────────────────────
    // Metadata-only + fast, but ACCESS EXCLUSIVE (so it queues), and it is
    // destructive + breaks cached app schemas until redeploy.
    case 'DROP_COLUMN':
      return mk('ACCESS EXCLUSIVE', 'METADATA_ONLY',
        `Stop referencing the column in app code and deploy first; then drop in a low-lock_timeout migration.`);

    // ── New-coverage ops (real-parser era) ──────────────────────────────────
    case 'DROP_INDEX':
      if (stmt.concurrent) return mk('SHARE UPDATE EXCLUSIVE', 'METADATA_ONLY', null);
      return mk('ACCESS EXCLUSIVE', 'METADATA_ONLY',
        `DROP INDEX CONCURRENTLY <idx>;  — takes SHARE UPDATE EXCLUSIVE instead of ACCESS EXCLUSIVE (cannot run in a transaction).`);
    case 'SET_LOGGED':
    case 'SET_UNLOGGED':
      // The whole table is rewritten into (or out of) the WAL-logged state.
      return mk('ACCESS EXCLUSIVE', 'REWRITE',
        `This rewrites the entire table under ACCESS EXCLUSIVE. Schedule it in a maintenance window, or create a new table with the target persistence, backfill in batches, and swap.`);
    case 'REFRESH_MATVIEW':
      if (stmt.concurrent) return mk('SHARE UPDATE EXCLUSIVE', 'SCAN', null);
      return mk('ACCESS EXCLUSIVE', 'SCAN',
        `REFRESH MATERIALIZED VIEW CONCURRENTLY <mv>;  — requires a UNIQUE index on the matview, but readers are not blocked during the refresh.`);
    case 'ATTACH_PARTITION':
      return mk('SHARE UPDATE EXCLUSIVE', 'SCAN',
        `Before ATTACH, add a CHECK constraint on the child matching the partition bounds (ADD ... NOT VALID, then VALIDATE) so Postgres skips the verification scan; drop the CHECK after.`);
    case 'DETACH_PARTITION':
      return mk('ACCESS EXCLUSIVE', 'METADATA_ONLY',
        `ALTER TABLE <parent> DETACH PARTITION <part> CONCURRENTLY;  (PG 14+; cannot run in a transaction) — avoids the ACCESS EXCLUSIVE parent lock.`);

    // ── Destructive: fast locks, but irreversible data/schema loss ──────────
    case 'DROP_TABLE':
      return mk('ACCESS EXCLUSIVE', 'METADATA_ONLY',
        `Irreversible. Confirm no views/FKs/app code depend on it; take a backup; consider ` +
        `renaming it out of the way first and dropping later once nothing breaks.`, true);
    case 'TRUNCATE':
      return mk('ACCESS EXCLUSIVE', 'METADATA_ONLY',
        `Irreversible bulk delete under ACCESS EXCLUSIVE. Take a backup first; run under a short ` +
        `lock_timeout; TRUNCATE also resets nothing you may rely on (sequences unless RESTART IDENTITY).`, true);

    default:
      // Unknown ALTER: assume the dangerous default (most ALTER TABLE = ACCESS EXCLUSIVE).
      return mk('ACCESS EXCLUSIVE', 'METADATA_ONLY', null);
  }

  function mk(lockMode: LockMode, costClass: CostClass, safeRewrite: string | null, destructive = false): LockFacts {
    return {
      lockMode,
      costClass,
      blocksReads: blocksReads(lockMode),
      blocksWrites: blocksWrites(lockMode),
      safeRewrite,
      destructive,
    };
  }
}

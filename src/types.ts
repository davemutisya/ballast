// Core domain types for Ballast's load-aware migration analysis.

/** Postgres table-level lock modes, weakest → strongest (pg docs 13.3). */
export type LockMode =
  | 'ACCESS SHARE'
  | 'ROW SHARE'
  | 'ROW EXCLUSIVE'
  | 'SHARE UPDATE EXCLUSIVE'
  | 'SHARE'
  | 'SHARE ROW EXCLUSIVE'
  | 'EXCLUSIVE'
  | 'ACCESS EXCLUSIVE';

/**
 * How long the lock is held is dominated by one of three cost classes:
 *  - METADATA_ONLY: catalog-only change, ~constant few ms regardless of size.
 *  - SCAN: a full table (or index-build) scan; dwell scales with ROW COUNT.
 *  - REWRITE: the whole heap is rewritten; dwell scales with TABLE BYTES.
 */
export type CostClass = 'METADATA_ONLY' | 'SCAN' | 'REWRITE';

/** A single DDL statement recognised by the analyzer. */
export interface Statement {
  raw: string;
  kind: string;          // e.g. 'CREATE_INDEX', 'SET_NOT_NULL'
  table: string | null;
  concurrent: boolean;   // CREATE INDEX CONCURRENTLY etc.
}

/**
 * The lightweight, read-only production context Ballast needs. Everything here
 * is obtainable from a read-only connection or an exported snapshot — no write
 * or DDL privileges, and no clone of production data.
 */
export interface StatsSnapshot {
  table: string;
  rows: number;               // pg_class.reltuples / pg_stat_user_tables.n_live_tup
  bytes: number;              // pg_total_relation_size / pg_table_size
  writeTps: number;           // observed writes/sec against this table
  readTps: number;            // observed reads/sec against this table
  /** Longest currently-running txn (sec) holding/queuing on this table. Drives queue risk. */
  longestRunningTxnSec: number;
  /** Whether the migration session sets a low lock_timeout (the queue-pileup guard). */
  lockTimeoutMs: number | null;
}

export interface DwellPrediction {
  costClass: CostClass;
  seconds: number;            // point estimate
  low: number;                // plausible range
  high: number;
  basis: string;              // human explanation of how we got here
}

export interface BlastRadius {
  blocksReads: boolean;
  blocksWrites: boolean;
  blockedQueries: number;     // queries blocked during the dwell at current load
  /** The lock-queue amplifier: a conflicting long-running txn turns even a fast op catastrophic. */
  queuePileupRisk: 'none' | 'low' | 'high';
  queueNote: string | null;
}

export type Severity = 'safe' | 'caution' | 'danger' | 'critical';

export interface Finding {
  statement: Statement;
  lockMode: LockMode;
  dwell: DwellPrediction;
  blast: BlastRadius;
  severity: Severity;
  safeRewrite: string | null;
  /** The one-line, load-aware verdict — the thing static linters can't say. */
  verdict: string;
}

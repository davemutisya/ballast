// The load model — Ballast's actual differentiation.
//
// A static linter says "this takes a lock." The load model answers the question
// that decides whether that lock is a non-event or an outage:
//   "given THIS table's size and THIS write load, how long is the lock held,
//    how many queries does it block, and will it pile up the lock queue?"
//
// Dwell is modelled as a function of table stats with a small number of
// calibratable throughput constants. Spike 1 exists to test the core claim that
// these are *predictable* (roughly linear in rows/bytes) — because if they are,
// the constants can be auto-calibrated per-environment and refined by the
// telemetry corpus. The constants below are seed defaults; Spike 1 measures the
// real ones and reports the fit.

import type {
  BlastRadius, CostClass, DwellPrediction, LockMode, StatsSnapshot,
} from './types.ts';

/** Seed throughput constants (refined by measurement + telemetry). */
export interface Calibration {
  scanRowsPerSec: number;     // pure sequential validation scan (SET NOT NULL)
  indexRowsPerSec: number;    // index build (scan + write the index) — slower
  rewriteBytesPerSec: number; // full heap rewrite (ALTER TYPE, volatile default)
  metadataSeconds: number;    // catalog-only change
}

// Seed defaults. Spike 1 measured (on cached/tmpfs storage) scan ≈ 38M rows/s
// and index-build ≈ 1.8M rows/s with CV 5–7% — i.e. dwell is a predictable
// linear function of size, but the constant is storage-dependent and MUST be
// auto-calibrated per environment (that calibration is the moat, not a guess).
export const DEFAULT_CALIBRATION: Calibration = {
  scanRowsPerSec: 35_000_000,
  indexRowsPerSec: 1_800_000,
  rewriteBytesPerSec: 200 * 1024 * 1024, // 200 MB/s
  metadataSeconds: 0.01,
};

export function predictDwell(
  costClass: CostClass,
  kind: string,
  stats: StatsSnapshot,
  cal: Calibration = DEFAULT_CALIBRATION,
): DwellPrediction {
  let seconds: number;
  let basis: string;

  switch (costClass) {
    case 'METADATA_ONLY':
      seconds = cal.metadataSeconds;
      basis = `catalog-only change (~constant, independent of ${fmt(stats.rows)} rows)`;
      break;
    case 'SCAN': {
      const rate = kind === 'CREATE_INDEX' ? cal.indexRowsPerSec : cal.scanRowsPerSec;
      seconds = stats.rows / rate;
      basis = `full scan of ${fmt(stats.rows)} rows at ~${fmt(rate)} rows/s`;
      break;
    }
    case 'REWRITE':
      seconds = stats.bytes / cal.rewriteBytesPerSec;
      basis = `heap rewrite of ${fmtBytes(stats.bytes)} at ~${fmtBytes(cal.rewriteBytesPerSec)}/s`;
      break;
  }

  // Honest uncertainty band: throughput varies with cache state, bloat, IO.
  return { costClass, seconds, low: seconds * 0.5, high: seconds * 2.5, basis };
}

export function predictBlast(
  lockMode: LockMode,
  blocksReads: boolean,
  blocksWrites: boolean,
  dwell: DwellPrediction,
  stats: StatsSnapshot,
): BlastRadius {
  const affectedTps =
    (blocksReads ? stats.readTps : 0) + (blocksWrites ? stats.writeTps : 0);
  const blockedQueries = Math.round(affectedTps * dwell.seconds);

  // The lock-queue amplifier. If a conflicting txn is already running long, the
  // migration can't get its lock immediately, and EVERYTHING queues behind it —
  // even a "fast" metadata-only op becomes an outage. lock_timeout is the guard.
  let queuePileupRisk: BlastRadius['queuePileupRisk'] = 'none';
  let queueNote: string | null = null;
  const guarded = stats.lockTimeoutMs !== null && stats.lockTimeoutMs <= 2000;

  if (stats.longestRunningTxnSec >= 1 && !guarded) {
    queuePileupRisk = 'high';
    const pileup = Math.round(
      (stats.readTps + stats.writeTps) * stats.longestRunningTxnSec,
    );
    queueNote =
      `a txn has run ${stats.longestRunningTxnSec.toFixed(1)}s on ${stats.table}; ` +
      `this ${lockMode} will queue behind it and pile up ~${fmt(pileup)} queries ` +
      `(set lock_timeout <= 2s + retry to avoid).`;
  } else if (stats.longestRunningTxnSec >= 1 && guarded) {
    queuePileupRisk = 'low';
    queueNote = `long-running txn present, but lock_timeout guards against pileup.`;
  }

  return { blocksReads, blocksWrites, blockedQueries, queuePileupRisk, queueNote };
}

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(Math.round(n));
}
function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + 'GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + 'MB';
  return (b / 1024).toFixed(0) + 'KB';
}

// Local, per-environment calibration store (~/.ballast/calibration.json). Works
// with telemetry OFF — you get auto-calibration on your own DB without ever
// sharing. Sharing (opt-in) only buys the global prior for cold starts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CALIBRATION, type Calibration } from '../loadModel.ts';
import type { TableFingerprint } from './contract.ts';
import type { CostClass } from '../types.ts';
import { bucketKey } from './fingerprint.ts';
import { combine, EMPTY, type Gaussian, type LocalStats, record } from './model.ts';

const DIR = path.join(os.homedir(), '.ballast');
const FILE = path.join(DIR, 'calibration.json');

export class CalibrationStore {
  private data: Record<string, LocalStats>;
  private priors: Record<string, Gaussian>;
  private persist: boolean;

  constructor(seedData?: Record<string, LocalStats>, priors?: Record<string, Gaussian>, opts?: { persist?: boolean }) {
    this.data = seedData ?? load();
    this.priors = priors ?? {};
    this.persist = opts?.persist ?? true;
  }

  get(key: string): LocalStats { return this.data[key] ?? EMPTY; }

  /**
   * Progressively coarser keys, most-specific first. A single measurement is
   * folded into all of them so that a table with a *different* fingerprint can
   * still find the environment's rate at the coarsest matching level before
   * falling back to the seed. Drop order = weakest rate-determinant first:
   * index-count → rows → bytes → storage. (engine|cost|kind|version always kept.)
   */
  private coarser(fullKey: string): string[] {
    const p = fullKey.split('|'); // engine|cc|kind|row|byte|index|storage|version  (idx 3,4,5,6)
    const w = (drop: number[]) => p.map((v, i) => (drop.includes(i) ? '*' : v)).join('|');
    return [fullKey, w([5]), w([5, 3]), w([5, 3, 4]), w([5, 3, 4, 6])];
  }

  /** Fold in a measured throughput for a bucket (from calibrate or a real migration). */
  observe(key: string, measuredRate: number): void {
    for (const k of this.coarser(key)) this.data[k] = record(this.get(k), measuredRate);
    if (this.persist) save(this.data);
  }

  setPrior(key: string, prior: Gaussian): void { this.priors[key] = prior; }

  private rate(engine: string, cc: CostClass, kind: string, fp: TableFingerprint, seed: number) {
    const full = bucketKey(engine, cc, kind, fp);
    for (const k of this.coarser(full)) {
      const local = this.get(k);
      if (local.n > 0) return combine(this.priors[k] ?? null, seed, local); // most-specific env data wins
    }
    return combine(this.priors[full] ?? null, seed, EMPTY); // cold: prior or seed
  }

  /**
   * Produce loadModel's Calibration for THIS table fingerprint — the only wiring
   * point. loadModel.predictDwell never learns calibration exists; we just hand
   * it environment-aware constants instead of DEFAULT_CALIBRATION.
   */
  toCalibration(engine: string, fp: TableFingerprint, seed: Calibration = DEFAULT_CALIBRATION): Calibration {
    return {
      scanRowsPerSec: this.rate(engine, 'SCAN', 'SET_NOT_NULL', fp, seed.scanRowsPerSec).rate,
      indexRowsPerSec: this.rate(engine, 'SCAN', 'CREATE_INDEX', fp, seed.indexRowsPerSec).rate,
      rewriteBytesPerSec: this.rate(engine, 'REWRITE', 'ALTER_TYPE', fp, seed.rewriteBytesPerSec).rate,
      metadataSeconds: seed.metadataSeconds,
    };
  }
}

function load(): Record<string, LocalStats> {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function save(data: Record<string, LocalStats>): void {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data)); } catch { /* best-effort */ }
}

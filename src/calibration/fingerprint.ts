// Bucketing: turn exact, potentially-identifying stats into a coarse, k-anonymous
// fingerprint, and derive the stable bucketKey used to index the corpus + priors.

import type { TableFingerprint } from './contract.ts';
import type { CostClass } from '../types.ts';

export function bucketRows(n: number): TableFingerprint['rowBucket'] {
  if (n <= 0) return '0';
  if (n < 1e3) return '<1e3';
  if (n < 1e4) return '1e3-1e4';
  if (n < 1e5) return '1e4-1e5';
  if (n < 1e6) return '1e5-1e6';
  if (n < 1e7) return '1e6-1e7';
  if (n < 1e8) return '1e7-1e8';
  if (n < 1e9) return '1e8-1e9';
  return '>=1e9';
}

export function bucketBytes(b: number): TableFingerprint['byteBucket'] {
  const MB = 1024 ** 2, GB = 1024 ** 3, TB = 1024 ** 4;
  if (b < MB) return '<1MB';
  if (b < 10 * MB) return '1-10MB';
  if (b < 100 * MB) return '10-100MB';
  if (b < GB) return '100MB-1GB';
  if (b < 10 * GB) return '1-10GB';
  if (b < 100 * GB) return '10-100GB';
  if (b < TB) return '100GB-1TB';
  return '>=1TB';
}

export function bucketIndex(k: number): TableFingerprint['indexBucket'] {
  if (k <= 0) return '0';
  if (k === 1) return '1';
  if (k === 2) return '2';
  if (k <= 5) return '3-5';
  if (k <= 10) return '6-10';
  return '>10';
}

export function fingerprint(
  s: { rows: number; bytes: number; indexCount: number; storageClass?: string; engineVersionMajor: string },
): TableFingerprint {
  const storage = (s.storageClass ?? 'unknown') as TableFingerprint['storageClass'];
  return {
    rowBucket: bucketRows(s.rows),
    byteBucket: bucketBytes(s.bytes),
    indexBucket: bucketIndex(s.indexCount),
    storageClass: storage,
    engineVersionMajor: s.engineVersionMajor,
  };
}

/** Order-stable, hashable key. e.g. "postgres|SCAN|CREATE_INDEX|1e7-1e8|1-10GB|3-5|ebs-gp3|16" */
export function bucketKey(engine: string, costClass: CostClass, statementKind: string, fp: TableFingerprint): string {
  return [engine, costClass, statementKind, fp.rowBucket, fp.byteBucket, fp.indexBucket, fp.storageClass, fp.engineVersionMajor].join('|');
}

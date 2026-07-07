// The redaction boundary. These zod types are the ONLY thing that may cross the
// network. There is no code path that serializes SQL, schema/table/column names,
// DSNs, hostnames, or row data — anything not in this schema physically cannot
// leave the machine. (Telemetry is off by default; this is the strict-opt-in,
// anonymized contract the user chose.)

import { z } from 'zod';

export const CostClass = z.enum(['METADATA_ONLY', 'SCAN', 'REWRITE']);
export const Engine = z.enum(['postgres', 'mysql', 'sqlserver']);

// Bucketed + non-reversible → k-anonymity. "1e8-1e9 rows / 10-100GB / ebs-gp3 /
// pg16" describes thousands of real tables, not one.
export const TableFingerprint = z.object({
  rowBucket: z.enum(['0', '<1e3', '1e3-1e4', '1e4-1e5', '1e5-1e6', '1e6-1e7', '1e7-1e8', '1e8-1e9', '>=1e9']),
  byteBucket: z.enum(['<1MB', '1-10MB', '10-100MB', '100MB-1GB', '1-10GB', '10-100GB', '100GB-1TB', '>=1TB']),
  indexBucket: z.enum(['0', '1', '2', '3-5', '6-10', '>10']),
  storageClass: z.enum(['local-nvme', 'local-ssd', 'ebs-gp3', 'ebs-io2', 'network-ssd', 'managed-cloud', 'unknown']),
  engineVersionMajor: z.string().regex(/^\d{1,2}$/),
});
export type TableFingerprint = z.infer<typeof TableFingerprint>;

export const DwellObservation = z.object({
  schemaVersion: z.literal(1),
  engine: Engine,
  costClass: CostClass,
  statementKind: z.string(), // bounded enum from OUR classifier — never user text
  lockLabel: z.string(),     // bounded, e.g. 'ACCESS EXCLUSIVE'
  concurrent: z.boolean(),
  fingerprint: TableFingerprint,
  // training signal:
  measuredRate: z.number(),  // size / actualSeconds (rows/s or bytes/s per costClass)
  predictedSeconds: z.number(),
  actualSeconds: z.number(),
  rateSourceAtPredict: z.enum(['seed', 'global-prior', 'env-posterior']),
  observationSource: z.enum(['calibration', 'real-migration']),
  installId: z.string().uuid(), // salted/rotating; a de-dup key, NOT identity
  ts: z.number(),               // epoch ms, coarsened to the hour
});
export type DwellObservation = z.infer<typeof DwellObservation>;

export const Prior = z.object({
  bucketKey: z.string(),
  logMean: z.number(),
  logVar: z.number(),
  n: z.number(),
  contributors: z.number(),
});
export const PriorBundle = z.object({
  updatedAt: z.number(),
  engine: Engine,
  priors: z.array(Prior),
});
export type PriorBundle = z.infer<typeof PriorBundle>;

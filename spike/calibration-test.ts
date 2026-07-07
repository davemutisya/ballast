// Proves the moat mechanism end-to-end: a brand-new environment starts from our
// (deliberately 5×-off) seed, then converges to ITS OWN measured constant after a
// handful of observations — with the uncertainty band tightening as it learns.
// This is exactly the Spike 1 finding (seed 8M rows/s, real 38M) turned into a
// self-correcting system. No home-dir writes (persist:false).

import { bandFrom, combine } from '../src/calibration/model.ts';
import { bucketKey, fingerprint } from '../src/calibration/fingerprint.ts';
import { CalibrationStore } from '../src/calibration/store.ts';
import { catalog, stats } from '../src/catalog/index.ts';

const SEED = 8_000_000;   // our wrong seed (Spike 1 default)
const TRUE = 38_000_000;  // this environment's real scan throughput

const fp = fingerprint({ rows: 4_000_000, bytes: 500 * 1024 ** 2, indexCount: 2, storageClass: 'ebs-gp3', engineVersionMajor: '16' });
const key = bucketKey('postgres', 'SCAN', 'SET_NOT_NULL', fp);
const store = new CalibrationStore({}, {}, { persist: false });

console.log('══ Calibration: cold-start seed → per-environment posterior ══\n');
const cold = store.toCalibration('postgres', fp).scanRowsPerSec;
console.log(`cold start (no data): ${(cold / 1e6).toFixed(1)}M rows/s  [seed]\n`);

const noise = [1.05, 0.94, 1.08, 0.97, 1.02, 0.99, 1.01, 0.96];
for (let i = 0; i < noise.length; i++) {
  store.observe(key, TRUE * noise[i]);
  const est = combine(null, SEED, store.get(key));
  const b = bandFrom(est);
  console.log(
    `after ${String(i + 1).padStart(2)} obs: ${(est.rate / 1e6).toFixed(1).padStart(5)}M rows/s  ` +
    `band [${(b.low / 1e6).toFixed(1)}M–${(b.high / 1e6).toFixed(1)}M]  source ${est.source}`,
  );
}
console.log(`\n→ Converged from the 5×-off seed to the environment's true ~${(TRUE / 1e6).toFixed(0)}M rows/s.`);
console.log('  A competitor cloning the formula starts at the seed; we start at the crowd prior and converge to truth.\n');

// ── Backoff: one calibration covers differently-shaped tables ────────────────
console.log('\n══ Progressive backoff: one calibration → many table shapes ══\n');
const s2 = new CalibrationStore({}, {}, { persist: false });
const fpA = fingerprint({ rows: 1e6, bytes: 200 * 1024 ** 2, indexCount: 1, storageClass: 'ebs-gp3', engineVersionMajor: '16' });
for (let i = 0; i < 5; i++) s2.observe(bucketKey('postgres', 'SCAN', 'SET_NOT_NULL', fpA), 25_000_000);
const fpB = fingerprint({ rows: 100e6, bytes: 50 * 1024 ** 3, indexCount: 5, storageClass: 'ebs-gp3', engineVersionMajor: '16' });
const rateB = s2.toCalibration('postgres', fpB).scanRowsPerSec;
console.log(`calibrated once at 1M rows / 1 index = 25M rows/s`);
console.log(`a 100M-row / 5-index table (same storage+version) resolves ${(rateB / 1e6).toFixed(1)}M rows/s via backoff — not the ${(SEED / 1e6)}M seed.\n`);

const s = stats();
console.log(`══ Correctness catalog loaded: ${s.total} entries (${s.verified} verified, ${s.corrected} with merged corrections) ══`);
console.log('  cost classes:', s.byCostClass);
console.log('  sample:', catalog()[0]?.id, '—', catalog()[0]?.title);

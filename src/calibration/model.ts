// Hierarchical calibration: a per-environment posterior over a global prior.
// Throughput is log-normal (Spike 1: CV ~10%, multiplicative noise), so we work
// in log space. This single combine() delivers both requirements: cold-start uses
// the crowd's prior (or seed), and after a handful of local runs the environment's
// own measured constant dominates. It replaces the hardcoded 0.5x/2.5x band.

export interface Gaussian { logMean: number; logVar: number } // global prior over ln(rate)
export interface LocalStats { n: number; sumLog: number; sumLog2: number }

export interface RateEstimate {
  rate: number;
  logMean: number;
  logVar: number; // predictive variance (includes measurement noise) → band
  n: number;
  source: 'seed' | 'global-prior' | 'env-posterior';
}

const TAU = 0.10; // measurement noise sd in log space (Spike 1 CV ~10%)

export function combine(prior: Gaussian | null, seedRate: number, local: LocalStats, tau = TAU): RateEstimate {
  // Prior: global crowd prior if past k-anonymity, else a weak prior centered on
  // our seed guess with wide variance so local data can move it fast.
  const priorMean = prior ? prior.logMean : Math.log(seedRate);
  const priorVar = prior ? prior.logVar : 1.0; // σ≈1 in log space = deliberately weak

  let precision = 1 / priorVar;
  let meanPrecision = priorMean / priorVar;

  if (local.n > 0) {
    precision += local.n / (tau * tau);
    meanPrecision += local.sumLog / (tau * tau); // = n * localMean / tau^2
  }

  const postMean = meanPrecision / precision;
  const predictiveVar = 1 / precision + tau * tau;

  return {
    rate: Math.exp(postMean),
    logMean: postMean,
    logVar: predictiveVar,
    n: local.n,
    source: local.n >= 3 ? 'env-posterior' : prior ? 'global-prior' : 'seed',
  };
}

/** Principled ±2σ band in rate space, replacing loadModel's fixed 0.5x/2.5x. */
export function bandFrom(est: RateEstimate): { low: number; high: number } {
  const sd = Math.sqrt(est.logVar);
  return { low: Math.exp(est.logMean - 2 * sd), high: Math.exp(est.logMean + 2 * sd) };
}

/** Online update of a bucket's sufficient statistics with one measured rate. */
export function record(local: LocalStats, measuredRate: number): LocalStats {
  const x = Math.log(measuredRate);
  return { n: local.n + 1, sumLog: local.sumLog + x, sumLog2: local.sumLog2 + x * x };
}

export const EMPTY: LocalStats = { n: 0, sumLog: 0, sumLog2: 0 };

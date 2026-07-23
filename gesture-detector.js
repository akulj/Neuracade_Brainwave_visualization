// ==================================================================
// gesture-detector.js
//
// Real-time detection of movement bursts (toe / ankle / leg wiggle)
// riding on top of a slowly wandering EEG/EMG baseline, WITHOUT using
// an absolute amplitude threshold.
//
// Why an absolute threshold doesn't work (per your plot): the
// baseline itself drifts by tens of thousands of µV over seconds.
// Any fixed number you pick will eventually sit either above the
// baseline (never fires) or below it (fires constantly).
//
// The fix, in three stages, all CAUSAL (usable sample-by-sample,
// no look-ahead, no filtfilt):
//
//   1. High-pass filter (1-pole, ~0.5 Hz default) — removes the slow
//      wander, keeps the faster (~1-10Hz) movement-artifact energy.
//   2. Rectify + smooth -> envelope — a fast (~150-250ms) running
//      estimate of local signal energy.
//   3. Adaptive noise floor — tracks the envelope's own recent
//      "quiet" level. It falls quickly when the signal is calm, and
//      rises slowly, so an active burst can't drag the floor up and
//      mask itself. Comparing envelope/floor (a RATIO, not a raw
//      value) is what makes this drift-invariant: if your electrode
//      impedance or baseline shifts, both the envelope and floor
//      shift together and the ratio stays put.
//
// Bursts are classified into tiers (toe/ankle/leg by default) using
// hysteresis (separate enter/exit ratios + a minimum hold time) so
// a single noisy sample can't flip the state back and forth.
//
// Because absolute thresholds are hardware/session dependent, this
// also ships a live calibration routine: record a few seconds of
// "quiet" and a few seconds of each gesture, and it sets sane
// enter/exit ratios for you from what it actually measured.
// ==================================================================

class GestureDetector {
  /**
   * @param {Object} opts
   * @param {number} opts.fs                 sample rate (Hz)
   * @param {number} [opts.hpCutoffHz=0.5]    high-pass cutoff, removes baseline wander
   * @param {number} [opts.envTauMs=200]      envelope smoothing time constant
   * @param {number} [opts.floorFastTauMs=800]   how fast the noise floor adapts while idle
   *   (it is frozen entirely while a gesture is active — see processSample)
   * @param {number} [opts.warmupMs=1500]     ignore state transitions until the filters settle
   * @param {Array}  [opts.tiers]  ordered smallest->largest, e.g.
   *   [{ key:'toe',   enterRatio:3,  exitRatio:2,  minHoldMs:150, command:'close_index_finger' },
   *    { key:'ankle', enterRatio:6,  exitRatio:4,  minHoldMs:150, command:'close_index_finger' },
   *    { key:'leg',   enterRatio:12, exitRatio:8,  minHoldMs:200, command:'close_fist' }]
   * @param {string} [opts.idleCommand='open_hand']
   */
  constructor(opts) {
    this.fs = opts.fs;
    this.dt = 1 / this.fs;

    const hpCutoffHz = opts.hpCutoffHz ?? 0.5;
    const tauHp = 1 / (2 * Math.PI * hpCutoffHz);
    this.hpAlpha = tauHp / (tauHp + this.dt);

    const envTau = (opts.envTauMs ?? 180) / 1000;
    this.envAlpha = this.dt / (envTau + this.dt);

    const floorFastTau = (opts.floorFastTauMs ?? 800) / 1000;
    this.floorFastAlpha = this.dt / (floorFastTau + this.dt);

    this.tiers = opts.tiers ?? [
      { key: 'toe',   enterRatio: 3,  exitRatio: 2, minHoldMs: 150, command: 'close_index_finger' },
      { key: 'ankle', enterRatio: 6,  exitRatio: 4, minHoldMs: 150, command: 'close_index_finger' },
      { key: 'leg',   enterRatio: 12, exitRatio: 8, minHoldMs: 200, command: 'close_fist' },
    ];
    this.idleCommand = opts.idleCommand ?? 'open_hand';
    this.warmupMs = opts.warmupMs ?? 1500;

    this.reset();
  }

  reset() {
    this.prevX1 = 0; this.hp1 = 0;
    this.prevX2 = 0; this.hp2 = 0;
    this.envStage1 = 0;
    this.env = 0;
    this.floor = 1e-6; // avoid divide-by-zero; re-seeded from the first real sample below
    this.ratio = 0;
    this._seeded = false;
    this._prevXSeeded = false;
    this._floorLockedAtWarmup = false;

    this.state = 'idle';      // 'idle' | tier.key
    this.candidateState = 'idle';
    this.candidateSinceMs = 0;
    this.sampleCount = 0;

    this._calib = null; // active calibration session, if any
  }

  /** Feed one raw sample (µV or counts, doesn't matter — it's all ratio-based). Returns {env, floor, ratio, state, event} */
  processSample(x, nowMs) {
    nowMs = nowMs ?? this.sampleCount * this.dt * 1000;
    this.sampleCount++;

    // 1) causal high-pass — CASCADED two 1-pole stages. A single 1-pole
    // section only rolls off at 6dB/octave, so a slow (~0.03Hz) baseline
    // wander still leaks several percent of its amplitude through even
    // with a 0.5Hz cutoff — enough to be mistaken for a burst before the
    // floor tracker catches up. Two stages (12dB/octave) suppress that
    // slow wander far more while barely touching real ~1-10Hz burst
    // content (which sits well above the cutoff either way).
    if (!this._prevXSeeded) { this.prevX1 = x; this._prevXSeeded = true; }
    this.hp1 = this.hpAlpha * (this.hp1 + x - this.prevX1);
    this.prevX1 = x;

    this.hp2 = this.hpAlpha * (this.hp2 + this.hp1 - this.prevX2);
    this.prevX2 = this.hp1;

    // 2) rectify + smooth -> envelope (two cascaded smoothing stages, same
    // reasoning as the high-pass cascade above: a single stage doesn't
    // suppress ripple at the burst's own oscillation frequency enough,
    // which let the ratio flicker in and out of a tier's threshold
    // instead of holding steady for the hysteresis hold time).
    const rect = Math.abs(this.hp2);
    this.envStage1 += this.envAlpha * (rect - this.envStage1);
    this.env += this.envAlpha * (this.envStage1 - this.env);

    if (!this._seeded) { this.floor = Math.max(this.env, 1e-6); this._seeded = true; }

    // 3) adaptive noise floor — tracked ONLY while idle, and frozen the
    // moment a gesture is active. Earlier versions let the floor keep
    // creeping toward env even during a held burst (via a "slow" alpha),
    // but for a big, sustained burst even a slow per-sample rate adds up
    // to a large absolute move within well under a second — enough to
    // pull a huge burst's ratio down to look like a small one (self-
    // masking). Freezing the floor during any active tier means every
    // gesture's peak ratio is judged against the SAME reference (the
    // last confirmed idle level), so burst size stays discriminable.
    if (this.state === 'idle') {
      this.floor += this.floorFastAlpha * (this.env - this.floor);
    }
    if (this.floor < 1e-6) this.floor = 1e-6;

    this.ratio = this.env / this.floor;

    // calibration capture, if a session is running
    if (this._calib && nowMs <= this._calib.endMs) {
      if (this.ratio > this._calib.peakRatio) this._calib.peakRatio = this.ratio;
    } else if (this._calib && nowMs > this._calib.endMs) {
      this._finishCalibration();
    }

    // ---- tiered hysteresis state machine ----
    // Determine which tier the CURRENT ratio would enter/stay in.
    let desired = 'idle';
    for (let i = this.tiers.length - 1; i >= 0; i--) {
      const t = this.tiers[i];
      if (this.state === t.key) {
        // already in this tier: use the (lower) exit threshold to leave it
        if (this.ratio >= t.exitRatio) { desired = t.key; break; }
      } else {
        if (this.ratio >= t.enterRatio) { desired = t.key; break; }
      }
    }

    let event = null;
    if (nowMs < this.warmupMs) {
      // still settling — keep tracking floor/env but don't classify yet
      this.candidateState = 'idle';
      this.state = 'idle';
      return { env: this.env, floor: this.floor, ratio: this.ratio, state: this.state, event: null };
    }
    if (desired !== this.candidateState) {
      this.candidateState = desired;
      this.candidateSinceMs = nowMs;
    }
    if (this.candidateState !== this.state) {
      const holdReq = this.candidateState === 'idle'
        ? 100
        : (this.tiers.find(t => t.key === this.candidateState)?.minHoldMs ?? 150);
      if (nowMs - this.candidateSinceMs >= holdReq) {
        this.state = this.candidateState;
        const tierDef = this.tiers.find(t => t.key === this.state);
        event = {
          state: this.state,
          command: tierDef ? tierDef.command : this.idleCommand,
          ratio: this.ratio,
          atMs: nowMs,
        };
      }
    }

    return { env: this.env, floor: this.floor, ratio: this.ratio, state: this.state, event };
  }

  // ---------------- calibration ----------------

  /**
   * Run a calibration window: for `durationMs`, track the peak env/floor
   * ratio actually observed. Call this while at rest ("quiet") or while
   * performing one gesture ("toe"/"ankle"/"leg"). Returns a Promise that
   * resolves with { tierKey, peakRatio, appliedEnter, appliedExit } once
   * the window elapses (driven by your own sample clock via processSample,
   * not a wall-clock timer — call tickCalibrationClock if you're not
   * feeding samples during the window, e.g. to allow a UI countdown).
   *
   * @param {string|null} tierKey  one of this.tiers[].key, or null for a
   *   quiet/baseline-only calibration (just lets the floor settle).
   * @param {number} durationMs
   */
  startCalibration(tierKey, durationMs) {
    return new Promise((resolve) => {
      const startMs = this.sampleCount * this.dt * 1000;
      this._calib = {
        tierKey,
        peakRatio: 0,
        endMs: startMs + durationMs,
        resolve,
      };
    });
  }

  _finishCalibration() {
    const { tierKey, peakRatio, resolve } = this._calib;
    let applied = null;
    if (tierKey) {
      const tier = this.tiers.find(t => t.key === tierKey);
      if (tier) {
        // Enter at ~65% of the observed peak, exit at ~40% — leaves
        // headroom below the real gesture but well above resting ratio (~1).
        tier.enterRatio = Math.max(2, +(peakRatio * 0.65).toFixed(2));
        tier.exitRatio = Math.max(1.3, +(peakRatio * 0.40).toFixed(2));
        applied = { enterRatio: tier.enterRatio, exitRatio: tier.exitRatio };
      }
    }
    const result = { tierKey, peakRatio: +peakRatio.toFixed(2), applied };
    this._calib = null;
    resolve(result);
  }

  isCalibrating() { return !!this._calib; }
}

if (typeof module !== 'undefined') module.exports = { GestureDetector };

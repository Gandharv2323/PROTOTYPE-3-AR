/**
 * OneEuroFilter — removes jitter from pose keypoints without adding lag.
 * The key to premium AR feel. Applied per-coordinate per-landmark.
 *
 * Paper: Casiez et al., "1€ Filter: A Simple Speed-based Low-pass Filter
 * for Noisy Input in Interactive Systems", CHI 2012.
 *
 * Parameters (tuned for 30fps pose):
 *   minCutoff: lower = smoother but more lag. 0.8 is good for body tracking.
 *   beta: higher = faster response to fast movement. 0.05 works for cloth warp.
 *   dCutoff: derivative smoothing. 1.0 is standard.
 */
export class OneEuroFilter {
  constructor(freq = 30, minCutoff = 0.8, beta = 0.05, dCutoff = 1.0) {
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this._x = null;
    this._dx = 0;
    this._lastTime = null;
  }

  _alpha(cutoff) {
    const te = 1.0 / this.freq;
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }

  filter(x, timestamp = performance.now()) {
    if (this._x === null) {
      this._x = x;
      this._lastTime = timestamp;
      return x;
    }
    const dt = (timestamp - this._lastTime) / 1000;
    if (dt > 0) this.freq = 1.0 / dt;
    this._lastTime = timestamp;

    // Derivative estimate
    const dx = (x - this._x) * this.freq;
    // Smooth derivative
    this._dx = this._dx + this._alpha(this.dCutoff) * (dx - this._dx);
    // Adaptive cutoff based on speed
    const cutoff = this.minCutoff + this.beta * Math.abs(this._dx);
    // Smooth position
    this._x = this._x + this._alpha(cutoff) * (x - this._x);
    return this._x;
  }

  reset() {
    this._x = null;
    this._dx = 0;
    this._lastTime = null;
  }
}

/**
 * FilteredPoint2D — wraps two OneEuroFilters for an (x, y) landmark.
 * Usage: const fp = new FilteredPoint2D(); const {x,y} = fp.filter(rawX, rawY);
 */
export class FilteredPoint2D {
  constructor(freq = 30, minCutoff = 0.8, beta = 0.05) {
    this.fx = new OneEuroFilter(freq, minCutoff, beta);
    this.fy = new OneEuroFilter(freq, minCutoff, beta);
  }
  filter(x, y, t = performance.now()) {
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) };
  }
  reset() { this.fx.reset(); this.fy.reset(); }
}

/**
 * LandmarkSmoother — smooths all relevant pose landmarks at once.
 * Pass in a MediaPipe poseLandmarks array, get back smoothed version.
 */
export class LandmarkSmoother {
  constructor(landmarkCount = 33, minCutoff = 0.8, beta = 0.05) {
    this.filters = Array.from({ length: landmarkCount }, () =>
      new FilteredPoint2D(30, minCutoff, beta)
    );
  }
  smooth(landmarks) {
    if (!landmarks) return null;
    const t = performance.now();
    return landmarks.map((lm, i) => {
      const { x, y } = this.filters[i].filter(lm.x, lm.y, t);
      return { x, y, z: lm.z, visibility: lm.visibility };
    });
  }
  reset() { this.filters.forEach(f => f.reset()); }
}

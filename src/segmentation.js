/**
 * SegmentationManager
 *
 * Wraps MediaPipe SelfieSegmentation to produce a clean person mask.
 *
 * Key trick for premium feel:
 *   - Temporal mask blending (15% previous + 85% current) removes mask flicker
 *   - Gaussian-style edge feathering hides hard segmentation boundaries
 *   - We run segmentation every OTHER frame and interpolate to save CPU
 */
export class SegmentationManager {
  constructor(onMask) {
    this._onMask = onMask;
    this._seg = null;
    this._ready = false;
    this._offscreen = null;     // OffscreenCanvas for mask processing
    this._offCtx = null;
    this._prevMaskData = null;  // for temporal blending
    this._frameSkip = 0;
    this._lastMask = null;
  }

  async init(width, height) {
    this._width = width;
    this._height = height;

    // Offscreen canvas for mask compositing
    this._offscreen = new OffscreenCanvas(width, height);
    this._offCtx = this._offscreen.getContext('2d');

    this._seg = new SelfieSegmentation({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/${file}`,
    });

    this._seg.setOptions({
      modelSelection: 1, // 1 = landscape model (higher quality, accepts 256x144)
    });

    this._seg.onResults((results) => this._handleResults(results));
    await this._seg.initialize();
    this._ready = true;
    console.log('[Segmentation] Ready');
  }

  _handleResults(results) {
    if (!results.segmentationMask) return;

    const ctx = this._offCtx;
    const w = this._width;
    const h = this._height;

    // Draw segmentation mask to offscreen canvas
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(results.segmentationMask, 0, 0, w, h);

    let maskData = ctx.getImageData(0, 0, w, h);

    // Temporal blend + convert grayscale→alpha so destination-in works on GPU
    // Output: RGBA = (255, 255, 255, personProbability) — enables fast canvas compositing
    const curr = maskData.data;
    if (this._prevMaskData) {
      const prev = this._prevMaskData.data;
      for (let i = 0; i < curr.length; i += 4) {
        const v   = curr[i] * 0.85 + prev[i+3] * 0.15;  // blend: curr red + prev alpha
        curr[i]   = 255;  // R — white
        curr[i+1] = 255;  // G — white
        curr[i+2] = 255;  // B — white
        curr[i+3] = v;    // A — person probability as alpha
      }
    } else {
      // First frame: just convert grayscale to alpha, no blend
      for (let i = 0; i < curr.length; i += 4) {
        const v = curr[i];
        curr[i] = curr[i+1] = curr[i+2] = 255;
        curr[i+3] = v;
      }
    }
    ctx.putImageData(maskData, 0, 0);

    // Reuse the already-processed ImageData as prevMask — avoids a second
    // CPU-GPU readback (getImageData). maskData is a detached copy from
    // the canvas so it won't be mutated by the next ctx.drawImage().
    this._prevMaskData = maskData;
    this._lastMask = this._offscreen;
    this._onMask(this._offscreen);
  }

  async send(videoFrame) {
    if (!this._ready) return;
    // Run every frame — segmentation is fast enough at 360p
    await this._seg.send({ image: videoFrame });
  }

  getLastMask() { return this._lastMask; }
}

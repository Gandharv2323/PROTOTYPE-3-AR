/**
 * App — main orchestrator.
 *
 * Owns the render loop and coordinates:
 *   Camera → PoseTracker + SegmentationManager → ClothRenderer → Canvas composite
 *
 * Render loop (per frame):
 *   1. Draw camera frame (mirrored) to base canvas
 *   2. Apply segmentation mask → foreground/background split
 *   3. Compute cloth quad from smoothed pose landmarks
 *   4. WebGL renders cloth onto cloth canvas (transparent bg)
 *   5. Composite: background (optional blur) → person → cloth → UI
 *
 * Target: 30fps on mid-range laptop, <60ms perceived latency.
 */

import { PoseTracker }          from './pose_tracker.js';
import { SegmentationManager }  from './segmentation.js';
import { ClothRenderer }        from './cloth_renderer.js';
import { Analytics }            from './analytics.js';

export class App {
  constructor(config = {}) {
    // Canvases
    this._videoEl        = null;  // hidden <video>
    this._outputCanvas   = null;  // visible output <canvas>
    this._outCtx         = null;
    this._clothCanvas    = null;  // hidden WebGL canvas (upper body)
    this._clothRenderer  = null;
    this._clothCanvas2   = null;  // hidden WebGL canvas (lower body)
    this._clothRenderer2 = null;

    // Modules
    this._poseTracker   = null;
    this._segManager    = null;
    this._analytics     = new Analytics(config.brandId || 'demo');

    // State
    this._latestLandmarks  = null;
    this._latestMask       = null;
    this._currentGarment   = null;
    this._lowerGarment     = null;   // pants / skirt
    this._lowerClothOpacity = 0;
    this._garments         = config.garments || [];
    this._running         = false;
    this._lastFrameTime   = 0;
    this._fpsEl           = null;
    this._frameTimes      = [];

    // Confidence: track last N frames for stability before rendering
    this._confidentFrames = 0;
    this._tmpCanvas       = null;  // cached OffscreenCanvas for person compositing
    this._inferring       = false; // prevents piling up MediaPipe send calls
    this._CONF_WARMUP     = 4;  // hold cloth for 4 frames before showing (prevents cold-start flash)
    this._noConfFrames    = 0;  // frames without confidence (for ghost/fade out)
    this._clothOpacity    = 0;  // 0..1, animated
    this._sizeMultiplier  = 1.0; // S/M/L chip — 1.0 = M (default)
    this._heightMultiplier = 1.0; // height calibration — 1.0 = 170 cm
    this._debugMode       = false; // D key — draw pose landmarks
  }

  async init(videoEl, outputCanvas, clothCanvas, fpsEl) {
    this._videoEl      = videoEl;
    this._outputCanvas = outputCanvas;
    this._outCtx       = outputCanvas.getContext('2d');
    this._clothCanvas  = clothCanvas;
    this._fpsEl        = fpsEl;

    // Init modules
    this._clothRenderer = new ClothRenderer(clothCanvas);
    this._clothRenderer.init();

    const w = outputCanvas.width;
    const h = outputCanvas.height;

    this._segManager = new SegmentationManager((mask) => {
      this._latestMask = mask;
    });
    await this._segManager.init(w, h);

    this._poseTracker = new PoseTracker((landmarks) => {
      this._latestLandmarks = landmarks;
    });
    await this._poseTracker.init();

    this._analytics.sessionStart();
    console.log('[App] All modules ready');
  }

  async startCamera(videoEl, outputCanvas, clothCanvas) {
    // Accept DOM elements here so they're available before init()
    this._videoEl      = videoEl;
    this._outputCanvas = outputCanvas;
    this._clothCanvas  = clothCanvas;

    // Guard: mediaDevices is undefined in non-secure contexts (file://, VS Code Simple Browser, etc.)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(
        'Camera API not available. Open this page in Chrome or Edge at http://localhost:3000 — ' +
        'not in VS Code\'s built-in browser.'
      );
    }

    // Try ideal 640x480 first; fall back to bare video:true
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (e) {
      console.warn('[App] Preferred constraints failed, trying video:true', e);
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
    }
    this._videoEl.srcObject = stream;
    await new Promise(r => { this._videoEl.onloadedmetadata = r; });
    await this._videoEl.play();

    const { videoWidth: w, videoHeight: h } = this._videoEl;
    this._outputCanvas.width  = w;
    this._outputCanvas.height = h;
    this._clothCanvas.width   = w;
    this._clothCanvas.height  = h;

    // Init second canvas for lower body
    if (!this._clothCanvas2) {
      this._clothCanvas2 = new OffscreenCanvas(w, h);
      this._clothRenderer2 = new ClothRenderer(this._clothCanvas2);
      this._clothRenderer2.init();
    } else {
      this._clothCanvas2.width  = w;
      this._clothCanvas2.height = h;
    }

    console.log(`[App] Camera: ${w}x${h}`);
  }

  setSize(multiplier) {
    this._sizeMultiplier = multiplier;
  }

  setHeight(cm) {
    // Scale relative to 170 cm baseline
    this._heightMultiplier = Math.max(0.7, Math.min(1.5, cm / 170));
  }

  toggleDebug() {
    this._debugMode = !this._debugMode;
    return this._debugMode;
  }

  async selectGarment(garment) {
    this._currentGarment = garment;
    this._clothOpacity   = 0;  // reset for fade-in
    await this._clothRenderer.loadGarment(garment.imageUrl);
    this._clothRenderer.setGarmentType(garment.type || 'shirt');
    this._analytics.garmentView(garment.id, garment.name);
    console.log('[App] Garment loaded:', garment.name);
  }

  async selectLowerGarment(garment) {
    if (!this._clothRenderer2) {
      console.warn('[App] Lower renderer not ready yet — camera may not be started');
      return;
    }
    this._lowerGarment      = garment;
    this._lowerClothOpacity = 0;
    await this._clothRenderer2.loadGarment(garment.imageUrl);
    this._clothRenderer2.setGarmentType(garment.type || 'pants');
    console.log('[App] Lower garment loaded:', garment.name);
  }

  clearLowerGarment() {
    this._lowerGarment      = null;
    this._lowerClothOpacity = 0;
  }

  start() {
    this._running  = true;
    this._inferring = false;
    requestAnimationFrame(() => this._loop());
  }

  stop() {
    this._running = false;
    this._analytics.sessionEnd();
  }

  trackAddToCart(garment) {
    this._analytics.addToCart(
      garment ? garment.id : this._currentGarment?.id,
      garment ? garment.price : this._currentGarment?.price
    );
  }

  // ── Core render loop ──────────────────────────────────────────────────────
  // Decoupled from inference: canvas renders at 60fps using latest known results.
  // Inference runs at its own speed (~15-30fps) without blocking the display.

  _loop() {
    if (!this._running) return;

    // Schedule NEXT frame immediately — render is never blocked by inference.
    requestAnimationFrame(() => this._loop());

    const t0    = performance.now();
    const video = this._videoEl;

    // Fire inference only when video is ready and previous inference finished.
    // This prevents MediaPipe call stack from piling up.
    if (video.readyState >= 2 && !this._inferring) {
      this._inferring = true;
      Promise.all([
        this._poseTracker.send(video),
        this._segManager.send(video),
      ])
        .then(() => { this._inferring = false; })
        .catch(() => { this._inferring = false; });
    }

    this._analytics.bumpFrame();
    this._render();
    this._updateFPS(performance.now() - t0);
  }

  _render() {
    const ctx = this._outCtx;
    const w   = this._outputCanvas.width;
    const h   = this._outputCanvas.height;
    const lm  = this._latestLandmarks;
    const mask = this._latestMask;

    // ── 1+2. Draw camera frame (one draw, two paths) ─────────────────────────
    if (mask) {
      // Background: single draw, dimmed+desaturated (replaces step 1 + step 2a)
      ctx.save();
      ctx.filter = 'saturate(0.25) brightness(0.70)';
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this._videoEl, 0, 0, w, h);
      ctx.restore();

      // Person layer: full-brightness cutout composited on top
      this._compositePersonLayer(ctx, mask, w, h);
    } else {
      // No mask yet — plain mirrored frame
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this._videoEl, 0, 0, w, h);
      ctx.restore();
    }

    // ── 3. Compute cloth quad + render ──────────────────────────────────────
    const isConfident = PoseTracker.isConfident(lm);

    if (isConfident) {
      this._confidentFrames++;
      this._noConfFrames = 0;
    } else {
      this._noConfFrames++;
      if (this._noConfFrames > 8) this._confidentFrames = 0;
    }

    const shouldRenderCloth = this._currentGarment &&
      this._confidentFrames >= this._CONF_WARMUP;

    if (shouldRenderCloth) {
      // Mirror landmarks X to match mirrored video
      const mirroredLm = lm.map(p => ({ ...p, x: 1 - p.x }));
      const quad = PoseTracker.computeClothQuad(
        mirroredLm, w, h, this._currentGarment.type || 'shirt',
        this._sizeMultiplier * this._heightMultiplier
      );

      if (quad) {
        // Animate cloth opacity: fade in on first frames, fade out on confidence loss
        const targetOpacity = isConfident ? 1.0 : 0.0;
        this._clothOpacity += (targetOpacity - this._clothOpacity) * 0.12;

        // Render cloth via WebGL onto transparent cloth canvas
        this._clothRenderer.render(quad);

        // Composite cloth canvas onto output
        ctx.save();
        ctx.globalAlpha = this._clothOpacity;
        ctx.drawImage(this._clothCanvas, 0, 0);
        ctx.restore();

        this._analytics.tryonActive();
      }
    } else if (this._noConfFrames > 15 && this._clothOpacity > 0.01) {
      // Graceful fade-out when we lose tracking
      this._clothOpacity *= 0.85;
      if (this._currentGarment) {
        const mirroredLm = lm ? lm.map(p => ({ ...p, x: 1 - p.x })) : null;
        const quad = mirroredLm
          ? PoseTracker.computeClothQuad(mirroredLm, w, h, this._currentGarment?.type || 'shirt',
              this._sizeMultiplier * this._heightMultiplier) : null;
        if (quad) {
          this._clothRenderer.render(quad);
          ctx.save();
          ctx.globalAlpha = this._clothOpacity;
          ctx.drawImage(this._clothCanvas, 0, 0);
          ctx.restore();
        }
      }
    }

    // ── 4. Lower body (pants/skirt) ─────────────────────────────────────────
    if (this._lowerGarment && this._clothRenderer2 && shouldRenderCloth) {
      const mirroredLm = lm.map(p => ({ ...p, x: 1 - p.x }));
      const lowerQuad  = PoseTracker.computeLowerBodyQuad(
        mirroredLm, w, h,
        this._lowerGarment.type || 'pants',
        this._sizeMultiplier * this._heightMultiplier
      );
      if (lowerQuad) {
        const targetOpacity = isConfident ? 1.0 : 0.0;
        this._lowerClothOpacity += (targetOpacity - this._lowerClothOpacity) * 0.12;
        this._clothRenderer2.render(lowerQuad);
        ctx.save();
        ctx.globalAlpha = this._lowerClothOpacity;
        ctx.drawImage(this._clothCanvas2, 0, 0);
        ctx.restore();
      }
    }

    // ── 5. Punch arms back over cloth (fixes sticker effect) ────────────────
    if (mask && lm && (this._currentGarment || this._lowerGarment)) {
      this._drawArmsOverCloth(ctx, lm, mask, w, h);
    }

    // ── Debug overlay (D key) ──────────────────────────────────────────────
    if (this._debugMode) this._drawDebug(ctx, this._latestLandmarks, w, h);
  }

  /**
   * Redraw arm pixels OVER the cloth so arms appear in front of shirt.
   * Builds a polygon path from shoulder→elbow→wrist on each side,
   * then redraws the person (video + mask) clipped to that region.
   */
  _drawArmsOverCloth(ctx, landmarks, mask, w, h) {
    if (!landmarks) return;
    const px = (idx) => ({
      x: (1 - landmarks[idx].x) * w,
      y:  landmarks[idx].y * h,
    });

    const visOf = (idx) => landmarks[idx]?.visibility ?? 0;

    // Build paths for each arm — skip if key points not tracked
    const armPolygons = [];

    // Left arm: chest-center → left shoulder → left elbow → (wrist)
    if (visOf(11) > 0.4 && visOf(13) > 0.3) {
      const sh = px(11); const el = px(13);
      const wr = visOf(15) > 0.3 ? px(15) : { x: el.x - (sh.y - el.y) * 0.15, y: el.y + (sh.y - el.y) * 0.6 };
      const pad = 22;
      armPolygons.push([ {x: sh.x + pad, y: sh.y - pad}, sh, el, wr, {x: wr.x - pad, y: wr.y}, {x: el.x - pad, y: el.y}, {x: sh.x - pad, y: sh.y + pad} ]);
    }

    // Right arm: chest-center → right shoulder → right elbow → (wrist)
    if (visOf(12) > 0.4 && visOf(14) > 0.3) {
      const sh = px(12); const el = px(14);
      const wr = visOf(16) > 0.3 ? px(16) : { x: el.x + (el.y - sh.y) * 0.15, y: el.y + (sh.y - el.y) * 0.6 };
      const pad = 22;
      armPolygons.push([ {x: sh.x - pad, y: sh.y - pad}, sh, el, wr, {x: wr.x + pad, y: wr.y}, {x: el.x + pad, y: el.y}, {x: sh.x + pad, y: sh.y + pad} ]);
    }

    if (armPolygons.length === 0) return;

    // Get person pixels (reuse cached tmp canvas which was already composited)
    if (!this._tmpCanvas) return;

    ctx.save();
    ctx.beginPath();
    for (const poly of armPolygons) {
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
    }
    ctx.clip();
    ctx.drawImage(this._tmpCanvas, 0, 0);
    ctx.restore();
  }

  /**
   * Composite person pixels over background using segmentation mask.
   * Uses GPU canvas compositing (destination-in) — no CPU pixel loop.
   * Mask from segmentation.js has alpha = person probability (pre-converted).
   */
  _compositePersonLayer(ctx, mask, w, h) {
    // Lazily init cached canvas — check BOTH dimensions (avoids corrupt composite on resize)
    if (!this._tmpCanvas || this._tmpCanvas.width !== w || this._tmpCanvas.height !== h) {
      this._tmpCanvas = new OffscreenCanvas(w, h);
    }
    const tmp = this._tmpCanvas.getContext('2d');

    // 1. Draw mirrored video onto tmp
    tmp.clearRect(0, 0, w, h);
    tmp.save();
    tmp.translate(w, 0);
    tmp.scale(-1, 1);
    tmp.drawImage(this._videoEl, 0, 0, w, h);
    tmp.restore();

    // 2. Cut out person shape using mask alpha (destination-in)
    //    Mask was stored unmirrored from MediaPipe, so mirror it here
    tmp.globalCompositeOperation = 'destination-in';
    tmp.save();
    tmp.translate(w, 0);
    tmp.scale(-1, 1);
    tmp.drawImage(mask, 0, 0, w, h);
    tmp.restore();
    tmp.globalCompositeOperation = 'source-over';

    // 3. Draw person cutout on top of dimmed background
    ctx.drawImage(this._tmpCanvas, 0, 0);
  }

  // ── FPS counter ────────────────────────────────────────────────────────────
  _updateFPS(frameMs) {
    this._frameTimes.push(frameMs);
    if (this._frameTimes.length > 30) this._frameTimes.shift();
    if (this._fpsEl && this._frameTimes.length % 10 === 0) {
      const avgMs = this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;
      const fps = Math.round(1000 / Math.max(avgMs, 16));
      this._fpsEl.textContent = `${fps} FPS  ${Math.round(avgMs)}ms`;
      // Color-code FPS: green ≥25, yellow 15-25, red <15
      this._fpsEl.style.color = fps >= 25 ? '#4ade80' : fps >= 15 ? '#fbbf24' : '#f87171';
    }
  }

  // ── Debug skeleton overlay (D key) ────────────────────────────────────────
  _drawDebug(ctx, landmarks, w, h) {
    if (!landmarks) return;
    const CONNECTIONS = [
      [11,12],[11,13],[13,15],[12,14],[14,16], // arms
      [11,23],[12,24],[23,24],                  // torso
      [23,25],[24,26],[25,27],[26,28],           // legs
      [0,1],[1,2],[2,3],[0,4],[4,5],[5,6],[9,10], // face+mouth
    ];
    const px = (i) => ({ x: (1 - landmarks[i].x) * w, y: landmarks[i].y * h });

    ctx.save();
    ctx.strokeStyle = 'rgba(74,222,128,0.80)';
    ctx.lineWidth = 1.5;
    for (const [a, b] of CONNECTIONS) {
      const pa = px(a), pb = px(b);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
    for (let i = 0; i < landmarks.length; i++) {
      const vis = landmarks[i].visibility ?? 1;
      if (vis < 0.3) continue;
      const p = px(i);
      ctx.fillStyle = vis > 0.7 ? '#4ade80' : '#fbbf24';
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.font = '9px monospace';
    ctx.fillStyle = '#fff';
    for (const i of [0,11,12,13,14,15,16,23,24]) {
      const p = px(i);
      ctx.fillText(i, p.x + 4, p.y - 2);
    }
    ctx.restore();
  }
}

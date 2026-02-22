import { LandmarkSmoother } from './one_euro_filter.js';

/**
 * MediaPipe Pose landmark indices for upper body garment warp.
 *
 * We use 6 anchor points to define the cloth quad + sleeve guides:
 *   11 = left shoulder   12 = right shoulder
 *   23 = left hip        24 = right hip
 *   13 = left elbow      14 = right elbow
 *   25 = left knee       26 = right knee  (used for elongated garments)
 */
export const LM = {
  LEFT_SHOULDER:  11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW:     13,
  RIGHT_ELBOW:    14,
  LEFT_WRIST:     15,
  RIGHT_WRIST:    16,
  LEFT_HIP:       23,
  RIGHT_HIP:      24,
  LEFT_KNEE:      25,
  RIGHT_KNEE:     26,
  LEFT_ANKLE:     27,
  RIGHT_ANKLE:    28,
  NOSE:           0,
  LEFT_EAR:       7,
  RIGHT_EAR:      8,
};

export class PoseTracker {
  constructor(onResults) {
    this._onResults = onResults;
    this._smoother = new LandmarkSmoother(33, 0.8, 0.05);
    this._pose = null;
    this._ready = false;
    this._frameCount = 0;
  }

  async init() {
    this._pose = new Pose({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`,
    });

    this._pose.setOptions({
      modelComplexity: 1,       // 0=lite(fastest), 1=full, 2=heavy
      smoothLandmarks: false,   // we do our own smoothing with 1€ filter
      enableSegmentation: false,
      smoothSegmentation: false,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });

    this._pose.onResults((results) => this._handleResults(results));
    await this._pose.initialize();
    this._ready = true;
    console.log('[PoseTracker] Ready');
  }

  _handleResults(results) {
    this._frameCount++;
    if (!results.poseLandmarks) {
      this._onResults(null);
      return;
    }
    // Apply 1€ filter — this is the #1 trick for premium AR feel
    const smoothed = this._smoother.smooth(results.poseLandmarks);
    this._onResults(smoothed);
  }

  async send(videoFrame) {
    if (!this._ready) return;
    await this._pose.send({ image: videoFrame });
  }

  /**
   * Computes the cloth warp quad from smoothed landmarks.
   *
   * Returns 4 corners in canvas pixel coords:
   *   [topLeft, topRight, bottomRight, bottomLeft]
   *
   * The cloth image will be perspective-warped onto this quad.
   *
   * canvasW, canvasH: the output canvas dimensions (landmarks are 0–1 normalized)
   */
  static computeClothQuad(landmarks, canvasW, canvasH, garmentType = 'shirt', sizeMultiplier = 1.0) {
    if (!landmarks) return null;

    const lm = (idx) => ({
      x: landmarks[idx].x * canvasW,
      y: landmarks[idx].y * canvasH,
    });

    const ls = lm(LM.LEFT_SHOULDER);
    const rs = lm(LM.RIGHT_SHOULDER);
    const lh = lm(LM.LEFT_HIP);
    const rh = lm(LM.RIGHT_HIP);
    const le = lm(LM.LEFT_ELBOW);
    const re = lm(LM.RIGHT_ELBOW);

    const shoulderWidth = Math.abs(rs.x - ls.x);

    // Body-proportional reference: shoulder→hip distance drives garment height.
    // This ensures the garment scales correctly whether the user is 1m or 3m away.
    const shoulderMidY = (ls.y + rs.y) / 2;
    const hipMidY      = (lh.y + rh.y) / 2;
    const bodyHeight   = Math.max(hipMidY - shoulderMidY, shoulderWidth * 0.8);

    // Identify which shoulder is physically left/right in the mirrored frame
    const leftSh  = ls.x < rs.x ? ls : rs;
    const rightSh = ls.x < rs.x ? rs : ls;
    const leftHip  = lh.x < rh.x ? lh : rh;
    const rightHip = lh.x < rh.x ? rh : lh;
    const leftEl   = le.x < re.x ? le : re;   // left elbow (screen-left)
    const rightEl  = le.x < re.x ? re : le;   // right elbow (screen-right)

    // Horizontal extent: use ELBOW positions for natural sleeve coverage.
    // Fall back to shoulder+padding if elbows are tucked in.
    // Use wrist positions when visible — sleeves follow all the way to the wrist
    const lw = lm(LM.LEFT_WRIST);
    const rw = lm(LM.RIGHT_WRIST);
    const lwVis = landmarks[LM.LEFT_WRIST]?.visibility  ?? 0;
    const rwVis = landmarks[LM.RIGHT_WRIST]?.visibility ?? 0;

    const elbowPad    = shoulderWidth * 0.18 * sizeMultiplier;
    const shoulderPad = shoulderWidth * 0.28 * sizeMultiplier;
    const wristPad    = shoulderWidth * 0.08 * sizeMultiplier;

    // Extend sleeve to wrist when wrist is visible and outside elbow
    const leftWristX  = lwVis > 0.4 ? Math.min(lw.x - wristPad, leftEl.x - elbowPad)  : leftEl.x  - elbowPad;
    const rightWristX = rwVis > 0.4 ? Math.max(rw.x + wristPad, rightEl.x + elbowPad) : rightEl.x + elbowPad;

    const leftX  = Math.min(leftWristX,  leftSh.x  - shoulderPad);
    const rightX = Math.max(rightWristX, rightSh.x + shoulderPad);

    // Top edge: lift above shoulders proportionally (collar coverage)
    // Use nose-to-shoulder distance so collar sits at the right height.
    const topLift   = shoulderWidth * 0.18;
    const topLeftY  = leftSh.y  - topLift;
    const topRightY = rightSh.y - topLift;

    // Bottom edge: body-proportional drop below hips
    // jacket longer, shirt slightly below hip, hoodie to hip
    const dropRatio = (garmentType === 'jacket' ? 0.22
                     : garmentType === 'hoodie' ? 0.08
                     : 0.12) * sizeMultiplier;
    const botY = hipMidY + bodyHeight * dropRatio;

    // Bottom corners follow the shoulder tilt slope for natural drape
    const tilt   = (topRightY - topLeftY) / (rightX - leftX);
    const midX   = (leftX + rightX) / 2;
    const botPad    = shoulderWidth * 0.10 * sizeMultiplier;  // slight taper at hem
    const botLeftX  = leftSh.x  - shoulderPad - botPad;
    const botRightX = rightSh.x + shoulderPad + botPad;
    const botLeftY  = botY + tilt * (botLeftX  - midX);
    const botRightY = botY + tilt * (botRightX - midX);

    return [
      { x: leftX,      y: topLeftY  },  // top-left
      { x: rightX,     y: topRightY },  // top-right
      { x: botRightX,  y: botRightY },  // bottom-right
      { x: botLeftX,   y: botLeftY  },  // bottom-left
    ];
  }

  /**
   * Compute lower body (pants/skirt) warp quad from hip → knee → ankle.
   * Returns [topLeft, topRight, bottomRight, bottomLeft] in canvas pixels.
   */
  static computeLowerBodyQuad(landmarks, canvasW, canvasH, garmentType = 'pants', sizeMultiplier = 1.0) {
    if (!landmarks) return null;
    const lm = (idx) => ({ x: landmarks[idx].x * canvasW, y: landmarks[idx].y * canvasH });

    const lh = lm(LM.LEFT_HIP);   const rh = lm(LM.RIGHT_HIP);
    const lk = lm(LM.LEFT_KNEE);  const rk = lm(LM.RIGHT_KNEE);
    const la = lm(LM.LEFT_ANKLE); const ra = lm(LM.RIGHT_ANKLE);

    const lkVis = landmarks[LM.LEFT_KNEE]?.visibility  ?? 0;
    const rkVis = landmarks[LM.RIGHT_KNEE]?.visibility ?? 0;
    const laVis = landmarks[LM.LEFT_ANKLE]?.visibility  ?? 0;
    const raVis = landmarks[LM.RIGHT_ANKLE]?.visibility ?? 0;

    // Need at least hips to render
    if ((landmarks[LM.LEFT_HIP]?.visibility ?? 0) < 0.4 ||
        (landmarks[LM.RIGHT_HIP]?.visibility ?? 0) < 0.4) return null;

    const hipW  = Math.abs(rh.x - lh.x);
    const sidePad = hipW * 0.18 * sizeMultiplier;

    // Top edge: at waist (just above hips)
    const waistLift = hipW * 0.12;
    const topY  = Math.min(lh.y, rh.y) - waistLift;
    const leftX  = Math.min(lh.x, rh.x) - sidePad;
    const rightX = Math.max(lh.x, rh.x) + sidePad;

    // Bottom edge: ankles if visible, else knees, else estimate
    let botY;
    if ((laVis > 0.4 || raVis > 0.4)) {
      botY = Math.max(
        laVis > 0.4 ? la.y : 0,
        raVis > 0.4 ? ra.y : 0
      ) + hipW * 0.08 * sizeMultiplier;
    } else if (lkVis > 0.4 || rkVis > 0.4) {
      botY = Math.max(
        lkVis > 0.4 ? lk.y : 0,
        rkVis > 0.4 ? rk.y : 0
      ) + hipW * 0.12 * sizeMultiplier;
    } else {
      // Estimate: hip + 2x hip-to-hip width
      botY = Math.max(lh.y, rh.y) + hipW * 1.8 * sizeMultiplier;
    }

    // Slight taper at hem (pants narrow at ankles)
    const taperBot = sidePad * (garmentType === 'skirt' ? 1.3 : 0.6);

    return [
      { x: leftX,           y: topY },   // top-left
      { x: rightX,          y: topY },   // top-right
      { x: rightX - taperBot, y: botY }, // bottom-right
      { x: leftX  + taperBot, y: botY }, // bottom-left
    ];
  }

  /**
   * Confidence check — only render cloth if both shoulders and both hips
   * are detected with sufficient visibility. Prevents cloth collapse on
   * occlusion or profile angles.
   */
  static isConfident(landmarks, threshold = 0.55) {
    if (!landmarks) return false;
    const check = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP];
    return check.every(i => (landmarks[i]?.visibility ?? 0) >= threshold);
  }

  reset() {
    this._smoother.reset();
  }
}

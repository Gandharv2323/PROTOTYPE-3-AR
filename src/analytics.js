/**
 * Analytics — lightweight session + conversion tracking.
 *
 * Fires events to the backend (or localStorage for MVP).
 * Replace ENDPOINT with your own endpoint when you have a server.
 *
 * Events tracked:
 *   session_start       — user opens the try-on
 *   garment_view        — user selects a garment
 *   tryon_active        — cloth is actively rendered (pose detected)
 *   session_end         — user closes or navigates away
 *   add_to_cart         — user clicks "Add to Cart" while in try-on
 *
 * This is your commercial data layer. Every pilot KPI comes from here.
 */
const ENDPOINT      = '/api/events';   // backend endpoint (active)
const ERROR_ENDPOINT= '/api/errors';   // error telemetry endpoint

// ── Global error telemetry ───────────────────────────────────────────────
// Captures unhandled JS errors and sends to /api/errors — no Sentry needed.
export function initErrorTelemetry(sessionId) {
  window.addEventListener('error', (e) => {
    _reportError({
      type:    'uncaught',
      message: e.message,
      source:  e.filename,
      line:    e.lineno,
      col:     e.colno,
      sessionId,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    _reportError({
      type:    'unhandledrejection',
      message: String(e.reason),
      sessionId,
    });
  });
}

function _reportError(payload) {
  try {
    navigator.sendBeacon(ERROR_ENDPOINT, JSON.stringify(payload));
  } catch (_) {}
  console.error('[ErrorTelemetry]', payload.message);
}

export class Analytics {
  constructor(brandId = 'demo') {
    this._brandId = brandId;
    this._sessionId = this._generateId();
    this._sessionStart = Date.now();
    this._activeGarment = null;
    this._tryonFrames = 0;  // frames where cloth was visible
    this._totalFrames = 0;
    this._garmentDwellStart = null;
    this._events = [];

    // Flush on page unload
    window.addEventListener('beforeunload', () => {
      this._flush('session_end');
      this._flushBatch();
    });
    console.log('[Analytics] Session:', this._sessionId);
  }

  sessionStart() {
    this._fire('session_start', {});
  }

  garmentView(garmentId, garmentName) {
    this._activeGarment = garmentId;
    this._garmentDwellStart = Date.now();
    this._fire('garment_view', { garmentId, garmentName });
  }

  tryonActive() {
    this._tryonFrames++;
    // Fire engagement event every 5 seconds of active try-on
    if (this._tryonFrames % 150 === 0) {  // ~5s at 30fps
      const dwell = this._garmentDwellStart
        ? Math.round((Date.now() - this._garmentDwellStart) / 1000)
        : 0;
      this._fire('tryon_active', {
        garmentId: this._activeGarment,
        dwellSeconds: dwell,
      });
    }
  }

  addToCart(garmentId, price) {
    this._fire('add_to_cart', {
      garmentId: garmentId || this._activeGarment,
      price,
      dwellBeforeCart: this._garmentDwellStart
        ? Math.round((Date.now() - this._garmentDwellStart) / 1000)
        : null,
    });
  }

  sessionEnd() {
    this._flush('session_end');
  }

  // ──────────────────────────────────────────────────────────
  _fire(name, data) {
    const event = {
      event: name,
      sessionId: this._sessionId,
      brandId: this._brandId,
      timestamp: new Date().toISOString(),
      ...data,
    };
    this._events.push(event);
    console.debug('[Analytics]', name, data);

    // Also store in localStorage for offline/fallback
    try {
      const stored = JSON.parse(localStorage.getItem('ar_mirror_events') || '[]');
      stored.push(event);
      // Keep last 500 events
      if (stored.length > 500) stored.splice(0, stored.length - 500);
      localStorage.setItem('ar_mirror_events', JSON.stringify(stored));
    } catch (_) {}

    if (ENDPOINT) this._sendToServer(event);
  }

  /** Flush remaining events to server (send all in one batch) */
  _flushBatch() {
    if (!ENDPOINT || this._events.length === 0) return;
    try {
      // sendBeacon works reliably in beforeunload (fetch doesn't)
      const payload = JSON.stringify({
        batch: true,
        events: this._events.slice(-50),  // last 50 max
      });
      navigator.sendBeacon(ENDPOINT, payload);
    } catch (_) {}
  }

  _flush(reason) {
    const duration = Math.round((Date.now() - this._sessionStart) / 1000);
    this._fire(reason, {
      durationSeconds: duration,
      tryonEngagementPct: this._totalFrames > 0
        ? Math.round((this._tryonFrames / this._totalFrames) * 100)
        : 0,
    });
  }

  async _sendToServer(event) {
    try {
      await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        keepalive: true,  // works in beforeunload
      });
    } catch (_) {}
  }

  _generateId() {
    return 'sess_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  /**
   * Returns a summary object for the current session.
   * Use this to display real-time stats during pilot demos.
   */
  getSummary() {
    return {
      sessionId: this._sessionId,
      durationSec: Math.round((Date.now() - this._sessionStart) / 1000),
      tryonEngagement: this._totalFrames > 0
        ? Math.round((this._tryonFrames / this._totalFrames) * 100) + '%'
        : '0%',
      eventsCount: this._events.length,
    };
  }

  bumpFrame() { this._totalFrames++; }
}

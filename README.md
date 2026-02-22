# AR Mirror — Real-Time Virtual Try-On

> Browser-native, camera-powered virtual garment try-on. No app install. No servers for inference. Just open a URL.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?logo=node.js)](https://nodejs.org)
[![Vanilla JS](https://img.shields.io/badge/Frontend-Vanilla%20JS%20ES%20Modules-yellow)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
[![MediaPipe](https://img.shields.io/badge/Pose-MediaPipe%20Pose-blue)](https://google.github.io/mediapipe/solutions/pose.html)
[![WebGL](https://img.shields.io/badge/Renderer-WebGL1-orange)](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API)
[![Deploy on Railway](https://img.shields.io/badge/Deploy-Railway-purple)](https://railway.app)

---

## What It Does

AR Mirror overlays a flat-lay garment image onto a live camera feed, warped in real-time to match the wearer's body pose. It runs entirely in the browser using MediaPipe for pose estimation, WebGL for perspective-correct UV warping, and a Node.js server for the catalog API.

```
Camera → MediaPipe Pose + Segmentation → shoulder/hip quad → WebGL warp → composite
```

No Python runtime. No cloud GPU. No app install. Works on laptop, tablet, and mobile.

---

## Key Features

| Feature | Details |
|---|---|
| **Real-time pose tracking** | MediaPipe Pose @ 30fps, 1€ filter smoothing |
| **Cloth warping** | WebGL1 5-point perspective-correct UV warp (shoulders, hips, center) |
| **Person segmentation** | MediaPipe SelfieSegmentation — background dim/desaturate |
| **Arms-over-cloth** | Person arm pixels are re-composited OVER cloth each frame — no sticker effect |
| **Wrist sleeve tracking** | Sleeves extend to wrist when MediaPipe detects them — natural arm movement |
| **Full body (pants)** | Lower-body quad: hip → knee → ankle with hem taper — second WebGL renderer |
| **Upload any garment** | Upload PNG/JPG → client-side flood-fill BG removal → instant AR try-on |
| **16-garment preset catalog** | Shirts, jackets, hoodies — real flat-lay images, transparent PNGs |
| **Size chips** | XS / S / M / L / XL (0.82× — 1.22× body-proportional scale) |
| **Height calibration** | 140–220 cm input → scales garment fit to real body |
| **Share / snapshot** | Web Share API (mobile native sheet) or direct PNG download |
| **Skeleton debug** | `D` key toggles landmark overlay |
| **Analytics** | Session events, try-on engagement, add-to-cart telemetry |
| **Service worker** | Caches models + assets → subsequent loads in ~0.5s |
| **CSP headers** | Content Security Policy with `wasm-unsafe-eval` for MediaPipe WASM |
| **Health check** | `GET /healthz` → 200 `ok` (Railway health probes) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (Chrome / Edge / Safari)                           │
│                                                             │
│  index.html ──► app.js (render loop @ 60fps)               │
│                  │                                          │
│       ┌──────────┼──────────┐                               │
│       ▼          ▼          ▼                               │
│  pose_tracker  segmentation  cloth_renderer                 │
│  (MediaPipe)   (MediaPipe)   (WebGL1)                       │
│       │          │          │                               │
│       └──────────┴──► composite on <canvas>                 │
│                                                             │
│  analytics.js ────────────────► POST /api/events            │
│  one_euro_filter.js (landmark smoother)                     │
└─────────────────────────────────────────────────────────────┘
              ▲                   │
              │ GET /api/garments │ Static assets
              │ POST /api/events  │ /assets/garments/*.png
┌─────────────────────────────────────────────────────────────┐
│  Node.js server.js                                          │
│   • HTTP (3000) — HTTPS auto on local with self-signed cert │
│   • /api/garments  → garments.json (16 items)               │
│   • /api/events    → data/events.ndjson (append-only)       │
│   • /api/errors    → data/errors.ndjson                     │
│   • /dashboard     → analytics HTML dashboard               │
│   • /healthz       → 200 ok                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Garment Catalog

16 preset garment PNGs sourced from VITON-HD dataset and processed with PIL threshold background removal (R,G,B > 230 → transparent), resized to max 600px.

| Type | Items |
|---|---|
| Shirts | Classic White, Stripe Oxford, Black Crew Tee, Charcoal Dress, Sage Green, Teal Polo, Steel Blue, Jet Black V-Neck, Forest Green |
| Jackets | Navy Jacket, Navy Blazer, Dark Navy Overcoat, Olive Field Jacket, Black Utility Vest |
| Hoodies | Black Hoodie, Indigo Crewneck Sweater |

Extend the catalog by adding PNGs to `assets/garments/` and entries to `garments.json`.

**Or upload your own** — click the upload zone in the sidebar, select Shirt/Hoodie/Jacket/Pants, then pick any image. Background is removed client-side automatically.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla JS ES Modules (no bundler) |
| Pose estimation | MediaPipe Pose 0.5.1675469404 |
| Segmentation | MediaPipe SelfieSegmentation 0.1.1675465747 |
| Cloth renderer | WebGL1, custom GLSL perspective UV warp |
| Landmark smoothing | 1€ filter (custom implementation) |
| Server | Node.js 18+ (zero npm dependencies) |
| Caching | Service Worker (cache-first for models, stale-while-revalidate for assets) |
| Cloud | Railway (auto-deploy from GitHub) |

---

## Local Setup

### Prerequisites
- Node.js 16+
- Chrome or Edge (camera + WebGL required)
- HTTPS recommended (required for camera on most mobile)

### Run

```bash
# 1. Clone
git clone https://github.com/Gandharv2323/PROTOTYPE-3-AR.git
cd PROTOTYPE-3-AR/ar-mirror

# 2. Start server (no npm install needed — zero dependencies)
node server.js

# 3. Open
# → http://localhost:3000
```

### HTTPS (optional, for mobile)

```bash
# Generate self-signed cert
node generate-cert.js

# Restart server — it will auto-detect certs/ and serve HTTPS
node server.js
# → https://localhost:3001
```

> **Note:** On mobile, you'll need to accept the self-signed cert warning, or use the Railway cloud URL which has a valid certificate.

---

## Cloud Deployment (Railway)

1. Push code to GitHub (already done)
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select `PROTOTYPE-3-AR` repo
4. Railway auto-detects `package.json` start script → runs `node server.js`
5. Click **Generate Domain** → get a public HTTPS URL

The server binds to `process.env.PORT` (Railway injects this) and `0.0.0.0` for cloud accessibility.

---

## Project Structure

```
ar-mirror/
├── index.html              # Single-page app
├── server.js               # Node.js HTTP/S server + API
├── garments.json           # 16-item garment catalog
├── sw.js                   # Service worker
├── package.json            # { "start": "node server.js" }, zero deps
├── .gitignore
├── assets/
│   └── garments/           # 16 transparent PNG garment images
├── src/
│   ├── app.js              # Main render loop orchestrator
│   ├── pose_tracker.js     # MediaPipe Pose wrapper + cloth quad compute
│   ├── cloth_renderer.js   # WebGL1 4-fan perspective UV warper
│   ├── segmentation.js     # MediaPipe SelfieSegmentation wrapper
│   ├── analytics.js        # Event tracking + error telemetry
│   └── one_euro_filter.js  # Landmark smoothing filter
└── data/
    ├── events.ndjson       # Append-only analytics log (gitignored)
    └── errors.ndjson       # Error telemetry log (gitignored)
```

---

## How the Cloth Warping Works

1. MediaPipe returns 33 body landmarks (normalized 0–1 x/y/visibility)
2. **Upper body**: `computeClothQuad()` extracts shoulder + hip landmarks, expands sleeve width to wrists when visible
3. **Lower body**: `computeLowerBodyQuad()` maps hip → knee → ankle with slight hem taper for pants/skirts
4. A perspective-correct 5-point UV warp is computed in a WebGL1 fragment shader (TL, TR, BR, BL, center)
5. The garment PNG is rendered onto a hidden `<canvas>` — one per garment slot (upper + lower)
6. **Arms punch-out**: after cloth rendering, arm polygons (shoulder→elbow→wrist) are re-drawn from the live person frame, composited on top of the cloth — this prevents the floating sticker effect
7. Frame composite order: background (desaturated) → person cutout (full brightness) → upper cloth → lower cloth → arm pixels → UI

### Upload-to-AR (client-side BG removal)

When you upload a garment image, a flood-fill algorithm starts from all four image corners, samples the background color, and zeroes out any pixel matching within a Manhattan-distance tolerance of 42. The result is a transparent PNG rendered to an object-URL and handed directly to the WebGL renderer — no server round-trip, no API key required.

---

## Performance

| Metric | Value |
|---|---|
| Target FPS | 30fps on mid-range laptop |
| Perceived latency | <60ms |
| Model load (first) | ~10 seconds (CDN download) |
| Model load (cached) | ~0.5 seconds (service worker) |
| Bundle size | 0 KB (no bundler, no framework) |

The render loop is decoupled from inference — canvas updates at 60fps using the latest available landmarks, while MediaPipe runs at its own pace (~15–30fps depending on hardware).

---

## Roadmap

- [x] **Full body coverage** — pants/skirt lower-body quad
- [x] **Upload any garment** — client-side BG removal → instant AR
- [x] **Arms-over-cloth** — realistic depth layering
- [x] **Wrist sleeve tracking** — sleeves follow arm movement
- [ ] **ViViD integration** — swap flat-lay PNGs for ViViD-generated try-on video frames
- [ ] **Garment search / filter** — by type, color, price
- [ ] **Cart persistence** — localStorage save across sessions
- [ ] **Fit score** — confidence score for "how well the garment fits" the detected body
- [ ] **Backend auth** — user accounts, saved try-ons
- [ ] **WebXR** — AR headset / phone camera overlay (WebXR Device API)

---

## ViViD Inference Pipeline (Research Backend)

This project also includes a local [ViViD](https://github.com/alibaba-yuanjing-aigclab/ViViD) inference setup for generating high-quality video try-on results:

```
ViViD/
├── vivid.py                  # Inference entry point
├── ckpts/                    # Model weights (git ignored)
│   ├── MotionModule/         # AnimateDiff motion module
│   ├── sd-image-variations-diffusers/  # Base UNet
│   └── sd-vae-ft-mse/        # Fine-tuned VAE
├── data/
│   ├── videos/               # Model (body) videos
│   └── cloth/                # Garment flat-lay images
└── configs/prompts/
    └── upper1.yaml           # Inference config
```

ViViD generates a video of the garment worn on a model, which can then be used as reference material for the AR overlay.

---

## License

MIT — see [LICENSE](LICENSE)

---

*Built with MediaPipe, WebGL, and Node.js. No frameworks were harmed in the making of this project.*

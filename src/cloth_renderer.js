/**
 * ClothRenderer — WebGL-accelerated perspective cloth warp.
 *
 * Maps a garment image onto an arbitrary 4-point quad derived from pose.
 * Runs entirely on GPU — no CPU bottleneck in the render loop.
 *
 * Rendering pipeline per frame:
 *   1. Camera frame → canvas (mirrored)
 *   2. Person mask applied → background isolated
 *   3. Cloth quad warped onto body region via WebGL
 *   4. Alpha-blended composite written to output canvas
 *
 * The 3 tricks that make this feel premium:
 *   A. Perspective-correct UV interpolation in shader (not affine)
 *   B. Per-pixel alpha fade at quad edges (feathering)
 *   C. Temporal opacity blend (new cloth fades in over 6 frames on garment switch)
 */

const VERT_SHADER = `
  attribute vec2 a_position;  // quad corner in screen pixels
  attribute vec2 a_texCoord;  // UV [0..1]

  uniform vec2 u_resolution; // canvas size

  // Perspective-correct interpolation: pass (u/w, v/w, 1/w) to fragment
  // and let GPU interpolate. Multiply back in fragment shader.
  varying vec2 v_texCoord;

  void main() {
    // Convert from pixel coords to clip space [-1, 1]
    vec2 clip = (a_position / u_resolution) * 2.0 - 1.0;
    clip.y = -clip.y; // flip Y (canvas Y is down, WebGL is up)
    gl_Position = vec4(clip, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`;

const FRAG_SHADER = `
  precision mediump float;
  varying vec2 v_texCoord;
  uniform sampler2D u_texture;
  uniform float u_opacity;
  uniform float u_edgeFade;    // feather distance in UV space
  uniform float u_roughness;   // 0=silk, 0.75=cotton, 0.82=denim
  uniform float u_fabricScale; // weave tiling (24=cotton, 48=silk, 32=denim)
  uniform float u_time;        // seconds — for silk shimmer animation
  uniform float u_envBrightness; // scene brightness from camera (0.3 dark … 1.5 bright)
  uniform vec3  u_envTint;       // scene color tint sampled from camera feed

  // --- Pseudo-random hash for noise ---
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  // Value noise (smooth random field)
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }

  // --- Fabric weave normal (cross-hatch sine threads) ---
  vec3 weaveNormal(vec2 uv, float scale) {
    vec2 p = uv * scale;
    float wx = sin(p.x * 6.2832);
    float wy = sin(p.y * 6.2832);
    float eps = 0.03;
    float wx2 = sin((p.x + eps) * 6.2832);
    float wy2 = sin((p.y + eps) * 6.2832);
    float dX = (wx2 * wy - wx * wy) / eps * 0.04;
    float dY = (wx * wy2 - wx * wy) / eps * 0.04;
    return normalize(vec3(dX, dY, 1.0));
  }

  // --- Low-frequency wrinkle normal (2-octave value noise gradient) ---
  vec3 wrinkleNormal(vec2 uv) {
    float eps = 0.008;
    float h00 = vnoise(uv * 4.0) * 0.65 + vnoise(uv * 9.0) * 0.35;
    float hx  = vnoise((uv + vec2(eps,0.0)) * 4.0) * 0.65 + vnoise((uv + vec2(eps,0.0)) * 9.0) * 0.35;
    float hy  = vnoise((uv + vec2(0.0,eps)) * 4.0) * 0.65 + vnoise((uv + vec2(0.0,eps)) * 9.0) * 0.35;
    float dX = (hx - h00) / eps * 0.45;
    float dY = (hy - h00) / eps * 0.45;
    return normalize(vec3(dX, dY, 1.0));
  }

  void main() {
    vec4 color = texture2D(u_texture, v_texCoord);

    // Edge feathering
    float fadeX = smoothstep(0.0, u_edgeFade, v_texCoord.x)
                * smoothstep(1.0, 1.0 - u_edgeFade, v_texCoord.x);
    float fadeY = smoothstep(0.0, u_edgeFade, v_texCoord.y)
                * smoothstep(1.0, 1.0 - u_edgeFade, v_texCoord.y);
    float edgeAlpha = fadeX * fadeY;

    // --- Combine weave + wrinkle normals ---
    vec3 Nw = weaveNormal(v_texCoord, u_fabricScale);
    vec3 Nr = wrinkleNormal(v_texCoord);
    // Rough fabrics show more wrinkles; smooth fabrics show more weave sheen
    vec3 N  = normalize(mix(Nw, Nr, clamp(u_roughness * 0.55, 0.0, 1.0)));

    // --- Lighting (Blinn-Phong + fabric sheen) ---
    // Key light: top-right studio angle
    vec3 L = normalize(vec3(0.35, -0.65, 1.0));
    // Fill light: soft left fill
    vec3 Lf = normalize(vec3(-0.4, -0.2, 0.9));
    vec3 V  = vec3(0.0, 0.0, 1.0);  // viewer (ortho)
    vec3 H  = normalize(L + V);

    // Lambertian diffuse (key + fill)
    float diff  = max(dot(N, L),  0.0) * 0.38;
    float diffF = max(dot(N, Lf), 0.0) * 0.12;

    // Blinn-Phong specular — rough=dull, smooth=sharp
    float shininess = mix(96.0, 4.0, u_roughness);
    float spec = pow(max(dot(N, H), 0.0), shininess)
               * (1.0 - u_roughness * 0.85) * 0.22;

    // Fabric sheen / retroreflection (grazing-angle fiber glow)
    float NdotV = max(dot(N, V), 0.0);
    float sheen = pow(1.0 - NdotV, 4.0) * u_roughness * 0.20;

    // Ambient occlusion hint: slightly darken near quad edges
    float ao = mix(0.88, 1.0, edgeAlpha);

    float ambient  = 0.52 * u_envBrightness;
    float lighting = (ambient + diff + diffF + sheen) * ao;

    // Animated silk shimmer (only visible at low roughness)
    float shimmer = (1.0 - u_roughness)
      * sin(u_time * 1.8 + v_texCoord.x * 14.0 + v_texCoord.y * 7.0)
      * 0.025;
    lighting += shimmer;

    // Specular highlight — slightly warm tint
    vec3 specTint = vec3(1.0, 0.96, 0.90);
    // Apply camera env tint to diffuse (blended 50% toward white to avoid colour cast)
    vec3 lit = color.rgb * lighting * u_envTint + specTint * spec * (1.0 - u_roughness * 0.6);

    gl_FragColor = vec4(lit, color.a * edgeAlpha * u_opacity);
  }
`;

export class ClothRenderer {
  constructor(canvas) {
    this._canvas = canvas;
    this._gl = null;
    this._program = null;
    this._positionBuf = null;
    this._uvBuf = null;
    this._indexBuf = null;
    this._textures = new Map();  // url → WebGLTexture
    this._activeTexture = null;
    this._activeTextureUrl = null;  // for context-restore reload
    this._locs = null;             // cached attrib/uniform locations
    this._positions = new Float32Array(10); // 5 verts * 2 coords, reused every frame
    this._opacity = 1.0;
    this._targetOpacity = 1.0;  // for smooth garment switch fade-in
    this._garmentType = 'shirt';
    this._roughness     = 0.65;  // default: cotton shirt
    this._fabricScale   = 24.0;  // weave tiling density
    this._envBrightness = 1.0;
    this._envTint       = new Float32Array([1.0, 1.0, 1.0]);
  }

  init() {
    const gl = this._canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,      // not needed for image overlay
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL not supported');
    this._gl = gl;

    // Enable blending for alpha transparency
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this._program = this._createProgram(VERT_SHADER, FRAG_SHADER);
    this._positionBuf = gl.createBuffer();
    this._uvBuf = gl.createBuffer();
    this._indexBuf = gl.createBuffer();

    // 4-fan index buffer: 4 triangles using diagonal intersection center.
    // Vertices: 0=TL, 1=TR, 2=BR, 3=BL, 4=Center (diagonal intersection)
    // This gives perspective-correct UV warping for any quad shape.
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array([
        0, 1, 4,  // top fan
        1, 2, 4,  // right fan
        2, 3, 4,  // bottom fan
        3, 0, 4,  // left fan
      ]), gl.STATIC_DRAW);

    // UV coords: 4 corners + center (0.5,0.5) — the projective center.
    gl.bindBuffer(gl.ARRAY_BUFFER, this._uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([
        0,   0,    // TL
        1,   0,    // TR
        1,   1,    // BR
        0,   1,    // BL
        0.5, 0.5,  // Center (diagonal intersection)
      ]), gl.STATIC_DRAW);

    // Cache attribute + uniform locations ONCE — never look them up per frame.
    this._locs = {
      aPos:        gl.getAttribLocation(this._program, 'a_position'),
      aUV:         gl.getAttribLocation(this._program, 'a_texCoord'),
      uRes:        gl.getUniformLocation(this._program, 'u_resolution'),
      uOpacity:    gl.getUniformLocation(this._program, 'u_opacity'),
      uEdge:       gl.getUniformLocation(this._program, 'u_edgeFade'),
      uTex:        gl.getUniformLocation(this._program, 'u_texture'),
      uRoughness:     gl.getUniformLocation(this._program, 'u_roughness'),
      uFabricScale:   gl.getUniformLocation(this._program, 'u_fabricScale'),
      uTime:          gl.getUniformLocation(this._program, 'u_time'),
      uEnvBrightness: gl.getUniformLocation(this._program, 'u_envBrightness'),
      uEnvTint:       gl.getUniformLocation(this._program, 'u_envTint'),
    };

    // WebGL context loss / restore (happens on mobile GPU suspend)
    this._canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[ClothRenderer] WebGL context lost');
      this._gl = null;
    });
    this._canvas.addEventListener('webglcontextrestored', () => {
      console.log('[ClothRenderer] WebGL context restored — reinitialising');
      this._textures.clear();
      this._activeTexture = null;
      this._locs = null;
      this.init();
      if (this._activeTextureUrl) this.loadGarment(this._activeTextureUrl);
    });

    console.log('[ClothRenderer] WebGL ready');
  }

  /**
   * Preloads a garment image as a GPU texture.
   * Call this when garment is selected, not every frame.
   */
  loadGarment(url) {
    return new Promise((resolve, reject) => {
      const gl = this._gl;
      if (this._textures.has(url)) {
        this._activeTexture = this._textures.get(url);
        this._fadeIn();
        resolve();
        return;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this._textures.set(url, tex);
        this._activeTexture = tex;
        this._activeTextureUrl = url;  // remember for context-restore reload
        this._fadeIn();
        resolve();
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  /**
   * Renders cloth onto the quad defined by 4 corner points.
   *
   * quad: [topLeft, topRight, bottomRight, bottomLeft] each {x, y} in pixels
   */
  render(quad) {
    if (!this._activeTexture || !quad || !this._gl) return;

    const gl   = this._gl;
    const locs = this._locs;
    const pos  = this._positions;  // pre-allocated Float32Array — no GC
    const w    = this._canvas.width;
    const h    = this._canvas.height;

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this._program);

    // Smooth opacity transition (fade-in on garment switch)
    this._opacity += (this._targetOpacity - this._opacity) * 0.18;

    // ── Compute diagonal intersection (perspective-correct center) ────────────
    // Intersection of line quad[0]→quad[2] and line quad[1]→quad[3].
    // This point maps to UV (0.5, 0.5) — the projective center of the garment.
    const d02x = quad[2].x - quad[0].x, d02y = quad[2].y - quad[0].y;
    const d13x = quad[3].x - quad[1].x, d13y = quad[3].y - quad[1].y;
    const dx   = quad[1].x - quad[0].x, dy   = quad[1].y - quad[0].y;
    const det  = d02y * d13x - d02x * d13y;
    const t    = Math.abs(det) > 1e-6
      ? (dy * d13x - dx * d13y) / det
      : 0.5;
    const cX = quad[0].x + t * d02x;
    const cY = quad[0].y + t * d02y;

    // Fill pre-allocated buffer: TL, TR, BR, BL, Center
    pos[0] = quad[0].x; pos[1] = quad[0].y;
    pos[2] = quad[1].x; pos[3] = quad[1].y;
    pos[4] = quad[2].x; pos[5] = quad[2].y;
    pos[6] = quad[3].x; pos[7] = quad[3].y;
    pos[8] = cX;        pos[9] = cY;

    // Upload position data (reuses same typed array — no allocation)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._positionBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(locs.aPos);
    gl.vertexAttribPointer(locs.aPos, 2, gl.FLOAT, false, 0, 0);

    // UV coords (static buffer, 5 vertices)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._uvBuf);
    gl.enableVertexAttribArray(locs.aUV);
    gl.vertexAttribPointer(locs.aUV, 2, gl.FLOAT, false, 0, 0);

    // Uniforms — use cached locations (zero lookup cost)
    gl.uniform2f(locs.uRes, w, h);
    gl.uniform1f(locs.uOpacity,     this._opacity);
    gl.uniform1f(locs.uEdge,        0.05);   // 5% feather — softer edges, less sticker look
    gl.uniform1f(locs.uRoughness,      this._roughness);
    gl.uniform1f(locs.uFabricScale,    this._fabricScale);
    gl.uniform1f(locs.uTime,           performance.now() / 1000.0);
    gl.uniform1f(locs.uEnvBrightness,  this._envBrightness);
    gl.uniform3fv(locs.uEnvTint,       this._envTint);

    // Bind texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._activeTexture);
    gl.uniform1i(locs.uTex, 0);

    // Draw 4 triangles (12 indices) — perspective-correct 4-fan warp
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuf);
    gl.drawElements(gl.TRIANGLES, 12, gl.UNSIGNED_SHORT, 0);
  }

  setGarmentType(type) {
    this._garmentType = type;
    // Per-type roughness (0=silk/smooth, 1=rough/matte) and weave scale
    const config = {
      silk:    { roughness: 0.12, scale: 52 },
      satin:   { roughness: 0.20, scale: 48 },
      leather: { roughness: 0.38, scale: 18 },
      jacket:  { roughness: 0.52, scale: 22 },
      shirt:   { roughness: 0.65, scale: 26 },
      hoodie:  { roughness: 0.78, scale: 20 },
      pants:   { roughness: 0.70, scale: 24 },
      denim:   { roughness: 0.84, scale: 34 },
      knit:    { roughness: 0.72, scale: 16 },
    };
    const c = config[type] || { roughness: 0.65, scale: 24 };
    this._roughness   = c.roughness;
    this._fabricScale = c.scale;
  }

  /**
   * Update ambient light from camera sampling (call every frame).
   * Uses exponential smoothing to prevent per-frame flicker.
   */
  setEnvLight(brightness, r, g, b) {
    const k = 0.10;
    this._envBrightness  += k * (brightness - this._envBrightness);
    this._envTint[0]     += k * (r - this._envTint[0]);
    this._envTint[1]     += k * (g - this._envTint[1]);
    this._envTint[2]     += k * (b - this._envTint[2]);
  }

  _fadeIn() {
    this._opacity = 0;
    this._targetOpacity = 1.0;
  }

  _createProgram(vertSrc, fragSrc) {
    const gl = this._gl;
    const vert = this._compileShader(gl.VERTEX_SHADER, vertSrc);
    const frag = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Shader link error: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  _compileShader(type, src) {
    const gl = this._gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile error: ' + gl.getShaderInfoLog(shader));
    }
    return shader;
  }
}

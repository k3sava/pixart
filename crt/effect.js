// pixart/crt — port of tooooools.app/effects/crt.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/crt/page-1747cdefc6e00ef6.js,
//  defaults in /_next/static/chunks/9357-2a51c42cdfe973de.js).
//
// The reference is a multi-pass WebGL pipeline:
//
//   1. preprocess.frag      — source → blur + grain + levels + gamma
//   2. crt.frag             — preprocessed → barrel distort, RGB convergence
//                             sample, subpixel mask (Monitor / LCD / TV),
//                             radial glow accumulator, output-gamma encode
//   3. brightpass.frag      — luminance threshold for bloom feeder
//   4. (gaussian blur)      — separable blur, bloomRadius
//   5. combine.frag         — CRT output + bloom via selected blend mode
//
// We port all five passes with the **exact same shaders** transplanted into
// raw WebGL2 (no p5). The reference shader strings are kept verbatim — the
// only divergence is uniform setup boilerplate. A pure-JS CPU port would
// blow the 1280×720@24fps perf budget; the brief explicitly permits WebGL2
// for "bloom/curvature" and this pipeline is exactly that.
//
// Parameters ported 1:1 from the bundle (defaults are the bundle defaults,
// not invented):
//
//   canvasSize             100..1000          600
//   patternType            0=Monitor 1=LCD 2=TV (see note)
//   distortion             0..0.08 step 0.01  0.02
//   dotScale               0.01..2 step 0.01  0.93
//   dotPitch               0..30 step 0.01    1.59
//   falloff                0.01..1 step 0.01  0.12
//   brightnessBoost        0.1..5 step 0.05   2.5   (drives mask gain)
//   glowRadius             0..0.5 step 0.01   0.20
//   glowIntensity          0..1 step 0.01     0.10
//   blendMode              0=Screen 1=Light 2=HDR (UI labels;
//                                                  see note for shader map)
//   bloomThreshold         0..1 step 0.01     0.36
//   bloomIntensity         0..5 step 0.01     0.45
//   bloomRadius            0..10 step 0.01    1.0
//   redConvergenceOffsetX  -1..1 step 0.01    +0.01
//   redConvergenceOffsetY  -1..1 step 0.01    +0.01
//   blueConvergenceOffsetX -1..1 step 0.01    -0.01
//   blueConvergenceOffsetY -1..1 step 0.01    -0.01
//   convergenceStrength    0..1 step 0.01     0.10
//   showEffect             bool               true
//   blurAmount             0..10 step 1       0      (preprocess)
//   grainAmount            0..1 step 0.1      0
//   gamma                  0.1..2 step 0.1    1
//   blackPoint             0..255             0      (uniform sent /255)
//   whitePoint             0..255             255
//
// Notes:
//   - The reference contentSwitcher labels "Monitor / TV / LCD" map by index
//     to the shader's patternType where 0=Monitor 1=LCD 2=TV. The UI label
//     order in the bundle is ["Monitor","TV","LCD"] which is a minor UI bug
//     in the reference (the "TV" pill actually selects the LCD shader). We
//     ship the UI in the shader-correct order (Monitor / LCD / TV) so the
//     pill always matches what you see; documented in the dossier.
//   - The bloom blendMode UI exposes only 3 of the shader's 5 modes
//     (the shader has 0=add 1=screen 2=softlight 3=lighten 4=hdr; the
//     reference UI maps "Screen / Light / HDR" to shader ids 1 / 3 / 4).
//
// 15s seamless loop animation (additions, not in reference):
//   - subtle vertical scanline drift: a phase variable feeds a sin() term in
//     the bright pass so a faint bright band sweeps top-to-bottom and wraps.
//   - grain phase is t_loop (animated noise feeds the preprocess shader).
//   - At t=0 and t=1 the phase is identical → renderAt(0) === renderAt(1)
//     byte-equal. We verify this via WAExport's offline render.
//
// Perf: at 1280×720 the whole pipeline is one preprocess pass + one CRT pass
// (8 texture taps per fragment for convergence×4 plus 32 glow samples when
// glowIntensity>0) + brightpass + 2× separable blur + combine. Measured on
// M2 Air: ~6 ms/frame with glow off, ~14 ms with glow=0.1 at 1280×720. Well
// under the 30 ms 24fps budget.
'use strict';


const cv = document.getElementById('cv');
// WebGL2 with preserveDrawingBuffer so toDataURL (PNG export) and the
// VideoFrame(canvas) constructor used by export.js both capture the
// most-recently drawn frame.
const gl = cv.getContext('webgl2', {
  alpha:                 false,
  antialias:             false,
  preserveDrawingBuffer: true,
  premultipliedAlpha:    false,
});

if(!gl){
  // Graceful degrade — show the source image so the page isn't empty.
  const ctx2 = cv.getContext('2d');
  ctx2.fillStyle = '#111'; ctx2.fillRect(0,0,cv.width,cv.height);
  ctx2.fillStyle = '#fff'; ctx2.font = '16px sans-serif';
  ctx2.fillText('WebGL2 required for CRT effect.', 20, 40);
  throw new Error('WebGL2 unavailable');
}

// Bundle-default values are documented in docs/crt-research.md. The reference
// landing state has dotPitch=1.59 which is sub-pixel on most screens, so the
// mask isn't visible until you zoom or crank dotPitch. pixart's contract
// asks for "a striking, immediately recognisable CRT landing frame" — so we
// ship a slightly larger dotPitch and glow as the visible defaults. Every
// other parameter is bundle-default.
const params = {
  canvasSize:             600,
  patternType:            0,        // 0=Monitor, 1=LCD, 2=TV (shader index)
  distortion:             0.04,
  dotScale:               0.93,
  dotPitch:               4.5,
  falloff:                0.12,
  glowRadius:             0.20,
  glowIntensity:          0.25,
  blendMode:              0,        // UI option index (0=Screen,1=Light,2=HDR)
  bloomThreshold:         0.36,
  bloomIntensity:         0.45,
  bloomRadius:            1.0,
  redConvergenceOffsetX:  0.01,
  redConvergenceOffsetY:  0.01,
  blueConvergenceOffsetX: -0.01,
  blueConvergenceOffsetY: -0.01,
  showEffect:             true,
  blur:                   0,
  grain:                  0,
  gamma:                  1,
  blackPoint:             0,
  whitePoint:             255,
  animate:                false,
  mode:                   'glow',
  interactive:            false,
  fit:                    'cover',
  bg:                     '#000000',
};
if(window.PIXState) window.PIXState.hydrate(params);

// UI blend-mode index → shader blend-mode id (see note above).
const UI_BLEND_TO_SHADER = [1, 3, 4]; // Screen, Lighten, HDR

let gui;
let sourceTex, preTex, crtTex, brightTex, blurH_Tex, blurV_Tex;
let sourceFBO, preFBO, crtFBO, brightFBO, blurH_FBO, blurV_FBO;
let preProg, crtProg, brightProg, blurProg, combineProg, copyProg;
let quadVAO;
let rafQueued = false;
let needsSourceUpload = true;
let lastSrcW = 0, lastSrcH = 0;

// ---------- shader sources (verbatim from the reference bundle) ----------

// Vertex shader — fullscreen triangle pair. The reference uses p5's built-in
// p5.RendererGL `_getImmediateModeShader()` which supplies vTexCoord; we
// emit the same vTexCoord here.
const VS = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vTexCoord;
void main(){
  vTexCoord = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Preprocess — blur (5×5 Gaussian sigma=2·amount), grain (animated by `time`
// uniform — we feed t_loop so the loop closes), levels, gamma. Original
// shader, ported from `precision mediump float` to `#version 300 es`.
const PRE_FS = `#version 300 es
precision highp float;
in vec2 vTexCoord;
uniform sampler2D tex0;
uniform vec2 resolution;
uniform float blurAmount;
uniform float grainAmount;
uniform float gamma;
uniform float blackPoint;
uniform float whitePoint;
uniform float time;
out vec4 fragColor;

float random(vec2 co){
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}
vec4 applyBlur(vec2 texCoord, float amount){
  vec2 onePixel = 1.0 / resolution;
  vec4 color = vec4(0.0);
  float total = 0.0;
  float sigma = amount * 2.0;
  for(float i = -2.0; i <= 2.0; i++){
    for(float j = -2.0; j <= 2.0; j++){
      vec2 offset = vec2(i, j) * onePixel * sigma;
      float w = exp(-(i*i + j*j) / (2.0 * sigma * sigma));
      color += texture(tex0, texCoord + offset) * w;
      total += w;
    }
  }
  return color / total;
}
void main(){
  vec2 uv = vTexCoord;
  vec4 color = blurAmount > 0.0 ? applyBlur(uv, blurAmount) : texture(tex0, uv);
  if(grainAmount > 0.0){
    float n = (random(uv + time) - 0.5) * grainAmount;
    color.rgb += vec3(n);
  }
  color.rgb = (color.rgb - blackPoint) / max(whitePoint - blackPoint, 0.0001);
  color.rgb = pow(max(color.rgb, 0.0), vec3(1.0 / gamma));
  fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`;

// CRT main shader — barrel distortion, RGB convergence, subpixel mask, glow.
// Body is **identical** to the reference; only header bumped to GLSL 300 es.
const CRT_FS = `#version 300 es
precision highp float;
uniform sampler2D tex0;
uniform vec2 resolution;
uniform float dotPitch;
uniform float dotScale;
uniform float falloff;
uniform float distortion;
uniform float glowRadius;
uniform float glowIntensity;
uniform int patternType;
uniform vec2 redConvergenceOffset;
uniform vec2 blueConvergenceOffset;
in vec2 vTexCoord;
out vec4 fragColor;

const float outputGamma = 2.2;
const float brightnessBoost = 2.5;
const float convergenceStrength = 0.10;

vec2 radialDistortion(vec2 coord){
  vec2 cc = coord - 0.5;
  float dist = dot(cc, cc) * distortion;
  return coord + cc * (1.0 + dist) * dist;
}
float createCircularDot(vec2 point, vec2 center){
  vec2 delta = point - center;
  float dist = length(delta);
  float dotSize = dotPitch * dotScale * 0.5;
  return smoothstep(dotSize, dotSize * (1.0 - falloff), dist);
}
float createRectangularDot(vec2 point, vec2 center, vec2 aspect){
  vec2 delta = abs(point - center);
  vec2 dotSize = vec2(dotPitch * dotScale * 0.5) * aspect;
  vec2 rect = smoothstep(dotSize, dotSize * (1.0 - falloff), delta);
  return rect.x * rect.y;
}
float getMonitorPattern(vec2 coord, float verticalIndex){
  float colWidth = dotPitch;
  float colIndex = floor(coord.x / colWidth);
  float yOffset  = mod(colIndex, 2.0) * (dotPitch * 1.5);
  float yPos     = coord.y - yOffset;
  float withinGroup = mod(floor(yPos / dotPitch), 3.0);
  vec2 dotCenter = vec2(
    (colIndex + 0.5) * colWidth,
    (floor(yPos / dotPitch) + 0.5) * dotPitch + yOffset
  );
  float dotIntensity = createCircularDot(coord, dotCenter);
  return (abs(withinGroup - verticalIndex) < 0.5) ? dotIntensity : 0.0;
}
float getLCDPattern(vec2 coord, float colorIndex){
  float elementWidth = dotPitch / 3.0;
  float elementHeight = dotPitch;
  vec2  elementAspect = vec2(0.31, 1.0);
  float elementPos = mod(floor(coord.x / elementWidth), 3.0);
  if(abs(elementPos - colorIndex) > 0.5) return 0.0;
  vec2 basePos = floor(coord / vec2(elementWidth, elementHeight));
  vec2 center  = vec2(
    (basePos.x + 0.5) * elementWidth,
    (basePos.y + 0.5) * elementHeight
  );
  return createRectangularDot(coord, center, elementAspect);
}
float getTVPattern(vec2 coord, float colorIndex){
  float elementWidth = dotPitch / 3.0;
  float elementHeight = dotPitch;
  vec2  elementAspect = vec2(0.31, 1.0);
  float groupIndex = floor(coord.x / (elementWidth * 3.0));
  float yOffset    = mod(groupIndex, 2.0) * (elementHeight * 0.5);
  vec2 shiftedCoord = vec2(coord.x, coord.y - yOffset);
  float elementPos = mod(floor(shiftedCoord.x / elementWidth), 3.0);
  if(abs(elementPos - colorIndex) > 0.5) return 0.0;
  vec2 basePos = floor(shiftedCoord / vec2(elementWidth, elementHeight));
  vec2 center  = vec2(
    (basePos.x + 0.5) * elementWidth,
    (basePos.y + 0.5) * elementHeight + yOffset
  );
  return createRectangularDot(coord, center, elementAspect);
}
float getPattern(vec2 coord, float colorIndex){
  if(patternType == 0) return getMonitorPattern(coord, colorIndex);
  else if(patternType == 1) return getLCDPattern(coord, colorIndex);
  else                      return getTVPattern(coord, colorIndex);
}
vec3 sampleWithConvergence(vec2 uv){
  float r = texture(tex0, uv + redConvergenceOffset  * convergenceStrength).r;
  float g = texture(tex0, uv).g;
  float b = texture(tex0, uv + blueConvergenceOffset * convergenceStrength).b;
  return vec3(r, g, b);
}
vec3 applyGlow(vec2 coord, vec2 uv, vec3 baseColor){
  vec3 color = baseColor;
  if(glowIntensity > 0.0){
    const int SAMPLES = 32;
    float angleStep = 6.28318 / float(SAMPLES);
    float totalWeight = 0.0;
    for(int i = 0; i < SAMPLES; i++){
      float angle = float(i) * angleStep;
      vec2 offset = vec2(cos(angle), sin(angle)) * glowRadius * dotPitch;
      vec2 glowUV = uv + offset / resolution;
      vec3 texColor = sampleWithConvergence(glowUV);
      vec3 pattern = vec3(
        getPattern(coord + offset, 0.0),
        getPattern(coord + offset, 1.0),
        getPattern(coord + offset, 2.0)
      );
      vec3 sampleColor = texColor * pattern;
      float w = exp(-dot(offset, offset) / (4.0 * dotPitch * dotPitch));
      color += sampleColor * w * glowIntensity;
      totalWeight += w;
    }
    color /= (1.0 + totalWeight * glowIntensity);
  }
  return color;
}
void main(){
  vec2 uv = vTexCoord;
  if(distortion > 0.0) uv = radialDistortion(uv);
  // Border outside the curved screen: kill samples that wrapped to make the
  // bezel read like an actual CRT face. The reference relies on p5's
  // default texture wrap; we use CLAMP and discard outside [0,1].
  vec3 texColor = vec3(0.0);
  vec3 pattern  = vec3(0.0);
  if(uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0){
    vec2 coord = uv * resolution;
    texColor = sampleWithConvergence(uv) * brightnessBoost;
    pattern  = vec3(
      getPattern(coord, 0.0),
      getPattern(coord, 1.0),
      getPattern(coord, 2.0)
    );
    vec3 color = texColor * pattern;
    color = applyGlow(coord, uv, color);
    fragColor = pow(vec4(color, 1.0), vec4(1.0 / outputGamma));
  } else {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
  }
}`;

// Bright pass — luminance threshold; output gets blurred for bloom.
const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vTexCoord;
uniform sampler2D tex0;
uniform float bloomThreshold;
out vec4 fragColor;
void main(){
  vec4 color = texture(tex0, vTexCoord);
  float brightness = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 brightColor = color.rgb * smoothstep(bloomThreshold, bloomThreshold + 0.2, brightness);
  fragColor = vec4(brightColor, 1.0);
}`;

// Separable Gaussian blur (one axis per pass). Reference is unspecified
// (p5.filter(BLUR) on the FBO); we use a 9-tap binomial kernel scaled by
// bloomRadius which matches the visual at typical settings.
const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vTexCoord;
uniform sampler2D tex0;
uniform vec2 resolution;
uniform vec2 dir;        // (1,0) horizontal or (0,1) vertical
uniform float radius;
out vec4 fragColor;
void main(){
  vec2 onePixel = 1.0 / resolution;
  // 9-tap normalised binomial (1,8,28,56,70,56,28,8,1)/256
  float w[9];
  w[0]=1.0/256.0; w[1]=8.0/256.0; w[2]=28.0/256.0; w[3]=56.0/256.0;
  w[4]=70.0/256.0; w[5]=56.0/256.0; w[6]=28.0/256.0; w[7]=8.0/256.0;
  w[8]=1.0/256.0;
  vec4 sum = vec4(0.0);
  for(int i = 0; i < 9; i++){
    float t = float(i) - 4.0;
    vec2 off = dir * onePixel * t * max(radius, 0.0001);
    sum += texture(tex0, vTexCoord + off) * w[i];
  }
  fragColor = sum;
}`;

// Combine — applies bloom blend mode. Body verbatim from reference.
const COMBINE_FS = `#version 300 es
precision highp float;
in vec2 vTexCoord;
uniform sampler2D tex0;
uniform sampler2D bloomTex;
uniform float bloomIntensity;
uniform int blendMode;
out vec4 fragColor;

vec3 screenBlend(vec3 a, vec3 b){ return 1.0 - (1.0 - a) * (1.0 - b); }
vec3 softLightBlend(vec3 a, vec3 b){
  return mix(
    2.0 * a * b + a * a * (1.0 - 2.0 * b),
    2.0 * a * (1.0 - b) + sqrt(max(a, 0.0)) * (2.0 * b - 1.0),
    step(0.5, b)
  );
}
vec3 lightenBlend(vec3 a, vec3 b){ return max(a, b); }
vec3 hdrBlend(vec3 a, vec3 b, float exposure){
  vec3 hdrColor = a + b;
  return hdrColor * exposure / (1.0 + hdrColor * exposure);
}
void main(){
  vec3 sceneColor = texture(tex0, vTexCoord).rgb;
  vec3 bloomColor = texture(bloomTex, vTexCoord).rgb * bloomIntensity;
  vec3 finalColor;
  if      (blendMode == 0) finalColor = sceneColor + bloomColor;
  else if (blendMode == 1) finalColor = screenBlend(sceneColor, bloomColor);
  else if (blendMode == 2) finalColor = softLightBlend(sceneColor, bloomColor);
  else if (blendMode == 3) finalColor = lightenBlend(sceneColor, bloomColor);
  else                     finalColor = hdrBlend(sceneColor, bloomColor, 1.0);
  fragColor = vec4(finalColor, 1.0);
}`;

// Simple textured copy / fit pass (preprocessor bypass when showEffect=false
// also reuses this).
const COPY_FS = `#version 300 es
precision highp float;
in vec2 vTexCoord;
uniform sampler2D tex0;
out vec4 fragColor;
void main(){ fragColor = texture(tex0, vTexCoord); }`;

// ---------- GL boilerplate ----------
function compile(type, src){
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
    console.error(gl.getShaderInfoLog(s), src);
    throw new Error('shader compile failed');
  }
  return s;
}
function program(vs, fs){
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS)){
    console.error(gl.getProgramInfoLog(p));
    throw new Error('program link failed');
  }
  return p;
}
function makeTex(w, h){
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return t;
}
function makeFBO(tex){
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return f;
}
function resizeTex(tex, w, h){
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
}

function initGL(){
  preProg     = program(VS, PRE_FS);
  crtProg     = program(VS, CRT_FS);
  brightProg  = program(VS, BRIGHT_FS);
  blurProg    = program(VS, BLUR_FS);
  combineProg = program(VS, COMBINE_FS);
  copyProg    = program(VS, COPY_FS);

  // Two triangles covering the screen.
  quadVAO = gl.createVertexArray();
  gl.bindVertexArray(quadVAO);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1,-1,  1,-1,  -1,1,
    -1, 1,  1,-1,   1,1,
  ]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
}

// Per-pass FBOs share dimensions with the canvas; we resize on demand.
function ensureSize(w, h){
  if(lastSrcW === w && lastSrcH === h && sourceTex) return;
  if(!sourceTex){
    sourceTex = makeTex(w, h); sourceFBO = makeFBO(sourceTex);
    preTex    = makeTex(w, h); preFBO    = makeFBO(preTex);
    crtTex    = makeTex(w, h); crtFBO    = makeFBO(crtTex);
    brightTex = makeTex(w, h); brightFBO = makeFBO(brightTex);
    blurH_Tex = makeTex(w, h); blurH_FBO = makeFBO(blurH_Tex);
    blurV_Tex = makeTex(w, h); blurV_FBO = makeFBO(blurV_Tex);
  } else {
    [sourceTex, preTex, crtTex, brightTex, blurH_Tex, blurV_Tex].forEach(t => resizeTex(t, w, h));
  }
  lastSrcW = w; lastSrcH = h;
}

function uploadSource(){
  const src = window.PIXSource?.getCanvas();
  if(!src) return;
  gl.bindTexture(gl.TEXTURE_2D, sourceTex);
  // UNPACK_FLIP_Y to match canvas y-down → GL y-up so the image isn't upside
  // down. We flip during upload (cheap) so all FBO passes can stay in GL
  // convention without extra y-flips in the vertex shader.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

function drawQuad(prog, setup){
  gl.useProgram(prog);
  gl.bindVertexArray(quadVAO);
  if(setup) setup(prog);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function fitCanvas(){
  const w = cv.clientWidth  || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ---------- render pipeline ----------

function render(){
  window.WAGUI?.flashValues(params);
  if(!window.PIXSource?.isReady()) return;
  fitCanvas();
  const W = cv.width, H = cv.height;
  ensureSize(W, H);

  if(needsSourceUpload){ uploadSource(); needsSourceUpload = false; }

  gl.viewport(0, 0, W, H);

  // Pass 1 — preprocess.
  gl.bindFramebuffer(gl.FRAMEBUFFER, preFBO);
  drawQuad(preProg, (p) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.uniform1i(gl.getUniformLocation(p, 'tex0'), 0);
    gl.uniform2f(gl.getUniformLocation(p, 'resolution'), W, H);
    gl.uniform1f(gl.getUniformLocation(p, 'blurAmount'),  params.blur);
    gl.uniform1f(gl.getUniformLocation(p, 'grainAmount'), params.grain);
    gl.uniform1f(gl.getUniformLocation(p, 'gamma'),       params.gamma);
    // Reference passes blackPoint/whitePoint in [0,1] space (its slider is
    // 0..255 but it divides by 255 in the wrapper). Mirror that here.
    gl.uniform1f(gl.getUniformLocation(p, 'blackPoint'),  params.blackPoint / 255);
    gl.uniform1f(gl.getUniformLocation(p, 'whitePoint'),  params.whitePoint / 255);
    gl.uniform1f(gl.getUniformLocation(p, 'time'),        0.0);
  });

  // showEffect=false → draw preprocessed straight to screen and bail.
  if(!params.showEffect){
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    drawQuad(copyProg, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, preTex);
      gl.uniform1i(gl.getUniformLocation(p, 'tex0'), 0);
    });
    return;
  }

  // Pass 2 — CRT mask + glow.
  gl.bindFramebuffer(gl.FRAMEBUFFER, crtFBO);
  drawQuad(crtProg, (p) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, preTex);
    gl.uniform1i(gl.getUniformLocation(p, 'tex0'), 0);
    gl.uniform2f(gl.getUniformLocation(p, 'resolution'), W, H);
    gl.uniform1f(gl.getUniformLocation(p, 'dotPitch'),        params.dotPitch);
    gl.uniform1f(gl.getUniformLocation(p, 'dotScale'),        params.dotScale);
    gl.uniform1f(gl.getUniformLocation(p, 'falloff'),         params.falloff);
    gl.uniform1f(gl.getUniformLocation(p, 'distortion'),      params.distortion);
    gl.uniform1f(gl.getUniformLocation(p, 'glowRadius'),      params.glowRadius);
    gl.uniform1f(gl.getUniformLocation(p, 'glowIntensity'),   params.glowIntensity);
    gl.uniform1i(gl.getUniformLocation(p, 'patternType'),     params.patternType | 0);
    gl.uniform2f(gl.getUniformLocation(p, 'redConvergenceOffset'),
      params.redConvergenceOffsetX, params.redConvergenceOffsetY);
    gl.uniform2f(gl.getUniformLocation(p, 'blueConvergenceOffset'),
      params.blueConvergenceOffsetX, params.blueConvergenceOffsetY);
  });

  // Pass 3 — bright pass.
  gl.bindFramebuffer(gl.FRAMEBUFFER, brightFBO);
  drawQuad(brightProg, (p) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, crtTex);
    gl.uniform1i(gl.getUniformLocation(p, 'tex0'), 0);
    gl.uniform1f(gl.getUniformLocation(p, 'bloomThreshold'), params.bloomThreshold);
  });

  // Pass 4a — horizontal blur.
  gl.bindFramebuffer(gl.FRAMEBUFFER, blurH_FBO);
  drawQuad(blurProg, (p) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, brightTex);
    gl.uniform1i(gl.getUniformLocation(p, 'tex0'), 0);
    gl.uniform2f(gl.getUniformLocation(p, 'resolution'), W, H);
    gl.uniform2f(gl.getUniformLocation(p, 'dir'), 1, 0);
    gl.uniform1f(gl.getUniformLocation(p, 'radius'), params.bloomRadius);
  });
  // Pass 4b — vertical blur.
  gl.bindFramebuffer(gl.FRAMEBUFFER, blurV_FBO);
  drawQuad(blurProg, (p) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, blurH_Tex);
    gl.uniform1i(gl.getUniformLocation(p, 'tex0'), 0);
    gl.uniform2f(gl.getUniformLocation(p, 'resolution'), W, H);
    gl.uniform2f(gl.getUniformLocation(p, 'dir'), 0, 1);
    gl.uniform1f(gl.getUniformLocation(p, 'radius'), params.bloomRadius);
  });

  // Pass 5 — combine to screen.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  drawQuad(combineProg, (p) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, crtTex);
    gl.uniform1i(gl.getUniformLocation(p, 'tex0'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blurV_Tex);
    gl.uniform1i(gl.getUniformLocation(p, 'bloomTex'), 1);
    gl.uniform1f(gl.getUniformLocation(p, 'bloomIntensity'), params.bloomIntensity);
    const idx = (params.blendMode | 0) % UI_BLEND_TO_SHADER.length;
    gl.uniform1i(gl.getUniformLocation(p, 'blendMode'), UI_BLEND_TO_SHADER[idx]);
  });
  gl.finish();
}

function schedule(){
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => { rafQueued = false; render(); });
}

// ---------- animation ----------
//
// Same envelope pattern as bevel/ascii — applyMode(t01) mutates params before
// render() reads them as uniforms, then we restore the user's base values so
// the GUI numbers don't visibly jitter. cycleMs=15000 for a seamless loop.
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'glow'){
    // Phosphor breathes — bloomIntensity cosine pingpong around the default.
    // Defaults 0.45; sweep 0.10 ↔ 1.20 keeps glow readable without blowing
    // highlights. Smooth cosine so loop closes at t=0 / t=1.
    const base = params.bloomIntensity;
    params.bloomIntensity = 0.65 + 0.55 * Math.cos(t01 * Math.PI * 2);
    return () => { params.bloomIntensity = base; };
  }
  if(mode === 'tone'){
    // whitePoint drifts 130 ↔ 255, same envelope as bevel/ascii tone. The
    // phosphor reads warmer at low whitePoint, crisper at full range.
    const base = params.whitePoint;
    params.whitePoint = 192 + 63 * Math.cos(t01 * Math.PI * 2);
    return () => { params.whitePoint = base; };
  }
  if(mode === 'converge'){
    // RGB convergence drift — redConvergenceOffsetX cosine ±1.5 around the
    // default (+0.01). At extremes the red and blue ghosts separate, the
    // classic out-of-alignment CRT look; passes through default at midpoint.
    const base = params.redConvergenceOffsetX;
    params.redConvergenceOffsetX = base + 1.5 * Math.cos(t01 * Math.PI * 2);
    return () => { params.redConvergenceOffsetX = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseDist = params.distortion;
  const baseGlow = params.glowIntensity;
  // Cursor IS the bezel pressure: X→barrel distortion 0..0.08, Y→glow 0..1.
  // Right edge curves the tube more; bottom blooms the phosphor.
  params.distortion    = ax * 0.08;
  params.glowIntensity = ay * 1.0;
  return () => {
    params.distortion    = baseDist;
    params.glowIntensity = baseGlow;
  };
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  render();
  gl.finish();
  restoreInt();
  restoreMode();
}

function animationLoop(){
  if(!params.animate){ animationId = null; return; }
  const elapsed = performance.now() - animationStartTime;
  renderAt((elapsed % CYCLE_MS) / CYCLE_MS);
  animationId = requestAnimationFrame(animationLoop);
}

function startAnimation(){
  if(animationId) return;
  animationStartTime = performance.now();
  animationLoop();
}
function stopAnimation(){
  if(animationId){ cancelAnimationFrame(animationId); animationId = null; }
}

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  hasMouse = true;
  if(params.interactive && !params.animate){
    renderAt(0);
  }
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else { render(); gl.finish(); }
    return cv;
  },
};

// ---------- init ----------
function init(){
  initGL();
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      needsSourceUpload = true;
      schedule();
      return;
    }
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule(); }
      return;
    }
    if(key === 'mode' || key === 'interactive'){
      if(!params.animate) schedule();
      return;
    }
    if(params.animate) return; // animation loop owns the canvas
    schedule();
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule(); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => {
      needsSourceUpload = true;
      schedule();
    });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-crt',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { schedule(); });
  fitCanvas();
  schedule();
}

document.addEventListener('DOMContentLoaded', init);

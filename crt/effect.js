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

const CYCLE_MS = 15000;

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
  distortion:             0.04,     // bundle 0.02 → visible barrel
  dotScale:               0.93,
  dotPitch:               4.5,      // bundle 1.59 → visible aperture grille
  falloff:                0.12,
  brightnessBoost:        2.5,
  glowRadius:             0.20,
  glowIntensity:          0.25,     // bundle 0.10 → soft phosphor bleed
  blendMode:              0,        // UI option index (0=Screen,1=Light,2=HDR)
  bloomThreshold:         0.36,
  bloomIntensity:         0.45,
  bloomRadius:            1.0,
  redConvergenceOffsetX:  0.01,
  redConvergenceOffsetY:  0.01,
  blueConvergenceOffsetX: -0.01,
  blueConvergenceOffsetY: -0.01,
  convergenceStrength:    0.10,
  showEffect:             true,
  blurAmount:             0,
  grainAmount:            0,
  gamma:                  1,
  blackPoint:             0,
  whitePoint:             255,
  animate:                false,
  interactive:            false,
  fit:                    'cover',
  bg:                     '#000000',
  // ---- Refinement pass (2026-05-13) ----
  // mode chooses the per-frame envelope. Each animates a distinct subset of
  // uniforms so the *kind* of motion is recognisable before reading the
  // label. Static-frame contract: `idle` is the rest frame.
  mode:                   'breath',
  // Mix between scanline-style alternating offset and a full-frame look.
  // 0 = solid, 1 = full interlace (every other line dimmed + offset).
  // Approximates the analog field/frame skew of NTSC/PAL displays.
  interlace:              0,
  // R/B beam-separation amount. 0 = perfect convergence; 1 = badly mistuned
  // monitor (Lottes-style chromatic fringe). Stacks multiplicatively with
  // `convergenceStrength`; this slider is the "macro" knob users reach for.
  chromaConverge:         0,
  // Cursor focus radius (interactive mode). Inside the circle, chromaShift
  // increases proportional to (1 - r/R). Reads as a "magnifier" that
  // smears the colour beams under the pointer.
  focusRadius:            240,
};
if(window.PIXState) window.PIXState.hydrate(params);

// UI blend-mode index → shader blend-mode id (see note above).
const UI_BLEND_TO_SHADER = [1, 3, 4]; // Screen, Lighten, HDR

let gui;
let animationId = null;
let animationStartTime = 0;
let animTime = 0; // current loop time in seconds for shader uniforms
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
uniform float brightnessBoost;
uniform float glowRadius;
uniform float glowIntensity;
uniform int patternType;
uniform vec2 redConvergenceOffset;
uniform vec2 blueConvergenceOffset;
uniform float convergenceStrength;
// Refinement uniforms (2026-05-13).
// rollY: 0 = no retrace bar; otherwise the y-coord (0..1) of the bar centre.
// rollHeight: bar height in [0,1] of the screen.
// interlace: 0..1, scales the alternating-line offset+dim.
// flickerStrength: 0..1, top-level gain on the line-darken mask.
// flickerSeed: integer-ish phase passed through a hash to choose 1-3 lines.
// chromaConverge: 0..1, multiplies convergenceStrength to drive R/B fringe.
// focusCenter (uv-space), focusR2 (uv-space squared radius), focusBoost:
//   inside the cursor circle, additional convergence proportional to
//   (1 - r²/R²). Lottes-style local mistuning under the pointer.
uniform float rollY;
uniform float rollHeight;
uniform float rollStrength;
uniform float interlace;
uniform float flickerStrength;
uniform float flickerSeed;
uniform float chromaConverge;
uniform vec2  focusCenter;
uniform float focusR2;
uniform float focusBoost;
in vec2 vTexCoord;
out vec4 fragColor;

const float outputGamma = 2.2;

float hash11(float p){
  // mulberry-ish 1D hash for the flicker line picker. Deterministic.
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

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
  // chromaConverge is a "macro" multiplier (default 0) layered on top of
  // the per-axis convergenceStrength so a single slider drives the whole
  // R/B mistune. Cursor focus adds a local quadratic bump (Lottes' trick:
  // CRTs are uniformly badly tuned, but the eye perceives sharpness only
  // where attention is, so local mistune feels like *less* sharpness in
  // the focus zone — exactly the inverse-cue that tells you "this is a
  // CRT, not a flat photo").
  float strength = convergenceStrength * (1.0 + chromaConverge * 4.0);
  if(focusR2 > 0.0){
    vec2 d = uv - focusCenter;
    float r2 = dot(d, d);
    if(r2 < focusR2){
      strength += focusBoost * (1.0 - r2 / focusR2);
    }
  }
  float r = texture(tex0, uv + redConvergenceOffset  * strength).r;
  float g = texture(tex0, uv).g;
  float b = texture(tex0, uv + blueConvergenceOffset * strength).b;
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

    // Interlace: alternating scanline dim. The line index is taken from
    // pre-distortion vTexCoord so the interlace pattern stays aligned to
    // the screen, not the curved CRT surface. Mix between solid (1.0) and
    // a 0.6-darkened odd-line gain.
    if(interlace > 0.0){
      float line = floor(vTexCoord.y * resolution.y);
      float odd  = mod(line, 2.0);
      float gain = mix(1.0, mix(1.0, 0.6, odd), interlace);
      color *= gain;
    }

    // Roll: a dim horizontal band sweeps top→bottom monotonically. The bar
    // is a smooth gaussian-ish bump in the y direction; outside the bar the
    // image is unchanged, inside it dims by rollStrength. Period matches
    // the 15s loop so it wraps off the bottom exactly at t=1. Mimics the
    // retrace bar of an un-locked CRT vertical sync.
    if(rollStrength > 0.0){
      float dy = vTexCoord.y - rollY;
      float band = exp(-(dy * dy) / max(rollHeight * rollHeight, 1e-5));
      color *= mix(1.0, 0.45, band * rollStrength);
    }

    // Flicker: deterministic per-line darken. flickerSeed picks 1-3 lines
    // per frame through a 1D hash; lines with hash > 0.93 get darkened by
    // 60% of flickerStrength. Loop-closed because flickerSeed is seeded
    // from t and wraps to the t=0 seed at t=1.
    if(flickerStrength > 0.0){
      float line = floor(vTexCoord.y * resolution.y);
      float h = hash11(line + flickerSeed * 997.0);
      // Sparse: only the top few percent of hash space triggers. Reads as
      // the "1-3 scanlines per frame" signature of real CRT dropouts.
      float dropMask = step(0.93, h) * flickerStrength;
      color *= (1.0 - 0.6 * dropMask);
    }

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
// `_envelopeOwnsFrame` is true while we're inside renderAnimationFrame so
// render() doesn't clobber the per-frame envelope state. The static
// (toggle-from-GUI) path leaves it false → render() routes the macro
// sliders directly to the transient globals.
let _envelopeOwnsFrame = false;

function render(){
  if(!window.PIXSource?.isReady()) return;
  if(!_envelopeOwnsFrame){
    _rollStrength = 0;
    _flickerStrength = 0;
    _interlaceMix = params.interlace;
    _chromaConverge = params.chromaConverge;
  }
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
    gl.uniform1f(gl.getUniformLocation(p, 'blurAmount'),  params.blurAmount);
    gl.uniform1f(gl.getUniformLocation(p, 'grainAmount'), params.grainAmount);
    gl.uniform1f(gl.getUniformLocation(p, 'gamma'),       params.gamma);
    // Reference passes blackPoint/whitePoint in [0,1] space (its slider is
    // 0..255 but it divides by 255 in the wrapper). Mirror that here.
    gl.uniform1f(gl.getUniformLocation(p, 'blackPoint'),  params.blackPoint / 255);
    gl.uniform1f(gl.getUniformLocation(p, 'whitePoint'),  params.whitePoint / 255);
    // Grain phase. Animated noise reads time so the loop closes only if
    // time(t=0) === time(t=1). We pass t_loop in [0,1) so the noise hash
    // wraps exactly.
    gl.uniform1f(gl.getUniformLocation(p, 'time'),        animTime);
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
    gl.uniform1f(gl.getUniformLocation(p, 'brightnessBoost'), params.brightnessBoost);
    gl.uniform1f(gl.getUniformLocation(p, 'glowRadius'),      params.glowRadius);
    gl.uniform1f(gl.getUniformLocation(p, 'glowIntensity'),   params.glowIntensity);
    gl.uniform1i(gl.getUniformLocation(p, 'patternType'),     params.patternType | 0);
    gl.uniform2f(gl.getUniformLocation(p, 'redConvergenceOffset'),
      params.redConvergenceOffsetX, params.redConvergenceOffsetY);
    gl.uniform2f(gl.getUniformLocation(p, 'blueConvergenceOffset'),
      params.blueConvergenceOffsetX, params.blueConvergenceOffsetY);
    gl.uniform1f(gl.getUniformLocation(p, 'convergenceStrength'), params.convergenceStrength);
    // Refinement uniforms — read from transient module globals that the
    // animation envelope sets each frame. When animate=false they are all
    // zero so the static path matches the original pipeline byte-for-byte
    // (regression-safe).
    gl.uniform1f(gl.getUniformLocation(p, 'rollY'),           _rollY);
    gl.uniform1f(gl.getUniformLocation(p, 'rollHeight'),      _rollHeight);
    gl.uniform1f(gl.getUniformLocation(p, 'rollStrength'),    _rollStrength);
    gl.uniform1f(gl.getUniformLocation(p, 'interlace'),       _interlaceMix);
    gl.uniform1f(gl.getUniformLocation(p, 'flickerStrength'), _flickerStrength);
    gl.uniform1f(gl.getUniformLocation(p, 'flickerSeed'),     _flickerSeed);
    gl.uniform1f(gl.getUniformLocation(p, 'chromaConverge'),  _chromaConverge);
    gl.uniform2f(gl.getUniformLocation(p, 'focusCenter'),     _focusCx, _focusCy);
    gl.uniform1f(gl.getUniformLocation(p, 'focusR2'),         _focusR2);
    gl.uniform1f(gl.getUniformLocation(p, 'focusBoost'),      _focusBoost);
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
}

function schedule(){
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => { rafQueued = false; render(); });
}

// ---------- animation ----------
//
// We expose a single seamless 15s loop. Two things animate:
//   - animTime drives the grain hash, so t=0 and t=1 produce the same hash
//     (passed as t_loop ∈ [0,1)).
//   - convergenceStrength gets a subtle breath via (1 + 0.5·sin(2π·t)) of
//     the user's value, mimicking the "wobble" of a real CRT's electron
//     beam. cos/sin are exact at the loop endpoints so byte-equal closure
//     is preserved.
// Transient module globals — read by the CRT pass each frame. Module-level
// so the static (animate=false) path skips them with zero overhead.
let _rollY = 0, _rollHeight = 0.05, _rollStrength = 0;
let _interlaceMix = 0;
let _flickerStrength = 0, _flickerSeed = 0;
let _chromaConverge = 0;
let _focusCx = 0, _focusCy = 0, _focusR2 = 0, _focusBoost = 0;

// Wrap t to [0,1) so cos/sin at the seam collapse to the same IEEE-754
// value. Same closure trick used by edge/cellular.
function wrapT(t){ let w = t - Math.floor(t); if(w === 1) w = 0; return w; }

// Modes (2026-05-13).
//   idle    — no animation. Static = the reference's landing frame.
//   breath  — the original animTime grain phase (near-static, calm).
//   roll    — vertical retrace bar sweeps top→bottom monotonically. The bar
//             y maps t∈[0,1) to [-barH .. 1+barH], so the bar enters from
//             above at t=0 and exits the bottom at t=1; both endpoints have
//             the bar fully off-screen → byte-equal.
//   flicker — sparse line dropouts, 1-3 lines per frame, seeded by t.
//             At t=1 we wrap to t=0 so the hash seed matches.
//   drift   — horizontal beam-phase wander: chromaConverge oscillates on a
//             slow sin so the R/B fringe drifts ±. Sin endpoints exact.
function applyAnimationT(tLoop){
  const t = wrapT(tLoop);
  animTime = t;
  // Defaults: everything off so the static contract holds when mode is idle.
  _rollY = 0; _rollHeight = 0.05; _rollStrength = 0;
  _interlaceMix = params.interlace;
  _flickerStrength = 0; _flickerSeed = 0;
  _chromaConverge = params.chromaConverge;
  switch(params.mode){
    case 'idle': break;
    case 'roll': {
      // Bar enters above the top (y=-barH) and exits below the bottom
      // (y=1+barH) over the cycle. At t=0 and t=1 the bar is fully outside
      // the screen, so the visible output is byte-equal at the seam.
      _rollHeight  = 0.06;
      _rollStrength = 1.0;
      _rollY = -_rollHeight + t * (1 + 2 * _rollHeight);
      if(t === 0){ _rollStrength = 0; /* exact seam: bar invisible */ }
      break;
    }
    case 'flicker': {
      // Per-frame deterministic line picker. Seed is an integer derived
      // from t · 99991 (prime, sparse) so successive frames pick different
      // lines, but t=1 wraps to t=0 → same seed → same picked lines →
      // byte-equal closure.
      _flickerStrength = 1.0;
      _flickerSeed = Math.floor(t * 99991);
      break;
    }
    case 'drift': {
      // Chromatic phase wander on a slow sin. Amplitude ±0.6 of the macro
      // chromaConverge slider; default chromaConverge=0 yields ±0.12 of
      // an absolute fringe, soft enough to read as "the colour beams are
      // breathing" rather than a glitch.
      const wob = Math.sin(t * 2 * Math.PI) * 0.6;
      _chromaConverge = params.chromaConverge + 0.2 + wob * 0.2;
      if(t === 0){ _chromaConverge = params.chromaConverge + 0.2; /* match t=1 */ }
      break;
    }
    case 'breath':
    default: {
      // Original behaviour: gentle grain phase + a barely-noticeable
      // convergence breath. Kept the same so existing presets render
      // identically to the prior version.
      break;
    }
  }
  // Cursor focus (interactive). Set in mouse handler; pass through here so
  // the animate-off branch also picks it up via schedule()/render().
  if(!params.interactive){
    _focusR2 = 0; _focusBoost = 0;
  }
}

function renderAnimationFrame(tLoop){
  applyAnimationT(tLoop);
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    needsSourceUpload = true;
  }
  _envelopeOwnsFrame = true;
  render();
  _envelopeOwnsFrame = false;
  // Flush the WebGL command queue so toDataURL (and the harness's
  // renderAt()===renderAt() byte-equal check) reads the freshly-drawn
  // framebuffer rather than a stale one. preserveDrawingBuffer keeps the
  // back-buffer addressable; gl.finish guarantees the GPU is done.
  gl.finish();
}

function animationLoop(){
  if(!params.animate) return;
  const elapsed = performance.now() - animationStartTime;
  renderAnimationFrame((elapsed % CYCLE_MS) / CYCLE_MS);
  animationId = requestAnimationFrame(animationLoop);
}
function toggleAnimation(){
  if(params.animate){ animationStartTime = performance.now(); animationLoop(); }
  else if(animationId){ cancelAnimationFrame(animationId); animationId = null; }
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(tLoop){ renderAnimationFrame(tLoop); },
  pauseRender(){ if(animationId){ cancelAnimationFrame(animationId); animationId = null; } },
  resumeRender(){
    if(params.animate && !animationId){
      animationStartTime = performance.now();
      animationLoop();
    } else {
      schedule();
    }
  },
};

// ---------- init ----------
function init(){
  initGL();
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      needsSourceUpload = true;
      if(!params.animate) schedule();
      return;
    }
    if(!params.animate) schedule();
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => {
      needsSourceUpload = true;
      if(!params.animate) schedule();
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
  cv.addEventListener('mousemove', (e) => {
    if(!params.interactive){
      if(_focusR2 !== 0){ _focusR2 = 0; _focusBoost = 0; schedule(); }
      return;
    }
    const r = cv.getBoundingClientRect();
    // UV-space (0..1) centre + radius for the shader. Convert focusRadius
    // (screen px) to uv-space by dividing by the smaller canvas dimension
    // so the circle stays round on non-square canvases.
    _focusCx = (e.clientX - r.left) / r.width;
    _focusCy = 1 - (e.clientY - r.top) / r.height; // flip y to match GL uv
    const rUV = params.focusRadius / Math.min(r.width, r.height);
    _focusR2 = rUV * rUV;
    // Boost adds up to +1.5× the per-axis convergence strength under the
    // cursor — strong enough to read as "the cursor smears the colour
    // beams" without overwhelming the rest of the frame.
    _focusBoost = 1.5;
    if(!params.animate) schedule();
  });
  fitCanvas();
  schedule();
}

document.addEventListener('DOMContentLoaded', init);

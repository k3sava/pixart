#!/usr/bin/env python3
"""Rename control labels from technical / designer jargon to plain English
across every effect's index.html. The data-key on each <div class="wg-row">
stays unchanged so JS code keeps working — only the visible <div class="wg-name">
text gets rewritten.

Idempotent: if the label is already plain, it's left alone.
"""
import re
from pathlib import Path

EFFECTS = [
    "ascii", "bevel", "cellular", "contour", "crt",
    "displace", "distort", "dithering", "dots", "edge",
    "film-grain", "flow-field", "gradients", "halftone-cmyk",
    "ink-wash", "kaleidoscope", "patterns", "pixel-sort",
    "recolor", "rgb-shift", "scatter", "slide", "slit-scan",
    "stack", "stippling", "voronoi", "watercolor", "zoom-blur",
]

ROOT = Path(__file__).resolve().parent.parent

# data-key → plain-English label. Global mapping; applies wherever the key
# appears as a wg-row across any effect. Keep terms toy-friendly: avoid
# "luminance", "gamma", "preprocessor", "factor", "cutoff", "envelope".
LABELS = {
    # Shared / preprocessor
    "source":                "Source",
    "fit":                   "Fit",
    "bg":                    "Background",
    "backgroundColor":       "Background",
    "ratio":                 "Ratio",
    "canvasSize":            "Size",
    "blur":                  "Blur",
    "blurAmount":            "Blur",
    "grain":                 "Grain",
    "grainAmount":           "Grain",
    "gamma":                 "Brightness",
    "blackPoint":            "Darken",
    "whitePoint":            "Brighten",
    "showEffect":            "Show effect",
    "lightnessThreshold":    "Threshold",
    "threshold":             "Threshold",
    "patternType":           "Pattern",
    "patternImage":          "Tile image",
    "dotTexture":            "Dot image",
    "displacementMap":       "Distortion map",
    "distortionMap":         "Distortion map",
    "preprocessTarget":      "Affect",
    "showEffect":            "Show effect",
    "animate":               "Animate",
    "interactive":           "Cursor control",
    "mode":                  "Mode",
    # ASCII
    "columns":               "Columns",
    "rows":                  "Rows",
    "ramp":                  "Character set",
    "comments":              "Wrap in /* */",
    "borders":               "Show borders",
    # Bevel
    "depth":                 "Depth",
    "lightAngle":            "Light angle",
    "effectThreshold":       "Edge sensitivity",
    # Cellular
    "cellSize":              "Cell size",
    "steps":                 "Generations",
    "neighborhoodType":      "Ruleset",
    "surviveLowerBound":     "Survive low",
    "surviveUpperBound":     "Survive high",
    "birthLowerBound":       "Birth low",
    "birthUpperBound":       "Birth high",
    "ltlSurviveLower":       "Survive low",
    "ltlSurviveUpper":       "Survive high",
    "ltlBirthLower":         "Birth low",
    "ltlBirthUpper":         "Birth high",
    "mncaThreshold1":        "Inner band",
    "mncaThreshold2":        "Outer band",
    "mnccThreshold1Lower":   "Ring 1 low",
    "mnccThreshold1Upper":   "Ring 1 high",
    "mnccThreshold2Lower":   "Ring 2 low",
    "mnccThreshold2Upper":   "Ring 2 high",
    "mnccThreshold3Lower":   "Ring 3 low",
    "mnccThreshold3Upper":   "Ring 3 high",
    "mnccThreshold4Lower":   "Ring 4 low",
    "mnccThreshold4Upper":   "Ring 4 high",
    # Contour
    "levels":                "Line count",
    "smoothing":             "Smoothing",
    "lineWidth":             "Line width",
    "lineColor":             "Line colour",
    "fillBands":             "Fill bands",
    # CRT
    "distortion":            "Curvature",
    "dotScale":              "Phosphor size",
    "dotPitch":              "Phosphor pitch",
    "falloff":               "Mask falloff",
    "glowRadius":            "Glow radius",
    "glowIntensity":         "Glow strength",
    "blendMode":             "Bloom blend",
    "bloomThreshold":        "Bloom threshold",
    "bloomIntensity":        "Bloom strength",
    "bloomRadius":           "Bloom radius",
    "redConvergenceOffsetX": "Red offset X",
    "redConvergenceOffsetY": "Red offset Y",
    "blueConvergenceOffsetX":"Blue offset X",
    "blueConvergenceOffsetY":"Blue offset Y",
    # Displace
    "stepSize":              "Spacing",
    "displacement":          "Shift",
    "dotSize":               "Dot size",
    # Distort
    "displacementThreshold": "Edge cutoff",
    "xDisplacementStrength": "Shift left/right",
    "yDisplacementStrength": "Shift up/down",
    "xShiftStrength":        "Shift left/right",
    "yShiftStrength":        "Shift up/down",
    # Dithering
    "pixelSize":             "Pixel size",
    "colorMode":             "Colour",
    # Dots
    "minDotSize":            "Smallest dot",
    "maxDotSize":             "Largest dot",
    "cornerRadius":          "Roundness",
    "angle":                 "Angle",
    "gridType":              "Grid style",
    "displacementFactor":    "Jitter",
    # Edge — uses minDotSize/maxDotSize/cornerRadius/stepSize from dots map
    # Film-grain
    "filmStock":             "Film",
    "grainSize":             "Grain size",
    "halation":              "Halation",
    "halationRadius":        "Halation radius",
    "vignette":              "Vignette",
    "temperature":           "Warmth",
    # Flow-field
    "particles":             "Particle count",
    "stepLength":            "Stroke length",
    "noiseScale":            "Flow scale",
    "flowStrength":          "Flow strength",
    "alpha":                 "Opacity",
    "inkColor":              "Ink colour",
    "colorMode":             "Colour mode",
    # Gradients
    "shapeType":             "Shape",
    # Halftone-CMYK
    "cAngle":                "Cyan angle",
    "mAngle":                "Magenta angle",
    "yAngle":                "Yellow angle",
    "kAngle":                "Black angle",
    "cStrength":             "Cyan strength",
    "mStrength":             "Magenta strength",
    "yStrength":             "Yellow strength",
    "kStrength":             "Black strength",
    "gcr":                   "Black mix",
    "registerOffset":        "Misregister",
    "paperWhite":            "Paper colour",
    # Ink-wash
    "paperType":             "Paper",
    "paperColor":            "Paper colour",
    "brushPressure":         "Brush pressure",
    "inkDensity":            "Ink density",
    "bleed":                 "Bleed",
    "dryBrush":              "Dry brush",
    "paperGrain":            "Paper texture",
    # Kaleidoscope
    "segments":              "Mirrors",
    "angleOffset":           "Twist",
    "mirror":                "Flip alternate slices",
    "sampleX":               "Centre X",
    "sampleY":               "Centre Y",
    "zoom":                  "Zoom",
    # Patterns
    "gridDensityNumber":     "Tile density",
    "bgColor":               "Background colour",
    # Pixel-sort
    "direction":             "Direction",
    "sortBy":                "Sort by",
    "thresholdLow":          "Lower limit",
    "thresholdHigh":         "Upper limit",
    "sortReverse":           "Reverse",
    # Recolor
    "posterizeSteps":        "Bands",
    "noiseIntensity":        "Noise",
    "noiseScale":            "Noise scale",
    "noiseGamma":            "Noise contrast",
    "gradientRepetitions":   "Palette repeats",
    "colorAttribute":        "Map by",
    "stop1Pos":              "Stop 1 position",
    "stop1Color":            "Stop 1 colour",
    "stop2Pos":              "Stop 2 position",
    "stop2Color":            "Stop 2 colour",
    "stop3Pos":              "Stop 3 position",
    "stop3Color":            "Stop 3 colour",
    # RGB-shift
    "rOffsetX":              "Red shift X",
    "rOffsetY":              "Red shift Y",
    "gOffsetX":              "Green shift X",
    "gOffsetY":              "Green shift Y",
    "bOffsetX":              "Blue shift X",
    "bOffsetY":              "Blue shift Y",
    "blend":                 "Blend",
    "gain":                  "Brightness",
    "fringe":                "Edge falloff",
    # Scatter
    "pointDensityFactor":    "Dot count",
    "minPointSize":          "Smallest dot",
    "maxPointSize":           "Largest dot",
    "relaxIterations":       "Spread evenness",
    "relaxStrength":         "Spread strength",
    # Slide
    "planeRadius":           "Corner roundness",
    "planeSize":             "Card size",
    "orbitRadius":           "Orbit radius",
    "orbitDirection":        "Direction",
    "cycles":                "Cycles",
    "curve":                 "Easing",
    "durationSeconds":       "Duration (s)",
    # Slit-scan
    "axis":                  "Axis",
    "spread":                "Spread",
    "tilt":                  "Tilt",
    # Stack
    "cardRadius":            "Corner roundness",
    "cardSize":              "Card size",
    "rotationRange":         "Rotation range",
    "rotationSeed":          "Random seed",
    "xShiftScale":           "Shift X scale",
    "yShiftScale":           "Shift Y scale",
    "speed":                 "Speed",
    # Stippling
    "xSquares":              "Columns",
    "ySquares":              "Rows",
    "minSquareWidth":        "Smallest bar",
    "maxSquareWidth":         "Largest bar",
    # Voronoi
    "seedCount":             "Cell count",
    "seedSource":            "Cell placement",
    "metric":                "Distance",
    "relax":                 "Settle",
    "borderWidth":           "Border width",
    "borderColor":           "Border colour",
    "paletteShift":          "Hue shift",
    # Watercolor
    "wetness":               "Wetness",
    "edgeStrength":          "Edge darkness",
    "tone":                  "Palette mix",
    "wetRim":                "Wet rim",
    "palette":               "Palette",
    # Zoom-blur
    "blurType":              "Blur type",
    "strength":              "Strength",
    "samples":               "Quality",
    "focusX":                "Focus X",
    "focusY":                "Focus Y",
    "dropoff":               "Falloff",
    "holdSharp":             "Sharp centre",
    "spiralTwist":           "Spiral twist",
    # Refinement-pass extras (kept where they survived)
    "tileFamily":            "Tile family",
    "tileColor":             "Tile colour",
    "dotColor":              "Dot colour",
    "edgeColor":             "Edge colour",
    "haloStrength":          "Halo",
    "thresholdSweep":        "Sweep range",
    "angleSweep":            "Angle sweep",
    "densityHarmony":        "Density harmony",
    "paletteHarmony":        "Palette harmony",
    "paletteAngle":          "Palette angle",
    "paletteStart":          "Start colour",
    "paletteEnd":            "End colour",
    "pixelSweep":            "Sweep range",
    "harmonic":              "Harmonic mix",
    "phaseOffset":           "Phase offset",
    "eddyScale":             "Eddy scale",
    "vorticity":             "Vorticity",
    "viewYaw":               "View yaw",
    "pitch":                 "Pitch",
    "kernelFamily":          "Edge kernel",
    "loopVideo":             "Loop video",
    "playRate":              "Play rate",
    "depthBands":            "Depth bands",
    "bandSpeed":             "Band speed",
    "focusRadius":           "Cursor focus",
    "shearAxis":             "Shear angle",
    "frameCount":            "Frame count",
    "showShadow":            "Shadow",
    "tintCards":             "Tint cards",
}

# Regex finds: <div class="wg-row ..." data-key="<key>"...> ... <div class="wg-name">OLD</div>
# We rewrite only the wg-name text. The data-key value is captured for the lookup.
ROW_RE = re.compile(
    r'(<div\s+class="wg-row[^"]*"\s+data-key="(?P<key>[^"]+)"[^>]*>\s*<div class="wg-name">)(?P<label>[^<]+)(</div>)',
    re.DOTALL,
)


def sync_one(slug: str) -> str:
    p = ROOT / slug / "index.html"
    if not p.exists():
        return f"MISSING: {p}"
    html = p.read_text()
    changes = 0

    def repl(m):
        nonlocal changes
        key = m.group("key")
        old = m.group("label").strip()
        new = LABELS.get(key)
        if new is None or new == old:
            return m.group(0)
        changes += 1
        return m.group(1) + new + m.group(4)

    new_html = ROW_RE.sub(repl, html)
    if changes:
        p.write_text(new_html)
        return f"ok: {slug} ({changes} relabeled)"
    return f"skip (already plain): {slug}"


if __name__ == "__main__":
    for slug in EFFECTS:
        print(sync_one(slug))

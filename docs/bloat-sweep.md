# Bloat sweep (per-control isolation methodology)

Generated 2026-05-13T18:23:32.519Z. DEAD threshold: 5000 pixel-byte differences across the whole canvas. Lower numbers mean the control changes the output less.

## ascii
| control | verdict | diff |
|---|---|---|
| columns | LIVE | 14513 |
| rows | LIVE | 40193 |
| ramp | SKIPPED | other |
| blur | LIVE | 40193 |
| grain | LIVE | 40193 |
| gamma | DEAD | 3073 |
| blackPoint | LIVE | 40193 |
| whitePoint | LIVE | 28262 |
| comments | LIVE | 52181 |
| borders | LIVE | 51916 |

## bevel
| control | verdict | diff |
|---|---|---|
| blurAmount | LIVE | 354445 |
| grainAmount | LIVE | 354445 |
| gamma | LIVE | 376288 |
| blackPoint | LIVE | 354445 |
| whitePoint | LIVE | 134846 |
| depth | LIVE | 310117 |
| lightAngle | DEAD | 0 |
| effectThreshold | LIVE | 354445 |

## cellular
| control | verdict | diff |
|---|---|---|
| blurAmount | LIVE | 19176 |
| grainAmount | LIVE | 19176 |
| gamma | LIVE | 7387 |
| blackPoint | LIVE | 19176 |
| whitePoint | DEAD | 4145 |
| threshold | DEAD | 2790 |
| cellSize | LIVE | 26796 |
| steps | LIVE | 15852 |
| neighborhoodType | LIVE | 19176 |
| surviveLowerBound | DEAD | 0 |
| surviveUpperBound | DEAD | 0 |
| birthLowerBound | DEAD | 0 |
| birthUpperBound | DEAD | 0 |
| ltlSurviveLower | DEAD | 0 |
| ltlSurviveUpper | DEAD | 0 |
| ltlBirthLower | DEAD | 0 |
| ltlBirthUpper | DEAD | 0 |
| mncaThreshold1 | DEAD | 0 |
| mncaThreshold2 | DEAD | 0 |
| mnccThreshold1Lower | LIVE | 48751 |
| mnccThreshold1Upper | LIVE | 37003 |
| mnccThreshold2Lower | LIVE | 49045 |
| mnccThreshold2Upper | LIVE | 42955 |
| mnccThreshold3Lower | LIVE | 48090 |
| mnccThreshold3Upper | LIVE | 41689 |
| mnccThreshold4Lower | LIVE | 47464 |
| mnccThreshold4Upper | LIVE | 30316 |

## contour
| control | verdict | diff |
|---|---|---|
| levels | LIVE | 73808 |
| smoothing | LIVE | 295052 |
| lineWidth | LIVE | 238436 |
| lineColor | SKIPPED | other |
| bgColor | SKIPPED | other |
| fillBands | LIVE | 155101 |

## crt
| control | verdict | diff |
|---|---|---|
| blur | LIVE | 1038296 |
| grain | LIVE | 1038296 |
| gamma | LIVE | 266630 |
| blackPoint | LIVE | 1038296 |
| whitePoint | LIVE | 1180814 |
| patternType | LIVE | 1038296 |
| distortion | LIVE | 650975 |
| dotScale | LIVE | 8885 |
| dotPitch | DEAD | 3867 |
| falloff | LIVE | 845140 |
| glowRadius | LIVE | 556450 |
| glowIntensity | LIVE | 497189 |
| blendMode | LIVE | 904912 |
| bloomThreshold | LIVE | 776376 |
| bloomIntensity | LIVE | 728732 |
| bloomRadius | LIVE | 772720 |
| redConvergenceOffsetX | LIVE | 773897 |
| redConvergenceOffsetY | LIVE | 771280 |
| blueConvergenceOffsetX | LIVE | 774753 |
| blueConvergenceOffsetY | LIVE | 770750 |

## displace
| control | verdict | diff |
|---|---|---|
| blur | LIVE | 317128 |
| grain | LIVE | 317128 |
| gamma | LIVE | 315624 |
| blackPoint | LIVE | 317128 |
| whitePoint | LIVE | 140199 |
| stepSize | LIVE | 288935 |
| displacement | LIVE | 238414 |
| dotSize | LIVE | 182407 |

## distort
| control | verdict | diff |
|---|---|---|
| distortionMap | SKIPPED | other |
| blurAmount | LIVE | 294207 |
| grainAmount | LIVE | 294207 |
| gamma | LIVE | 284239 |
| blackPoint | LIVE | 294207 |
| whitePoint | LIVE | 264866 |
| preprocessTarget | DEAD | 0 |
| displacementThreshold | LIVE | 294207 |
| xDisplacementStrength | LIVE | 290407 |
| yDisplacementStrength | LIVE | 311336 |

## dithering
| control | verdict | diff |
|---|---|---|
| blur | LIVE | 148469 |
| grain | LIVE | 148469 |
| gamma | LIVE | 37523 |
| blackPoint | LIVE | 148469 |
| whitePoint | LIVE | 36382 |
| patternType | LIVE | 148469 |
| pixelSize | LIVE | 384777 |
| lightnessThreshold | LIVE | 36256 |
| colorMode | LIVE | 199422 |

## dots
| control | verdict | diff |
|---|---|---|
| blur | LIVE | 225291 |
| grain | LIVE | 225291 |
| gamma | LIVE | 104947 |
| blackPoint | LIVE | 225291 |
| whitePoint | LIVE | 84754 |
| lightnessThreshold | LIVE | 65292 |
| gridType | LIVE | 225291 |
| angle | LIVE | 253463 |
| stepSize | LIVE | 126701 |
| minDotSize | LIVE | 217980 |
| maxDotSize | LIVE | 30175 |
| cornerRadius | LIVE | 223319 |
| displacementFactor | LIVE | 221822 |

## edge
| control | verdict | diff |
|---|---|---|
| blur | LIVE | 33078 |
| grain | LIVE | 33078 |
| gamma | LIVE | 93314 |
| blackPoint | LIVE | 33078 |
| whitePoint | LIVE | 50935 |
| lightnessThreshold | LIVE | 114951 |
| minDotSize | LIVE | 33078 |
| maxDotSize | DEAD | 2744 |
| cornerRadius | LIVE | 24393 |
| stepSize | LIVE | 44217 |

## film-grain
| control | verdict | diff |
|---|---|---|
| filmStock | LIVE | 716186 |
| grainAmount | LIVE | 382298 |
| grainSize | LIVE | 691527 |
| halation | LIVE | 682035 |
| halationRadius | LIVE | 682035 |
| vignette | LIVE | 677790 |
| temperature | LIVE | 682737 |

## flow-field
| control | verdict | diff |
|---|---|---|
| colorMode | LIVE | 306439 |
| particles | LIVE | 27731 |
| steps | LIVE | 191184 |
| stepLength | LIVE | 220191 |
| noiseScale | LIVE | 351329 |
| flowStrength | LIVE | 79677 |
| lineWidth | LIVE | 286074 |
| alpha | DEAD | 2669 |
| inkColor | SKIPPED | other |

## gradients
| control | verdict | diff |
|---|---|---|
| blur | LIVE | 27067 |
| grain | LIVE | 27067 |
| gamma | LIVE | 21559 |
| blackPoint | LIVE | 27067 |
| whitePoint | LIVE | 22436 |
| lightnessThreshold | LIVE | 56443 |
| stepSize | LIVE | 48316 |
| shapeType | LIVE | 27067 |

## halftone-cmyk
| control | verdict | diff |
|---|---|---|
| cellSize | LIVE | 785150 |
| cAngle | LIVE | 619377 |
| mAngle | LIVE | 583772 |
| yAngle | LIVE | 631645 |
| kAngle | LIVE | 628793 |
| cStrength | LIVE | 580768 |
| mStrength | LIVE | 576533 |
| yStrength | LIVE | 610196 |
| kStrength | LIVE | 601217 |
| gcr | LIVE | 614406 |
| registerOffset | LIVE | 629325 |
| paperWhite | SKIPPED | other |

## ink-wash
| control | verdict | diff |
|---|---|---|
| inkColor | SKIPPED | other |
| paperColor | SKIPPED | other |
| brushPressure | LIVE | 364729 |
| inkDensity | LIVE | 364729 |
| bleed | DEAD | 0 |
| dryBrush | LIVE | 437267 |
| paperGrain | LIVE | 150469 |
| paperType | LIVE | 438920 |

## kaleidoscope
| control | verdict | diff |
|---|---|---|
| segments | LIVE | 228963 |
| angleOffset | LIVE | 263838 |
| mirror | LIVE | 289620 |
| sampleX | LIVE | 271735 |
| sampleY | LIVE | 365296 |
| zoom | LIVE | 452160 |

## patterns
| control | verdict | diff |
|---|---|---|
| patternImage | SKIPPED | other |
| blurAmount | DEAD | 4866 |
| grainAmount | DEAD | 4866 |
| gamma | LIVE | 5327 |
| blackPoint | DEAD | 4866 |
| whitePoint | DEAD | 4992 |
| lightnessThreshold | DEAD | 2790 |
| gridDensityNumber | DEAD | 3304 |
| bgColor | SKIPPED | other |

## pixel-sort
| control | verdict | diff |
|---|---|---|
| direction | LIVE | 484605 |
| sortBy | LIVE | 539299 |
| thresholdLow | LIVE | 777527 |
| thresholdHigh | LIVE | 474596 |
| sortReverse | LIVE | 483189 |

## recolor
| control | verdict | diff |
|---|---|---|
| blur | LIVE | 116403 |
| grain | LIVE | 116403 |
| gamma | LIVE | 142724 |
| blackPoint | LIVE | 116403 |
| whitePoint | LIVE | 108275 |
| posterizeSteps | LIVE | 31766 |
| noiseIntensity | LIVE | 96626 |
| noiseScale | LIVE | 104260 |
| noiseGamma | LIVE | 100151 |
| gradientRepetitions | LIVE | 116403 |
| colorAttribute | LIVE | 116403 |
| stop1Pos | LIVE | 121717 |
| stop1Color | SKIPPED | other |
| stop2Pos | LIVE | 96145 |
| stop2Color | SKIPPED | other |
| stop3Pos | LIVE | 85262 |
| stop3Color | SKIPPED | other |

## rgb-shift
| control | verdict | diff |
|---|---|---|
| rOffsetX | LIVE | 290831 |
| rOffsetY | LIVE | 285958 |
| gOffsetX | LIVE | 290367 |
| gOffsetY | LIVE | 287598 |
| bOffsetX | LIVE | 290724 |
| bOffsetY | LIVE | 286725 |
| blend | LIVE | 289254 |
| gain | DEAD | 2751 |
| fringe | LIVE | 135336 |

## scatter
| control | verdict | diff |
|---|---|---|
| dotTexture | SKIPPED | other |
| blurAmount | LIVE | 42837 |
| grainAmount | LIVE | 42837 |
| gamma | LIVE | 72181 |
| blackPoint | LIVE | 42837 |
| whitePoint | LIVE | 44561 |
| pointDensityFactor | DEAD | 2669 |
| minPointSize | LIVE | 46513 |
| maxPointSize | LIVE | 109920 |
| relaxIterations | LIVE | 38558 |
| relaxStrength | LIVE | 38558 |

## slide
| control | verdict | diff |
|---|---|---|
| planeRadius | LIVE | 70184 |
| planeSize | LIVE | 14431 |
| orbitRadius | LIVE | 84926 |
| orbitDirection | LIVE | 69850 |
| cycles | LIVE | 72540 |
| curve | LIVE | 72462 |
| durationSeconds | LIVE | 69942 |
| backgroundColor | SKIPPED | other |

## slit-scan
| control | verdict | diff |
|---|---|---|
| axis | LIVE | 277948 |
| spread | LIVE | 293018 |
| tilt | LIVE | 276138 |

## stack
| control | verdict | diff |
|---|---|---|
| cardRadius | LIVE | 109355 |
| cardSize | LIVE | 11847 |
| rotationRange | LIVE | 98122 |
| rotationSeed | LIVE | 108297 |
| xShiftScale | LIVE | 111143 |
| yShiftScale | LIVE | 91158 |
| cycles | LIVE | 83755 |
| speed | DEAD | 0 |
| durationSeconds | DEAD | 2744 |
| backgroundColor | SKIPPED | other |

## stippling
| control | verdict | diff |
|---|---|---|
| blur | LIVE | 266673 |
| grain | LIVE | 266673 |
| gamma | LIVE | 169918 |
| blackPoint | LIVE | 266673 |
| whitePoint | LIVE | 148102 |
| lightnessThreshold | LIVE | 119739 |
| gridType | LIVE | 266673 |
| angle | LIVE | 393316 |
| ySquares | LIVE | 137033 |
| xSquares | LIVE | 15033 |
| minSquareWidth | LIVE | 295060 |
| maxSquareWidth | LIVE | 178318 |

## voronoi
| control | verdict | diff |
|---|---|---|
| seedCount | LIVE | 6079 |
| seedSource | LIVE | 30736 |
| metric | DEAD | 4686 |
| relax | LIVE | 116977 |
| borderWidth | LIVE | 116480 |
| borderColor | SKIPPED | other |
| colorMode | LIVE | 116301 |
| paletteShift | DEAD | 0 |

## watercolor
| control | verdict | diff |
|---|---|---|
| wetness | LIVE | 388720 |
| edgeStrength | LIVE | 388596 |
| smoothing | LIVE | 402227 |
| paperGrain | LIVE | 250546 |
| palette | LIVE | 389201 |
| tone | LIVE | 389201 |
| wetRim | LIVE | 392412 |

## zoom-blur
| control | verdict | diff |
|---|---|---|
| strength | LIVE | 203058 |
| samples | LIVE | 258657 |
| focusX | LIVE | 178228 |
| focusY | LIVE | 226493 |
| dropoff | LIVE | 203058 |
| holdSharp | LIVE | 214040 |

## Strip list (DEAD only)

- **ascii**: gamma
- **bevel**: lightAngle
- **cellular**: whitePoint, threshold, surviveLowerBound, surviveUpperBound, birthLowerBound, birthUpperBound, ltlSurviveLower, ltlSurviveUpper, ltlBirthLower, ltlBirthUpper, mncaThreshold1, mncaThreshold2
- **crt**: dotPitch
- **distort**: preprocessTarget
- **edge**: maxDotSize
- **flow-field**: alpha
- **ink-wash**: bleed
- **patterns**: blurAmount, grainAmount, blackPoint, whitePoint, lightnessThreshold, gridDensityNumber
- **rgb-shift**: gain
- **scatter**: pointDensityFactor
- **stack**: speed, durationSeconds
- **voronoi**: metric, paletteShift

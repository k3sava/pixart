bevel: ok
cellular: ok
- dithering: ok — renamed blurAmount/grainAmount→blur/grain in index.html + effect.js; anim/interactive already stripped
- 2026-05-13T12:35:54+05:30 crt: pass2 alignment strip complete; params trimmed, animation/envelope removed, shader uniforms reduced, blur/grain renamed
- ascii: stripped fg/fgMatch/bold/tracking/jitter/invertRamp/mode/animate/interactive/focusRadius; added showEffect; static-only WAEffect.
- 2026-05-13 pass2 dots: stripped animation/dotShape/angleSweep/screenAngleOffset/dotColor/bgColor/mode/interactive/focusRadius; renamed blurAmount→blur, grainAmount→grain; hardcoded black-on-white; round-only drawDot; WAEffect cycleMs=0
- 2026-05-13 edge: stripped kernel/halo/edgeColor/thresholdSweep/mode/animate/interactive/focusRadius; hardcoded Sobel + black on white; WAEffect static contract.
- distort pass2: data-keys verified, fit+bg added, effect.js clean
- displace: stripped 3D bolt-on (viewYaw/pitch/eddyScale/vorticity/mode/animate/interactive/focusRadius); renamed pixelDensity→stepSize, yDisplacement→displacement, blurAmount→blur, grainAmount→grain; now faithful step-displace per tooooools.
- gradients: stripped animation/palette/focus controls; hardcoded black→white palette; keys match spec (source, fit, bg, canvasSize, blur, grain, gamma, blackPoint, whitePoint, lightnessThreshold, stepSize, shapeType, showEffect)
- 2026-05-13 stippling: pass2 strip — removed mode/animate/interactive/angleSweep/densityHarmony/dotColor/bgColor/focusRadius; renamed blurAmount→blur, grainAmount→grain; hardcoded white paper + black ink; WAEffect static-only.
2026-05-13 recolor pass2: stripped hueRotationAmount/levels/palette/mode/animate/interactive; renamed blurAmount→blur, grainAmount→grain; effect.js now static (LUT-based 3-stop gradient map); WAEffect = no-op renderAt/pauseRender + paint() resume.

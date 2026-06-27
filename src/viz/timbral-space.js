'use strict';
// ═══ TIMBRAL SPACE — 3D Spectral Visualization (v1.0) ═══
//
// A three-dimensional spectral coordinate system that visualizes the ensemble
// as living acoustic sculpture. Inspired by Berenice Abbott's physics photography:
// scientific truth rendered with precision, black ground, luminous paths.
//
// Axes (real acoustic measurements, not metaphors):
//   X — Spectral Centroid (brightness): dark ← → bright
//   Y — Spectral Density (energy): sparse ← → dense
//   Z — Spectral Flatness (noisiness): tonal ← → noise
//
// Agents are invisible positional anchors — their presence is shown solely through
// note trails and live note meshes. Agent Groups drift in timbral space based on
// real-time spectral analysis, providing spatial coherence for note placement.
//
// Note trajectories: Sequential notes from each agent connect into fading lines
// in timbral space — long-exposure photography of musical phrases.
//
// Synchrony threads: Faint connections between agents whose Kuramoto phases
// are close — emergent from the physics, not designed.
//
// References:
//   Abbott, B. — Strobe Alley, MIT (physics photography)
//   Peeters et al. 2011 — spectral descriptors for timbre classification
//   Large & Jones 1999 — hierarchical entrainment (Kuramoto phase data)
//
// Load order: after sound-engine.js, after three-browser.js.

var TimbralSpace = (function() {

  // ══════════════════════════════════════════════════
  // CONSTANTS
  // ══════════════════════════════════════════════════

  // Voice colors — luminous, restrained, scientific false-color
  var COLORS = {
    bass:       { r: 0.27, g: 0.27, b: 0.80 },  // deep indigo
    rhythm:     { r: 0.80, g: 0.53, b: 0.27 },  // warm amber
    soloist:    { r: 0.27, g: 0.80, b: 0.67 },  // cool teal
    lead:       { r: 0.80, g: 0.40, b: 0.53 },  // pale rose
    percussion: { r: 0.87, g: 0.67, b: 0.40 },  // warm gold
    human:      { r: 0.95, g: 0.95, b: 1.00 }   // blue-white
  };

  // Home regions in timbral space (normalized 0-1, mapped to scene coords)
  // Maximally spread on X/Y, moderate Z so depth doesn't shrink back agents too much
  var HOME = {
    bass:       { x: 0.18, y: 0.25, z: 0.35 },  // low-left
    rhythm:     { x: 0.70, y: 0.18, z: 0.55 },  // low-right-mid
    soloist:    { x: 0.82, y: 0.78, z: 0.35 },  // upper-right
    lead:       { x: 0.22, y: 0.82, z: 0.45 },  // upper-left
    percussion: { x: 0.15, y: 0.15, z: 0.65 },  // low-left-back
    human:      { x: 0.50, y: 0.50, z: 0.45 }   // center: for note tracking only
  };

  // Scene dimensions — COMPACT so everything is visible and centered
  var SPACE_SIZE = 4;           // half-extent of the timbral space
  var TRAIL_MAX_POINTS = 120;   // max points per voice trail
  var TRAIL_FADE_RATE = 0.008;  // opacity decay per frame (slower fade)
  var CAMERA_ORBIT_PERIOD = 600; // seconds for full orbit (very slow — near-static)
  var CAMERA_DISTANCE = 8;      // distance from origin (closer)
  var CAMERA_ELEVATION = 0.15;  // radians above horizontal (low angle, slightly tilted up)
  // Spectral analysis
  var FFT_SIZE = 1024;
  var SPECTRAL_SMOOTH = 0.92;   // EMA smoothing for agent positions
  var AMPLITUDE_SMOOTH = 0.85;  // EMA for sphere glow intensity

  // Ambient star field
  var STAR_COUNT = 400;         // background dust motes
  var _starField = null;

  // Atmospheric dust (near-field, section-reactive)
  var DUST_COUNT = 300;
  var _dustField = null;
  var _dustBrightness = 0.06;   // EMA-smoothed, driven by section energy

  // Cached section energy (shared between _updateSectionAmbience and _renderWithBloom)
  var _cachedSectionEnergy = 0;

  // Voices to visualize — human excluded (they ARE the viewer)
  var VOICES = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
  // All voices including human (for spectral analysis / note tracking only)
  var ALL_VOICES = ['bass', 'rhythm', 'soloist', 'lead', 'percussion', 'human'];


  // ══════════════════════════════════════════════════
  // STATE
  // ══════════════════════════════════════════════════

  var _active = false;
  var _scene, _camera, _renderer, _clock;
  var _container;             // DOM container (.canvas-wrap)
  var _canvas2d;              // original 2D Tonnetz canvas
  var _rafId = null;

  // Per-voice objects
  var _agents = {};           // { voiceName: { mesh (Group), points, shBasis, basePositions, ... } }
  var _trails = {};           // { voiceName: { line, positions, opacities, headIdx, ... } }
  var _spectral = {};         // { voiceName: { centroid, density, flatness, amplitude, analyser, freqData } }

  // Sync threads (data only — rendered via tube InstancedMesh)
  var _syncLines = [];

  // Axis lines + labels
  var _axisGroup;

  // Scatter particles — visible geometry in separate scene + proxy lights for RawDump
  var _scatterPool = [];
  var _scatterIdx = 0;
  var SCATTER_MAX = 200;
  var _scatterScene;      // separate THREE.Scene (no z-fight with dump)
  var _scatterGeo;
  var _scatterMat;
  var _scatterIMesh;
  var _scatterDummy;
  var _scatterColor;

  // Per-voice velocity tracking (for collision physics)
  // Updated each time a note is placed — velocity = position delta in timbral space
  var _voiceVelocity = {};  // { voiceName: { vx, vy, vz } }

  // Note event tracking (for trails)
  var _lastNotes = {};        // { voiceName: [{ midi, velocity, time }] }


  // ══════════════════════════════════════════════════
  // SPECTRAL ANALYSIS
  // ══════════════════════════════════════════════════

  // Extract spectral centroid, density, flatness from AnalyserNode FFT data
  function _initSpectral(voiceName) {
    var analyser = null;
    if (typeof SoundEngine !== 'undefined' && SoundEngine.getAnalyser) {
      analyser = SoundEngine.getAnalyser(voiceName);
    }

    var numBins = analyser ? analyser.frequencyBinCount : 512;
    _spectral[voiceName] = {
      analyser: analyser,
      freqData: new Float32Array(numBins),
      centroid: HOME[voiceName] ? HOME[voiceName].x : 0.5,
      density: HOME[voiceName] ? HOME[voiceName].y : 0.5,
      flatness: HOME[voiceName] ? HOME[voiceName].z : 0.25,
      amplitude: 0,
      numBins: numBins
    };
  }

  function _updateSpectral(voiceName) {
    var s = _spectral[voiceName];
    if (!s || !s.analyser) return;

    s.analyser.getFloatFrequencyData(s.freqData);

    var sampleRate = 44100;
    try {
      var c = SoundEngine.ensureCtx();
      if (c) sampleRate = c.sampleRate;
    } catch(e) {}

    var data = s.freqData;
    var N = s.numBins;

    // Convert dB to linear magnitude and compute features
    var sumMagFreq = 0, sumMag = 0;
    var sumLogPow = 0, sumPow = 0;
    var count = 0;

    for (var i = 1; i < N; i++) {
      var db = data[i];
      if (db < -100) db = -100;
      var mag = Math.pow(10, db / 20);
      var pow = mag * mag;
      var freq = i * sampleRate / (N * 2);

      sumMagFreq += mag * freq;
      sumMag += mag;
      sumPow += pow;
      if (pow > 1e-20) {
        sumLogPow += Math.log(pow);
        count++;
      }
    }

    // Spectral centroid (Hz → normalized 0-1, assuming 20Hz-10kHz range)
    var centroidHz = sumMag > 0.0001 ? sumMagFreq / sumMag : 200;
    var centroidNorm = Math.max(0, Math.min(1, (Math.log2(centroidHz) - Math.log2(20)) / (Math.log2(10000) - Math.log2(20))));

    // Spectral density (RMS energy, normalized)
    var rms = Math.sqrt(sumPow / Math.max(1, N));
    var densityNorm = Math.max(0, Math.min(1, rms * 30)); // scale to visible range

    // Spectral flatness (geometric mean / arithmetic mean of power)
    var flatness = 0;
    if (count > 0 && sumPow > 0) {
      var geoMean = Math.exp(sumLogPow / count);
      var ariMean = sumPow / count;
      flatness = Math.max(0, Math.min(1, geoMean / ariMean));
    }

    // EMA smoothing toward real spectral values
    // When signal is very weak (silence), pull back toward home position
    var sm = SPECTRAL_SMOOTH;
    var home = HOME[voiceName] || HOME.human;
    var signalPresent = rms > 0.001;  // actual audio present?

    if (signalPresent) {
      s.centroid = s.centroid * sm + centroidNorm * (1 - sm);
      s.density = s.density * sm + densityNorm * (1 - sm);
      s.flatness = s.flatness * sm + flatness * (1 - sm);
    } else {
      // Drift back to home in silence
      s.centroid = s.centroid * 0.98 + home.x * 0.02;
      s.density = s.density * 0.98 + home.y * 0.02;
      s.flatness = s.flatness * 0.98 + home.z * 0.02;
    }
    s.amplitude = s.amplitude * AMPLITUDE_SMOOTH + rms * 10 * (1 - AMPLITUDE_SMOOTH);
    if (s.amplitude > 1) s.amplitude = 1;
  }

  // Convert normalized timbral coordinates (0-1) to scene coordinates
  function _timbralToScene(cx, dy, fz) {
    return {
      x: (cx - 0.5) * SPACE_SIZE * 2,
      y: (dy - 0.5) * SPACE_SIZE * 2,
      z: (fz - 0.5) * SPACE_SIZE * 2
    };
  }


  // ══════════════════════════════════════════════════
  // TUBE INSTANCE POOL (InstancedMesh — single draw call)
  // ══════════════════════════════════════════════════
  //
  // All connections (trails, sync threads, live note lines) render as
  // real 3D cylinders via a single InstancedMesh. Each tube segment is
  // one instance, positioned/oriented/scaled per frame. No sprites,
  // no 1px lines. The bloom post-processing creates the phosphor glow.

  var TUBE_POOL_SIZE = 600;
  var TUBE_RADIAL_SEGS = 8;       // enough segments for smooth core→glow falloff
  var TUBE_BASE_RADIUS = 0.008;   // wider geometry — shader narrows visible core, glow in outer shell

  var _tubeIMesh = null;           // THREE.InstancedMesh
  var _tubeInstanceIdx = 0;        // per-frame counter, reset each animate()

  // Pre-allocated temp objects (zero GC pressure)
  var _tUP = null;
  var _tDir = null;
  var _tQuat = null;
  var _tMat4 = null;
  var _tPos = null;
  var _tScale = null;
  var _tColor = null;

  // Lightning texture for tube surfaces (CC0 from OpenGameArt)
  // Loaded async — falls back to plain white until ready
  var _lightningTex = null;
  var _lightningReady = false;
  var _sparkTexture = null;  // spark texture for note spheres
  var _sparkReady = false;

  // Load spark texture, desaturate to grayscale so voice color tinting works
  function _loadSparkTexture() {
    var img = new Image();
    img.onload = function() {
      var canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      var data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var px = data.data;
      for (var i = 0; i < px.length; i += 4) {
        var lum = px[i] * 0.299 + px[i+1] * 0.587 + px[i+2] * 0.114;
        px[i] = px[i+1] = px[i+2] = lum;
        px[i+3] = 255;
      }
      ctx.putImageData(data, 0, 0);

      var tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      _sparkTexture = tex;
      _sparkReady = true;
      console.log('%cSpark texture loaded (grayscale)', 'color:#fa0;font-family:monospace');
    };
    img.src = 'data/textures/spark4.jpg';
  }

  function _loadLightningTexture() {
    // Load the image manually so we can desaturate to grayscale
    // Grayscale allows per-instance color tinting to give each voice its own hue
    var img = new Image();
    img.onload = function() {
      // Draw to canvas and convert to grayscale (luminance)
      var canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      var data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var px = data.data;
      for (var i = 0; i < px.length; i += 4) {
        // Luminance: 0.299R + 0.587G + 0.114B
        var lum = px[i] * 0.299 + px[i+1] * 0.587 + px[i+2] * 0.114;
        px[i] = px[i+1] = px[i+2] = lum;
        px[i+3] = 255;  // full alpha — brightness via RGB only
      }
      ctx.putImageData(data, 0, 0);

      var tex = new THREE.CanvasTexture(canvas);
      // Rotate 90° so the lightning arc runs along tube LENGTH (UV.y)
      // The thin bright bolt against black creates natural glow around circumference
      tex.rotation = Math.PI / 2;
      tex.center.set(0.5, 0.5);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      // Maximum density: 48× along length — bolt becomes continuous glowing filament
      // 1× around circumference — thin tube means this just sets brightness profile
      tex.repeat.set(1, 48);
      tex.needsUpdate = true;

      _lightningTex = tex;
      _lightningReady = true;
      if (_tubeIMesh && _tubeIMesh.material) {
        _tubeIMesh.material.map = tex;
        _tubeIMesh.material.needsUpdate = true;
      }
      console.log('%cLightning texture loaded (grayscale)', 'color:#6af;font-family:monospace');
    };
    img.src = 'data/textures/lightning_blue.png';
  }

  // Fallback: simple white texture (used until lightning loads)
  function _createFallbackTexture() {
    var canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 4, 4);
    var tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  function _initTubePool() {
    _tUP = new THREE.Vector3(0, 1, 0);
    _tDir = new THREE.Vector3();
    _tQuat = new THREE.Quaternion();
    _tMat4 = new THREE.Matrix4();
    _tPos = new THREE.Vector3();
    _tScale = new THREE.Vector3();
    _tColor = new THREE.Color();

    // CylinderGeometry — wider radius, shader creates thin bright core + glow buffer
    var geo = new THREE.CylinderGeometry(1, 1, 1, TUBE_RADIAL_SEGS, 1, true);

    // Custom ShaderMaterial for tubes: solid core thread + soft glow falloff
    // Uses instanced rendering — instanceMatrix and instanceColor from InstancedMesh
    var mat = new THREE.ShaderMaterial({
      vertexShader: [
        'varying vec3 vNormal;',
        'varying vec3 vViewPos;',
        'varying vec2 vUv;',
        'varying vec3 vInstanceColor;',
        'void main() {',
        '  vNormal = normalize(normalMatrix * normal);',
        '  vUv = uv;',
        // instanceColor is vec3 provided by InstancedMesh.setColorAt
        '  vInstanceColor = instanceColor;',
        '  vec4 mvPos = modelViewMatrix * instanceMatrix * vec4(position, 1.0);',
        '  vViewPos = mvPos.xyz;',
        '  gl_Position = projectionMatrix * mvPos;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vNormal;',
        'varying vec3 vViewPos;',
        'varying vec2 vUv;',
        'varying vec3 vInstanceColor;',

        'void main() {',
        '  vec3 viewDir = normalize(-vViewPos);',
        '  float NdotV = abs(dot(vNormal, viewDir));',

        // Solid core: only the absolute center-facing strip (NdotV > 0.93)
        // Visually ~1px thread at typical viewing distance
        // Everything else is soft glow falloff
        '  float coreEdge = 0.93;',
        '  float solidCore = smoothstep(coreEdge - 0.03, coreEdge + 0.03, NdotV);',

        // Glow falloff — cubic for soft fade, subtle halo
        '  float glowFalloff = pow(NdotV, 3.0) * 0.3;',

        // Combine: pixel-thin bright core + soft surrounding glow
        '  float intensity = solidCore * 1.0 + (1.0 - solidCore) * glowFalloff;',

        // Color from instance (already premultiplied with opacity)
        '  vec3 col = vInstanceColor * intensity;',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n'),
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    // Begin async loading of textures (spark for notes)
    _loadLightningTexture();
    _loadSparkTexture();

    _tubeIMesh = new THREE.InstancedMesh(geo, mat, TUBE_POOL_SIZE);
    _tubeIMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _tubeIMesh.frustumCulled = false;

    // Initialize all instances as invisible (zero scale)
    var zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
    for (var i = 0; i < TUBE_POOL_SIZE; i++) {
      _tubeIMesh.setMatrixAt(i, zeroMat);
    }
    // Init instanceColor buffer by setting index 0
    _tubeIMesh.setColorAt(0, new THREE.Color(0, 0, 0));

    _tubeIMesh.count = 0;  // render nothing initially
    _scene.add(_tubeIMesh);
  }

  // Claim a tube instance: orient cylinder between two 3D points
  // Color is baked with opacity (premultiplied: darker = more transparent with additive)
  function _setTubeInstance(x1, y1, z1, x2, y2, z2, r, g, b, opacity, radiusMult) {
    if (_tubeInstanceIdx >= TUBE_POOL_SIZE) return;
    var idx = _tubeInstanceIdx++;

    _tDir.set(x2 - x1, y2 - y1, z2 - z1);
    var len = _tDir.length();
    if (len < 0.001) {
      // Degenerate — hide this instance
      _tMat4.makeScale(0, 0, 0);
      _tubeIMesh.setMatrixAt(idx, _tMat4);
      _tubeIMesh.setColorAt(idx, _tColor.setRGB(0, 0, 0));
      return;
    }

    _tDir.divideScalar(len);
    _tQuat.setFromUnitVectors(_tUP, _tDir);
    _tPos.set((x1 + x2) * 0.5, (y1 + y2) * 0.5, (z1 + z2) * 0.5);
    var rad = TUBE_BASE_RADIUS * (radiusMult || 1);
    _tScale.set(rad, len, rad);
    _tMat4.compose(_tPos, _tQuat, _tScale);

    _tubeIMesh.setMatrixAt(idx, _tMat4);
    // Premultiplied alpha: with additive blending, darker = transparent
    // Texture handles radial falloff (RGB), color controls brightness
    // 3× boost — 2× the amber material intensity
    var boost = 3.0;
    _tColor.setRGB(
      Math.min(1, r * opacity * boost),
      Math.min(1, g * opacity * boost),
      Math.min(1, b * opacity * boost)
    );
    _tubeIMesh.setColorAt(idx, _tColor);
  }

  // Call after all subsystems have claimed instances
  var _prevTubeCount = 0;
  function _finalizeTubePool() {
    // Skip buffer upload when nothing is active and nothing was active last frame
    if (_tubeInstanceIdx === 0 && _prevTubeCount === 0) return;

    // Hide any unused instances from previous frame
    for (var i = _tubeInstanceIdx; i < _prevTubeCount; i++) {
      _tMat4.makeScale(0, 0, 0);
      _tubeIMesh.setMatrixAt(i, _tMat4);
    }
    _tubeIMesh.count = Math.max(_tubeInstanceIdx, 1);
    _tubeIMesh.instanceMatrix.needsUpdate = true;
    if (_tubeIMesh.instanceColor) _tubeIMesh.instanceColor.needsUpdate = true;
    _prevTubeCount = _tubeInstanceIdx;
  }


  // ══════════════════════════════════════════════════
  // AGENT ANCHOR CREATION (invisible positional reference)
  // ══════════════════════════════════════════════════

  function _createAgent(voiceName) {
    var col = COLORS[voiceName] || COLORS.human;
    var threeColor = new THREE.Color(col.r, col.g, col.b);

    // Invisible positional anchor — agent presence is shown through notes only.
    // The Group still drifts in timbral space (spectral tracking) so note positions
    // maintain their 15% agent-pull for spatial coherence.
    var group = new THREE.Group();

    // Position at home
    var home = HOME[voiceName] || HOME.human;
    var pos3 = _timbralToScene(home.x, home.y, home.z);
    group.position.set(pos3.x, pos3.y, pos3.z);

    _scene.add(group);

    _agents[voiceName] = {
      mesh: group,
      color: threeColor,
      amplitude: 0
    };
  }


  // ══════════════════════════════════════════════════
  // NOTE TRAILS
  // ══════════════════════════════════════════════════

  function _createTrail(voiceName) {
    var col = COLORS[voiceName] || COLORS.human;

    // Data model only — rendering is via tube InstancedMesh pool
    _trails[voiceName] = {
      positions: new Float32Array(TRAIL_MAX_POINTS * 3),
      activeCount: 0,
      opacities: new Float32Array(TRAIL_MAX_POINTS),
      maxOpacity: 0.9,
      color: col
    };

    _lastNotes[voiceName] = [];
  }

  // Add a point to a voice's trail
  function _addTrailPoint(voiceName, x, y, z) {
    var trail = _trails[voiceName];
    if (!trail) return;

    var n = trail.activeCount;
    if (n >= TRAIL_MAX_POINTS) {
      // Shift everything down by 1
      for (var i = 0; i < (TRAIL_MAX_POINTS - 1) * 3; i++) {
        trail.positions[i] = trail.positions[i + 3];
      }
      for (var j = 0; j < TRAIL_MAX_POINTS - 1; j++) {
        trail.opacities[j] = trail.opacities[j + 1];
      }
      n = TRAIL_MAX_POINTS - 1;
    }

    trail.positions[n * 3] = x;
    trail.positions[n * 3 + 1] = y;
    trail.positions[n * 3 + 2] = z;
    trail.opacities[n] = trail.maxOpacity;
    trail.activeCount = n + 1;
  }

  // Fade trail opacities and render as tube segments via InstancedMesh
  function _updateTrail(voiceName) {
    var trail = _trails[voiceName];
    if (!trail) return;

    var col = trail.color;
    var alive = 0;

    for (var i = 0; i < trail.activeCount; i++) {
      trail.opacities[i] -= TRAIL_FADE_RATE;
      if (trail.opacities[i] < 0.005) trail.opacities[i] = 0;
      if (trail.opacities[i] > 0.005) alive = i + 1;
    }

    // Render tube segments between consecutive trail points
    for (var i = 0; i < alive - 1; i++) {
      var a1 = trail.opacities[i];
      var a2 = trail.opacities[i + 1];
      if (a1 < 0.01 && a2 < 0.01) continue;

      var avgA = (a1 + a2) * 0.5;
      _setTubeInstance(
        trail.positions[i * 3],     trail.positions[i * 3 + 1],     trail.positions[i * 3 + 2],
        trail.positions[(i+1) * 3], trail.positions[(i+1) * 3 + 1], trail.positions[(i+1) * 3 + 2],
        col.r, col.g, col.b,
        avgA,
        0.8 + avgA * 0.6  // thicker when fresh, thinner as it fades
      );
    }

    trail.activeCount = alive;
  }


  // ══════════════════════════════════════════════════
  // SCATTER PARTICLES
  // ══════════════════════════════════════════════════

  // Scatter particles — pool-only, no geometry.
  // Scatter particles: visible InstancedMesh in _scatterScene (isolated from dump text).
  // Also exposed via getActiveScatterData() as proxy lights for RawDump shader.

  function _initScatter() {
    _scatterDummy = new THREE.Object3D();
    _scatterColor = new THREE.Color();

    // Separate scene — no fog, no background (renders on top of main scene)
    _scatterScene = new THREE.Scene();

    _scatterGeo = new THREE.IcosahedronGeometry(0.025, 1);

    // Incandescent particle shader — bright hot core, soft edge falloff.
    // Tiny geometry + concentrated center lets bloom spread it into a natural glow halo.
    // Uses smooth normals derived from position (icosahedron vertices lie on a sphere).
    _scatterMat = new THREE.ShaderMaterial({
      vertexShader: [
        'varying vec3 vColor;',
        'varying vec3 vNormal;',
        'varying vec3 vViewPos;',
        'void main() {',
        '  vColor = instanceColor;',
        // Smooth sphere normal from position (icosahedron verts are on unit sphere)
        '  vec3 smoothN = normalize((instanceMatrix * vec4(normalize(position), 0.0)).xyz);',
        '  vNormal = normalize(normalMatrix * smoothN);',
        '  vec4 mvPos = modelViewMatrix * instanceMatrix * vec4(position, 1.0);',
        '  vViewPos = mvPos.xyz;',
        '  gl_Position = projectionMatrix * mvPos;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vColor;',
        'varying vec3 vNormal;',
        'varying vec3 vViewPos;',
        'void main() {',
        '  vec3 viewDir = normalize(-vViewPos);',
        '  float NdotV = max(dot(vNormal, viewDir), 0.0);',
        // Hot core: concentrated bright center (like incandescent metal)
        '  float core = pow(NdotV, 2.0);',
        // Soft rim glow: faint edge catch (Fresnel-like)
        '  float rim = pow(1.0 - NdotV, 3.0) * 0.15;',
        '  float intensity = core + rim;',
        '  gl_FragColor = vec4(vColor * intensity, 1.0);',
        '}'
      ].join('\n'),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      transparent: true
    });

    _scatterIMesh = new THREE.InstancedMesh(_scatterGeo, _scatterMat, SCATTER_MAX);
    _scatterIMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _scatterIMesh.frustumCulled = false;  // particles scatter across scene

    // Init instanceColor buffer (must call setColorAt once to create it)
    _scatterIMesh.setColorAt(0, new THREE.Color(0, 0, 0));

    // Init all instances to scale 0 (invisible)
    var zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
    for (var i = 0; i < SCATTER_MAX; i++) {
      _scatterIMesh.setMatrixAt(i, zeroMat);
      _scatterPool.push({ life: 0, maxLife: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, sc: 0, cr: 0, cg: 0, cb: 0 });
    }
    _scatterIMesh.instanceMatrix.needsUpdate = true;
    _scatterIMesh.count = SCATTER_MAX;

    _scatterScene.add(_scatterIMesh);
  }

  // Spawn a spark FROM a note's surface, radiating outward.
  // x,y,z = note center. dx,dy,dz = voice velocity (movement through timbral space).
  // The spark appears on the sphere surface and flies outward — like a hot ember
  // shed from an incandescent object as it moves through space.
  var NOTE_RADIUS = 0.03;  // must match _noteSharedGeo radius

  function _spawnScatter(x, y, z, color, dx, dy, dz) {
    var idx = _scatterIdx % SCATTER_MAX;
    var dot = _scatterPool[idx];
    _scatterIdx++;

    // 1. Random point on unit sphere (surface emission, not volume)
    var theta = Math.random() * Math.PI * 2;
    var cosP = 2 * Math.random() - 1;  // uniform on sphere
    var sinP = Math.sqrt(1 - cosP * cosP);
    var rx = sinP * Math.cos(theta);
    var ry = sinP * Math.sin(theta);
    var rz = cosP;

    // Spawn ON the note sphere surface — spark starts at the edge, not the center
    dot.x = x + rx * NOTE_RADIUS;
    dot.y = y + ry * NOTE_RADIUS;
    dot.z = z + rz * NOTE_RADIUS;

    // Voice color
    dot.cr = color.r * 1.3;
    dot.cg = color.g * 1.3;
    dot.cb = color.b * 1.3;

    // Scale 0.5-1.0
    dot.sc = 0.5 + Math.random() * 0.5;

    // 2. Velocity: radial outward from surface + voice movement bias
    // Like sparks from a grinder — they fly away from the surface,
    // biased in the direction the object is moving.
    var dLen = 0;
    if (dx || dy || dz) {
      dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    // Radial speed: how fast the spark leaves the surface
    var radialSpeed = 0.003 + Math.random() * 0.004;  // 0.003-0.007 units/frame

    if (dLen > 0.001) {
      // Blend: 60% radial (outward from surface) + 40% voice velocity (trailing behind)
      var inheritSpeed = Math.min(dLen * 0.02, 0.025);
      var ndx = dx / dLen, ndy = dy / dLen, ndz = dz / dLen;
      dot.vx = rx * radialSpeed * 0.6 + ndx * inheritSpeed * 0.4;
      dot.vy = ry * radialSpeed * 0.6 + ndy * inheritSpeed * 0.4;
      dot.vz = rz * radialSpeed * 0.6 + ndz * inheritSpeed * 0.4;
    } else {
      // No voice velocity — pure radial emission (omnidirectional from surface)
      dot.vx = rx * radialSpeed;
      dot.vy = ry * radialSpeed;
      dot.vz = rz * radialSpeed;
    }

    dot.life = 1.0;
    dot.maxLife = 6.0 + Math.random() * 9.0;  // 6-15s lingering dust
  }

  function _updateScatter(dt) {
    if (!_scatterIMesh) return;

    for (var i = 0; i < SCATTER_MAX; i++) {
      var dot = _scatterPool[i];
      if (dot.life <= 0) {
        // Dead — scale 0, black
        _scatterDummy.position.set(0, -100, 0);
        _scatterDummy.scale.set(0, 0, 0);
        _scatterDummy.updateMatrix();
        _scatterIMesh.setMatrixAt(i, _scatterDummy.matrix);
        _scatterColor.setRGB(0, 0, 0);
        _scatterIMesh.setColorAt(i, _scatterColor);
        continue;
      }

      dot.life -= dt / dot.maxLife;
      if (dot.life <= 0) {
        dot.life = 0;
        // Hide immediately — don't skip a frame
        _scatterDummy.position.set(0, -100, 0);
        _scatterDummy.scale.set(0, 0, 0);
        _scatterDummy.updateMatrix();
        _scatterIMesh.setMatrixAt(i, _scatterDummy.matrix);
        _scatterColor.setRGB(0, 0, 0);
        _scatterIMesh.setColorAt(i, _scatterColor);
        continue;
      }

      // Air resistance — sparks burst fast, decelerate visibly, linger as floating dust.
      // 0.992 per frame at 60fps: 62% velocity lost by 2s, 91% by 5s.
      // This IS the containment — drag stops sparks before they reach the box walls.
      var drag = 0.992;
      dot.vx *= drag;
      dot.vy *= drag;
      dot.vz *= drag;
      dot.x += dot.vx;
      dot.y += dot.vy;
      dot.z += dot.vz;

      // ── Size decay: quadratic → shrinks to zero (no floor) ──
      // Sparks are born small and shrink to nothing. The disappearance IS the decay.
      var sizeCurve = dot.life * dot.life;  // quadratic — accelerating shrink at end
      var s = dot.sc * sizeCurve;
      _scatterDummy.position.set(dot.x, dot.y, dot.z);
      _scatterDummy.scale.set(s, s, s);
      _scatterDummy.updateMatrix();
      _scatterIMesh.setMatrixAt(i, _scatterDummy.matrix);

      // ── Blackbody color cooling: white-hot → yellow → orange → red → dark ──
      // Maps life (1→0) to temperature (6500K → 800K)
      // Tanner Helland algorithm — physically-based color temperature
      var temp = 800 + dot.life * 5700;  // life 1.0=6500K (white), 0.0=800K (deep red)
      var t100 = temp / 100;
      var bbr, bbg, bbb;
      if (t100 <= 66) {
        bbr = 1.0;
        bbg = Math.max(0, Math.min(1, (99.47 * Math.log(t100) - 161.12) / 255));
        bbb = t100 <= 19 ? 0 : Math.max(0, Math.min(1, (138.52 * Math.log(t100 - 10) - 305.04) / 255));
      } else {
        bbr = Math.max(0, Math.min(1, 329.70 * Math.pow(t100 - 60, -0.1332) / 255));
        bbg = Math.max(0, Math.min(1, 288.12 * Math.pow(t100 - 60, -0.0755) / 255));
        bbb = 1.0;
      }

      // Blend: 55% blackbody + 45% voice color (identity visible but cooling dominates)
      var blend = 0.45;
      var fr = bbr * (1 - blend) + dot.cr * blend;
      var fg = bbg * (1 - blend) + dot.cg * blend;
      var fb = bbb * (1 - blend) + dot.cb * blend;

      // ── Brightness decay: separate from size ──
      // Cubic curve: stays bright longer, then fades.
      // Multiplier 1.5 compensates for hot-core shader (~50% average intensity).
      // Peak channel after shader: ~1.3 × 1.5 × 0.5 ≈ 0.98 — subordinate to notes (2.0-2.9).
      var brightCurve = dot.life * dot.life * dot.life;
      _scatterColor.setRGB(fr * brightCurve * 1.5, fg * brightCurve * 1.5, fb * brightCurve * 1.5);
      _scatterIMesh.setColorAt(i, _scatterColor);
    }

    _scatterIMesh.instanceMatrix.needsUpdate = true;
    if (_scatterIMesh.instanceColor) _scatterIMesh.instanceColor.needsUpdate = true;
  }


  // ══════════════════════════════════════════════════
  // COLLISION PARTICLE BURSTS (cross-voice interaction)
  // ══════════════════════════════════════════════════
  //
  // When notes from different voices are near each other, or a note
  // crosses another voice's trail, particles burst at the collision
  // point. More particles during PEAK — the visual climax indicator.
  //
  // Two collision types:
  //   1. Note-note: two live notes from different voices overlap in space
  //   2. Note-trail: a live note sits on/near another voice's trail line

  var _collisionTimer = 0;
  // Per-pair cooldown: a collision between two voices is a singular event,
  // not a continuous stream. After a burst, that pair is silent for 3 seconds
  // (they must separate and re-approach to collide again).
  var _collisionCooldowns = {};  // "voiceA_voiceB" → timestamp of last burst
  var COLLISION_COOLDOWN = 3.0;   // seconds between bursts for same voice pair

  // With agent pull removed, notes at the same pitch differ only by small z-fighting
  // offsets (±0.12). Collision radius covers same-pitch (0.3 apart) through nearby
  // scale degrees (circle-of-fifths neighbors ~1.0-1.5 apart).
  var COLLISION_RADIUS = 1.2;       // scene units — same pitch to neighboring scale degrees
  var COLLISION_RADIUS2 = COLLISION_RADIUS * COLLISION_RADIUS;
  var TRAIL_HIT_RADIUS = 0.8;      // scene units — note-to-trail-segment distance
  var TRAIL_HIT_RADIUS2 = TRAIL_HIT_RADIUS * TRAIL_HIT_RADIUS;

  // Full collision physics burst.
  // voiceA, voiceB = voice names (for velocity lookup).
  // posA, posB = { x, y, z } positions of the two colliding notes.
  // colorA, colorB = voice colors.
  // proximity = 0-1, how close the notes are (1 = touching, 0 = at radius edge).
  // sectionIntensity = 0-1, current section energy.
  function _spawnCollisionBurst(voiceA, voiceB, posA, posB, colorA, colorB, proximity, sectionIntensity) {
    // 1. Relative velocity — determines collision energy
    var va = _voiceVelocity[voiceA] || { vx: 0, vy: 0, vz: 0 };
    var vb = _voiceVelocity[voiceB] || { vx: 0, vy: 0, vz: 0 };

    // Relative velocity: how fast they approach each other
    var rvx = va.vx - vb.vx, rvy = va.vy - vb.vy, rvz = va.vz - vb.vz;
    var relSpeed = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);

    // Center-of-mass velocity: sparks drift with the average momentum
    var cmx = (va.vx + vb.vx) * 0.5;
    var cmy = (va.vy + vb.vy) * 0.5;
    var cmz = (va.vz + vb.vz) * 0.5;

    // 2. Collision normal (from B toward A)
    var dx = posA.x - posB.x, dy = posA.y - posB.y, dz = posA.z - posB.z;
    var cLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    var cnx = dx / cLen, cny = dy / cLen, cnz = dz / cLen;

    // 3. Perpendicular axes for deflection plane
    var ux = 0, uy = 1, uz = 0;
    if (Math.abs(cny) > 0.9) { ux = 1; uy = 0; uz = 0; }
    var px = cny * uz - cnz * uy, py = cnz * ux - cnx * uz, pz = cnx * uy - cny * ux;
    var pLen = Math.sqrt(px * px + py * py + pz * pz) || 1;
    px /= pLen; py /= pLen; pz /= pLen;
    var qx = cny * pz - cnz * py, qy = cnz * px - cnx * pz, qz = cnx * py - cny * px;

    // 4. Collision energy → spark count
    // Gentle brush = 1 spark. Head-on approach = 2-3 sparks. Never overwhelming.
    var energy = relSpeed * proximity * sectionIntensity;
    var count = Math.max(1, Math.min(3, 1 + Math.floor(energy * 4)));

    // Midpoint of collision
    var mx = (posA.x + posB.x) * 0.5;
    var my = (posA.y + posB.y) * 0.5;
    var mz = (posA.z + posB.z) * 0.5;

    // 5. Spawn sparks with physics-based velocity
    // Each spark carries the color of ONE of the two voices (alternating)
    // — so you see both voice identities in the debris
    for (var i = 0; i < count; i++) {
      // Alternate voice colors — half carry A, half carry B
      var sparkColor = (i % 2 === 0) ? colorA : colorB;

      // Deflection: random angle in the perpendicular plane
      var angle = Math.random() * Math.PI * 2;
      var perpDir_x = Math.cos(angle) * px + Math.sin(angle) * qx;
      var perpDir_y = Math.cos(angle) * py + Math.sin(angle) * qy;
      var perpDir_z = Math.cos(angle) * pz + Math.sin(angle) * qz;

      // Each spark gets a random share of the collision energy (Boltzmann-like)
      var u1 = Math.random(), u2 = Math.random();
      var boltzmann = Math.sqrt(-2 * Math.log(Math.max(u1, 0.001))) * Math.cos(2 * Math.PI * u2);
      var sparkEnergy = Math.abs(boltzmann) * 0.5 + 0.3;  // 0.3-1.5 range, peaked at 0.3

      // Perpendicular scatter (main direction) + some normal rebound + center-of-mass drift
      // Stronger scatter speeds for more realistic debris ejection
      var scatterSpeed = sparkEnergy * (relSpeed + 0.005) * 0.6;
      var reboundSpeed = sparkEnergy * (relSpeed + 0.005) * 0.25;
      var sdx = perpDir_x * scatterSpeed + cnx * reboundSpeed + cmx * 0.4;
      var sdy = perpDir_y * scatterSpeed + cny * reboundSpeed + cmy * 0.4;
      var sdz = perpDir_z * scatterSpeed + cnz * reboundSpeed + cmz * 0.4;

      _spawnScatter(mx, my, mz, sparkColor, sdx, sdy, sdz);
    }
  }

  function _emitCollisionBursts(dt) {
    // Throttle: check every ~50ms (not every frame)
    _collisionTimer += dt;
    if (_collisionTimer < 0.05) return;
    _collisionTimer = 0;

    var energy = _cachedSectionEnergy;
    // Burst intensity scales with section energy: quiet = subtle, peak = fireworks
    // Minimum 0.15 so collisions are always visible, scaled up to 1.0 at peak
    var intensity = 0.15 + energy * 0.85;

    // Collect active live notes
    var active = [];
    for (var id in _liveNotes) {
      var ln = _liveNotes[id];
      if (!ln.released && ln.mesh) active.push(ln);
    }

    // 1. Note-note collisions: different voices, close proximity
    // Each voice pair can only collide once per cooldown period — a collision
    // is a singular event (approach → burst → separate), not a continuous stream.
    var now = Date.now() / 1000;
    for (var i = 0; i < active.length; i++) {
      var a = active[i];
      for (var j = i + 1; j < active.length; j++) {
        var b = active[j];
        if (b.voiceName === a.voiceName) continue;

        var dx = a.mesh.position.x - b.mesh.position.x;
        var dy = a.mesh.position.y - b.mesh.position.y;
        var dz = a.mesh.position.z - b.mesh.position.z;
        var dist2 = dx * dx + dy * dy + dz * dz;

        if (dist2 < COLLISION_RADIUS2) {
          // Per-pair cooldown: skip if this pair collided recently
          var pairKey = a.voiceName < b.voiceName
            ? a.voiceName + '_' + b.voiceName
            : b.voiceName + '_' + a.voiceName;
          if (_collisionCooldowns[pairKey] && (now - _collisionCooldowns[pairKey]) < COLLISION_COOLDOWN) {
            continue;
          }
          _collisionCooldowns[pairKey] = now;

          var proximity = 1 - Math.sqrt(dist2) / COLLISION_RADIUS;
          var colA = COLORS[a.voiceName] || COLORS.human;
          var colB = COLORS[b.voiceName] || COLORS.human;
          _spawnCollisionBurst(
            a.voiceName, b.voiceName,
            a.mesh.position, b.mesh.position,
            colA, colB, proximity, intensity
          );
        }
      }
    }

    // 2. Note-trail collisions: a note near another voice's trail
    for (var ni = 0; ni < active.length; ni++) {
      var note = active[ni];
      var nx = note.mesh.position.x;
      var ny = note.mesh.position.y;
      var nz = note.mesh.position.z;
      var noteCol = COLORS[note.voiceName] || COLORS.human;

      for (var vi = 0; vi < ALL_VOICES.length; vi++) {
        var trailVoice = ALL_VOICES[vi];
        if (trailVoice === note.voiceName) continue; // skip own trail
        var trail = _trails[trailVoice];
        if (!trail || trail.activeCount < 2) continue;

        // Sample a few trail segments (not all — performance)
        var step = Math.max(1, Math.floor(trail.activeCount / 8));
        for (var ti = 0; ti < trail.activeCount - 1; ti += step) {
          if (trail.opacities[ti] < 0.05) continue;
          var t3 = ti * 3;
          // Closest point on segment to note: project note onto segment
          var sx = trail.positions[t3], sy = trail.positions[t3 + 1], sz = trail.positions[t3 + 2];
          var ex = trail.positions[t3 + 3], ey = trail.positions[t3 + 4], ez = trail.positions[t3 + 5];
          var edx = ex - sx, edy = ey - sy, edz = ez - sz;
          var segLen2 = edx * edx + edy * edy + edz * edz;
          if (segLen2 < 0.001) continue;
          var tt = Math.max(0, Math.min(1, ((nx - sx) * edx + (ny - sy) * edy + (nz - sz) * edz) / segLen2));
          var cx = sx + edx * tt, cy = sy + edy * tt, cz = sz + edz * tt;
          var cdx = nx - cx, cdy = ny - cy, cdz = nz - cz;
          var cdist2 = cdx * cdx + cdy * cdy + cdz * cdz;

          if (cdist2 < TRAIL_HIT_RADIUS2) {
            // Per-pair cooldown for trail grazes too
            var trailKey = note.voiceName < trailVoice
              ? note.voiceName + '_t_' + trailVoice
              : trailVoice + '_t_' + note.voiceName;
            if (_collisionCooldowns[trailKey] && (now - _collisionCooldowns[trailKey]) < COLLISION_COOLDOWN) {
              break;
            }
            _collisionCooldowns[trailKey] = now;

            var trailCol = COLORS[trailVoice] || COLORS.human;
            // Trail collision: very gentle — a note grazing a ghost path
            // Just 1 spark, inheriting the note's velocity
            var trailBlend = {
              r: (noteCol.r + trailCol.r) * 0.5,
              g: (noteCol.g + trailCol.g) * 0.5,
              b: (noteCol.b + trailCol.b) * 0.5
            };
            var nv = _voiceVelocity[note.voiceName] || { vx: 0, vy: 0, vz: 0 };
            _spawnScatter(cx, cy, cz, trailBlend, nv.vx + cdx * 0.3, nv.vy + cdy * 0.3, nv.vz + cdz * 0.3);
            break; // one spark per voice trail per note
          }
        }
      }
    }
  }


  // ══════════════════════════════════════════════════
  // NOTE COLOR BLENDING (harmonic overlap)
  // ══════════════════════════════════════════════════
  //
  // When notes from different voices are near each other, their colors
  // blend toward each other — the points themselves become the overlap
  // visualization. No extra sprites, just natural color mixing.

  var BLEND_RADIUS = 0.8;  // scene units — notes within this blend colors

  function _updateNoteBlending() {
    // Collect active (non-released) live notes
    var active = [];
    for (var id in _liveNotes) {
      var ln = _liveNotes[id];
      if (!ln.released) active.push(ln);
    }
    if (active.length < 2) return;

    var R2 = BLEND_RADIUS * BLEND_RADIUS;

    // For each note, accumulate blend color from nearby notes of other voices
    for (var i = 0; i < active.length; i++) {
      var a = active[i];
      var ownCol = COLORS[a.voiceName] || COLORS.human;
      var blendR = ownCol.r, blendG = ownCol.g, blendB = ownCol.b;
      var blendWeight = 0;

      for (var j = 0; j < active.length; j++) {
        if (i === j) continue;
        var b = active[j];
        if (b.voiceName === a.voiceName) continue;  // only blend across voices

        var dx = a.mesh.position.x - b.mesh.position.x;
        var dy = a.mesh.position.y - b.mesh.position.y;
        var dz = a.mesh.position.z - b.mesh.position.z;
        var dist2 = dx * dx + dy * dy + dz * dz;

        if (dist2 < R2) {
          // Closer = stronger blend (1.0 at overlap, 0.0 at radius edge)
          var proximity = 1 - Math.sqrt(dist2) / BLEND_RADIUS;
          var otherCol = COLORS[b.voiceName] || COLORS.human;
          blendR += otherCol.r * proximity;
          blendG += otherCol.g * proximity;
          blendB += otherCol.b * proximity;
          blendWeight += proximity;
        }
      }

      if (blendWeight > 0) {
        // Mix: own color + accumulated neighbor colors
        var total = 1 + blendWeight;
        var br = blendR / total, bg = blendG / total, bb = blendB / total;
        if (a.mat.uniforms) {
          a.mat.uniforms.uColor.value.setRGB(br, bg, bb);
        } else {
          a.mat.color.setRGB(br, bg, bb);
        }
      } else {
        // Reset to own voice color
        if (a.mat.uniforms) {
          a.mat.uniforms.uColor.value.setRGB(ownCol.r, ownCol.g, ownCol.b);
        } else {
          a.mat.color.setRGB(ownCol.r, ownCol.g, ownCol.b);
        }
      }
    }
  }


  // ══════════════════════════════════════════════════
  // SYNCHRONY THREADS (Kuramoto phase coupling)
  // ══════════════════════════════════════════════════

  function _initSyncThreads() {
    // Data-only — rendering via tube InstancedMesh pool
    var voicePairs = [];
    for (var i = 0; i < VOICES.length; i++) {
      for (var j = i + 1; j < VOICES.length; j++) {
        voicePairs.push([VOICES[i], VOICES[j]]);
      }
    }

    for (var p = 0; p < voicePairs.length; p++) {
      var pair = voicePairs[p];
      var col1 = COLORS[pair[0]];
      var col2 = COLORS[pair[1]];

      _syncLines.push({
        pair: pair,
        midColor: {
          r: (col1.r + col2.r) / 2,
          g: (col1.g + col2.g) / 2,
          b: (col1.b + col2.b) / 2
        },
        targetOpacity: 0,
        currentOpacity: 0
      });
    }
  }

  function _updateSyncThreads() {
    if (typeof PhaseCoupling === 'undefined') return;

    var state;
    try { state = PhaseCoupling.getState(); } catch(e) { return; }

    for (var s = 0; s < _syncLines.length; s++) {
      var sync = _syncLines[s];
      var v1 = sync.pair[0], v2 = sync.pair[1];

      var a1 = _agents[v1], a2 = _agents[v2];
      if (!a1 || !a2) continue;

      // Compute phase proximity
      var s1 = state[v1], s2 = state[v2];
      if (!s1 || !s2 || s1.phase === undefined || s2.phase === undefined) {
        sync.targetOpacity = 0;
        sync.currentOpacity += (0 - sync.currentOpacity) * 0.08;
        continue;
      }

      var phaseDiff = Math.abs(s1.phase - s2.phase);
      if (phaseDiff > Math.PI) phaseDiff = 2 * Math.PI - phaseDiff;

      var proximity = Math.max(0, 1 - phaseDiff / (Math.PI / 3));
      var amp1 = _spectral[v1] ? _spectral[v1].amplitude : 0;
      var amp2 = _spectral[v2] ? _spectral[v2].amplitude : 0;
      var bothPlaying = Math.min(amp1, amp2);

      sync.targetOpacity = proximity * proximity * bothPlaying * 0.55;
      sync.currentOpacity += (sync.targetOpacity - sync.currentOpacity) * 0.08;

      if (sync.currentOpacity < 0.005) continue;

      // Render as tube segment via InstancedMesh
      var mc = sync.midColor;
      _setTubeInstance(
        a1.mesh.position.x, a1.mesh.position.y, a1.mesh.position.z,
        a2.mesh.position.x, a2.mesh.position.y, a2.mesh.position.z,
        mc.r, mc.g, mc.b,
        sync.currentOpacity,
        1.5  // slightly thicker than trails for visibility
      );
    }
  }


  // ══════════════════════════════════════════════════
  // AXES + GRID (scientific measurement marks)
  // ══════════════════════════════════════════════════

  function _createAxes() {
    _axisGroup = new THREE.Group();

    var S = SPACE_SIZE;
    // Green-tinted grid to match BIOS/phosphor aesthetic
    var axisColor = new THREE.Color(0.15, 0.45, 0.25);
    var gridColor = new THREE.Color(0.06, 0.14, 0.08);
    var gridColorBright = new THREE.Color(0.10, 0.22, 0.12);

    // ── Batched line segments: collect pairs per material, then build one
    //    THREE.LineSegments per material group. 93 draw calls → 6. ──
    var batches = {
      axis:     { color: axisColor,      opacity: 0.50, verts: [] },
      grid:     { color: gridColor,      opacity: 0.18, verts: [] },
      gridBr:   { color: gridColorBright, opacity: 0.30, verts: [] },
      wall:     { color: gridColor,      opacity: 0.10, verts: [] },
      box:      { color: axisColor,      opacity: 0.60, verts: [] },
      tick:     { color: axisColor,      opacity: 0.28, verts: [] }
    };

    function pushSeg(batch, from, to) {
      batch.verts.push(from[0], from[1], from[2], to[0], to[1], to[2]);
    }

    // Main axes
    pushSeg(batches.axis, [-S, -S, -S], [S, -S, -S]);
    pushSeg(batches.axis, [-S, -S, -S], [-S, S, -S]);
    pushSeg(batches.axis, [-S, -S, -S], [-S, -S, S]);

    // Floor grid
    var divisions = 8;
    var step = (S * 2) / divisions;
    for (var i = 0; i <= divisions; i++) {
      var v = -S + i * step;
      var b = (i === 0 || i === divisions || i === divisions / 2) ? batches.gridBr : batches.grid;
      pushSeg(b, [-S, -S, v], [S, -S, v]);
      pushSeg(b, [v, -S, -S], [v, -S, S]);
    }

    // Wall grid
    for (var j = 0; j <= divisions; j++) {
      var w = -S + j * step;
      pushSeg(batches.wall, [-S, -S, w], [-S, S, w]);
      pushSeg(batches.wall, [-S, w, -S], [-S, w, S]);
      pushSeg(batches.wall, [w, -S, -S], [w, S, -S]);
      pushSeg(batches.wall, [-S, w, -S], [S, w, -S]);
    }

    // Bounding box
    pushSeg(batches.box, [-S, S, -S], [S, S, -S]);
    pushSeg(batches.box, [-S, S, -S], [-S, S, S]);
    pushSeg(batches.box, [S, S, -S], [S, S, S]);
    pushSeg(batches.box, [-S, S, S], [S, S, S]);
    pushSeg(batches.box, [S, -S, -S], [S, S, -S]);
    pushSeg(batches.box, [S, -S, S], [S, S, S]);
    pushSeg(batches.box, [-S, -S, S], [-S, S, S]);
    pushSeg(batches.box, [-S, -S, S], [S, -S, S]);
    pushSeg(batches.box, [S, -S, -S], [S, -S, S]);

    // Tick marks
    var tickLen = 0.12;
    for (var t = 0; t <= divisions; t++) {
      var tv = -S + t * step;
      pushSeg(batches.tick, [tv, -S, -S], [tv, -S + tickLen, -S]);
      pushSeg(batches.tick, [-S, tv, -S], [-S + tickLen, tv, -S]);
      pushSeg(batches.tick, [-S, -S, tv], [-S, -S + tickLen, tv]);
    }

    // Build one LineSegments per batch
    for (var key in batches) {
      var batch = batches[key];
      if (batch.verts.length === 0) continue;
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(batch.verts), 3));
      var mat = new THREE.LineBasicMaterial({
        color: batch.color,
        transparent: true,
        opacity: batch.opacity,
        depthWrite: false
      });
      var segs = new THREE.LineSegments(geo, mat);
      segs.frustumCulled = false;
      _axisGroup.add(segs);
    }

    // Axis labels using sprites with canvas text — scaled for smaller scene
    _createAxisLabel('SPECTRAL CENTROID', S + 0.8, -S, -S, 0.18);
    _createAxisLabel('DENSITY', -S, S + 0.8, -S, 0.18);
    _createAxisLabel('FLATNESS', -S, -S, S + 0.8, 0.18);

    _scene.add(_axisGroup);
  }

  function _createAxisLabel(text, x, y, z, scale) {
    var canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    var ctx2 = canvas.getContext('2d');
    ctx2.fillStyle = 'rgba(0,0,0,0)';
    ctx2.fillRect(0, 0, 512, 128);
    ctx2.font = '36px "Share Tech Mono", monospace';
    ctx2.fillStyle = 'rgba(51, 255, 51, 0.18)';  // green phosphor to match HUD
    ctx2.textAlign = 'center';
    ctx2.fillText(text.toUpperCase(), 256, 80);

    var tex = new THREE.CanvasTexture(canvas);
    var mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true
    });
    var sprite = new THREE.Sprite(mat);
    sprite.position.set(x, y, z);
    sprite.scale.set(scale * 8, scale * 2, 1);
    _axisGroup.add(sprite);
  }


  // ══════════════════════════════════════════════════
  // NOTE EVENT TRACKING (from VoiceManager + SoundEngine)
  // ══════════════════════════════════════════════════

  // Track active notes — sustain-linked visualization
  // Notes appear as glowing points while sounding, lines between simultaneous notes,
  // fade on release. The timbral space fills with fleeting luminous geometry.
  var _prevActiveNotes = {};

  // Live note objects: { id, voiceName, midi, pc, mesh, glowSprite, startTime, released, fadeAlpha }
  var _liveNotes = {};
  // Live note connecting lines per voice: { voiceName: THREE.Line }
  var _liveNoteLines = {};

  // ── Procedural glow ShaderMaterial for note spheres ──
  // Fresnel edge glow + bright core + energy filaments — all computed in GLSL
  var _glowVertShader = [
    'varying vec3 vNormal;',
    'varying vec3 vViewPos;',
    'varying vec2 vUv;',
    'void main() {',
    '  vNormal = normalize(normalMatrix * normal);',
    '  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);',
    '  vViewPos = mvPos.xyz;',
    '  vUv = uv;',
    '  gl_Position = projectionMatrix * mvPos;',
    '}'
  ].join('\n');

  var _glowFragShader = [
    'uniform vec3 uColor;',
    'uniform float uTime;',
    'uniform float uOpacity;',
    'varying vec3 vNormal;',
    'varying vec3 vViewPos;',
    'varying vec2 vUv;',

    // Simple hash for procedural noise
    'float hash(vec2 p) {',
    '  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);',
    '}',

    // Smooth noise
    'float noise(vec2 p) {',
    '  vec2 i = floor(p);',
    '  vec2 f = fract(p);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  float a = hash(i);',
    '  float b = hash(i + vec2(1.0, 0.0));',
    '  float c = hash(i + vec2(0.0, 1.0));',
    '  float d = hash(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);',
    '}',

    'void main() {',
    '  vec3 viewDir = normalize(-vViewPos);',
    '  float NdotV = dot(vNormal, viewDir);',

    // Solid core vs glow buffer: inner 80% (0.024) is solid, outer 20% (0.006) is glow
    // NdotV ~0.6 corresponds to the visual edge of the solid core on a sphere
    '  float coreEdge = 0.6;',
    '  float solidCore = smoothstep(coreEdge - 0.05, coreEdge + 0.05, NdotV);',

    // Energy filaments — procedural noise crawling across surface
    '  vec2 noiseCoord = vUv * 8.0 + uTime * 0.3;',
    '  float filament1 = noise(noiseCoord);',
    '  float filament2 = noise(noiseCoord * 2.3 + 5.7);',
    '  float filaments = pow(filament1 * filament2, 0.8);',

    // Glow buffer: soft Fresnel falloff in the outer shell
    '  float glowFalloff = pow(max(NdotV, 0.0), 0.8);',

    // Combine: solid bright core + soft glow buffer with filament detail
    '  float coreIntensity = solidCore * (1.5 + filaments * 0.3);',
    '  float glowIntensity = (1.0 - solidCore) * glowFalloff * (0.6 + filaments * 0.4);',
    '  float intensity = coreIntensity + glowIntensity;',

    // Color output — overbright for bloom
    '  vec3 col = uColor * intensity * 2.0;',
    '  gl_FragColor = vec4(col * uOpacity, 1.0);',
    '}'
  ].join('\n');

  // ── Live note mesh pool ──
  // Pre-allocate meshes to avoid per-note new SphereGeometry + ShaderMaterial.
  // BEFORE: new geo+mat every note onset, never disposed = GC pressure + GPU alloc.
  // AFTER: shared geometry, pool of 32 meshes reused via acquire/release.
  var _notePool = [];
  var _notePoolFree = [];
  var NOTE_POOL_SIZE = 32;  // max simultaneous live notes (6 voices rarely exceed 24)
  var _noteSharedGeo = null;

  function _initNotePool() {
    _noteSharedGeo = new THREE.SphereGeometry(0.03, 16, 16);
    for (var i = 0; i < NOTE_POOL_SIZE; i++) {
      var mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(1, 1, 1) },
          uTime: { value: Math.random() * 100 },
          uOpacity: { value: 0 }
        },
        vertexShader: _glowVertShader,
        fragmentShader: _glowFragShader,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.FrontSide
      });
      var mesh = new THREE.Mesh(_noteSharedGeo, mat);
      mesh.visible = false;
      _scene.add(mesh);
      _notePool.push({ mesh: mesh, mat: mat });
      _notePoolFree.push(i);
    }
  }

  function _createLiveNoteMesh(voiceName, x, y, z) {
    var col = COLORS[voiceName] || COLORS.human;

    // Acquire from pool
    if (_notePoolFree.length > 0) {
      var idx = _notePoolFree.pop();
      var pooled = _notePool[idx];
      pooled.mesh.position.set(x, y, z);
      pooled.mesh.scale.set(1, 1, 1);
      pooled.mesh.visible = true;
      pooled.mat.uniforms.uColor.value.setRGB(col.r, col.g, col.b);
      pooled.mat.uniforms.uTime.value = Math.random() * 100;
      pooled.mat.uniforms.uOpacity.value = 1.0;
      pooled._poolIdx = idx;
      return pooled;
    }

    // Fallback: all pool slots in use — create ephemeral (rare)
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(col.r, col.g, col.b) },
        uTime: { value: Math.random() * 100 },
        uOpacity: { value: 1.0 }
      },
      vertexShader: _glowVertShader,
      fragmentShader: _glowFragShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide
    });
    var mesh = new THREE.Mesh(_noteSharedGeo, mat);
    mesh.position.set(x, y, z);
    _scene.add(mesh);
    return { mesh: mesh, mat: mat, _poolIdx: -1 };
  }

  function _releaseLiveNoteMesh(objs) {
    if (objs._poolIdx >= 0) {
      // Return to pool — hide, don't remove from scene
      objs.mesh.visible = false;
      objs.mat.uniforms.uOpacity.value = 0;
      _notePoolFree.push(objs._poolIdx);
    } else {
      // Ephemeral fallback — remove from scene
      _scene.remove(objs.mesh);
    }
  }

  // ── Circle of fifths mapping for note positions ──
  // Pitch classes ordered by fifths: C→G→D→A→E→B→F#→C#→Ab→Eb→Bb→F
  // Harmonically related notes (C near G, G near D) are spatially close.
  // Krumhansl & Kessler 1982 — perceptual key distance follows CoF.
  var _FIFTHS_ORDER = [0,7,2,9,4,11,6,1,8,3,10,5];
  var _FIFTHS_ANGLE = [];
  for (var _fi = 0; _fi < 12; _fi++) {
    _FIFTHS_ANGLE[_FIFTHS_ORDER[_fi]] = (_fi / 12) * Math.PI * 2;
  }
  // Voice regional offsets — minimal stagger to prevent z-fighting on
  // identical pitches, but voices freely overlap in harmonic space.
  var _VOICE_NOTE_OFFSET = {
    bass:       { x: -0.12, z: -0.08 },
    rhythm:     { x:  0.12, z: -0.08 },
    soloist:    { x:  0.10, z:  0.10 },
    lead:       { x: -0.10, z:  0.10 },
    percussion: { x:  0.00, z:  0.15 },
    human:      { x:  0.00, z:  0.00 }
  };

  function _getNotePosition(voiceName, midi) {
    var pc = ((midi % 12) + 12) % 12;
    var octave = Math.floor(midi / 12) - 1;  // MIDI 60 = C4 → octave 4

    // Y = octave height. Octave 4 (middle C) centered at 0.
    // Each octave = 1.4 scene units. Clamp to ±SPACE_SIZE.
    var y = (octave - 4) * 1.4;
    y = Math.max(-SPACE_SIZE + 0.5, Math.min(SPACE_SIZE - 0.5, y));

    // X/Z = circle of fifths angle + voice offset
    var angle = _FIFTHS_ANGLE[pc] || 0;
    var radius = 2.2;  // spread across horizontal plane
    var offset = _VOICE_NOTE_OFFSET[voiceName] || _VOICE_NOTE_OFFSET.human;

    var x = Math.cos(angle) * radius + offset.x;
    var z = Math.sin(angle) * radius + offset.z;

    // Agent pull removed — notes sit at their true harmonic position
    // (circle-of-fifths + octave). Voice color identifies the emitter.
    // Small z-fighting offsets (_VOICE_NOTE_OFFSET) prevent mesh overlap.
    // Collisions between voices now represent real harmonic proximity.

    return { x: x, y: y, z: z };
  }

  function _pollNoteEvents() {
    var now = Date.now();

    for (var vi = 0; vi < ALL_VOICES.length; vi++) {
      var voiceName = ALL_VOICES[vi];
      var detailed = [];

      try {
        if (voiceName === 'human') {
          if (typeof SoundEngine !== 'undefined' && SoundEngine.getActiveNotes) {
            var raw = SoundEngine.getActiveNotes('human') || [];
            for (var r = 0; r < raw.length; r++) {
              detailed.push({
                noteId: raw[r].noteId,
                midi: raw[r].midi,
                pc: ((raw[r].midi % 12) + 12) % 12,
                startTime: raw[r].startTime
              });
            }
          }
        } else if (typeof VoiceManager !== 'undefined') {
          detailed = VoiceManager.getActiveNotesDetailed(voiceName) || [];
        }
      } catch(e) { continue; }

      var prev = _prevActiveNotes[voiceName] || {};
      var current = {};

      // Detect new notes
      for (var n = 0; n < detailed.length; n++) {
        var note = detailed[n];
        var id = voiceName + '_' + (note.noteId || (note.midi + '_' + note.startTime));
        current[id] = true;

        if (!prev[id] && !_liveNotes[id]) {
          // New note — create glowing point
          var pos = _getNotePosition(voiceName, note.midi);
          var objs = _createLiveNoteMesh(voiceName, pos.x, pos.y, pos.z);
          _liveNotes[id] = {
            id: id,
            voiceName: voiceName,
            midi: note.midi,
            pc: note.pc,
            mesh: objs.mesh,
            mat: objs.mat,
            startTime: now,
            released: false,
            fadeAlpha: 1.0
          };
          // Also add to trail for persistence
          _addTrailPoint(voiceName, pos.x, pos.y, pos.z);

          // Track voice velocity in timbral space (for collision physics)
          var sdx = 0, sdy = 0, sdz = 0;
          var trail = _trails[voiceName];
          if (trail && trail.activeCount >= 2) {
            var ti = (trail.activeCount - 2) * 3;
            sdx = pos.x - trail.positions[ti];
            sdy = pos.y - trail.positions[ti + 1];
            sdz = pos.z - trail.positions[ti + 2];
          }
          _voiceVelocity[voiceName] = { vx: sdx, vy: sdy, vz: sdz };

          // Note onset sparks: each note sheds 2-4 embers as it appears
          // Subtle dust from a voice arriving in the space
          var col = COLORS[voiceName] || COLORS.human;
          var leapDist = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz);
          // Step = 2 embers. Leap = 3-4 embers. Proportional to movement energy.
          var emitCount = Math.max(2, Math.min(4, 2 + Math.floor(leapDist * 1.2)));
          for (var si = 0; si < emitCount; si++) {
            _spawnScatter(pos.x, pos.y, pos.z, col, sdx, sdy, sdz);
          }
        }
      }

      // Detect released notes
      for (var prevId in prev) {
        if (!current[prevId] && _liveNotes[prevId]) {
          _liveNotes[prevId].released = true;
        }
      }

      _prevActiveNotes[voiceName] = current;
    }

    // Update live notes: fade released, remove dead
    var toRemove = [];
    for (var lnId in _liveNotes) {
      var ln = _liveNotes[lnId];

      if (ln.released) {
        ln.fadeAlpha -= 0.03;  // ~30 frames to fade
        if (ln.fadeAlpha <= 0) {
          toRemove.push(lnId);
          _releaseLiveNoteMesh(ln);
          continue;
        }
      } else {
        // Subtle breathing pulse while sustained
        var age = (now - ln.startTime) / 1000;
        ln.fadeAlpha = 0.7 + Math.sin(age * 3) * 0.3;
      }

      // Update shader uniforms — opacity + animate filaments
      if (ln.mat.uniforms) {
        ln.mat.uniforms.uOpacity.value = ln.fadeAlpha;
        ln.mat.uniforms.uTime.value += 0.016;  // ~60fps tick
      } else {
        ln.mat.opacity = ln.fadeAlpha * 0.9;
      }
      // Scale sphere slightly with fade for breathing effect
      var s = 0.8 + ln.fadeAlpha * 0.4;
      ln.mesh.scale.set(s, s, s);
    }
    for (var ri = 0; ri < toRemove.length; ri++) {
      delete _liveNotes[toRemove[ri]];
    }

    // Update connecting lines between simultaneous live notes per voice
    _updateLiveNoteLines();
  }

  function _updateLiveNoteLines() {
    // Group live notes by voice and render chord shapes via InstancedMesh.
    // When a voice has 2+ simultaneous notes, connect ALL pairs to form
    // a polygon/triangle — reads as a chord shape, not just a chain.
    var perVoice = {};
    for (var id in _liveNotes) {
      var ln = _liveNotes[id];
      if (!perVoice[ln.voiceName]) perVoice[ln.voiceName] = [];
      perVoice[ln.voiceName].push(ln);
    }

    for (var vi = 0; vi < ALL_VOICES.length; vi++) {
      var v = ALL_VOICES[vi];
      var notes = perVoice[v] || [];
      if (notes.length < 2) continue;

      var col = COLORS[v] || COLORS.human;
      var minAlpha = 1.0;
      for (var ni = 0; ni < notes.length; ni++) {
        if (notes[ni].fadeAlpha < minAlpha) minAlpha = notes[ni].fadeAlpha;
      }

      // Connect ALL pairs — triangle for triads, polygon for larger chords
      for (var a = 0; a < notes.length; a++) {
        for (var b = a + 1; b < notes.length; b++) {
          var p1 = notes[a].mesh.position;
          var p2 = notes[b].mesh.position;
          _setTubeInstance(
            p1.x, p1.y, p1.z,
            p2.x, p2.y, p2.z,
            col.r, col.g, col.b,
            minAlpha * 0.6,
            1.3  // slightly thicker than trail
          );
        }
      }
    }
  }


  // Phase-driven agent movement data (used in animation loop)
  var _phaseMotion = {};

  function _updatePhaseMotion() {
    if (typeof PhaseCoupling === 'undefined') return;

    var state;
    try { state = PhaseCoupling.getState(); } catch(e) { return; }

    for (var vi = 0; vi < VOICES.length; vi++) {
      var v = VOICES[vi];
      var vState = state[v];
      if (!vState || vState.phase === undefined) continue;

      var barEmphasis = 1.0;
      try { barEmphasis = PhaseCoupling.getBarEmphasis(v); } catch(e) {}
      _phaseMotion[v] = {
        phase: vState.phase || 0,
        readiness: vState.readiness || 0,
        barEmphasis: barEmphasis
      };
    }
  }


  // ══════════════════════════════════════════════════
  // SECTION STATE ENERGY (from SectionTracker)
  // ══════════════════════════════════════════════════
  //
  // Tracks section energy for particle burst scaling.
  // Background stays neutral dark — energy is communicated through
  // particle density and collision bursts, not scene tinting.

  function _updateSectionAmbience() {
    if (typeof SectionTracker === 'undefined' || !_scene) return;

    var st;
    try { st = SectionTracker.getState(); } catch(e) { return; }
    if (!st) return;

    var energy = st.energy || 0;
    _cachedSectionEnergy = energy;

    // Fog density inversely proportional to energy (more visible space when energetic)
    if (_scene.fog) {
      _scene.fog.density = 0.012 - energy * 0.005;
    }
  }


  // ══════════════════════════════════════════════════
  // HARMONIC PREDICTION GLOW (from HarmonicPlanner)
  // ══════════════════════════════════════════════════
  //
  // When the harmonic planner predicts the next chord with confidence,
  // dim markers appear at the predicted chord-tone positions in the space.

  var _chordMarkers = [];
  var CHORD_MARKER_MAX = 6;

  function _initChordMarkers() {
    var geo = new THREE.SphereGeometry(0.08, 8, 8);
    for (var i = 0; i < CHORD_MARKER_MAX; i++) {
      var mat = new THREE.MeshBasicMaterial({
        color: 0x445566,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      _scene.add(mesh);
      _chordMarkers.push(mesh);
    }
  }

  function _updateChordPredictions() {
    if (typeof HarmonicPlanner === 'undefined') return;

    var tones, confidence;
    try {
      tones = HarmonicPlanner.getNextChordTones ? HarmonicPlanner.getNextChordTones() : null;
      confidence = HarmonicPlanner.getConfidence ? HarmonicPlanner.getConfidence() : 0;
    } catch(e) { return; }

    // Hide all markers first
    for (var i = 0; i < CHORD_MARKER_MAX; i++) {
      _chordMarkers[i].visible = false;
    }

    if (!tones || confidence < 0.1) return;

    // Position chord tones in the space
    for (var t = 0; t < tones.length && t < CHORD_MARKER_MAX; t++) {
      var pc = tones[t];
      // Map pitch class to horizontal position (0-11 → spread across X)
      var x = ((pc / 12) - 0.5) * SPACE_SIZE * 1.2;
      var y = -SPACE_SIZE * 0.6;  // below center (harmonic floor)
      var z = 0;

      _chordMarkers[t].position.set(x, y, z);
      _chordMarkers[t].material.opacity = confidence * 0.2;
      _chordMarkers[t].visible = true;

      // Scale with confidence
      var s = 0.5 + confidence * 1.5;
      _chordMarkers[t].scale.set(s, s, s);
    }
  }



  // ══════════════════════════════════════════════════
  // ENSEMBLE HUD (real-time data overlay)
  // ══════════════════════════════════════════════════
  //
  // Minimal text overlay showing real operating data:
  // BPM, section state, order parameter, active key.
  // Uses HTML overlay (not 3D text) for crisp rendering.

  var _hudElement = null;

  function _createHUD() {
    // ── Title label (top-left) ──
    var titleEl = document.createElement('div');
    titleEl.id = 'timbralTitle';
    titleEl.style.cssText = 'position:fixed;top:16px;left:20px;z-index:100;font-family:"Share Tech Mono",monospace;font-size:10px;letter-spacing:3px;color:rgba(51,255,51,0.22);pointer-events:none;user-select:none;text-transform:uppercase';
    titleEl.textContent = 'VELES v8.10.2';
    document.body.appendChild(titleEl);

    // ── Data readout + controls (top-right) ──
    _hudElement = document.createElement('div');
    _hudElement.id = 'timbralHUD';
    _hudElement.style.cssText = 'position:fixed;top:14px;right:20px;z-index:100;font-family:"Share Tech Mono",monospace;font-size:10px;color:rgba(51,255,51,0.40);letter-spacing:1.5px;line-height:1.7;user-select:none;text-align:right';
    document.body.appendChild(_hudElement);

    // ── Bottom-left keyboard hint ──
    var hintEl = document.createElement('div');
    hintEl.id = 'timbralHint';
    hintEl.style.cssText = 'position:fixed;bottom:14px;left:20px;z-index:100;font-family:"Share Tech Mono",monospace;font-size:8px;letter-spacing:1px;color:rgba(51,255,51,0.15);pointer-events:none;user-select:none';
    hintEl.innerHTML = 'LEFT-DRAG ORBIT · RIGHT-DRAG PAN · SCROLL ZOOM · A-L KEYS PLAY';
    document.body.appendChild(hintEl);
  }

  var _specReadout = null;

  // Shared button style for HUD — green phosphor matching BIOS
  var _btnStyle = 'cursor:pointer;pointer-events:auto;font-family:"Share Tech Mono",monospace;font-size:9px;letter-spacing:2px;display:inline-block;padding:3px 10px;text-transform:uppercase;';
  var _btnOn = _btnStyle + 'color:rgba(51,255,51,0.65);border:1px solid rgba(51,255,51,0.25);text-shadow:0 0 6px rgba(51,255,51,0.3);';
  var _btnOff = _btnStyle + 'color:rgba(51,255,51,0.25);border:1px solid rgba(51,255,51,0.10);';

  function _updateHUD() {
    if (!_hudElement) return;

    var lines = [];

    // BPM — large, prominent
    try {
      if (typeof PhaseCoupling !== 'undefined') {
        var bpm = PhaseCoupling.getConsensusBPM();
        lines.push('<span style="font-size:14px;color:rgba(51,255,51,0.50);letter-spacing:3px;text-shadow:0 0 8px rgba(51,255,51,0.15)">' + Math.round(bpm) + ' BPM</span>');
      }
    } catch(e) {}

    // Section state
    try {
      if (typeof SectionTracker !== 'undefined') {
        var st = SectionTracker.getState();
        lines.push('<span style="color:rgba(51,255,51,0.30);font-size:9px;letter-spacing:2px">' + st.state + '</span>');
      }
    } catch(e) {}

    // Key + mode
    try {
      if (typeof SharedState !== 'undefined') {
        var NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        var keyName = NOTE_NAMES[SharedState.keyC || 0] || 'C';
        var modeName = SharedState.modeName || SharedState.mode || 'minor';
        lines.push('<span style="color:rgba(51,255,51,0.30);font-size:9px;letter-spacing:2px">' + keyName + ' ' + modeName.toUpperCase() + '</span>');
      }
    } catch(e) {}

    // Spacer
    lines.push('<span style="display:block;height:6px"></span>');

    // Reset button
    lines.push('<span id="hudResetBtn" style="' + _btnOff + '" onclick="if(typeof resetAll===\'function\')resetAll()">↺ RESET</span>');

    // Auto toggle button — green phosphor style
    var autoState = false;
    try { autoState = typeof _autoRunning !== 'undefined' ? _autoRunning : (document.getElementById('bAuto') && document.getElementById('bAuto').classList.contains('on')); } catch(e) {}
    lines.push('<span id="hudAutoBtn" style="' + (autoState ? _btnOn : _btnOff) + 'margin-top:3px" onclick="if(typeof toggleAuto===\'function\')toggleAuto()">' + (autoState ? '■ AUTO' : '▶ AUTO') + '</span>');

    // Settings button — same style
    lines.push('<span id="hudSettingsBtn" style="' + _btnOff + 'margin-top:3px" onclick="if(typeof showSettings===\'function\')showSettings()">⚙ CONFIG</span>');

    // Record button
    var recActive = typeof window._isRecording === 'function' && window._isRecording();
    lines.push('<span id="hudRecBtn" style="' + (recActive ? _btnOn + 'color:rgba(224,60,60,0.75);border-color:rgba(224,60,60,0.35);text-shadow:0 0 6px rgba(224,60,60,0.3);' : _btnOff) + 'margin-top:3px" onclick="if(typeof window._toggleRecording===\'function\')window._toggleRecording()">' + (recActive ? '● REC' : '○ REC') + '</span>');

    _hudElement.innerHTML = lines.join('<br>');

  }


  // ══════════════════════════════════════════════════
  // CAMERA CONTROLLER
  // ══════════════════════════════════════════════════

  var _cameraAngle = Math.PI * 0.45;  // start facing center (along Z toward origin)
  var _cameraVertOsc = 0;

  // User camera control state
  var _userDragging = false;
  var _userPanning = false;     // right-click pan mode
  var _userDragX = 0, _userDragY = 0;
  var _userAngleOffset = 0;    // horizontal offset from mouse drag (left-click orbit)
  var _userElevOffset = 0;     // vertical offset from mouse drag
  var _userPanX = 0;           // horizontal pan offset (right-click)
  var _userPanY = 0;           // vertical pan offset (right-click)
  var _orbitPaused = false;    // pause auto-orbit while user drags
  var _orbitResumeTimer = 0;
  var _userZoom = 0;           // scroll zoom offset

  function _initCameraControls() {
    if (!_renderer) return;
    var el = _renderer.domElement;

    // Prevent context menu on right-click
    el.addEventListener('contextmenu', function(e) { e.preventDefault(); });

    el.addEventListener('mousedown', function(e) {
      if (e.button === 0) {
        // Left-click: orbit
        _userDragging = true;
        _userDragX = e.clientX;
        _userDragY = e.clientY;
        _orbitPaused = true;
        el.style.cursor = 'grabbing';
      } else if (e.button === 2) {
        // Right-click: pan (move look-at point)
        _userPanning = true;
        _userDragX = e.clientX;
        _userDragY = e.clientY;
        _orbitPaused = true;
        el.style.cursor = 'move';
      }
    });

    window.addEventListener('mousemove', function(e) {
      if (_userDragging) {
        var dx = e.clientX - _userDragX;
        var dy = e.clientY - _userDragY;
        _userAngleOffset += dx * 0.005;
        _userElevOffset = Math.max(-0.6, Math.min(0.8, _userElevOffset - dy * 0.003));
        _userDragX = e.clientX;
        _userDragY = e.clientY;
      } else if (_userPanning) {
        var dx = e.clientX - _userDragX;
        var dy = e.clientY - _userDragY;
        _userPanX += dx * 0.015;
        _userPanY -= dy * 0.015;
        // Clamp pan so you don't lose the scene
        _userPanX = Math.max(-8, Math.min(8, _userPanX));
        _userPanY = Math.max(-8, Math.min(8, _userPanY));
        _userDragX = e.clientX;
        _userDragY = e.clientY;
      }
    });

    window.addEventListener('mouseup', function(e) {
      if (_userDragging || _userPanning) {
        _userDragging = false;
        _userPanning = false;
        el.style.cursor = 'default';
        _orbitResumeTimer = 5.0;
      }
    });

    // Scroll to zoom
    el.addEventListener('wheel', function(e) {
      e.preventDefault();
      _userZoom = Math.max(-15, Math.min(15, _userZoom + e.deltaY * 0.02));
    }, { passive: false });
  }

  function _updateCamera(dt) {
    // Resume auto-orbit after user stops dragging
    if (_orbitPaused && !_userDragging) {
      _orbitResumeTimer -= dt;
      if (_orbitResumeTimer <= 0) {
        _orbitPaused = false;
      }
    }

    // Slow azimuthal orbit (paused during/after user drag)
    if (!_orbitPaused) {
      _cameraAngle += (2 * Math.PI / CAMERA_ORBIT_PERIOD) * dt;
      if (_cameraAngle > 2 * Math.PI) _cameraAngle -= 2 * Math.PI;
    }

    // Very gentle vertical oscillation (barely perceptible)
    _cameraVertOsc += dt * 0.02;
    var elevation = CAMERA_ELEVATION + Math.sin(_cameraVertOsc) * 0.02 + _userElevOffset;

    var totalAngle = _cameraAngle + _userAngleOffset;
    var dist = CAMERA_DISTANCE + _userZoom;

    var cx = Math.cos(totalAngle) * dist * Math.cos(elevation);
    var cy = Math.sin(elevation) * dist * 0.5 + 0.3;
    var cz = Math.sin(totalAngle) * dist * Math.cos(elevation);

    // Apply pan offset (right-click drag moves the look-at point)
    var lookX = _userPanX;
    var lookY = _userPanY;

    _camera.position.set(cx + lookX, cy + lookY, cz);
    _camera.lookAt(lookX, lookY, 0);
  }


  // ══════════════════════════════════════════════════
  // POST-PROCESSING: Multi-pass bloom
  // ══════════════════════════════════════════════════
  //
  // Minimal bloom pipeline without Three.js postprocessing addon:
  // 1. Render scene to off-screen target (full res)
  // 2. Downsample + threshold to bright-pass target (1/4 res)
  // 3. Gaussian blur (ping-pong, 2 passes)
  // 4. Composite: original + blurred bloom overlay
  //
  // All using full-screen quads with custom shaders.

  var _bloomEnabled = true;
  var _rtScene, _rtBrightPass, _rtBlurA, _rtBlurB;
  var _brightQuad, _blurQuad, _compositeQuad;
  var _bloomCamera;
  var _bloomScene;

  // Threshold + downsample shader
  var BRIGHT_PASS_FRAG = [
    'uniform sampler2D tDiffuse;',
    'uniform float uThreshold;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec4 color = texture2D(tDiffuse, vUv);',
    '  float brightness = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));',
    '  float contribution = max(0.0, brightness - uThreshold);',
    '  contribution = contribution / (contribution + 1.0);',  // soft knee
    '  gl_FragColor = vec4(color.rgb * contribution, 1.0);',
    '}'
  ].join('\n');

  // Gaussian blur (horizontal or vertical depending on uniform)
  var BLUR_FRAG = [
    'uniform sampler2D tDiffuse;',
    'uniform vec2 uDirection;',
    'uniform vec2 uResolution;',
    'varying vec2 vUv;',
    '',
    'void main() {',
    '  vec2 texel = uDirection / uResolution;',
    '  vec4 sum = vec4(0.0);',
    '  sum += texture2D(tDiffuse, vUv - 4.0 * texel) * 0.0162;',
    '  sum += texture2D(tDiffuse, vUv - 3.0 * texel) * 0.0540;',
    '  sum += texture2D(tDiffuse, vUv - 2.0 * texel) * 0.1216;',
    '  sum += texture2D(tDiffuse, vUv - 1.0 * texel) * 0.1945;',
    '  sum += texture2D(tDiffuse, vUv) * 0.2270;',
    '  sum += texture2D(tDiffuse, vUv + 1.0 * texel) * 0.1945;',
    '  sum += texture2D(tDiffuse, vUv + 2.0 * texel) * 0.1216;',
    '  sum += texture2D(tDiffuse, vUv + 3.0 * texel) * 0.0540;',
    '  sum += texture2D(tDiffuse, vUv + 4.0 * texel) * 0.0162;',
    '  gl_FragColor = sum;',
    '}'
  ].join('\n');

  // Final composite: scene + bloom + comprehensive CRT simulation
  // Reference: BabylonJS CRT study, Shadertoy "Cathode" by Mattias
  var COMPOSITE_FRAG = [
    'uniform sampler2D tScene;',
    'uniform sampler2D tBloom;',
    'uniform float uBloomStrength;',
    'uniform float uTime;',
    'uniform vec2 uResolution;',
    'varying vec2 vUv;',

    // ── Barrel distortion (Lottes 2014 CRT model) ──
    'vec2 crtDistort(vec2 uv) {',
    '  vec2 cc = uv - 0.5;',
    '  float r2 = dot(cc, cc);',
    '  float f = 1.0 + r2 * (0.14 + r2 * 0.08);',  // aggressive curvature
    '  return cc * f + 0.5;',
    '}',

    // ── Hash for noise ──
    'float hash(vec2 p) {',
    '  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);',
    '}',

    // ── Sample with horizontal color bleed (phosphor persistence) ──
    // 3 taps (was 5): center + 1px offset pair. 40% fewer texture fetches.
    // Weights re-normalized to preserve equivalent brightness.
    'vec3 sampleBleed(sampler2D tex, vec2 uv, vec2 texel) {',
    '  vec3 c = texture2D(tex, uv).rgb;',
    '  c += texture2D(tex, uv + vec2(texel.x, 0.0)).rgb * 0.35;',
    '  c += texture2D(tex, uv - vec2(texel.x, 0.0)).rgb * 0.35;',
    '  return c / 1.7;',
    '}',

    'void main() {',
    // Subtle vertical jitter (rolling artifact)
    '  vec2 jitter = vec2(0.0, sin(uTime * 1.7) * 0.0003);',
    '  vec2 uv = crtDistort(vUv + jitter);',

    // Edge mask — black outside curved screen
    '  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {',
    '    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return;',
    '  }',

    // Smooth edge falloff (not hard cut)
    '  float edgeSoft = smoothstep(0.0, 0.01, uv.x) * smoothstep(1.0, 0.99, uv.x)',
    '                 * smoothstep(0.0, 0.01, uv.y) * smoothstep(1.0, 0.99, uv.y);',

    '  vec2 texel = 1.0 / uResolution;',

    // ── Chromatic aberration (aggressive radial RGB split) ──
    '  float aberr = 0.003;',
    '  vec2 dir = (uv - 0.5) * aberr;',
    '  float r = sampleBleed(tScene, uv + dir, texel).r',
    '          + sampleBleed(tBloom, uv + dir, texel).r * uBloomStrength;',
    '  float g = sampleBleed(tScene, uv, texel).g',
    '          + sampleBleed(tBloom, uv, texel).g * uBloomStrength;',
    '  float b = sampleBleed(tScene, uv - dir, texel).b',
    '          + sampleBleed(tBloom, uv - dir, texel).b * uBloomStrength;',
    '  vec3 combined = vec3(r, g, b);',

    // ── Filmic tone mapping ──
    '  combined = combined / (combined + vec3(1.0));',
    '  combined = pow(combined, vec3(0.92));',

    // ── Heavy scanlines (interlaced — odd/even per frame) ──
    '  float scanY = gl_FragCoord.y;',
    '  float frameOdd = mod(floor(uTime * 30.0), 2.0);',
    '  float scanline = 0.78 + 0.22 * smoothstep(0.3, 0.7,',
    '    sin((scanY + frameOdd * 0.5) * 3.14159));',
    '  combined *= scanline;',

    // ── Heavy phosphor triad mask (visible RGB subpixel pattern) ──
    '  float px = mod(gl_FragCoord.x, 3.0);',
    '  float py = mod(gl_FragCoord.y, 3.0);',
    '  vec3 phosphorMask = vec3(0.72);',  // darker base = more visible mask
    '  if (px < 1.0) phosphorMask.r = 1.25;',
    '  else if (px < 2.0) phosphorMask.g = 1.25;',
    '  else phosphorMask.b = 1.25;',
    // Stagger every other row for aperture grille
    '  if (py < 1.5) phosphorMask = mix(phosphorMask, vec3(1.0), 0.2);',
    '  combined *= phosphorMask;',

    // ── Heavy noise grain ──
    '  float grain = (hash(uv * uResolution + fract(uTime * 7.0) * 999.0) - 0.5) * 0.08;',
    '  combined += grain;',

    // ── Lighter vignette (CSS overlay handles the rest) ──
    '  vec2 vig = uv * (1.0 - uv);',
    '  float vigAmount = pow(vig.x * vig.y * 22.0, 0.32);',
    '  combined *= vigAmount;',

    // ── Visible brightness flicker (50/60Hz hum) ──
    '  float flicker = 1.0 - 0.02 * sin(uTime * 60.0 * 3.14159 * 2.0);',
    '  combined *= flicker;',

    // ── Horizontal rolling bar (very subtle) ──
    '  float rollBar = 1.0 - 0.03 * smoothstep(0.0, 0.05,',
    '    abs(fract(uv.y - uTime * 0.04) - 0.5));',
    '  combined *= rollBar;',

    // ── Warm phosphor tint (amber CRT bias) ──
    '  combined *= vec3(1.08, 1.0, 0.88);',

    // Edge and floor
    '  combined *= edgeSoft;',
    '  combined = max(combined, vec3(0.0));',

    // ── Overall brightness boost ──
    '  combined *= 1.45;',

    '  gl_FragColor = vec4(combined, 1.0);',
    '}'
  ].join('\n');

  // Shared fullscreen quad vertex shader
  var FULLSCREEN_VERT = [
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = uv;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  function _initBloom(width, height) {
    if (!_bloomEnabled) return;
    try {

    var halfW = Math.floor(width / 2);
    var halfH = Math.floor(height / 2);

    // Full-res scene render target
    _rtScene = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType  // HDR for bloom
    });

    // Quarter-res bloom targets
    _rtBrightPass = new THREE.WebGLRenderTarget(halfW, halfH, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat
    });
    _rtBlurA = new THREE.WebGLRenderTarget(halfW, halfH, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat
    });
    _rtBlurB = new THREE.WebGLRenderTarget(halfW, halfH, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat
    });

    // Bloom processing scene (fullscreen quad)
    _bloomCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
    _bloomCamera.position.z = 1;
    _bloomScene = new THREE.Scene();

    var quadGeo = new THREE.PlaneGeometry(2, 2);

    // Bright pass material (threshold + downsample)
    _brightQuad = new THREE.Mesh(quadGeo, new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: 0.15 }
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BRIGHT_PASS_FRAG,
      depthTest: false,
      depthWrite: false
    }));

    // Blur material (reused for horizontal + vertical passes)
    _blurQuad = new THREE.Mesh(quadGeo.clone(), new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uResolution: { value: new THREE.Vector2(halfW, halfH) }
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false
    }));

    // Composite material (scene + bloom + CRT)
    _compositeQuad = new THREE.Mesh(quadGeo.clone(), new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uBloomStrength: { value: 0.70 },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(width, height) }
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false
    }));
    console.log('TimbralSpace: bloom initialized (' + width + 'x' + height + ')');
    } catch(e) {
      console.warn('TimbralSpace: bloom init failed, falling back to direct render:', e);
      _bloomEnabled = false;
    }
  }

  function _renderWithBloom() {
    if (!_bloomEnabled || !_rtScene) {
      _renderer.render(_scene, _camera);
      return;
    }

    // Pass 1: Render main scene to HDR target
    _renderer.setRenderTarget(_rtScene);
    _renderer.render(_scene, _camera);

    // Pass 1b: Render scatter sparks on top (separate scene — no z-fight with dump)
    if (_scatterScene) {
      _renderer.autoClear = false;
      _renderer.setRenderTarget(_rtScene);
      _renderer.render(_scatterScene, _camera);
      _renderer.autoClear = true;
    }

    // Pass 2: Bright pass (threshold + downsample)
    _brightQuad.material.uniforms.tDiffuse.value = _rtScene.texture;
    _bloomScene.children.length = 0;
    _bloomScene.add(_brightQuad);
    _renderer.setRenderTarget(_rtBrightPass);
    _renderer.render(_bloomScene, _bloomCamera);

    // Pass 3: Horizontal blur
    _blurQuad.material.uniforms.tDiffuse.value = _rtBrightPass.texture;
    _blurQuad.material.uniforms.uDirection.value.set(1, 0);
    _bloomScene.children.length = 0;
    _bloomScene.add(_blurQuad);
    _renderer.setRenderTarget(_rtBlurA);
    _renderer.render(_bloomScene, _bloomCamera);

    // Pass 4: Vertical blur
    _blurQuad.material.uniforms.tDiffuse.value = _rtBlurA.texture;
    _blurQuad.material.uniforms.uDirection.value.set(0, 1);
    _renderer.setRenderTarget(_rtBlurB);
    _renderer.render(_bloomScene, _bloomCamera);

    // Pass 5: Second blur pass (wider kernel via ping-pong)
    _blurQuad.material.uniforms.tDiffuse.value = _rtBlurB.texture;
    _blurQuad.material.uniforms.uDirection.value.set(1, 0);
    _renderer.setRenderTarget(_rtBlurA);
    _renderer.render(_bloomScene, _bloomCamera);

    _blurQuad.material.uniforms.tDiffuse.value = _rtBlurA.texture;
    _blurQuad.material.uniforms.uDirection.value.set(0, 1);
    _renderer.setRenderTarget(_rtBlurB);
    _renderer.render(_bloomScene, _bloomCamera);

    // Pass 6: Composite — scene + bloom + CRT → screen
    _bloomScene.children.length = 0;
    _bloomScene.add(_compositeQuad);
    _compositeQuad.material.uniforms.tScene.value = _rtScene.texture;
    _compositeQuad.material.uniforms.tBloom.value = _rtBlurB.texture;
    _compositeQuad.material.uniforms.uTime.value = performance.now() * 0.001;
    _renderer.setRenderTarget(null);
    _renderer.render(_bloomScene, _bloomCamera);
  }


  // ══════════════════════════════════════════════════
  // AMBIENT STAR FIELD (background dust motes for depth)
  // ══════════════════════════════════════════════════

  function _createStarField() {
    var positions = new Float32Array(STAR_COUNT * 3);
    var colors = new Float32Array(STAR_COUNT * 3);
    var sizes = new Float32Array(STAR_COUNT);
    var S = SPACE_SIZE * 2.5;  // spread beyond the bounding box

    for (var i = 0; i < STAR_COUNT; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * S * 2;
      positions[i * 3 + 1] = (Math.random() - 0.5) * S * 2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * S * 2;

      // Cool blue-white tints with variation
      var warmth = Math.random();
      colors[i * 3]     = 0.4 + warmth * 0.3;    // R
      colors[i * 3 + 1] = 0.45 + warmth * 0.25;  // G
      colors[i * 3 + 2] = 0.6 + warmth * 0.4;    // B

      sizes[i] = 0.8 + Math.random() * 2.5;
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    // Custom point shader for soft glowing dust
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) }
      },
      vertexShader: [
        'attribute float size;',
        'attribute vec3 color;',
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'uniform float uTime;',
        'uniform float uPixelRatio;',
        'void main() {',
        '  vColor = color;',
        '  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);',
        '  float dist = length(mvPos.xyz);',
        '  // Twinkle: gentle brightness oscillation per particle',
        '  float twinkle = 0.5 + 0.5 * sin(uTime * 0.3 + position.x * 7.0 + position.z * 5.0);',
        '  vAlpha = twinkle * 0.25 * (1.0 / (1.0 + dist * 0.06));',
        '  gl_PointSize = size * uPixelRatio * (8.0 / max(dist, 1.0));',
        '  gl_Position = projectionMatrix * mvPos;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'void main() {',
        '  float d = length(gl_PointCoord - vec2(0.5));',
        '  if (d > 0.5) discard;',
        '  float soft = 1.0 - smoothstep(0.0, 0.5, d);',
        '  gl_FragColor = vec4(vColor, vAlpha * soft);',
        '}'
      ].join('\n'),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    _starField = new THREE.Points(geo, mat);
    _starField.frustumCulled = false;
    _scene.add(_starField);
  }

  function _updateStarField(time) {
    if (_starField && _starField.material.uniforms) {
      _starField.material.uniforms.uTime.value = time;
    }
  }


  // ══════════════════════════════════════════════════
  // ATMOSPHERIC DUST (near-field, section-reactive motes)
  // ══════════════════════════════════════════════════

  function _createDustField() {
    var positions = new Float32Array(DUST_COUNT * 3);
    var colors = new Float32Array(DUST_COUNT * 3);
    var sizes = new Float32Array(DUST_COUNT);
    var S = SPACE_SIZE * 1.5;

    for (var i = 0; i < DUST_COUNT; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * S * 2;
      positions[i * 3 + 1] = (Math.random() - 0.5) * S * 2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * S * 2;

      // Warm amber with subtle per-particle variation
      var warmth = 0.8 + Math.random() * 0.4;
      colors[i * 3]     = 0.4 * warmth;
      colors[i * 3 + 1] = 0.25 * warmth;
      colors[i * 3 + 2] = 0.10 * warmth;

      sizes[i] = 0.3 + Math.random() * 0.7;
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uDustBrightness: { value: 0.06 }
      },
      vertexShader: [
        'attribute float size;',
        'attribute vec3 color;',
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'uniform float uTime;',
        'uniform float uPixelRatio;',
        'uniform float uDustBrightness;',
        'void main() {',
        '  vColor = color;',
        '  // Each particle drifts in a unique elliptical orbit',
        '  float phase = position.x * 3.0 + position.z * 5.0;',
        '  vec3 drift = vec3(',
        '    sin(uTime * 0.05 + phase) * 0.3,',
        '    cos(uTime * 0.03 + phase * 0.7) * 0.15,',
        '    sin(uTime * 0.04 + phase * 1.3) * 0.25',
        '  );',
        '  vec3 pos = position + drift;',
        '  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);',
        '  float dist = length(mvPos.xyz);',
        '  // Gentle twinkle + distance fade',
        '  float twinkle = 0.6 + 0.4 * sin(uTime * 0.5 + phase * 2.0);',
        '  vAlpha = uDustBrightness * twinkle * (1.0 / (1.0 + dist * 0.08));',
        '  gl_PointSize = size * uPixelRatio * (6.0 / max(dist, 1.0));',
        '  gl_Position = projectionMatrix * mvPos;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'void main() {',
        '  float d = length(gl_PointCoord - vec2(0.5));',
        '  if (d > 0.5) discard;',
        '  float soft = 1.0 - smoothstep(0.1, 0.5, d);',
        '  gl_FragColor = vec4(vColor, vAlpha * soft);',
        '}'
      ].join('\n'),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    _dustField = new THREE.Points(geo, mat);
    _dustField.frustumCulled = false;
    _scene.add(_dustField);
  }

  function _updateDustField(time) {
    if (!_dustField) return;
    _dustField.material.uniforms.uTime.value = time;

    // Section-driven brightness: smooth EMA toward target
    var targetBrightness = 0.06 + _cachedSectionEnergy * 0.14;
    _dustBrightness += (targetBrightness - _dustBrightness) * 0.02;
    _dustField.material.uniforms.uDustBrightness.value = _dustBrightness;
  }


  // ══════════════════════════════════════════════════
  // GROUND PLANE GLOW (subtle floor reflection)
  // ══════════════════════════════════════════════════

  var _groundPlane = null;

  function _createGroundPlane() {
    var S = SPACE_SIZE;
    var geo = new THREE.PlaneGeometry(S * 2.4, S * 2.4, 1, 1);
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0.08, 0.08, 0.15) },
        uOpacity: { value: 0.15 }
      },
      vertexShader: [
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = uv;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor;',
        'uniform float uOpacity;',
        'varying vec2 vUv;',
        'void main() {',
        '  // Radial falloff from center',
        '  float d = length(vUv - vec2(0.5));',
        '  float alpha = uOpacity * (1.0 - smoothstep(0.0, 0.6, d));',
        '  gl_FragColor = vec4(uColor, alpha);',
        '}'
      ].join('\n'),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    _groundPlane = new THREE.Mesh(geo, mat);
    _groundPlane.rotation.x = -Math.PI / 2;
    _groundPlane.position.y = -S + 0.01;  // just above floor grid
    _scene.add(_groundPlane);
  }


  // ══════════════════════════════════════════════════
  // ANIMATION LOOP
  // ══════════════════════════════════════════════════

  function _animate() {
    if (!_active) return;
    _rafId = requestAnimationFrame(_animate);

    var dt = _clock.getDelta();
    if (dt > 0.05) dt = 0.05;  // cap at 50ms

    // 1. Update spectral analysis for all voices (including human for note viz)
    for (var vi = 0; vi < ALL_VOICES.length; vi++) {
      _updateSpectral(ALL_VOICES[vi]);
    }

    // 2. Update invisible agent anchors (spectral position drift for note pull)
    var elapsedTime = _clock.elapsedTime;
    for (var ai = 0; ai < VOICES.length; ai++) {
      var v = VOICES[ai];
      var agent = _agents[v];
      var spec = _spectral[v];
      if (!agent || !spec) continue;

      // Drift anchor toward real spectral position — notes use this for 15% spatial pull
      var home = HOME[v] || HOME.human;
      var signalStrength = Math.min(1, spec.amplitude * 4);

      var pm = _phaseMotion[v];
      var phaseX = 0, phaseY = 0, phaseZ = 0;
      if (pm) {
        var phaseAmt = pm.readiness * 0.02;
        phaseX = Math.cos(pm.phase) * phaseAmt;
        phaseZ = Math.sin(pm.phase) * phaseAmt;
        phaseY = (pm.barEmphasis - 1.0) * 0.015;
      }
      var idlePhase = ai * 1.7;
      var idleX = Math.sin(elapsedTime * 0.08 + idlePhase) * 0.008 + phaseX;
      var idleY = Math.cos(elapsedTime * 0.06 + idlePhase * 1.3) * 0.006 + phaseY;
      var idleZ = Math.sin(elapsedTime * 0.07 + idlePhase * 0.7) * 0.007 + phaseZ;

      var cx = home.x * (1 - signalStrength) + spec.centroid * signalStrength + idleX;
      var dy = home.y * (1 - signalStrength) + spec.density * signalStrength + idleY;
      var fz = home.z * (1 - signalStrength) + spec.flatness * signalStrength + idleZ;
      var target = _timbralToScene(cx, dy, fz);
      var driftSpeed = 0.03;
      agent.mesh.position.x += (target.x - agent.mesh.position.x) * driftSpeed;
      agent.mesh.position.y += (target.y - agent.mesh.position.y) * driftSpeed;
      agent.mesh.position.z += (target.z - agent.mesh.position.z) * driftSpeed;
    }

    // 3. Reset tube instance pool for this frame
    _tubeInstanceIdx = 0;

    // 4. Poll for new notes and update trails (including human)
    _pollNoteEvents();
    for (var ti = 0; ti < ALL_VOICES.length; ti++) {
      _updateTrail(ALL_VOICES[ti]);
    }

    // 5. Cross-voice collision bursts → then update scatter particles
    // Emit FIRST so new particles get valid matrices before _updateScatter processes them
    _emitCollisionBursts(dt);
    _updateScatter(dt);

    // 6. Blend note colors when voices overlap spatially
    _updateNoteBlending();

    // 7. Sync threads disabled — too subtle to notice, save draw calls
    // _updateSyncThreads();

    // 8. Finalize tube InstancedMesh (commit all instance transforms)
    _finalizeTubePool();

    // 9. Update phase motion data (drives invisible anchor drift)
    _updatePhaseMotion();

    // 10. Update section ambience (real section state)
    _updateSectionAmbience();

    // 11. Chord prediction markers disabled — too subtle, clutters space
    // _updateChordPredictions();

    // 12. Camera orbit
    _updateCamera(dt);

    // 13. Update ambient star field + atmospheric dust
    _updateStarField(elapsedTime);
    _updateDustField(elapsedTime);

    // 14. Update HUD (throttled to ~4fps for text)
    if (!_hudThrottle || Date.now() - _hudThrottle > 250) {
      _updateHUD();
      _hudThrottle = Date.now();
    }

    // 14. Render with bloom postprocessing
    _renderWithBloom();

    // 15. Raw data overlay (toggle with D key) — must run after bloom render
    if (window.RawDump) RawDump.update();
  }

  var _hudThrottle = 0;


  // ══════════════════════════════════════════════════
  // INITIALIZATION
  // ══════════════════════════════════════════════════

  function _setup() {
    console.log('TimbralSpace._setup: THREE loaded =', !!window.THREE,
                ', THREE.REVISION =', (window.THREE ? window.THREE.REVISION : 'n/a'));
    if (!window.THREE) {
      console.error('TimbralSpace: THREE.js not loaded — check lib/three-browser.js');
      return false;
    }

    _container = document.getElementById('cWrap');
    _canvas2d = document.getElementById('cv');
    if (!_container) {
      console.error('TimbralSpace: canvas-wrap container not found');
      return false;
    }

    // Scene
    _scene = new THREE.Scene();
    _scene.background = new THREE.Color(0x030308);
    // Very subtle fog for depth cueing
    _scene.fog = new THREE.FogExp2(0x030308, 0.012);

    // Camera — low angle, centered, slightly tilted up to observe all notes
    var aspect = _container.clientWidth / _container.clientHeight;
    _camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 200);
    _camera.position.set(0, 1.5, 8);
    _camera.lookAt(0, 0.5, 0);

    // Renderer
    _renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    });
    _renderer.setSize(_container.clientWidth, _container.clientHeight);
    _renderer.setPixelRatio(window.devicePixelRatio);  // full native resolution
    _renderer.domElement.id = 'cv3d';
    _renderer.domElement.style.display = 'none';
    _renderer.domElement.style.position = 'absolute';
    _renderer.domElement.style.top = '0';
    _renderer.domElement.style.left = '0';
    _renderer.domElement.style.width = '100%';
    _renderer.domElement.style.height = '100%';
    _container.appendChild(_renderer.domElement);

    // Clock
    _clock = new THREE.Clock(false);

    // Create environment
    _createAxes();
    _createStarField();
    _createDustField();
    _createGroundPlane();
    _initScatter();
    _initTubePool();
    _initNotePool();
    _initSyncThreads();

    // Init spectral for ALL voices (including human, for note tracking)
    for (var si = 0; si < ALL_VOICES.length; si++) {
      _initSpectral(ALL_VOICES[si]);
    }

    // Create agent anchors and trails (not human — they're the viewer)
    // Agents are invisible — their presence is shown through notes only
    for (var i = 0; i < VOICES.length; i++) {
      _createAgent(VOICES[i]);
      _createTrail(VOICES[i]);
    }
    // Human still gets a trail for their notes (no agent body)
    _createTrail('human');

    // Harmonic prediction markers — disabled (too subtle, clutters space)
    // _initChordMarkers();

    // HUD overlay (real data readout)
    _createHUD();

    // Mouse camera controls (drag to orbit, scroll to zoom)
    _initCameraControls();

    // Initialize bloom postprocessing
    _initBloom(_container.clientWidth * window.devicePixelRatio,
               _container.clientHeight * window.devicePixelRatio);

    // Resize handler
    window.addEventListener('resize', _onResize);

    console.log('TimbralSpace: initialized (' + VOICES.length + ' voice anchors, notes + trails)');
    return true;
  }

  var _initialized = false;

  function _onResize() {
    if (!_renderer || !_container || !_camera) return;
    var w = _container.clientWidth;
    var h = _container.clientHeight;
    _camera.aspect = w / h;
    _camera.updateProjectionMatrix();
    _renderer.setSize(w, h);

    // Resize bloom targets
    var dpr = window.devicePixelRatio;
    var pw = Math.floor(w * dpr);
    var ph = Math.floor(h * dpr);
    if (_rtScene) _rtScene.setSize(pw, ph);
    if (_rtBrightPass) _rtBrightPass.setSize(Math.floor(pw / 2), Math.floor(ph / 2));
    if (_rtBlurA) _rtBlurA.setSize(Math.floor(pw / 2), Math.floor(ph / 2));
    if (_rtBlurB) _rtBlurB.setSize(Math.floor(pw / 2), Math.floor(ph / 2));
    if (_blurQuad && _blurQuad.material.uniforms.uResolution) {
      _blurQuad.material.uniforms.uResolution.value.set(Math.floor(pw / 2), Math.floor(ph / 2));
    }
    if (_compositeQuad && _compositeQuad.material.uniforms.uResolution) {
      _compositeQuad.material.uniforms.uResolution.value.set(pw, ph);
    }
  }


  // ══════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════

  function init() {
    if (_initialized) return;
    _initialized = _setup();
  }

  function toggle() {
    if (!_initialized) init();
    if (!_initialized) return;

    _active = !_active;

    if (_active) {
      // Show 3D, hide 2D
      _renderer.domElement.style.display = 'block';
      if (_canvas2d) _canvas2d.style.display = 'none';
      if (_container) _container.classList.add('mode-3d');

      // Refresh analysers in case AudioContext was created after init
      refreshAnalysers();

      if (_hudElement) _hudElement.style.display = 'block';

      _clock.start();
      _onResize();  // ensure dimensions match
      _animate();
      console.log('TimbralSpace: activated (primary 3D view)');
    } else {
      // Show 2D, hide 3D (legacy fallback — normally 3D stays on)
      _renderer.domElement.style.display = 'none';
      if (_canvas2d) _canvas2d.style.display = 'block';
      if (_container) _container.classList.remove('mode-3d');

      if (_hudElement) _hudElement.style.display = 'none';

      _clock.stop();
      if (_rafId) {
        cancelAnimationFrame(_rafId);
        _rafId = null;
      }
      console.log('TimbralSpace: deactivated');
    }
  }

  function isActive() {
    return _active;
  }

  // Force a specific voice to update its spectral source
  // (call after AudioContext is created or instruments change)
  function refreshAnalysers() {
    for (var i = 0; i < ALL_VOICES.length; i++) {
      var v = ALL_VOICES[i];
      if (typeof SoundEngine !== 'undefined' && SoundEngine.getAnalyser) {
        var analyser = SoundEngine.getAnalyser(v);
        if (analyser && _spectral[v]) {
          _spectral[v].analyser = analyser;
          _spectral[v].numBins = analyser.frequencyBinCount;
          _spectral[v].freqData = new Float32Array(analyser.frequencyBinCount);
        }
      }
    }
    console.log('TimbralSpace: analysers refreshed');
  }

  function getProjectionContext() {
    return { camera: _camera };
  }

  function getScene() {
    return _scene;
  }

  // Return active scatter particles as light sources for RawDump shader.
  // No geometry — sparks are visible only as colored light flashes on text.
  function getActiveScatterData() {
    var result = [];
    for (var i = 0; i < SCATTER_MAX; i++) {
      var dot = _scatterPool[i];
      if (dot.life <= 0) continue;
      // Match visual brightness curve: cubic fade (same as _updateScatter)
      var lc = dot.life * dot.life * dot.life;
      // Only emit proxy light for sparks with meaningful brightness
      if (lc < 0.02) continue;
      result.push({
        x: dot.x, y: dot.y, z: dot.z,
        r: dot.cr * lc,
        g: dot.cg * lc,
        b: dot.cb * lc,
        opacity: lc
      });
    }
    return result;
  }

  // Return positions, colors, and opacity of all visible note spheres.
  // Used by RawDump for per-word note-proximity lighting.
  function getActiveNoteData() {
    var result = [];
    for (var id in _liveNotes) {
      var ln = _liveNotes[id];
      if (!ln.mesh || !ln.mesh.visible) continue;
      var col = COLORS[ln.voiceName] || COLORS.human;
      result.push({
        x: ln.mesh.position.x,
        y: ln.mesh.position.y,
        z: ln.mesh.position.z,
        r: col.r, g: col.g, b: col.b,
        opacity: ln.fadeAlpha
      });
    }
    return result;
  }

  function getAgentPosition(voiceName) {
    var a = _agents[voiceName];
    if (!a) return null;
    return {
      x: a.mesh.position.x,
      y: a.mesh.position.y,
      z: a.mesh.position.z
    };
  }

  function getSpectral(voiceName) {
    var s = _spectral[voiceName];
    if (!s) return null;
    return {
      centroid: s.centroid,
      density: s.density,
      flatness: s.flatness,
      amplitude: s.amplitude
    };
  }


  // Diagnostic: find every visible Mesh/Points in the scene and log position + type
  function debugSceneGraph() {
    if (!_scene) { console.log('No scene'); return; }
    var results = [];
    _scene.traverse(function(obj) {
      if (!obj.visible) return;
      if (obj.isMesh || obj.isPoints || obj.isSprite || obj.isInstancedMesh) {
        var wp = new THREE.Vector3();
        obj.getWorldPosition(wp);
        results.push({
          type: obj.type || obj.constructor.name,
          name: obj.name || '(unnamed)',
          pos: '(' + wp.x.toFixed(2) + ', ' + wp.y.toFixed(2) + ', ' + wp.z.toFixed(2) + ')',
          scale: '(' + obj.scale.x.toFixed(2) + ', ' + obj.scale.y.toFixed(2) + ', ' + obj.scale.z.toFixed(2) + ')',
          visible: obj.visible,
          count: obj.count !== undefined ? obj.count : '-',
          renderOrder: obj.renderOrder
        });
      }
    });
    console.table(results);
    return results;
  }

  function toggleGrid() {
    if (_axisGroup) _axisGroup.visible = !_axisGroup.visible;
  }

  return {
    init: init,
    toggle: toggle,
    toggleGrid: toggleGrid,
    isActive: isActive,
    refreshAnalysers: refreshAnalysers,
    getAgentPosition: getAgentPosition,
    getSpectral: getSpectral,
    getProjectionContext: getProjectionContext,
    getScene: getScene,
    getActiveNoteData: getActiveNoteData,
    getActiveScatterData: getActiveScatterData,
    debugSceneGraph: debugSceneGraph
  };

})();

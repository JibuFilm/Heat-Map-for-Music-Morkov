'use strict';
// ═══ RAW DUMP v7 — Architectural Pipeline Visualizer ═══
//
// ~45 clusters inside timbral box. Color-coded by belief layer.
// Size hierarchy: L1 core = large, periphery = small.
// Per-word note-proximity lighting + EventBus nerve impulses.
// Y = belief layer, X = voice, Z = pipeline depth.
//
// Toggle: B key. Default: OFF. 3D-only.

var RawDump = (function() {

  var _active = false;
  var _scene = null;
  var _camera = null;
  var _rootGroup = null;
  var _clusters = [];           // [{group, words[], fn, ax, ay, az, driftA, ...}]
  var _clusterByFn = {};        // fn name → cluster index (for pulse targeting)
  var _midiLog = [];
  var _contentTimer = 0;

  // Float animation state
  var _animPhase = 'idle';      // 'idle' | 'entering' | 'exiting'
  var _animStart = 0;
  var ANIM_DURATION = 2000;     // 2 seconds
  var WALL_SIZE = 4;            // matches SPACE_SIZE in timbral-space.js
  var _busWired = false;

  // Shared note uniforms — updated once per frame, referenced by all materials
  var _noteUniforms = null;
  var MAX_NOTES = 48;

  // ═══════════════════════════════════════════════════════════
  // §1a  LAYER COLORS + SCALE (visual hierarchy)
  // ═══════════════════════════════════════════════════════════
  //
  // Each layer gets a distinct hue so you SEE the architecture.
  // Scale controls text plane size (1.0 = default).
  //                        R     G     B     ambient  scale  fontSize
  var LAYER_STYLE = {
    L6:   { r: 0.55, g: 0.35, b: 0.90, amb: 0.08, sc: 1.0,  fs: 22 },  // violet
    L5:   { r: 0.20, g: 0.80, b: 0.90, amb: 0.07, sc: 1.0,  fs: 22 },  // cyan
    L4:   { r: 0.90, g: 0.65, b: 0.20, amb: 0.07, sc: 1.1,  fs: 24 },  // amber
    L3:   { r: 0.85, g: 0.85, b: 0.25, amb: 0.07, sc: 1.0,  fs: 22 },  // yellow
    L2:   { r: 0.25, g: 0.90, b: 0.40, amb: 0.07, sc: 1.1,  fs: 24 },  // green
    L1:   { r: 0.95, g: 0.95, b: 1.00, amb: 0.12, sc: 1.5,  fs: 30 },  // WHITE — the core
    L0:   { r: 0.90, g: 0.35, b: 0.25, amb: 0.07, sc: 1.0,  fs: 22 },  // warm red
    OBS:  { r: 0.25, g: 0.55, b: 0.50, amb: 0.04, sc: 0.8,  fs: 18 },  // dim teal
    HARM: { r: 0.70, g: 0.70, b: 0.30, amb: 0.05, sc: 0.9,  fs: 20 },  // dim yellow
    AGT:  { r: 0.40, g: 0.60, b: 0.40, amb: 0.04, sc: 0.8,  fs: 18 },  // dim green
    CORD: { r: 0.45, g: 0.50, b: 0.65, amb: 0.04, sc: 0.8,  fs: 18 },  // dim blue
    SND:  { r: 0.60, g: 0.40, b: 0.25, amb: 0.03, sc: 0.7,  fs: 16 },  // dim orange
    INP:  { r: 0.70, g: 0.70, b: 0.70, amb: 0.04, sc: 0.8,  fs: 18 },  // dim white
    META: { r: 0.35, g: 0.40, b: 0.35, amb: 0.03, sc: 0.7,  fs: 16 }   // very dim
  };

  // ═══════════════════════════════════════════════════════════
  // §1b  VOICE COLORS (match TimbralSpace note sphere colors)
  // ═══════════════════════════════════════════════════════════

  var VOICE_COLORS = {
    bass:       [0.27, 0.27, 0.80],
    rhythm:     [0.80, 0.53, 0.27],
    soloist:    [0.27, 0.80, 0.67],
    lead:       [0.80, 0.40, 0.53],
    percussion: [0.87, 0.67, 0.40],
    human:      [0.90, 0.90, 0.90],
    system:     [0.20, 1.00, 0.20]   // green phosphor for non-voice events
  };

  // ═══════════════════════════════════════════════════════════
  // §1d  GATE READINESS + SIGNAL CASCADE + HARMONIC GLOW
  // ═══════════════════════════════════════════════════════════

  // L1 cluster fnName → voice for gate readiness brightness
  var GATE_VOICE_MAP = {
    L1_bass: 'bass', L1_rhythm: 'rhythm', L1_solo: 'soloist',
    L1_lead: 'lead', L1_perc: 'percussion'
  };

  // Signal cascade: noteProduced ripples upward through belief layers
  // SND → L0 → L1 → L3 → L6 with staggered delays (ms)
  var CASCADE_LAYERS = [
    { delay: 0,   clusters: ['voiceManager', 'timbral'] },
    { delay: 60,  clusters: ['L0_mood', 'tension'] },
    { delay: 120, clusters: ['gateAll', 'scope'] },
    { delay: 180, clusters: ['L3_key', 'harmonicPlan', 'chordBelief'] },
    { delay: 250, clusters: ['L6_bass', 'L6_solo', 'L6_lead'] }
  ];

  // Pending cascade pulses: [{fireAt, clusters, voiceKey}]
  var _cascadeQueue = [];

  // Harmonic convergence: L3/HARM clusters glow with key confidence
  var _harmonicConf = 0;
  var HARMONIC_CLUSTERS = { L3_key: true, keyModulation: true, harmonicPlan: true, chordBelief: true };

  function _queueCascade(voiceKey) {
    var now = Date.now();
    for (var i = 0; i < CASCADE_LAYERS.length; i++) {
      var layer = CASCADE_LAYERS[i];
      var targets = layer.clusters.slice();
      // At L1 delay, add voice-specific cluster
      if (layer.delay === 120) {
        var shortName = voiceKey === 'soloist' ? 'solo' : voiceKey === 'percussion' ? 'perc' : voiceKey;
        var l1Name = 'L1_' + shortName;
        if (_clusterByFn[l1Name] !== undefined) targets.push(l1Name);
      }
      _cascadeQueue.push({ fireAt: now + layer.delay, clusters: targets, voiceKey: voiceKey });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §1c  EVENT → CLUSTER MAPPING
  // ═══════════════════════════════════════════════════════════
  // Each event maps to: { clusters: [fn names], color: voice key or fn(data)→key }
  // noteProduced uses cascade system instead of direct pulse

  var EVENT_CLUSTER_MAP = {
    // noteProduced handled via _queueCascade — no direct pulse here
    noteProduced:       { clusters: [], color: function(d) { return d.voiceName || 'system'; }, cascade: true },
    // Human input — lights up input layer + L0 mood + gesture
    humanNote:          { clusters: ['midiCore','gestureClass','L0_mood'], color: 'human' },
    humanGesture:       { clusters: ['gestureClass'], color: 'human' },
    // Key/chord — lights L3 key belief layer
    keyChanged:         { clusters: ['L3_key','keyModulation','harmonicPlan'], color: 'system' },
    chordChanged:       { clusters: ['harmonicPlan','chordBelief','L3_key'], color: 'system' },
    chordBeliefChanged: { clusters: ['chordBelief','harmonicPlan','L3_key'], color: 'system' },
    // Section — lights L4 arc layer
    sectionChange:      { clusters: ['L4_arc','section','coordination'], color: 'system' },
    // Phrase boundary — lights L2 intent + L6 expectancy
    phraseBoundary:     { clusters: ['L2_intent','melodicIntent','L6_solo','L6_lead'], color: 'system' },
    // Collective breath — lights L4 arc + L0 mood + coordination
    collectiveBreath:   { clusters: ['sessionEnd','L4_arc','tension','coordination'], color: 'system' },
    sessionEnding:      { clusters: ['sessionEnd','L4_arc','timbral'], color: 'system' },
    sessionRebirth:     { clusters: ['sessionEnd','L4_arc','L5_sync'], color: 'system' },
    // Thematic memory
    themeArchived:      { clusters: ['thematic','L2_intent'], color: function(d) { return d.voice || 'system'; } },
    themeRecalled:      { clusters: ['thematic','melodicIntent','L2_intent'], color: function(d) { return d.voice || 'system'; } },
    // Percussion — lights perc agent + L1
    percPatternChange:  { clusters: ['percState','L1_perc'], color: 'percussion' },
    percFillSignal:     { clusters: ['percState','L1_perc'], color: 'percussion' },
    // Behavior mode — lights coordination
    behaviorModeChange: { clusters: ['coordination','scope'], color: function(d) { return d.voice || 'system'; } },
    sharedPhrasePublished: { clusters: ['thematic'], color: function(d) { return d.voice || 'system'; } },
    genreChanged:       { clusters: ['musicMetrics','ensembleSummary'], color: 'human' }
  };

  // ═══════════════════════════════════════════════════════════
  // §1  SHADERS
  // ═══════════════════════════════════════════════════════════

  var VERT = [
    'varying vec2 vUv;',
    'varying vec3 vWorldPos;',
    'void main() {',
    '  vUv = uv;',
    '  vec4 worldPos = modelMatrix * vec4(position, 1.0);',
    '  vWorldPos = worldPos.xyz;',
    '  gl_Position = projectionMatrix * viewMatrix * worldPos;',
    '}'
  ].join('\n');

  var FRAG = [
    'uniform sampler2D tText;',
    'uniform float uBaseOpacity;',
    'uniform float uTime;',
    'uniform float uPulse;',
    'uniform vec3  uPulseColor;',
    'uniform vec3  uLayerColor;',
    'uniform float uLayerAmb;',
    'uniform int uNoteCount;',
    'uniform int uNoteOnlyCount;',
    'uniform vec3 uNotePositions[' + MAX_NOTES + '];',
    'uniform vec3 uNoteColors[' + MAX_NOTES + '];',
    'uniform float uNoteOpacities[' + MAX_NOTES + '];',
    'varying vec2 vUv;',
    'varying vec3 vWorldPos;',
    '',
    'void main() {',
    '  vec4 texel = texture2D(tText, vUv);',
    '  if (texel.a < 0.1) discard;',
    '',
    '  // Accumulate light: note spheres (dim) + scatter sparks (bright)',
    '  vec3 light = vec3(0.0);',
    '  for (int i = 0; i < ' + MAX_NOTES + '; i++) {',
    '    if (i >= uNoteCount) break;',
    '    vec3 delta = vWorldPos - uNotePositions[i];',
    '    float dist2 = dot(delta, delta);',
    // Note lights: broader, gentle ambient awareness (inverse square, soft)
    // Spark lights: tighter radius — localized pool of reflected glow
    '    float noteAtten = 1.0 / (1.0 + dist2 * 3.0);',
    '    float sparkAtten = 1.0 / (1.0 + dist2 * 8.0);',
    '    float atten = (i < uNoteOnlyCount) ? noteAtten : sparkAtten;',
    '    float scale = (i < uNoteOnlyCount) ? 0.06 : 0.05;',
    '    light += uNoteColors[i] * atten * uNoteOpacities[i] * scale;',
    '  }',
    '',
    '  // Layer-colored ambient (each belief layer has its own hue)',
    '  vec3 ambient = uLayerColor * uLayerAmb;',
    '',
    '  // EventBus nerve pulse: additive colored glow',
    '  vec3 pulse = uPulseColor * uPulse * 0.8;',
    '',
    '  // Combine: text tinted by layer color * (ambient + note lighting + pulse)',
    '  vec3 tinted = texel.rgb * (0.3 + 0.7 * uLayerColor);',
    '  vec3 color = tinted * (ambient + light * 1.2 + pulse);',
    '',
    '  // Subtle breath',
    '  float breath = 1.0 + sin(uTime * 0.5) * 0.08;',
    '',
    '  gl_FragColor = vec4(color * breath, texel.a * uBaseOpacity);',
    '}'
  ].join('\n');

  // ═══════════════════════════════════════════════════════════
  // §2  CLUSTER LAYOUT — Architectural 3D Map
  //
  //   Y axis = Belief Hierarchy (bottom→top: output→L0→L1→L2→L3→L4→L5→L6)
  //   X axis = Voice columns (bass -3, rhythm -1.5, center 0, soloist 1.5, lead 3)
  //   Z axis = Pipeline depth (observation -3, belief 0, expression +3)
  //
  //   Looking at the space you SEE the architecture.
  // ═══════════════════════════════════════════════════════════

  var CLUSTER_DEFS = [

    // ── L6 — MELODIC EXPECTANCY (violet, y ≈ 3.3) ──
    { x:-1.8, y: 3.3, z:-0.5, op:0.85, fn:'L6_bass',     maxWords:3, layer:'L6' },
    { x: 0.0, y: 3.5, z: 0.5, op:0.88, fn:'L6_solo',     maxWords:3, layer:'L6' },
    { x: 1.8, y: 3.3, z:-0.3, op:0.85, fn:'L6_lead',     maxWords:3, layer:'L6' },

    // ── L5 — PHASE COUPLING (cyan, y ≈ 2.5) ──
    { x: 0.0, y: 2.5, z: 0.0, op:0.90, fn:'L5_sync',     maxWords:4, layer:'L5' },
    { x:-2.5, y: 2.5, z:-1.0, op:0.82, fn:'L5_phases',   maxWords:5, layer:'L5' },
    { x: 2.5, y: 2.5, z: 1.0, op:0.80, fn:'barTracker',  maxWords:3, layer:'L5' },

    // ── L4 — NARRATIVE ARC (amber, y ≈ 1.8) ──
    { x: 0.0, y: 1.8, z: 0.0, op:0.92, fn:'L4_arc',      maxWords:4, layer:'L4' },
    { x:-2.5, y: 1.8, z:-1.2, op:0.82, fn:'section',     maxWords:3, layer:'L4' },
    { x: 2.5, y: 1.8, z:-1.2, op:0.82, fn:'sessionEnd',  maxWords:4, layer:'L4' },

    // ── L3 — KEY BELIEF (yellow, y ≈ 1.0) ──
    { x: 0.0, y: 1.0, z: 0.0, op:0.92, fn:'L3_key',      maxWords:4, layer:'L3' },
    { x:-2.5, y: 1.0, z:-0.5, op:0.82, fn:'keyModulation', maxWords:3, layer:'L3' },
    { x: 2.5, y: 1.0, z:-0.5, op:0.82, fn:'harmonicPlan', maxWords:3, layer:'L3' },
    { x: 0.0, y: 0.8, z:-2.5, op:0.80, fn:'chordBelief', maxWords:3, layer:'HARM' },

    // ── L2 — MELODIC INTENT (green, y ≈ 0.3) ──
    { x: 0.0, y: 0.3, z: 0.0, op:0.92, fn:'L2_intent',   maxWords:5, layer:'L2' },
    { x:-2.5, y: 0.3, z: 0.5, op:0.82, fn:'melodicIntent', maxWords:5, layer:'L2' },

    // ── L1 — BELIEF STATE ★ THE CORE ★ (white, y ≈ -0.5) ──
    { x:-3.0, y:-0.5, z: 0.0, op:0.95, fn:'L1_bass',     maxWords:4, layer:'L1' },
    { x:-1.5, y:-0.5, z: 0.0, op:0.95, fn:'L1_rhythm',   maxWords:4, layer:'L1' },
    { x: 0.0, y:-0.5, z: 0.0, op:0.95, fn:'L1_solo',     maxWords:4, layer:'L1' },
    { x: 1.5, y:-0.5, z: 0.0, op:0.95, fn:'L1_lead',     maxWords:4, layer:'L1' },
    { x: 3.0, y:-0.5, z: 0.0, op:0.92, fn:'L1_perc',     maxWords:4, layer:'L1' },
    { x: 0.0, y:-0.5, z: 2.5, op:0.82, fn:'gateAll',     maxWords:5, layer:'L1' },
    { x: 0.0, y:-0.8, z:-2.5, op:0.80, fn:'scope',       maxWords:4, layer:'L1' },

    // ── L0 — MOOD STATE (warm red, y ≈ -1.5) ──
    { x: 0.0, y:-1.5, z: 0.0, op:0.90, fn:'L0_mood',     maxWords:4, layer:'L0' },
    { x:-2.5, y:-1.5, z:-1.0, op:0.82, fn:'tension',     maxWords:4, layer:'L0' },
    { x: 2.5, y:-1.5, z:-1.0, op:0.82, fn:'moodDetailed', maxWords:4, layer:'L0' },

    // ── OBSERVATION (dim teal, y ≈ -2.3) ──
    { x: 0.0, y:-2.3, z: 0.0, op:0.85, fn:'context',      maxWords:4, layer:'OBS' },
    { x:-2.5, y:-2.3, z:-1.0, op:0.78, fn:'saturation',   maxWords:3, layer:'OBS' },
    { x: 2.5, y:-2.3, z:-1.0, op:0.78, fn:'pairwiseTens', maxWords:4, layer:'OBS' },

    // ── VOICE AGENTS (dim green, flanking L1) ──
    { x:-3.5, y:-0.5, z:-2.0, op:0.82, fn:'bassState',    maxWords:3, layer:'AGT' },
    { x:-1.8, y:-0.5, z:-2.0, op:0.80, fn:'rhythmState',  maxWords:3, layer:'AGT' },
    { x: 0.0, y:-0.5, z:-2.0, op:0.82, fn:'soloState',    maxWords:3, layer:'AGT' },
    { x: 1.8, y:-0.5, z:-2.0, op:0.82, fn:'leadState',    maxWords:3, layer:'AGT' },
    { x: 3.5, y:-0.5, z:-1.5, op:0.80, fn:'percState',    maxWords:3, layer:'AGT' },

    // ── COORDINATION (dim blue, z ≈ 2.5) ──
    { x:-2.0, y: 0.0, z: 3.0, op:0.78, fn:'conviction',   maxWords:3, layer:'CORD' },
    { x: 2.0, y: 0.0, z: 3.0, op:0.78, fn:'dialogue',     maxWords:3, layer:'CORD' },
    { x: 0.0, y: 0.0, z: 3.5, op:0.78, fn:'coordination', maxWords:3, layer:'CORD' },

    // ── SOUND (dim orange, y ≈ -3.0) ──
    { x: 0.0, y:-3.0, z: 0.0, op:0.75, fn:'voiceManager', maxWords:3, layer:'SND' },
    { x:-2.5, y:-3.0, z: 1.0, op:0.72, fn:'timbral',     maxWords:3, layer:'SND' },

    // ── INPUT (dim white, y ≈ -3.5) ──
    { x:-1.5, y:-3.5, z:-1.5, op:0.78, fn:'midiCore',     maxWords:3, layer:'INP' },
    { x: 1.5, y:-3.5, z:-1.5, op:0.75, fn:'gestureClass', maxWords:3, layer:'INP' },

    // ── META (very dim, corners) ──
    { x:-3.5, y: 1.5, z: 2.0, op:0.72, fn:'thematic',     maxWords:2, layer:'META' },
    { x: 3.5, y:-1.5, z:-2.0, op:0.70, fn:'musicMetrics', maxWords:3, layer:'META' },
    { x: 3.5, y:-1.5, z: 2.0, op:0.70, fn:'ensembleSummary', maxWords:3, layer:'META' }
  ];

  // ═══════════════════════════════════════════════════════════
  // §3  DATA READERS
  // ═══════════════════════════════════════════════════════════

  function _f(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v.toFixed(d !== undefined ? d : 3) : '\u2014';
  }
  function _b(v) { return v ? 'true' : 'false'; }
  var NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  var READERS = {

    // ╔═══════════════════════════════════════════════════════╗
    // ║  L6 — MELODIC EXPECTANCY (IDyOM: LTM + STM)         ║
    // ╚═══════════════════════════════════════════════════════╝

    L6_bass: function() {
      var rows = [];
      try { if (typeof MelodicExpectancy !== 'undefined') {
        rows.push(['L6', 'EXPECTANCY']);
        var p = MelodicExpectancy.predict('bass'); if (p) { rows.push(['bass.H', _f(p.entropy)]); rows.push(['bass.top', NOTE_NAMES[p.topPC || 0] + ' ' + _f(p.topProb, 2)]); }
      }} catch(e) {}
      return rows;
    },

    L6_solo: function() {
      var rows = [];
      try { if (typeof MelodicExpectancy !== 'undefined') {
        rows.push(['L6', 'EXPECTANCY']);
        var p = MelodicExpectancy.predict('soloist'); if (p) { rows.push(['solo.H', _f(p.entropy)]); rows.push(['solo.top', NOTE_NAMES[p.topPC || 0] + ' ' + _f(p.topProb, 2)]); }
      }} catch(e) {}
      return rows;
    },

    L6_lead: function() {
      var rows = [];
      try { if (typeof MelodicExpectancy !== 'undefined') {
        rows.push(['L6', 'EXPECTANCY']);
        var p = MelodicExpectancy.predict('lead'); if (p) { rows.push(['lead.H', _f(p.entropy)]); rows.push(['lead.top', NOTE_NAMES[p.topPC || 0] + ' ' + _f(p.topProb, 2)]); }
      }} catch(e) {}
      return rows;
    },

    // ╔═══════════════════════════════════════════════════════╗
    // ║  L5 — PHASE COUPLING (Kuramoto oscillators)          ║
    // ╚═══════════════════════════════════════════════════════╝

    L5_sync: function() {
      var rows = [];
      try {
        rows.push(['L5', 'COUPLING']);
        var op = PhaseCoupling.getOrderParameter ? PhaseCoupling.getOrderParameter() : null;
        if (op !== null) rows.push(['sync.r', _f(op)]);
        rows.push(['BPM', _f(PhaseCoupling.getConsensusBPM(), 1)]);
        if (PhaseCoupling.getCoherenceState) { var cs = PhaseCoupling.getCoherenceState(); if (cs) rows.push(['dr/dt', _f(cs.drdt)]); }
        if (PhaseCoupling.getBarEmphasis) rows.push(['barEmph', _f(PhaseCoupling.getBarEmphasis())]);
      } catch(e) {}
      return rows;
    },

    L5_phases: function() {
      var rows = [];
      try {
        rows.push(['L5', 'PHASES']);
        var vs = ['bass','rhythm','soloist','lead','percussion'];
        for (var i = 0; i < vs.length; i++) {
          var ph = PhaseCoupling.getPhase ? PhaseCoupling.getPhase(vs[i]) : null;
          if (ph !== null) rows.push([vs[i].slice(0,4) + '.\u03C6', _f(ph, 2)]);
        }
      } catch(e) {}
      return rows;
    },

    // ╔═══════════════════════════════════════════════════════╗
    // ║  L4 — NARRATIVE ARC (Session Architecture)           ║
    // ╚═══════════════════════════════════════════════════════╝

    L4_arc: function() {
      var rows = [];
      try {
        rows.push(['L4', 'ARC']);
        if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getSessionPhase) {
          var sp = NarrativeArc.getSessionPhase();
          if (sp) { rows.push(['phase', sp.phase || '\u2014']); rows.push(['progress', _f(sp.phaseProgress)]); if (sp.peakCeiling !== undefined) rows.push(['peakCeil', _f(sp.peakCeiling)]); }
        }
        if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getEnergyModifier) rows.push(['eMod', _f(NarrativeArc.getEnergyModifier())]);
      } catch(e) {}
      return rows;
    },

    // ╔═══════════════════════════════════════════════════════╗
    // ║  L3 — KEY BELIEF (84-key Bayesian)                   ║
    // ╚═══════════════════════════════════════════════════════╝

    L3_key: function() {
      var rows = [];
      try {
        rows.push(['L3', 'KEY BELIEF']);
        if (typeof KeyBelief !== 'undefined') {
          if (KeyBelief.getMostLikelyKey) { var mk = KeyBelief.getMostLikelyKey(); if (mk) rows.push(['key', NOTE_NAMES[mk.key || 0] + ' ' + (mk.mode || '\u2014')]); }
          if (KeyBelief.getConfidence) rows.push(['conf', _f(KeyBelief.getConfidence())]);
          if (KeyBelief.getPCEntropy) rows.push(['pcH', _f(KeyBelief.getPCEntropy())]);
          if (KeyBelief.getGravity) rows.push(['grav', _f(KeyBelief.getGravity())]);
        }
      } catch(e) {}
      return rows;
    },

    // ╔═══════════════════════════════════════════════════════╗
    // ║  L2 — MELODIC INTENT (L1→L2 matrix)                 ║
    // ╚═══════════════════════════════════════════════════════╝

    L2_intent: function() {
      var rows = [];
      try {
        rows.push(['L2', 'INTENT']);
        if (typeof MelodicIntent !== 'undefined' && MelodicIntent.getIntent) {
          var vs = ['bass','rhythm','soloist','lead'];
          for (var i = 0; i < vs.length; i++) {
            var intent = MelodicIntent.getIntent(vs[i]);
            if (intent) rows.push([vs[i].slice(0,4), intent]);
          }
        }
      } catch(e) {}
      return rows;
    },

    // ╔═══════════════════════════════════════════════════════╗
    // ║  L1 — BELIEF STATE (POMDP 5-need)  ★ THE CORE ★     ║
    // ╚═══════════════════════════════════════════════════════╝

    L1_bass: function() {
      var rows = [];
      try {
        rows.push(['L1', 'BASS']);
        var b = BeliefState.getBelief('bass');
        rows.push(['stab', _f(b.needs_stability)]); rows.push(['ener', _f(b.needs_energy)]);
        rows.push(['spac', _f(b.needs_space)]); rows.push(['surp', _f(b.needs_surprise)]);
      } catch(e) {}
      return rows;
    },

    L1_rhythm: function() {
      var rows = [];
      try {
        rows.push(['L1', 'RHYTHM']);
        var b = BeliefState.getBelief('rhythm');
        rows.push(['stab', _f(b.needs_stability)]); rows.push(['ener', _f(b.needs_energy)]);
        rows.push(['spac', _f(b.needs_space)]); rows.push(['surp', _f(b.needs_surprise)]);
      } catch(e) {}
      return rows;
    },

    L1_solo: function() {
      var rows = [];
      try {
        rows.push(['L1', 'SOLOIST']);
        var b = BeliefState.getBelief('soloist');
        rows.push(['ener', _f(b.needs_energy)]); rows.push(['surp', _f(b.needs_surprise)]);
        rows.push(['reso', _f(b.needs_resolution)]); rows.push(['spac', _f(b.needs_space)]);
      } catch(e) {}
      return rows;
    },

    L1_lead: function() {
      var rows = [];
      try {
        rows.push(['L1', 'LEAD']);
        var b = BeliefState.getBelief('lead');
        rows.push(['ener', _f(b.needs_energy)]); rows.push(['surp', _f(b.needs_surprise)]);
        rows.push(['reso', _f(b.needs_resolution)]); rows.push(['spac', _f(b.needs_space)]);
      } catch(e) {}
      return rows;
    },

    L1_perc: function() {
      var rows = [];
      try {
        rows.push(['L1', 'PERC']);
        var b = BeliefState.getBelief('percussion');
        rows.push(['stab', _f(b.needs_stability)]); rows.push(['ener', _f(b.needs_energy)]);
        rows.push(['spac', _f(b.needs_space)]);
      } catch(e) {}
      try { rows.push(['gate', _f(BeliefState.getParams('percussion').gateProb)]); } catch(e) {}
      return rows;
    },

    // ╔═══════════════════════════════════════════════════════╗
    // ║  L0 — MOOD STATE (emotional modulators)              ║
    // ╚═══════════════════════════════════════════════════════╝

    L0_mood: function() {
      var rows = [];
      try {
        rows.push(['L0', 'MOOD']);
        if (typeof MoodState !== 'undefined' && MoodState.get) {
          var ms = MoodState.get();
          if (ms) { rows.push(['val', _f(ms.valence)]); rows.push(['aro', _f(ms.arousal)]); if (ms.dominance !== undefined) rows.push(['dom', _f(ms.dominance)]); }
        }
        if (typeof MoodState !== 'undefined' && MoodState.getCombinedTension) rows.push(['tens', _f(MoodState.getCombinedTension())]);
      } catch(e) {}
      return rows;
    },

    midiCore: function() {
      var rows = [];
      for (var i = 0; i < _midiLog.length; i++) rows.push(['MIDI', _midiLog[i]]);
      if (rows.length === 0) rows.push(['MIDI', '\u2014 waiting \u2014']);
      return rows;
    },

    section: function() {
      var rows = [];
      try {
        var st = SectionTracker.getState();
        rows.push(['section', st.state]); rows.push(['energy', _f(st.energy)]);
        rows.push(['adventure', _f(st.adventurousness)]); rows.push(['density', _f(st.density)]);
        rows.push(['resolveUrge', _f(st.resolutionUrgency)]);
      } catch(e) {}
      return rows;
    },

    dialogue: function() {
      var rows = [];
      try {
        var ds = DialogueEngine.getStance();
        rows.push(['stance', ds.stance || '\u2014']); rows.push(['initiative', _f(ds.initiative)]);
        rows.push(['agreement', _f(ds.agreement)]);
      } catch(e) {}
      try { rows.push(['develop', _b(DialogueEngine.shouldDevelop())]); } catch(e) {}
      try {
        var vs = DialogueEngine.getVoiceStances();
        if (vs) {
          if (vs.bass) rows.push(['bass.stance', vs.bass.stance || '\u2014']);
          if (vs.lead) rows.push(['lead.stance', vs.lead.stance || '\u2014']);
        }
      } catch(e) {}
      return rows;
    },

    bassState: function() {
      var rows = [];
      try {
        if (typeof BassAssistant !== 'undefined') {
          if (BassAssistant.getBassState) rows.push(['_bassState', BassAssistant.getBassState()]);
          if (BassAssistant.getTimeSinceSearching) rows.push(['sinceSearch', Math.round(BassAssistant.getTimeSinceSearching()) + 'ms']);
          if (BassAssistant.getCurrentSource) rows.push(['source', BassAssistant.getCurrentSource()]);
          if (BassAssistant.getLoopConfidence) rows.push(['loopConf', _f(BassAssistant.getLoopConfidence())]);
        }
      } catch(e) {}
      return rows;
    },

    rhythmState: function() {
      var rows = [];
      try {
        if (typeof RhythmAssistant !== 'undefined') {
          if (RhythmAssistant.getCurrentSource) rows.push(['rhyth.src', RhythmAssistant.getCurrentSource()]);
          if (RhythmAssistant.getLoopConfidence) rows.push(['rhyth.loop', _f(RhythmAssistant.getLoopConfidence())]);
          if (RhythmAssistant.getPhraseProgress) rows.push(['rhyth.prog', _f(RhythmAssistant.getPhraseProgress())]);
        }
      } catch(e) {}
      return rows;
    },

    soloState: function() {
      var rows = [];
      try {
        if (typeof SoloistAssistant !== 'undefined') {
          if (SoloistAssistant.getDeliberationState) { var ds = SoloistAssistant.getDeliberationState(); rows.push(['solo._state', ds.state || '\u2014']); rows.push(['solo._mode', ds.mode || 'null']); if (ds.evidenceScore !== undefined) rows.push(['solo._evid', _f(ds.evidenceScore)]); }
          if (SoloistAssistant.getCandidatePool) rows.push(['solo.pool', SoloistAssistant.getCandidatePool().length + '']);
        }
      } catch(e) {}
      return rows;
    },

    leadState: function() {
      var rows = [];
      try {
        if (typeof LeadAssistant !== 'undefined' && LeadAssistant.getDeliberationState) {
          var ds = LeadAssistant.getDeliberationState();
          rows.push(['lead._state', ds.state || '\u2014']); rows.push(['lead._mode', (ds.mode || 'null')]);
          rows.push(['lead._evid', _f(ds.evidenceScore)]); rows.push(['lead._delibMs', Math.round(ds.deliberationMs || 0) + 'ms']);
        }
      } catch(e) {}
      return rows;
    },

    percState: function() {
      var rows = [];
      try {
        if (typeof PercussionAssistant !== 'undefined') {
          if (PercussionAssistant.getCurrentSource) rows.push(['perc.src', PercussionAssistant.getCurrentSource()]);
          if (PercussionAssistant.getLoopConfidence) rows.push(['perc.loop', _f(PercussionAssistant.getLoopConfidence())]);
        }
      } catch(e) {}
      return rows;
    },

    context: function() {
      var rows = [];
      try { if (typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getEnsembleSnapshot) { var snap = ContextIntegrator.getEnsembleSnapshot(); if (snap) { rows.push(['ctx.density', _f(snap.totalDensity)]); rows.push(['ctx.tension', _f(snap.intervalTension)]); rows.push(['ctx.entropy', _f(snap.relationalEntropy)]); rows.push(['ctx.phaseAlign', _f(snap.phaseAlignment)]); } } } catch(e) {}
      return rows;
    },

    voiceManager: function() {
      var rows = [];
      try { if (typeof VoiceManager !== 'undefined' && VoiceManager.getActiveNoteCount) { var vs = ['bass','rhythm','soloist','lead','percussion']; for (var i = 0; i < vs.length; i++) { var cnt = VoiceManager.getActiveNoteCount(vs[i]); if (cnt !== undefined) rows.push([vs[i].slice(0,4) + '.notes', cnt + '']); } } } catch(e) {}
      return rows;
    },

    timbral: function() {
      var rows = [];
      try { if (typeof TimbralEvolution !== 'undefined' && TimbralEvolution.getState) { var ts = TimbralEvolution.getState(); if (ts) { rows.push(['tmbrl.reverb', _f(ts.reverb)]); rows.push(['tmbrl.bright', _f(ts.brightness)]); rows.push(['tmbrl.stereo', _f(ts.stereo)]); } } } catch(e) {}
      return rows;
    },

    tension: function() {
      var rows = [];
      var voices = ['lead', 'soloist', 'bass', 'rhythm'];
      for (var i = 0; i < voices.length; i++) { try { var b = BeliefState.getBelief(voices[i]); if (b && b.tensionLevel !== undefined) rows.push([voices[i].slice(0,4) + '.tension', _f(b.tensionLevel)]); } catch(e) {} }
      return rows;
    },

    thematic: function() {
      var rows = [];
      try { if (typeof ThematicMemory !== 'undefined') { if (ThematicMemory.getThemeCount) rows.push(['theme.count', ThematicMemory.getThemeCount() + '']); if (ThematicMemory.getRecallRate) rows.push(['theme.recall', _f(ThematicMemory.getRecallRate())]); if (ThematicMemory.getSessionPhase) rows.push(['theme.phase', ThematicMemory.getSessionPhase()]); } } catch(e) {}
      return rows;
    },

    coordination: function() {
      var rows = [];
      try { if (typeof SectionTracker !== 'undefined' && SectionTracker.getVoicePerceptions) { var vp = SectionTracker.getVoicePerceptions(); if (vp) { var vs = ['bass','lead','soloist']; for (var i = 0; i < vs.length; i++) { var vv = vp[vs[i]]; if (vv) rows.push([vs[i].slice(0,4) + '.percSec', vv.state || '\u2014']); } } } } catch(e) {}
      try { if (typeof PeerVelocity !== 'undefined' && PeerVelocity.getEnvelope) { rows.push(['peerVel.lead', _f(PeerVelocity.getEnvelope('lead'))]); rows.push(['peerVel.solo', _f(PeerVelocity.getEnvelope('soloist'))]); } } catch(e) {}
      return rows;
    },

    scope: function() {
      var rows = [];
      var agentMap = [['bass','BassAssistant'],['solo','SoloistAssistant'],['lead','LeadAssistant'],['rhyth','RhythmAssistant']];
      for (var i = 0; i < agentMap.length; i++) { try { var agent = window[agentMap[i][1]]; if (agent && agent.scope && agent.scope.accumulator !== undefined) rows.push([agentMap[i][0] + '.scope', _f(agent.scope.accumulator)]); } catch(e) {} }
      return rows;
    },

    gateAll: function() {
      var rows = [];
      var voices = ['bass','rhythm','soloist','lead','percussion'];
      for (var i = 0; i < voices.length; i++) { try { var p = BeliefState.getParams(voices[i]); rows.push([voices[i].slice(0,4) + '.gate', _f(p.gateProb)]); } catch(e) {} }
      return rows;
    },

    // ═══════════════════════════════════════════════════════
    // Phase 1 — NEW READERS (untapped pipeline sources)
    // ═══════════════════════════════════════════════════════

    harmonicPlan: function() {
      var rows = [];
      try {
        if (typeof HarmonicPlanner !== 'undefined' && HarmonicPlanner.getNextChords) {
          var chords = HarmonicPlanner.getNextChords();
          if (chords && chords.length > 0) {
            for (var i = 0; i < Math.min(chords.length, 3); i++) {
              var ch = chords[i];
              rows.push(['next' + (i+1), NOTE_NAMES[ch.rootPC || 0] + (ch.type || '') + ' ' + _f(ch.confidence, 2)]);
            }
          }
          if (HarmonicPlanner.getConfidence) rows.push(['harm.conf', _f(HarmonicPlanner.getConfidence())]);
        }
      } catch(e) {}
      return rows;
    },

    chordBelief: function() {
      var rows = [];
      try {
        if (typeof ChordBelief !== 'undefined') {
          if (ChordBelief.getChord) {
            var ch = ChordBelief.getChord();
            if (ch) rows.push(['chord', NOTE_NAMES[ch.rootPC || 0] + (ch.type || '') + ' ' + _f(ch.confidence, 2)]);
          }
          if (ChordBelief.getEntropy) rows.push(['cb.entropy', _f(ChordBelief.getEntropy())]);
          if (ChordBelief.getConfidence) rows.push(['cb.conf', _f(ChordBelief.getConfidence())]);
        }
      } catch(e) {}
      return rows;
    },

    conviction: function() {
      var rows = [];
      try {
        if (typeof ConvictionExpression !== 'undefined' && ConvictionExpression.getAll) {
          var all = ConvictionExpression.getAll();
          var vs = ['bass','rhythm','soloist','lead','percussion'];
          for (var i = 0; i < vs.length; i++) {
            var v = vs[i];
            if (all[v]) rows.push([v.slice(0,4) + '.conv', _f(all[v].conviction) + ' f' + _f(all[v].filterMod, 2)]);
          }
        }
      } catch(e) {}
      return rows;
    },

    sessionEnd: function() {
      var rows = [];
      try {
        if (typeof SessionEnding !== 'undefined' && SessionEnding.getState) {
          var st = SessionEnding.getState();
          if (st) {
            rows.push(['se.phase', st.phase || 'inactive']);
            rows.push(['se.progress', _f(st.progress)]);
            rows.push(['se.cycle', (st.cycleCount || 0) + '']);
            if (st.rebirthVoice) rows.push(['se.rebirth', st.rebirthVoice]);
            if (st.currentBPM) rows.push(['se.bpm', _f(st.currentBPM, 1)]);
          }
        }
      } catch(e) {}
      return rows;
    },

    melodicIntent: function() {
      var rows = [];
      try {
        if (typeof MelodicIntent !== 'undefined' && MelodicIntent.getIntent) {
          var vs = ['bass','rhythm','soloist','lead'];
          for (var i = 0; i < vs.length; i++) {
            var intent = MelodicIntent.getIntent(vs[i]);
            if (intent) rows.push([vs[i].slice(0,4) + '.intent', intent]);
          }
          if (MelodicIntent.getSeedReplay) {
            var sr = MelodicIntent.getSeedReplay();
            if (sr) rows.push(['seed.replay', 'active']);
          }
        }
      } catch(e) {}
      return rows;
    },

    barTracker: function() {
      var rows = [];
      try {
        if (typeof BarTracker !== 'undefined') {
          if (BarTracker.getBarPhase) rows.push(['bar.phase', _f(BarTracker.getBarPhase())]);
          if (BarTracker.getBeatInBar) rows.push(['bar.beat', BarTracker.getBeatInBar() + '']);
          if (BarTracker.getBarConfidence) rows.push(['bar.conf', _f(BarTracker.getBarConfidence())]);
          if (BarTracker.getBeatsPerBar) rows.push(['bar.meter', BarTracker.getBeatsPerBar() + '/4']);
          if (BarTracker.isNearDownbeat) rows.push(['bar.down', _b(BarTracker.isNearDownbeat())]);
        }
      } catch(e) {}
      return rows;
    },

    keyModulation: function() {
      var rows = [];
      try {
        if (typeof KeyBelief !== 'undefined') {
          if (KeyBelief.getModulationMomentum) {
            var mm = KeyBelief.getModulationMomentum();
            if (mm) { rows.push(['key.momPos', _f(mm.position)]); rows.push(['key.momDir', _f(mm.direction)]); }
          }
          if (KeyBelief.getPCEntropy) rows.push(['key.pcEnt', _f(KeyBelief.getPCEntropy())]);
          if (KeyBelief.getGravity) rows.push(['key.grav', _f(KeyBelief.getGravity())]);
          if (KeyBelief.getConsonance) rows.push(['key.conso', _f(KeyBelief.getConsonance())]);
        }
      } catch(e) {}
      return rows;
    },

    moodDetailed: function() {
      var rows = [];
      try {
        if (typeof MoodState !== 'undefined') {
          if (MoodState.getAll) {
            var ms = MoodState.getAll();
            if (ms) {
              rows.push(['mood.tempo', _f(ms.tempoMult)]);
              rows.push(['mood.velOff', _f(ms.velocityOffset)]);
              rows.push(['mood.artic', _f(ms.articulationRatio)]);
              if (ms.surpriseBoost !== undefined) rows.push(['mood.surp', _f(ms.surpriseBoost)]);
              if (ms.tension !== undefined) rows.push(['mood.tens', _f(ms.tension)]);
            }
          }
        }
      } catch(e) {}
      return rows;
    },

    gestureClass: function() {
      var rows = [];
      try {
        if (typeof GestureClassifier !== 'undefined' && GestureClassifier.getGesture) {
          var g = GestureClassifier.getGesture();
          if (g) {
            rows.push(['gest.type', g.type || '\u2014']);
            if (g.energy !== undefined) rows.push(['gest.energy', _f(g.energy)]);
            if (g.velocity !== undefined) rows.push(['gest.vel', _f(g.velocity)]);
          }
        }
      } catch(e) {}
      return rows;
    },

    musicMetrics: function() {
      var rows = [];
      try {
        if (typeof MusicMetrics !== 'undefined') {
          if (MusicMetrics.getMI) {
            var mi = MusicMetrics.getMI();
            if (mi) { rows.push(['MI', mi.score + ' (' + mi.grade + ')']); }
          }
          if (MusicMetrics.getReport) {
            var rp = MusicMetrics.getReport();
            if (rp) {
              if (rp.consonance !== undefined) rows.push(['mt.conso', _f(rp.consonance)]);
              if (rp.formClarity !== undefined) rows.push(['mt.form', _f(rp.formClarity)]);
              if (rp.tensionArc !== undefined) rows.push(['mt.tArc', _f(rp.tensionArc)]);
            }
          }
        }
      } catch(e) {}
      return rows;
    },

    pairwiseTens: function() {
      var rows = [];
      try {
        if (typeof ContextIntegrator !== 'undefined') {
          var pairs = [['bass','rhythm'],['bass','soloist'],['soloist','lead'],['rhythm','lead']];
          for (var i = 0; i < pairs.length; i++) {
            if (ContextIntegrator.getPairwiseTension) {
              var t = ContextIntegrator.getPairwiseTension(pairs[i][0], pairs[i][1]);
              if (t !== null && t !== undefined) rows.push([pairs[i][0].slice(0,4) + '\u2194' + pairs[i][1].slice(0,4), _f(t)]);
            }
          }
          if (ContextIntegrator.getRelationalEntropy) rows.push(['rel.entropy', _f(ContextIntegrator.getRelationalEntropy())]);
        }
      } catch(e) {}
      return rows;
    },

    saturation: function() {
      var rows = [];
      try {
        if (typeof ContextIntegrator !== 'undefined') {
          if (ContextIntegrator.getSaturatedPCs) {
            var sat = ContextIntegrator.getSaturatedPCs();
            if (sat && sat.length > 0) rows.push(['saturated', sat.map(function(pc) { return NOTE_NAMES[pc]; }).join(' ')]);
          }
          if (ContextIntegrator.isDensityBudgetExceeded) rows.push(['densBudget', _b(ContextIntegrator.isDensityBudgetExceeded())]);
          if (ContextIntegrator.getDensityVariance) rows.push(['densVar', _f(ContextIntegrator.getDensityVariance())]);
          if (ContextIntegrator.isRhythmStable) rows.push(['rhythStab', _b(ContextIntegrator.isRhythmStable())]);
          if (ContextIntegrator.isBassStable) rows.push(['bassStab', _b(ContextIntegrator.isBassStable())]);
        }
      } catch(e) {}
      return rows;
    },

    ensembleSummary: function() {
      var rows = [];
      try {
        if (typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getEnsembleSnapshot) {
          var snap = ContextIntegrator.getEnsembleSnapshot();
          if (snap) {
            if (snap.overall_tension !== undefined) rows.push(['ens.tension', _f(snap.overall_tension)]);
            if (snap.densities) { var total = 0; var vs = Object.keys(snap.densities); for (var i = 0; i < vs.length; i++) total += snap.densities[vs[i]] || 0; rows.push(['ens.density', _f(total, 2)]); }
          }
        }
        if (typeof PhaseCoupling !== 'undefined' && PhaseCoupling.getOrderParameter) rows.push(['ens.sync', _f(PhaseCoupling.getOrderParameter())]);
        if (typeof FinalCoordinator !== 'undefined' && FinalCoordinator.getBassRoot) rows.push(['ens.root', NOTE_NAMES[FinalCoordinator.getBassRoot() || 0]]);
        if (typeof FinalCoordinator !== 'undefined' && FinalCoordinator.getDensity) rows.push(['ens.nps', _f(FinalCoordinator.getDensity(), 2)]);
      } catch(e) {}
      return rows;
    }

  };

  // ═══════════════════════════════════════════════════════════
  // §3b  EVENTBUS NERVE IMPULSES
  // ═══════════════════════════════════════════════════════════

  function _firePulse(clusterFnNames, voiceKey) {
    var col = VOICE_COLORS[voiceKey] || VOICE_COLORS.system;
    for (var i = 0; i < clusterFnNames.length; i++) {
      var idx = _clusterByFn[clusterFnNames[i]];
      if (idx === undefined) continue;
      var c = _clusters[idx];
      // Stack pulses but cap at 1.0
      c.pulse = Math.min(1.0, c.pulse + 0.7);
      c.pulseR = col[0];
      c.pulseG = col[1];
      c.pulseB = col[2];
    }
  }

  // noteProduced fires ~200/min — throttle to max 10/s per voice
  var _noteThrottle = {};
  var NOTE_THROTTLE_MS = 100;

  function _wireEventBus() {
    if (_busWired || typeof EventBus === 'undefined') return;
    _busWired = true;

    var events = Object.keys(EVENT_CLUSTER_MAP);
    for (var i = 0; i < events.length; i++) {
      (function(eventName) {
        var mapping = EVENT_CLUSTER_MAP[eventName];
        EventBus.on(eventName, function(data) {
          if (!_active) return;

          // Throttle high-traffic noteProduced per voice
          if (eventName === 'noteProduced') {
            var vn = (data && data.voiceName) || 'unknown';
            var now = Date.now();
            if (_noteThrottle[vn] && (now - _noteThrottle[vn]) < NOTE_THROTTLE_MS) return;
            _noteThrottle[vn] = now;
          }

          // Resolve voice color
          var voiceKey;
          if (typeof mapping.color === 'function') {
            voiceKey = mapping.color(data || {});
          } else {
            voiceKey = mapping.color;
          }

          // Signal cascade: noteProduced ripples upward through layers
          if (mapping.cascade) {
            _queueCascade(voiceKey);
          } else {
            _firePulse(mapping.clusters, voiceKey);
          }
        });
      })(events[i]);
    }

    console.log('RawDump: EventBus wired — ' + events.length + ' channels → nerve impulses');
  }

  // ═══════════════════════════════════════════════════════════
  // §4  CANVAS TEXT RENDERING
  // ═══════════════════════════════════════════════════════════

  var _fontReady = false;

  function _ensureFont() {
    if (_fontReady) return;
    if (document.fonts && document.fonts.check && document.fonts.check('12px "Share Tech Mono"')) {
      _fontReady = true;
    }
  }

  function _drawWordCanvas(canvas, ctx, text, fontSize) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    _ensureFont();
    ctx.font = (fontSize || 24) + 'px "Share Tech Mono", monospace';
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 4, canvas.height / 2);
  }

  // ═══════════════════════════════════════════════════════════
  // §5  INIT — Build Three.js meshes
  // ═══════════════════════════════════════════════════════════

  function init(camera, scene) {
    _camera = camera;
    _scene = scene;
    if (typeof THREE === 'undefined' || !_scene) return;

    _rootGroup = new THREE.Group();
    _rootGroup.visible = false;
    _rootGroup.renderOrder = -10;  // render behind notes + particles — text is backdrop, not foreground
    _scene.add(_rootGroup);

    // Shared note uniforms for note-proximity lighting
    var notePositions = [];
    var noteColors = [];
    var noteOpacities = new Float32Array(MAX_NOTES);
    for (var n = 0; n < MAX_NOTES; n++) {
      notePositions.push(new THREE.Vector3(0, -100, 0));
      noteColors.push(new THREE.Vector3(0, 0, 0));
    }
    _noteUniforms = {
      uNoteCount:     { value: 0 },
      uNoteOnlyCount: { value: 0 },
      uNotePositions: { value: notePositions },
      uNoteColors:    { value: noteColors },
      uNoteOpacities: { value: noteOpacities }
    };

    for (var i = 0; i < CLUSTER_DEFS.length; i++) {
      var def = CLUSTER_DEFS[i];
      var readerFn = READERS[def.fn] || function() { return []; };
      _buildCluster(def, readerFn);
    }

    // Wire EventBus nerve impulses
    _wireEventBus();

    console.log('RawDump v7: ' + _clusters.length + ' clusters (color-coded L0-L6), EventBus ' + Object.keys(EVENT_CLUSTER_MAP).length + ' channels');
  }

  function _buildCluster(def, readerFn) {
    var style = LAYER_STYLE[def.layer] || LAYER_STYLE.META;
    var sc = style.sc;

    var group = new THREE.Group();
    group.position.set(def.x, def.y, def.z);

    // Orient VERTICAL — upright planes facing outward horizontally
    var outXZ = new THREE.Vector3(def.x, 0, def.z);
    if (outXZ.lengthSq() < 0.01) outXZ.set(1, 0, 0);
    outXZ.normalize();
    var target = new THREE.Vector3().copy(group.position).add(outXZ);
    target.y = group.position.y;
    group.lookAt(target);

    _rootGroup.add(group);

    // Per-layer scaled geometry
    var planeW = 1.2 * sc;
    var planeH = 0.15 * sc;
    var geo = new THREE.PlaneGeometry(planeW, planeH);

    var maxW = def.maxWords || 4;
    var words = [];
    var wordSpacing = 0.20 * sc;

    for (var w = 0; w < maxW; w++) {
      var canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 64;
      var ctx = canvas.getContext('2d');
      var tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;

      var mat = new THREE.ShaderMaterial({
        uniforms: {
          tText:          { value: tex },
          uBaseOpacity:   { value: def.op },
          uTime:          { value: Math.random() * 100 },
          uPulse:         { value: 0.0 },
          uPulseColor:    { value: new THREE.Vector3(0.2, 1.0, 0.2) },
          uLayerColor:    { value: new THREE.Vector3(style.r, style.g, style.b) },
          uLayerAmb:      { value: style.amb },
          uNoteCount:     _noteUniforms.uNoteCount,
          uNoteOnlyCount: _noteUniforms.uNoteOnlyCount,
          uNotePositions: _noteUniforms.uNotePositions,
          uNoteColors:    _noteUniforms.uNoteColors,
          uNoteOpacities: _noteUniforms.uNoteOpacities
        },
        vertexShader:   VERT,
        fragmentShader: FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      });

      var mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, -w * wordSpacing, 0);
      mesh.visible = false;
      group.add(mesh);

      words.push({
        mesh:     mesh,
        mat:      mat,
        canvas:   canvas,
        ctx:      ctx,
        tex:      tex,
        prevText: null,
        fontSize: style.fs,
        baseY:    -w * wordSpacing,
        microAmpX:   0.02 + Math.random() * 0.04,
        microAmpY:   0.01 + Math.random() * 0.03,
        microAmpZ:   0.015 + Math.random() * 0.03,
        microRateX:  0.12 + Math.random() * 0.18,
        microRateY:  0.10 + Math.random() * 0.20,
        microRateZ:  0.08 + Math.random() * 0.15,
        microPhaseX: Math.random() * Math.PI * 2,
        microPhaseY: Math.random() * Math.PI * 2,
        microPhaseZ: Math.random() * Math.PI * 2
      });
    }

    // Compute wall position: project cluster radially outward to box wall
    var wx = def.x, wy = def.y, wz = def.z;
    var maxAxis = Math.max(Math.abs(wx), Math.abs(wy), Math.abs(wz));
    if (maxAxis > 0.1) {
      var wallScale = WALL_SIZE / maxAxis;
      wx *= wallScale; wy *= wallScale; wz *= wallScale;
    } else {
      // Near-center clusters: push outward along a random direction
      var wa = Math.random() * Math.PI * 2;
      wx = Math.cos(wa) * WALL_SIZE;
      wz = Math.sin(wa) * WALL_SIZE;
      wy = def.y;
    }

    var clusterObj = {
      group:    group,
      words:    words,
      fn:       readerFn,
      fnName:   def.fn,
      layer:    def.layer,
      baseAmb:  style.amb,
      baseOp:   def.op,
      ax: def.x, ay: def.y, az: def.z,
      wx: wx, wy: wy, wz: wz,  // wall start position
      driftA:   0.15 + Math.random() * 0.20,
      driftRX:  0.06 + Math.random() * 0.08,
      driftRY:  0.05 + Math.random() * 0.08,
      driftOX:  Math.random() * Math.PI * 2,
      driftOY:  Math.random() * Math.PI * 2,
      pulse:    0.0,
      pulseR:   0.2, pulseG: 1.0, pulseB: 0.2
    };
    _clusterByFn[def.fn] = _clusters.length;
    _clusters.push(clusterObj);
  }

  // ═══════════════════════════════════════════════════════════
  // §6  UPDATE — called every frame
  // ═══════════════════════════════════════════════════════════

  function update() {
    if (!_rootGroup) return;
    // Must keep running during 'exiting' animation even though _active will go false
    if (!_active && _animPhase === 'idle') return;

    var now = Date.now();
    var t = now / 1000;

    // ── Float animation: lerp clusters between wall and destination ──
    if (_animPhase !== 'idle') {
      var elapsed = now - _animStart;
      var raw = Math.min(1.0, elapsed / ANIM_DURATION);
      var eased = _easeOutCubic(raw);

      for (var ai = 0; ai < _clusters.length; ai++) {
        var ac = _clusters[ai];
        var frac = _animPhase === 'entering' ? eased : (1.0 - eased);
        // Lerp position: wall → destination
        ac.group.position.x = ac.wx + (ac.ax - ac.wx) * frac;
        ac.group.position.y = ac.wy + (ac.ay - ac.wy) * frac;
        ac.group.position.z = ac.wz + (ac.az - ac.wz) * frac;
        // Fade opacity
        for (var aw = 0; aw < ac.words.length; aw++) {
          ac.words[aw].mat.uniforms.uBaseOpacity.value = ac.baseOp * frac;
        }
      }

      if (raw >= 1.0) {
        if (_animPhase === 'exiting') {
          _active = false;
          if (_rootGroup) _rootGroup.visible = false;
        }
        _animPhase = 'idle';
      }
      // During animation, still run the rest of update for content/lighting
    }
    var doContent = (now - _contentTimer) > 100;
    if (doContent) _contentTimer = now;

    // Update shared note uniforms from TimbralSpace
    _updateNoteUniforms();

    // ── Process cascade queue (staggered noteProduced ripples) ──
    var qi = 0;
    while (qi < _cascadeQueue.length) {
      var entry = _cascadeQueue[qi];
      if (now >= entry.fireAt) {
        _firePulse(entry.clusters, entry.voiceKey);
        _cascadeQueue.splice(qi, 1);
      } else {
        qi++;
      }
    }
    // Safety: cap queue size (prevents runaway if events flood)
    if (_cascadeQueue.length > 200) _cascadeQueue.length = 200;

    // ── Read gate readiness + harmonic confidence (10fps) ──
    if (doContent) {
      // Harmonic convergence: smooth toward current confidence
      try {
        if (typeof KeyBelief !== 'undefined' && KeyBelief.getConfidence) {
          var rawConf = KeyBelief.getConfidence() || 0;
          _harmonicConf += (rawConf - _harmonicConf) * 0.15;  // smooth
        }
      } catch(e) {}
    }

    // All clusters
    for (var i = 0; i < _clusters.length; i++) {
      var c = _clusters[i];

      // Macro drift (cluster group) — only during idle, animation controls position otherwise
      if (_animPhase === 'idle') {
        c.group.position.x = c.ax + Math.sin(t * c.driftRX + c.driftOX) * c.driftA;
        c.group.position.y = c.ay + Math.cos(t * c.driftRY + c.driftOY) * c.driftA;
      }

      // Pulse decay — exponential falloff (~0.4s to near-zero)
      if (c.pulse > 0.005) {
        c.pulse *= 0.92;  // ~60fps → half-life ~0.4s
      } else {
        c.pulse = 0;
      }

      // ── Gate Readiness Glow (L1 voice clusters) ──
      // L1 clusters brighten as gate readiness ramps toward 1.0
      // You literally see voices "charging up" before they play
      var ambMod = 1.0;
      var voiceName = GATE_VOICE_MAP[c.fnName];
      if (voiceName) {
        try {
          var params = BeliefState.getParams(voiceName);
          var gp = params.gateProb || 0;
          // 0.15 floor (dim but visible) → 2.5x at full readiness (overbright for bloom)
          ambMod = 0.15 + gp * 2.35;
        } catch(e) {}
      }

      // ── Harmonic Convergence Glow (L3/HARM clusters) ──
      // Brighten when voices converge on key — dim during modulation
      if (HARMONIC_CLUSTERS[c.fnName]) {
        // confidence 0→1 maps to 0.4→2.0 ambient multiplier
        ambMod = 0.4 + _harmonicConf * 1.6;
      }

      // Per-word micro drift + time + pulse + dynamic ambient
      var dynamicAmb = c.baseAmb * ambMod;
      for (var w = 0; w < c.words.length; w++) {
        var word = c.words[w];
        if (!word.mesh.visible) continue;
        word.mesh.position.x = Math.sin(t * word.microRateX + word.microPhaseX) * word.microAmpX;
        word.mesh.position.y = word.baseY + Math.cos(t * word.microRateY + word.microPhaseY) * word.microAmpY;
        word.mesh.position.z = Math.sin(t * word.microRateZ + word.microPhaseZ) * word.microAmpZ;
        word.mat.uniforms.uTime.value = t + i * 7.3;
        word.mat.uniforms.uPulse.value = c.pulse;
        word.mat.uniforms.uPulseColor.value.set(c.pulseR, c.pulseG, c.pulseB);
        word.mat.uniforms.uLayerAmb.value = dynamicAmb;
      }

      // Content update (10fps)
      if (doContent) {
        var rows = c.fn();
        for (var r = 0; r < c.words.length; r++) {
          var wd = c.words[r];
          if (r < rows.length) {
            var txt = rows[r][0] + ': ' + rows[r][1];
            if (txt !== wd.prevText) {
              _drawWordCanvas(wd.canvas, wd.ctx, txt, wd.fontSize);
              wd.tex.needsUpdate = true;
              wd.prevText = txt;
            }
            if (!wd.mesh.visible) wd.mesh.visible = true;
          } else {
            if (wd.mesh.visible) wd.mesh.visible = false;
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §7  NOTE UNIFORM UPDATE
  // ═══════════════════════════════════════════════════════════

  function _updateNoteUniforms() {
    if (!_noteUniforms) return;

    // 1. Note sphere lights
    var noteData = [];
    try {
      if (typeof TimbralSpace !== 'undefined' && TimbralSpace.getActiveNoteData) {
        noteData = TimbralSpace.getActiveNoteData();
      }
    } catch(e) {}

    // 2. Scatter spark lights (proxy lights — no geometry, just light on text)
    var scatterData = [];
    try {
      if (typeof TimbralSpace !== 'undefined' && TimbralSpace.getActiveScatterData) {
        scatterData = TimbralSpace.getActiveScatterData();
      }
    } catch(e) {}

    var positions = _noteUniforms.uNotePositions.value;
    var colors = _noteUniforms.uNoteColors.value;
    var opacities = _noteUniforms.uNoteOpacities.value;

    var idx = 0;
    var maxSlots = MAX_NOTES;

    // Write note lights (dim — just ambient awareness)
    for (var i = 0; i < noteData.length && idx < maxSlots; i++) {
      var nd = noteData[i];
      positions[idx].set(nd.x, nd.y, nd.z);
      colors[idx].set(nd.r, nd.g, nd.b);
      opacities[idx] = nd.opacity;
      idx++;
    }

    var noteOnlyCount = idx;  // boundary: slots 0..noteOnlyCount are notes (dim)

    // Write scatter spark lights (bright flash on text)
    for (var j = 0; j < scatterData.length && idx < maxSlots; j++) {
      var sd = scatterData[j];
      positions[idx].set(sd.x, sd.y, sd.z);
      colors[idx].set(sd.r, sd.g, sd.b);
      opacities[idx] = sd.opacity;
      idx++;
    }

    _noteUniforms.uNoteCount.value = idx;
    _noteUniforms.uNoteOnlyCount.value = noteOnlyCount;

    // Clear remaining slots
    for (var k = idx; k < maxSlots; k++) {
      positions[k].set(0, -100, 0);
      colors[k].set(0, 0, 0);
      opacities[k] = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §8  MIDI CAPTURE
  // ═══════════════════════════════════════════════════════════

  function _captureMidi(data) {
    if (!data || data.length < 2) return;
    var hex = [];
    for (var i = 0; i < Math.min(data.length, 3); i++) {
      hex.push(data[i].toString(16).toUpperCase().padStart(2, '0'));
    }
    _midiLog.unshift(hex.join(' '));
    if (_midiLog.length > 4) _midiLog.length = 4;
  }

  // ═══════════════════════════════════════════════════════════
  // §9  PUBLIC API
  // ═══════════════════════════════════════════════════════════

  function _easeOutCubic(t) { return 1 - (1 - t) * (1 - t) * (1 - t); }

  function toggle() {
    if (typeof TimbralSpace !== 'undefined' && !TimbralSpace.isActive()) {
      console.log('RawDump: requires 3D mode (press ` first)');
      return;
    }
    if (_animPhase === 'entering' || _animPhase === 'exiting') return; // mid-animation

    _animStart = Date.now();
    if (!_active) {
      // Show: start entering from walls
      _active = true;
      _animPhase = 'entering';
      if (_rootGroup) _rootGroup.visible = true;
      // Set clusters to wall positions immediately
      for (var i = 0; i < _clusters.length; i++) {
        var c = _clusters[i];
        c.group.position.set(c.wx, c.wy, c.wz);
      }
    } else {
      // Hide: start exiting to walls
      _animPhase = 'exiting';
    }
  }

  function isActive() { return _active; }

  return { init: init, update: update, toggle: toggle, isActive: isActive, _captureMidi: _captureMidi };

})();

window.RawDump = RawDump;

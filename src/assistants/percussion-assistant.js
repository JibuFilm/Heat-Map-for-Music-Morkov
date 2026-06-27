'use strict';
// ═══ PERCUSSION ASSISTANT (Phase E — 4th voice) ═══
//
// The percussion voice operates on a fundamentally different axis from
// bass/rhythm/soloist: drum names instead of pitch classes, beat-grid alignment
// instead of IOI-ratio scheduling.
//
// Beat-grid scheduling:
//   Patterns define hit positions as beat fractions within a 4-beat bar.
//   Each tick, the assistant checks if any scheduled hit has been crossed
//   since the last tick. If so, SoundEngine.playDrum() fires.
//
// Pattern selection:
//   Driven by SectionTracker state: sparse in STABLE/RELEASE, basic in
//   BUILD, driving in PEAK. Belief state gates overall activity.
//
// No FinalCoordinator integration needed — percussion has no pitch to
// collide with other voices. No Scheduler integration — beat-grid is
// self-contained.
//
// Depends on: sound-engine.js, bar-tracker.js, tempo-engine.js,
//             belief-state.js, phase-coupling.js, section-tracker.js
// Load order: after solo-assistant.js, before app.js wiring

var PercussionAssistant = (function() {

  var enabled = false;
  var _lastBarPhase = -1;  // tracks where we were last tick (0-1)
  var _coldStartElapsed = 0;
  var _coldStartDone = false;
  var _noteCount = 0;

  // v2.6.1: Multi-bar phrase state
  var _phraseBarCount = 0;       // 0-3: position within 4-bar phrase
  var _phraseLength = 4;         // bars per phrase
  var _phraseBasePattern = null;  // the "establish" pattern selected at bar 0
  var _phraseRole = 'establish';  // establish|repeat|develop|turnaround
  var _totalBarsInSection = 0;   // bars since section changed (for fill grid)
  var _cachedSectionState = '';   // detect section transitions

  // v2.6.1: Hat openness — continuous state driven by section energy
  var _hatOpenness = 0.0;  // 0=closed, 1=open

  // v2.5.3: Cross-voice ensemble awareness (beat-aligned updates)
  var _ensembleSnap = null;       // cached ContextIntegrator.getEnsembleSnapshot()
  var _dialogueStance = null;     // cached DialogueEngine.getStance()
  var _ensembleUpdatePhase = 0;   // last phase at which ensemble was sampled
  var _ENSEMBLE_UPDATE_INTERVAL = 0.25;  // update every beat (research: 1-beat adaptation lag)

  // v2.4: Ghost note velocity calibration (from universal percussion research)
  // Research: ghost notes should be vel 0.08-0.17, not 0.20-0.50
  var VEL_FLOOR = 0.08;
  var GHOST_VEL_CEILING = 0.17;

  // v2.1: Tempo inertia — low-pass filter prevents percussion from jerking
  // with every human phrase. Drums are the temporal anchor; they should resist
  // sudden tempo changes and smooth the ensemble's sense of pulse.
  var _smoothedBPM = 0;  // 0 = uninitialized
  var _TEMPO_INERTIA = 0.995;  // higher = more stable (0.995 ≈ 2.2s half-life at 16ms ticks)

  // ═══════════════════════════════════════
  // BEAT PATTERNS
  // ═══════════════════════════════════════
  // Each pattern defines hit positions as fractions of a bar (0-1).
  // Beat 0 = 0.0, Beat 1 = 0.25, Beat 2 = 0.5, Beat 3 = 0.75
  // Subdivisions: eighth = 0.125, sixteenth = 0.0625

  var PATTERNS = {
    sparse: {
      kick:  [0.0],
      snare: [0.5],
      hat:   [0.0, 0.25, 0.5, 0.75]
    },
    basic: {
      kick:  [0.0, 0.5],
      snare: [0.25, 0.75],
      hat:   [0.0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]
    },
    driving: {
      kick:  [0.0, 0.25, 0.5, 0.75],
      snare: [0.25, 0.75],
      hat:   [0.0, 0.0625, 0.125, 0.1875, 0.25, 0.3125, 0.375, 0.4375,
              0.5, 0.5625, 0.625, 0.6875, 0.75, 0.8125, 0.875, 0.9375]
    }
  };

  // Fill pattern — dense snare+kick burst used during BUILD→PEAK transition
  var FILL_PATTERN = {
    kick:  [0.0, 0.25, 0.5, 0.75],
    snare: [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875],
    hat:   [0.0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]
  };
  var _fillActive = false;
  var _fillStartTime = 0;
  var _FILL_DURATION_MS = 500;  // half a bar at 120 BPM

  var _currentPatternName = 'basic';
  var _currentPattern = PATTERNS.basic;
  var _currentTimbre = '808';  // user-selectable, defaults to 808
  var _useLexiconFormat = false;  // true when current pattern uses {pos,vel,prob} objects

  // ═══════════════════════════════════════
  // v3.15.0: GESTURAL MODE — Textural Percussion
  // ═══════════════════════════════════════
  // Instead of beat patterns, percussion plays sparse gestures driven by
  // NarrativeArc + MelodicIntent + MoodState. Silence is the default state.
  // Pattern mode preserved as opt-in fallback.
  //
  // Psychoacoustic grounding:
  //   Bregman 1990: sparse events = per-hit attention (not habituated stream)
  //   Large & Jones 1999: no temporal expectations → each hit is genuine event
  //   Huron 2006: low prediction + high surprise = emotional impact
  //   Berlyne: complexity only at structural moments → optimal arousal
  var _gestureMode = true;           // false = legacy pattern mode
  var _gestureQueue = [];            // [{drum, time, vel, opts}] scheduled hits
  var _lastGestureEndTime = 0;       // when last gesture's final hit is scheduled
  var _gestureMinGapMs = 1200;       // minimum gap between gestures (arc-responsive)
  var GESTURAL_GATE_SCALE = 0.12;    // multiplier on gateProb in gestural mode

  // Gesture vocabulary — each type defines how to generate a hit sequence.
  // intent affinity: [continuation, punctuation, consonance, contrast]
  var GESTURE_TYPES = {
    silence:    { affinity: [1.0,  0.2,  0.6,  0.0], minHits: 0, maxHits: 0 },
    accent:     { affinity: [0.1,  0.9,  0.2,  0.7], minHits: 1, maxHits: 1 },
    double_tap: { affinity: [0.2,  0.7,  0.3,  0.5], minHits: 2, maxHits: 2 },
    roll:       { affinity: [0.3,  0.4,  0.6,  0.8], minHits: 4, maxHits: 8 },
    swell:      { affinity: [0.6,  0.1,  0.9,  0.3], minHits: 6, maxHits: 12 },
    brush:      { affinity: [0.5,  0.2,  0.8,  0.2], minHits: 2, maxHits: 4 },
    decay:      { affinity: [0.7,  0.3,  0.4,  0.1], minHits: 1, maxHits: 1 },
    // v8.6.0 Gap 7: Cymbal gesture types
    // Pressing 2002: ride pattern as timekeeping substrate in jazz/electronic
    ride_pattern: { affinity: [0.7,  0.2,  0.8,  0.3], minHits: 3, maxHits: 8 },
    // London 2012: cymbal crashes create metric accent hierarchy at structural boundaries
    crash_accent: { affinity: [0.1,  0.8,  0.3,  0.9], minHits: 1, maxHits: 2 }
  };

  // Arc phase modifiers — boost/penalize gesture types per narrative phase
  var PHASE_GESTURE_MOD = {
    establish:  { silence: 1.5, decay: 1.3, brush: 0.8, accent: 0.3, roll: 0.2, swell: 0.5, ride_pattern: 0.3, crash_accent: 0.1 },
    develop:    { brush: 1.4, swell: 1.2, decay: 1.0, accent: 0.8, silence: 0.7, roll: 0.6, ride_pattern: 0.8, crash_accent: 0.3 },
    climax:     { accent: 1.5, roll: 1.4, double_tap: 1.3, swell: 1.0, silence: 0.2, brush: 0.6, ride_pattern: 1.3, crash_accent: 1.2 },
    resolve:    { decay: 1.5, silence: 1.3, brush: 1.0, swell: 0.8, accent: 0.4, roll: 0.3, ride_pattern: 0.5, crash_accent: 0.8 },
    transition: { accent: 1.2, silence: 1.0, decay: 1.0, brush: 0.8, roll: 0.5, swell: 0.4, ride_pattern: 0.6, crash_accent: 1.0 }
  };

  // Drum selection weights by mood/energy context
  // v8.6.0 Gap 7: expanded pool with ride + crash (Zbikowski 2004: cymbals mark structural boundaries)
  // [kick, snare, hat, rimshot, tom_low, ride, crash]
  var DRUM_POOL = ['kick', 'snare', 'hat', 'rimshot', 'tom_low', 'ride', 'crash'];
  var DRUM_WEIGHTS_DEFAULT = [0.25, 0.20, 0.25, 0.08, 0.10, 0.08, 0.04];

  // ── Beat-grid quantization for gestural mode ──
  // Large & Jones 1999: attending oscillators lock to isochronous events.
  // London 2012: even sparse percussion creates metric framework when beat-aligned.
  // Gestures snap to nearest beat subdivision while preserving musical character.
  //
  // gridSize: 0.125 (8th note) or 0.0625 (16th note) as bar-phase fraction
  // Uses percussion's own _lastBarPhase accumulator (works in freerun without human input).
  // BarTracker requires human notes for phase estimation — unavailable in auto mode.
  function _snapToGrid(timeMs, gridSize) {
    var barMs = 60000 / (_smoothedBPM || 120) * 4;
    if (barMs <= 0 || _lastBarPhase < 0) return timeMs;

    // Project from current phase to the requested time
    var now = Date.now();
    var phase = _lastBarPhase;
    if (Math.abs(timeMs - now) > 5 && barMs > 0) {
      phase = ((phase + (timeMs - now) / barMs) % 1.0 + 1.0) % 1.0;
    }

    var gridPhase = Math.round(phase / gridSize) * gridSize;
    if (gridPhase >= 1.0) gridPhase -= 1.0;

    var phaseDiff = gridPhase - phase;
    if (phaseDiff > 0.5) phaseDiff -= 1.0;
    if (phaseDiff < -0.5) phaseDiff += 1.0;

    return timeMs + phaseDiff * barMs;
  }

  // Section-dependent expressive micro-jitter (London 2012)
  // STABLE/BUILD: tight snap. PEAK: ±10ms humanization. RELEASE: ±5ms.
  var _QUANTIZE_JITTER = { STABLE: 0, BUILD: 0, PEAK: 10, RELEASE: 5 };

  function _applyGridJitter(timeMs) {
    var jitter = 0;
    if (typeof SectionTracker !== 'undefined') {
      var sec = SectionTracker.getVoiceState('percussion').state;
      jitter = _QUANTIZE_JITTER[sec] || 0;
    }
    if (jitter === 0) return timeMs;
    return timeMs + (Math.random() * 2 - 1) * jitter;
  }

  // v2.6.0: Drum lexicon system — character model
  // Each "drummer" is a character with vocabulary (lexicon) + timbre (sound)
  var _drumLexicon = null;      // Array of pattern objects from drum lexicon JSON
  var _drumLexiconLoaded = false;
  var _LEXICON_SCAN_LIMIT = 50; // how many lexicon patterns to score per selection
  var _loadSeq = 0;             // load sequence counter — prevents stale fetch races

  // Drum lexicon map: timbre → lexicon file path
  var _DRUM_LEXICON_MAP = {
    'jazz_brushes': 'data/Lexicon/drums/jazz_brushes.json',
    'latin_perc':   'data/Lexicon/drums/latin_perc.json',
    'soul_pocket':  'data/Lexicon/drums/soul_pocket.json',
    'timpani':      'data/Lexicon/drums/timpani.json',
    'maracas':      'data/Lexicon/drums/maracas.json'
  };

  // ── Drum lexicon scoring (v2.6.0) ──
  // Cannot reuse pitch scoreLexiconEntry() — no scale-fit gate for drums
  function _scoreDrumPattern(pattern, context) {
    var score = 0;

    // 1. Energy range fit
    if (pattern.energy_range && context.energy !== undefined) {
      var e = context.energy;
      if (e >= pattern.energy_range[0] && e <= pattern.energy_range[1]) {
        score += 0.10;
      } else {
        var dist = Math.min(Math.abs(e - pattern.energy_range[0]),
                            Math.abs(e - pattern.energy_range[1]));
        score -= dist * 0.15;
      }
    }

    // 2. Section affinity
    if (pattern.section_affinity && context.sectionState) {
      if (pattern.section_affinity.indexOf(context.sectionState) >= 0) {
        score += 0.12;
      } else {
        score -= 0.04;
      }
    }

    // 3. Density fit — match pattern density to section density target
    if (pattern.density !== undefined && context.sectionDensity !== undefined) {
      var densityDiff = Math.abs(pattern.density - context.sectionDensity);
      score -= densityDiff * 0.3;
    }

    // 4. Syncopation fit — Witek inverted-U: moderate is best
    if (pattern.syncopation !== undefined) {
      score += (1.0 - Math.abs(pattern.syncopation - 0.4)) * 0.15;
    }

    // 5. Interest
    if (pattern.interest !== undefined) {
      score += pattern.interest * 0.1;
    }

    // 6. Frequency bonus
    if (pattern.frequency) {
      score += Math.log(pattern.frequency + 1) / 20;
    }

    return score;
  }

  // Select best pattern from drum lexicon based on current context
  function _selectFromLexicon() {
    if (!_drumLexicon || _drumLexicon.length === 0) return null;

    var sectionState = 'BUILD';
    var energy = 0.5;
    var density = 0.5;
    if (typeof SectionTracker !== 'undefined') {
      try {
        var st = SectionTracker.getVoiceState('percussion');
        sectionState = st.state || 'BUILD';
        energy = st.energy || 0.5;
        density = st.density || 0.5;
      } catch (e) {}
    }

    // v2.6.1: Gadd principle — adjust density target based on ensemble busyness
    var densityTarget = (typeof PERC_DENSITY_TARGETS !== 'undefined' && PERC_DENSITY_TARGETS[sectionState])
      ? PERC_DENSITY_TARGETS[sectionState] : density;
    if (_ensembleSnap && _ensembleSnap.voiceDensities) {
      var totalDens = 0;
      var vd = _ensembleSnap.voiceDensities;
      totalDens = (vd.bass || 0) + (vd.rhythm || 0) + (vd.soloist || 0) + (vd.lead || 0);
      var ensembleBusyness = Math.min(1.0, totalDens / 4.0);
      densityTarget *= (1.3 - ensembleBusyness * 0.6);  // busy ensemble → sparser percussion
      densityTarget = Math.max(0.15, Math.min(0.85, densityTarget));
    }

    var context = {
      sectionState: sectionState,
      energy: energy,
      sectionDensity: densityTarget
    };

    // Score a random subset (avoid scanning entire lexicon every time)
    var candidates = _drumLexicon;
    if (candidates.length > _LEXICON_SCAN_LIMIT) {
      // Weighted random sample — prefer patterns we haven't recently used
      candidates = [];
      var indices = [];
      for (var i = 0; i < _drumLexicon.length; i++) indices.push(i);
      // Shuffle and take first SCAN_LIMIT
      for (var j = indices.length - 1; j > 0; j--) {
        var k = Math.floor(Math.random() * (j + 1));
        var tmp = indices[j]; indices[j] = indices[k]; indices[k] = tmp;
      }
      for (var m = 0; m < _LEXICON_SCAN_LIMIT && m < indices.length; m++) {
        candidates.push(_drumLexicon[indices[m]]);
      }
    }

    var bestScore = -Infinity;
    var bestPattern = null;
    for (var pi = 0; pi < candidates.length; pi++) {
      var s = _scoreDrumPattern(candidates[pi], context);
      if (s > bestScore) {
        bestScore = s;
        bestPattern = candidates[pi];
      }
    }

    return bestPattern;
  }

  // Convert lexicon pattern to the format used by the hit loop
  function _convertLexiconPattern(lexPattern) {
    if (!lexPattern || !lexPattern.hits) return null;
    return lexPattern.hits;
  }

  // ═══════════════════════════════════════
  // v2.6.1: MULTI-BAR PHRASE SYSTEM
  // ═══════════════════════════════════════
  // Percussion thinks in 4-bar phrases: establish → repeat → develop → turnaround
  // Research: universal §4 (Elvin Jones), §3 (Steve Gadd)

  // Fill patterns by energy level
  var FILL_TYPES = {
    light: {
      snare: [{pos: 0.75, vel: 0.50, prob: 0.9}],
      kick:  [{pos: 0.75, vel: 0.40, prob: 0.7}]
    },
    medium: {
      snare: [{pos: 0.5, vel: 0.45, prob: 0.8}, {pos: 0.5625, vel: 0.50, prob: 0.7},
              {pos: 0.625, vel: 0.55, prob: 0.8}, {pos: 0.6875, vel: 0.60, prob: 0.9},
              {pos: 0.75, vel: 0.70, prob: 1.0}],
      kick:  [{pos: 0.5, vel: 0.50, prob: 0.6}, {pos: 0.75, vel: 0.60, prob: 0.8}]
    },
    heavy: {
      snare: [{pos: 0.25, vel: 0.40, prob: 0.7}, {pos: 0.3125, vel: 0.45, prob: 0.7},
              {pos: 0.375, vel: 0.50, prob: 0.8}, {pos: 0.4375, vel: 0.55, prob: 0.8},
              {pos: 0.5, vel: 0.60, prob: 0.9}, {pos: 0.5625, vel: 0.65, prob: 0.9},
              {pos: 0.625, vel: 0.70, prob: 1.0}, {pos: 0.6875, vel: 0.80, prob: 1.0},
              {pos: 0.75, vel: 0.90, prob: 1.0}],
      tom_high: [{pos: 0.25, vel: 0.55, prob: 0.5}],
      tom_mid:  [{pos: 0.375, vel: 0.55, prob: 0.5}],
      tom_low:  [{pos: 0.5, vel: 0.55, prob: 0.5}],
      kick:  [{pos: 0.75, vel: 0.70, prob: 0.9}]
    }
  };

  function _fillProbability() {
    var prob = 0.10;
    // 4/8/16-bar fill grid (research: universal §4)
    if (_totalBarsInSection > 0) {
      if ((_totalBarsInSection + 1) % 16 === 0) prob = 0.70;
      else if ((_totalBarsInSection + 1) % 8 === 0) prob = 0.50;
      else if ((_totalBarsInSection + 1) % 4 === 0) prob = 0.30;
    }
    // Section transition imminent
    if (typeof SectionTracker !== 'undefined') {
      try {
        var st = SectionTracker.getVoiceState('percussion');
        if ((st.resolutionUrgency || 0) > 0.6) prob = Math.max(prob, 0.85);
      } catch (e) {}
    }
    // v5 Phase 2: Anticipatory fills — boost fill probability when PEAK predicted
    if (typeof SectionTracker !== 'undefined' && typeof SectionTracker.getForecast === 'function') {
      try {
        var forecast = SectionTracker.getForecast('percussion');
        if (forecast && forecast.confidence > 0.5) {
          if (forecast.predictedState === 'PEAK') {
            prob = Math.max(prob, 0.50); // prepare transition fill into PEAK
          } else if (forecast.predictedState === 'RELEASE') {
            prob = Math.max(prob, 0.40); // wind-down fill approaching RELEASE
          }
        }
      } catch (e) {}
    }
    // Gadd: reduce fills when ensemble is dense
    if (_ensembleSnap && _ensembleSnap.voiceDensities) {
      var td = (_ensembleSnap.voiceDensities.bass || 0) + (_ensembleSnap.voiceDensities.rhythm || 0) +
               (_ensembleSnap.voiceDensities.soloist || 0) + (_ensembleSnap.voiceDensities.lead || 0);
      if (td > 3.0) prob *= 0.5;
    }
    return Math.min(prob, 0.90);
  }

  function _selectFillType() {
    var energy = 0.5;
    if (typeof SectionTracker !== 'undefined') {
      try { energy = SectionTracker.getVoiceState('percussion').energy || 0.5; } catch (e) {}
    }
    if (energy < 0.35) return FILL_TYPES.light;
    if (energy < 0.65) return FILL_TYPES.medium;
    return FILL_TYPES.heavy;
  }

  // Create a variation of a lexicon pattern
  // type: 'repeat' (minor prob changes), 'develop' (add ghosts, shift timing), 'turnaround' (thin out)
  function _varyPattern(baseHits, variationType) {
    if (!baseHits) return baseHits;
    var result = {};
    var drums = Object.keys(baseHits);
    for (var di = 0; di < drums.length; di++) {
      var drum = drums[di];
      var hits = baseHits[drum];
      var newHits = [];
      for (var hi = 0; hi < hits.length; hi++) {
        var h = hits[hi];
        var isStructural = (drum === 'kick' || drum === 'snare') &&
          (h.pos < 0.01 || Math.abs(h.pos - 0.25) < 0.02 ||
           Math.abs(h.pos - 0.5) < 0.02 || Math.abs(h.pos - 0.75) < 0.02);

        if (variationType === 'repeat') {
          // Minor prob variation: +/-10% on non-structural hits
          var probAdj = isStructural ? 0 : (Math.random() - 0.5) * 0.2;
          newHits.push({pos: h.pos, vel: h.vel, prob: Math.max(0.1, Math.min(1.0, (h.prob || 1.0) + probAdj))});
        } else if (variationType === 'develop') {
          newHits.push({pos: h.pos, vel: h.vel, prob: h.prob || 1.0});
        } else if (variationType === 'turnaround') {
          // Thin out: keep structural hits, drop 30% of others
          if (isStructural || Math.random() > 0.30) {
            newHits.push({pos: h.pos, vel: h.vel * 0.85, prob: h.prob || 1.0});
          }
        }
      }
      if (newHits.length > 0) result[drum] = newHits;
    }
    // Develop: add 1-2 ghost notes on unoccupied 16th positions for hat/shaker
    if (variationType === 'develop') {
      var ghostDrum = result.hat ? 'hat' : (result.shaker ? 'shaker' : null);
      if (ghostDrum) {
        var occupied = {};
        for (var ghi = 0; ghi < (result[ghostDrum] || []).length; ghi++) {
          occupied[result[ghostDrum][ghi].pos] = true;
        }
        var ghostsAdded = 0;
        for (var gp = 0.0625; gp < 1.0 && ghostsAdded < 2; gp += 0.0625) {
          var gpR = Math.round(gp * 10000) / 10000;
          if (!occupied[gpR] && Math.random() < 0.3) {
            result[ghostDrum].push({pos: gpR, vel: 0.12, prob: 0.5});
            ghostsAdded++;
          }
        }
      }
    }
    return result;
  }

  // Called on each bar boundary — drives the 4-bar phrase system
  function _onNewBar() {
    _totalBarsInSection++;

    // Check for section state change → reset phrase
    var currentSection = '';
    if (typeof SectionTracker !== 'undefined') {
      try { currentSection = SectionTracker.getVoiceState('percussion').state || ''; } catch (e) {}
    }
    if (currentSection !== _cachedSectionState) {
      _cachedSectionState = currentSection;
      _totalBarsInSection = 0;
      _phraseBarCount = 0;  // force new phrase on section change
    }

    // Update hat openness (smooth transition driven by section energy)
    var sectionEnergy = 0.3;
    if (typeof SectionTracker !== 'undefined') {
      try { sectionEnergy = SectionTracker.getVoiceState('percussion').energy || 0.3; } catch (e) {}
    }
    var targetOpenness = Math.max(0.0, Math.min(1.0, (sectionEnergy - 0.2) / 0.6));
    _hatOpenness += (targetOpenness - _hatOpenness) * 0.3;  // smooth per bar

    // Determine phrase role
    var barInPhrase = _phraseBarCount % _phraseLength;

    if (barInPhrase === 0) {
      // ESTABLISH: select a new base pattern from lexicon
      _phraseRole = 'establish';
      if (_drumLexiconLoaded && _drumLexicon && _drumLexicon.length > 0) {
        var selected = _selectFromLexicon();
        if (selected) {
          _phraseBasePattern = _convertLexiconPattern(selected);
          _currentPattern = _phraseBasePattern;
          _useLexiconFormat = true;
          _currentPatternName = 'lexicon';
        }
      }
    } else if (barInPhrase === 1) {
      // REPEAT: use base with minor variation
      _phraseRole = 'repeat';
      if (_phraseBasePattern) {
        _currentPattern = _varyPattern(_phraseBasePattern, 'repeat');
      }
    } else if (barInPhrase === 2) {
      // DEVELOP: add ghost notes, shift timing
      _phraseRole = 'develop';
      if (_phraseBasePattern) {
        _currentPattern = _varyPattern(_phraseBasePattern, 'develop');
      }
    } else {
      // TURNAROUND: thin out, check for fill
      _phraseRole = 'turnaround';
      var fp = _fillProbability();
      if (Math.random() < fp) {
        // Play a fill
        _fillActive = true;
        _fillStartTime = Date.now();
        _currentPattern = _selectFillType();
        _useLexiconFormat = true;
        try {
          if (typeof EventBus !== 'undefined') EventBus.emit('percFillSignal', { bar: _totalBarsInSection, prob: fp });
        } catch (e) {}
      } else if (_phraseBasePattern) {
        _currentPattern = _varyPattern(_phraseBasePattern, 'turnaround');
      }
    }

    _phraseBarCount++;
  }

  // Load a drum lexicon JSON file
  function _loadDrumLexicon(path) {
    _drumLexicon = null;
    _drumLexiconLoaded = false;
    // v2.6.0: sequence counter prevents stale fetch responses from overwriting newer loads
    var mySeq = ++_loadSeq;
    console.log('%c[PercussionAssistant] Loading drum lexicon: ' + path + ' (seq=' + mySeq + ')', 'color:#f80');

    fetch(path)
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        // Discard if a newer load was started while we were fetching
        if (mySeq !== _loadSeq) {
          console.log('[PercussionAssistant] Discarding stale load (seq=' + mySeq + ', current=' + _loadSeq + ')');
          return;
        }
        var patterns = data.patterns || [];
        if (patterns.length === 0) {
          console.warn('[PercussionAssistant] Drum lexicon empty: ' + path);
          return;
        }
        _drumLexicon = patterns;
        _drumLexiconLoaded = true;
        console.log('%c[PercussionAssistant] Loaded ' + patterns.length +
          ' drum patterns for ' + (data.meta && data.meta.character || 'unknown'),
          'color:#0f0;font-weight:bold');
        // Immediately select a pattern from the lexicon
        var selected = _selectFromLexicon();
        if (selected) {
          _currentPattern = _convertLexiconPattern(selected);
          _useLexiconFormat = true;
          _currentPatternName = 'lexicon';
        }
      })
      .catch(function(err) {
        if (mySeq !== _loadSeq) return;  // stale — ignore
        console.warn('[PercussionAssistant] Failed to load drum lexicon: ' + path, err);
        _drumLexicon = null;
        _drumLexiconLoaded = false;
      });
  }

  // v2.6.1: Context-only velocity multiplier for lexicon patterns
  // Returns a modifier (centered ~1.0) that scales the lexicon's velocity hint
  // without overriding it. Captures section energy, belief, ensemble, peer velocity.
  function _velocityMod(drumName, barPhase, isGhost) {
    var mod = 1.0;

    // Belief-driven: energy→louder, space→softer
    if (typeof BeliefState !== 'undefined') {
      try {
        var b = BeliefState.getBelief('percussion');
        if (b) {
          mod *= (1 + (b.needs_energy || 0) * 0.15 - (b.needs_space || 0) * 0.10);
        }
      } catch (e) {}
    }

    // Section energy gradient (STABLE ~0.93, PEAK ~1.06)
    if (typeof SectionTracker !== 'undefined') {
      try {
        var st = SectionTracker.getVoiceState('percussion');
        mod *= 0.85 + (st.energy || 0.3) * 0.25;
      } catch (e) {}
    }

    // Contour-responsive hat (Gadd: soften when soloist busy)
    if (drumName === 'hat' && _ensembleSnap) {
      var soloDens = (_ensembleSnap.voiceDensities && _ensembleSnap.voiceDensities.soloist) || 0;
      if (soloDens > 2) mod *= Math.max(0.75, 1.0 - soloDens * 0.05);
    }

    // Tension-responsive kick
    if (drumName === 'kick' && _ensembleSnap) {
      mod *= (1.0 + (_ensembleSnap.intervalTension || 0) * 0.12);
    }

    // Dialogue stance velocity
    if (_dialogueStance) {
      mod *= 0.92 + _dialogueStance.initiative * 0.16;
    }

    // Ghost note ceiling
    if (isGhost) mod = Math.min(mod, GHOST_VEL_CEILING / 0.5);  // keep ghost hints quiet

    // Peer velocity envelope (breathing/fatigue)
    if (typeof PeerVelocity !== 'undefined') mod *= PeerVelocity.getVelocity('percussion');

    return Math.max(0.3, Math.min(1.5, mod));
  }

  // Velocity shaping per drum (accent on strong beats)
  // v2.3: belief-driven velocity modulation — energy boosts accents, space softens
  // NOTE: Used only for legacy (non-lexicon) patterns. Lexicon patterns use _velocityMod().
  function _velocity(drumName, barPhase, isGhost) {
    var base = 0.7;
    // Accent beat 1 (0.0) and beat 3 (0.5)
    if (barPhase < 0.01 || (barPhase > 0.49 && barPhase < 0.51)) {
      base = 1.0;
    } else if (Math.abs(barPhase - 0.25) < 0.01 || Math.abs(barPhase - 0.75) < 0.01) {
      base = 0.85;
    }
    // Hats are quieter
    if (drumName === 'hat') base *= 0.5;

    // v2.3: Belief-driven dynamic — energy → louder accents, space → softer
    if (typeof BeliefState !== 'undefined') {
      try {
        var b = BeliefState.getBelief('percussion');
        if (b) {
          var energyW = b.needs_energy || 0;
          var spaceW = b.needs_space || 0;
          base *= (1 + energyW * 0.15 - spaceW * 0.10);
        }
      } catch (e) {}
    }

    // v2.5.3: Section energy velocity gradient (smooth, not stepped)
    // Research §15D: STABLE vel 70-85, BUILD 80-100, PEAK 100-127, RELEASE 50-70
    if (typeof SectionTracker !== 'undefined') {
      try {
        var st = SectionTracker.getVoiceState('percussion');
        var sectionEnergyMod = 0.85 + (st.energy || 0.3) * 0.25;  // STABLE: 0.93, PEAK: 1.06
        base *= sectionEnergyMod;
      } catch (e) {}
    }

    // v2.5.3: Contour-responsive hat — echo dominant melodic direction
    // Research §3 (Steve Gadd): soften when soloist is busy
    if (drumName === 'hat' && _ensembleSnap) {
      var contourSum = 0, contourCount = 0;
      var vc = _ensembleSnap.voiceContours;
      if (vc) {
        var cvNames = ['soloist', 'lead', 'rhythm'];
        for (var ci = 0; ci < cvNames.length; ci++) {
          if (vc[cvNames[ci]] !== 0 && vc[cvNames[ci]] !== undefined) {
            contourSum += vc[cvNames[ci]]; contourCount++;
          }
        }
      }
      if (contourCount > 0) {
        var avgContour = contourSum / contourCount;  // -1 to +1
        base *= (1.0 + avgContour * 0.08);  // ascending: +8%, descending: -8%
      }
      // Soloist active → soften hats for clarity (Gadd principle)
      var soloDens = (_ensembleSnap.voiceDensities && _ensembleSnap.voiceDensities.soloist) || 0;
      if (soloDens > 2) base *= Math.max(0.75, 1.0 - soloDens * 0.05);
    }

    // v2.5.3: Tension-responsive kick — accent dissonance
    if (drumName === 'kick' && _ensembleSnap) {
      var tension = _ensembleSnap.intervalTension || 0;
      base *= (1.0 + tension * 0.12);  // up to +12% at max tension
    }

    // v2.5.3: Dialogue stance velocity — subtle (percussion is anchor, not show)
    if (_dialogueStance) {
      var stanceVelMod = 0.92 + _dialogueStance.initiative * 0.16;  // support: 0.95, lead: 1.05
      base *= stanceVelMod;
    }

    var vel = Math.max(VEL_FLOOR, Math.min(1.0, base));
    // v2.4: Ghost notes capped at GHOST_VEL_CEILING (research: 0.08-0.17)
    if (isGhost) vel = Math.min(vel, GHOST_VEL_CEILING);
    // v2.5.1: Peer velocity envelope (breathing/fatigue)
    if (typeof PeerVelocity !== 'undefined') vel *= PeerVelocity.getVelocity('percussion');
    // v2.5.3: Final floor clamp (PeerVelocity can push below VEL_FLOOR)
    return Math.max(VEL_FLOOR, vel);
  }

  // v2.3: Per-hit probability gate — belief-driven hit suppression
  // energyMult > 1 during needs_energy (more hits), < 1 during needs_space (fewer)
  function _shouldFireHit(drumName, hitPos) {
    // Structural hits (beats 1 and 3 for kick/snare) always fire
    var isStructural = (drumName === 'kick' || drumName === 'snare') &&
      (hitPos < 0.01 || (hitPos > 0.24 && hitPos < 0.26) ||
       (hitPos > 0.49 && hitPos < 0.51) || (hitPos > 0.74 && hitPos < 0.76));
    if (isStructural) return true;

    // Belief-driven probability scaling
    var energyMult = 1.0;
    if (typeof BeliefState !== 'undefined') {
      try {
        var b = BeliefState.getBelief('percussion');
        if (b) {
          var energyW = b.needs_energy || 0;
          var spaceW = b.needs_space || 0;
          energyMult = 1.0 + energyW * 0.3 - spaceW * 0.4;
          energyMult = Math.max(0.5, Math.min(1.3, energyMult));
        }
      } catch (e) {}
    }

    // v8.5.0: Positive bass→kick coupling (Enhancement 5)
    // Clayton 2012: entrainment is bidirectional between rhythmic layers.
    // When bass recently played near this beat position, fire the kick (reinforcement).
    // Takes priority over bass density suppression below.
    if (drumName === 'kick' && !isStructural &&
        typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getBassNotePhases) {
      var bassPhases = ContextIntegrator.getBassNotePhases();
      if (bassPhases.length > 0) {
        var _bpNow = Date.now();
        var _bpBarMs = (typeof BarTracker !== 'undefined') ? BarTracker.getBarPeriod() : 2000;
        var _bpCutoff = _bpNow - _bpBarMs * 2; // last 2 bars
        for (var _bp = 0; _bp < bassPhases.length; _bp++) {
          if (bassPhases[_bp].time < _bpCutoff) continue;
          var _bd = Math.abs(bassPhases[_bp].phase - hitPos);
          if (_bd > 0.5) _bd = 1 - _bd;
          if (_bd < 0.08) return true; // bass played here recently — reinforce with kick
        }
      }
    }

    // v2.5.3: Bass-aware kick — reduce non-structural kicks when bass is active
    // Research §10: kick-bass frequency separation, sidechain-like interaction
    if (drumName === 'kick' && !isStructural && _ensembleSnap && _ensembleSnap.voiceDensities) {
      var bassDens = _ensembleSnap.voiceDensities.bass || 0;
      var kickBassMod = 1.0 - (bassDens - 0.5) * 0.15;
      kickBassMod = Math.max(0.6, Math.min(1.1, kickBassMod));
      // Bass in loop mode → kick locks tighter (reduce off-beat kicks)
      if (_ensembleSnap.voiceSources && _ensembleSnap.voiceSources.bass === 'loop') kickBassMod *= 0.85;
      if (Math.random() > kickBassMod) return false;
    }

    // Hats on off-beats are ornamental — apply probability gate
    if (drumName === 'hat') {
      var isOnBeat = (hitPos < 0.01 || Math.abs(hitPos - 0.25) < 0.01 ||
                      Math.abs(hitPos - 0.5) < 0.01 || Math.abs(hitPos - 0.75) < 0.01);
      if (!isOnBeat) {
        // v2.5.3: ensemble-aware ghost gating
        // Research §5: ghost notes thin when dense, thicken when sparse
        // Research §7: high entropy → simplify to anchor
        var ensembleMod = 1.0;
        if (_ensembleSnap && _ensembleSnap.voiceDensities) {
          var pitchDens = (_ensembleSnap.voiceDensities.bass || 0) +
            (_ensembleSnap.voiceDensities.rhythm || 0) +
            (_ensembleSnap.voiceDensities.soloist || 0) +
            (_ensembleSnap.voiceDensities.lead || 0);
          ensembleMod = 1.0 - (pitchDens - 4) * 0.08;  // dense→fewer, sparse→more
          var entropy = _ensembleSnap.relationalEntropy || 0;
          if (entropy > 0.6) ensembleMod *= 0.85;  // chaotic → simplify (bell/anchor role)
          ensembleMod = Math.max(0.5, Math.min(1.3, ensembleMod));
        }
        // v2.6.1: phrase-role modulation
        var phraseMod = 1.0;
        if (_phraseRole === 'turnaround') phraseMod = 0.7;   // thin out before next phrase
        else if (_phraseRole === 'establish') phraseMod = 1.2; // start clearly
        return Math.random() < (0.85 * energyMult * ensembleMod * phraseMod);
      }
    }

    // v8.6.0 Gap 7: Cymbal hit gating for pattern mode
    // Crashes/splashes only fire on strong metric positions (downbeat, beat 3).
    // Ride fires more freely but still probability-gated.
    if (drumName === 'ride' || drumName === 'crash' || drumName === 'splash') {
      if (drumName !== 'ride') {
        // Crash/splash: only on downbeats and beat 3
        var isDownbeat = hitPos < 0.02 || Math.abs(hitPos - 0.5) < 0.02;
        if (!isDownbeat) return false;
      }
      return Math.random() < (energyMult * 0.7);
    }

    return true;
  }

  // ═══════════════════════════════════════
  // PATTERN SELECTION (from SectionTracker)
  // ═══════════════════════════════════════

  function _selectPattern() {
    // v2.6.0: If drum lexicon is loaded, select from lexicon instead of hardcoded patterns
    if (_drumLexiconLoaded && _drumLexicon && _drumLexicon.length > 0) {
      var selected = _selectFromLexicon();
      if (selected) {
        _currentPattern = _convertLexiconPattern(selected);
        _useLexiconFormat = true;
        _currentPatternName = 'lexicon';
        return;
      }
    }

    // ── Fallback: hardcoded pattern selection (808/acoustic) ──
    // Genre-configurable percussion style
    var gc = (typeof getGenreConfig === 'function' && typeof SharedState !== 'undefined')
      ? getGenreConfig(SharedState.genre) : {};

    // Timbre is now user-controlled via UI — no genre override

    // Motorik: never change pattern — steady, hypnotic, no fills (Kraftwerk/TD/Neu!)
    if (gc.percStyle === 'motorik') return;

    if (typeof SectionTracker === 'undefined') return;
    var state = SectionTracker.getVoiceState('percussion');
    var newPattern = gc.percDefaultPattern || 'basic';

    if (gc.percStyle === 'sparse') {
      // Sparse style: only switch to basic at PEAK, otherwise always sparse
      newPattern = (state.state === 'PEAK') ? 'basic' : 'sparse';
    } else {
      // Standard / reactive: section-driven pattern selection
      if (state.state === 'STABLE' || state.state === 'RELEASE') {
        newPattern = 'sparse';
      } else if (state.state === 'PEAK') {
        newPattern = 'driving';
      } else if (state.state === 'TRANSITION') {
        newPattern = 'sparse';
      }
      // BUILD stays at default (basic)

      // v2.5.3: adventurousness-responsive pattern complexity
      // Research §9: high adventurousness → earlier escalation; low → restraint
      var adv = state.adventurousness || 0;
      if (adv > 0.6 && state.state === 'BUILD' && newPattern !== 'driving') {
        newPattern = 'driving';  // adventurous BUILD → jump to driving earlier
      }
      if (adv < 0.3 && state.state === 'PEAK') {
        newPattern = 'basic';  // restrained PEAK → don't over-drive
      }

      // v5 Phase 2: Forecast-driven pattern anticipation
      if (typeof SectionTracker.getForecast === 'function') {
        try {
          var pcForecast = SectionTracker.getForecast('percussion');
          if (pcForecast && pcForecast.confidence > 0.5) {
            // BUILD predicted from STABLE → escalate to basic early
            if (pcForecast.predictedState === 'BUILD' && state.state === 'STABLE' && newPattern === 'sparse') {
              newPattern = 'basic';
            }
            // PEAK predicted from BUILD → escalate to driving early
            if (pcForecast.predictedState === 'PEAK' && state.state === 'BUILD' && newPattern === 'basic') {
              newPattern = 'driving';
            }
          }
        } catch (e) {}
      }
    }

    if (newPattern !== _currentPatternName) {
      var oldPattern = _currentPatternName;

      // Fill detection: basic→driving = BUILD→PEAK transition
      // Play a fill burst before settling into the driving pattern
      if (oldPattern === 'basic' && newPattern === 'driving' && !_fillActive) {
        _fillActive = true;
        _fillStartTime = Date.now();
        _currentPattern = FILL_PATTERN;  // temporary fill pattern
        // Emit fill signal for other voices to react
        try {
          if (typeof EventBus !== 'undefined') EventBus.emit('percFillSignal', { from: oldPattern, to: newPattern });
        } catch(e) {}
      } else {
        _currentPattern = PATTERNS[newPattern];
      }

      _currentPatternName = newPattern;

      // Notify context integrator + event bus of pattern change
      try {
        if (typeof ContextIntegrator !== 'undefined') ContextIntegrator.onPercPatternChange(oldPattern, newPattern);
      } catch(e) {}
      try {
        if (typeof EventBus !== 'undefined') EventBus.emit('percPatternChange', { from: oldPattern, to: newPattern });
      } catch(e) {}
    }
  }

  // ═══════════════════════════════════════
  // GESTURAL SYSTEM — selection, scheduling, timbral params
  // ═══════════════════════════════════════

  // Select drum based on mood/energy context
  function _selectGestureDrum() {
    var weights = DRUM_WEIGHTS_DEFAULT.slice();
    // Mood-driven: high tension → more snare/rimshot, low → more hat/cymbal
    if (typeof MoodState !== 'undefined') {
      try {
        var mood = MoodState.getMood('percussion');
        if (mood && mood.harmonicTension > 0.4) {
          weights[1] += 0.15; // snare
          weights[3] += 0.10; // rimshot
          weights[2] -= 0.10; // less hat
        }
      } catch (e) {}
    }
    // Energy-driven: high energy → more kick
    if (typeof BeliefState !== 'undefined') {
      try {
        var b = BeliefState.getBelief('percussion');
        if (b && b.needs_energy > 0.4) weights[0] += 0.15;
        if (b && b.needs_space > 0.4) { weights[2] += 0.10; weights[4] += 0.10; }
      } catch (e) {}
    }
    // v8.6.0 Gap 7: Section-driven cymbal expression (Zbikowski 2004)
    // Cymbals mark structural boundaries: ride builds momentum, crash punctuates transitions.
    if (typeof SectionTracker !== 'undefined') {
      try {
        var _sec = SectionTracker.getVoiceState('percussion').state;
        if (_sec === 'PEAK') { weights[5] += 0.12; weights[6] += 0.08; }    // ride+crash at climax
        else if (_sec === 'BUILD') { weights[5] += 0.06; }                    // ride builds momentum
        else if (_sec === 'RELEASE') { weights[6] += 0.05; }                  // crash for resolution
      } catch (e) {}
    }
    // Normalize and pick
    var total = 0;
    for (var i = 0; i < weights.length; i++) { weights[i] = Math.max(0.02, weights[i]); total += weights[i]; }
    var roll = Math.random() * total;
    var cum = 0;
    for (var j = 0; j < weights.length; j++) {
      cum += weights[j];
      if (roll <= cum) return DRUM_POOL[j];
    }
    return DRUM_POOL[2]; // hat fallback
  }

  // Compute timbral parameters from beliefs + mood (Phase C)
  function _getTimbreParams() {
    var params = { decayMult: 1.0, brightness: 1.0, attackShape: 0 };
    // Mood-driven: minor → dark, major → bright
    if (typeof MoodState !== 'undefined') {
      try {
        var mood = MoodState.getMood('percussion');
        if (mood) {
          params.brightness = 0.6 + (mood.modeValence + 1) * 0.2; // -1→0.4, 0→0.6, +1→0.8
          params.brightness = Math.max(0.3, Math.min(1.2, params.brightness));
        }
      } catch (e) {}
    }
    // Section-driven: energy → longer decay, RELEASE → soft attacks
    if (typeof SectionTracker !== 'undefined') {
      try {
        var st = SectionTracker.getVoiceState('percussion');
        params.decayMult = 0.6 + (st.energy || 0.5) * 1.2; // low=short, high=long ring
        if (st.state === 'RELEASE' || st.state === 'STABLE') params.attackShape = 0.4;
      } catch (e) {}
    }
    // Belief-driven: space → longer ring
    if (typeof BeliefState !== 'undefined') {
      try {
        var b = BeliefState.getBelief('percussion');
        if (b && b.needs_space > 0.4) params.decayMult *= 1.4;
      } catch (e) {}
    }
    return params;
  }

  // Score and select a gesture type based on intent + arc + section + ensemble
  function _selectGesture() {
    // Read current intent probabilities
    var intentProbs = [0.25, 0.25, 0.25, 0.25]; // uniform fallback
    if (typeof MelodicIntent !== 'undefined' && MelodicIntent.getIntentProbs) {
      try {
        var probs = MelodicIntent.getIntentProbs('percussion');
        if (probs && probs.length === 4) intentProbs = probs;
      } catch (e) {}
    }

    // Read arc phase
    var arcPhase = 'develop'; // default
    if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getArc) {
      try {
        var arc = NarrativeArc.getArc('percussion');
        if (arc && arc.phase) arcPhase = arc.phase;
      } catch (e) {}
    }

    // Ensemble density — more silence when ensemble is busy
    var ensembleBusyness = 0;
    if (_ensembleSnap && _ensembleSnap.voiceDensities) {
      var vd = _ensembleSnap.voiceDensities;
      var totalDens = (vd.bass || 0) + (vd.rhythm || 0) + (vd.soloist || 0) + (vd.lead || 0);
      ensembleBusyness = Math.min(1.0, totalDens / 5.0);
    }

    // Score each gesture type
    var phaseMods = PHASE_GESTURE_MOD[arcPhase] || {};
    var types = Object.keys(GESTURE_TYPES);
    var scores = [];
    var totalScore = 0;
    for (var i = 0; i < types.length; i++) {
      var gType = GESTURE_TYPES[types[i]];
      // Dot product: intent affinity × intent probabilities
      var score = 0;
      for (var j = 0; j < 4; j++) score += gType.affinity[j] * intentProbs[j];
      // Arc phase modifier
      score *= (phaseMods[types[i]] || 1.0);
      // Ensemble busyness boosts silence, penalizes dense gestures
      if (types[i] === 'silence') score *= (1.0 + ensembleBusyness * 0.8);
      else if (gType.maxHits > 4) score *= (1.0 - ensembleBusyness * 0.5);
      else score *= (1.0 - ensembleBusyness * 0.2);
      score = Math.max(0.01, score);
      scores.push(score);
      totalScore += score;
    }

    // Weighted random selection
    var roll = Math.random() * totalScore;
    var cum = 0;
    for (var k = 0; k < types.length; k++) {
      cum += scores[k];
      if (roll <= cum) return types[k];
    }
    return 'silence';
  }

  // Schedule gesture hits into the queue — beat-grid quantized (v8.5.0)
  // Large & Jones 1999: temporal structure is necessary for attending.
  // Each gesture preserves its musical character while snapping to the beat grid.
  function _scheduleGesture(gestureName) {
    var now = Date.now();
    var timbreParams = _getTimbreParams();
    var drum = _selectGestureDrum();
    var barMs = 60000 / (_smoothedBPM || 120) * 4; // ms per bar
    var eighth = barMs * 0.125;    // ms per 8th note
    var sixteenth = barMs * 0.0625; // ms per 16th note

    if (gestureName === 'silence') {
      _lastGestureEndTime = now + _gestureMinGapMs;
      return;
    }

    if (gestureName === 'accent') {
      // Single sharp hit — snap to nearest 8th note
      var t = _applyGridJitter(_snapToGrid(now, 0.125));
      var accentVel = 0.65 + Math.random() * 0.25;
      _gestureQueue.push({
        drum: drum, time: t, vel: accentVel,
        opts: { hatOpenness: _hatOpenness, decayMult: timbreParams.decayMult * 0.7,
                brightness: timbreParams.brightness * 1.2, attackShape: 0 }
      });
      _lastGestureEndTime = t + 100;
    }

    else if (gestureName === 'double_tap') {
      // First on nearest 8th, second on next 16th (~62ms at 120BPM)
      var t1 = _applyGridJitter(_snapToGrid(now, 0.125));
      var t2 = _applyGridJitter(t1 + sixteenth);
      var vel1 = 0.55 + Math.random() * 0.20;
      _gestureQueue.push({
        drum: drum, time: t1, vel: vel1,
        opts: { hatOpenness: _hatOpenness, decayMult: timbreParams.decayMult * 0.6,
                brightness: timbreParams.brightness, attackShape: 0 }
      });
      _gestureQueue.push({
        drum: drum, time: t2, vel: vel1 * 0.65,
        opts: { hatOpenness: _hatOpenness, decayMult: timbreParams.decayMult * 0.5,
                brightness: timbreParams.brightness * 0.9, attackShape: 0.2 }
      });
      _lastGestureEndTime = t2 + 50;
    }

    else if (gestureName === 'roll') {
      // Start on nearest 8th, hits on grid-locked subdivisions.
      // Accelerates via decreasing grid multiples: 2×16th → 1×16th
      var numHits = 4 + Math.floor(Math.random() * 5);
      var t = _applyGridJitter(_snapToGrid(now, 0.125));
      for (var ri = 0; ri < numHits; ri++) {
        var progress = ri / Math.max(1, numHits - 1);
        var vel = 0.25 + progress * 0.55; // velocity ramp 0.25→0.80
        _gestureQueue.push({
          drum: (ri === numHits - 1) ? drum : 'snare',
          time: t, vel: vel,
          opts: { hatOpenness: _hatOpenness, decayMult: timbreParams.decayMult * (0.4 + progress * 0.6),
                  brightness: timbreParams.brightness * (0.7 + progress * 0.3), attackShape: 0 }
        });
        // Acceleration via grid compression: early=2×16th, late=1×16th
        var spacingMult = 2.0 - progress * 1.0;
        t += _applyGridJitter(sixteenth * spacingMult);
      }
      _lastGestureEndTime = t;
    }

    else if (gestureName === 'swell') {
      // Distribute across 8th-note positions over 1-2 bars, sine velocity
      var swellBars = 1.0 + Math.random();
      var totalEighths = Math.round(swellBars * 8);
      var numHits = Math.min(totalEighths, 6 + Math.floor(Math.random() * 7));
      var step = Math.max(1, Math.floor(totalEighths / numHits));
      var baseT = _snapToGrid(now, 0.125);
      for (var si = 0; si < numHits; si++) {
        var progress = si / Math.max(1, numHits - 1);
        var sinVel = Math.sin(progress * Math.PI) * 0.50 + 0.10;
        var hitT = _applyGridJitter(baseT + si * step * eighth);
        _gestureQueue.push({
          drum: 'hat', time: hitT, vel: sinVel,
          opts: { hatOpenness: Math.min(1.0, _hatOpenness + progress * 0.4),
                  decayMult: timbreParams.decayMult * 1.3, brightness: timbreParams.brightness * 0.8,
                  attackShape: 0.3 + (1 - Math.sin(progress * Math.PI)) * 0.4 }
        });
      }
      _lastGestureEndTime = baseT + totalEighths * eighth;
    }

    else if (gestureName === 'brush') {
      // Hits on 8th-note positions, 1-3 eighths apart (sparse, textural)
      var numHits = 2 + Math.floor(Math.random() * 3);
      var t = _snapToGrid(now, 0.125);
      for (var bi = 0; bi < numHits; bi++) {
        var vel = 0.12 + Math.random() * 0.20;
        _gestureQueue.push({
          drum: 'hat', time: _applyGridJitter(t), vel: vel,
          opts: { hatOpenness: Math.min(1.0, _hatOpenness + 0.3),
                  decayMult: timbreParams.decayMult * 1.5, brightness: timbreParams.brightness * 0.6,
                  attackShape: 0.5 + Math.random() * 0.3 }
        });
        // Jump 1-3 eighth notes forward
        t += eighth * (1 + Math.floor(Math.random() * 3));
      }
      _lastGestureEndTime = t;
    }

    else if (gestureName === 'decay') {
      // Single hit with extended ring — snap to nearest 8th
      var t = _applyGridJitter(_snapToGrid(now, 0.125));
      var vel = 0.45 + Math.random() * 0.25;
      _gestureQueue.push({
        drum: drum === 'snare' ? 'hat' : drum,
        time: t, vel: vel,
        opts: { hatOpenness: Math.min(1.0, _hatOpenness + 0.5),
                decayMult: timbreParams.decayMult * 2.5, brightness: timbreParams.brightness * 0.7,
                attackShape: 0.3 }
      });
      _lastGestureEndTime = t + 200;
    }

    // v8.6.0 Gap 7: Ride pattern — steady timekeeping on 8th-note grid
    // Pressing 2002: ride cymbal as rhythmic substrate, anchoring metric attention.
    // Beat 1 accented, others lighter. 3-8 hits depending on section energy.
    else if (gestureName === 'ride_pattern') {
      var rideHits = 3 + Math.floor(Math.random() * 6); // 3-8 hits
      var baseT = _snapToGrid(now, 0.125);
      for (var rpi = 0; rpi < rideHits; rpi++) {
        var hitT = _applyGridJitter(baseT + rpi * eighth);
        // Metric accent: every 4th eighth note (= beat boundaries) louder
        var rideVel = (rpi % 4 === 0) ? (0.55 + Math.random() * 0.15) : (0.35 + Math.random() * 0.15);
        _gestureQueue.push({
          drum: 'ride', time: hitT, vel: rideVel,
          opts: { decayMult: timbreParams.decayMult * 1.2, brightness: timbreParams.brightness,
                  attackShape: 0.1 }
        });
      }
      _lastGestureEndTime = baseT + rideHits * eighth;
    }

    // v8.6.0 Gap 7: Crash accent — structural boundary marker
    // London 2012: cymbal crashes create metric accent hierarchy.
    // 1-2 hits on quarter-note grid. High velocity, extended decay.
    else if (gestureName === 'crash_accent') {
      var crashT = _applyGridJitter(_snapToGrid(now, 0.25)); // snap to quarter note
      var crashVel = 0.70 + Math.random() * 0.20;
      _gestureQueue.push({
        drum: 'crash', time: crashT, vel: crashVel,
        opts: { decayMult: timbreParams.decayMult * 2.0, brightness: timbreParams.brightness * 1.1,
                attackShape: 0 }
      });
      // Optional second hit at half-bar (50% probability)
      if (Math.random() < 0.5) {
        var crashT2 = _applyGridJitter(crashT + barMs * 0.5);
        _gestureQueue.push({
          drum: 'crash', time: crashT2, vel: crashVel * 0.7,
          opts: { decayMult: timbreParams.decayMult * 1.5, brightness: timbreParams.brightness,
                  attackShape: 0.1 }
        });
        _lastGestureEndTime = crashT2 + 300;
      } else {
        _lastGestureEndTime = crashT + 300;
      }
    }
  }

  // Fire queued gesture hits and notify systems
  function _fireGestureHits() {
    var now = Date.now();
    var fired = 0;
    while (_gestureQueue.length > 0 && _gestureQueue[0].time <= now) {
      var hit = _gestureQueue.shift();
      try {
        SoundEngine.playDrum(hit.drum, hit.vel, _currentTimbre, hit.opts);
      } catch (e) {}
      _noteCount++;
      fired++;
      // Notify coupling + belief + context
      try { if (typeof PhaseCoupling !== 'undefined') PhaseCoupling.onNoteProduced('percussion'); } catch (e) {}
      try { if (typeof BeliefState !== 'undefined') BeliefState.onVoiceNote('percussion'); } catch (e) {}
      try {
        if (typeof ContextIntegrator !== 'undefined') {
          // Estimate phase at hit.time by projecting backward from current _lastBarPhase
          // (hit fires when hit.time <= now, so now >= hit.time)
          var _hitBarMs = 60000 / (_smoothedBPM || 120) * 4;
          var _hitPhase = _lastBarPhase;
          if (_hitBarMs > 0 && now > hit.time) {
            _hitPhase = ((_lastBarPhase - (now - hit.time) / _hitBarMs) % 1.0 + 1.0) % 1.0;
          }
          ContextIntegrator.onPercussionHit(hit.drum, _hitPhase, hit.vel);
        }
      } catch (e) {}
      try {
        if (typeof EventBus !== 'undefined') EventBus.emit('noteProduced', {
          voice: 'percussion', drum: hit.drum, velocity: hit.vel, time: now
        });
      } catch (e) {}
    }
    return fired;
  }

  // Gestural mode tick — replaces beat-grid scheduling
  function _gestureTick(dt) {
    var now = Date.now();

    // Bar-phase accumulator (shared with pattern mode for hat openness + ensemble updates)
    var rawBPM = (typeof TempoEngine !== 'undefined') ? TempoEngine.getEffectiveBPM() : 120;
    if (_smoothedBPM === 0) _smoothedBPM = rawBPM;
    _smoothedBPM = _smoothedBPM * _TEMPO_INERTIA + rawBPM * (1 - _TEMPO_INERTIA);
    var beatsPerMs = _smoothedBPM / 60000;
    var phaseIncrement = dt * beatsPerMs * 0.25;
    if (_lastBarPhase < 0) { _lastBarPhase = 0; return; }
    var barPhase = (_lastBarPhase + phaseIncrement) % 1.0;
    if (phaseIncrement > 0.25) { _lastBarPhase = barPhase; return; }

    // Beat-aligned ensemble context update (reuse pattern mode cadence)
    var phaseDelta = barPhase - _ensembleUpdatePhase;
    if (phaseDelta < 0) phaseDelta += 1.0;
    if (phaseDelta >= _ENSEMBLE_UPDATE_INTERVAL) {
      _ensembleUpdatePhase = barPhase;
      try { if (typeof ContextIntegrator !== 'undefined') _ensembleSnap = ContextIntegrator.getEnsembleSnapshot(); } catch (e) {}
      try { if (typeof DialogueEngine !== 'undefined') _dialogueStance = DialogueEngine.getStance('percussion'); } catch (e) {}
    }

    // Bar boundary → update hat openness
    var barWrapped = (barPhase < _lastBarPhase && phaseIncrement < 0.25);
    if (barWrapped) {
      var sectionEnergy = 0.3;
      try {
        if (typeof SectionTracker !== 'undefined') sectionEnergy = SectionTracker.getVoiceState('percussion').energy || 0.3;
      } catch (e) {}
      var targetOpenness = Math.max(0.0, Math.min(1.0, (sectionEnergy - 0.2) / 0.6));
      _hatOpenness += (targetOpenness - _hatOpenness) * 0.3;
    }

    // 1. Fire any pending queued hits
    _fireGestureHits();

    // 2. Should we schedule a new gesture?
    if (now < _lastGestureEndTime + _gestureMinGapMs) {
      _lastBarPhase = barPhase;
      return; // still in cooldown from last gesture
    }

    // Gate check: belief gateProb × gestural scale
    var effectiveGate = 0.15;
    if (typeof BeliefState !== 'undefined' && typeof BeliefState.getParams === 'function') {
      try {
        var params = BeliefState.getParams('percussion');
        if (params) effectiveGate = params.gateProb * GESTURAL_GATE_SCALE;
      } catch (e) {}
    }

    // Roll against gate — most ticks result in silence
    if (Math.random() > effectiveGate) {
      _lastBarPhase = barPhase;
      return;
    }

    // Select and schedule a gesture
    var gestureName = _selectGesture();
    _scheduleGesture(gestureName);

    // Adjust minimum gap based on arc phase (climax = more frequent, establish = sparser)
    var arcPhase = 'develop';
    try {
      if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getArc) {
        var arc = NarrativeArc.getArc('percussion');
        if (arc && arc.phase) arcPhase = arc.phase;
      }
    } catch (e) {}
    var phaseGapMod = { establish: 2.0, develop: 1.3, climax: 0.5, resolve: 1.6, transition: 1.0 };
    _gestureMinGapMs = 1200 * (phaseGapMod[arcPhase] || 1.0);

    _lastBarPhase = barPhase;
  }

  // ═══════════════════════════════════════
  // TICK — beat-grid drum scheduling
  // ═══════════════════════════════════════

  function onTick(dt) {
    if (!enabled) return;

    // Cold-start stagger — percussion enters first (0ms count-in)
    if (!_coldStartDone) {
      _coldStartElapsed += dt;
      var delay = 0;
      if (typeof BeliefState !== 'undefined' && typeof BeliefState.getColdStartDelay === 'function') {
        delay = BeliefState.getColdStartDelay('percussion');
      }
      if (_coldStartElapsed < delay) return;
      _coldStartDone = true;

      // Apply genre default pattern on first entry (timbre is user-controlled)
      var _gc = (typeof getGenreConfig === 'function' && typeof SharedState !== 'undefined')
        ? getGenreConfig(SharedState.genre) : {};
      if (_gc.percDefaultPattern && PATTERNS[_gc.percDefaultPattern]) {
        _currentPatternName = _gc.percDefaultPattern;
        _currentPattern = PATTERNS[_gc.percDefaultPattern];
      }
      // Gestural mode is the default. Pattern mode only activates when
      // a drum lexicon is loaded (timbre-specific vocabulary).
    }

    // v3.15.0: Gestural mode branch — entirely different tick path
    if (_gestureMode) {
      _gestureTick(dt);
      return;
    }

    // ── Pattern mode (legacy) ──

    // Gate check: belief state gateProb (already includes phase coupling modulation)
    if (typeof BeliefState !== 'undefined' && typeof BeliefState.getParams === 'function') {
      var params = BeliefState.getParams('percussion');
      if (params && params.gateProb < 0.3) return;  // too low — stay silent
    }

    // v2.1: Percussion-owned phase accumulator.
    // Instead of Date.now() % barMs (which jumps when BPM changes),
    // we accumulate phase from dt — immune to BPM-change phase glitches.
    var rawBPM = (typeof TempoEngine !== 'undefined') ? TempoEngine.getEffectiveBPM() : 120;
    if (_smoothedBPM === 0) _smoothedBPM = rawBPM;
    _smoothedBPM = _smoothedBPM * _TEMPO_INERTIA + rawBPM * (1 - _TEMPO_INERTIA);

    // Phase increment: dt ms × (beats/ms) × (bars/beat) = bars advanced
    var beatsPerMs = _smoothedBPM / 60000;
    var phaseIncrement = dt * beatsPerMs * 0.25;  // 0.25 = 1 bar per 4 beats

    // First tick — initialize phase, don't fire
    if (_lastBarPhase < 0) {
      _lastBarPhase = 0;
      return;
    }

    var barPhase = (_lastBarPhase + phaseIncrement) % 1.0;

    // Safety: cap phase increment to prevent blast if dt is huge (tab unfocus etc)
    if (phaseIncrement > 0.25) {
      _lastBarPhase = barPhase;
      return;
    }

    // v2.5.3: Beat-aligned cross-voice update (research: 1-beat adaptation lag)
    // Loehr, Large & Palmer 2011: musicians adapt at lag of one beat
    // Weber's law: perceptual timing 250-2000ms sweet spot
    var phaseDelta = barPhase - _ensembleUpdatePhase;
    if (phaseDelta < 0) phaseDelta += 1.0;  // wrap
    if (phaseDelta >= _ENSEMBLE_UPDATE_INTERVAL) {
      _ensembleUpdatePhase = barPhase;
      try {
        if (typeof ContextIntegrator !== 'undefined') {
          _ensembleSnap = ContextIntegrator.getEnsembleSnapshot();
        }
      } catch (e) {}
      try {
        if (typeof DialogueEngine !== 'undefined') {
          _dialogueStance = DialogueEngine.getStance('percussion');
        }
      } catch (e) {}
    }

    // Fill expiry: after fill duration, restore phrase pattern
    if (_fillActive && Date.now() - _fillStartTime > _FILL_DURATION_MS) {
      _fillActive = false;
      if (_phraseBasePattern) {
        _currentPattern = _phraseBasePattern;
        _useLexiconFormat = true;
        _currentPatternName = 'lexicon';
      } else if (_drumLexiconLoaded) {
        var restored = _selectFromLexicon();
        if (restored) {
          _currentPattern = _convertLexiconPattern(restored);
          _useLexiconFormat = true;
          _currentPatternName = 'lexicon';
        }
      } else {
        _currentPattern = PATTERNS[_currentPatternName] || PATTERNS.basic;
        _useLexiconFormat = false;
      }
    }

    // v2.6.1: Bar boundary detection — drives 4-bar phrase system
    // Detect wrap-around (barPhase < _lastBarPhase = crossed bar boundary)
    var barWrapped = (barPhase < _lastBarPhase && phaseIncrement < 0.25);
    if (barWrapped) {
      _onNewBar();
    }

    // Legacy: update pattern for non-lexicon timbres (808/acoustic) via section check
    if (!_drumLexiconLoaded && barWrapped) {
      _selectPattern();
    }

    // Check which hits we crossed since last tick
    // v2.6.0: patterns can be either format:
    //   Legacy: {kick: [0.0, 0.5], snare: [0.25, 0.75], ...}  (arrays of numbers)
    //   Lexicon: {kick: [{pos,vel,prob}], snare: [{pos,vel,prob}], ...}  (arrays of objects)
    var drums;
    if (_useLexiconFormat && _currentPattern) {
      drums = Object.keys(_currentPattern);
    } else {
      drums = (typeof DrumPatterns !== 'undefined' && DrumPatterns.ALL_DRUMS)
        ? DrumPatterns.ALL_DRUMS : ['kick', 'snare', 'hat'];
    }
    for (var di = 0; di < drums.length; di++) {
      var drumName = drums[di];
      var hits = _currentPattern[drumName];
      if (!hits || hits.length === 0) continue;

      for (var hi = 0; hi < hits.length; hi++) {
        var hitEntry = hits[hi];
        // v2.6.0: support both formats
        var hitPos, hitVelHint, hitProb;
        if (typeof hitEntry === 'object' && hitEntry !== null) {
          // Lexicon format: {pos, vel, prob}
          hitPos = hitEntry.pos;
          hitVelHint = hitEntry.vel || null;   // velocity hint from lexicon
          hitProb = hitEntry.prob !== undefined ? hitEntry.prob : 1.0;
        } else {
          // Legacy format: just a number (position)
          hitPos = hitEntry;
          hitVelHint = null;
          hitProb = 1.0;
        }

        if (_didCross(_lastBarPhase, barPhase, hitPos)) {
          // v2.6.0: lexicon probability gate (before belief gate)
          if (hitProb < 1.0 && Math.random() > hitProb) continue;
          // v2.3: Per-hit probability gate — belief-driven suppression of ornamental hits
          if (!_shouldFireHit(drumName, hitPos)) continue;
          // v2.4: Ghost detection — hats on off-beat 16th positions are ghost notes
          var isGhost = (drumName === 'hat' || drumName === 'shaker') &&
            !(hitPos < 0.01 || Math.abs(hitPos - 0.25) < 0.01 ||
              Math.abs(hitPos - 0.5) < 0.01 || Math.abs(hitPos - 0.75) < 0.01);
          var vel;
          if (hitVelHint !== null) {
            // v2.6.1: lexicon velocity is primary — modulate with context, don't override
            // hitVelHint carries the musical intent (ghost=0.15, accent=0.8, etc.)
            // _velocityMod() applies section/belief/ensemble scaling as a multiplier
            vel = hitVelHint * _velocityMod(drumName, hitPos, isGhost);
            vel = Math.max(VEL_FLOOR, Math.min(1.0, vel));
          } else {
            vel = _velocity(drumName, hitPos, isGhost);
          }
          try {
            var drumOpts = (drumName === 'hat') ? { hatOpenness: _hatOpenness } : undefined;
            SoundEngine.playDrum(drumName, vel, _currentTimbre, drumOpts);
          } catch(e) {}
          _noteCount++;

          // Notify phase coupling + temporal awareness
          try {
            if (typeof PhaseCoupling !== 'undefined') PhaseCoupling.onNoteProduced('percussion');
          } catch(e) {}
          try {
            if (typeof BeliefState !== 'undefined') BeliefState.onVoiceNote('percussion');
          } catch(e) {}

          // Notify context integrator (pass barPhase for kick pattern tracking)
          try {
            if (typeof ContextIntegrator !== 'undefined') ContextIntegrator.onPercussionHit(drumName, hitPos, vel);
          } catch(e) {}

          // Notify event bus
          try {
            if (typeof EventBus !== 'undefined') EventBus.emit('noteProduced', {
              voice: 'percussion', drum: drumName, velocity: vel, time: Date.now()
            });
          } catch(e) {}
        }
      }
    }

    _lastBarPhase = barPhase;
  }

  // Did we cross a hit position between lastPhase and currentPhase?
  // Handles bar wrap-around (0.95 → 0.05 crosses 0.0).
  function _didCross(lastPhase, currentPhase, hitPos) {
    if (currentPhase >= lastPhase) {
      // Normal forward motion
      return hitPos > lastPhase && hitPos <= currentPhase;
    } else {
      // Wrapped around (crossed bar boundary)
      return hitPos > lastPhase || hitPos <= currentPhase;
    }
  }

  // ═══════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════

  function setEnabled(v) { enabled = v; }
  function isEnabled() { return enabled; }
  function setTimbre(t) {
    if (!t) return;
    _currentTimbre = t;
    // v2.6.0: character model — instrument selection loads drum lexicon
    if (_DRUM_LEXICON_MAP[t]) {
      _loadDrumLexicon(_DRUM_LEXICON_MAP[t]);
      _gestureMode = false; // drum lexicon = pattern mode (character vocabulary)
    } else {
      // No lexicon = gestural mode (textural colorist)
      _drumLexicon = null;
      _drumLexiconLoaded = false;
      _useLexiconFormat = false;
      _currentPattern = PATTERNS[_currentPatternName] || PATTERNS.basic;
      _gestureMode = true;
    }
  }
  function getTimbre() { return _currentTimbre; }

  function reset() {
    _lastBarPhase = -1;
    _coldStartElapsed = 0;
    _coldStartDone = false;
    _currentPatternName = 'basic';
    _currentPattern = PATTERNS.basic;
    _currentTimbre = '808';
    _fillActive = false;
    _fillStartTime = 0;
    _noteCount = 0;
    _smoothedBPM = 0;
    _ensembleSnap = null;
    _dialogueStance = null;
    _ensembleUpdatePhase = 0;
    _drumLexicon = null;
    _drumLexiconLoaded = false;
    _useLexiconFormat = false;
    // v2.6.1: phrase state
    _phraseBarCount = 0;
    _phraseBasePattern = null;
    _phraseRole = 'establish';
    _totalBarsInSection = 0;
    _cachedSectionState = '';
    _hatOpenness = 0.0;
    // v3.15.0: gestural state
    _gestureMode = true;
    _gestureQueue = [];
    _lastGestureEndTime = 0;
    _gestureMinGapMs = 1200;
    enabled = false;
  }

  function getNoteCount() { return _noteCount; }
  function getCurrentPattern() { return _currentPatternName; }

  function setGestureMode(v) { _gestureMode = !!v; }
  function isGestureMode() { return _gestureMode; }

  // getKickPositions() — returns deterministic kick bar-phase positions when in pattern mode.
  // Returns null in gestural mode (no deterministic positions).
  // Bass uses this for zero-lag coupling — no observation delay.
  function getKickPositions() {
    if (_gestureMode) return null;
    if (_currentPattern && _currentPattern.kick) {
      return _currentPattern.kick.map(function(entry) {
        return (typeof entry === 'object' && entry !== null) ? entry.pos : entry;
      });
    }
    return null;
  }

  return {
    onTick:            onTick,
    setEnabled:        setEnabled,
    isEnabled:         isEnabled,
    setTimbre:         setTimbre,
    getTimbre:         getTimbre,
    reset:             reset,
    getNoteCount:      getNoteCount,
    getCurrentPattern: getCurrentPattern,
    setGestureMode:    setGestureMode,
    isGestureMode:     isGestureMode,
    getKickPositions:  getKickPositions
  };

})();

console.log('%cPercussionAssistant loaded (Phase E)', 'color:#f80;font-family:monospace');

'use strict';
// ═══ MOOD STATE — L0 Harmonic Mood Layer (v5 Phase 4b) ═══
//
// Below L1 beliefs in the hierarchy:
//   L0 Mood:    "What is the harmonic mood?" (mode valence, harmonic tension)
//   L1 POMDP:   "What does the music need?" (stability/energy/space/surprise/resolution)
//   L2 Intent:  "What character of phrase?" (continuation/punctuation/consonance/contrast)
//   L3 KeyBelief: "Which notes fit?" (84-key Bayesian distribution: 12 roots × 7 modes)
//
// Mood derives from harmonic context (key mode, CoF distance, chord tension) and
// outputs continuous modifiers for tempo, velocity, articulation, and density.
//
// Integration windows (Farbood 2012):
//   Harmony-driven (mode, key area): 22-second EMA
//   Tension-driven (dynamics, density): 3-second EMA
//   Articulation: 8-second EMA (intermediate)
//
// Per-voice asymmetry (Eerola et al. 2013, Huron et al. 2006):
//   Bass: high mode sensitivity, low tension sensitivity (valence anchor)
//   Soloist: low mode sensitivity, high tension sensitivity (arousal explorer)
//
// Depends on: key-belief.js, harmonic-planner.js, shared-state
// Load order: after key-belief.js, before belief-state.js

var MoodState = (function() {

  // ── Integration time constants (ms) ──
  // Farbood (2012): harmony ~22s, dynamics ~3s, articulation ~8s
  var HARMONY_TAU  = 22000;
  var TENSION_TAU  = 3000;
  var ARTICULATION_TAU = 8000;

  // ── Per-voice sensitivity (Eerola et al. 2013, Huron et al. 2006) ──
  // modeSens: how much mode (major/minor) affects this voice
  // tensionSens: how much harmonic tension affects this voice
  var VOICE_SENSITIVITY = {
    bass:       { modeSens: 1.0,  tensionSens: 0.5 },
    rhythm:     { modeSens: 0.7,  tensionSens: 0.7 },
    soloist:    { modeSens: 0.4,  tensionSens: 1.0 },
    lead:       { modeSens: 0.6,  tensionSens: 0.9 },
    percussion: { modeSens: 0.3,  tensionSens: 0.8 }
  };

  // ── Smoothed state (EMA outputs) ──
  var _modeValence = 0;         // [-1, +1]: -1=minor, +1=major
  var _harmonicTension = 0;     // [0, 1]: CoF distance + chord roughness
  var _articulationRaw = 0.75;  // [0, 1]: note duration / IOI ratio

  // v6 Phase 7C: Farbood (2012) additional tension channels
  var _pitchHeight = 0;         // [0, 1]: average register across voices
  var _onsetDensity = 0;        // [0, 1]: notes/sec normalized
  var _velocitySpread = 0;      // [0, 1]: dynamic range spread
  var _tempoChange = 0;         // [-1, 1]: rate of BPM change (positive = acceleration)
  var _prevBPM = 0;             // for tempo change tracking

  // v6 Phase 7C: Trend salience (Farbood 2012 key insight)
  // Sustained directional change amplifies tension perception.
  var _trends = {
    harmonicTension: { dir: 0, streak: 0, prev: 0 },
    pitchHeight:     { dir: 0, streak: 0, prev: 0 },
    onsetDensity:    { dir: 0, streak: 0, prev: 0 },
    velocitySpread:  { dir: 0, streak: 0, prev: 0 },
    tempoChange:     { dir: 0, streak: 0, prev: 0 }
  };

  // ── Raw (unsmoothed) inputs ──
  var _rawModeValence = 0;
  var _rawTension = 0;

  // ── Layer 0: Spectral blend (v9.5.0) ──
  // When sidecar provides spectral data, blend acoustic roughness into
  // harmonicTension and spectral centroid into pitchHeight.
  // Ramps smoothly: 0→0.4 over 5s when sidecar connects, 0 when disconnected.
  var _spectralWeight = 0;
  var _SPECTRAL_TARGET_WEIGHT = 0.4;  // max influence of spectral data
  var _SPECTRAL_RAMP_TAU = 5000;      // ms to ramp to target (5s)
  var _SPECTRAL_CENTROID_CEIL = 4000;  // Hz — maps to pitchHeight 1.0

  // ── Confidence gate ──
  var _CONFIDENCE_GATE = 0.3;   // minimum KeyBelief confidence to apply mode offsets

  // ── Tick accumulator ──
  var _accumMs = 0;
  var _TICK_INTERVAL = 200;     // update 5x/sec (not every 5ms tick)

  // ── Per-mode perceptual brightness valence [-1, +1] ──
  // Ordered by MODE_NAMES index: ionian, dorian, phrygian, lydian, mixolydian, aeolian, locrian
  // Brightness ranking: lydian > ionian > mixolydian > dorian > aeolian > phrygian > locrian
  // Based on circle-of-fifths position when all modes built on same root.
  var _MODE_VALENCE_BY_INDEX = (typeof MODE_VALENCE !== 'undefined' && typeof MODE_NAMES !== 'undefined')
    ? MODE_NAMES.map(function(m) { return MODE_VALENCE[m] || 0; })
    : [0.67, 0.0, -0.67, 1.0, 0.33, -0.33, -1.0];  // fallback

  // ── Compute raw mode valence from KeyBelief ──
  // Uses 84-key distribution (12 roots × 7 modes) when available.
  // Each mode contributes its perceptual brightness weight to ensemble valence.
  // Pre-allocated voice arrays (avoid per-call allocation)
  var _pitchedVoices = ['bass', 'rhythm', 'soloist', 'lead'];

  function _computeModeValence() {
    if (typeof KeyBelief === 'undefined' || !KeyBelief.getDistribution) return 0;

    var voices = _pitchedVoices;
    var numModes = (typeof MODE_NAMES !== 'undefined') ? MODE_NAMES.length : 7;
    var totalValence = 0;
    var voiceCount = 0;

    for (var vi = 0; vi < voices.length; vi++) {
      var dist = KeyBelief.getDistribution(voices[vi]);
      if (!dist || !dist.distribution) continue;

      // Sum probability-weighted brightness for each mode
      var voiceValence = 0;
      for (var ki = 0; ki < dist.distribution.length; ki++) {
        var modeIdx = ki % numModes;
        voiceValence += dist.distribution[ki] * _MODE_VALENCE_BY_INDEX[modeIdx];
      }
      totalValence += voiceValence;
      voiceCount++;
    }

    if (voiceCount === 0) return 0;
    return Math.max(-1, Math.min(1, totalValence / voiceCount));
  }

  // ── Compute harmonic tension from CoF distance ──
  function _computeHarmonicTension() {
    // CoF distance between current chord root and tonic
    var tension = 0;

    if (typeof SharedState !== 'undefined' && SharedState.currentChord) {
      var tonic = SharedState.keyC || 0;
      var chordRoot = SharedState.currentChord.rootPC;
      if (chordRoot !== undefined && chordRoot !== null) {
        // Signed CoF distance (0-6)
        var cofDist = _cofDistance(tonic, chordRoot);
        tension = Math.min(1, cofDist / 6.0);

        // Minor chord quality adds roughness (Parncutt 1989)
        if (SharedState.currentChord.type === 'minor') {
          tension = Math.min(1, tension + 0.08);
        }
      }
    }

    return tension;
  }

  // ── CoF distance (unsigned, 0-6) — pre-computed lookup table ──
  var _cofDistTable = new Uint8Array(144);  // 12×12 flat
  (function _initCofDistTable() {
    for (var from = 0; from < 12; from++) {
      for (var to = 0; to < 12; to++) {
        var steps = 0;
        for (var i = 1; i <= 6; i++) {
          if ((from + i * 7) % 12 === to) { steps = i; break; }
          if ((from - i * 7 + 120) % 12 === to) { steps = i; break; }
        }
        _cofDistTable[from * 12 + to] = steps;
      }
    }
  })();

  function _cofDistance(from, to) {
    return _cofDistTable[from * 12 + to];
  }

  // ── EMA update (v6 7C: fixed — was (target - alpha), now (target - current)) ──
  function _ema(current, target, tau, dtMs) {
    if (tau <= 0) return target;
    var alpha = dtMs / tau;
    return current + (target - current) * alpha;
  }

  // ── Asymmetric EMA (Farbood 2012): tension rises faster than it resolves ──
  function _emaAsym(current, target, tau, dtMs) {
    if (tau <= 0) return target;
    var alpha = (dtMs / tau) * (target > current ? 1.3 : 0.7);
    return current + (target - current) * alpha;
  }

  // ── Update trend salience for a channel ──
  function _updateTrend(trendObj, currentVal) {
    var delta = currentVal - trendObj.prev;
    var newDir = delta > 0.001 ? 1 : (delta < -0.001 ? -1 : 0);
    if (newDir !== 0 && newDir === trendObj.dir) {
      trendObj.streak++;
    } else {
      trendObj.streak = newDir !== 0 ? 1 : 0;
      trendObj.dir = newDir;
    }
    trendObj.prev = currentVal;
    // Salience: caps at 1.5x after 8 consecutive ticks
    return Math.min(trendObj.streak / 8, 1.5);
  }

  // ── v6 7C: Compute raw pitch height (0-1) ──
  function _computePitchHeight() {
    if (typeof ResearchState === 'undefined' || !ResearchState.getNotes) return 0;
    var notes = ResearchState.getNotes();
    if (!notes || notes.length === 0) return 0;
    // Average MIDI note of last 10 notes, normalized to 0-1 (MIDI 21-108)
    var sum = 0, count = 0;
    var start = Math.max(0, notes.length - 10);
    for (var i = start; i < notes.length; i++) {
      if (notes[i].midi) { sum += notes[i].midi; count++; }
      else if (notes[i].note !== undefined) { sum += notes[i].note; count++; }
    }
    if (count === 0) return 0;
    return Math.max(0, Math.min(1, (sum / count - 36) / 60));  // MIDI 36-96 → 0-1
  }

  // ── v6 7C: Compute onset density (0-1) ──
  function _computeOnsetDensity() {
    if (typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getEnsembleDensity) {
      return Math.min(1, ContextIntegrator.getEnsembleDensity());
    }
    return 0;
  }

  // ── v6 7C: Compute velocity spread (0-1) ──
  function _computeVelocitySpread() {
    if (typeof ResearchState === 'undefined' || !ResearchState.getNotes) return 0;
    var notes = ResearchState.getNotes();
    if (!notes || notes.length < 3) return 0;
    var start = Math.max(0, notes.length - 20);
    var sum = 0, sumSq = 0, count = 0;
    for (var i = start; i < notes.length; i++) {
      var v = notes[i].velocity || notes[i].vel;
      if (v !== undefined) { sum += v; sumSq += v * v; count++; }
    }
    if (count < 2) return 0;
    var mean = sum / count;
    var variance = sumSq / count - mean * mean;
    var std = Math.sqrt(Math.max(0, variance));
    return Math.min(1, std / 40);  // normalize: 40 MIDI = full spread
  }

  // ── Main tick ──
  function tick(dt) {
    _accumMs += dt;
    if (_accumMs < _TICK_INTERVAL) return;
    var elapsed = _accumMs;
    _accumMs = 0;

    // Compute raw inputs
    _rawModeValence = _computeModeValence();
    _rawTension = _computeHarmonicTension();

    // v6 7C: Compute new tension channel raw values
    var rawPitchHeight = _computePitchHeight();

    // ── Layer 0: Spectral blend ──
    // When sidecar provides acoustic data, blend it with symbolic estimates.
    // Roughness replaces CoF-based tension partially (acoustic reality vs chord assumptions).
    // Centroid replaces MIDI-based pitch height (actual brightness vs note numbers).
    var _sidecarReady = (typeof SidecarBridge !== 'undefined' && SidecarBridge.isReady());
    var _spectralData = _sidecarReady ? SidecarBridge.getSpectral() : null;

    if (_spectralData && _spectralData.roughness !== undefined) {
      // Ramp weight toward target
      _spectralWeight = _spectralWeight + (_SPECTRAL_TARGET_WEIGHT - _spectralWeight) * (elapsed / _SPECTRAL_RAMP_TAU);
      // Blend roughness into tension (Plomp & Levelt 1965 — acoustic dissonance)
      _rawTension = _rawTension * (1 - _spectralWeight) + _spectralData.roughness * _spectralWeight;
      // Blend centroid into pitch height (McAdams 1999 — perceptual brightness)
      if (_spectralData.centroid > 0) {
        var spectralHeight = Math.min(1, _spectralData.centroid / _SPECTRAL_CENTROID_CEIL);
        rawPitchHeight = rawPitchHeight * (1 - _spectralWeight) + spectralHeight * _spectralWeight;
      }
    } else {
      // Ramp weight toward 0 (graceful degradation)
      _spectralWeight = _spectralWeight * (1 - elapsed / _SPECTRAL_RAMP_TAU);
      if (_spectralWeight < 0.001) _spectralWeight = 0;
    }
    var rawOnsetDensity = _computeOnsetDensity();
    var rawVelocitySpread = _computeVelocitySpread();

    var currentBPM = (typeof PhaseCoupling !== 'undefined' && PhaseCoupling.getConsensusBPM)
      ? PhaseCoupling.getConsensusBPM() : 120;
    var rawTempoChange = _prevBPM > 0 ? (currentBPM - _prevBPM) / Math.max(1, elapsed / 1000) : 0;
    rawTempoChange = Math.max(-1, Math.min(1, rawTempoChange / 10));  // ±10 BPM/s → ±1
    _prevBPM = currentBPM;

    // EMA smoothing (harmony uses slow tau, tension channels use asymmetric EMA)
    _modeValence += (_rawModeValence - _modeValence) * (elapsed / HARMONY_TAU);
    _harmonicTension = _emaAsym(_harmonicTension, _rawTension, TENSION_TAU, elapsed);

    // v6 7C: Smooth new channels with asymmetric EMA
    _pitchHeight = _emaAsym(_pitchHeight, rawPitchHeight, TENSION_TAU, elapsed);
    _onsetDensity = _emaAsym(_onsetDensity, rawOnsetDensity, TENSION_TAU, elapsed);
    _velocitySpread = _emaAsym(_velocitySpread, rawVelocitySpread, ARTICULATION_TAU, elapsed);
    _tempoChange = _emaAsym(_tempoChange, rawTempoChange, TENSION_TAU, elapsed);

    // v6 7C: Update trend salience for each channel
    _updateTrend(_trends.harmonicTension, _harmonicTension);
    _updateTrend(_trends.pitchHeight, _pitchHeight);
    _updateTrend(_trends.onsetDensity, _onsetDensity);
    _updateTrend(_trends.velocitySpread, _velocitySpread);
    _updateTrend(_trends.tempoChange, _tempoChange);

    // Articulation blends mode + tension
    var artTarget = 0.75 + (_modeValence * 0.10);  // major=0.85 (detached), minor=0.65 (legato)
    _articulationRaw += (artTarget - _articulationRaw) * (elapsed / ARTICULATION_TAU);
  }

  // ── Public API: get modifiers for a specific voice ──

  // Tempo multiplier: minor=0.97, major=1.03 (Post & Huron 2009)
  function getTempoMultiplier(voice) {
    var conf = _getConfidence();
    if (conf < _CONFIDENCE_GATE) return 1.0;

    var sens = _getModeSens(voice);
    var mult = 1.0 + (_modeValence * 0.03 * sens * conf);
    return Math.max(0.93, Math.min(1.07, mult));  // clamp ±7%
  }

  // Velocity offset: minor=-5, major=+5 MIDI (Turner & Huron 2008)
  function getVelocityOffset(voice) {
    var conf = _getConfidence();
    if (conf < _CONFIDENCE_GATE) return 0;

    var sens = _getModeSens(voice);
    return Math.round(_modeValence * 5 * sens * conf);
  }

  // Articulation ratio: note duration / IOI (Bresin & Friberg 2011)
  // minor=0.65 (legato), major=0.85 (detached)
  function getArticulationRatio(voice) {
    var conf = _getConfidence();
    if (conf < _CONFIDENCE_GATE) return 0.75;  // neutral

    var sens = _getModeSens(voice);
    return 0.75 + ((_articulationRaw - 0.75) * sens * conf);
  }

  // Density modifier from harmonic tension (Bigand et al. 1996)
  // High tension = reduce density (create space for resolution)
  function getDensityModifier(voice) {
    var sens = _getTensionSens(voice);
    return 1.0 - (_harmonicTension * 0.20 * sens);  // max -20% at tritone
  }

  // Surprise boost from CoF distance (Lerdahl 2001)
  // Distant keys → more adventurousness
  function getSurpriseBoost(voice) {
    var sens = _getTensionSens(voice);
    return _harmonicTension * 0.12 * sens;  // max +0.12 at tritone
  }

  // ── v6 7C: Combined multi-parametric tension (Farbood 2012 weight ratios) ──
  // Weighted sum with trend salience amplification. Harmony dominates.
  function getCombinedTension(voice) {
    var sens = _getTensionSens(voice);
    var base = (
      _harmonicTension * 0.30 +
      _pitchHeight     * 0.20 +
      _onsetDensity    * 0.20 +
      _velocitySpread  * 0.10 +
      Math.max(0, _tempoChange) * 0.10 +  // only acceleration adds tension
      _modeValence * -0.10                 // major reduces tension
    );
    // Trend salience: amplify channels with sustained directional change
    var trendAmp = 1.0;
    var maxSalience = Math.max(
      _trends.harmonicTension.streak / 8,
      _trends.pitchHeight.streak / 8,
      _trends.onsetDensity.streak / 8
    );
    trendAmp += Math.min(maxSalience, 0.5) * 0.3;  // up to +15% from sustained trends
    return Math.max(0, Math.min(1, base * sens * trendAmp));
  }

  // ── Full mood snapshot for a voice ──
  function getMood(voice) {
    return {
      modeValence:     +_modeValence.toFixed(3),
      harmonicTension: +_harmonicTension.toFixed(3),
      combinedTension: +getCombinedTension(voice).toFixed(3),
      tempoMult:       +getTempoMultiplier(voice).toFixed(4),
      velocityOffset:  getVelocityOffset(voice),
      articulation:    +getArticulationRatio(voice).toFixed(3),
      densityMod:      +getDensityModifier(voice).toFixed(3),
      surpriseBoost:   +getSurpriseBoost(voice).toFixed(3)
    };
  }

  // ── Diagnostics ──
  function getAll() {
    var result = {
      modeValence:     +_modeValence.toFixed(3),
      rawModeValence:  +_rawModeValence.toFixed(3),
      harmonicTension: +_harmonicTension.toFixed(3),
      rawTension:      +_rawTension.toFixed(3),
      pitchHeight:     +_pitchHeight.toFixed(3),
      onsetDensity:    +_onsetDensity.toFixed(3),
      velocitySpread:  +_velocitySpread.toFixed(3),
      tempoChange:     +_tempoChange.toFixed(3),
      confidence:      +_getConfidence().toFixed(3),
      spectralWeight:  +_spectralWeight.toFixed(3),
      trends: {
        harmonicTension: _trends.harmonicTension.streak,
        pitchHeight:     _trends.pitchHeight.streak,
        onsetDensity:    _trends.onsetDensity.streak,
        velocitySpread:  _trends.velocitySpread.streak,
        tempoChange:     _trends.tempoChange.streak
      }
    };
    var voices = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
    for (var i = 0; i < voices.length; i++) {
      result[voices[i]] = getMood(voices[i]);
    }
    return result;
  }

  // ── Helpers ──
  function _getConfidence() {
    if (typeof KeyBelief === 'undefined' || !KeyBelief.getConfidence) return 0;
    // Ensemble average confidence (getConfidence() without voice returns 0,
    // so compute average across all pitched voices)
    var voices = _pitchedVoices;
    var sum = 0, count = 0;
    for (var i = 0; i < voices.length; i++) {
      var c = KeyBelief.getConfidence(voices[i]);
      if (c > 0) { sum += c; count++; }
    }
    return count > 0 ? sum / count : 0;
  }

  function _getModeSens(voice) {
    var s = VOICE_SENSITIVITY[voice];
    return s ? s.modeSens : 0.5;
  }

  function _getTensionSens(voice) {
    var s = VOICE_SENSITIVITY[voice];
    return s ? s.tensionSens : 0.5;
  }

  function reset() {
    _modeValence = 0;
    _harmonicTension = 0;
    _articulationRaw = 0.75;
    _rawModeValence = 0;
    _rawTension = 0;
    _pitchHeight = 0;
    _onsetDensity = 0;
    _velocitySpread = 0;
    _tempoChange = 0;
    _prevBPM = 0;
    _accumMs = 0;
    _spectralWeight = 0;
    var keys = Object.keys(_trends);
    for (var i = 0; i < keys.length; i++) {
      _trends[keys[i]].dir = 0;
      _trends[keys[i]].streak = 0;
      _trends[keys[i]].prev = 0;
    }
  }

  return {
    tick:                tick,
    getTempoMultiplier:  getTempoMultiplier,
    getVelocityOffset:   getVelocityOffset,
    getArticulationRatio: getArticulationRatio,
    getDensityModifier:  getDensityModifier,
    getSurpriseBoost:    getSurpriseBoost,
    getCombinedTension:  getCombinedTension,
    getMood:             getMood,
    getAll:              getAll,
    reset:               reset
  };

})();

console.log('%cMoodState loaded (L0 harmonic mood layer)', 'color:#c9a;font-family:monospace');

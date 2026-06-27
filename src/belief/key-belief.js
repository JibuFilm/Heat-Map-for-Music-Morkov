'use strict';
// ═══ KEY BELIEF (v3 Phase 1 — Per-Voice Key as Probability Distribution) ═══
//
// Each voice forms its OWN key belief by observing what OTHER voices play.
// Bass hears rhythm/soloist/lead, soloist hears bass/rhythm/lead, etc.
// This replaces the centralized SharedState.keyC for decision-making.
//
// SharedState.getKeyDistribution() is kept for UI display only — it shows
// the player a global consensus key. But assistants use their per-voice
// belief from this module to score phrases and fit scales.
//
// Architecture:
//   noteProduced event -> per-voice histogram (excluding own notes)
//   -> K-S 84-key correlation (12 roots × 7 modes) -> Bayesian distribution
//   -> per-voice confidence, topKey, topModeName, dynamic scaleFitMin
//
// v3.16.0: Expanded from 24 keys (major/minor) to 84 keys (7 diatonic modes).
// Modal profiles constructed from K-S framework + Temperley 2007 principles.
// Distinguishes dorian (bright minor) from aeolian, mixolydian from ionian, etc.
// MoodState consumes modal brightness gradient for nuanced valence.
//
// Follows PeerVelocity pattern: direct observation via EventBus,
// bypasses POMDP to avoid circular dependency.
//
// Depends on: constants.js (KEY_BELIEF_CONFIG, getScale), event-bus.js
// Load order: after context-integrator.js, before phase-coupling.js

var KeyBelief = (function() {

  // v8.12.1: Centralized grounding flag — updated in tick(), read by SectionTracker
  var _groundingLost = false;

  var _config = (typeof KEY_BELIEF_CONFIG !== 'undefined') ? KEY_BELIEF_CONFIG : {
    CONFIDENCE_THRESHOLD: 0.6,
    SOFT_SCALE_FIT_MIN: 0.4,
    UPDATE_INTERVAL_MS: 500
  };

  // ── K-S Modal Profiles (12 pitch-class weights per mode) ──
  // Ionian/Aeolian = original Krumhansl & Kessler 1982 major/minor profiles.
  // ── Modal Probe-Tone Profiles (K-K stability hierarchy, v9 Feature C) ──
  //
  // Psychoacoustically grounded modal profiles. Genre-neutral.
  //
  // Ionian + Aeolian: Direct from Krumhansl & Kessler 1982 probe-tone experiments
  // (Cognitive Foundations of Musical Pitch, Table 2.1). These measure perceived
  // "goodness of fit" for each chromatic tone after hearing a key-defining context.
  //
  // Other modes: Constructed using K-K's empirical stability hierarchy mapped onto
  // each mode's scale degrees. The hierarchy reflects perceptual prominence:
  //   Major-type (lydian, mixolydian): tonic > P5 > M3 > P4 > M6 > M2 > M7
  //   Minor-type (dorian, phrygian, locrian): tonic > m3 > P5 > P4 > m7 > m6 > m2
  // Weights are the K-K probe-tone ratings for each hierarchical position.
  // Non-scale tones use the K-K chromatic average (~2.48 major, ~2.78 minor).
  //
  // This avoids simple rotation (which breaks tonic dominance) and avoids
  // corpus derivation (which introduces genre bias).

  // K-K scale-degree stability weights (from probe-tone ratings, rank-ordered)
  // Major parent: 1st=6.35, 5th=5.19, 3rd=4.38, 4th=4.09, 6th=3.66, 2nd=3.48, 7th=2.88
  // Minor parent: 1st=6.33, 3rd=5.38, 5th=4.75, 4th=3.53, 7th=3.34, 6th=3.98, 2nd=3.52
  // Non-scale chromatic average: major ~2.39, minor ~2.66

  // Build a profile from stability hierarchy + mode intervals
  function _buildModalProfile(intervals, parentWeights, chromAvg) {
    // parentWeights: array of 7 weights corresponding to scale degrees 1-7 in order
    var prof = new Array(12);
    for (var i = 0; i < 12; i++) prof[i] = chromAvg;  // chromatic default
    for (var d = 0; d < 7; d++) {
      prof[intervals[d]] = parentWeights[d];
    }
    return prof;
  }

  // K-K weights mapped to scale degree positions (1st through 7th)
  // Major type: [1st, 2nd, 3rd, 4th, 5th, 6th, 7th] from K-K major probe-tone ratings
  var _KK_MAJ_DEG = [6.35, 3.48, 4.38, 4.09, 5.19, 3.66, 2.88];
  var _KK_MAJ_CHROM = 2.39;  // average of non-scale tones in K-K major
  // Minor type: same ordering from K-K minor probe-tone ratings
  var _KK_MIN_DEG = [6.33, 3.52, 5.38, 3.53, 4.75, 3.98, 3.34];
  var _KK_MIN_CHROM = 2.66;  // average of non-scale tones in K-K minor

  var MODAL_PROFS = [
    // Ionian (Major): K-K empirical direct — [0,2,4,5,7,9,11]
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    // Dorian [0,2,3,5,7,9,10]: minor-type stability, ♮6 is the bright 6th
    _buildModalProfile([0,2,3,5,7,9,10], _KK_MIN_DEG, _KK_MIN_CHROM),
    // Phrygian [0,1,3,5,7,8,10]: minor-type stability, ♭2 is the dark 2nd
    _buildModalProfile([0,1,3,5,7,8,10], _KK_MIN_DEG, _KK_MIN_CHROM),
    // Lydian [0,2,4,6,7,9,11]: major-type stability, ♯4 is the bright 4th
    _buildModalProfile([0,2,4,6,7,9,11], _KK_MAJ_DEG, _KK_MAJ_CHROM),
    // Mixolydian [0,2,4,5,7,9,10]: major-type stability, ♭7 is the flattened 7th
    _buildModalProfile([0,2,4,5,7,9,10], _KK_MAJ_DEG, _KK_MAJ_CHROM),
    // Aeolian (Natural Minor): K-K empirical direct — [0,2,3,5,7,8,10]
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
    // Locrian [0,1,3,5,6,8,10]: minor-type stability, ♭2♭5 (darkest, diminished)
    _buildModalProfile([0,1,3,5,6,8,10], _KK_MIN_DEG, _KK_MIN_CHROM)
  ];

  var NUM_MODES = 7;
  var NUM_KEYS = 84;  // 12 roots × 7 modes

  // Legacy aliases (backward compat for prediction-engine.js)
  var MAJOR_PROF = MODAL_PROFS[0];
  var MINOR_PROF = MODAL_PROFS[5];

  var VOICES = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
  var PITCH_VOICES = ['bass', 'rhythm', 'soloist', 'lead'];

  // How much weight each voice's notes carry when observed BY others
  // Bass notes are strong harmonic evidence; soloist is exploratory
  var OBSERVE_WEIGHT = { bass: 2.5, rhythm: 1.0, soloist: 0.5, lead: 0.8, human: 1.5 };

  // Per-role histogram decay — different harmonic memory spans create natural divergence.
  // Bass holds key evidence longest (harmonic anchor), soloist forgets fastest (exploratory).
  // Applied once per UPDATE_INTERVAL_MS (500ms), not every tick.
  // Half-life in beats at 120 BPM: bass ~35, rhythm ~17, lead ~10, soloist ~7
  var HIST_DECAY = {
    bass:    0.98,   // slow decay — bass is harmonically stubborn, holds the old key
    rhythm:  0.96,   // moderate — follows but not instantly
    lead:    0.93,   // responsive — energy driver, quick to sense new direction
    soloist: 0.90    // fast decay — exploratory, first to hear a new key
  };

  // Arc-driven decay acceleration — during climax/transition phases, decay faster
  // so the histogram can "forget" the old key and allow modulation.
  // Without this, 4 AI voices reinforcing the same key creates an unbreakable cycle.
  // Values are exponents applied to base decay (0.98^2 = 0.96, 0.98^3 = 0.94).
  // v9.1.0: Reduced climax/transition acceleration. 3.0× was too aggressive —
  // evidence half-life collapsed to 5.7s, destroying key confidence mid-session.
  // With softmax temperature fix, lower acceleration still allows modulation
  // while maintaining enough evidence for meaningful confidence.
  var ARC_DECAY_ACCEL = {
    establish:  1.0,  // normal decay — grounding the key
    develop:    1.3,  // slightly faster — preparing for change
    climax:     1.8,  // moderate — peak exploration window (was 3.0, too aggressive)
    resolve:    1.0,  // normal — settling into resolution
    transition: 1.5   // moderate — clearing palette between arcs (was 2.5)
  };

  // Key staleness: track how long each voice has held the same topKey.
  // After KEY_STALE_THRESHOLD_S, apply progressive extra decay to break rigidity.
  var KEY_STALE_THRESHOLD_S = 45;  // seconds before staleness pressure begins
  var KEY_STALE_MAX_ACCEL = 2.0;   // maximum additional acceleration at full staleness
  var _keyHoldStart = {};  // voice -> { key, startTime }
  PITCH_VOICES.forEach(function(v) { _keyHoldStart[v] = { key: -1, startTime: 0 }; });

  // ── Per-voice state ──
  // Each voice has its own histogram built from OTHER voices' notes
  var _histograms = {};    // voice -> Float64Array(12)
  var _histCounts = {};    // voice -> int (total weighted notes observed)
  var _distributions = {}; // voice -> { distribution, entropy, confidence, topKey, topMode }
  var _accumMs = 0;

  function _initVoice(v) {
    _histograms[v] = new Float64Array(12);
    _histCounts[v] = 0;
    _distributions[v] = null;
  }

  // Initialize all voices
  PITCH_VOICES.forEach(_initVoice);

  // ── Note observation: when voice X plays, all OTHER voices observe ──
  function _onNoteProduced(data) {
    var source = data.voiceName || data.voice;
    if (!source) return;

    // Percussion notes have no pitch class — skip for key belief
    if (source === 'percussion') return;

    var pc = data.pc;
    if (pc === undefined || pc === null) return;
    pc = pc % 12;

    var weight = OBSERVE_WEIGHT[source] || 1.0;

    // Feed this note to every OTHER voice's histogram
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var observer = PITCH_VOICES[i];
      if (observer === source) continue; // don't observe own output
      _histograms[observer][pc] += weight;
      _histCounts[observer]++;
    }

    // Invalidate cached distributions
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      _distributions[PITCH_VOICES[i]] = null;
    }
  }

  // Also observe human notes — all voices hear the human
  function _onHumanNote(data) {
    var pc = data.pc;
    if (pc === undefined || pc === null) return;
    pc = pc % 12;

    var weight = OBSERVE_WEIGHT.human;

    for (var i = 0; i < PITCH_VOICES.length; i++) {
      _histograms[PITCH_VOICES[i]][pc] += weight;
      _histCounts[PITCH_VOICES[i]]++;
    }

    for (var i = 0; i < PITCH_VOICES.length; i++) {
      _distributions[PITCH_VOICES[i]] = null;
    }
  }

  // Subscribe to events
  if (typeof EventBus !== 'undefined') {
    EventBus.on('noteProduced', _onNoteProduced);
    EventBus.on('humanNote', _onHumanNote);
  }

  // ── Mode index to name mapping ──
  var _MODE_NAMES = (typeof MODE_NAMES !== 'undefined') ? MODE_NAMES
    : ['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian'];

  // Legacy mode name mapping (backward compat: ionian → 'major', aeolian → 'minor')
  var _MODE_LEGACY = { ionian: 'major', aeolian: 'minor' };

  // ── Compute K-S distribution for a single voice ──
  // 84-key system: 12 roots × 7 modes (ionian, dorian, phrygian, lydian, mixolydian, aeolian, locrian)
  function _computeDistribution(voice) {
    var hist = _histograms[voice];
    if (!hist || _histCounts[voice] < 8) {
      // Not enough data — return uniform
      var uniform = 1 / NUM_KEYS;
      var dist = new Float64Array(NUM_KEYS);
      for (var i = 0; i < NUM_KEYS; i++) dist[i] = uniform;
      return { distribution: dist, entropy: Math.log2(NUM_KEYS), confidence: 0,
               topKey: 0, topMode: 'minor', topModeIndex: 5, topModeName: 'aeolian' };
    }

    // Normalize histogram to probability distribution before K-S correlation.
    // Without this, accumulated evidence with slow decay (bass 0.98) causes
    // histogram values to grow unbounded → K-S scores explode → softmax
    // collapses to argmax → confidence locks at 1.0 permanently.
    //
    // v9.1.0 fix: The normalization (v3.11.0) solved the explosion but created
    // a new problem — K-S scores on normalized histograms cluster in a tiny range
    // (3.0-3.7), which softmax flattens to near-uniform distribution. Confidence
    // collapses to 0.03 even with 100% in-scale bass output.
    //
    // Solution: Keep normalization (prevents explosion) but apply softmax with
    // temperature T=0.25 to sharpen the distribution. This amplifies the small
    // K-S score differences into meaningful probability peaks without brittleness.
    // T=0.25 with 84 keys gives confidence ~0.15-0.45 for clear tonal contexts.
    var normHist = new Float64Array(12);
    var histSum = 0;
    for (var i = 0; i < 12; i++) histSum += hist[i];
    if (histSum > 0) {
      for (var i = 0; i < 12; i++) normHist[i] = hist[i] / histSum;
    } else {
      for (var i = 0; i < 12; i++) normHist[i] = 1 / 12;
    }

    // K-S correlation for all 84 keys (12 roots × 7 modes)
    var scores = new Float64Array(NUM_KEYS);
    for (var k = 0; k < 12; k++) {
      for (var m = 0; m < NUM_MODES; m++) {
        var s = 0;
        var prof = MODAL_PROFS[m];
        for (var i = 0; i < 12; i++) {
          s += normHist[(k + i) % 12] * prof[i];
        }
        scores[k * NUM_MODES + m] = s;
      }
    }

    // Softmax normalization with temperature scaling (v9.1.0)
    // T < 1.0 sharpens the distribution, amplifying K-S score differences.
    // Without temperature, scores in [3.0, 3.7] produce near-uniform output.
    // T=0.25 stretches the effective score range by 4×, giving meaningful peaks.
    var SOFTMAX_TEMP = 0.25;
    var maxS = -Infinity;
    for (var i = 0; i < NUM_KEYS; i++) if (scores[i] > maxS) maxS = scores[i];
    var expSum = 0;
    var dist = new Float64Array(NUM_KEYS);
    for (var i = 0; i < NUM_KEYS; i++) { dist[i] = Math.exp((scores[i] - maxS) / SOFTMAX_TEMP); expSum += dist[i]; }
    for (var i = 0; i < NUM_KEYS; i++) dist[i] /= expSum;

    // Entropy and confidence
    var entropy = 0;
    for (var i = 0; i < NUM_KEYS; i++) if (dist[i] > 0) entropy -= dist[i] * Math.log2(dist[i]);
    var maxEntropy = Math.log2(NUM_KEYS);
    var confidence = Math.max(0, 1 - entropy / maxEntropy);

    // Top key
    var topIdx = 0;
    for (var i = 1; i < NUM_KEYS; i++) if (dist[i] > dist[topIdx]) topIdx = i;
    var topKey = Math.floor(topIdx / NUM_MODES);
    var topModeIndex = topIdx % NUM_MODES;
    var topModeName = _MODE_NAMES[topModeIndex];
    // Legacy mode: 'major' for ionian/lydian/mixolydian, 'minor' for others
    var topMode = _MODE_LEGACY[topModeName] || 'minor';

    return {
      distribution: dist, entropy: entropy, confidence: confidence,
      topKey: topKey, topMode: topMode,
      topModeIndex: topModeIndex, topModeName: topModeName
    };
  }

  // ── tick(dt) — decay histograms and refresh at beat rate ──
  function tick(dt) {
    _accumMs += dt;
    if (_accumMs < _config.UPDATE_INTERVAL_MS) return;
    _accumMs = 0;

    // Decay all histograms at beat rate — per-role rates for harmonic personality
    // Arc phase and key staleness accelerate decay to break self-reinforcing key lock.
    //
    // v8.12.1: Centralized grounding flag — single check, reused by SectionTracker.
    // When bass not in GROOVE or recently exited SEARCHING, harmonic grounding is weak.
    var _bassNotGrounding = (typeof BassAssistant !== 'undefined' && BassAssistant.getBassState)
      ? BassAssistant.getBassState() !== 'groove' : false;
    var _bassRecentSearch = (typeof BassAssistant !== 'undefined' && BassAssistant.getTimeSinceSearching)
      ? BassAssistant.getTimeSinceSearching() < 3000 : false;
    _groundingLost = _bassNotGrounding || _bassRecentSearch;
    var _bassDecayMod = _groundingLost ? 0.5 : 1.0;

    var now = Date.now();
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var v = PITCH_VOICES[i];
      var baseDecay = HIST_DECAY[v] || 0.95;

      // Arc-driven acceleration: during climax/transition, forget faster
      var accel = 1.0;
      if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getArc) {
        var arcState = NarrativeArc.getArc(v);
        if (arcState && arcState.phase) {
          accel = ARC_DECAY_ACCEL[arcState.phase] || 1.0;
        }
      }

      // Key staleness acceleration: same key held too long → progressive pressure
      var d = _distributions[v];
      if (d && d.confidence > 0.03) {
        var hold = _keyHoldStart[v];
        if (hold.key !== d.topKey) {
          hold.key = d.topKey;
          hold.startTime = now;
        } else {
          var holdSec = (now - hold.startTime) / 1000;
          if (holdSec > KEY_STALE_THRESHOLD_S) {
            var staleT = Math.min(1, (holdSec - KEY_STALE_THRESHOLD_S) / 60);
            accel += staleT * KEY_STALE_MAX_ACCEL;
          }
        }
      }

      var decay = Math.pow(baseDecay, accel * _bassDecayMod);
      var hist = _histograms[v];
      for (var j = 0; j < 12; j++) hist[j] *= decay;
    }

    // Refresh all distributions at beat rate
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var v = PITCH_VOICES[i];
      _distributions[v] = _computeDistribution(v);
    }

    // Update UI reference key from consensus (average across voices)
    _updateConsensusKey();
  }

  // ── Consensus key for UI display (replaces SharedState auto-key) ──
  function _updateConsensusKey() {
    // Average confidence-weighted distributions across all voices
    var consensus = new Float64Array(NUM_KEYS);
    var totalConf = 0;
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var d = _distributions[PITCH_VOICES[i]];
      if (!d) continue;
      var w = Math.max(0.1, d.confidence); // minimum weight to avoid zero
      for (var j = 0; j < NUM_KEYS; j++) consensus[j] += d.distribution[j] * w;
      totalConf += w;
    }
    if (totalConf > 0) {
      for (var j = 0; j < NUM_KEYS; j++) consensus[j] /= totalConf;
    }

    // Find consensus top key
    var topIdx = 0;
    for (var i = 1; i < NUM_KEYS; i++) if (consensus[i] > consensus[topIdx]) topIdx = i;
    var topKey = Math.floor(topIdx / NUM_MODES);
    var topModeIndex = topIdx % NUM_MODES;
    var topModeName = _MODE_NAMES[topModeIndex];
    var topMode = _MODE_LEGACY[topModeName] || 'minor';

    // Compute consensus confidence
    var entropy = 0;
    for (var i = 0; i < NUM_KEYS; i++) if (consensus[i] > 0) entropy -= consensus[i] * Math.log2(consensus[i]);
    var confidence = Math.max(0, 1 - entropy / Math.log2(NUM_KEYS));

    // Update SharedState.keyC for UI display + backward compat.
    // v9.1.0: With softmax temperature T=0.25, confidence now ranges 0.15-0.45
    // for clear tonal contexts. Gate raised to 0.08 to suppress spurious key
    // changes when confidence is too low (was 0.03, which let near-random
    // distributions trigger keyChanged events → rapid TRANSITION oscillation).
    var consensusGate = 0.08;
    if (confidence >= consensusGate && typeof SharedState !== 'undefined') {
      if (topKey !== SharedState.keyC || topMode !== SharedState.mode || topModeName !== SharedState.modeName) {
        SharedState.keyC = topKey;
        SharedState.mode = topMode;
        SharedState.modeName = topModeName;  // 7-mode name (ionian, dorian, etc.)
        if (typeof EventBus !== 'undefined') {
          EventBus.emit('keyChanged', { key: topKey, mode: topMode, modeName: topModeName });
        }
      }
    }
  }

  // ═══ PUBLIC API — all take voice parameter ═══

  // getDistribution(voice) — per-voice 84-key distribution (12 roots × 7 modes)
  function getDistribution(voice) {
    if (!voice || !_distributions[voice]) {
      if (voice && !_distributions[voice]) _distributions[voice] = _computeDistribution(voice);
      if (!voice) return null;
    }
    return _distributions[voice];
  }

  // getConfidence(voice) — per-voice entropy-based confidence
  function getConfidence(voice) {
    var d = getDistribution(voice);
    return d ? d.confidence : 0;
  }

  // getMostLikelyKey(voice) — per-voice { key, mode }
  function getMostLikelyKey(voice) {
    var d = getDistribution(voice);
    if (!d) return null;
    return { key: d.topKey, mode: d.topMode };
  }

  // getScaleFitMin(voice) — per-voice dynamic threshold
  function getScaleFitMin(voice) {
    var conf = getConfidence(voice);
    if (conf >= _config.CONFIDENCE_THRESHOLD) return 0.7;
    var t = conf / _config.CONFIDENCE_THRESHOLD;
    return _config.SOFT_SCALE_FIT_MIN + t * (0.7 - _config.SOFT_SCALE_FIT_MIN);
  }

  // shouldUseSoftFit(voice) — per-voice gate
  function shouldUseSoftFit(voice) {
    return getConfidence(voice) < _config.CONFIDENCE_THRESHOLD;
  }

  // ═══ DIAGNOSTIC FEATURES — harmonic narrative analysis ═══

  // Circle-of-fifths position for each PC: C=0, G=1, D=2, A=3, E=4, B=5, F#=6, Db=7, Ab=8, Eb=9, Bb=10, F=11
  var _COF = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

  // Circle-of-fifths distance between two PCs (0-6, wraps at tritone)
  function _cofDistance(pc1, pc2) {
    var d = Math.abs(_COF[pc1] - _COF[pc2]);
    return Math.min(d, 12 - d);
  }

  // ── Key Divergence Index ──
  // How much voices disagree about the key (0=consensus, 1=maximum disagreement)
  // Uses circle-of-fifths distance, so related keys (C/G, Cm/Eb) score low
  function getDivergence() {
    var keys = [];
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var d = _distributions[PITCH_VOICES[i]];
      if (d && d.confidence > 0.05) keys.push(d.topKey);
    }
    if (keys.length < 2) return 0;

    // Average pairwise CoF distance, normalized to 0-1
    var totalDist = 0, pairs = 0;
    for (var i = 0; i < keys.length; i++) {
      for (var j = i + 1; j < keys.length; j++) {
        totalDist += _cofDistance(keys[i], keys[j]);
        pairs++;
      }
    }
    return pairs > 0 ? +(totalDist / pairs / 6).toFixed(3) : 0; // max CoF dist is 6
  }

  // ── Harmonic Gravity ──
  // Weighted centroid on circle of fifths from all voices' distributions.
  // Returns { position: 0-11 (CoF position), direction: -1/0/+1 (flatward/neutral/sharpward) }
  // Sharpward = adding sharps (energy), flatward = adding flats (relaxation)
  var _prevGravity = null;

  function getGravity() {
    // Compute gravity as weighted average CoF position using circular mean
    var sinSum = 0, cosSum = 0, totalWeight = 0;
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var d = _distributions[PITCH_VOICES[i]];
      if (!d) continue;
      var w = Math.max(0.1, d.confidence);
      // Weight each key in the distribution by its probability
      for (var ki = 0; ki < NUM_KEYS; ki++) {
        if (d.distribution[ki] < 0.01) continue;
        var pc = Math.floor(ki / NUM_MODES);
        var cofPos = _COF[pc];
        var angle = cofPos * Math.PI * 2 / 12;
        sinSum += Math.sin(angle) * d.distribution[ki] * w;
        cosSum += Math.cos(angle) * d.distribution[ki] * w;
        totalWeight += d.distribution[ki] * w;
      }
    }

    if (totalWeight === 0) return { position: 0, direction: 0 };

    var angle = Math.atan2(sinSum / totalWeight, cosSum / totalWeight);
    if (angle < 0) angle += Math.PI * 2;
    var position = +(angle * 12 / (Math.PI * 2)).toFixed(1);

    // Direction: compare to previous gravity
    var direction = 0;
    if (_prevGravity !== null) {
      var delta = position - _prevGravity;
      // Wrap around circle
      if (delta > 6) delta -= 12;
      if (delta < -6) delta += 12;
      if (delta > 0.2) direction = 1;       // sharpward
      else if (delta < -0.2) direction = -1; // flatward
    }
    _prevGravity = position;

    return { position: position, direction: direction };
  }

  // ── Modulation Events ──
  // Track when any voice's topKey changes. Records who moved first and direction.
  var _prevKeys = {};  // voice -> { key, mode }
  var _modulations = []; // recent modulation events (rolling buffer of 20)

  function _checkModulations() {
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var v = PITCH_VOICES[i];
      var d = _distributions[v];
      if (!d || d.confidence < 0.1) continue;

      var prev = _prevKeys[v];
      if (prev && (prev.key !== d.topKey || prev.mode !== d.topMode)) {
        var cofDir = _COF[d.topKey] - _COF[prev.key];
        if (cofDir > 6) cofDir -= 12;
        if (cofDir < -6) cofDir += 12;

        _modulations.push({
          t: Date.now(),
          voice: v,
          from: { key: prev.key, mode: prev.mode },
          to: { key: d.topKey, mode: d.topMode },
          cofDirection: cofDir > 0 ? 'sharp' : cofDir < 0 ? 'flat' : 'parallel',
          cofDistance: _cofDistance(prev.key, d.topKey)
        });
        if (_modulations.length > 20) _modulations.shift();
      }
      _prevKeys[v] = { key: d.topKey, mode: d.topMode };
    }
  }

  function getModulations() {
    return _modulations.slice(); // defensive copy
  }

  function getRecentModulation() {
    return _modulations.length > 0 ? _modulations[_modulations.length - 1] : null;
  }

  // ── Pitch Class Entropy ──
  // Shannon entropy of the ensemble's recent PC output (from histograms).
  // Low = diatonic/locked, High = chromatic/searching. Range 0-3.58 (log2(12))
  function getPCEntropy() {
    // Sum all voice histograms to get ensemble PC profile
    var total = new Float64Array(12);
    var sum = 0;
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var hist = _histograms[PITCH_VOICES[i]];
      if (!hist) continue;
      for (var j = 0; j < 12; j++) { total[j] += hist[j]; sum += hist[j]; }
    }
    if (sum === 0) return 0;

    var entropy = 0;
    for (var j = 0; j < 12; j++) {
      var p = total[j] / sum;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    return +entropy.toFixed(3);
  }

  // ── Consonance Index ──
  // Ratio of consonant intervals between simultaneous voice key beliefs.
  // Uses top key PCs. Consonant = unison, m3, M3, P4, P5, m6, M6 (intervals 0,3,4,5,7,8,9)
  var _CONSONANT = { 0: true, 3: true, 4: true, 5: true, 7: true, 8: true, 9: true };

  function getConsonance() {
    var keys = [];
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var d = _distributions[PITCH_VOICES[i]];
      if (d && d.confidence > 0.05) keys.push(d.topKey);
    }
    if (keys.length < 2) return 1.0; // no tension with one voice

    var consonant = 0, total = 0;
    for (var i = 0; i < keys.length; i++) {
      for (var j = i + 1; j < keys.length; j++) {
        var interval = Math.abs(keys[i] - keys[j]) % 12;
        if (_CONSONANT[interval]) consonant++;
        total++;
      }
    }
    return total > 0 ? +(consonant / total).toFixed(3) : 1.0;
  }

  // ═══ COF MOMENTUM TRACKER (v5 Phase 3 — Harmonic Foresight) ═══
  //
  // Per-voice directional momentum on the circle of fifths.
  // Research basis: Krumhansl & Kessler 1982, Cuddy & Thompson 1992,
  // Bharucha & Stoeckig 1987, Lerdahl 2001.
  //
  // Sharpward = brightening/tension (dominant function)
  // Flatward  = darkening/relaxation (subdominant function)
  // Asymmetry: flatward registers faster (Cuddy & Thompson 1992).

  var _MOMENTUM_CONFIG = {
    // Per-role buffer sizes (recent harmonic events to track)
    // Bass: slow/conservative (anchor). Soloist: fast/responsive (explorer).
    bufferSize: { bass: 6, rhythm: 4, soloist: 3, lead: 3 },
    // Per-role exponential decay per event
    decayRate:  { bass: 0.90, rhythm: 0.80, soloist: 0.65, lead: 0.70 },
    // Asymmetry: flatward signal is perceptually clearer (Cuddy & Thompson 1992)
    sharpwardGain: 0.8,
    flatwardGain:  1.0,
    // Thresholds
    directionThreshold: 0.3,  // |direction| > threshold to declare trajectory
    confidenceThreshold: 0.5  // minimum confidence for consumers to act
  };

  // Per-voice momentum state
  var _momentum = {};
  function _initMomentum(v) {
    _momentum[v] = {
      steps: [],       // circular buffer of weighted CoF step values
      direction: 0,    // -1 to +1 (flatward to sharpward)
      confidence: 0,   // 0 to 1
      predictedKey: -1 // next predicted key index (0-11), or -1 if no prediction
    };
  }
  PITCH_VOICES.forEach(_initMomentum);

  // Compute signed CoF step between two keys (-6 to +6)
  // Positive = sharpward (C→G = +1), negative = flatward (C→F = -1)
  function _cofStep(fromKey, toKey) {
    var step = _COF[toKey] - _COF[fromKey];
    if (step > 6) step -= 12;
    if (step < -6) step += 12;
    return step;
  }

  // Called when a modulation is detected for a voice
  function _updateMomentum(voice, cofStep) {
    var m = _momentum[voice];
    if (!m) return;

    // Apply asymmetry gain
    var weighted = cofStep > 0
      ? cofStep * _MOMENTUM_CONFIG.sharpwardGain
      : cofStep * _MOMENTUM_CONFIG.flatwardGain;

    // Push to buffer (limited by per-role size)
    var maxBuf = _MOMENTUM_CONFIG.bufferSize[voice] || 4;
    m.steps.push(weighted);
    while (m.steps.length > maxBuf) m.steps.shift();

    // Compute weighted average (recent events weighted more via decay)
    var decay = _MOMENTUM_CONFIG.decayRate[voice] || 0.80;
    var weightedSum = 0, weightSum = 0;
    for (var i = 0; i < m.steps.length; i++) {
      var age = m.steps.length - 1 - i; // 0 = most recent
      var w = Math.pow(decay, age);
      weightedSum += m.steps[i] * w;
      weightSum += Math.abs(m.steps[i]) * w;
    }

    // Direction: sign of weighted sum, normalized to [-1, +1]
    var maxPossible = maxBuf * 6; // theoretical max (all steps = ±6)
    m.direction = maxPossible > 0 ? weightedSum / maxPossible : 0;
    m.direction = Math.max(-1, Math.min(1, m.direction * 3)); // scale up for sensitivity

    // Confidence: consistency of direction (how much do steps agree?)
    // High when all steps point the same way, low when mixed
    if (m.steps.length >= 2 && weightSum > 0) {
      m.confidence = Math.min(1, Math.abs(weightedSum) / weightSum);
    } else {
      m.confidence = 0;
    }

    // Predicted next key: extrapolate one CoF step in the momentum direction
    if (Math.abs(m.direction) > _MOMENTUM_CONFIG.directionThreshold && m.confidence > 0.3) {
      var currentKey = 0;
      var d = _distributions[voice];
      if (d) currentKey = d.topKey;
      var cofPos = _COF[currentKey];
      var nextCofPos = m.direction > 0
        ? (cofPos + 1) % 12     // one step sharpward
        : (cofPos + 11) % 12;   // one step flatward
      // Reverse COF lookup: find PC for this CoF position
      for (var pc = 0; pc < 12; pc++) {
        if (_COF[pc] === nextCofPos) { m.predictedKey = pc; break; }
      }
    } else {
      m.predictedKey = -1;
    }
  }

  // Reset momentum on cadential arrival or section boundary
  function _resetMomentum(voice, strength) {
    var m = _momentum[voice];
    if (!m) return;
    m.direction *= strength;  // partial reset (0.5 = halve, 0.0 = full reset)
    m.confidence *= strength;
    if (strength === 0) { m.steps = []; m.predictedKey = -1; }
  }

  // Public API
  function getModulationMomentum(voice) {
    if (!voice) {
      // Ensemble average
      var dir = 0, conf = 0, count = 0;
      for (var i = 0; i < PITCH_VOICES.length; i++) {
        var m = _momentum[PITCH_VOICES[i]];
        if (m) { dir += m.direction; conf += m.confidence; count++; }
      }
      return {
        direction: count > 0 ? (dir > 0.1 ? 'sharp' : dir < -0.1 ? 'flat' : 'none') : 'none',
        strength: count > 0 ? Math.abs(dir / count) : 0,
        predictedKey: -1
      };
    }
    var m = _momentum[voice];
    if (!m) return { direction: 'none', strength: 0, predictedKey: -1 };
    return {
      direction: m.direction > _MOMENTUM_CONFIG.directionThreshold ? 'sharp'
               : m.direction < -_MOMENTUM_CONFIG.directionThreshold ? 'flat' : 'none',
      strength: Math.abs(m.direction),
      confidence: m.confidence,
      predictedKey: m.predictedKey
    };
  }

  // Wire momentum updates into modulation detection
  var _origCheckModulations = _checkModulations;
  _checkModulations = function() {
    // Track previous keys before checking
    var prevKeys = {};
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var v = PITCH_VOICES[i];
      if (_prevKeys[v]) prevKeys[v] = { key: _prevKeys[v].key };
    }

    _origCheckModulations();

    // After modulation check, feed any detected modulations into momentum
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var v = PITCH_VOICES[i];
      var d = _distributions[v];
      if (!d || d.confidence < 0.1) continue;
      if (prevKeys[v] && prevKeys[v].key !== d.topKey) {
        var step = _cofStep(prevKeys[v].key, d.topKey);
        if (step !== 0) _updateMomentum(v, step);
      }
    }
  };

  // Hook modulation checking into the tick refresh
  var _origUpdateConsensus = _updateConsensusKey;
  _updateConsensusKey = function() {
    _origUpdateConsensus();
    _checkModulations();
  };

  // getAll() — snapshot of all voices for ResearchState
  function getAll() {
    var result = {};
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var v = PITCH_VOICES[i];
      var d = getDistribution(v); // compute on-demand, not stale cache
      result[v] = d ? {
        confidence: +d.confidence.toFixed(3),
        topKey: d.topKey,
        topMode: d.topMode,
        topModeName: d.topModeName || d.topMode,
        softFit: d.confidence < _config.CONFIDENCE_THRESHOLD
      } : { confidence: 0, topKey: 0, topMode: 'minor', topModeName: 'aeolian', softFit: true };
    }
    // Ensemble-level diagnostics
    // Per-voice momentum
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var v = PITCH_VOICES[i];
      if (result[v]) result[v].momentum = getModulationMomentum(v);
    }
    result._ensemble = {
      divergence: getDivergence(),
      gravity: getGravity(),
      pcEntropy: getPCEntropy(),
      consonance: getConsonance(),
      recentMod: getRecentModulation(),
      momentum: getModulationMomentum()
    };
    return result;
  }

  function reset() {
    PITCH_VOICES.forEach(_initVoice);
    PITCH_VOICES.forEach(_initMomentum);
    PITCH_VOICES.forEach(function(v) { _keyHoldStart[v] = { key: -1, startTime: 0 }; });
    _accumMs = 0;
    _prevGravity = null;
    _prevKeys = {};
    _modulations = [];
  }

  return {
    tick:              tick,
    getDistribution:   getDistribution,
    getConfidence:     getConfidence,
    getMostLikelyKey:  getMostLikelyKey,
    getScaleFitMin:    getScaleFitMin,
    shouldUseSoftFit:  shouldUseSoftFit,
    // Diagnostic features
    getDivergence:     getDivergence,
    getGravity:        getGravity,
    getConsonance:     getConsonance,
    getPCEntropy:      getPCEntropy,
    getModulations:    getModulations,
    getRecentModulation: getRecentModulation,
    getModulationMomentum: getModulationMomentum,
    getAll:            getAll,
    reset:             reset,
    // v8.12.1: Centralized grounding flag — true when bass not in GROOVE or recently was SEARCHING
    isGroundingLost:   function() { return _groundingLost; }
  };
})();

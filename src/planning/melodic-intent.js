'use strict';
// ═══ MELODIC INTENT — L2 Belief Layer (v3 Phase 2) ═══
//
// The missing middle layer of the belief hierarchy:
//   L1 POMDP: "What does the music need?" (stability/energy/space/surprise/resolution)
//   L2 Intent: "What character of phrase?" (continuation/punctuation/consonance/contrast)
//   L3 KeyBelief: "Which notes fit?" (24-key Bayesian distribution)
//
// L2 derives intent from L1 beliefs via a mapping matrix (not a separate POMDP).
// Intent persists for a commitment window (2-8 bars per role), creating multi-bar
// phrase arcs that EMERGE from sustained behavioral intent rather than a mechanical
// bar counter.
//
// Seed phrase memory: during 'continuation', the first phrase becomes a seed that
// subsequent phrases replay or develop. Bass/rhythm replay exactly (ostinato),
// soloist/lead replay with similarity bias (motivic development).
//
// Depends on: belief-state.js, phase-coupling.js, constants.js (L1_TO_L2_MATRIX etc.)
// Load order: after belief-state.js + phase-coupling.js, before phrase-planner.js

var MelodicIntent = (function() {

  var INTENT_NAMES = ['continuation', 'punctuation', 'consonance', 'contrast'];
  var PITCH_VOICES = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];

  // ── Per-voice state ──
  var _state = {};

  // Maximum seed replays before auto-clearing. Set high so structural mechanisms
  // (arc intent changes, staleness detection, contour fingerprint) are always the
  // binding constraint — not this hard cap.
  // PHASE 5 REPLACEMENT: Remove entirely when peer intelligence provides
  // ensemble variation budget. Complexity multiplier remains as input signal.
  var SEED_MAX_REPLAYS = { bass: 12, rhythm: 16, soloist: 6, lead: 6, percussion: 4 };

  // Permanent psychoacoustic law (Berlyne inverted-U, Margulis 2014):
  // Short patterns perceived as rhythmic cells → higher repetition tolerance.
  // Long patterns carry more information → faster listener fatigue.
  // PHASE 5 INPUT: Peer intelligence uses this as repetition tolerance weight.
  function _getComplexityMultiplier(seed) {
    if (!seed || !seed.sd) return 1.0;
    var len = seed.sd.length;
    if (len <= 2) return 2.0;   // rhythmic cells: double tolerance
    if (len <= 3) return 1.5;   // short motifs
    if (len <= 6) return 1.0;   // medium: baseline
    if (len <= 9) return 0.7;   // long: 30% less
    return 0.5;                  // very long: half
  }

  // Farbood 2012: rhythmic memory ~3s. Repp 2005: ±3-5% timing variation
  // perceived as expressive, not as a different phrase.
  // Progressive: increases with replay count (listener habituates to exact pattern).
  // Per-role: bass/rhythm less variation (groove anchoring), soloist/lead more (expressiveness).
  var MICRO_VAR_SCALE = { bass: 0.5, rhythm: 0.6, soloist: 1.0, lead: 0.9 };

  function _applyMicroVariation(ioiRatios, replayCount, role) {
    if (!ioiRatios || ioiRatios.length === 0) return ioiRatios;
    var baseJitter = Math.min(0.01 + replayCount * 0.008, 0.05);
    var jitter = baseJitter * (MICRO_VAR_SCALE[role] || 1.0);
    var result = new Array(ioiRatios.length);
    for (var i = 0; i < ioiRatios.length; i++) {
      var noise = ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * 2;
      result[i] = ioiRatios[i] * (1.0 + noise * jitter);
    }
    return result;
  }

  function _initVoice(role) {
    _state[role] = {
      intent: null,           // current intent name or null (unset)
      intentProbs: null,      // [continuation, punctuation, consonance, contrast] probabilities
      commitStartTime: 0,     // when current intent was committed
      commitBars: 4,          // how many bars to hold this intent
      seed: null,             // { sd: [...], ioiRatios: [...], key: number }
      seedReplayCount: 0,     // how many times current seed has been replayed
      prevSection: ''         // for section-change detection
    };
  }

  // Initialize all voices
  PITCH_VOICES.forEach(_initVoice);

  // ── L1→L2 mapping ──
  // Computes intent probabilities from L1 belief vector via dot product + role bias + softmax.
  function _computeIntentProbs(role) {
    var matrix = (typeof L1_TO_L2_MATRIX !== 'undefined') ? L1_TO_L2_MATRIX : null;
    var biases = (typeof INTENT_ROLE_BIAS !== 'undefined') ? INTENT_ROLE_BIAS[role] : null;
    if (!matrix) return [0.25, 0.25, 0.25, 0.25]; // uniform fallback

    // Get L1 belief vector
    var beliefs;
    if (typeof BeliefState !== 'undefined') {
      var b = BeliefState.getBelief(role);
      if (b) {
        beliefs = [
          b.needs_stability  || 0,
          b.needs_energy     || 0,
          b.needs_space      || 0,
          b.needs_surprise   || 0,
          b.needs_resolution || 0
        ];
      }
    }
    if (!beliefs) beliefs = [0.2, 0.2, 0.2, 0.2, 0.2];

    // Dot product: intent_score = Σ(matrix[intent][i] × belief[i]) + bias
    var scores = [];
    for (var ii = 0; ii < INTENT_NAMES.length; ii++) {
      var intentName = INTENT_NAMES[ii];
      var weights = matrix[intentName];
      if (!weights) { scores.push(0.25); continue; }

      var dot = 0;
      for (var bi = 0; bi < 5; bi++) {
        dot += weights[bi] * beliefs[bi];
      }

      // Add per-role bias
      if (biases && biases[intentName]) {
        dot += biases[intentName];
      }

      scores.push(Math.max(0.01, dot)); // floor prevents zero
    }

    // Softmax normalization (temperature 1.0)
    var maxScore = scores[0];
    for (var i = 1; i < scores.length; i++) {
      if (scores[i] > maxScore) maxScore = scores[i];
    }

    var expSum = 0;
    var exps = [];
    for (var i = 0; i < scores.length; i++) {
      var e = Math.exp((scores[i] - maxScore) * 5.0); // scaling factor for discrimination
      exps.push(e);
      expSum += e;
    }

    var probs = [];
    for (var i = 0; i < exps.length; i++) {
      probs.push(expSum > 0 ? exps[i] / expSum : 0.25);
    }

    return probs;
  }

  // Sample an intent from probability distribution
  function _sampleIntent(probs) {
    var roll = Math.random();
    var cumulative = 0;
    for (var i = 0; i < probs.length; i++) {
      cumulative += probs[i];
      if (roll <= cumulative) return INTENT_NAMES[i];
    }
    return INTENT_NAMES[INTENT_NAMES.length - 1];
  }

  // Get commitment window in bars for this role + section
  function _getCommitmentBars(role) {
    var config = (typeof INTENT_COMMITMENT_BARS !== 'undefined') ? INTENT_COMMITMENT_BARS[role] : null;
    if (!config) return 4;

    var section = 'STABLE';
    if (typeof SectionTracker !== 'undefined') {
      try { section = (SectionTracker.getVoiceState ? SectionTracker.getVoiceState(role) : SectionTracker.getState()).state || 'STABLE'; } catch (e) {}
    }

    return config[section] || config['default'] || 4;
  }

  // Check if commitment window has elapsed (wall-clock + BPM)
  function _isCommitmentExpired(role) {
    var s = _state[role];
    if (!s.intent || s.commitStartTime === 0) return true;

    var bpm = 120;
    if (typeof PhaseCoupling !== 'undefined') {
      bpm = PhaseCoupling.getConsensusBPM() || 120;
    }
    var barMs = 60000 / bpm * 4; // 4 beats per bar
    var elapsed = Date.now() - s.commitStartTime;
    var barsElapsed = elapsed / barMs;

    return barsElapsed >= s.commitBars;
  }

  // ── Intent evaluation (called periodically, not every tick) ──
  function _evaluateIntent(role) {
    var s = _state[role];

    // Check for section change → force re-evaluation + clear seed
    var currentSection = '';
    if (typeof SectionTracker !== 'undefined') {
      try { currentSection = (SectionTracker.getVoiceState ? SectionTracker.getVoiceState(role) : SectionTracker.getState()).state || ''; } catch (e) {}
    }
    var sectionChanged = (currentSection !== s.prevSection && s.prevSection !== '');
    s.prevSection = currentSection;

    if (sectionChanged) {
      s.seed = null; // clear seed on section change
    }

    // v5 Phase 2: Staleness detection — force re-evaluation when belief pattern is stale
    var staleForced = false;
    if (typeof BeliefState !== 'undefined' && typeof BeliefState.isStalePattern === 'function') {
      var staleness = BeliefState.isStalePattern(role, 40);
      if (staleness.stale && !_isCommitmentExpired(role) && !sectionChanged) {
        staleForced = true;
        s.seed = null; // clear seed — stale pattern needs fresh material
      }
    }

    // Re-evaluate if: no intent, commitment expired, section changed, or stale pattern
    if (!s.intent || _isCommitmentExpired(role) || sectionChanged || staleForced) {
      var probs = _computeIntentProbs(role);

      // v5 Phase 4: Arc-driven intent sequencing
      // NarrativeArc provides a preferred intent for the current arc phase.
      // Weight: 0.7 arc preference, 0.3 belief-driven (allows override).
      if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getPreferredIntent) {
        var arcIntent = NarrativeArc.getPreferredIntent(role);
        if (arcIntent) {
          var arcIdx = INTENT_NAMES.indexOf(arcIntent);
          if (arcIdx >= 0) {
            // Boost the arc-preferred intent
            probs[arcIdx] *= 3.5; // strong bias toward arc preference
            // Renormalize
            var arcSum = 0;
            for (var ai = 0; ai < probs.length; ai++) arcSum += probs[ai];
            if (arcSum > 0) for (var ai = 0; ai < probs.length; ai++) probs[ai] /= arcSum;
          }
        }
      }

      // v5 Phase 2: When stale, bias toward contrast/punctuation to break the pattern
      // (staleness overrides arc — safety net takes priority)
      if (staleForced) {
        // If current intent is continuation or consonance, push hard toward contrast
        var contrastIdx = INTENT_NAMES.indexOf('contrast');
        var punctIdx = INTENT_NAMES.indexOf('punctuation');
        if (contrastIdx >= 0) probs[contrastIdx] *= 2.5;
        if (punctIdx >= 0) probs[punctIdx] *= 1.5;
        // Renormalize
        var psum = 0;
        for (var pi = 0; pi < probs.length; pi++) psum += probs[pi];
        if (psum > 0) for (var pi = 0; pi < probs.length; pi++) probs[pi] /= psum;
      }

      s.intentProbs = probs;

      var newIntent = _sampleIntent(probs);

      // If intent changes, clear seed
      if (newIntent !== s.intent) {
        s.seed = null;
      }

      s.intent = newIntent;
      s.commitStartTime = Date.now();
      s.commitBars = _getCommitmentBars(role);
    }
  }

  // ── Tick (lightweight — only checks commitment expiry) ──
  var _accumMs = 0;
  var _EVAL_INTERVAL_MS = 500; // check every 500ms (beat rate), not every 5ms tick

  function tick(dt) {
    _accumMs += dt;
    if (_accumMs < _EVAL_INTERVAL_MS) return;
    _accumMs = 0;

    for (var i = 0; i < PITCH_VOICES.length; i++) {
      _evaluateIntent(PITCH_VOICES[i]);
    }
  }

  // ── Public API ──

  // Get current intent for a voice
  function getIntent(role) {
    var s = _state[role];
    if (!s) return 'consonance'; // safe default
    if (!s.intent) _evaluateIntent(role); // lazy init
    return s.intent;
  }

  // Get intent probabilities (for diagnostics)
  function getIntentProbs(role) {
    var s = _state[role];
    return s ? s.intentProbs : null;
  }

  // ── Seed phrase management ──

  function hasSeed(role) {
    var s = _state[role];
    return s && s.seed && s.seed.sd && s.seed.sd.length > 0;
  }

  function setSeed(role, phrase, key) {
    var s = _state[role];
    if (!s) return;
    s.seed = {
      sd: phrase.sd ? phrase.sd.slice() : null,
      ioiRatios: phrase.ioi_ratios ? phrase.ioi_ratios.slice() : null,
      key: key || 0
    };
    s.seedReplayCount = 0;
  }

  function clearSeed(role) {
    var s = _state[role];
    if (s) s.seed = null;
  }

  // Get seed replay transposed to current key.
  // Tracks replay count and auto-clears seed after SEED_MAX_REPLAYS
  // to prevent the same phrase looping indefinitely.
  function getSeedReplay(role, currentKey) {
    var s = _state[role];
    if (!s || !s.seed || !s.seed.sd) return null;

    // v5 Phase 5: Ensemble variation budget replaces hard SEED_MAX_REPLAYS cap.
    // PeerModel tracks ensemble-wide repetition and signals which voice should vary.
    // Staleness detection (BeliefState.isStalePattern) and arc intent changes
    // remain as parallel safety nets.
    var maxReplays;
    if (typeof PeerModel !== 'undefined' && PeerModel.getEnsembleVariation) {
      var ev = PeerModel.getEnsembleVariation();
      if (ev.variationNeeded && ev.suggestedVarier === role) {
        maxReplays = s.seedReplayCount; // clear now — this voice needs to vary
      } else {
        maxReplays = 999; // effectively unlimited — structural mechanisms govern
      }
    } else {
      // Fallback: original hard caps if PeerModel not loaded
      maxReplays = SEED_MAX_REPLAYS[role] || 6;
    }
    // Pattern complexity still adjusts tolerance (Berlyne inverted-U)
    maxReplays = Math.round(maxReplays * _getComplexityMultiplier(s.seed));
    if (s.seedReplayCount >= maxReplays) {
      s.seed = null;
      s.seedReplayCount = 0;
      return null; // force fresh phrase selection
    }

    s.seedReplayCount++;

    var seed = s.seed;
    var keyShift = ((currentKey - seed.key) % 12 + 12) % 12;

    // Transpose scale degrees
    var transposedSD = new Array(seed.sd.length);
    for (var i = 0; i < seed.sd.length; i++) {
      transposedSD[i] = (seed.sd[i] + keyShift) % 12;
    }

    // Convert to pitch classes
    var notes = new Array(transposedSD.length);
    for (var i = 0; i < transposedSD.length; i++) {
      notes[i] = (transposedSD[i] + currentKey) % 12;
    }

    return {
      notes: notes,
      sd: transposedSD,
      ioiRatios: _applyMicroVariation(seed.ioiRatios, s.seedReplayCount, role)
    };
  }

  // ── State snapshot (for ResearchState / diagnostics) ──

  function getState() {
    var result = {};
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      var role = PITCH_VOICES[i];
      var s = _state[role];
      if (!s) continue;

      var bpm = 120;
      if (typeof PhaseCoupling !== 'undefined') {
        bpm = PhaseCoupling.getConsensusBPM() || 120;
      }
      var barMs = 60000 / bpm * 4;
      var elapsed = s.commitStartTime > 0 ? Date.now() - s.commitStartTime : 0;
      var barsElapsed = barMs > 0 ? +(elapsed / barMs).toFixed(1) : 0;

      result[role] = {
        intent: s.intent,
        probs: s.intentProbs,
        commitBar: barsElapsed,
        commitTotal: s.commitBars,
        hasSeed: !!(s.seed && s.seed.sd),
        seedReplayCount: s.seedReplayCount || 0
      };
    }
    return result;
  }

  function getAll() {
    return getState();
  }

  function reset() {
    PITCH_VOICES.forEach(_initVoice);
    _accumMs = 0;
  }

  return {
    tick:            tick,
    getIntent:       getIntent,
    getIntentProbs:  getIntentProbs,
    hasSeed:         hasSeed,
    setSeed:         setSeed,
    clearSeed:       clearSeed,
    getSeedReplay:   getSeedReplay,
    getState:        getState,
    getAll:          getAll,
    reset:           reset,
    getComplexityMultiplier: function(role) {
      var s = _state[role];
      return s && s.seed ? _getComplexityMultiplier(s.seed) : 1.0;
    }
  };

})();

console.log('%cMelodicIntent loaded (L2 belief layer)', 'color:#e6a;font-family:monospace');

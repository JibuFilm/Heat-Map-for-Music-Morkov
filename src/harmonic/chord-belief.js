'use strict';
// ═══ CHORD BELIEF (v9.3.0 — Unified Harmonic Truth) ═══
//
// Single source of harmonic truth for the ensemble. Two complementary layers:
//
// 1. EVIDENTIAL LAYER — "What chord IS being played?"
//    observe(rootPC, type, source) accumulates weighted evidence from actual notes.
//    24-chord distribution decays over time. Chord changes when threshold crossed.
//    Sources: bass_groove (2.5), bass_searching (0.5), rhythm_voicing (1.5), human (3.0)
//
// 2. INTENTIONAL LAYER — "Where is the ensemble HEADING?"
//    publishIntent(voice, ...) records each voice's harmonic prediction.
//    getConsensus(excludeVoice) tallies weighted votes across peer intents.
//    Enables stigmergic coordination: voices bias toward agreed-upon harmony.
//    Tillmann, Bharucha & Bigand (2000); Pressing (1999) shared referent.
//
// v9.2.0: Created evidential layer (replaced bass-only chord inference).
// v9.3.0: Absorbed intentional layer (was _getHarmonicConsensus in assistant-shared.js).
//          Single module now manages all harmonic truth — evidential AND intentional.
//
// Follows KeyBelief pattern: IIFE, tick(), EventBus observation.
// Depends on: constants.js, event-bus.js, SharedState (prediction-engine.js)
// Load order: after harmonic-planner.js, before assistant files

var ChordBelief = (function() {

  // ── Configuration ──
  var SOURCE_WEIGHTS = {
    bass_groove:    2.5,
    bass_searching: 0.5,
    rhythm_voicing: 1.5,
    grammar:        1.0,
    human:          3.0
  };

  var EVIDENCE_HALFLIFE_MS = 2000;     // evidence halves every 2s (Krumhansl 1990)
  var MIN_WEIGHT_THRESHOLD = 3.0;      // must accumulate 3.0+ before chord is authoritative
  var UPDATE_INTERVAL_MS   = 100;      // check threshold every 100ms
  var DIATONIC_PENALTY     = 0.5;      // chromatic chord evidence multiplied by this
  var SECTION_RESET_TTL_MS = 1500;     // short evidence window after section change

  // ── State ──
  // 24-chord distribution: chordID = rootPC * 2 + (type === 'major' ? 0 : 1)
  var _evidence = new Float64Array(24);
  var _timeSinceUpdate = 0;
  var _timeSinceReset = Infinity;      // time since last section reset

  // Current authoritative chord (what SharedState.currentChord reflects)
  var _currentChord = null;            // { rootPC, type, confidence, source, timestamp }

  // Decay factor pre-computed from half-life
  // decay^(dt) = 0.5 when dt = HALFLIFE → decay = 0.5^(1/HALFLIFE)
  // For per-ms: decay_per_ms = Math.pow(0.5, 1 / EVIDENCE_HALFLIFE_MS)
  var _decayPerMs = Math.pow(0.5, 1.0 / EVIDENCE_HALFLIFE_MS);

  // Track observation count for diagnostic
  var _observeCount = 0;
  var _chordChangeCount = 0;

  // ── Intentional layer state (v9.3.0: migrated from _getHarmonicConsensus) ──
  // Per-voice harmonic intent: what each voice PLANS to play (lookahead)
  var _intents = {};               // voice → { targetPC, targetType, confidence, beatsAway, timestamp }
  var _consensusLastSection = '';   // track section changes for intent expiry
  var _consensusLastResetTime = 0;
  var _MOMENTUM_DECAY = 4000;      // momentum authority boost decay (ms)
  var _consensusVotes = new Float64Array(12); // reusable vote buffer

  // ── Helpers ──

  function _chordId(rootPC, type) {
    return rootPC * 2 + (type === 'major' ? 0 : 1);
  }

  function _fromChordId(id) {
    return { rootPC: Math.floor(id / 2), type: (id % 2 === 0) ? 'major' : 'minor' };
  }

  // Check if a chord root is diatonic to the current key
  function _isDiatonic(rootPC) {
    if (typeof SharedState === 'undefined') return true;
    var keyC = SharedState.keyC;
    var mode = SharedState.mode;
    if (typeof getScale !== 'function') return true;
    var scale = getScale(keyC, mode);
    for (var i = 0; i < scale.length; i++) {
      if (scale[i] === rootPC) return true;
    }
    return false;
  }

  // ── Public API ──

  // Observe chord evidence from a source
  function observe(rootPC, type, source) {
    var weight = SOURCE_WEIGHTS[source] || 1.0;

    // Diatonic validation: penalize chromatic chord roots
    if (!_isDiatonic(rootPC)) {
      weight *= DIATONIC_PENALTY;
    }

    // Shorter evidence window right after section change (Lerdahl 2001)
    if (_timeSinceReset < SECTION_RESET_TTL_MS) {
      // Don't penalize — just let the shorter decay handle it
    }

    var id = _chordId(rootPC, type);
    _evidence[id] += weight;
    _observeCount++;

    // Human triads bypass temporal filter — weight 3.0 crosses threshold instantly
    if (source === 'human' && weight >= MIN_WEIGHT_THRESHOLD) {
      _commitChord(id, weight, 'human');
    }
  }

  // Commit a chord change (update SharedState)
  function _commitChord(winnerID, confidence, source) {
    var winner = _fromChordId(winnerID);
    var newRoot = winner.rootPC;
    var newType = winner.type;

    // Only emit change if chord actually changed
    var changed = !_currentChord ||
      _currentChord.rootPC !== newRoot ||
      _currentChord.type !== newType;

    _currentChord = {
      rootPC: newRoot,
      type: newType,
      confidence: Math.min(1.0, confidence / 10.0), // normalize to 0-1
      source: source,
      timestamp: Date.now()
    };

    // Update SharedState (backward-compatible)
    if (typeof SharedState !== 'undefined' && SharedState.recordChord) {
      SharedState.recordChord(newRoot, newType);
      // Extend with metadata
      if (SharedState.currentChord) {
        SharedState.currentChord.confidence = _currentChord.confidence;
        SharedState.currentChord.source = source;
        SharedState.currentChord.timestamp = _currentChord.timestamp;
      }
    }

    if (changed) {
      _chordChangeCount++;
      if (typeof EventBus !== 'undefined') {
        EventBus.emit('chordBeliefChanged', _currentChord);
      }
    }
  }

  // Tick: decay evidence, check threshold, update chord if needed
  function tick(dt) {
    _timeSinceUpdate += dt;
    _timeSinceReset += dt;

    if (_timeSinceUpdate < UPDATE_INTERVAL_MS) return;
    _timeSinceUpdate = 0;

    // ── Decay all evidence ──
    var decayFactor = Math.pow(_decayPerMs, UPDATE_INTERVAL_MS);
    // Accelerated decay after section reset
    if (_timeSinceReset < SECTION_RESET_TTL_MS) {
      decayFactor *= decayFactor; // double decay rate during transition
    }
    for (var i = 0; i < 24; i++) {
      _evidence[i] *= decayFactor;
      if (_evidence[i] < 0.001) _evidence[i] = 0;
    }

    // v9.2.0: Grammar feedback REMOVED to break circular dependency.
    // ChordBelief sets SharedState.currentChord → HarmonicPlanner reads it →
    // HarmonicPlanner.getNextChords() → ChordBelief fed it back as evidence = CIRCULAR.
    // Now: ChordBelief = evidential (what IS the chord?), HarmonicPlanner = predictive (what's NEXT?).
    // Grammar can observe ChordBelief's output but not feed into it.

    // ── Find winner ──
    var bestID = 0;
    var bestWeight = _evidence[0];
    var totalWeight = _evidence[0];
    for (var j = 1; j < 24; j++) {
      totalWeight += _evidence[j];
      if (_evidence[j] > bestWeight) {
        bestWeight = _evidence[j];
        bestID = j;
      }
    }

    // ── Threshold check ──
    if (bestWeight >= MIN_WEIGHT_THRESHOLD) {
      var source = 'consensus';
      _commitChord(bestID, bestWeight, source);
    }
  }

  // ── Section change handler ──
  if (typeof EventBus !== 'undefined') {
    EventBus.on('sectionChanged', function() {
      _timeSinceReset = 0;
      // Don't clear evidence — just accelerate decay via the reset timer

      // v9.3.0: Also expire all harmonic intents on section boundary
      // Lerdahl (2001): structural boundaries create new tonal contexts
      _consensusLastResetTime = Date.now();
      for (var v in _intents) {
        if (_intents[v]) _intents[v].timestamp = 0;
      }
    });
  }

  // ── Intentional layer API (v9.3.0) ──

  // Publish a voice's harmonic intent (what it plans/predicts harmonically).
  // Replaces direct writes to SharedState.harmonicIntent[voice].
  function publishIntent(voice, targetPC, targetType, confidence, beatsAway) {
    _intents[voice] = {
      targetPC: targetPC,
      targetType: targetType || 'major',
      confidence: confidence || 0,
      beatsAway: beatsAway || 0,
      timestamp: Date.now()
    };
  }

  // Get ensemble harmonic consensus from peer intent signals.
  // Weighted vote across published harmonic intents (stigmergic coordination).
  // Returns { targetPC, targetType, confidence } or null if insufficient consensus.
  // excludeVoice: voice name to exclude from voting (prevents self-voting).
  // Migrated from _getHarmonicConsensus in assistant-shared.js (v8.7.1-v9.2.0).
  function getConsensus(excludeVoice) {
    var weights = (typeof HARMONIC_AUTHORITY_WEIGHT !== 'undefined') ? HARMONIC_AUTHORITY_WEIGHT : null;
    if (!weights) return null;
    var baseTTL = (typeof HARMONIC_CONSENSUS_TTL !== 'undefined') ? HARMONIC_CONSENSUS_TTL : 3000;
    var now = Date.now();

    // Dynamic TTL: section boundary detection
    // After reset, use shorter TTL (1500ms) to prevent stale consensus bleeding
    var currentSection = '';
    if (typeof SectionTracker !== 'undefined') {
      currentSection = SectionTracker.getState().state;
    }
    if (currentSection && currentSection !== _consensusLastSection) {
      _consensusLastSection = currentSection;
      _consensusLastResetTime = now;
      for (var v in _intents) {
        if (_intents[v]) _intents[v].timestamp = 0;
      }
    }
    var timeSinceReset = now - _consensusLastResetTime;
    var ttl = timeSinceReset < 2000 ? 1500 : baseTTL;

    // Tally weighted votes per target pitch class
    for (var i = 0; i < 12; i++) _consensusVotes[i] = 0;
    var totalWeight = 0;
    for (var voice in _intents) {
      if (voice === excludeVoice) continue;
      var intent = _intents[voice];
      if (!intent || now - intent.timestamp > ttl) continue;
      // Weight = authority × confidence × recency decay
      // Farbood (2012): recent events weighted more strongly
      var age = now - intent.timestamp;
      var recency = 1.0 - (age / ttl) * 0.3;
      // Momentum authority boost (Keller 2014: leading voice)
      var authorityW = weights[voice] || 0;
      if (typeof SharedState !== 'undefined' && SharedState._momentumAuthorityBoost &&
          SharedState._momentumAuthorityBoost[voice]) {
        var _mab = SharedState._momentumAuthorityBoost[voice];
        if (now - _mab.timestamp < _MOMENTUM_DECAY) {
          authorityW += _mab.boost * (1.0 - (now - _mab.timestamp) / _MOMENTUM_DECAY);
        }
      }
      var w = authorityW * (intent.confidence || 0) * recency;
      if (w <= 0) continue;
      _consensusVotes[intent.targetPC] += w;
      totalWeight += w;
    }
    if (totalWeight < 0.3) return null;

    // Find winning PC
    var bestPC = 0, bestScore = 0;
    for (var pc = 0; pc < 12; pc++) {
      if (_consensusVotes[pc] > bestScore) { bestScore = _consensusVotes[pc]; bestPC = pc; }
    }
    var confidence = bestScore / totalWeight;
    if (confidence < 0.3) return null;

    // Find winning type from highest-authority voice voting for bestPC
    var bestType = 'major';
    var bestAuthority = 0;
    for (var voice2 in _intents) {
      if (voice2 === excludeVoice) continue;
      var intent2 = _intents[voice2];
      if (!intent2 || now - intent2.timestamp > ttl) continue;
      if (intent2.targetPC === bestPC && (weights[voice2] || 0) > bestAuthority) {
        bestAuthority = weights[voice2] || 0;
        bestType = intent2.targetType || 'major';
      }
    }

    return { targetPC: bestPC, targetType: bestType, confidence: confidence };
  }

  // ── Getters ──

  function getChord() {
    return _currentChord || {
      rootPC: (typeof SharedState !== 'undefined') ? SharedState.keyC : 0,
      type: (typeof SharedState !== 'undefined' && SharedState.mode === 'major') ? 'major' : 'minor',
      confidence: 0,
      source: 'none',
      timestamp: 0
    };
  }

  function getDistribution() {
    return _evidence;
  }

  function getEntropy() {
    // Shannon entropy of normalized evidence distribution
    var total = 0;
    for (var i = 0; i < 24; i++) total += _evidence[i];
    if (total < 0.001) return Math.log2(24); // maximum entropy (uniform)
    var entropy = 0;
    for (var j = 0; j < 24; j++) {
      var p = _evidence[j] / total;
      if (p > 0.001) entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  function getConfidence() {
    if (!_currentChord) return 0;
    return _currentChord.confidence;
  }

  function getDiagnostics() {
    return {
      observeCount: _observeCount,
      chordChangeCount: _chordChangeCount,
      currentChord: _currentChord,
      topEvidence: (function() {
        var sorted = [];
        for (var i = 0; i < 24; i++) {
          if (_evidence[i] > 0.01) {
            var c = _fromChordId(i);
            sorted.push({ rootPC: c.rootPC, type: c.type, weight: +_evidence[i].toFixed(3) });
          }
        }
        sorted.sort(function(a, b) { return b.weight - a.weight; });
        return sorted.slice(0, 5);
      })(),
      entropy: +getEntropy().toFixed(3)
    };
  }

  function reset() {
    for (var i = 0; i < 24; i++) _evidence[i] = 0;
    _currentChord = null;
    _timeSinceUpdate = 0;
    _timeSinceReset = Infinity;
    _observeCount = 0;
    _chordChangeCount = 0;
    // v9.3.0: also reset intentional layer
    _intents = {};
    _consensusLastSection = '';
    _consensusLastResetTime = 0;
  }

  return {
    observe: observe,
    tick: tick,
    getChord: getChord,
    getDistribution: getDistribution,
    getEntropy: getEntropy,
    getConfidence: getConfidence,
    getDiagnostics: getDiagnostics,
    reset: reset,
    // v9.3.0: Intentional layer (migrated from _getHarmonicConsensus)
    publishIntent: publishIntent,
    getConsensus: getConsensus
  };

})();

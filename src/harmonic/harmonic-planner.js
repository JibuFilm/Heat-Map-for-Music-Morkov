'use strict';
// ═══ HARMONIC PLANNER (Phase C — Hierarchical Prediction) ═══
//
// Sits between SectionTracker (macro form) and the assistants' phrase generation.
// Provides 3-chord lookahead so the system can ANTICIPATE harmonic changes
// rather than react to them.
//
// Two complementary models:
//   1. Chord-sequence PPM trie (learned from what the human plays)
//   2. Functional harmonic grammar (rule-based fallback from music theory)
//
// Assistants query: HarmonicPlanner.getNextChords() → [{rootPC, type, confidence, beatsAway}]
// The PhraseGenerator and assistants use this to choose leading tones, approach
// patterns, and resolution targets *before* the chord actually changes.
//
// Depends on: constants.js, event-bus.js, prediction-engine.js (SharedState),
//             bar-tracker.js (BarTracker), section-tracker.js (SectionTracker)
// Load order: after section-tracker.js, before assistant files.

var HarmonicPlanner = (function() {

  // ══════════════════════════════════════
  // CHORD HISTORY + PPM
  // ══════════════════════════════════════

  // Chord trie operates on chord IDs: rootPC * 2 + (type === 'major' ? 0 : 1)
  // This gives 24 possible chord IDs (12 roots × 2 types)
  var chordTrie = new PPMTrie(3);  // order-3 for short progressions
  var chordHistory = [];           // [{rootPC, type, time, duration}]
  var MAX_HISTORY = 64;

  // ── STYLE BIAS (zero-style-bias build) ──
  // Scales how much the learned chord-PPM (style, from live play) contributes
  // vs. the rule-based functional grammar. 0 = pure functional grammar (the
  // graph/grammar drives, belief state supplies direction); 1 = original v9
  // behavior (PPM ramps to 0.7 as it gathers data). Lexicons are stripped in
  // this build, so this governs whether ANY learned bias leaks in.
  var STYLE_BIAS = 0;

  // ── Chord change tracking ──
  var lastChordTime = 0;
  var lastChordID = -1;

  // ══════════════════════════════════════
  // FUNCTIONAL HARMONIC GRAMMAR
  // ══════════════════════════════════════
  // Rule-based chord expectations from common-practice harmony.
  // Each entry maps a scale-degree roman numeral to likely successors.
  // Weights are relative probabilities (not normalized).
  //
  // Major key progressions (Temperley 2009, Huron 2006)
  var MAJOR_GRAMMAR = {
    0: { 5: 3.0, 3: 2.0, 7: 1.5, 2: 1.0, 4: 0.8 },   // I  → IV, ii, V, vi, iii
    2: { 7: 3.0, 5: 2.0, 0: 0.5 },                       // ii → V, IV, I
    3: { 5: 2.0, 2: 1.5, 0: 0.5 },                        // iii → IV, ii, I (rare)
    4: { 7: 2.5, 5: 2.0, 2: 1.0, 0: 0.8 },               // iii(Em) → V, IV, ii
    5: { 7: 3.5, 0: 2.0, 2: 1.5, 9: 0.5 },               // IV → V, I, ii, vi
    7: { 0: 4.0, 9: 1.5, 5: 0.8 },                        // V  → I, vi, IV
    9: { 5: 2.5, 2: 2.0, 7: 1.0, 0: 0.5 }                // vi → IV, ii, V, I
  };

  // Minor key progressions — FUNCTIONAL (zero-style-bias build).
  // Pre-dominants (ii°, iv, VI) drive to V; V resolves to i. The harmonic-minor
  // leading tone is supplied by the tension layer when a chord sits on degree 7.
  // Modal colours (VII, III) are kept but the dominant is now central, so the
  // harmony has real tension and pull instead of a plagal i-iv-bVII drift.
  var MINOR_GRAMMAR = {
    0:  { 5: 3.0, 7: 2.5, 3: 1.8, 2: 1.2, 10: 0.6 },   // i   → iv, V, III, ii°, VII
    2:  { 7: 4.0, 0: 0.4 },                              // ii° → V
    3:  { 5: 2.0, 7: 2.0, 0: 1.0 },                      // III → iv, V, i
    5:  { 7: 4.0, 0: 1.0, 3: 0.5 },                      // iv  → V, i, III
    7:  { 0: 4.0, 8: 1.2, 5: 0.3 },                      // V   → i, VI (deceptive), iv
    8:  { 7: 2.0, 3: 1.5, 5: 1.0, 0: 1.0 },             // VI  → V, III, iv, i
    10: { 3: 2.0, 0: 1.5, 5: 1.0 }                       // VII → III, i, iv
  };

  // ══════════════════════════════════════
  // CHORD OBSERVATION
  // ══════════════════════════════════════

  function onChordChanged(data) {
    if (!data || data.rootPC === undefined) return;

    var now = Date.now();
    var chordID = data.rootPC * 2 + (data.type === 'major' ? 0 : 1);

    // Record duration of previous chord
    if (chordHistory.length > 0) {
      chordHistory[chordHistory.length - 1].duration = now - lastChordTime;
    }

    // Observe in PPM trie
    chordTrie.observe(chordID);

    // Push to history
    chordHistory.push({
      rootPC: data.rootPC,
      type: data.type,
      time: now,
      duration: 0,  // filled when next chord arrives
      id: chordID
    });
    if (chordHistory.length > MAX_HISTORY) chordHistory.shift();

    lastChordTime = now;
    lastChordID = chordID;
  }

  // Subscribe to chord changes from the event bus
  EventBus.on('chordChanged', onChordChanged);

  // ══════════════════════════════════════
  // PREDICTION: 3-CHORD LOOKAHEAD
  // ══════════════════════════════════════

  function getNextChords() {
    var results = [];
    var keyC = SharedState.keyC;
    var mode = SharedState.mode;

    // ── Step 1: PPM prediction for next chord ──
    var ppmProbs = chordTrie.predict(24);
    var ppmTotal = 0;
    for (var i = 0; i < 24; i++) ppmTotal += ppmProbs[i];

    // ── Step 2: Grammar prediction ──
    var grammar = (mode === 'major' || mode === 'mixolydian') ? MAJOR_GRAMMAR : MINOR_GRAMMAR;
    var grammarProbs = new Float64Array(24);

    if (SharedState.currentChord) {
      var currentSD = ((SharedState.currentChord.rootPC - keyC) % 12 + 12) % 12;
      var successors = grammar[currentSD];
      if (successors) {
        var keys = Object.keys(successors);
        for (var k = 0; k < keys.length; k++) {
          var targetSD = parseInt(keys[k]);
          var weight = successors[keys[k]];
          var targetPC = (targetSD + keyC) % 12;
          // Determine chord type from scale context
          var chordType = _inferChordType(targetSD, mode);
          var chordID = targetPC * 2 + (chordType === 'major' ? 0 : 1);
          grammarProbs[chordID] += weight;
        }
      }
    }

    // Normalize grammar
    var grammarTotal = 0;
    for (var g = 0; g < 24; g++) grammarTotal += grammarProbs[g];

    // ── Step 3: Blend PPM + Grammar ──
    // As PPM gets more data, it dominates. Grammar provides fallback.
    var ppmWeight = Math.min(chordHistory.length / 20, 0.7) * STYLE_BIAS;
    var gramWeight = 1.0 - ppmWeight;

    var blended = new Float64Array(24);
    for (var b = 0; b < 24; b++) {
      var ppmP = ppmTotal > 0 ? ppmProbs[b] / ppmTotal : 1 / 24;
      var gramP = grammarTotal > 0 ? grammarProbs[b] / grammarTotal : 1 / 24;
      blended[b] = ppmP * ppmWeight + gramP * gramWeight;
    }

    // ── Step 4: Section-aware modulation ──
    // During BUILD/PEAK: boost non-tonic chords (more adventurous harmony)
    // During RELEASE: boost tonic/subdominant (resolution)
    if (typeof SectionTracker !== 'undefined') {
      var sState = SectionTracker.getState();
      var adventurousness = sState.adventurousness || 0;
      var resolutionUrg = sState.resolutionUrgency || 0;

      if (adventurousness > 0.4) {
        // Boost non-tonic chords proportional to adventurousness
        var tonicID = keyC * 2 + (mode === 'major' ? 0 : 1);
        for (var a = 0; a < 24; a++) {
          if (a !== tonicID) {
            blended[a] *= (1 + adventurousness * 0.4);
          }
        }
      }

      if (resolutionUrg > 0.3) {
        // Boost V→I resolution
        var domPC = (keyC + 7) % 12;
        var tonicMaj = keyC * 2;
        var tonicMin = keyC * 2 + 1;
        var domMaj = domPC * 2;
        blended[tonicMaj] *= (1 + resolutionUrg * 0.6);
        blended[tonicMin] *= (1 + resolutionUrg * 0.6);
        blended[domMaj] *= (1 + resolutionUrg * 0.3);
      }
    }

    // ── Step 4a: Tonic gravity bias (Krumhansl 1990, Bharucha 1987) ──
    // Tonic chord must recur periodically for perceived key stability.
    // Krumhansl: tonal center needs reinforcement every 2-4s (~4-8 beats at 120 BPM).
    // Without this, the planner drifts to iv-bVII plagal loops (tonic at 8.9% vs 15-25% target).
    // After 8 beats without tonic, apply a growing bonus that caps at +60%.
    // This is NOT genre tuning — it is psychoacoustic grounding for tonal stability.
    if (chordHistory.length > 0) {
      var _tgNow = Date.now();
      var _tgTonicPC = keyC;
      var _tgLastTonicTime = 0;
      for (var _tgi = chordHistory.length - 1; _tgi >= 0; _tgi--) {
        if (chordHistory[_tgi].rootPC === _tgTonicPC) {
          _tgLastTonicTime = chordHistory[_tgi].time;
          break;
        }
      }
      var _tgBpm = (typeof PhaseCoupling !== 'undefined' && PhaseCoupling.getConsensusBPM)
        ? PhaseCoupling.getConsensusBPM() : 120;
      if (!_tgBpm || _tgBpm < 30) _tgBpm = 120;
      var _tgBeatMs = 60000 / _tgBpm;
      // If tonic never appeared, treat as maximally overdue (use session start as reference)
      var _tgRefTime = _tgLastTonicTime > 0 ? _tgLastTonicTime : (chordHistory[0].time || _tgNow - 10000);
      var _tgBeatsSinceTonic = (_tgNow - _tgRefTime) / _tgBeatMs;
      if (_tgBeatsSinceTonic > 6) {
        // Gravity must overcome section-aware suppression (non-tonic gets up to 1.32× during PEAK).
        // Ramp from 1.0 at 6 beats to cap of 1.5 at 18 beats. This ensures tonic probability
        // can compete with adventurousness-boosted non-tonic chords.
        var _tgGravity = 1.0 + 0.40 * Math.min((_tgBeatsSinceTonic - 6) / 12, 1.25);
        blended[_tgTonicPC * 2] *= _tgGravity;       // tonic major
        blended[_tgTonicPC * 2 + 1] *= _tgGravity;   // tonic minor
      }
    }

    // ── Step 4b: Peer harmonic consensus boost (Pressing 1999, stigmergic coordination) ──
    // v9.3.0: Boost chord prediction toward peer consensus via ChordBelief.
    // Bharucha (1987): harmonic priming effect ~15%. Scale by consensus confidence.
    if (typeof ChordBelief !== 'undefined') {
      var _hc = ChordBelief.getConsensus(null);  // full consensus (no voice excluded)
      if (_hc) {
        var _hcBonus = (typeof HARMONIC_CONSENSUS_BONUS !== 'undefined') ? HARMONIC_CONSENSUS_BONUS : 0.15;
        var _hcTypeIdx = _hc.targetType === 'minor' ? 1 : 0;
        var _hcID = _hc.targetPC * 2 + _hcTypeIdx;
        blended[_hcID] *= (1 + _hcBonus * _hc.confidence);
        // Also boost the alternative quality (major↔minor) at reduced strength
        var _hcAltID = _hc.targetPC * 2 + (1 - _hcTypeIdx);
        blended[_hcAltID] *= (1 + _hcBonus * _hc.confidence * 0.3);
      }
    }

    // ── Step 5: Extract top 3 predictions ──
    // Normalize
    var total = 0;
    for (var n = 0; n < 24; n++) total += blended[n];
    if (total > 0) {
      for (var n = 0; n < 24; n++) blended[n] /= total;
    }

    // Sort indices by probability
    var indices = [];
    for (var idx = 0; idx < 24; idx++) indices.push(idx);
    indices.sort(function(a, b) { return blended[b] - blended[a]; });

    // Estimate beats until next chord change
    var beatsUntil = _estimateBeatsUntilChange();

    for (var r = 0; r < Math.min(3, indices.length); r++) {
      var ci = indices[r];
      var rootPC = Math.floor(ci / 2);
      var type = ci % 2 === 0 ? 'major' : 'minor';
      results.push({
        rootPC: rootPC,
        type: type,
        confidence: blended[ci],
        beatsAway: beatsUntil * (r + 1)  // rough: each successive chord further away
      });
    }

    return results;
  }

  // ── Get chord tones for the predicted next chord ──
  // Returns [rootPC, thirdPC, fifthPC] for the top prediction
  function getNextChordTones() {
    var next = getNextChords();
    if (next.length === 0) return null;

    var top = next[0];
    var third = (top.rootPC + (top.type === 'minor' ? 3 : 4)) % 12;
    var fifth = (top.rootPC + 7) % 12;
    return [top.rootPC, third, fifth];
  }

  // ── Get confidence of the top prediction ──
  function getConfidence() {
    var next = getNextChords();
    return next.length > 0 ? next[0].confidence : 0;
  }

  // ── Get current chord context for assistants ──
  // Returns a richer chord object with extensions and function label
  function getCurrentContext() {
    var chord = SharedState.currentChord;
    if (!chord) return null;

    var keyC = SharedState.keyC;
    var sd = ((chord.rootPC - keyC) % 12 + 12) % 12;
    var functionLabel = _sdToFunction(sd, SharedState.mode);

    return {
      rootPC: chord.rootPC,
      type: chord.type,
      scaleDegree: sd,
      functionLabel: functionLabel,
      chordTones: [
        chord.rootPC,
        (chord.rootPC + (chord.type === 'minor' ? 3 : 4)) % 12,
        (chord.rootPC + 7) % 12
      ],
      durationMs: Date.now() - lastChordTime,
      isTonicFunction: sd === 0 || sd === 9,  // I or vi
      isDominantFunction: sd === 7 || sd === 11,  // V or vii°
      isSubdominantFunction: sd === 5 || sd === 2  // IV or ii
    };
  }

  // ══════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════

  // Infer chord type from scale degree and mode
  function _inferChordType(sd, mode) {
    if (mode === 'major' || mode === 'mixolydian' || mode === 'pent_major') {
      // Major: I, IV, V major; ii, iii, vi minor
      if (sd === 0 || sd === 5 || sd === 7) return 'major';
      return 'minor';
    } else {
      // Minor: i, iv, v minor; III, VI, VII major
      if (sd === 3 || sd === 8 || sd === 10) return 'major';
      return 'minor';
    }
  }

  // Scale degree to functional label
  function _sdToFunction(sd, mode) {
    var labels = {
      0: 'tonic', 2: 'supertonic', 3: 'mediant', 4: 'mediant',
      5: 'subdominant', 7: 'dominant', 8: 'submediant', 9: 'submediant',
      10: 'subtonic', 11: 'leading'
    };
    return labels[sd] || 'chromatic';
  }

  // Estimate beats until next chord change from recent history
  function _estimateBeatsUntilChange() {
    if (chordHistory.length < 2) return 4; // default: 1 bar

    // Average recent chord durations
    var recentCount = Math.min(6, chordHistory.length - 1);
    var totalDur = 0;
    for (var i = chordHistory.length - recentCount - 1; i < chordHistory.length - 1; i++) {
      if (i >= 0 && chordHistory[i].duration > 0) {
        totalDur += chordHistory[i].duration;
      }
    }
    var avgDurMs = totalDur / Math.max(1, recentCount);
    if (avgDurMs <= 0) return 4;

    // Convert to beats
    var bpm = (typeof TempoEngine !== 'undefined') ?
      TempoEngine.getEffectiveBPM() : 120;
    if (!Number.isFinite(bpm) || bpm < 30) bpm = 120;
    var beatMs = 60000 / bpm;

    var avgBeats = avgDurMs / beatMs;

    // How long since last chord change?
    var elapsed = (Date.now() - lastChordTime) / beatMs;
    var remaining = Math.max(0.5, avgBeats - elapsed);

    return remaining;
  }

  // ═══════════════════════════════════════
  // REGISTER-AWARE CHORD FILTERING (v3.17.0)
  // ═══════════════════════════════════════
  // Voice-aware chord prediction. Penalizes chords that would create
  // roughness in the requesting voice's register (Plomp & Levelt 1965).
  //
  // Critical bandwidth varies with register:
  //   Bass (C1-C3): ~3 semitones (100-262 Hz, CB ~100 Hz)
  //   Mid (C3-C5): ~4 semitones (262-1047 Hz, CB ~150 Hz)
  //   High (C5+): ~5+ semitones (1047+ Hz, CB ~200 Hz)
  //
  // For bass voice: penalize chords where root-to-root motion <= 3 semitones
  // (creates audible beating at bass frequencies).
  // For melody voices: no penalty (close intervals are clear at higher registers).

  // Approximate register per voice (in MIDI note range center)
  var VOICE_REGISTER = {
    bass: 36,        // C2 — low register, narrow critical bandwidth
    rhythm: 60,      // C4 — mid register
    soloist: 72,     // C5 — upper register
    lead: 66,        // F#4 — mid-upper register
    percussion: 48   // C3 — irrelevant (unpitched) but defined for completeness
  };

  // Critical bandwidth in semitones by register (Glasberg & Moore 1990)
  function _getCriticalBandwidthST(midiCenter) {
    if (midiCenter < 48) return 3;    // below C3: ~3 semitones
    if (midiCenter < 72) return 4;    // C3-C5: ~4 semitones
    return 5;                          // above C5: ~5+ semitones
  }

  // Register cost: penalize chord predictions that create roughness for a voice.
  // Returns a multiplier 0.3-1.0 (1.0 = no penalty, 0.3 = maximum roughness).
  function _registerCost(voice, predictedRootPC) {
    var register = VOICE_REGISTER[voice];
    if (!register) return 1.0;

    var cbST = _getCriticalBandwidthST(register);

    // Measure interval from current chord root to predicted root
    var currentChord = SharedState.currentChord;
    if (!currentChord || currentChord.rootPC === undefined) return 1.0;

    var interval = Math.abs(predictedRootPC - currentChord.rootPC);
    if (interval > 6) interval = 12 - interval;  // shortest path on pitch class circle

    // No penalty for unisons (0) or intervals above critical bandwidth
    if (interval === 0 || interval >= cbST) return 1.0;

    // Penalty scales with how deep into the critical bandwidth zone we are.
    // At interval=1 (semitone): maximum roughness -> 0.3 for bass, 0.5 for mid
    // At interval=cbST-1: mild roughness -> 0.7-0.8
    var depth = 1.0 - (interval / cbST);  // 1.0 at interval=0, 0 at interval=cbST
    var penalty = 1.0 - depth * 0.7;      // 0.3 at max depth, 1.0 at no depth

    return Math.max(0.3, penalty);
  }

  // Voice-aware chord prediction.
  // Same as getNextChords() but applies register cost for the requesting voice.
  function getNextChordsForVoice(voice) {
    if (!voice) return getNextChords();

    var results = [];
    var keyC = SharedState.keyC;
    var mode = SharedState.mode;

    // ── Reuse the existing prediction pipeline ──
    // PPM prediction
    var ppmProbs = chordTrie.predict(24);
    var ppmTotal = 0;
    for (var pi = 0; pi < 24; pi++) ppmTotal += ppmProbs[pi];

    // Grammar prediction
    var grammar = (mode === 'major' || mode === 'mixolydian') ? MAJOR_GRAMMAR : MINOR_GRAMMAR;
    var grammarProbs = new Float64Array(24);

    if (SharedState.currentChord) {
      var currentSD = ((SharedState.currentChord.rootPC - keyC) % 12 + 12) % 12;
      var successors = grammar[currentSD];
      if (successors) {
        var sKeys = Object.keys(successors);
        for (var sk = 0; sk < sKeys.length; sk++) {
          var targetSD = parseInt(sKeys[sk]);
          var weight = successors[sKeys[sk]];
          var targetPC = (targetSD + keyC) % 12;
          var chordType = _inferChordType(targetSD, mode);
          var chordID = targetPC * 2 + (chordType === 'major' ? 0 : 1);
          grammarProbs[chordID] += weight;
        }
      }
    }

    // Normalize grammar
    var grammarTotal = 0;
    for (var gi = 0; gi < 24; gi++) grammarTotal += grammarProbs[gi];

    // Blend PPM + Grammar
    var ppmWeight = Math.min(chordHistory.length / 20, 0.7) * STYLE_BIAS;
    var gramWeight = 1.0 - ppmWeight;
    var blended = new Float64Array(24);
    for (var bi = 0; bi < 24; bi++) {
      var ppmP = ppmTotal > 0 ? ppmProbs[bi] / ppmTotal : 1 / 24;
      var gramP = grammarTotal > 0 ? grammarProbs[bi] / grammarTotal : 1 / 24;
      blended[bi] = ppmP * ppmWeight + gramP * gramWeight;
    }

    // Section-aware modulation
    if (typeof SectionTracker !== 'undefined') {
      var sState = SectionTracker.getState();
      var adventurousness = sState.adventurousness || 0;
      var resolutionUrg = sState.resolutionUrgency || 0;

      if (adventurousness > 0.4) {
        var tonicID = keyC * 2 + (mode === 'major' ? 0 : 1);
        for (var ai = 0; ai < 24; ai++) {
          if (ai !== tonicID) blended[ai] *= (1 + adventurousness * 0.4);
        }
      }

      if (resolutionUrg > 0.3) {
        var domPC = (keyC + 7) % 12;
        var tonicMaj = keyC * 2;
        var tonicMin = keyC * 2 + 1;
        var domMaj = domPC * 2;
        blended[tonicMaj] *= (1 + resolutionUrg * 0.6);
        blended[tonicMin] *= (1 + resolutionUrg * 0.6);
        blended[domMaj] *= (1 + resolutionUrg * 0.3);
      }
    }

    // ── v3.17.0: Apply register cost per chord ──
    for (var rc = 0; rc < 24; rc++) {
      var rcRootPC = Math.floor(rc / 2);
      blended[rc] *= _registerCost(voice, rcRootPC);
    }

    // Normalize
    var total = 0;
    for (var ni = 0; ni < 24; ni++) total += blended[ni];
    if (total > 0) {
      for (var ni2 = 0; ni2 < 24; ni2++) blended[ni2] /= total;
    }

    // Sort indices by probability
    var indices = [];
    for (var idx = 0; idx < 24; idx++) indices.push(idx);
    indices.sort(function(x, y) { return blended[y] - blended[x]; });

    // Estimate beats until next chord change
    var beatsUntil = _estimateBeatsUntilChange();

    // Extract top 3
    for (var ri = 0; ri < Math.min(3, indices.length); ri++) {
      var ci = indices[ri];
      var rPC = Math.floor(ci / 2);
      var type = ci % 2 === 0 ? 'major' : 'minor';
      results.push({
        rootPC: rPC,
        type: type,
        confidence: blended[ci],
        beatsAway: beatsUntil * (ri + 1)
      });
    }

    return results;
  }

  // ══════════════════════════════════════
  // RESET
  // ══════════════════════════════════════

  function reset() {
    chordTrie.reset();
    chordHistory = [];
    lastChordTime = 0;
    lastChordID = -1;
  }

  // ══════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════

  return {
    getNextChords:         getNextChords,         // → [{rootPC, type, confidence, beatsAway}] (top 3)
    getNextChordsForVoice: getNextChordsForVoice, // → same, register-aware (v3.17.0)
    getNextChordTones:     getNextChordTones,     // → [rootPC, thirdPC, fifthPC] or null
    getConfidence:         getConfidence,          // → 0-1 for top prediction
    getCurrentContext:     getCurrentContext,      // → rich chord context object
    reset:                 reset
  };

})();

console.log('%cHarmonicPlanner loaded', 'color:#4a9;font-family:monospace');

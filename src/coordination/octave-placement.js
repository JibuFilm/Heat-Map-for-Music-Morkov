'use strict';
// ═══ OCTAVE PLACEMENT — Context-Aware PC → Absolute MIDI ═══
//
// Replaces the hardcoded baseMidi lookup in app.js playVoiceNote:
//   bass → 36, rhythm → 60, soloist → 72
//
// Instead, each voice has a HOME range (strong gravity, ~70% of notes)
// and a ROAM range (allowed but costlier). The placement function
// picks the octave that minimizes a combined cost of:
//   1. Voice-leading distance from previous note
//   2. Gravity toward home range center
//   3. Separation from other active voices
//
// v9.1.0: Session-phase register modulation (Huron 2001, Bregman 1990).
// Compact register at exposition (warmth, stream fusion) → maximum
// spread at recapitulation (grandeur, stream segregation). The pitch-
// space equivalent of TimbralEvolution's stereo width modulation.
//
// This gives bass occasional walks up to G3, solo occasional dips
// to C4, while keeping voices mostly in their natural territory.
//
// No hard boundaries — the cost function is soft. A bass note at
// MIDI 55 (G3) is allowed, it just costs more than MIDI 43 (G2).
//
// Depends on: nothing (standalone utility)
// Load order: before app.js

var OctavePlacement = (function() {

  // ═══════════════════════════════════════
  // VOICE RANGES
  // ═══════════════════════════════════════

  // Voice ranges enforce register separation for auditory stream segregation
  // (Bregman 1990). Each voice occupies a distinct register band.
  // Gap between adjacent home ranges: ≥5 semitones for clarity.
  //   bass:    C2-B2  (low anchor)
  //   rhythm:  C3-E4  (mid harmonic pad)
  //   lead:    F4-B4  (upper-mid melodic driver)
  //   soloist: C5-B5  (high melodic explorer)
  var RANGES = {
    bass:    { home: [36, 47], roam: [30, 55] },   // C2-B2 home, tighter roam
    rhythm:  { home: [48, 64], roam: [36, 72] },   // C3-E4 home, trimmed top to avoid lead
    soloist: { home: [72, 83], roam: [66, 90] },   // C5-B5 home, tighter roam (was 60-96)
    lead:    { home: [65, 76], roam: [55, 84] }    // F4-E5 home, between rhythm and soloist
  };

  // Home center (midpoint of home range)
  var HOME_CENTER = {
    bass:   41.5,  // (36+47)/2
    rhythm: 56.0,  // (48+64)/2 — was 59.5, now lower to create gap with lead
    soloist: 77.5,  // (72+83)/2
    lead:   70.5   // (65+76)/2 — was 68, now higher to sit between rhythm and soloist
  };

  // ═══════════════════════════════════════
  // GRAVITY WEIGHTS (section-dependent)
  // ═══════════════════════════════════════
  // Higher = stronger pull toward home. Lower = more roaming.

  var GRAVITY_BY_SECTION = {
    STABLE:     1.0,
    BUILD:      0.6,
    PEAK:       0.5,   // was 0.3 — keep voices closer to home even at climax
    RELEASE:    0.8,
    TRANSITION: 0.9
  };

  // v2.4: Register bias per section (from universal ensemble research)
  // Positive = bias toward higher register, negative = toward lower
  // BUILD ascends, PEAK stays high, RELEASE descends — mirrors energy arc
  var REGISTER_BIAS = {
    STABLE:     0,
    BUILD:      3,     // +3 MIDI notes toward higher register
    PEAK:       5,     // stay high
    RELEASE:    -4,    // descend
    TRANSITION: 0
  };

  // ═══════════════════════════════════════
  // SESSION-PHASE REGISTER MODULATION (v9.1.0)
  // ═══════════════════════════════════════
  // Compact register at exposition (Huron 2001: proximity = intimacy,
  // McAdams & Bregman 1979: overlapping register = stream fusion = blended texture).
  // Maximum spread at recapitulation (Bregman 1990: pitch separation = stream
  // segregation = distinct voices = grandeur).
  //
  // homeShift: MIDI semitones to shift home center (+ = higher, - = lower)
  // roamShrink: total semitones to shrink roam range (split between top/bottom)

  var SESSION_REGISTER = {
    exposition: {
      bass:    { homeShift: +3,  roamShrink: 4 },   // closer to rhythm (compact warmth)
      rhythm:  { homeShift:  0,  roamShrink: 3 },
      soloist: { homeShift: -4,  roamShrink: 5 },   // closer to lead (overlapping intimacy)
      lead:    { homeShift: -2,  roamShrink: 3 }
    },
    development: {
      bass:    { homeShift: +1,  roamShrink: 2 },   // spreading
      rhythm:  { homeShift:  0,  roamShrink: 1 },
      soloist: { homeShift: -2,  roamShrink: 2 },
      lead:    { homeShift: -1,  roamShrink: 1 }
    },
    recapitulation: {
      bass:    { homeShift: -2,  roamShrink: 0 },   // deeper bass (full depth)
      rhythm:  { homeShift:  0,  roamShrink: 0 },   // full range
      soloist: { homeShift: +2,  roamShrink: 0 },   // higher (brilliant)
      lead:    { homeShift: +1,  roamShrink: 0 }    // slightly higher
    }
  };

  // ═══════════════════════════════════════
  // LAST NOTE TRACKING (for voice-leading)
  // ═══════════════════════════════════════

  var _lastMidi = {
    bass:   41,   // start near home center
    rhythm: 56,
    soloist: 77,
    lead:   70
  };

  // ═══════════════════════════════════════
  // PLACEMENT FUNCTION
  // ═══════════════════════════════════════

  // Given a pitch class (0-11) and voice name, return the best absolute MIDI note.
  // context (optional): { sectionState, otherVoiceMidi: [midi1, midi2] }
  function place(pc, voiceName, context) {
    var range = RANGES[voiceName];
    if (!range) return pc + 60; // fallback

    var homeCenter = HOME_CENTER[voiceName];
    var prevMidi = _lastMidi[voiceName];

    // Section-dependent gravity
    var sectionState = (context && context.sectionState) ? context.sectionState : 'STABLE';
    var gravityWeight = GRAVITY_BY_SECTION[sectionState] || 1.0;
    // QW2 bass PEAK gravity TESTED: MI 67, bassRhythmMI 0.93 (regression).
    // Tighter bass register constrains pitch choices, increasing convergence with rhythm.
    // Reverted — bass register flexibility is needed for voice independence.

    // ── Session-phase register modulation (v9.1.0) ──
    // Shift home center and shrink roam range based on session arc phase.
    var adjustedCenter = homeCenter;
    var adjustedRoamLow = range.roam[0];
    var adjustedRoamHigh = range.roam[1];
    var sessionPhase = null;

    if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getSessionPhase) {
      var sp = NarrativeArc.getSessionPhase();
      sessionPhase = sp.phase;
      var sr = SESSION_REGISTER[sp.phase];
      if (sr && sr[voiceName]) {
        adjustedCenter += sr[voiceName].homeShift;
        adjustedRoamLow += Math.floor(sr[voiceName].roamShrink / 2);
        adjustedRoamHigh -= Math.ceil(sr[voiceName].roamShrink / 2);
      }
      // SessionEnding convergence: return toward compact (intimate) during ending
      if (typeof SessionEnding !== 'undefined' && SessionEnding.isActive()) {
        var endState = SessionEnding.getState();
        var endProg = endState.progress || 0;
        var expoReg = SESSION_REGISTER.exposition[voiceName];
        if (expoReg && sr && sr[voiceName]) {
          var currentShift = sr[voiceName].homeShift;
          adjustedCenter = homeCenter + currentShift + (expoReg.homeShift - currentShift) * endProg;
          var currentShrink = sr[voiceName].roamShrink;
          var expoShrink = expoReg.roamShrink;
          var blendShrink = currentShrink + (expoShrink - currentShrink) * endProg;
          adjustedRoamLow = range.roam[0] + Math.floor(blendShrink / 2);
          adjustedRoamHigh = range.roam[1] - Math.ceil(blendShrink / 2);
        }
      }
    }

    // Behavior mode gravity: each mode specifies how tightly the voice
    // should stick to home range (pedal=1.5, walking=0.4, etc.)
    if (typeof BehaviorModes !== 'undefined') {
      try {
        var bm = BehaviorModes.getMode(voiceName);
        if (bm && bm.gravityMult) {
          gravityWeight *= bm.gravityMult;
        }
      } catch (e) {}
    }

    // Belief-state modulation: needs_space → more roaming, needs_stability → stay home
    if (typeof BeliefState !== 'undefined') {
      try {
        var belief = BeliefState.getBelief(voiceName);
        if (belief) {
          var roamBias = (belief.needs_space || 0) * 0.3 + (belief.needs_surprise || 0) * 0.2;
          var homeBias = (belief.needs_stability || 0) * 0.2;
          gravityWeight *= (1.0 - roamBias + homeBias);
        }
      } catch (e) {}
    }
    gravityWeight = Math.max(0.1, Math.min(2.0, gravityWeight));

    // Generate all candidate octave placements within roam range
    var candidates = [];

    for (var octave = 0; octave <= 9; octave++) {
      var midi = pc + octave * 12;
      if (midi < adjustedRoamLow || midi > adjustedRoamHigh) continue;
      candidates.push(midi);
    }

    if (candidates.length === 0) {
      // Fallback: nearest to adjusted home center
      var fallback = pc + Math.round((adjustedCenter - pc) / 12) * 12;
      _lastMidi[voiceName] = fallback;
      return fallback;
    }

    // Score each candidate (lower cost = better)
    var bestMidi = candidates[0];
    var bestCost = Infinity;

    // Session-aware separation threshold (v9.1.0):
    // Exposition allows closer voices (fusion = blended warmth).
    // Recapitulation demands clear separation (segregation = distinct grandeur).
    var fusionThreshold = 7;
    if (sessionPhase === 'exposition') fusionThreshold = 4;
    else if (sessionPhase === 'recapitulation') fusionThreshold = 8;

    for (var i = 0; i < candidates.length; i++) {
      var midi = candidates[i];

      // 1. Voice-leading cost: distance from previous note (most important)
      var vlDist = Math.abs(midi - prevMidi);
      var vlCost = vlDist * 0.4;  // weight: 0.4 per semitone

      // 2. Gravity cost: distance from adjusted home center (section-dependent)
      var homeDist = Math.abs(midi - adjustedCenter);
      // Inside home range: zero cost. Outside: quadratic
      var inHome = (midi >= range.home[0] && midi <= range.home[1]);
      var gravityCost = inHome ? 0 : (homeDist * homeDist * 0.005 * gravityWeight);

      // 3. Separation cost: avoid other active voices (prevent masking)
      // Bregman 1990: timbre alone insufficient for stream segregation in the
      // same register — pitch separation is the primary grouping cue.
      var sepCost = 0;
      if (context && context.otherVoiceMidi) {
        for (var j = 0; j < context.otherVoiceMidi.length; j++) {
          var otherMidi = context.otherVoiceMidi[j];
          if (otherMidi === null || otherMidi === undefined) continue;
          var dist = Math.abs(midi - otherMidi);
          // Penalty for being within fusion threshold (session-aware)
          if (dist < fusionThreshold) sepCost += (fusionThreshold - dist) * 1.5;
          // Mild preference for moderate separation
          else if (dist <= 18) sepCost += 0;
          else sepCost += (dist - 18) * 0.03;  // very mild cost for extreme spread
        }
      }

      // 4. Leap penalty: discourage huge jumps (>12 semitones)
      var leapCost = 0;
      if (vlDist > 12) leapCost = (vlDist - 12) * 0.3;

      // 5. v2.4: Register bias — section-dependent directional preference
      var regBias = REGISTER_BIAS[sectionState] || 0;
      var regBiasCost = 0;
      if (regBias !== 0 && prevMidi > 0) {
        var biasTarget = prevMidi + regBias;
        regBiasCost = Math.abs(midi - biasTarget) * 0.08;
      }

      var totalCost = vlCost + gravityCost + sepCost + leapCost + regBiasCost;

      if (totalCost < bestCost) {
        bestCost = totalCost;
        bestMidi = midi;
      }
    }

    _lastMidi[voiceName] = bestMidi;
    return bestMidi;
  }

  // ═══════════════════════════════════════
  // QUERY / RESET
  // ═══════════════════════════════════════

  function getLastMidi(voice) {
    return _lastMidi[voice] || 60;
  }

  function getRange(voice) {
    return RANGES[voice] || RANGES.rhythm;
  }

  function reset() {
    _lastMidi.bass = 41;
    _lastMidi.rhythm = 56;
    _lastMidi.soloist = 77;
    _lastMidi.lead = 70;
  }

  return {
    place:       place,
    getLastMidi: getLastMidi,
    getRange:    getRange,
    reset:       reset,
    RANGES:      RANGES
  };

})();

console.log('%cOctavePlacement loaded (gravity-based, session-phase register)', 'color:#af6;font-family:monospace');

'use strict';
// ═══ OVERLAP MANAGER — MIDI-Domain Psychoacoustic Safety ═══
//
// Runs AFTER OctavePlacement (has absolute MIDI) but BEFORE VoiceManager.
// Applies psychoacoustic rules from the research spec to prevent masking.
//
// 6 rules in priority order:
//   1. Low Interval Limit — shift or suppress below-threshold intervals
//   2. Onset Displacement — delay when critical-band collision
//   3. Contrary Motion — integrated into OctavePlacement (not here)
//   4. Dynamic Hierarchy — velocity scaling by distance from human
//   5. Density Budget — section-aware voice/note limits
//   6. Critical-Band Check — Bark band histogram safety net
//
// Depends on: OctavePlacement (getLastMidi), VoiceManager (getActiveNotes),
//             SectionTracker, ContextIntegrator
// Load order: after octave-placement.js, before app.js

var OverlapManager = (function() {

  // ═══════════════════════════════════════
  // LOW INTERVAL LIMIT TABLE
  // ═══════════════════════════════════════
  // For each interval (in semitones), the minimum MIDI of the TOP note
  // below which the interval becomes muddy.
  // From psychoacoustic research (Huron, Plomp & Levelt).

  var LIL_TABLE = {
    1:  52,  // m2 — below E3, minor seconds are indistinct
    2:  51,  // M2 — below Eb3
    3:  48,  // m3 — below C3
    4:  45,  // M3 — below A2
    5:  40,  // P4 — below E2
    6:  38,  // tritone — below D2
    // P5 (7), m6 (8), M6 (9) — clear down to very low registers
    // Octave (12) — always clear
  };

  // ═══════════════════════════════════════
  // BARK BAND LOOKUP (MIDI → Bark band)
  // ═══════════════════════════════════════
  // Simplified: 1 entry per MIDI note 21-108.
  // Bark = floor(13 * atan(0.00076 * f) + 3.5 * atan((f/7500)^2))
  // Pre-computed for speed.

  var _barkCache = {};

  function _midiToBark(midi) {
    if (_barkCache[midi] !== undefined) return _barkCache[midi];
    var freq = 440 * Math.pow(2, (midi - 69) / 12);
    var bark = Math.floor(13 * Math.atan(0.00076 * freq) + 3.5 * Math.atan(Math.pow(freq / 7500, 2)));
    _barkCache[midi] = bark;
    return bark;
  }

  // ═══════════════════════════════════════
  // STATS TRACKING
  // ═══════════════════════════════════════

  var _stats = { lilShifts: 0, lilSuppressed: 0, hierarchyScaled: 0, densitySuppressed: 0, barkSuppressed: 0 };

  // ═══════════════════════════════════════
  // RULE 1: LOW INTERVAL LIMIT
  // ═══════════════════════════════════════

  function _lowIntervalLimit(midi, voiceName) {
    // Check against all other voices' current MIDI positions
    var voices = ['bass', 'rhythm', 'soloist', 'lead'];
    for (var i = 0; i < voices.length; i++) {
      if (voices[i] === voiceName) continue;
      var otherMidi = _getVoiceMidi(voices[i]);
      if (otherMidi === null) continue;

      var low = Math.min(midi, otherMidi);
      var high = Math.max(midi, otherMidi);
      var interval = high - low;
      if (interval > 12) interval = interval % 12;
      if (interval === 0) continue;

      var minTop = LIL_TABLE[interval];
      if (minTop === undefined) continue;  // interval is safe at any register

      if (high < minTop) {
        // Violation — try shifting the candidate up one octave
        if (midi === low) {
          // Our note is the low one — shift up
          var shifted = midi + 12;
          var newHigh = Math.max(shifted, otherMidi);
          if (newHigh >= minTop) {
            _stats.lilShifts++;
            return { midi: shifted, suppress: false };
          }
        }
        // Can't fix by shifting — suppress
        _stats.lilSuppressed++;
        return { midi: midi, suppress: true };
      }
    }
    return { midi: midi, suppress: false };
  }

  // ═══════════════════════════════════════
  // RULE 4: DYNAMIC HIERARCHY
  // ═══════════════════════════════════════

  function _dynamicHierarchy(midi, voiceName) {
    // Get human's recent MIDI range
    var humanMidi = _getHumanMidi();
    if (humanMidi === null) return 1.0;

    var distance = Math.abs(midi - humanMidi);

    // Rank all AI voices by distance from human
    var voices = ['bass', 'rhythm', 'soloist', 'lead'];
    var distances = [];
    for (var i = 0; i < voices.length; i++) {
      var vm = _getVoiceMidi(voices[i]);
      if (vm !== null) {
        distances.push({ voice: voices[i], dist: Math.abs(vm - humanMidi) });
      }
    }
    distances.sort(function(a, b) { return a.dist - b.dist; });

    // Find this voice's rank (closest = background, furthest = foreground)
    for (var i = 0; i < distances.length; i++) {
      if (distances[i].voice === voiceName) {
        if (i === 0) { _stats.hierarchyScaled++; return 0.5; }   // closest → background
        if (i === 1) { _stats.hierarchyScaled++; return 0.7; }   // middle → middleground
        return 1.0;                                                // furthest → foreground
      }
    }
    return 1.0;
  }

  // ═══════════════════════════════════════
  // RULE 5: DENSITY BUDGET BY SECTION
  // ═══════════════════════════════════════

  var DENSITY_BUDGET = {
    INTRO:      { maxVoices: 1, maxNotesPerBeat: 2 },
    STABLE:     { maxVoices: 3, maxNotesPerBeat: 6 },
    BUILD:      { maxVoices: 3, maxNotesPerBeat: 8 },
    PEAK:       { maxVoices: 3, maxNotesPerBeat: 10 },
    RELEASE:    { maxVoices: 2, maxNotesPerBeat: 4 },
    TRANSITION: { maxVoices: 2, maxNotesPerBeat: 3 }
  };

  function _densityBudget(voiceName, sectionState) {
    var budget = DENSITY_BUDGET[sectionState] || DENSITY_BUDGET.STABLE;
    var maxNpb = budget.maxNotesPerBeat;

    // v2.2: Baseline mode — fixed section budgets only.
    // Belief-aware budget adjustment deferred to per-voice observation stage.
    // When per-voice beliefs are working, re-enable:
    //   maxNpb += BeliefState.getParams(voice).density * 5;

    // Count active voices (voices that played in the last beat)
    if (typeof FinalCoordinator !== 'undefined') {
      var density = FinalCoordinator.getPerceivedDensity
        ? FinalCoordinator.getPerceivedDensity()
        : 0;
      if (density > maxNpb) {
        // Over budget — suppress lower-priority voices (soloist first, then rhythm)
        if (voiceName === 'soloist' || (voiceName === 'rhythm' && density > maxNpb + 2)) {
          _stats.densitySuppressed++;
          return true;  // suppress
        }
      }
    }
    return false;
  }

  // ═══════════════════════════════════════
  // RULE 6: CRITICAL-BAND HISTOGRAM
  // ═══════════════════════════════════════

  function _criticalBandCheck(midi, voiceName) {
    var candidateBark = _midiToBark(midi);
    var count = 0;

    // Count notes in same or adjacent Bark bands from other voices
    var voices = ['bass', 'rhythm', 'soloist', 'lead'];
    for (var i = 0; i < voices.length; i++) {
      if (voices[i] === voiceName) continue;
      var otherMidi = _getVoiceMidi(voices[i]);
      if (otherMidi === null) continue;
      var otherBark = _midiToBark(otherMidi);
      if (Math.abs(candidateBark - otherBark) <= 1) {
        count++;
      }
    }

    // Also check VoiceManager for sustained poly notes
    if (typeof VoiceManager !== 'undefined' && VoiceManager.getActiveNotes) {
      for (var i = 0; i < voices.length; i++) {
        if (voices[i] === voiceName) continue;
        var activeNotes = VoiceManager.getActiveNotes(voices[i]);
        if (activeNotes) {
          for (var j = 0; j < activeNotes.length; j++) {
            // activeNotes are PCs, need to estimate MIDI
            var estMidi = _getVoiceMidi(voices[i]);
            if (estMidi !== null) {
              var noteBark = _midiToBark(estMidi);
              if (Math.abs(candidateBark - noteBark) <= 1) {
                count++;
              }
            }
          }
        }
      }
    }

    if (count >= 3) {
      // Too crowded — try shifting octave
      var upMidi = midi + 12;
      var downMidi = midi - 12;
      var upBark = _midiToBark(upMidi);
      var downBark = _midiToBark(downMidi);

      // Count occupants in shifted positions
      var upCount = 0, downCount = 0;
      for (var i = 0; i < voices.length; i++) {
        if (voices[i] === voiceName) continue;
        var om = _getVoiceMidi(voices[i]);
        if (om === null) continue;
        var ob = _midiToBark(om);
        if (Math.abs(upBark - ob) <= 1) upCount++;
        if (Math.abs(downBark - ob) <= 1) downCount++;
      }

      if (upCount < count && upMidi <= 96) {
        _stats.barkSuppressed++;
        return { midi: upMidi, suppress: false };
      }
      if (downCount < count && downMidi >= 24) {
        _stats.barkSuppressed++;
        return { midi: downMidi, suppress: false };
      }
      // Can't fix — suppress
      _stats.barkSuppressed++;
      return { midi: midi, suppress: true };
    }

    return { midi: midi, suppress: false };
  }

  // ═══════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════

  function _getVoiceMidi(voiceName) {
    if (typeof OctavePlacement !== 'undefined' && OctavePlacement.getLastMidi) {
      var m = OctavePlacement.getLastMidi(voiceName);
      if (m !== null && m !== undefined && m > 0) return m;
    }
    return null;
  }

  function _getHumanMidi() {
    // Try to get human's recent MIDI from OctavePlacement or InputHandler
    if (typeof OctavePlacement !== 'undefined' && OctavePlacement.getLastMidi) {
      var m = OctavePlacement.getLastMidi('human');
      if (m !== null && m !== undefined && m > 0) return m;
    }
    // Fallback: check SharedState for recent human note
    if (typeof SharedState !== 'undefined' && SharedState.lastHumanMidi) {
      return SharedState.lastHumanMidi;
    }
    return null;
  }

  // ═══════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════

  function check(midi, voiceName, context) {
    context = context || {};
    var sectionState = context.sectionState || 'STABLE';
    var result = { midi: midi, velocityMult: 1.0, suppress: false };

    // Rule 1: Low Interval Limit
    var lilResult = _lowIntervalLimit(midi, voiceName);
    if (lilResult.suppress) { result.suppress = true; return result; }
    result.midi = lilResult.midi;

    // Rule 4: Dynamic Hierarchy (velocity scaling)
    result.velocityMult = _dynamicHierarchy(result.midi, voiceName);

    // Rule 5: Density Budget
    if (_densityBudget(voiceName, sectionState)) {
      result.suppress = true;
      return result;
    }

    // Rule 6: Critical-Band Check
    var barkResult = _criticalBandCheck(result.midi, voiceName);
    if (barkResult.suppress) { result.suppress = true; return result; }
    result.midi = barkResult.midi;

    return result;
  }

  function getStats() { return Object.assign({}, _stats); }

  function reset() {
    _stats = { lilShifts: 0, lilSuppressed: 0, hierarchyScaled: 0, densitySuppressed: 0, barkSuppressed: 0 };
    _barkCache = {};
  }

  return {
    check:    check,
    getStats: getStats,
    reset:    reset
  };

})();

console.log('%cOverlapManager loaded (6-rule MIDI-domain safety)', 'color:#f88;font-family:monospace');

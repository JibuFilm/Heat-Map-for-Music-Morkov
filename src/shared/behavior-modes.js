'use strict';
// ═══ BEHAVIOR MODES — RESEARCH/DIAGNOSTIC ONLY ═══
//
// STATUS: Decorative — loaded for console access during arc tests but
// NOT integrated into the assistant pipeline. Mode selection runs but
// no assistant reads the output. From the old centralized orchestrator
// architecture (v1.x); superseded by per-voice belief-driven decisions.
//
// Available via console: BehaviorModes.selectMode(voice), .getHandler(voice)
//
// Original design:
// Replaces the static tier cascade with mode-driven generation.
// Each voice has behavior modes (bassline/pedal/rest, arpeggio/pad, etc.)
// selected probabilistically from the full belief distribution.
//
// Architecture:
//   BeliefState (sensing) → BehaviorModes (policy) → Assistant onTick (execution)
//
// Mode selection happens at phrase boundaries, not every tick.
// Self-contained modes (pedal, pad, rest, laying_out) bypass the tier
// cascade entirely — this breaks lexicon dominance.
//
// Depends on: belief-state.js, phase-coupling.js
// Load order: after belief-state.js, before assistant files

var BehaviorModes = (function() {

  // ═══════════════════════════════════════
  // MODE DEFINITIONS
  // ═══════════════════════════════════════

  var MODES = {
    bass:   ['bassline', 'rhythmic', 'pedal', 'rest'],
    rhythm: ['arpeggio', 'textural', 'comping', 'pad', 'rest'],
    soloist: ['melodic', 'developmental', 'conversational', 'laying_out']
  };

  // ═══════════════════════════════════════
  // MODE WEIGHT MATRIX
  // ═══════════════════════════════════════
  // Each mode's affinity to each belief state.
  // Order: [stability, energy, space, surprise, resolution]
  // Dot product of beliefs × weights → unnormalized mode probability.

  var MODE_WEIGHTS = {
    bass: {
      bassline:  [0.40, 0.30, 0.05, 0.15, 0.30],
      rhythmic:  [0.10, 0.40, 0.05, 0.30, 0.10],
      pedal:     [0.35, 0.05, 0.30, 0.05, 0.40],
      rest:      [0.05, 0.05, 0.50, 0.10, 0.05]
    },
    rhythm: {
      arpeggio:  [0.35, 0.30, 0.05, 0.15, 0.25],
      textural:  [0.10, 0.35, 0.10, 0.35, 0.10],
      comping:   [0.25, 0.35, 0.05, 0.20, 0.15],
      pad:       [0.30, 0.05, 0.25, 0.05, 0.40],
      rest:      [0.05, 0.05, 0.50, 0.10, 0.05]
    },
    soloist: {
      melodic:       [0.30, 0.25, 0.05, 0.15, 0.25],
      developmental: [0.10, 0.35, 0.05, 0.35, 0.10],
      conversational:[0.15, 0.15, 0.15, 0.20, 0.15],
      laying_out:    [0.10, 0.05, 0.50, 0.05, 0.10]
    }
  };

  // ═══════════════════════════════════════
  // PER-VOICE STATE
  // ═══════════════════════════════════════

  var _currentMode = { bass: null, rhythm: null, soloist: null };
  var _modeStartTime = { bass: 0, rhythm: 0, soloist: 0 };

  // Minimum mode duration — use perceptual integration window if available
  function _getMinModeDuration() {
    if (typeof BeliefState !== 'undefined' && BeliefState.PERCEPTUAL) {
      return BeliefState.PERCEPTUAL.INTEGRATION_WINDOW;  // 2500ms
    }
    return 2500;
  }

  // ═══════════════════════════════════════
  // MODE SELECTION (probabilistic)
  // ═══════════════════════════════════════

  function selectMode(role) {
    var now = Date.now();

    // Enforce minimum mode duration — don't switch mid-gesture
    if (_currentMode[role] && now - _modeStartTime[role] < _getMinModeDuration()) {
      return _currentMode[role];
    }

    // Get belief vector
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
    if (!beliefs) beliefs = [0.2, 0.2, 0.2, 0.2, 0.2];  // uniform fallback

    var weights = MODE_WEIGHTS[role];
    if (!weights) return _currentMode[role] || MODES[role][0];

    var modes = MODES[role];

    // Compute unnormalized probabilities via dot product
    var probs = [];
    var total = 0;
    for (var mi = 0; mi < modes.length; mi++) {
      var w = weights[modes[mi]];
      var dot = 0;
      for (var bi = 0; bi < 5; bi++) {
        dot += beliefs[bi] * w[bi];
      }

      // Energy modulation: low energy boosts rest/pedal/pad/laying_out
      if (typeof BeliefState !== 'undefined') {
        var params = BeliefState.getParams(role);
        if (params) {
          var energy = params.energy;
          var modeName = modes[mi];
          if (modeName === 'rest' || modeName === 'pedal' ||
              modeName === 'pad' || modeName === 'laying_out') {
            // Low energy (0→1 maps to 2.0→1.0 boost)
            dot *= 2.0 - energy;
          }
        }
      }

      dot = Math.max(0.01, dot);  // floor to prevent zero probability
      probs.push(dot);
      total += dot;
    }

    // Normalize and sample
    var roll = Math.random() * total;
    var cumulative = 0;
    var selected = modes[0];
    for (var si = 0; si < modes.length; si++) {
      cumulative += probs[si];
      if (roll <= cumulative) {
        selected = modes[si];
        break;
      }
    }

    // Track mode change
    var oldMode = _currentMode[role];
    if (selected !== oldMode) {
      _previousMode[role] = oldMode;
      _currentMode[role] = selected;
      _modeStartTime[role] = now;

      // Emit mode change event
      try {
        if (typeof EventBus !== 'undefined') {
          EventBus.emit('behaviorModeChange', { voice: role, from: oldMode, to: selected });
        }
      } catch (e) {}
    }

    return selected;
  }

  // ═══════════════════════════════════════
  // SELF-CONTAINED MODE HANDLERS
  // ═══════════════════════════════════════
  // These bypass the tier cascade entirely.

  function _pedalHandler(role) {
    // Sustain root or fifth of current key/chord
    var key = 0;
    if (typeof SharedState !== 'undefined') {
      key = SharedState.keyC || 0;
    }

    var pc = key;
    if (Math.random() < 0.3) {
      pc = (key + 7) % 12;  // sometimes fifth
    }

    // Scale snap
    if (typeof AssistantShared !== 'undefined') {
      pc = AssistantShared.scaleSnap(pc);
    }

    return { pc: pc, source: 'pedal', confidence: 0.9 };
  }

  function _padHandler(role) {
    // Similar to pedal but for rhythm — pick a chord tone
    var key = 0;
    if (typeof SharedState !== 'undefined') {
      key = SharedState.keyC || 0;
    }

    // Pick root, third, or fifth
    var intervals = [0, 4, 7];
    var pc = (key + intervals[Math.floor(Math.random() * intervals.length)]) % 12;

    if (typeof AssistantShared !== 'undefined') {
      pc = AssistantShared.scaleSnap(pc);
    }

    return { pc: pc, source: 'pad', confidence: 0.85 };
  }

  function _restHandler(role) {
    // Silence — trigger energy recovery
    if (typeof BeliefState !== 'undefined') {
      BeliefState.updateEnergy(role, 16, false);
    }
    return null;
  }

  // Map of self-contained handlers per mode
  var HANDLERS = {
    pedal:      _pedalHandler,
    pad:        _padHandler,
    rest:       _restHandler,
    laying_out: _restHandler  // same as rest but selected by different weights
  };

  // ═══════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════

  function getCurrentMode(role) {
    return _currentMode[role] || MODES[role][0];
  }

  function getHandler(role, mode) {
    // Returns handler function for self-contained modes, null for cascade modes
    return HANDLERS[mode] || null;
  }

  function isCascadeMode(mode) {
    return !HANDLERS[mode];
  }

  // Track previous mode per voice for transition smoothing
  var _previousMode = { bass: null, rhythm: null, soloist: null };

  // Was this voice just resting? (for transition smoothing — first phrase after
  // rest/laying_out/pad should be shorter to ease back in)
  function wasResting(role) {
    var prev = _previousMode[role];
    return prev === 'rest' || prev === 'laying_out' || prev === 'pad' || prev === 'pedal';
  }

  function reset() {
    _currentMode = { bass: null, rhythm: null, soloist: null };
    _modeStartTime = { bass: 0, rhythm: 0, soloist: 0 };
    _previousMode = { bass: null, rhythm: null, soloist: null };
  }

  return {
    selectMode:     selectMode,
    getCurrentMode: getCurrentMode,
    getHandler:     getHandler,
    isCascadeMode:  isCascadeMode,
    wasResting:     wasResting,
    MODES:          MODES,
    reset:          reset
  };

})();

console.log('%cBehaviorModes loaded (POMDP policy layer)', 'color:#f6a;font-family:monospace');

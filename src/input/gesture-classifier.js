// ═══════════════════════════════════════════════════════════════
// GestureClassifier — Player Gesture Recognition (v9.1.0)
// ═══════════════════════════════════════════════════════════════
// Classifies what the human player is TRYING to say from their
// MIDI note stream. The ensemble responds through existing channels
// (DialogueEngine stance, gate pipeline) — not by being told what
// to do.
//
// Gesture types:
//   ascending_run    — building excitement, ensemble responds with energy
//   descending_run   — releasing tension, ensemble supports
//   sustained_note   — contemplation, ensemble creates space
//   repeated_pattern — groove invitation, ensemble locks in
//   chord_stab       — harmonic assertion, ensemble supports harmony
//   silence          — yielding/anticipation, ensemble takes initiative
//   exploratory      — searching, ensemble responds freely
//   steady_pulse     — timekeeper, ensemble stabilizes
//
// Each gesture has an influence vector { energy, initiative, space }
// that maps to existing belief/dialogue channels. No new control
// pathway — gestures are SIGNALS, not instructions.
//
// Psychoacoustic basis:
//   Keller 2014 — Joint action in music: anticipation through gesture
//     recognition. Temporal, pitch-directional, and density cues.
//   Novembre & Keller 2014 — Anticipatory planning in ensemble music
//     requires internal models of partners' intended actions.
//   Godoy 2006 — Musical gestures are multimodal units of meaning.
//     Classification into types (impulsive, sustained, iterative) is
//     a natural perceptual process.
//   Leman 2008 — Embodied music cognition: listeners parse music into
//     gestural chunks that carry intention.
//   Pecenka & Keller 2011 — Temporal prediction in joint action via
//     period and phase coupling, enhanced by gesture recognition.
//   Ragert et al. 2013 — Adaptive temporal prediction modulated by
//     perceived intention behind gestures.
//
// Depends on: event-bus.js (EventBus.emit)
// Load order: after input-handler.js, before bar-tracker.js
// ═══════════════════════════════════════════════════════════════

'use strict';

var GestureClassifier = (function() {

  // ═══════════════════════════════════════
  // GESTURE TYPES + INFLUENCE VECTORS
  // ═══════════════════════════════════════
  // energy:     how much energy the gesture implies (→ needs_energy observation)
  // initiative: how much the player is taking the lead (→ DialogueEngine initiative)
  // space:      how much space the player is leaving (→ needs_space / gate boost)

  var GESTURE_TYPES = {
    ascending_run:    { energy: 0.85, initiative: 0.7,  space: 0.3 },
    descending_run:   { energy: 0.50, initiative: 0.5,  space: 0.4 },
    sustained_note:   { energy: 0.20, initiative: 0.3,  space: 0.9 },
    repeated_pattern: { energy: 0.60, initiative: 0.4,  space: 0.2 },
    chord_stab:       { energy: 0.70, initiative: 0.6,  space: 0.4 },
    silence:          { energy: 0.10, initiative: 0.1,  space: 1.0 },
    exploratory:      { energy: 0.50, initiative: 0.6,  space: 0.5 },
    steady_pulse:     { energy: 0.40, initiative: 0.3,  space: 0.3 }
  };

  // ═══════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════

  var WINDOW_MS = 3000;              // 3-second sliding window
  var MIN_NOTES_FOR_RUN = 4;         // minimum notes for run detection
  var SILENCE_THRESHOLD_MS = 2000;   // 2s silence = silence gesture
  var CLASSIFY_INTERVAL_MS = 500;    // classify every 500ms (not every note)

  // ═══════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════

  var _noteBuffer = [];    // { pc, midi, time, velocity }
  var _currentGesture = { type: 'silence', confidence: 0.5, since: 0 };
  var _lastClassifyTime = 0;
  var _lastNoteTime = 0;

  // ═══════════════════════════════════════
  // NOTE OBSERVATION
  // ═══════════════════════════════════════

  // Called from app.js onNoteInput (after EventBus.emit('humanNote'))
  function onHumanNote(pc, midi, velocity) {
    var now = Date.now();
    _noteBuffer.push({
      pc: pc,
      midi: midi || (pc + 60),
      time: now,
      velocity: (typeof velocity === 'number') ? velocity : 0.5
    });
    _lastNoteTime = now;

    // Prune old notes
    while (_noteBuffer.length > 0 && now - _noteBuffer[0].time > WINDOW_MS) {
      _noteBuffer.shift();
    }
  }

  // ═══════════════════════════════════════
  // CLASSIFICATION
  // ═══════════════════════════════════════

  function _classify() {
    var now = Date.now();
    var silenceMs = _lastNoteTime > 0 ? now - _lastNoteTime : Infinity;

    // ── Silence detection (Keller 2014: silence = yielding/anticipation) ──
    if (_lastNoteTime > 0 && silenceMs > SILENCE_THRESHOLD_MS) {
      _setGesture('silence', Math.min(1.0, silenceMs / 4000));
      return;
    }

    var notes = _noteBuffer;
    if (notes.length < 2) {
      // Single note or empty — sustained if last note was recent
      if (notes.length === 1 && silenceMs < 1500) {
        _setGesture('sustained_note', 0.6);
      }
      return;
    }

    // ── Feature extraction ──
    var intervals = [];       // signed MIDI intervals
    var ioiMs = [];           // inter-onset intervals in ms
    var pcCounts = {};        // pitch class histogram

    for (var i = 0; i < notes.length; i++) {
      pcCounts[notes[i].pc] = (pcCounts[notes[i].pc] || 0) + 1;
      if (i > 0) {
        intervals.push(notes[i].midi - notes[i - 1].midi);
        ioiMs.push(notes[i].time - notes[i - 1].time);
      }
    }

    var uniquePCs = 0;
    for (var k in pcCounts) {
      if (pcCounts.hasOwnProperty(k)) uniquePCs++;
    }

    var avgIOI = _mean(ioiMs);
    var ioiCV = _cv(ioiMs);                    // coefficient of variation
    var netDirection = notes[notes.length - 1].midi - notes[0].midi;
    var directionality = Math.abs(netDirection) / Math.max(1, notes.length);

    // ── Run detection: ascending/descending (Frieler 2019) ──
    // Runs are consecutive same-direction steps with fast IOI
    if (notes.length >= MIN_NOTES_FOR_RUN && avgIOI < 350) {
      var sameDir = 0;
      for (var j = 0; j < intervals.length; j++) {
        if (netDirection > 0 && intervals[j] > 0) sameDir++;
        else if (netDirection < 0 && intervals[j] < 0) sameDir++;
      }
      var dirRatio = sameDir / intervals.length;
      if (dirRatio > 0.7 && directionality > 1.0) {
        if (netDirection > 0) {
          _setGesture('ascending_run', dirRatio);
        } else {
          _setGesture('descending_run', dirRatio);
        }
        return;
      }
    }

    // ── Repeated pattern detection ──
    // Low PC diversity + regular IOI = groove/ostinato (Margulis 2014)
    if (uniquePCs <= 3 && ioiCV < 0.3 && notes.length >= 4) {
      _setGesture('repeated_pattern', 1.0 - ioiCV);
      return;
    }

    // ── Chord stab detection ──
    // Multiple near-simultaneous notes (IOI < 80ms) + 3+ unique PCs
    var simultaneousCount = 0;
    for (var m = 0; m < ioiMs.length; m++) {
      if (ioiMs[m] < 80) simultaneousCount++;
    }
    if (simultaneousCount >= 2 && uniquePCs >= 3) {
      _setGesture('chord_stab', 0.7 + 0.1 * Math.min(3, simultaneousCount));
      return;
    }

    // ── Steady pulse ──
    // Regular IOI, moderate speed (Keller 2014: periodic signal = entrainment)
    if (ioiCV < 0.25 && avgIOI > 200 && avgIOI < 600) {
      _setGesture('steady_pulse', 1.0 - ioiCV);
      return;
    }

    // ── Sustained note ──
    if (notes.length <= 2 && silenceMs > 800 && silenceMs < SILENCE_THRESHOLD_MS) {
      _setGesture('sustained_note', 0.5 + 0.3 * (silenceMs / SILENCE_THRESHOLD_MS));
      return;
    }

    // ── Exploratory (default: varied, non-pattern input) ──
    _setGesture('exploratory', 0.4 + 0.2 * Math.min(1, uniquePCs / 6));
  }

  // ═══════════════════════════════════════
  // GESTURE STATE MANAGEMENT
  // ═══════════════════════════════════════

  function _setGesture(type, confidence) {
    if (_currentGesture.type !== type) {
      _currentGesture.type = type;
      _currentGesture.since = Date.now();
      // Emit on TYPE CHANGE only (not every classify tick)
      if (typeof EventBus !== 'undefined') {
        EventBus.emit('humanGesture', {
          type: type,
          confidence: confidence,
          influence: GESTURE_TYPES[type] || GESTURE_TYPES.exploratory
        });
      }
    }
    _currentGesture.confidence = confidence;
  }

  // ═══════════════════════════════════════
  // TICK (rate-limited classification)
  // ═══════════════════════════════════════

  function tick(dt) {
    var now = Date.now();
    if (now - _lastClassifyTime < CLASSIFY_INTERVAL_MS) return;
    _lastClassifyTime = now;
    _classify();
  }

  // ═══════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════

  function getGesture() {
    return {
      type: _currentGesture.type,
      confidence: _currentGesture.confidence,
      influence: GESTURE_TYPES[_currentGesture.type] || GESTURE_TYPES.exploratory,
      durationMs: Date.now() - _currentGesture.since
    };
  }

  function reset() {
    _noteBuffer = [];
    _currentGesture = { type: 'silence', confidence: 0.5, since: 0 };
    _lastNoteTime = 0;
    _lastClassifyTime = 0;
  }

  // ═══════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════

  function _mean(arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function _cv(arr) {
    if (arr.length < 2) return 0;
    var m = _mean(arr);
    if (m === 0) return 0;
    var v = 0;
    for (var i = 0; i < arr.length; i++) v += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(v / arr.length) / m;
  }

  return {
    onHumanNote: onHumanNote,
    tick:        tick,
    getGesture:  getGesture,
    reset:       reset
  };

})();

console.log('%cGestureClassifier loaded (Keller 2014 joint action)', 'color:#9cf;font-family:monospace');

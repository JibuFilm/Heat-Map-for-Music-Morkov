'use strict';
// ═══ AUTO-EVALUATOR — Simulated MIDI input for prediction stress-testing ═══
//
// Feeds the system varied MIDI patterns so the developer can hear what the
// prediction algorithm does with rich, diverse input — instead of being
// limited by their own repetitive playing style.
//
// Injection point: window.onNoteInput(pc, midi, register, velocityMult)
// This is the same entry point that keyboard and hardware MIDI use.
// noteOff handled via SoundEngine.noteOff('human', noteId).
//
// Patterns are defined in scale degrees relative to current key, then
// transposed at playback time so they always fit the active key/scale.

var AutoEvaluator = (function() {

  // ── State ──
  var _running = false;
  var _currentPattern = null;
  var _currentPatternName = '';
  var _suiteMode = false;
  var _suiteIndex = 0;
  var _noteTimer = null;
  var _suiteGapTimer = null;
  var _heldNoteIds = [];    // [{noteId, midi}] for pending noteOffs
  var _noteOffTimers = [];  // setTimeout IDs for scheduled noteOffs
  var _statusEl = null;     // UI element for status display
  var _onStatusChange = null;
  var _prevOwnershipPolicy = null;  // saved policy to restore on stop

  // ── Helpers ──

  // Get current beat duration in ms from TempoEngine or BPM input
  function _beatMs() {
    if (typeof TempoEngine !== 'undefined') {
      var bpm = TempoEngine.getEffectiveBPM();
      if (bpm > 0) return 60000 / bpm;
    }
    // v9.2.0: bpmInput removed — use bpmSlider as fallback
    var bpmEl = document.getElementById('bpmSlider');
    if (bpmEl) return 60000 / (+bpmEl.value || 120);
    return 500; // fallback 120 BPM
  }

  // Get current key (pitch class 0-11) from SharedState
  function _key() {
    if (typeof SharedState !== 'undefined') return SharedState.keyC || 0;
    return 0;
  }

  // Get current scale intervals from SharedState
  function _scaleIntervals() {
    if (typeof SharedState !== 'undefined') {
      var m = SharedState.mode || 'minor';
      return SCALES[m] || SCALES.minor;
    }
    return SCALES.minor;
  }

  // Convert a scale degree (0-based index into the scale) + octave offset
  // to an absolute MIDI note number, transposed to the current key.
  // sd: 0 = root, 1 = 2nd, 2 = 3rd, etc. Can be negative or > scale length.
  // octave: octave number (4 = middle C region)
  function _sdToMidi(sd, octave) {
    var intervals = _scaleIntervals();
    var len = intervals.length;
    // Handle scale degrees beyond one octave
    var octShift = Math.floor(sd / len);
    var degInScale = ((sd % len) + len) % len;
    var semitone = intervals[degInScale] + octShift * 12;
    return _key() + semitone + (octave || 4) * 12;
  }

  // Convert an absolute semitone offset from key root to MIDI
  function _semiToMidi(semi, octave) {
    return _key() + semi + (octave || 4) * 12;
  }

  // Inject a note into the system via the same path as real MIDI
  function _injectNote(midi, velocity, durationBeats) {
    if (!_running) return;
    var pc = ((midi % 12) + 12) % 12;
    var register = midi < 48 ? 'bass' : midi < 72 ? 'rhythm' : 'soloist';
    var velMult = (velocity || 100) / 127;

    if (typeof window.onNoteInput === 'function') {
      var noteId = window.onNoteInput(pc, midi, register, velMult);

      // Schedule noteOff
      var durMs = (durationBeats || 0.8) * _beatMs();
      var offTimer = setTimeout(function() {
        if (noteId !== undefined && noteId !== null) {
          try { SoundEngine.noteOff('human', noteId); } catch(e) {}
        }
        // Remove from held list
        _heldNoteIds = _heldNoteIds.filter(function(h) { return h.noteId !== noteId; });
      }, durMs);
      _noteOffTimers.push(offTimer);
      if (noteId !== undefined && noteId !== null) {
        _heldNoteIds.push({ noteId: noteId, midi: midi });
      }
    }
  }

  // Kill all held notes immediately
  function _killAllNotes() {
    for (var i = 0; i < _heldNoteIds.length; i++) {
      try { SoundEngine.noteOff('human', _heldNoteIds[i].noteId); } catch(e) {}
    }
    _heldNoteIds = [];
    for (var j = 0; j < _noteOffTimers.length; j++) {
      clearTimeout(_noteOffTimers[j]);
    }
    _noteOffTimers = [];
  }

  // Update status display
  function _setStatus(text) {
    if (_statusEl) _statusEl.textContent = text;
    if (_onStatusChange) _onStatusChange(text, _running);
  }

  // ═══ PATTERN DEFINITIONS ═══
  // Each pattern is a function that returns an array of note events:
  // [{sd, octave, velocity, durationBeats, delayBeats}]
  // - sd: scale degree (0-based) OR use 'semi' for chromatic semitone offset
  // - octave: MIDI octave (3=bass, 4=rhythm, 5=soloist)
  // - velocity: 0-127
  // - durationBeats: how long the note sounds
  // - delayBeats: time before THIS note (from previous note)

  var PATTERNS = {};

  // 1. Ascending scale — C minor scale up 2 octaves, steady tempo
  PATTERNS['ascending-scale'] = function() {
    var notes = [];
    for (var oct = 0; oct < 2; oct++) {
      for (var sd = 0; sd < 7; sd++) {
        notes.push({ sd: sd + oct * 7, octave: 4, velocity: 90, durationBeats: 0.8, delayBeats: 0.5 });
      }
    }
    // Descend back
    for (var oct2 = 1; oct2 >= 0; oct2--) {
      for (var sd2 = 6; sd2 >= 0; sd2--) {
        notes.push({ sd: sd2 + oct2 * 7, octave: 4, velocity: 85, durationBeats: 0.8, delayBeats: 0.5 });
      }
    }
    return notes;
  };

  // 2. Arpeggiated chords — i, iv, V, VI progression, broken chords
  PATTERNS['arpeggiated-chords'] = function() {
    var notes = [];
    // Scale degrees for chord tones: i=[0,2,4], iv=[3,5,0+7], V=[4,6,1+7], VI=[5,0+7,2+7]
    var chords = [
      [0, 2, 4],       // i   (root, 3rd, 5th in scale degrees)
      [3, 5, 7],       // iv
      [4, 6, 8],       // V
      [5, 7, 9]        // VI
    ];
    // Play each chord as arpeggio twice (up then down)
    for (var c = 0; c < chords.length; c++) {
      var ch = chords[c];
      // Up
      for (var n = 0; n < ch.length; n++) {
        notes.push({ sd: ch[n], octave: 4, velocity: 95, durationBeats: 0.9, delayBeats: 0.33 });
      }
      // Down
      for (var n2 = ch.length - 2; n2 >= 0; n2--) {
        notes.push({ sd: ch[n2], octave: 4, velocity: 85, durationBeats: 0.9, delayBeats: 0.33 });
      }
      // Repeat with octave variation
      for (var n3 = 0; n3 < ch.length; n3++) {
        notes.push({ sd: ch[n3], octave: 3, velocity: 80, durationBeats: 0.9, delayBeats: 0.33 });
      }
      for (var n4 = ch.length - 2; n4 >= 0; n4--) {
        notes.push({ sd: ch[n4], octave: 4, velocity: 90, durationBeats: 0.9, delayBeats: 0.33 });
      }
    }
    return notes;
  };

  // 3. Chromatic run — chromatic ascent/descent (semitone-based, not scale degrees)
  PATTERNS['chromatic-run'] = function() {
    var notes = [];
    // Ascend chromatically 1.5 octaves
    for (var s = 0; s < 18; s++) {
      notes.push({ semi: s, octave: 4, velocity: 80 + Math.floor(s * 1.5), durationBeats: 0.6, delayBeats: 0.25 });
    }
    // Descend
    for (var s2 = 17; s2 >= 0; s2--) {
      notes.push({ semi: s2, octave: 4, velocity: 80 + Math.floor(s2 * 1.5), durationBeats: 0.6, delayBeats: 0.25 });
    }
    return notes;
  };

  // 4. Jazz-like leaps — large intervals, unpredictable direction
  PATTERNS['jazz-leaps'] = function() {
    var notes = [];
    // Sequence of large interval jumps (in scale degrees)
    var jumps = [0, 5, 2, 9, 4, 11, 1, 8, 3, 10, 6, 13, 0, 7, -2, 5, 12, 3, 9, 1, 6, -1, 4, 10];
    for (var i = 0; i < jumps.length; i++) {
      var sd = jumps[i];
      var oct = sd < 0 ? 3 : (sd > 7 ? 5 : 4);
      var vel = 75 + Math.floor(Math.random() * 40);
      notes.push({ sd: sd, octave: oct, velocity: vel, durationBeats: 0.7, delayBeats: 0.5 + Math.random() * 0.3 });
    }
    return notes;
  };

  // 5. Repetitive ostinato — simple 4-note repeating pattern
  PATTERNS['ostinato'] = function() {
    var notes = [];
    // Simple 4-note pattern repeated many times
    var pattern = [0, 2, 4, 2]; // root, 3rd, 5th, 3rd
    for (var rep = 0; rep < 8; rep++) {
      for (var n = 0; n < pattern.length; n++) {
        var vel = (n === 0) ? 100 : 80; // accent first note
        notes.push({ sd: pattern[n], octave: 4, velocity: vel, durationBeats: 0.7, delayBeats: 0.5 });
      }
    }
    return notes;
  };

  // 6. Call and response — play 4 notes, wait, play 4 notes
  PATTERNS['call-response'] = function() {
    var notes = [];
    var phrases = [
      [0, 2, 4, 7],      // call 1: scale fragment
      [7, 5, 4, 2],      // response 1: descending answer
      [0, 4, 7, 9],      // call 2: wider leap
      [9, 7, 4, 0],      // response 2: mirror
      [2, 5, 7, 9],      // call 3: starting on 2nd
      [9, 5, 4, 0],      // response 3: different contour
    ];
    for (var p = 0; p < phrases.length; p++) {
      for (var n = 0; n < phrases[p].length; n++) {
        notes.push({
          sd: phrases[p][n], octave: 4,
          velocity: (n === 0) ? 100 : 85,
          durationBeats: 0.6,
          delayBeats: (n === 0 && p > 0) ? 2.0 : 0.4  // 2-beat gap between phrases
        });
      }
    }
    return notes;
  };

  // 7. Fast passages — 16th note runs
  PATTERNS['fast-passages'] = function() {
    var notes = [];
    // Scale runs at 16th note speed
    for (var run = 0; run < 3; run++) {
      var startSd = run * 3;
      // Ascending run
      for (var s = 0; s < 8; s++) {
        notes.push({
          sd: startSd + s, octave: 4,
          velocity: 70 + Math.floor(Math.random() * 20),
          durationBeats: 0.3,
          delayBeats: 0.125 // 16th notes at current tempo
        });
      }
      // Brief pause
      notes.push({ sd: startSd + 7, octave: 4, velocity: 95, durationBeats: 1.0, delayBeats: 0.5 });
      // Descending run
      for (var s2 = 7; s2 >= 0; s2--) {
        notes.push({
          sd: startSd + s2, octave: 4,
          velocity: 70 + Math.floor(Math.random() * 20),
          durationBeats: 0.3,
          delayBeats: 0.125
        });
      }
      // Pause between runs
      notes.push({ sd: startSd, octave: 4, velocity: 90, durationBeats: 1.5, delayBeats: 1.0 });
    }
    return notes;
  };

  // 8. Sparse/ambient — long held notes with large gaps
  PATTERNS['sparse-ambient'] = function() {
    var notes = [];
    var tones = [0, 4, 7, 0, 3, 7, 2, 5, 0, 7]; // gentle scale-tone sequence
    for (var i = 0; i < tones.length; i++) {
      var oct = (i % 3 === 0) ? 3 : 4;
      notes.push({
        sd: tones[i], octave: oct,
        velocity: 50 + Math.floor(Math.random() * 30),
        durationBeats: 3.0 + Math.random() * 2.0,
        delayBeats: (i === 0) ? 0.5 : 2.0 + Math.random() * 2.0
      });
    }
    return notes;
  };

  // 9. Sequencer bass — steady 8th-note bass pattern in low register
  // Simulates a Berlin School sequencer line (TD/KW style).
  // Tests: bass-kick lock, percussion stability, belief state with live input.
  PATTERNS['sequencer-bass'] = function() {
    var notes = [];
    // 8-bar steady bass sequence: root-5th-octave-5th repeating in 8ths
    var seq = [0, 4, 7, 4, 0, 4, 7, 4];
    for (var bar = 0; bar < 8; bar++) {
      for (var n = 0; n < seq.length; n++) {
        notes.push({
          sd: seq[n], octave: 3,  // bass register
          velocity: (n === 0) ? 95 : 75,  // accent downbeat
          durationBeats: 0.4,
          delayBeats: 0.5  // 8th notes
        });
      }
    }
    return notes;
  };

  // 10. Pad chords — slow chord changes in rhythm register
  // Simulates a sustained pad player (Jarre/ambient style).
  // Tests: rhythm-voice interaction with percussion, section evolution.
  PATTERNS['pad-chords'] = function() {
    var notes = [];
    // i → iv → v → i progression, 2 bars each, multiple voices per chord
    var chords = [
      { tones: [0, 2, 4], bars: 2 },
      { tones: [3, 5, 0], bars: 2 },
      { tones: [4, 6, 1], bars: 2 },
      { tones: [0, 2, 4], bars: 2 }
    ];
    for (var c = 0; c < chords.length; c++) {
      var ch = chords[c];
      // Play chord tones staggered slightly (like a human)
      for (var t = 0; t < ch.tones.length; t++) {
        notes.push({
          sd: ch.tones[t], octave: 4,
          velocity: 65 + t * 5,
          durationBeats: ch.bars * 4 - 0.5,  // nearly full duration
          delayBeats: (t === 0 && c === 0) ? 0.5 : (t === 0 ? ch.bars * 4 : 0.15)
        });
      }
    }
    return notes;
  };

  // 11. Gentle melody — simple stepwise melody in soloist register
  // Tests: solo-percussion interaction, motif capture, fill response.
  PATTERNS['gentle-melody'] = function() {
    var notes = [];
    // 4-bar phrases with gaps, stepwise motion, moderate tempo
    var phrases = [
      [0, 1, 2, 4, 2, 1, 0],     // arch shape
      [4, 5, 6, 7, 6, 4],         // higher arch
      [7, 6, 4, 2, 0],            // descending
      [0, 2, 4, 7, 9, 7, 4, 2, 0] // wide arch
    ];
    for (var p = 0; p < phrases.length; p++) {
      for (var n = 0; n < phrases[p].length; n++) {
        notes.push({
          sd: phrases[p][n], octave: 5,  // soloist register
          velocity: 70 + Math.floor(Math.random() * 20),
          durationBeats: 0.8 + Math.random() * 0.4,
          delayBeats: (n === 0 && p > 0) ? 3.0 : 0.75  // 3-beat gap between phrases
        });
      }
    }
    return notes;
  };

  // Pattern execution order for suite mode
  var PATTERN_ORDER = [
    'ascending-scale',
    'arpeggiated-chords',
    'chromatic-run',
    'jazz-leaps',
    'ostinato',
    'call-response',
    'fast-passages',
    'sparse-ambient',
    'sequencer-bass',
    'pad-chords',
    'gentle-melody'
  ];

  // ═══ PLAYBACK ENGINE ═══

  function _playPattern(name, onComplete) {
    if (!PATTERNS[name]) {
      console.warn('AutoEvaluator: unknown pattern "' + name + '"');
      return;
    }

    _currentPatternName = name;
    _setStatus('EVAL: ' + name);

    // Generate note sequence (some patterns use random, so generate fresh each time)
    var noteSeq = PATTERNS[name]();
    var idx = 0;

    function scheduleNext() {
      if (!_running || idx >= noteSeq.length) {
        _setStatus(_suiteMode ? 'EVAL: gap...' : 'EVAL: done');
        if (onComplete) onComplete();
        return;
      }

      var note = noteSeq[idx];
      var delayMs = (note.delayBeats || 0.5) * _beatMs();
      idx++;

      _noteTimer = setTimeout(function() {
        if (!_running) return;

        // Compute MIDI note number
        var midi;
        if (note.semi !== undefined) {
          midi = _semiToMidi(note.semi, note.octave);
        } else {
          midi = _sdToMidi(note.sd, note.octave);
        }

        // Clamp to playable range
        midi = Math.max(36, Math.min(96, midi));

        _injectNote(midi, note.velocity, note.durationBeats);
        scheduleNext();
      }, delayMs);
    }

    scheduleNext();
  }

  // ═══ PUBLIC API ═══

  function init(deps) {
    // deps is optional — we use globals (SharedState, TempoEngine, SoundEngine, etc.)
    // since the project uses the IIFE/global pattern, not ES module imports.
    if (deps && deps.onStatusChange) {
      _onStatusChange = deps.onStatusChange;
    }
    console.log('AutoEvaluator: initialized (' + PATTERN_ORDER.length + ' patterns)');
  }

  function _enterEvalPolicy() {
    // Switch to accompany policy so eval notes don't claim ownership
    // (otherwise eval notes block the assistants from playing that register)
    if (typeof OwnershipDetector !== 'undefined') {
      _prevOwnershipPolicy = OwnershipDetector.getPolicy();
      OwnershipDetector.setPolicy('accompany');
    }
  }

  function _restorePolicy() {
    if (typeof OwnershipDetector !== 'undefined' && _prevOwnershipPolicy) {
      OwnershipDetector.setPolicy(_prevOwnershipPolicy);
      _prevOwnershipPolicy = null;
    }
  }

  function startPattern(name) {
    if (_running) stop();
    _enterEvalPolicy();
    _running = true;
    _suiteMode = false;
    _playPattern(name, function() {
      _running = false;
      _setStatus('');
    });
  }

  function startSuite() {
    if (_running) stop();
    _enterEvalPolicy();
    _running = true;
    _suiteMode = true;
    _suiteIndex = 0;

    function playNext() {
      if (!_running || _suiteIndex >= PATTERN_ORDER.length) {
        _running = false;
        _suiteMode = false;
        _setStatus('EVAL: complete');
        setTimeout(function() { _setStatus(''); }, 2000);
        return;
      }

      var patName = PATTERN_ORDER[_suiteIndex];
      _suiteIndex++;

      _playPattern(patName, function() {
        if (!_running) return;
        // 2-bar gap between patterns
        var gapMs = _beatMs() * 8; // 2 bars in 4/4
        _setStatus('EVAL: gap (' + _suiteIndex + '/' + PATTERN_ORDER.length + ')');
        _suiteGapTimer = setTimeout(playNext, gapMs);
      });
    }

    playNext();
  }

  function stop() {
    _running = false;
    _suiteMode = false;
    if (_noteTimer) { clearTimeout(_noteTimer); _noteTimer = null; }
    if (_suiteGapTimer) { clearTimeout(_suiteGapTimer); _suiteGapTimer = null; }
    _killAllNotes();
    _restorePolicy();
    _setStatus('');
  }

  function isRunning() {
    return _running;
  }

  function getPatterns() {
    return PATTERN_ORDER.slice();
  }

  function getCurrentPattern() {
    return _currentPatternName;
  }

  // Allow external UI to set the status element
  function setStatusElement(el) {
    _statusEl = el;
  }

  return {
    init: init,
    startPattern: startPattern,
    startSuite: startSuite,
    stop: stop,
    isRunning: isRunning,
    getPatterns: getPatterns,
    getCurrentPattern: getCurrentPattern,
    setStatusElement: setStatusElement
  };
})();

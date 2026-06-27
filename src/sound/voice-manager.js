'use strict';
// ═══ VOICE MANAGER (Phase 7) ═══
//
// Polyphony policy layer between the pipeline and SoundEngine.
// SoundEngine produces sound. VoiceManager decides WHEN notes release.
//
// Three modes:
//   mono   — one note at a time. New note kills previous instantly.
//   poly   — multiple notes ring. Oldest stolen when at maxPoly.
//   legato — like poly but brief overlap for smooth transitions.
//
// Phase 7 Step 4: Scope-gated onset snap.
//   Tracks per-voice onset times in ctx.currentTime seconds. When a note
//   from any voice lands in the uncanny zone (FUSION..SEPARATION ms) relative
//   to another voice's recent onset, delays the audio onset to the separation
//   boundary using SoundEngine's scheduleAheadSec parameter.
//
//   For Scheduler-driven notes arriving in the same tick, the gap is 0 (fusion
//   zone) — no snap needed. For scope-gated notes from different 5ms ticks,
//   the gap could be 5-30ms — snap pushes to 35ms separation.
//
// Public API:
//   onNote(midi, volMult, voiceName)  — called from playVoiceNote, returns noteId
//   tick(dt)                          — call from highResTick, checks auto-release
//   getActiveNotes(voiceName)         — returns array of PCs currently sounding
//   getActivePoly(voiceName)          — returns count of active notes
//   getActiveNotesDetailed(voiceName) — returns [{noteId, midi, pc, startTime}]
//   setConfig(voiceName, config)      — override config at runtime
//   reset()                           — release everything
//
// Load order: after sound-engine, before final-coordinator.

var VoiceManager = (function() {

  // ── Per-voice configuration ──
  // sustainBeats: null means no auto-release (mono releases on next noteOn)
  var CONFIG = {
    bass:   { mode: 'mono',   maxPoly: 1, sustainBeats: 4.0 },
    rhythm: { mode: 'poly',   maxPoly: 4, sustainBeats: 2.0 },
    soloist: { mode: 'legato', maxPoly: 2, sustainBeats: 1.5 },
    lead:   { mode: 'legato', maxPoly: 2, sustainBeats: 2.5 }
  };

  // ── Active note tracking ──
  // Keyed by voiceName. Each entry is an array of:
  //   { noteId, midi, pc, startTime (Date.now), sustainUntil (Date.now ms), released }
  var active = { bass: [], rhythm: [], soloist: [], lead: [] };

  // ── Onset tracking for scope-gated snap (Phase 7 Step 4) ──
  // Records ctx.currentTime (seconds) and Date.now (ms) of each voice's last noteOn.
  // Used to detect uncanny-zone gaps between voices.
  var lastOnset = { bass: null, rhythm: null, soloist: null, lead: null };

  function getConfig(voiceName) {
    return CONFIG[voiceName] || CONFIG.bass;
  }

  function getActive(voiceName) {
    if (!active[voiceName]) active[voiceName] = [];
    return active[voiceName];
  }


  // ── Beat-to-ms conversion ──
  function beatMs() {
    var bpm = (typeof TempoEngine !== 'undefined') ? TempoEngine.getEffectiveBPM() : 120;
    return 60000 / Math.max(30, bpm);
  }


  // ── Onset snap (Phase 7 Step 4) ──
  //
  // Check other voices' recent onsets. If the gap between "now" and any other
  // voice's last onset is in the uncanny zone, compute a schedule-ahead offset
  // to push this note to the separation boundary.
  //
  // Returns: scheduleAheadSec (float, >= 0). 0 means fire now.
  //
  // Uses perceptual threshold constants from constants.js.
  // Falls back to hardcoded defaults if constants not loaded.
  function computeOnsetSnap(voiceName) {
    var fusionMs = (typeof NOTE_FUSION_THRESHOLD_MS !== 'undefined') ? NOTE_FUSION_THRESHOLD_MS : 5;
    var sepMs = (typeof NOTE_SEPARATION_MIN_MS !== 'undefined') ? NOTE_SEPARATION_MIN_MS : 35;

    // Get audio context current time
    var ctx = (typeof SoundEngine !== 'undefined' && SoundEngine.ensureCtx) ?
              SoundEngine.ensureCtx() : null;
    if (!ctx) return 0;

    var now = ctx.currentTime;    // seconds
    var nowMs = Date.now();

    for (var name in lastOnset) {
      if (name === voiceName) continue;
      var onset = lastOnset[name];
      if (!onset) continue;

      // Check staleness: ignore onsets older than 2× separation (expressive zone)
      var ageMs = nowMs - onset.dateNow;
      if (ageMs < 0 || ageMs >= sepMs * 2) continue;

      // Compute gap in audio-clock seconds
      var gapSec = now - onset.ctxTime;
      var gapMs = gapSec * 1000;

      if (gapMs < 0) continue;  // other voice is scheduled in the future — skip

      // Zone check
      if (gapMs >= fusionMs && gapMs < sepMs) {
        // Uncanny zone — push to separation boundary
        var neededMs = sepMs - gapMs;
        return Math.max(0, neededMs / 1000);
      }
      // gapMs < fusionMs → fusion zone, fire now (they'll fuse)
      // gapMs >= sepMs → expressive zone, fire now (clean separation)
    }

    return 0;
  }


  // ── Core: onNote ──
  // Called from playVoiceNote. Applies polyphony policy + onset snap,
  // computes expression (v5.1.0), then calls SoundEngine.noteOn.
  // Returns the noteId from SoundEngine.
  function onNote(midi, volMult, voiceName, extraAhead) {
    var cfg = getConfig(voiceName);
    var notes = getActive(voiceName);
    var now = Date.now();

    // ── Mode-specific release policy ──
    if (cfg.mode === 'mono') {
      releaseAll(voiceName);
    } else {
      // poly or legato: steal oldest if at maxPoly
      while (countActive(notes) >= cfg.maxPoly) {
        releaseOldest(voiceName);
      }
    }

    // ── Onset snap (Step 4) ──
    var snapOffset = computeOnsetSnap(voiceName);

    // ── Compute expression (v5.1.0) ──
    var expression = null;
    var graceDelay = 0;
    if (typeof ExpressionEngine !== 'undefined') {
      // Gather context for expression computation
      var prevMidi = _getPreviousMidi(voiceName);
      var durationMs = 500; // default
      if (cfg.sustainBeats !== null) {
        durationMs = cfg.sustainBeats * beatMs();
        if (typeof MoodState !== 'undefined' && MoodState.getArticulationRatio) {
          durationMs *= MoodState.getArticulationRatio(voiceName) / 0.75;
        }
      }
      var gapBefore = 0;
      if (lastOnset[voiceName]) {
        gapBefore = now - lastOnset[voiceName].dateNow;
      }

      expression = ExpressionEngine.compute(voiceName, midi, {
        prevMidi: prevMidi,
        durationMs: durationMs,
        volMult: volMult,
        gapBefore: gapBefore
      });

      // Handle grace notes — fire-and-forget pre-note, delay main note
      if (expression && expression.graceNote) {
        var gn = expression.graceNote;
        SoundEngine.playGrace(gn.midi, (gn.vol || 0.35) * volMult, voiceName, gn.durationSec || 0.04);
        graceDelay = (gn.durationSec || 0.04) + 0.005; // slight overlap
        delete expression.graceNote;
      }
    }

    // ── Fire the note (extraAhead adds to snap for rolled chords etc.) ──
    var totalAhead = snapOffset + (extraAhead || 0) + graceDelay;
    var result = SoundEngine.noteOn(midi, volMult, voiceName, totalAhead, expression);
    var noteId = result.noteId;
    var onsetTime = result.onsetTime;

    // ── Record onset for future snap checks ──
    lastOnset[voiceName] = {
      ctxTime: onsetTime,
      dateNow: now
    };

    // ── Compute auto-release time ──
    var sustainUntil = null;
    if (cfg.sustainBeats !== null) {
      var sustainMs = cfg.sustainBeats * beatMs();
      // v5 Phase 4b: Mood articulation — minor keys → legato (longer sustain),
      // major → staccato (shorter). Bresin & Friberg 2011.
      if (typeof MoodState !== 'undefined' && MoodState.getArticulationRatio) {
        var artRatio = MoodState.getArticulationRatio(voiceName);
        sustainMs *= artRatio / 0.75;
      }
      // Expression: mute/ghost have shorter sustain
      if (expression && expression.mute) sustainMs = Math.min(sustainMs, 80);
      if (expression && expression.ghost) sustainMs *= 0.4;
      sustainUntil = now + sustainMs;
    }

    // ── Track ──
    var pc = ((midi % 12) + 12) % 12;
    notes.push({
      noteId: noteId,
      midi: midi,
      pc: pc,
      startTime: now,
      sustainUntil: sustainUntil,
      released: false
    });

    return noteId;
  }

  // ── Get most recent MIDI note for a voice (for expression context) ──
  function _getPreviousMidi(voiceName) {
    var notes = getActive(voiceName);
    for (var i = notes.length - 1; i >= 0; i--) {
      return notes[i].midi;
    }
    return null;
  }


  // ── Release helpers ──

  function countActive(notes) {
    var c = 0;
    for (var i = 0; i < notes.length; i++) {
      if (!notes[i].released) c++;
    }
    return c;
  }

  function releaseOldest(voiceName) {
    var notes = getActive(voiceName);
    for (var i = 0; i < notes.length; i++) {
      if (!notes[i].released) {
        notes[i].released = true;
        SoundEngine.releaseNote(voiceName, notes[i].noteId);
        return;
      }
    }
  }

  function releaseAll(voiceName) {
    var notes = getActive(voiceName);
    for (var i = 0; i < notes.length; i++) {
      if (!notes[i].released) {
        notes[i].released = true;
        SoundEngine.releaseNote(voiceName, notes[i].noteId);
      }
    }
  }


  // ── tick: auto-release expired notes, clean up fully released ──
  function tick(dt) {
    var now = Date.now();

    for (var voiceName in active) {
      var notes = active[voiceName];

      // Pass 1: release notes past their sustain time
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i];
        if (!n.released && n.sustainUntil !== null && now >= n.sustainUntil) {
          n.released = true;
          SoundEngine.releaseNote(voiceName, n.noteId);
        }
      }

      // Pass 2: remove entries released long enough for SoundEngine cleanup
      var cleaned = [];
      for (var j = 0; j < notes.length; j++) {
        if (notes[j].released && now - notes[j].startTime > 5000) {
          continue;  // stale — SoundEngine has cleaned up
        }
        cleaned.push(notes[j]);
      }
      active[voiceName] = cleaned;
    }
  }


  // ── Query API ──

  // Returns array of pitch classes (0-11) currently sounding (non-released).
  function getActiveNotes(voiceName) {
    var notes = getActive(voiceName);
    var pcs = [];
    for (var i = 0; i < notes.length; i++) {
      if (!notes[i].released) {
        pcs.push(notes[i].pc);
      }
    }
    return pcs;
  }

  // Returns count of currently sounding (non-released) notes.
  function getActivePoly(voiceName) {
    var notes = getActive(voiceName);
    var c = 0;
    for (var i = 0; i < notes.length; i++) {
      if (!notes[i].released) c++;
    }
    return c;
  }

  // Returns detailed info: [{noteId, midi, pc, startTime}]
  function getActiveNotesDetailed(voiceName) {
    var notes = getActive(voiceName);
    var result = [];
    for (var i = 0; i < notes.length; i++) {
      if (!notes[i].released) {
        result.push({
          noteId: notes[i].noteId,
          midi: notes[i].midi,
          pc: notes[i].pc,
          startTime: notes[i].startTime
        });
      }
    }
    return result;
  }


  // ── Configuration ──

  function setConfig(voiceName, cfg) {
    if (!CONFIG[voiceName]) CONFIG[voiceName] = {};
    if (cfg.mode !== undefined) CONFIG[voiceName].mode = cfg.mode;
    if (cfg.maxPoly !== undefined) CONFIG[voiceName].maxPoly = cfg.maxPoly;
    if (cfg.sustainBeats !== undefined) CONFIG[voiceName].sustainBeats = cfg.sustainBeats;
  }

  function getConfigSnapshot(voiceName) {
    var c = getConfig(voiceName);
    return { mode: c.mode, maxPoly: c.maxPoly, sustainBeats: c.sustainBeats };
  }


  // ── Reset ──

  function reset() {
    for (var voiceName in active) {
      releaseAll(voiceName);
      active[voiceName] = [];
    }
    lastOnset = { bass: null, rhythm: null, soloist: null };
  }


  // ── PUBLIC ──

  return {
    onNote: onNote,
    tick: tick,
    getActiveNotes: getActiveNotes,
    getActivePoly: getActivePoly,
    getActiveNotesDetailed: getActiveNotesDetailed,
    setConfig: setConfig,
    getConfig: getConfigSnapshot,
    reset: reset
  };
})();

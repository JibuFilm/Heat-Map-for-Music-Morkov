'use strict';
// ═══ PEER VELOCITY ENVELOPE (v2.5.1) ═══
//
// Per-voice breathing/fatigue model. Each voice's loudness naturally
// declines with sustained playing and recovers during silence.
//
// DESIGN: Direct observation pathway — bypasses POMDP belief state.
// Observes note output via EventBus 'noteProduced' and feeds velocity
// directly into playVoiceNote(). No circular dependency:
//   note → fatigue → quieter → (no belief involvement)
//
// Per-role parameters reflect musical identity:
//   bass:       anchor — slow fatigue, always audible (minVel 0.50)
//   rhythm:     groove — steady output, fast recovery
//   soloist:    expressive bursts — fast fatigue, slow recovery, wide range
//   lead:       energy driver — moderate fatigue, wide range for BUILD→PEAK
//   percussion: timekeeper — minimal fatigue, always present
//
// Depends on: event-bus.js (EventBus.on)
// Load order: after channel-orchestrator.js, before auto-evaluator.js

var PeerVelocity = (function() {

  // ── Per-role fatigue/recovery parameters ──
  var PARAMS = {
    bass:       { fatiguePerNote: 0.03,  recoveryPerSec: 0.08,  minVel: 0.50 },
    rhythm:     { fatiguePerNote: 0.02,  recoveryPerSec: 0.10,  minVel: 0.45 },
    soloist:    { fatiguePerNote: 0.03,  recoveryPerSec: 0.06,  minVel: 0.30 },
    lead:       { fatiguePerNote: 0.02,  recoveryPerSec: 0.12,  minVel: 0.35 },
    percussion: { fatiguePerNote: 0.01,  recoveryPerSec: 0.12,  minVel: 0.55 }
  };

  // ── Per-voice state ──
  var _vel = { bass: 1, rhythm: 1, soloist: 1, lead: 1, percussion: 1 };
  var _lastNoteTime = { bass: 0, rhythm: 0, soloist: 0, lead: 0, percussion: 0 };

  // Grace period before recovery starts (ms)
  var RECOVERY_GRACE_MS = 500;

  // ── Note produced → fatigue ──
  function onNoteProduced(voice) {
    var p = PARAMS[voice];
    if (!p) return;
    _vel[voice] = Math.max(p.minVel, _vel[voice] - p.fatiguePerNote);
    _lastNoteTime[voice] = Date.now();
  }

  // ── Tick → recovery for silent voices ──
  function tick(dtSec) {
    var now = Date.now();
    var voices = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      var silenceMs = now - _lastNoteTime[v];
      if (_lastNoteTime[v] > 0 && silenceMs > RECOVERY_GRACE_MS) {
        _vel[v] = Math.min(1.0, _vel[v] + PARAMS[v].recoveryPerSec * dtSec);
      }
    }
  }

  function getVelocity(voice) {
    return _vel[voice] !== undefined ? _vel[voice] : 1.0;
  }

  function getAll() {
    return { bass: _vel.bass, rhythm: _vel.rhythm, soloist: _vel.soloist, lead: _vel.lead, percussion: _vel.percussion };
  }

  function reset() {
    for (var v in _vel) _vel[v] = 1.0;
    for (var v2 in _lastNoteTime) _lastNoteTime[v2] = 0;
  }

  // ── Subscribe to noteProduced ──
  if (typeof EventBus !== 'undefined') {
    EventBus.on('noteProduced', function(data) {
      if (data.voiceName) onNoteProduced(data.voiceName);
      else if (data.voice) onNoteProduced(data.voice);
    });
  }

  return {
    tick: tick,
    getVelocity: getVelocity,
    getAll: getAll,
    reset: reset
  };

})();

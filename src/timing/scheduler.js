'use strict';
// ═══ SCHEDULER (Gen3 Phase 1 + Phase 4 IOI + Phase 6 cross-voice snap) ═══
//
// Phase 6 addition: crossVoiceSnap()
// When scheduling a new phrase, check every note's time against all other
// voices' active schedule times. If any note lands in the uncanny zone
// (FUSION..SEPARATION ms) of another voice's note, snap it to fuse.
// This prevents the problem at its source — no downstream correction needed.
//
// The existing within-phrase snap (Phase 4.5) is unchanged — it handles
// notes within the SAME voice's phrase that are too close together.
// Cross-voice snap handles notes across DIFFERENT voices' phrases.

var Scheduler = (function() {

  var activeSchedules = {};
  var sustainBoosts = {};
  var _expressionStash = {};  // v7 Phase 8D: per-voice expression side-channel

  // ── Pre-allocated scratch arrays (reused across calls to reduce GC pressure) ──
  var _otherTimesPool = [];         // reused by crossVoiceSnap
  var _firedPool = [];              // reused by tickPhrases

  // ── Schedule a phrase with IOI ratios ──
  // v2.3: timeMult parameter — perception-based time scaling per voice.
  //   timeMult > 1.0 → stretched IOIs (voice perceives time as slower)
  //   timeMult < 1.0 → compressed IOIs (voice perceives time as faster)
  //   timeMult = 1.0 or omitted → BPM-aligned (legacy behavior)
  function schedulePhrase(voiceName, notes, ioiRatios, bpm, callback, startDelayRatio, timeMult) {
    if (!notes || notes.length === 0) return;

    var baseIoi = 60000 / Math.max(30, bpm);
    // Apply subjective time multiplier: scales all IOIs for this voice
    if (timeMult && timeMult !== 1.0) {
      baseIoi *= timeMult;
    }
    var now = Date.now();
    var scheduled = [];
    var t = now + (startDelayRatio || 0) * baseIoi;

    for (var i = 0; i < notes.length; i++) {
      scheduled.push({ pc: notes[i], time: t });
      if (i < notes.length - 1) {
        var ratio = (ioiRatios && i < ioiRatios.length) ? ioiRatios[i] : 1.0;
        // v8.11.0: Minimum IOI floor — prevents note bursts from near-zero ratios.
        // At 120 BPM, baseIoi=500ms. Floor 0.25 → minimum 125ms between notes.
        // Musically: 16th notes at 120 BPM = 125ms — fast runs OK, bursts eliminated.
        if (ratio < 0.25) ratio = 0.25;
        t += baseIoi * ratio;
      }
    }

    // ── Phase 4.5: Within-phrase perceptual snap ──
    // Prevents uncanny-zone gaps between consecutive notes in the SAME phrase.
    var fusionMs = (typeof NOTE_FUSION_THRESHOLD_MS !== 'undefined') ? NOTE_FUSION_THRESHOLD_MS : 5;
    var sepMs = (typeof NOTE_SEPARATION_MIN_MS !== 'undefined') ? NOTE_SEPARATION_MIN_MS : 35;
    for (var i = 1; i < scheduled.length; i++) {
      var gap = scheduled[i].time - scheduled[i - 1].time;
      if (gap < fusionMs) {
        scheduled[i].time = scheduled[i - 1].time;
      } else if (gap < sepMs) {
        scheduled[i].time = scheduled[i - 1].time + sepMs;
      }
    }

    // ── v3.17.0: Bar-aware downbeat snap (Large & Jones 1999) ──
    // If PhaseCoupling's bar oscillator shows we're near a downbeat,
    // snap the first note to align with it. This creates bar-aligned phrases
    // that sound metrically grounded without strict quantization.
    if (typeof PhaseCoupling !== 'undefined' && PhaseCoupling.getBarPhase) {
      var barPhase = PhaseCoupling.getBarPhase(voiceName);
      // barPhase 0 = downbeat, 0.25 = beat 2, 0.5 = beat 3, 0.75 = beat 4
      // If within 10% of a downbeat (barPhase < 0.1 or > 0.9), snap first note
      var distToDownbeat = barPhase < 0.5 ? barPhase : (1.0 - barPhase);
      if (distToDownbeat < 0.1 && scheduled.length > 0) {
        // Calculate time to next downbeat
        var barPeriodMs = baseIoi * 4;  // 4 beats per bar
        var snapOffsetMs = (distToDownbeat < 0.05)
          ? -distToDownbeat * barPeriodMs   // snap backward (just past downbeat)
          : (1.0 - barPhase) * barPeriodMs; // snap forward (approaching downbeat)
        // Only snap if adjustment is small (< 1 beat)
        if (Math.abs(snapOffsetMs) < baseIoi) {
          var adjustment = snapOffsetMs;
          for (var si = 0; si < scheduled.length; si++) {
            scheduled[si].time += adjustment;
          }
        }
      }
    }

    // ── Phase 6: Cross-voice snap ──
    // Check this phrase's note times against ALL other voices' active schedules.
    // Snap uncanny-zone conflicts to fuse (simultaneous). This way both notes
    // arrive at coordinate() in the same tick — FC sees them together and can
    // do pitch clash resolution with full information.
    crossVoiceSnap(voiceName, scheduled, fusionMs, sepMs);

    // ── Same-PC fusion: consecutive identical PCs at same timestamp ──
    var deduped = [scheduled[0]];
    deduped[0].boost = 1.0;
    for (var i = 1; i < scheduled.length; i++) {
      if (scheduled[i].pc === deduped[deduped.length - 1].pc &&
          scheduled[i].time === deduped[deduped.length - 1].time) {
        deduped[deduped.length - 1].boost = Math.min(deduped[deduped.length - 1].boost + 0.15, 1.5);
      } else {
        scheduled[i].boost = 1.0;
        deduped.push(scheduled[i]);
      }
    }
    scheduled = deduped;

    activeSchedules[voiceName] = {
      voiceName: voiceName,
      notes: scheduled,
      nextIdx: 0,
      callback: callback
    };
  }

  // ── Cross-voice snap ──
  // For each note in the new schedule, check against upcoming notes
  // in all other voices' active schedules. If the gap falls in the
  // uncanny zone (>= fusion, < separation), snap THIS note to match
  // the other voice's time (fuse into a simultaneous event).
  //
  // Fusing is preferred over separating because:
  //   1. Simultaneous notes from different voices = chord/dyad (musically good)
  //   2. FinalCoordinator can resolve pitch clashes in the same tick
  //   3. No cross-clock correction needed downstream
  //
  // We snap the NEW phrase's notes (the one being scheduled now).
  // Already-scheduled phrases are not modified — their times are committed.
  function crossVoiceSnap(voiceName, scheduled, fusionMs, sepMs) {
    // Collect all upcoming note times from other voices (reuse pooled array)
    var otherTimes = _otherTimesPool;
    otherTimes.length = 0;
    for (var name in activeSchedules) {
      if (name === voiceName) continue;
      var sched = activeSchedules[name];
      for (var j = sched.nextIdx; j < sched.notes.length; j++) {
        otherTimes.push(sched.notes[j].time);
      }
    }

    if (otherTimes.length === 0) return;

    // Sort for efficient scanning
    otherTimes.sort(function(a, b) { return a - b; });

    // For each note in the new phrase, check against other voices
    for (var i = 0; i < scheduled.length; i++) {
      var myTime = scheduled[i].time;

      for (var j = 0; j < otherTimes.length; j++) {
        var otherTime = otherTimes[j];
        var gap = Math.abs(myTime - otherTime);

        // Past the window — otherTimes is sorted, so if gap is growing, stop
        if (otherTime > myTime + sepMs) break;

        // Check uncanny zone
        if (gap >= fusionMs && gap < sepMs) {
          // Snap to the other voice's time (fuse)
          scheduled[i].time = otherTime;
          break;  // snapped, move to next note
        }
      }
    }
  }

  // ── Cancel ──
  function cancel(voiceName) {
    delete activeSchedules[voiceName];
  }

  // ── v8.5.0: Mid-phrase density thinning (Gap 4) ──
  // Bregman 1990: auditory scene analysis fails with >3 concurrent streams.
  // Allows a voice to skip alternate notes from an active phrase without canceling it.
  var _thinning = {};  // per-voice: { enabled, counter }

  function setThinning(voiceName, enabled) {
    if (enabled) {
      _thinning[voiceName] = { enabled: true, counter: 0 };
    } else {
      delete _thinning[voiceName];
    }
  }

  function isThinning(voiceName) {
    return !!(_thinning[voiceName] && _thinning[voiceName].enabled);
  }

  // ── Pull-based note retrieval ──
  function consumeNext(voiceName) {
    var sched = activeSchedules[voiceName];
    if (!sched) return null;
    var now = Date.now();

    if (sched.nextIdx < sched.notes.length && sched.notes[sched.nextIdx].time <= now) {
      var note = sched.notes[sched.nextIdx];
      sched.nextIdx++;

      // Chord support: note.pc can be array of PCs (chord) or single PC
      if (Array.isArray(note.pc)) {
        for (var ci = 0; ci < note.pc.length; ci++) {
          if (sched.callback) sched.callback(note.pc[ci], voiceName);
        }
      } else {
        if (sched.callback) sched.callback(note.pc, voiceName);
      }

      if (note.boost && note.boost > 1.0) {
        sustainBoosts[voiceName] = note.boost;
      }

      if (sched.nextIdx >= sched.notes.length) {
        delete activeSchedules[voiceName];
      }
      // Return first PC (or single PC) for backward compat
      return Array.isArray(note.pc) ? note.pc[0] : note.pc;
    }
    return null;
  }

  // v8.11.0: Voices managed by AssistantShared use consumeNext() in their onTick.
  // tickPhrases must skip these voices — otherwise it silently advances nextIdx,
  // eating notes that consumeNext would have played on subsequent ticks.
  var _assistantVoices = { bass: true, rhythm: true, soloist: true, lead: true, percussion: true };

  function tickPhrases() {
    var now = Date.now();
    var fired = _firedPool;
    fired.length = 0;

    for (var name in activeSchedules) {
      // Skip voices managed by assistants — they consume via consumeNext in onTick
      if (_assistantVoices[name]) continue;
      var sched = activeSchedules[name];
      while (sched.nextIdx < sched.notes.length && sched.notes[sched.nextIdx].time <= now) {
        var note = sched.notes[sched.nextIdx];

        // Mid-phrase thinning: skip alternate notes when enabled (Gap 4)
        var thin = _thinning[name];
        if (thin && thin.enabled) {
          thin.counter++;
          if (thin.counter % 2 === 0) {
            // Skip this note — advance pointer without firing
            sched.nextIdx++;
            continue;
          }
        }

        // Chord support: fire each PC in a chord slot individually
        if (Array.isArray(note.pc)) {
          for (var ci = 0; ci < note.pc.length; ci++) {
            fired.push({ voiceName: name, pc: note.pc[ci] });
            if (sched.callback) sched.callback(note.pc[ci], name);
          }
        } else {
          fired.push({ voiceName: name, pc: note.pc });
          if (sched.callback) sched.callback(note.pc, name);
        }
        sched.nextIdx++;
      }
      if (sched.nextIdx >= sched.notes.length) {
        delete activeSchedules[name];
      }
    }

    return fired;
  }

  function hasActivePhrase(voiceName) {
    return !!activeSchedules[voiceName];
  }

  function reset() {
    activeSchedules = {};
    sustainBoosts = {};
  }

  function consumeSustainBoost(voiceName) {
    var boost = sustainBoosts[voiceName] || 1.0;
    delete sustainBoosts[voiceName];
    return boost;
  }

  function getPhraseProgress(voiceName) {
    var sched = activeSchedules[voiceName];
    if (!sched || sched.notes.length === 0) return 0.5; // neutral when no active phrase (avoids biasing belief observations)
    return sched.nextIdx / sched.notes.length;
  }

  // v7 Phase 8D: Expression side-channel — avoids changing onTick return type
  function setExpression(voiceName, expr) {
    _expressionStash[voiceName] = expr;
  }
  function getExpression(voiceName) {
    var e = _expressionStash[voiceName];
    delete _expressionStash[voiceName];
    return e || { velocityMult: 1.0, durationMult: 1.0 };
  }

  // v7 Phase 8A: Phrase context for monitor — total notes, current index, previous PC
  function getPhraseContext(voiceName) {
    var sched = activeSchedules[voiceName];
    if (!sched) return null;
    var idx = sched.nextIdx;
    var prevPC = null;
    if (idx > 1 && sched.notes[idx - 2]) {
      var pp = sched.notes[idx - 2].pc;
      prevPC = Array.isArray(pp) ? pp[0] : pp;
    }
    return {
      totalNotes: sched.notes.length,
      currentIdx: idx,
      prevPC: prevPC
    };
  }

  return {
    schedulePhrase: schedulePhrase,
    cancel: cancel,
    consumeNext: consumeNext,
    consumeSustainBoost: consumeSustainBoost,
    tickPhrases: tickPhrases,
    hasActivePhrase: hasActivePhrase,
    setThinning: setThinning,
    isThinning: isThinning,
    getPhraseProgress: getPhraseProgress,
    getPhraseContext: getPhraseContext,
    setExpression: setExpression,
    getExpression: getExpression,
    reset: reset
  };
})();

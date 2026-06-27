'use strict';
// ═══ FINAL COORDINATOR (Gen3 Phase 3 + Phase 6 simplification + Phase 7 VoiceManager) ═══
//
// Phase 6: Removed all cross-voice timing delay logic. Timing separation
// handled by Scheduler.crossVoiceSnap + VoiceManager scope-onset snap.
//
// Phase 7 changes:
//   - wouldClash() checks VoiceManager.getActiveNotes() (all sustained PCs)
//     in addition to lastPC tracking. Falls back to lastPC-only if VoiceManager
//     is not loaded (backward compat).
//   - isOverDensity() incorporates VoiceManager.getActivePoly() as a
//     "perceived density" boost. Poly notes still ringing count partially.
//   - resolveClash() avoids all sounding PCs across all voices, not just
//     the two explicit avoid params. 2-param signature PRESERVED.
//
// coordinate() return: { bass: pc|null, lead: pc|null, rhythm: pc|null, soloist: pc|null }
// Priority order: bass > lead > rhythm > solo. Bass never density-capped, never muted.

var FinalCoordinator = (function() {

  // ── State ──
  var lastBassPC = null;
  var lastRhythmPC = null;
  var lastSoloPC = null;
  var lastLeadPC = null;
  var lastBassTime = 0;
  var lastRhythmTime = 0;
  var lastSoloTime = 0;
  var lastLeadTime = 0;

  // Density tracking — assistant notes ONLY
  // v2.2: Caps raised to safety-net level. Primary density control is now
  // belief-driven (BeliefState density param → assistant skip probability).
  // These only fire as absolute ceiling to prevent runaway.
  var recentNotes = [];
  var MAX_DENSITY = 14;
  var SOLO_DENSITY_CAP = 6;
  var RHYTHM_DENSITY_CAP = 7;

  // Phase 7: weight for polyphonic density contribution.
  // Each sustained note beyond 1 adds this fraction to perceived density.
  var POLY_DENSITY_WEIGHT = 0.5;

  // ── Human note recording (Phase 5B) ──
  function recordHumanNote(pc, register, time) {
    time = time || Date.now();
    if (register === 'bass') {
      lastBassPC = pc;
      lastBassTime = time;
    } else if (register === 'rhythm') {
      lastRhythmPC = pc;
      lastRhythmTime = time;
    } else if (register === 'soloist') {
      lastSoloPC = pc;
      lastSoloTime = time;
    }
  }

  // ── Collision detection ──
  function isClash(pc1, pc2) {
    if (pc1 === null || pc2 === null || pc1 === undefined || pc2 === undefined) return false;
    var diff = Math.abs(pc1 - pc2);
    if (diff > 6) diff = 12 - diff;
    return diff === 1;
  }

  // Phase 7: collect all currently sounding PCs for a voice.
  // Merges VoiceManager sustained notes with FC's lastPC tracking.
  // VM provides poly context (chords building up). lastPC is authoritative
  // for the current tick (set inside coordinate() before wouldClash runs).
  // Both sources are merged and deduped.
  function getSoundingPCs(voiceName, lastPC, lastTime) {
    var now = Date.now();
    var beatMs = 60000 / Math.max(30, TempoEngine.getEffectiveBPM());
    var pcs = [];

    // VoiceManager sustained notes (poly context)
    if (typeof VoiceManager !== 'undefined') {
      var vmPCs = VoiceManager.getActiveNotes(voiceName);
      for (var i = 0; i < vmPCs.length; i++) pcs.push(vmPCs[i]);
    }

    // lastPC — always include if recent, deduped against VM results
    if (lastPC !== null && now - lastTime < beatMs) {
      var found = false;
      for (var j = 0; j < pcs.length; j++) {
        if (pcs[j] === lastPC) { found = true; break; }
      }
      if (!found) pcs.push(lastPC);
    }

    return pcs;
  }

  function wouldClash(pc, exclude) {
    var voiceMap = {
      bass:   { last: lastBassPC,   time: lastBassTime },
      rhythm: { last: lastRhythmPC, time: lastRhythmTime },
      soloist: { last: lastSoloPC,   time: lastSoloTime },
      lead:   { last: lastLeadPC,   time: lastLeadTime }
    };

    for (var voiceName in voiceMap) {
      if (voiceName === exclude) continue;
      var v = voiceMap[voiceName];
      var pcs = getSoundingPCs(voiceName, v.last, v.time);
      for (var i = 0; i < pcs.length; i++) {
        if (isClash(pc, pcs[i])) return voiceName;
      }
    }
    return null;
  }

  // ±6 semitone search for nearest in-scale non-clashing note.
  // Phase 7: also avoids clashing with any currently sounding PC across all voices.
  // 2-param signature preserved (avoidA, avoidB still explicit for the
  // immediate-tick context where VoiceManager hasn't tracked the note yet).
  function resolveClash(pc, avoidA, avoidB) {
    var key = SharedState.keyC;
    var scale = getScale(key, SharedState.mode);
    var scaleSet = {};
    for (var i = 0; i < scale.length; i++) scaleSet[scale[i]] = true;

    // Collect all sounding PCs to avoid (from VoiceManager)
    var allAvoid = [];
    if (avoidA !== null && avoidA !== undefined) allAvoid.push(avoidA);
    if (avoidB !== null && avoidB !== undefined) allAvoid.push(avoidB);

    if (typeof VoiceManager !== 'undefined') {
      var voices = ['bass', 'rhythm', 'soloist', 'lead'];
      for (var vi = 0; vi < voices.length; vi++) {
        var pcs = VoiceManager.getActiveNotes(voices[vi]);
        for (var pi = 0; pi < pcs.length; pi++) {
          allAvoid.push(pcs[pi]);
        }
      }
    }

    var candidates = [];
    for (var offset = -6; offset <= 6; offset++) {
      if (offset === 0) continue;
      var candidate = ((pc + offset) % 12 + 12) % 12;
      if (!scaleSet[candidate]) continue;

      // Check against all avoid PCs
      var clashes = false;
      for (var ai = 0; ai < allAvoid.length; ai++) {
        if (isClash(candidate, allAvoid[ai])) { clashes = true; break; }
      }
      if (!clashes) {
        candidates.push({ pc: candidate, dist: Math.abs(offset) });
      }
    }

    if (candidates.length > 0) {
      candidates.sort(function(a, b) { return a.dist - b.dist; });
      return candidates[0].pc;
    }
    return pc;
  }

  // ── Density ──
  function getBeatMs() {
    return 60000 / Math.max(30, TempoEngine.getEffectiveBPM());
  }

  function cleanDensity() {
    var now = Date.now();
    var window = getBeatMs();
    recentNotes = recentNotes.filter(function(n) {
      var age = now - n.time;
      return age >= 0 && age < window;
    });
  }

  function getDensity(voice) {
    var now = Date.now();
    var window = getBeatMs();
    var count = 0;
    for (var i = 0; i < recentNotes.length; i++) {
      if (now - recentNotes[i].time < window) {
        if (!voice || recentNotes[i].voice === voice) count++;
      }
    }
    return count;
  }

  // Phase 7: perceived density includes sustained polyphony.
  // A voice with 3 active poly notes is perceptually denser than
  // its note-on rate alone suggests.
  function getPerceivedDensity(voice) {
    var noteOnDensity = getDensity(voice);
    if (typeof VoiceManager === 'undefined') return noteOnDensity;

    var polyBoost = 0;
    if (voice) {
      // Per-voice: add partial count for sustained notes beyond 1
      var poly = VoiceManager.getActivePoly(voice);
      if (poly > 1) polyBoost = (poly - 1) * POLY_DENSITY_WEIGHT;
    } else {
      // Total: sum across all voices
      var voices = ['bass', 'rhythm', 'soloist', 'lead'];
      for (var i = 0; i < voices.length; i++) {
        var p = VoiceManager.getActivePoly(voices[i]);
        if (p > 1) polyBoost += (p - 1) * POLY_DENSITY_WEIGHT;
      }
    }
    return noteOnDensity + polyBoost;
  }

  function isOverDensity(voice) {
    cleanDensity();
    var total = getPerceivedDensity();
    if (total >= MAX_DENSITY) return true;
    if (voice === 'soloist' && getPerceivedDensity('soloist') >= SOLO_DENSITY_CAP) return true;
    if (voice === 'rhythm' && getPerceivedDensity('rhythm') >= RHYTHM_DENSITY_CAP) return true;
    return false;
  }

  function recordNote(voice) {
    recentNotes.push({ time: Date.now(), voice: voice });
  }

  // ── Conviction-based clash resolution (v4 Phase 6) ──
  // Replaces fixed priority hierarchy (bass>lead>rhythm>solo) with
  // dynamic conviction scoring. Each voice computes conviction from:
  //   1. Harmonic confidence (KeyBelief)      — 0 to 0.25
  //   2. Melodic commitment (mid-phrase)      — 0 or 0.20
  //   3. Cadential bass motion (P4/P5)        — 0 or 0.15 (bass only)
  //   4. Section energy (BUILD/PEAK)          — 0 to 0.10
  // Highest conviction places first; lower conviction resolves clashes.

  function _computeConviction(voice, pc) {
    var conviction = 0.30;

    // Harmonic confidence: how sure is this voice about the current key?
    if (typeof KeyBelief !== 'undefined') {
      conviction += (KeyBelief.getConfidence(voice) || 0) * 0.25;
    }

    // Melodic commitment: mid-phrase = higher conviction
    if (typeof Scheduler !== 'undefined' && Scheduler.hasActivePhrase(voice)) {
      conviction += 0.20;
    }

    // Cadential bass motion: P4/P5 root motion (Terhardt virtual pitch)
    if (voice === 'bass' && pc !== null && lastBassPC !== null) {
      var interval = Math.abs(pc - lastBassPC);
      if (interval > 6) interval = 12 - interval;
      if (interval === 5 || interval === 7) {
        conviction += 0.15;
      }
    }

    // Section energy alignment
    if (typeof SectionTracker !== 'undefined' && SectionTracker.getVoiceState) {
      var vs = SectionTracker.getVoiceState(voice);
      if (vs.state === 'BUILD') conviction += 0.05;
      if (vs.state === 'PEAK') conviction += 0.10;
    }

    return Math.min(conviction, 1.0);
  }

  function _updateLastPC(voice, pc, now) {
    switch (voice) {
      case 'bass':    lastBassPC = pc;   lastBassTime = now;   break;
      case 'rhythm':  lastRhythmPC = pc; lastRhythmTime = now; break;
      case 'soloist': lastSoloPC = pc;   lastSoloTime = now;   break;
      case 'lead':    lastLeadPC = pc;   lastLeadTime = now;   break;
    }
  }

  // ── Main coordination (v4 Phase 6: conviction-based, Phase 7: VoiceManager-aware) ──
  // v2.2: Density gating removed. BeliefState is the sole density authority.
  // FinalCoordinator handles clash resolution only (harmonic quality).
  // v3.5.0: Priority hierarchy replaced with conviction-sorted processing.
  function coordinate(bassPC, rhythmPC, soloPC, leadPC) {
    var now = Date.now();

    // Build voice entries with conviction scores
    var entries = [];
    if (bassPC !== null)   entries.push({ voice: 'bass',    pc: bassPC,   conviction: _computeConviction('bass', bassPC) });
    if (leadPC !== null)   entries.push({ voice: 'lead',    pc: leadPC,   conviction: _computeConviction('lead', leadPC) });
    if (rhythmPC !== null) entries.push({ voice: 'rhythm',  pc: rhythmPC, conviction: _computeConviction('rhythm', rhythmPC) });
    if (soloPC !== null)   entries.push({ voice: 'soloist', pc: soloPC,   conviction: _computeConviction('soloist', soloPC) });

    // Sort by conviction (highest first). Stable sort: ties resolve in insertion order.
    entries.sort(function(a, b) { return b.conviction - a.conviction; });

    // Place voices in conviction order — higher conviction places first
    var result = { bass: null, rhythm: null, soloist: null, lead: null };
    var placed = [];

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];

      // Check clash against all already-placed PCs
      var clashes = false;
      for (var j = 0; j < placed.length; j++) {
        if (isClash(e.pc, placed[j])) { clashes = true; break; }
      }

      if (clashes) {
        e.pc = resolveClash(e.pc, placed[0] || null, placed[1] || null);
      }

      result[e.voice] = e.pc;
      placed.push(e.pc);
      _updateLastPC(e.voice, e.pc, now);
      recordNote(e.voice);
    }

    return result;
  }

  // ── Bass root access ──
  function getBassRoot() {
    var now = Date.now();
    var beatMs = 60000 / Math.max(30, TempoEngine.getEffectiveBPM());
    if (lastBassPC !== null && now - lastBassTime < beatMs * 4) {
      return lastBassPC;
    }
    return null;
  }

  // ── Energy management ──
  function getEnergyMultiplier(voice) {
    // v3.8.2: OwnershipDetector removed — energy management based on density only
    var totalDensity = getDensity();
    if (totalDensity < 6) return 1.0;
    if (voice === 'soloist') return 0.6;
    if (voice === 'rhythm') return 0.8;
    return 1.0;
  }

  function reset() {
    lastBassPC = null; lastRhythmPC = null; lastSoloPC = null; lastLeadPC = null;
    lastBassTime = 0; lastRhythmTime = 0; lastSoloTime = 0; lastLeadTime = 0;
    recentNotes = [];
  }

  return {
    coordinate: coordinate,
    recordHumanNote: recordHumanNote,
    getBassRoot: getBassRoot,
    getDensity: getDensity,
    getConviction: _computeConviction,
    isClash: isClash,
    reset: reset
  };
})();

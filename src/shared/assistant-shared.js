'use strict';
// ═══ ASSISTANT SHARED UTILITIES (Phase 5C — deduplication refactor) ═══
//
// Extracted from bass-assistant.js, rhythm-assistant.js, solo-assistant.js.
// These functions were copy-pasted with only cosmetic differences. Now they
// live here and each assistant calls them with role-specific parameters.
//
// Load order: after constants.js, before any assistant file.
//
// Functions extracted:
//   scaleSnap(pc)                      — snap PC to nearest in-scale note
//   tempSample(probs, temperature)     — temperature-weighted sampling from 12-PC distribution
//   observeNoteSTM(pc, prevNote, stm, keyC) — feed a note into an STM trie set
//   detectLoopInBuffer(pcs, config)    — autocorrelation loop detection on PC buffer
//   buildPhraseSchedule(voiceName, notes, ioiRatios, bpm, barAlignConfig) — shared scheduling pattern
//   scoreLexiconEntry(entry, key, context, weights) — shared selectPhrase scaffolding

var AssistantShared = (function() {

  // ── Cached scale set (invalidated on key/mode change) ──
  // Avoids creating new Set() on every scaleSnap / selectPhrase call.
  var _cachedScaleKey = -1;
  var _cachedScaleMode = '';
  var _cachedScaleSet = null;  // Set of PCs
  var _cachedScaleArr = null;  // array of PCs

  // ═══ MUSICAL MOMENTUM (v8.7.1) ═══
  // Detects when a voice plays a burst of harmonically strong notes and publishes
  // a momentum signal to SharedState. Other voices read this on their next tick
  // to boost energy beliefs and align harmonic direction.
  //
  // Design: stigmergic (Pressing 1999) — no direct messaging. The signal is
  // "something important is happening in the ensemble" not "play this."
  // Each voice independently decides how to respond based on its role + beliefs.
  //
  // Speed: runs on noteProduced EventBus (every note, ~5ms), not phrase completion.
  // A 2-tick soloist burst is detected immediately.
  var _momentumPerVoice = {};
  var _MOMENTUM_WINDOW = 3000;      // ms window for note burst detection
  var _MOMENTUM_NOTE_THRESH = 4;    // min notes in window to trigger
  var _MOMENTUM_CHORD_RATIO = 0.5;  // min fraction of notes that are chord tones
  var _MOMENTUM_DECAY = 4000;       // ms until momentum signal expires

  function _detectMomentum(voiceName, pc) {
    if (!_momentumPerVoice[voiceName]) {
      _momentumPerVoice[voiceName] = { notes: [], lastSignal: 0 };
    }
    var mv = _momentumPerVoice[voiceName];
    var now = Date.now();

    // Add note to rolling window
    mv.notes.push({ pc: pc, time: now });
    // Trim old notes
    while (mv.notes.length > 0 && now - mv.notes[0].time > _MOMENTUM_WINDOW) {
      mv.notes.shift();
    }

    // Need minimum note count in window
    if (mv.notes.length < _MOMENTUM_NOTE_THRESH) return;

    // Check harmonic quality: what fraction are chord tones?
    var chord = SharedState.currentChord;
    if (!chord) return;
    var chordTones = [chord.rootPC, (chord.rootPC + (chord.type === 'minor' ? 3 : 4)) % 12, (chord.rootPC + 7) % 12];
    var chordCount = 0;
    for (var ni = 0; ni < mv.notes.length; ni++) {
      for (var ci = 0; ci < chordTones.length; ci++) {
        if (mv.notes[ni].pc === chordTones[ci]) { chordCount++; break; }
      }
    }
    var chordRatio = chordCount / mv.notes.length;

    // Rate: notes per second in this burst
    var burstDuration = (now - mv.notes[0].time) / 1000;
    var nps = burstDuration > 0.1 ? mv.notes.length / burstDuration : 0;

    // Momentum = high note rate + harmonically grounded (or intentional tension)
    // A burst of non-chord tones is also momentum if it's dense enough (soloist tension)
    var momentumStrength = 0;
    if (chordRatio >= _MOMENTUM_CHORD_RATIO) {
      // Harmonically grounded burst — strong momentum
      momentumStrength = Math.min(1.0, nps / 4.0) * (0.5 + 0.5 * chordRatio);
    } else if (nps > 3.0 && mv.notes.length >= 6) {
      // Dense non-chord burst (soloist tension) — moderate momentum
      momentumStrength = Math.min(0.7, nps / 6.0);
    }

    if (momentumStrength < 0.3) return;  // not significant enough

    // Don't re-trigger within 2 seconds
    if (now - mv.lastSignal < 2000) return;
    mv.lastSignal = now;

    // Publish to SharedState — other voices read this
    if (!SharedState.musicalMomentum) SharedState.musicalMomentum = {};
    SharedState.musicalMomentum[voiceName] = {
      strength: momentumStrength,
      harmonicTarget: chord.rootPC,
      harmonicType: chord.type,
      nps: nps,
      chordRatio: chordRatio,
      timestamp: now
    };

    // Temporarily boost this voice's harmonic authority (Keller 2014: leading voice
    // should have stronger harmonic influence during its peak moment)
    if (!SharedState._momentumAuthorityBoost) SharedState._momentumAuthorityBoost = {};
    SharedState._momentumAuthorityBoost[voiceName] = {
      boost: 0.5,  // add 0.5 to authority weight temporarily
      timestamp: now
    };
  }

  // Read active momentum from any peer (called by belief observation layer)
  function getActiveMomentum(excludeVoice) {
    if (!SharedState.musicalMomentum) return null;
    var now = Date.now();
    var best = null;
    for (var v in SharedState.musicalMomentum) {
      if (v === excludeVoice) continue;
      var m = SharedState.musicalMomentum[v];
      if (!m || now - m.timestamp > _MOMENTUM_DECAY) continue;
      // Decay strength over time
      var age = now - m.timestamp;
      var decayed = m.strength * (1.0 - age / _MOMENTUM_DECAY);
      if (decayed > 0.2 && (!best || decayed > best.strength)) {
        best = { voice: v, strength: decayed, harmonicTarget: m.harmonicTarget,
                 harmonicType: m.harmonicType, nps: m.nps };
      }
    }
    return best;
  }

  // ═══ TENSION ACCUMULATION (v8.13.0 — Farbood 2012, Huron 2006, Lerdahl 2001) ═══
  // Tracks unresolved harmonic tension per voice using THREE complementary signals:
  //
  // 1. PHRASE-END TENSION: rises on non-resolving phrase endings, falls on resolution.
  //    This is the original v8.8.0 mechanism, but with MUCH slower decay during
  //    BUILD/PEAK so tension accumulates across phrases instead of oscillating.
  //
  // 2. HARMONIC DISTANCE: continuous CoF distance from tonic. A voice playing in a
  //    distant key area for multiple phrases accumulates tension regardless of how
  //    individual phrases end. (Lerdahl 2001: tonal tension = hierarchical distance.)
  //
  // 3. PHRASE STREAK: count of consecutive non-resolving phrases. Each adds a small
  //    increment that compounds. Resets hard on strong resolution.
  //    (Farbood 2012: sustained directional change amplifies tension perception.)
  //
  // Resolution requires MULTIPLE converging signals — a single root on a weak beat
  // doesn't erase 8 bars of accumulated tension. Strong resolution needs:
  // root on a strong beat (metric weight ≥ 0.5) while bass is grounding.
  //
  // "The approach to resolution is more rewarding than the arrival" — Huron 2006
  var _tensionPerVoice = {};
  var _TENSION_HALF_LIFE = 10000;  // 10s base decay (Farbood 2012: 10-12s empirical window)
  var _TENSION_RESOLVE_DROP = 0.12; // weaker single-phrase resolution (was 0.20)
  var _TENSION_STRONG_RESOLVE_DROP = 0.25; // strong resolution: root + strong beat + bass grounding
  var _TENSION_NONRESOLVE_RISE = 0.14; // per-phrase tension build
  var _TENSION_APPROACH_RISE = 0.20;   // approach tones create tension pull
  var _TENSION_STREAK_INCREMENT = 0.04; // per consecutive non-resolving phrase
  var _TENSION_HARMONIC_WEIGHT = 0.15;  // continuous CoF distance contribution per note

  // Circle-of-fifths distance (0-6) — pre-computed lookup table (O(1))
  // v9.2.0: Consolidated with mood-state.js (both used same algorithm, different optimization)
  var _cofTable = new Uint8Array(144);
  (function() {
    for (var a = 0; a < 12; a++) for (var b = 0; b < 12; b++) {
      var d = 6;
      for (var i = 1; i <= 6; i++) {
        if ((a + i * 7) % 12 === b || (a - i * 7 + 120) % 12 === b) { d = i; break; }
      }
      _cofTable[a * 12 + b] = d;
    }
  })();
  function _cofDist(a, b) { return _cofTable[a * 12 + b]; }

  // v9.2.0: Extracted from duplicated code in _updateTension() and getTensionLevel()
  // Section-aware decay multiplier (Farbood 2012): BUILD/PEAK slow decay so tension
  // accumulates across phrases. RELEASE speeds decay for satisfying resolution.
  function _getSectionDecayMult() {
    try {
      var secState = SectionTracker.getState().state;
      if (secState === 'BUILD') return 0.15;
      if (secState === 'PEAK') return 0.25;
      if (secState === 'RELEASE') return 2.0;
    } catch(e) {}
    return 1.0;
  }

  function _updateTension(voiceName, pc) {
    if (!_tensionPerVoice[voiceName]) {
      _tensionPerVoice[voiceName] = {
        level: 0.3, lastUpdate: Date.now(), lastNoteTime: 0, lastPC: -1,
        nonResolvingStreak: 0,  // consecutive non-resolving phrase endings
        harmonicAccum: 0        // accumulated harmonic distance signal
      };
    }
    var tv = _tensionPerVoice[voiceName];
    var now = Date.now();

    // ── Natural decay toward 0.3 baseline ──
    var elapsed = now - tv.lastUpdate;
    if (elapsed > 0) {
      // Section-aware decay: BUILD/PEAK DRAMATICALLY slow decay so tension accumulates
      // across multiple phrases. RELEASE speeds decay for satisfying resolution.
      // Key change from v8.8.0: BUILD was 0.6x, now 0.15x. PEAK was 0.8x, now 0.25x.
      // This is the core fix — tension was oscillating because decay was too fast
      // relative to the rate phrases produce tension updates.
      var decayRate = (Math.LN2 / _TENSION_HALF_LIFE) * _getSectionDecayMult();
      tv.level = 0.3 + (tv.level - 0.3) * Math.exp(-decayRate * elapsed);
      // Harmonic accumulator also decays (faster — it's a momentary signal)
      tv.harmonicAccum = tv.harmonicAccum * Math.exp(-decayRate * 2 * elapsed);
    }
    tv.lastUpdate = now;

    // ── Signal 2: Continuous harmonic distance (every note) ──
    // Each note's CoF distance from tonic feeds a small tension increment.
    // Playing in distant key areas accumulates tension regardless of phrase endings.
    // (Lerdahl 2001: tonal tension is hierarchical pitch-space distance.)
    var tonic = (typeof SharedState !== 'undefined') ? (SharedState.keyC || 0) : 0;
    var cofDistance = _cofDist(tonic, pc);
    if (cofDistance > 1) {
      // Only notes outside tonic/dominant contribute (CoF distance > 1)
      var harmonicIncrement = (cofDistance / 6.0) * _TENSION_HARMONIC_WEIGHT;
      tv.harmonicAccum = Math.min(0.3, tv.harmonicAccum + harmonicIncrement);
      tv.level = Math.min(1.0, tv.level + harmonicIncrement * 0.5);
    }

    // ── Signal 1: Phrase-end tension (gap > 400ms) ──
    var gap = now - tv.lastNoteTime;
    var isPhraseEnd = (gap > 400 && tv.lastPC >= 0);

    if (isPhraseEnd) {
      var endPC = tv.lastPC;
      var chord = SharedState.currentChord;
      if (chord) {
        var root = chord.rootPC;
        var third = (root + (chord.type === 'minor' ? 3 : 4)) % 12;
        var fifth = (root + 7) % 12;
        var semitoneAbove = (root + 1) % 12;
        var semitoneBelow = (root + 11) % 12;

        // Check for STRONG resolution conditions (multiple converging signals)
        var isStrongBeat = false;
        if (typeof BarTracker !== 'undefined' && BarTracker.getBarPhase) {
          var barPhase = BarTracker.getBarPhase();
          // Strong beats: beat 1 (0.0-0.1) and beat 3 (0.45-0.55)
          isStrongBeat = (barPhase < 0.1 || (barPhase > 0.45 && barPhase < 0.55));
        }
        var bassGrounding = true;
        if (typeof BassAssistant !== 'undefined' && BassAssistant.getBassState) {
          bassGrounding = (BassAssistant.getBassState() === 'groove');
        }

        if (endPC === root) {
          if (isStrongBeat && bassGrounding) {
            // STRONG resolution: root on strong beat with bass grounding
            tv.level = Math.max(0.0, tv.level - _TENSION_STRONG_RESOLVE_DROP);
            tv.nonResolvingStreak = 0; // reset streak
            tv.harmonicAccum *= 0.3;   // mostly clear harmonic accumulator
          } else {
            // Weak resolution: root but wrong beat or no bass grounding
            tv.level = Math.max(0.0, tv.level - _TENSION_RESOLVE_DROP * 0.7);
            tv.nonResolvingStreak = Math.max(0, tv.nonResolvingStreak - 1);
          }
        } else if (endPC === third || endPC === fifth) {
          // 3rd/5th = mild resolution (less than root)
          tv.level = Math.max(0.0, tv.level - _TENSION_RESOLVE_DROP * 0.4);
          tv.nonResolvingStreak = Math.max(0, tv.nonResolvingStreak - 1);
        } else if (endPC === semitoneAbove || endPC === semitoneBelow) {
          // Approach tone = strong tension (leading tone wants to resolve)
          tv.level = Math.min(1.0, tv.level + _TENSION_APPROACH_RISE);
          tv.nonResolvingStreak++;
        } else {
          // Other non-chord tone = moderate tension
          tv.level = Math.min(1.0, tv.level + _TENSION_NONRESOLVE_RISE);
          tv.nonResolvingStreak++;
        }

        // ── Signal 3: Phrase streak compound tension ──
        // Each consecutive non-resolving phrase adds compounding tension.
        // This creates the cross-phrase accumulation that was missing.
        // (Farbood 2012: sustained directional change amplifies perception.)
        if (tv.nonResolvingStreak > 1) {
          var streakBonus = Math.min(tv.nonResolvingStreak - 1, 6) * _TENSION_STREAK_INCREMENT;
          tv.level = Math.min(1.0, tv.level + streakBonus);
        }
      }
    }

    tv.lastNoteTime = now;
    tv.lastPC = pc;
  }

  function getTensionLevel(voiceName) {
    if (!_tensionPerVoice[voiceName]) return 0.3;
    // Apply decay before returning
    var tv = _tensionPerVoice[voiceName];
    var now = Date.now();
    var elapsed = now - tv.lastUpdate;
    if (elapsed > 100) {
      var decayRate = (Math.LN2 / _TENSION_HALF_LIFE) * _getSectionDecayMult();
      return 0.3 + (tv.level - 0.3) * Math.exp(-decayRate * elapsed);
    }
    return tv.level;
  }

  // Wire into EventBus noteProduced (called once at module load)
  if (typeof EventBus !== 'undefined') {
    EventBus.on('noteProduced', function(data) {
      var voice = data.voiceName || data.voice;
      if (voice && voice !== 'human' && voice !== 'percussion') {
        _detectMomentum(voice, data.pc);
        // Update tension on every note (decay tracking + phrase boundary detection)
        _updateTension(voice, data.pc);
      }
    });
  }

  // ═══ COLLECTIVE BREATH (v9.0.0) ═══
  // Ensemble-level silence as architecture. When ensemble density saturates,
  // voices progressively withdraw, leaving one voice soloing, then re-enter.
  //
  // This solves the "stage problem" (ROADMAP #11) through a musical mechanism
  // rather than a timing gate: silence creates anticipation (Huron 2006 ITPRA).
  //
  // Phases: idle → withdraw → solo → reenter → cooldown → idle
  // Withdrawal order: lead → soloist → rhythm → percussion → bass (structural last)
  // Re-entry order: bass → percussion → rhythm → soloist → lead (reverse)
  //
  // Psychoacoustic basis:
  //   London 2012 (metric hierarchy and expectation)
  //   Farbood 2012 (tension-release timing)
  //   Madison 2006 (silence budget)

  var _BREATH_WITHDRAW_ORDER = ['lead', 'soloist', 'rhythm', 'percussion', 'bass'];
  var _BREATH_REENTER_ORDER  = ['bass', 'percussion', 'rhythm', 'soloist', 'lead'];
  var _BREATH_COOLDOWN_MS    = 90000;  // 90s between breaths
  var _BREATH_MIN_SESSION_MS = 60000;  // no breath in first 60s
  var _BREATH_FULLNESS_THRESH = 0.80;  // ensemble fullness threshold
  var _BREATH_FULLNESS_BARS  = 4;      // bars above threshold to trigger
  var _BREATH_WITHDRAW_MS    = 8000;   // 8s to fully withdraw all voices
  var _BREATH_SOLO_MS        = 6000;   // 6s of solo voice
  var _BREATH_REENTER_MS     = 10000;  // 10s to fully re-enter all voices

  var _breath = {
    phase: 'idle',        // idle | withdraw | solo | reenter | cooldown
    startTime: 0,         // when current phase started
    lastBreathTime: 0,    // when last breath completed (for cooldown)
    soloVoice: null,      // which voice gets the solo
    fullnessAccum: 0,     // bars above fullness threshold
    sessionStartTime: 0   // when session started (for 60s guard)
  };

  // Compute ensemble fullness (0-1) from density + active voices + register coverage.
  // High fullness = the ensemble is saturated — a breath would create dramatic contrast.
  function _getEnsembleFullness() {
    if (typeof ContextIntegrator === 'undefined' || !ContextIntegrator.getEnsembleSnapshot) return 0;
    var snap = ContextIntegrator.getEnsembleSnapshot();
    // Density component: 0-1 mapped from 0-8 nps
    var densityFull = Math.min(1, (snap.totalDensity || 0) / 8);
    // Voice count component: 0-1 mapped from 0-5 active voices
    var voiceFull = Math.min(1, (snap.activeVoiceCount || 0) / 5);
    // Weighted: density matters more (you can be full with 3 dense voices)
    return densityFull * 0.6 + voiceFull * 0.4;
  }

  // Choose solo voice based on NarrativeArc phase — voice in climax phase gets priority.
  function _chooseSoloVoice() {
    if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getArc) {
      var voices = ['bass', 'soloist', 'lead'];  // only pitched soloists
      for (var i = 0; i < voices.length; i++) {
        var arc = NarrativeArc.getArc(voices[i]);
        if (arc && arc.active && arc.phase === 'climax') return voices[i];
      }
    }
    // Default: weighted random favoring melodic voices
    var roll = Math.random();
    if (roll < 0.40) return 'soloist';
    if (roll < 0.70) return 'lead';
    if (roll < 0.85) return 'bass';
    return 'rhythm';
  }

  // Tick the breath state machine. Called from the main onTick path.
  function _breathTick(dt) {
    if (!_breath.sessionStartTime) _breath.sessionStartTime = Date.now();
    var now = Date.now();

    switch (_breath.phase) {
      case 'idle':
        // v9.0.1: No breath during session ending (ending handles its own withdrawal)
        if (typeof SessionEnding !== 'undefined' && SessionEnding.isActive()) return;
        // Guard: no breath in first 60s
        if (now - _breath.sessionStartTime < _BREATH_MIN_SESSION_MS) return;
        // Guard: cooldown between breaths
        if (_breath.lastBreathTime && now - _breath.lastBreathTime < _BREATH_COOLDOWN_MS) return;
        // Guard: only during BUILD or late PEAK (dramatic moments)
        if (typeof SectionTracker !== 'undefined') {
          var sec = SectionTracker.getState().state;
          if (sec !== 'BUILD' && sec !== 'PEAK') { _breath.fullnessAccum = 0; return; }
        }
        // Check fullness
        var fullness = _getEnsembleFullness();
        if (fullness > _BREATH_FULLNESS_THRESH) {
          // Accumulate bars above threshold
          var bpm = (typeof PhaseCoupling !== 'undefined') ? (PhaseCoupling.getConsensusBPM() || 120) : 120;
          var barsPerMs = 1 / (60000 / bpm * 4);
          _breath.fullnessAccum += dt * barsPerMs;
          if (_breath.fullnessAccum >= _BREATH_FULLNESS_BARS) {
            // Trigger breath
            _breath.phase = 'withdraw';
            _breath.startTime = now;
            _breath.soloVoice = _chooseSoloVoice();
            _breath.fullnessAccum = 0;
            EventBus.emit('collectiveBreath', { phase: 'withdraw', soloVoice: _breath.soloVoice });
          }
        } else {
          // Decay accumulator when fullness drops
          _breath.fullnessAccum = Math.max(0, _breath.fullnessAccum - dt * 0.0005);
        }
        break;

      case 'withdraw':
        if (now - _breath.startTime >= _BREATH_WITHDRAW_MS) {
          _breath.phase = 'solo';
          _breath.startTime = now;
          EventBus.emit('collectiveBreath', { phase: 'solo', soloVoice: _breath.soloVoice });
        }
        break;

      case 'solo':
        if (now - _breath.startTime >= _BREATH_SOLO_MS) {
          _breath.phase = 'reenter';
          _breath.startTime = now;
          EventBus.emit('collectiveBreath', { phase: 'reenter', soloVoice: _breath.soloVoice });
        }
        break;

      case 'reenter':
        if (now - _breath.startTime >= _BREATH_REENTER_MS) {
          _breath.phase = 'cooldown';
          _breath.startTime = now;
          _breath.lastBreathTime = now;
          _breath.soloVoice = null;
          EventBus.emit('collectiveBreath', { phase: 'complete' });
        }
        break;

      case 'cooldown':
        // Transition back to idle after cooldown expires (checked in 'idle' guard)
        _breath.phase = 'idle';
        break;
    }
  }

  // Get the gate modifier for a specific voice during collective breath.
  // Returns 0.0-1.0 multiplier on the unified gate readiness.
  // During idle/cooldown: returns 1.0 (no effect).
  // During withdraw: voices fade out in order (lead first, bass last).
  // During solo: only soloVoice has 1.0, all others have 0.0.
  // During reenter: voices fade in in reverse order (bass first, lead last).
  function _getBreathModifier(voiceName) {
    if (_breath.phase === 'idle' || _breath.phase === 'cooldown') return 1.0;
    if (voiceName === _breath.soloVoice) return 1.0;  // solo voice always active

    var now = Date.now();
    var elapsed = now - _breath.startTime;

    if (_breath.phase === 'withdraw') {
      // Each voice has a withdrawal window within the total withdraw duration.
      // Lead withdraws first (0-20%), soloist next (20-40%), etc.
      var orderIdx = _BREATH_WITHDRAW_ORDER.indexOf(voiceName);
      if (orderIdx < 0) return 1.0;
      var voiceCount = _BREATH_WITHDRAW_ORDER.length;
      var windowStart = (orderIdx / voiceCount) * _BREATH_WITHDRAW_MS;
      var windowEnd = ((orderIdx + 1) / voiceCount) * _BREATH_WITHDRAW_MS;
      if (elapsed < windowStart) return 1.0;  // not yet this voice's turn
      if (elapsed >= windowEnd) return 0.0;    // already withdrawn
      // Smooth fade within window
      return 1.0 - (elapsed - windowStart) / (windowEnd - windowStart);
    }

    if (_breath.phase === 'solo') {
      return 0.0;  // all non-solo voices silent
    }

    if (_breath.phase === 'reenter') {
      // Each voice has a re-entry window within the total reenter duration.
      var orderIdx = _BREATH_REENTER_ORDER.indexOf(voiceName);
      if (orderIdx < 0) return 1.0;
      var voiceCount = _BREATH_REENTER_ORDER.length;
      var windowStart = (orderIdx / voiceCount) * _BREATH_REENTER_MS;
      var windowEnd = ((orderIdx + 1) / voiceCount) * _BREATH_REENTER_MS;
      if (elapsed < windowStart) return 0.0;  // not yet this voice's turn
      if (elapsed >= windowEnd) return 1.0;    // fully re-entered
      // Smooth fade within window
      return (elapsed - windowStart) / (windowEnd - windowStart);
    }

    return 1.0;
  }

  function _refreshScaleCache() {
    var k = SharedState.keyC;
    var m = SharedState.mode;
    if (k !== _cachedScaleKey || m !== _cachedScaleMode) {
      _cachedScaleArr = getScale(k, m);
      _cachedScaleSet = new Set(_cachedScaleArr);
      _cachedScaleKey = k;
      _cachedScaleMode = m;
    }
  }

  // ── scaleSnap(pc, voice) ──
  // Snap a pitch class to the nearest note in the current scale.
  // Searches ±6 semitones (guaranteed to find something in any scale).
  // Previously duplicated in all three assistants (identical code).
  //
  // When a voice is in a contrast/climax arc phase, snap to a modulation
  // target key instead. This breaks the self-reinforcing key lock where
  // scaleSnap→same key notes→histogram confirms→scaleSnap loops forever.
  // The voice intentionally plays in a neighboring key (one CoF step away),
  // injecting new tonal material that shifts other voices' histograms.
  function scaleSnap(pc, voice) {
    // During modulation-active arc phases, use a target key instead
    if (voice && typeof NarrativeArc !== 'undefined' && NarrativeArc.getArc) {
      var _arcState = NarrativeArc.getArc(voice);
      if (_arcState && (_arcState.phase === 'climax' || _arcState.phase === 'transition')) {
        var _targetScale = _getModulationTargetScale(voice);
        if (_targetScale) {
          if (_targetScale.has(pc)) return pc;
          for (var _o = 1; _o <= 6; _o++) {
            if (_targetScale.has((pc + _o) % 12)) return (pc + _o) % 12;
            if (_targetScale.has(((pc - _o) + 12) % 12)) return ((pc - _o) + 12) % 12;
          }
          return pc;
        }
      }
    }

    _refreshScaleCache();
    if (_cachedScaleSet.has(pc)) return pc;
    for (var off = 1; off <= 6; off++) {
      if (_cachedScaleSet.has((pc + off) % 12)) return (pc + off) % 12;
      if (_cachedScaleSet.has(((pc - off) + 12) % 12)) return ((pc - off) + 12) % 12;
    }
    return pc;
  }

  // ── Modulation target: one CoF step from current key ──
  // During climax/transition, voices snap to a neighboring key's scale.
  // Direction follows CoF momentum if available, otherwise alternates sharp/flat.
  var _COF_ORDER = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]; // C,G,D,A,E,B,F#,Db,Ab,Eb,Bb,F
  var _modTargetCache = {}; // voice -> { key, mode, scaleSet, arcPhaseIdx }

  function _getModulationTargetScale(voice) {
    // Check if cached target is still valid for current arc phase
    var arcState = NarrativeArc.getArc(voice);
    var cached = _modTargetCache[voice];
    if (cached && cached.arcPhaseIdx === arcState.phaseIdx && cached.template === arcState.template) {
      return cached.scaleSet;
    }

    // Pick modulation direction from CoF momentum, or alternate
    var direction = 1; // default sharpward (dominant direction)
    if (typeof KeyBelief !== 'undefined' && KeyBelief.getModulationMomentum) {
      var mom = KeyBelief.getModulationMomentum(voice);
      if (mom.direction === 'flat') direction = -1;
      else if (mom.direction === 'sharp') direction = 1;
      else direction = Math.random() < 0.5 ? 1 : -1; // random if no momentum
    }

    // Current key from SharedState
    var currentKey = SharedState.keyC;
    var currentMode = SharedState.mode;

    // Find current position on CoF and step
    var cofPos = -1;
    for (var i = 0; i < 12; i++) {
      if (_COF_ORDER[i] === currentKey) { cofPos = i; break; }
    }
    if (cofPos < 0) cofPos = 0;

    var targetCofPos = ((cofPos + direction) + 12) % 12;
    var targetKey = _COF_ORDER[targetCofPos];

    // Build target scale set
    var targetScaleArr = getScale(targetKey, currentMode);
    var targetScaleSet = new Set(targetScaleArr);

    _modTargetCache[voice] = {
      key: targetKey,
      mode: currentMode,
      scaleSet: targetScaleSet,
      arcPhaseIdx: arcState.phaseIdx,
      template: arcState.template
    };

    return targetScaleSet;
  }

  // ── tempSample(probs, temperature) ──
  // Temperature-weighted sampling from a 12-element probability distribution.
  // Returns a pitch class (0–11). Falls back to dominant if distribution collapses.
  // Previously duplicated in all three assistants AND voice-player.js (4 copies).
  // Pre-allocated temp distribution array (avoid per-call Float64Array allocation)
  var _tempSampleArr = new Float64Array(12);

  function tempSample(probs, temperature) {
    var tp = _tempSampleArr;
    var invT = 1 / Math.max(0.1, temperature);
    for (var i = 0; i < 12; i++) {
      tp[i] = Math.pow(Math.max(probs[i], 0.0001), invT);
    }
    var tw = 0;
    for (var i = 0; i < 12; i++) tw += tp[i];
    if (tw < 0.001) return (SharedState.keyC + 7) % 12;
    var r = Math.random() * tw;
    for (var i = 0; i < 12; i++) {
      r -= tp[i];
      if (r <= 0) return i;
    }
    return 0;
  }

  // ── observeNoteSTM(pc, prevNote, stm, keyC) ──
  // Feed a note into a standard STM trie set (pitch, interval, sd, contour, linked).
  // Updates stm.recent. Returns the new currentNote value.
  // Previously duplicated in all three assistants (identical code).
  //
  // stm: { pitch: PPMTrie, interval: PPMTrie, sd: PPMTrie,
  //         contour: PPMTrie, linked: PPMTrie, recent: [] }
  function observeNoteSTM(pc, prevNote, stm, keyC) {
    stm.pitch.observe(pc);
    if (prevNote !== null) {
      var interval = ((pc - prevNote) % 12 + 12) % 12;
      if (interval > 6) interval -= 12;
      stm.interval.observe(interval + 12);
      var sd = ((pc - keyC) % 12 + 12) % 12;
      stm.sd.observe(sd);
      var contour = pc > prevNote ? 1 : pc < prevNote ? 0 : 2;
      stm.contour.observe(contour);
      stm.linked.observe((interval + 12) * 12 + sd);
    }
    stm.recent.push(pc);
    if (stm.recent.length > 12) stm.recent.shift();
    return pc;  // caller assigns to currentNote
  }

  // ── detectLoopInBuffer(pcs, config) ──
  // Autocorrelation-based loop detection on an array of pitch classes.
  // Returns { pattern: [pc,...], confidence: 0-1 } or null if no loop found.
  //
  // config: {
  //   minLength:    minimum buffer size to attempt detection (default 6)
  //   maxLag:       maximum loop length to search (default 16)
  //   threshold:    minimum correlation to accept (bass/rhythm: 0.6, solo: 0.7)
  // }
  //
  // Previously duplicated in all three assistants. Only differences were
  // the threshold (now a config param) and post-detection state management
  // (which stays in each assistant's closure).
  function detectLoopInBuffer(pcs, config) {
    var minLen = config.minLength || 6;
    var maxLag = config.maxLag || 16;
    var threshold = config.threshold || 0.6;

    if (pcs.length < minLen) return null;

    var n = pcs.length;
    var bestLag = 0;
    var bestCorr = 0;

    for (var lag = 2; lag <= Math.min(maxLag, Math.floor(n / 2)); lag++) {
      var matches = 0;
      var total = 0;
      for (var i = 0; i < n - lag; i++) {
        if (pcs[i] === pcs[i + lag]) matches++;
        total++;
      }
      var corr = total > 0 ? matches / total : 0;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    if (bestCorr > threshold && bestLag >= 2) {
      return {
        pattern: pcs.slice(-bestLag),
        confidence: bestCorr
      };
    }
    return null;
  }

  // ── buildPhraseSchedule(voiceName, notes, ioiRatios, bpm, barAlignConfig) ──
  // Shared phrase scheduling pattern used by tier_a_lexicon and tier_b_generate
  // in all three assistants. Handles bar-aligned delay and immediate scheduling.
  //
  // barAlignConfig: {
  //   enabled:      bool — check BarTracker at all?
  //   confThreshold: number — min BarTracker confidence (default 0.7)
  //   minDelay:     number — min beats delay to bother aligning (default 0.3)
  //   maxDelay:     number — max beats delay to wait (default 2.0)
  //   useStrongBeat: bool — target strong beat instead of downbeat (rhythm = true)
  // }
  //
  // Returns: { barDelay: number, scheduled: bool }
  //   barDelay > 0 means ALL notes go through Scheduler, first note returns null
  //   barDelay = 0 means first note returns immediately, rest through Scheduler
  function buildPhraseSchedule(voiceName, notes, ioiRatios, bpm, barAlignConfig) {
    var barDelay = 0;

    if (barAlignConfig && barAlignConfig.enabled &&
        typeof BarTracker !== 'undefined') {
      var confThreshold = barAlignConfig.confThreshold || 0.7;
      var minDel = barAlignConfig.minDelay || 0.3;
      var maxDel = barAlignConfig.maxDelay || 2.0;

      if (BarTracker.getBarConfidence() > confThreshold) {
        var beatsUntil = barAlignConfig.useStrongBeat ?
          BarTracker.getBeatsUntilStrongBeat() :
          BarTracker.getBeatsUntilDownbeat();
        if (beatsUntil > minDel && beatsUntil < maxDel) {
          barDelay = beatsUntil;
        }
      }
    }

    // Phase coupling temporal offset: adds Kuramoto-derived stagger
    // This creates actual temporal separation between voices based on
    // their oscillator phase — not just gate modulation.
    var phaseOffset = 0;
    if (typeof PhaseCoupling !== 'undefined') {
      phaseOffset = PhaseCoupling.getTemporalOffset(voiceName);
    }

    var totalDelay = barDelay + phaseOffset;

    // v2.3: Perception-based time — each voice's subjective time multiplier
    // scales IOI ratios so voices perceive tempo differently.
    // Bass stays near 1.0 (metronomic), soloist drifts most (rubato).
    var timeMult = 1.0;
    if (typeof BeliefState !== 'undefined' && BeliefState.getSubjectiveTimeMult) {
      timeMult = BeliefState.getSubjectiveTimeMult(voiceName);
    }

    if (totalDelay > 0) {
      // Delayed: schedule ALL notes, Scheduler handles everything
      Scheduler.schedulePhrase(voiceName, notes, ioiRatios, bpm, null, totalDelay, timeMult);
    } else {
      // Immediate: first note returns now, Scheduler handles rest
      Scheduler.schedulePhrase(
        voiceName,
        notes.slice(1),
        ioiRatios.slice(1),
        bpm,
        null,
        ioiRatios[0],
        timeMult
      );
    }

    // v8.6.0: Feed IOI ratios into MelodicExpectancy IOI STM (duration learning)
    if (ioiRatios && typeof MelodicExpectancy !== 'undefined' && MelodicExpectancy.observeIOI) {
      for (var _oi = 0; _oi < ioiRatios.length; _oi++) {
        if (ioiRatios[_oi] > 0) MelodicExpectancy.observeIOI(voiceName, ioiRatios[_oi]);
      }
    }

    return { barDelay: barDelay, phaseOffset: phaseOffset, scheduled: true };
  }

  // ═══ v9.3.0: 4-Dimensional Aesthetic Scoring ═══
  // Each dimension computes a sub-score from the phrase and context.
  // Neural models will replace these functions individually.
  // All dimension outputs are additive sub-scores (not normalized to [0,1]).

  // The dimension functions receive pre-computed shared factors via a 'shared' object
  // to avoid recomputing them. This keeps the hot path efficient.
  // shared = { startPC, contextFit, freqScore, interestScore, metricFit,
  //            sectionBonus, energyBonus, expectancyFit, ioiExpectancyFit, consensusData }

  // ── HARMONIC DIMENSION ──
  // How well does this phrase fit the harmonic context?
  // Structural: chord-tone landing, consensus grounding, damped tension (×0.3)
  // Melodic: approach-tone rewards, metric chord fit, full tension/trajectory targets
  function computeHarmonicDim(shared, entry, key, context, weights, isStructural, role) {
    var dim = 0;

    // Context fit (chord tone alignment of starting pitch)
    dim += shared.contextFit * (weights.contextFit || (isStructural ? 0.35 : 0.15));

    // Bass root fit
    var bassRootFit = 0;
    if (context.bassRoot !== null && context.bassRoot !== undefined) {
      var intervals = weights.bassRootIntervals || (isStructural ? [7] : [2, 5, 9]);
      var brBoost = weights.bassRootBoost || (isStructural ? 0.07 : 0.06);
      for (var bi = 0; bi < intervals.length; bi++) {
        if (shared.startPC === (context.bassRoot + intervals[bi]) % 12) {
          bassRootFit = brBoost;
          break;
        }
      }
      if (shared.startPC === context.bassRoot && bassRootFit < 0.1) bassRootFit = 0.1;
    }
    dim += bassRootFit;

    // Consensus bonus (structural: chord-tone landing; melodic: approach-tone rewards)
    var consensusBonus = 0;
    var cd = shared.consensusData;
    if (cd) {
      if (isStructural) {
        // Structural: land ON chord tones (Bharucha 1987, Parncutt 1989)
        consensusBonus += cd.interiorRatio * 0.06 * cd.conf;
        if (cd.endPC === cd.target) consensusBonus += 0.12 * cd.conf;
        else if (cd.endPC === cd.fifth) consensusBonus += 0.08 * cd.conf;
        else if (cd.endPC === cd.third) consensusBonus += 0.06 * cd.conf;
      } else {
        // Melodic: reward APPROACH tones (Lerdahl 2001: tonal tension/attraction)
        consensusBonus += cd.interiorRatio * 0.06 * cd.conf;
        var _semitoneAbove = (cd.target + 1) % 12;
        var _semitoneBelow = (cd.target + 11) % 12;
        var _wholeToneBelow = (cd.target + 10) % 12;
        if (cd.endPC === _semitoneBelow || cd.endPC === _semitoneAbove) {
          consensusBonus += 0.10 * cd.conf;
        } else if (cd.endPC === _wholeToneBelow) {
          consensusBonus += 0.06 * cd.conf;
        } else if (cd.endPC === cd.target) {
          consensusBonus += 0.08 * cd.conf;
        } else if (cd.endPC === cd.fifth) {
          consensusBonus += 0.05 * cd.conf;
        }
      }
    }
    dim += consensusBonus;

    // Metric-position chord-tone scoring (melodic only — GTTM, White 2017)
    if (!isStructural && context.chord && entry.ioi_ratios && entry.ioi_ratios.length > 0) {
      var _mcRoot = context.chord.rootPC;
      var _mcThird = (_mcRoot + (context.chord.type === 'minor' ? 3 : 4)) % 12;
      var _mcFifth = (_mcRoot + 7) % 12;
      var _mcSeventh = (_mcRoot + (context.chord.type === 'minor' ? 10 : 11)) % 12;
      var _mcChordTones = [_mcRoot, _mcThird, _mcFifth, _mcSeventh];
      var _metricPos = 0;
      var _mcHits = 0, _mcTotal = 0;
      for (var _mci = 0; _mci < entry.sd.length; _mci++) {
        var _beatFrac = _metricPos % 1.0;
        var _isStrongBeat = (_beatFrac < 0.15 || _beatFrac > 0.85);
        if (_isStrongBeat) {
          _mcTotal++;
          var _mcPC = (entry.sd[_mci] + key) % 12;
          var _isChordTone = false;
          for (var _mcj = 0; _mcj < _mcChordTones.length; _mcj++) {
            if (_mcPC === _mcChordTones[_mcj]) { _isChordTone = true; break; }
          }
          if (_isChordTone) _mcHits++;
        }
        if (_mci < entry.ioi_ratios.length) _metricPos += entry.ioi_ratios[_mci];
        else _metricPos += 1.0;
      }
      if (_mcTotal > 0) {
        var _mcRatio = _mcHits / _mcTotal;
        dim += Math.max(-0.12, Math.min(0.18, (_mcRatio - 0.4) * 0.30));
      }
    }

    // Tension-target phrase ending (Farbood 2012, Huron 2006)
    var tensionTargetBonus = 0;
    if (context.chord && entry.sd.length >= 2) {
      var _ttLevel = getTensionLevel(role);
      var _ttEndPC = (entry.sd[entry.sd.length - 1] + key) % 12;
      var _ttRoot = context.chord.rootPC;
      var _ttThird = (_ttRoot + (context.chord.type === 'minor' ? 3 : 4)) % 12;
      var _ttFifth = (_ttRoot + 7) % 12;
      var _ttIsResolving = (_ttEndPC === _ttRoot || _ttEndPC === _ttThird || _ttEndPC === _ttFifth);
      if (_ttLevel < 0.30) {
        tensionTargetBonus = _ttIsResolving ? -0.02 : 0.14;
      } else if (_ttLevel > 0.52) {
        tensionTargetBonus = _ttIsResolving ? 0.18 : -0.02;
      } else if (!isStructural && role === 'lead') {
        tensionTargetBonus = _ttIsResolving ? 0.08 : 0.0;
      }
    }
    dim += tensionTargetBonus * (isStructural ? 0.3 : 1.0);

    // Phrase-end target notes (Frieler 2019, Ford 2021)
    var phraseEndTargetBonus = 0;
    if (entry.sd.length >= 2 && typeof HarmonicPlanner !== 'undefined' && HarmonicPlanner.getNextChords) {
      var _nextChords = HarmonicPlanner.getNextChords();
      if (_nextChords && _nextChords.length > 0 && _nextChords[0].confidence > 0.3) {
        var _nc = _nextChords[0];
        if (_nc.beatsAway < 4) {
          var _ncRoot = _nc.rootPC;
          var _ncThird = (_ncRoot + (_nc.type === 'minor' ? 3 : 4)) % 12;
          var _ncSeventh = (_ncRoot + (_nc.type === 'minor' ? 10 : 11)) % 12;
          var _peEndPC = (entry.sd[entry.sd.length - 1] + key) % 12;
          var _peConf = _nc.confidence;

          if (isStructural) {
            if (_peEndPC === _ncRoot) phraseEndTargetBonus = 0.12 * _peConf;
            else if (_peEndPC === _ncThird) phraseEndTargetBonus = 0.10 * _peConf;
            else if (_peEndPC === _ncSeventh) phraseEndTargetBonus = 0.08 * _peConf;
          } else {
            // Melodic: full weight with tonic bias, tension modulation, section modulation
            if (_peEndPC === _ncRoot) phraseEndTargetBonus = 0.12 * _peConf;
            else if (_peEndPC === _ncThird) phraseEndTargetBonus = 0.10 * _peConf;
            else if (_peEndPC === _ncSeventh) phraseEndTargetBonus = 0.08 * _peConf;
            else {
              var _peApproach3 = ((_peEndPC - _ncThird + 12) % 12);
              var _peApproach7 = ((_peEndPC - _ncSeventh + 12) % 12);
              if (_peApproach3 === 1 || _peApproach3 === 11 || _peApproach7 === 1 || _peApproach7 === 11) {
                phraseEndTargetBonus = 0.06 * _peConf;
              }
            }
            // Lead tonic bias (Lerdahl & Jackendoff 1983: tonal closure)
            if (context.tonicBias > 0 && _peEndPC === _ncRoot) {
              phraseEndTargetBonus += context.tonicBias;
            }
            // Tension-aware modulation
            var _peTension = getTensionLevel(role);
            var _peIsResolving = (_peEndPC === _ncRoot || _peEndPC === _ncThird);
            var _peIsTension = (_peEndPC === _ncSeventh);
            if (_peTension < 0.30) {
              if (_peIsResolving) phraseEndTargetBonus *= 0.3;
              if (_peIsTension) phraseEndTargetBonus *= 1.5;
            } else if (_peTension > 0.52) {
              if (_peIsResolving) phraseEndTargetBonus *= 1.5;
              if (_peIsTension) phraseEndTargetBonus *= 0.5;
            }
            // Section modulation
            if (typeof SectionTracker !== 'undefined') {
              var _peSec = SectionTracker.getState().state;
              if (_peSec === 'BUILD' && _peEndPC === _ncSeventh) phraseEndTargetBonus += 0.03;
              else if (_peSec === 'RELEASE' && (_peEndPC === _ncRoot || _peEndPC === _ncThird)) phraseEndTargetBonus += 0.04;
            }
          }
        }
      }
    }
    dim += phraseEndTargetBonus * (isStructural ? 0.3 : 1.0);

    return dim;
  }

  // ── GROOVE DIMENSION ──
  // Does this phrase maintain rhythmic continuity?
  // Same computation for both structural and melodic paths.
  function computeGrooveDim(shared, entry, context, weights) {
    var dim = 0;
    // Loop bonus (groove continuity)
    dim += entry.loopable ? (weights.loopBonus || 0) : 0;
    // Metric fit (BarTracker alignment)
    dim += shared.metricFit;
    // Energy range fit
    dim += shared.energyBonus;
    return dim;
  }

  // ── INTEREST DIMENSION ──
  // Is this phrase musically novel and engaging?
  // Different weights per role but same computation.
  function computeInterestDim(shared, entry, context, weights) {
    var dim = 0;
    dim += shared.interestScore * (weights.interest || 0.20);
    dim += shared.freqScore * (weights.freq || 0.15);
    dim += shared.sectionBonus;
    dim += Math.random() * (weights.randomSpread || 0.10);
    return dim;
  }

  // ── EXPECTANCY DIMENSION ──
  // Does this phrase match learned/predicted patterns?
  // Structural: trajectory ×0.2 damped, section forecast only
  // Melodic: full trajectory with modulation momentum + section forecast
  function computeExpectancyDim(shared, entry, key, context, weights, isStructural, role) {
    var dim = 0;
    // Melodic expectancy (pitch prediction)
    dim += shared.expectancyFit;
    // IOI expectancy (timing prediction)
    dim += shared.ioiExpectancyFit;

    // Trajectory bonus
    var trajectoryBonus = 0;
    var _ens2 = context.ensembleContext;
    if (_ens2) {
      if (!isStructural) {
        // Melodic: full modulation momentum
        var mom = _ens2.modulationMomentum;
        if (mom && mom.predictedKey >= 0 && mom.confidence > 0.5) {
          var predKey = mom.predictedKey;
          var predFifth = (predKey + 7) % 12;
          for (var si = 0; si < entry.sd.length; si++) {
            var notePC = (entry.sd[si] + key) % 12;
            if (notePC === predKey) { trajectoryBonus += 0.06; break; }
            if (notePC === predFifth) { trajectoryBonus += 0.03; break; }
          }
        }
      }
      // Section forecast (both paths)
      var fcst = _ens2.sectionForecast;
      if (fcst && fcst.confidence > 0.5 && entry.sd.length >= 3) {
        var lastSD = entry.sd[entry.sd.length - 1];
        var firstSD = entry.sd[0];
        var contour = lastSD - firstSD;
        if (isStructural) {
          if (fcst.predictedState === 'STABLE' && Math.abs(contour) < 2) trajectoryBonus += 0.03;
        } else {
          if (fcst.predictedState === 'PEAK' && contour > 2) trajectoryBonus += 0.04;
          else if (fcst.predictedState === 'RELEASE' && contour < -2) trajectoryBonus += 0.04;
          else if (fcst.predictedState === 'STABLE' && Math.abs(contour) < 2) trajectoryBonus += 0.03;
        }
      }
    }
    dim += trajectoryBonus * (isStructural ? 0.2 : 1.0);

    return dim;
  }

  // ── MELODIC MODIFIERS ──
  // Post-dimension multiplicative modifiers for melodic voices only.
  // These don't map to a single dimension — they modulate the whole score.
  function computeMelodicModifiers(entry, key, context, role) {
    var lexRepMult = 1.0;
    var leadDiffMult = 1.0;
    var complementaryMult = 1.0;

    // Internal repetition penalty (Huron 2006: >25% consecutive unisons is monotonous)
    if (entry.sd.length >= 3) {
      var _lexRepCount = 0;
      for (var _lri = 1; _lri < entry.sd.length; _lri++) {
        if (entry.sd[_lri] === entry.sd[_lri - 1]) _lexRepCount++;
      }
      var _lexRepRate = _lexRepCount / (entry.sd.length - 1);
      if (_lexRepRate > 0.25) {
        lexRepMult = Math.max(0.3, 1.0 - (_lexRepRate - 0.25) * 2.0);
      }
    }

    // Lead differentiation — interval scoring vs ALL peers (Huron 2001, Bregman 1990)
    if (role === 'lead' && typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getPeerRecentPCs) {
      var _peerVoices = ['bass', 'rhythm', 'soloist'];
      var _peerPCs = [];
      for (var _pvi = 0; _pvi < _peerVoices.length; _pvi++) {
        var _pvRecent = ContextIntegrator.getPeerRecentPCs(_peerVoices[_pvi]);
        if (_pvRecent && _pvRecent.length > 0) _peerPCs.push(_pvRecent[_pvRecent.length - 1]);
      }
      if (_peerPCs.length > 0) {
        var _ldTotal = 0;
        for (var _ldi = 0; _ldi < entry.sd.length; _ldi++) {
          var _ldPC = (entry.sd[_ldi] + key) % 12;
          var _ldNoteScore = 0;
          for (var _ldj = 0; _ldj < _peerPCs.length; _ldj++) {
            var _ldInterval = Math.abs(_ldPC - _peerPCs[_ldj]);
            if (_ldInterval > 6) _ldInterval = 12 - _ldInterval;
            if (_ldInterval === 3 || _ldInterval === 4) _ldNoteScore += 0.15;
            else if (_ldInterval === 5) _ldNoteScore += 0.06;
            else if (_ldInterval === 6) _ldNoteScore += 0.02;
            else if (_ldInterval === 0) _ldNoteScore -= 0.20;
            else if (_ldInterval === 1 || _ldInterval === 2) _ldNoteScore -= 0.10;
          }
          _ldTotal += _ldNoteScore / _peerPCs.length;
        }
        var leadDiffBonus = _ldTotal / entry.sd.length;
        if (leadDiffBonus !== 0) {
          leadDiffMult = Math.max(0.3, 1.0 + leadDiffBonus * 3.0);
        }
      }
    }

    // Complementary harmony — lead fills UNOCCUPIED chord tones (Hodson 2007)
    if (role === 'lead' && context.chord && typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getPeerRecentPCs) {
      var _chPeerData = ContextIntegrator.getPeerRecentPCs('lead');
      if (_chPeerData) {
        var _chRoot = context.chord.rootPC;
        var _chThird = (_chRoot + (context.chord.type === 'minor' ? 3 : 4)) % 12;
        var _chFifth = (_chRoot + 7) % 12;
        var _chSeventh = (_chRoot + (context.chord.type === 'minor' ? 10 : 11)) % 12;
        var _chTones = [_chRoot, _chThird, _chFifth, _chSeventh];
        var _chOccupied = {};
        var _chVoices = ['bass', 'rhythm', 'soloist'];
        for (var _chi = 0; _chi < _chVoices.length; _chi++) {
          var _chArr = _chPeerData[_chVoices[_chi]];
          if (_chArr && _chArr.length > 0) {
            var _chStart = Math.max(0, _chArr.length - 2);
            for (var _chj = _chStart; _chj < _chArr.length; _chj++) {
              _chOccupied[_chArr[_chj]] = true;
            }
          }
        }
        var _chGaps = [];
        for (var _chk = 0; _chk < _chTones.length; _chk++) {
          if (!_chOccupied[_chTones[_chk]]) _chGaps.push(_chTones[_chk]);
        }
        if (_chGaps.length > 0 && _chGaps.length < 4) {
          var _chHits = 0, _chDups = 0, _chCount = 0;
          for (var _chl = 0; _chl < entry.sd.length; _chl++) {
            var _chPC = (entry.sd[_chl] + key) % 12;
            var _chIsChordTone = false;
            for (var _chm = 0; _chm < _chTones.length; _chm++) {
              if (_chPC === _chTones[_chm]) { _chIsChordTone = true; break; }
            }
            if (_chIsChordTone) {
              _chCount++;
              var _chIsGap = false;
              for (var _chn = 0; _chn < _chGaps.length; _chn++) {
                if (_chPC === _chGaps[_chn]) { _chIsGap = true; break; }
              }
              if (_chIsGap) _chHits++;
              else _chDups++;
            }
          }
          if (_chCount > 0) {
            var complementaryBonus = (_chHits - _chDups * 0.5) / _chCount;
            complementaryBonus *= 0.15;
            if (complementaryBonus !== 0) {
              complementaryMult = Math.max(0.5, 1.0 + complementaryBonus * 2.5);
            }
          }
        }
      }
    }

    return { lexRepMult: lexRepMult, leadDiffMult: leadDiffMult, complementaryMult: complementaryMult };
  }

  // ── scoreLexiconEntry(entry, key, context, weights) ──
  // v9.3.0: Refactored into 4 aesthetic dimensions + post-dimension modifiers.
  // Each dimension is independently replaceable by a neural model.
  //
  // Returns: { score: number, passed: bool } — passed=false means scaleFit gate failed
  function scoreLexiconEntry(entry, key, context, weights) {
    if (!entry.sd || entry.sd.length < 2) return { score: 0, passed: false };

    // ── ScaleFit gate ──
    _refreshScaleCache();
    var inScaleCount = 0;
    for (var si = 0; si < entry.sd.length; si++) {
      if (_cachedScaleSet.has((entry.sd[si] + key) % 12)) inScaleCount++;
    }
    var scaleFitMin = weights.scaleFitMin || 0.7;
    // v3 Phase 1: Per-voice dynamic scaleFitMin when key confidence is low
    var _role = context.role || null;
    // v8.16.0: Hoist role classification for factor gating (Temperley 2007, Lerdahl 2001)
    var _isStructuralVoice = (_role === 'bass' || _role === 'rhythm' || _role === 'percussion');
    if (_role && typeof KeyBelief !== 'undefined' && KeyBelief.shouldUseSoftFit(_role)) {
      scaleFitMin = KeyBelief.getScaleFitMin(_role);
    }
    // v5 Phase 4b: Mood surprise — high harmonic tension lowers scaleFit gate (Lerdahl 2001)
    // Distant keys → more adventurous phrase selection (allow more chromaticism)
    if (_role && typeof MoodState !== 'undefined' && MoodState.getSurpriseBoost) {
      var _surpriseBoost = MoodState.getSurpriseBoost(_role);
      scaleFitMin = Math.max(0.35, scaleFitMin - _surpriseBoost);  // max -0.12 at tritone
    }
    var scaleFitRatio = inScaleCount / entry.sd.length;
    if (scaleFitRatio < scaleFitMin) {
      return { score: 0, passed: false };
    }

    // ── Soft scaleFit via key distribution (when available) ──
    // Instead of binary pass/fail against a single key, compute expected
    // scale-fit across the full key probability distribution.
    var softScaleFit = 1.0;
    // v3 Phase 1: Auto-inject per-voice distribution when confidence is low
    var _keyDist = weights.keyDistribution || null;
    if (!_keyDist && _role && typeof KeyBelief !== 'undefined' && KeyBelief.shouldUseSoftFit(_role)) {
      _keyDist = KeyBelief.getDistribution(_role);
    }
    if (_keyDist) {
      var dist = _keyDist.distribution;
      var _numModes = (typeof MODE_NAMES !== 'undefined') ? MODE_NAMES.length : 7;
      var expectedFit = 0;
      for (var ki = 0; ki < dist.length; ki++) {
        if (dist[ki] < 0.01) continue;  // skip negligible keys
        var kRoot = Math.floor(ki / _numModes);
        var kModeName = (typeof MODE_NAMES !== 'undefined') ? MODE_NAMES[ki % _numModes]
          : (ki % _numModes === 0 ? 'major' : 'minor');
        var kScale = new Set(getScale(kRoot, kModeName));
        var fit = 0;
        for (var si2 = 0; si2 < entry.sd.length; si2++) {
          if (kScale.has((entry.sd[si2] + kRoot) % 12)) fit++;
        }
        expectedFit += dist[ki] * (fit / entry.sd.length);
      }
      // Scale from 0.7-1.0 range to 0.8-1.2 score multiplier
      softScaleFit = 0.8 + expectedFit * 0.4;
    }


    // ═══ v9.0.0: Role-differentiated scoring paths ═══
    // Split from monolithic 20+ factor formula into two clean paths:
    //   Structural (bass/rhythm/percussion): "What does the harmony need?"
    //   Melodic (soloist/lead): "What does the story need?"
    // Shared factors computed once, then combined with path-specific weights.
    // This resolves the groupthink-vs-variety tension structurally:
    // structural voices converge on chord tones, melodic voices diverge with taste.

    // ── Shared factor computation (used by both paths) ──
    var startPC = (entry.sd[0] + key) % 12;

    // Frequency score (diminishing returns)
    var freqScore = Math.log1p(entry.frequency) / 10;

    // Interest score
    var interestScore = entry.interest || 0.5;

    // Context fit: does the phrase start on a chord tone?
    var contextFit = 0.5;
    if (context.chord) {
      var chRoot = context.chord.rootPC;
      var chThird = (chRoot + (context.chord.type === 'minor' ? 3 : 4)) % 12;
      var chFifth = (chRoot + 7) % 12;
      if (startPC === chRoot) contextFit = 1.0;
      else if (startPC === chFifth) contextFit = 0.85;
      else if (startPC === chThird) contextFit = 0.7;

      // Per-voice harmonic blending via KeyBelief
      var _ens = context.ensembleContext;
      if (_ens && _ens.voiceKeyBelief) {
        var _div = _ens.keyDivergence || 0;
        var _hbo = (typeof HARMONY_BLEND_ONSET !== 'undefined') ? HARMONY_BLEND_ONSET : 0.05;
        var _hbr = (typeof HARMONY_BLEND_RANGE !== 'undefined') ? HARMONY_BLEND_RANGE : 0.6;
        var _hbm = (typeof HARMONY_BLEND_MAX !== 'undefined') ? HARMONY_BLEND_MAX : 0.5;
        var _bw = Math.min(Math.max((_div - _hbo) / _hbr, 0), 1.0) * _hbm;
        if (_bw > 0.001) {
          var _vkb = _ens.voiceKeyBelief;
          if (_vkb.topKey !== undefined) {
            var vRoot = _vkb.topKey;
            var vMode = _vkb.topMode || 'minor';
            var vThird = (vRoot + (vMode === 'minor' ? 3 : 4)) % 12;
            var vFifth = (vRoot + 7) % 12;
            var voiceFit = 0.5;
            if (startPC === vRoot) voiceFit = 1.0;
            else if (startPC === vFifth) voiceFit = 0.85;
            else if (startPC === vThird) voiceFit = 0.7;
            contextFit = contextFit * (1 - _bw) + voiceFit * _bw;
          }
        }
      }
    }

    // Saturation penalty
    if (context.saturatedPCs && context.saturatedPCs.indexOf(startPC) >= 0) {
      contextFit *= 0.85;
    }

    // Metric fit (BarTracker)
    var metricFit = 0;
    if (typeof BarTracker !== 'undefined' && BarTracker.getBarConfidence() > 0.03) {
      var phraseDurBeats = entry.sd.length - 1;
      if (entry.ioi_ratios && entry.ioi_ratios.length > 0) {
        phraseDurBeats = 0;
        for (var ri = 0; ri < entry.ioi_ratios.length; ri++) {
          phraseDurBeats += entry.ioi_ratios[ri];
        }
      }
      metricFit = BarTracker.scorePhraseMetric(
        phraseDurBeats,
        weights.metricStartW || 0.5,
        weights.metricEndW || 0.5
      ) * (weights.metricScale || 0.15);
    }

    // Section affinity
    var sectionBonus = 0;
    if (entry.section_affinity && context.sectionState) {
      sectionBonus = (entry.section_affinity.indexOf(context.sectionState) >= 0) ? 0.12 : -0.04;
    }

    // Energy range fit
    var energyBonus = 0;
    if (entry.energy_range && context.sectionEnergy !== undefined) {
      var eLo = entry.energy_range[0], eHi = entry.energy_range[1];
      if (context.sectionEnergy >= eLo && context.sectionEnergy <= eHi) {
        energyBonus = 0.10;
      } else {
        var eDist = Math.min(Math.abs(context.sectionEnergy - eLo), Math.abs(context.sectionEnergy - eHi));
        energyBonus = -0.05 * eDist;
      }
    }

    // Expectancy fit (MelodicExpectancy prediction)
    var expectancyFit = 0;
    if (typeof MelodicExpectancy !== 'undefined' && MelodicExpectancy.predict) {
      var _pred = MelodicExpectancy.predict(context.role);
      if (_pred && _pred.dist) {
        var _expSum = 0;
        for (var _ei = 0; _ei < entry.sd.length; _ei++) {
          var _ePC = (entry.sd[_ei] + key) % 12;
          _expSum += _pred.dist[_ePC] || 0;
        }
        var _avgProb = _expSum / entry.sd.length;
        expectancyFit = Math.min(0.20, _avgProb * 0.40);
      }
    }

    // IOI expectancy fit
    var ioiExpectancyFit = 0;
    var _ioiScoringEnabled = (typeof IOI_GENERATION_ENABLED !== 'undefined') ? IOI_GENERATION_ENABLED : false;
    if (_ioiScoringEnabled && typeof MelodicExpectancy !== 'undefined' && MelodicExpectancy.predictIOI &&
        entry.ioi_ratios && entry.ioi_ratios.length > 0) {
      var _ioiPred = MelodicExpectancy.predictIOI(context.role);
      if (_ioiPred && _ioiPred.dist) {
        var _ioiSum = 0;
        for (var _ii = 0; _ii < entry.ioi_ratios.length; _ii++) {
          var _ioiBin = MelodicExpectancy.quantizeIOI(entry.ioi_ratios[_ii]);
          _ioiSum += _ioiPred.dist[_ioiBin] || 0;
        }
        var _ioiAvgProb = _ioiSum / entry.ioi_ratios.length;
        ioiExpectancyFit = Math.min(0.15, _ioiAvgProb * 0.30);
      }
    }

    // Harmonic consensus pre-computation (shared, role-differentiated application below)
    var _consensusMultiplier = (context.bassGrounding === false) ? 1.6 : 1.0;
    var _consensusData = null;
    if (context.harmonicConsensus && entry.sd.length >= 2) {
      var _cTarget = context.harmonicConsensus.targetPC;
      var _cConf = (context.harmonicConsensus.confidence || 0) * _consensusMultiplier;
      if (_cConf > 0.3) {
        var _cFifth = (_cTarget + 7) % 12;
        var _cThird = (_cTarget + (context.harmonicConsensus.targetType === 'minor' ? 3 : 4)) % 12;
        var _endPC = (entry.sd[entry.sd.length - 1] + key) % 12;
        // Interior harmonic grounding (shared)
        var _interiorFit = 0;
        var _interiorChecks = 0;
        var _cChordSet = [_cTarget, _cThird, _cFifth];
        for (var _ci = 0; _ci < entry.sd.length - 1; _ci += 2) {
          var _ciPC = (entry.sd[_ci] + key) % 12;
          _interiorChecks++;
          for (var _cj = 0; _cj < _cChordSet.length; _cj++) {
            if (_ciPC === _cChordSet[_cj]) { _interiorFit++; break; }
          }
        }
        var _interiorRatio = _interiorChecks > 0 ? _interiorFit / _interiorChecks : 0;
        _consensusData = {
          target: _cTarget, third: _cThird, fifth: _cFifth,
          conf: _cConf, endPC: _endPC, interiorRatio: _interiorRatio
        };
      }
    }

    // ═══ v9.3.0: 4-Dimensional Aesthetic Scoring ═══
    // Shared pre-computed values passed to dimension functions
    var _shared = {
      startPC: startPC,
      contextFit: contextFit,
      freqScore: freqScore,
      interestScore: interestScore,
      metricFit: metricFit,
      sectionBonus: sectionBonus,
      energyBonus: energyBonus,
      expectancyFit: expectancyFit,
      ioiExpectancyFit: ioiExpectancyFit,
      consensusData: _consensusData
    };

    // Compute 4 dimensions
    var harmonicDim = computeHarmonicDim(_shared, entry, key, context, weights, _isStructuralVoice, _role);
    var grooveDim = computeGrooveDim(_shared, entry, context, weights);
    var interestDim = computeInterestDim(_shared, entry, context, weights);
    var expectancyDim = computeExpectancyDim(_shared, entry, key, context, weights, _isStructuralVoice, _role);

    // Combine dimensions (all weights 1.0 = behavioral equivalence with pre-S2 scorer)
    var _dimW = (typeof AESTHETIC_DIMENSIONS !== 'undefined' && AESTHETIC_DIMENSIONS[_role])
      ? AESTHETIC_DIMENSIONS[_role] : { harmonic: 1.0, groove: 1.0, interest: 1.0, expectancy: 1.0 };
    var score = (harmonicDim * _dimW.harmonic +
                 grooveDim * _dimW.groove +
                 interestDim * _dimW.interest +
                 expectancyDim * _dimW.expectancy) * softScaleFit;

    // Post-dimension multiplicative modifiers (melodic voices only)
    if (!_isStructuralVoice) {
      var _mods = computeMelodicModifiers(entry, key, context, _role);
      score *= _mods.lexRepMult * _mods.leadDiffMult * _mods.complementaryMult;
    }

    // ═══ SHARED POST-SCORING (both paths) ═══
    // Role-specific extra scoring (personality layer)
    if (weights.extraScorer) {
      score += weights.extraScorer(entry, key, score, context.ensembleContext || null);
    }

    // Peer complementarity scoring (register separation, density, figure-ground)
    if (typeof PeerModel !== 'undefined' && PeerModel.getComplementaryBonus) {
      score += PeerModel.getComplementaryBonus(context.role, entry.sd, key);
    }

    // FGSR: selective listening response (Sawyer 2003: max 0.10)
    if (typeof PeerModel !== 'undefined' && PeerModel.getPeerFeatureResponse) {
      score += PeerModel.getPeerFeatureResponse(context.role, entry.sd, key);
    }

    // Motivic relationship bonus (SharedPhraseMemory contour similarity)
    if (typeof SharedPhraseMemory !== 'undefined' && entry.sd) {
      score += SharedPhraseMemory.getMotivicBonus(entry.sd);
    }

    // v9.0.0: Thematic memory bonus — session-scale motif callback
    // (Margulis 2014: repetition creates meaning across time)
    // Phase-modulated: low in exposition, high in recapitulation
    if (typeof ThematicMemory !== 'undefined' && entry.sd) {
      score += ThematicMemory.getThematicBonus(entry.sd, name);
    }

    return { score: score, passed: true };
  }

  // ── selectFromCandidates(candidates, topN) ──
  // Sort by score, pick randomly from top N. Shared pattern.
  function selectFromCandidates(candidates, topN) {
    if (candidates.length === 0) return null;
    candidates.sort(function(a, b) { return b.score - a.score; });
    var idx = Math.min(Math.floor(Math.random() * (topN || 5)), candidates.length - 1);
    return candidates[idx];
  }

  // ═══════════════════════════════════════════════════════════════════
  // createVoiceAgent(config) — v4 Phase 1 shared assistant scaffold
  // ═══════════════════════════════════════════════════════════════════
  //
  // Factory that builds a pitch-voice agent with shared infrastructure.
  // Each assistant file defines role-specific config + hooks, then calls
  // this factory to get a fully functional agent object.
  //
  // config: {
  //   name:              'bass',
  //   scopeMultiplier:   0.5,
  //   lexiconKey:        'bass_lexicon',      // key in combined genre JSON
  //   lexiconFallbacks:  [],                  // e.g. ['rhythm_lexicon'] for lead
  //   loopConfig:        { threshold, decay, minConfidence, minBufferLen, maxLag },
  //   phraseWeights:     { freq, interest, contextFit, loopBonus, ... },
  //   recentPhraseMemory: 5,
  //   ownershipCheck:    true,                // false for lead
  //   observeOwnOutput:  false,               // true for soloist
  //   bpmUseScopeMultiplier: true,            // multiply BPM by scope.multiplier for scheduling
  //   hooks: {
  //     onObservePlayer:  fn(agent, pc, time),
  //     preGate:          fn(agent, dt) -> null|'skip',
  //     postGap:          fn(agent, dt) -> null|'skip',
  //     tierCascade:      fn(agent) -> result|null,
  //     tier3Bias:        fn(agent, probs, stm),
  //     onReset:          fn(agent),
  //     onResult:         fn(agent, result),
  //   }
  // }

  // v9.3.0: _getHarmonicConsensus REMOVED — migrated to ChordBelief.getConsensus().
  // Harmonic intent publishing migrated to ChordBelief.publishIntent().
  // Single harmonic truth source: ChordBelief handles both evidential and intentional layers.

  function createVoiceAgent(config) {
    var name = config.name;

    // ── Internal state ──
    var scope = new TemporalScope(config.scopeMultiplier || 1.0);
    var stm = {
      pitch: new PPMTrie(4), interval: new PPMTrie(3), sd: new PPMTrie(3),
      contour: new PPMTrie(4), linked: new PPMTrie(3), recent: []
    };
    var currentNote = null;
    var lastHumanTime = 0;
    var patternBuffer = [];
    var loopPattern = null;
    var loopIdx = 0;
    var loopConfidence = 0;
    var lc = (typeof LOOP_CONFIG !== 'undefined' && LOOP_CONFIG[name]) ? LOOP_CONFIG[name] :
      { threshold: 0.6, decay: 0.95, minConfidence: 0.5, minBufferLen: 6, maxLag: 16 };
    if (config.loopConfig) {
      for (var k in config.loopConfig) lc[k] = config.loopConfig[k];
    }
    var lexicon = [];
    var lexiconLoaded = false;
    var currentPhrase = null;
    var lastPhraseTime = 0;
    var recentPhraseIds = [];

    // ── V7 Phase 0: Gate diagnostic counters ──
    var _gateCounters = {
      ticks: 0, raceBlock: 0, preGateBlock: 0, beliefBlock: 0,
      scopeBlock: 0, phraseGapBlock: 0, postGapBlock: 0, staggerBlock: 0,
      stateBypass: 0, tierFail: 0, activePhrase: 0, produced: 0
    };
    var _gateLogTimer = 0;

    // v8.2 Fix 5: Post-phrase evaluation (Phase 1: diagnostic only)
    // Tracks whether phrases achieved their intended musical effect.
    // Uses belief vector distance, entropy change, and dominant-need shift
    // since single-need delta near equilibrium rounds to 0.
    var _phraseOutcomes = [];
    var OUTCOME_BUFFER_SIZE = 32;

    // ── V7 Phase 8A: Phrase Monitor ──
    // Substitutes non-chord-tones on strong beats mid-phrase.
    // Max 2 subs per phrase, within 2 semitones, preserving contour.
    var _monitorSubCount = 0;
    var _monitorLastPhraseIdx = -1;
    var MONITOR_MAX_SUBS = 2;

    function monitorNote(pc, voiceName) {
      if (typeof HarmonicPlanner === 'undefined' || !HarmonicPlanner.getCurrentContext) return pc;
      var ctx = HarmonicPlanner.getCurrentContext();
      if (!ctx || !ctx.chordTones || ctx.chordTones.length === 0) return pc;

      // Reset sub counter on new phrase
      var phraseCtx = Scheduler.getPhraseContext(voiceName);
      if (!phraseCtx) return pc;
      if (phraseCtx.currentIdx <= 1 || phraseCtx.currentIdx < _monitorLastPhraseIdx) {
        _monitorSubCount = 0;
      }
      _monitorLastPhraseIdx = phraseCtx.currentIdx;

      // Already at max substitutions for this phrase
      if (_monitorSubCount >= MONITOR_MAX_SUBS) return pc;

      // Only substitute on strong beats (first 25% and around 50% of phrase)
      var progress = phraseCtx.currentIdx / phraseCtx.totalNotes;
      var isStrongBeat = (progress < 0.15) || (progress > 0.45 && progress < 0.60);
      if (!isStrongBeat) return pc;

      // Check if current PC is a chord tone
      var isChordTone = false;
      for (var i = 0; i < ctx.chordTones.length; i++) {
        if (pc === ctx.chordTones[i]) { isChordTone = true; break; }
      }
      if (isChordTone) return pc;

      // Find nearest chord tone within 2 semitones that preserves contour
      var prevPC = phraseCtx.prevPC;
      var bestPC = -1;
      var bestScore = -1;

      for (var c = 0; c < ctx.chordTones.length; c++) {
        var ct = ctx.chordTones[c];
        var dist = Math.min(Math.abs(ct - pc), 12 - Math.abs(ct - pc));
        if (dist > 2) continue;  // only within 2 semitones

        // Preserve contour direction relative to previous note
        if (prevPC !== null) {
          var origDir = ((pc - prevPC + 12) % 12 > 6) ? -1 : 1;
          var subDir = ((ct - prevPC + 12) % 12 > 6) ? -1 : 1;
          if (origDir !== subDir && dist > 1) continue;  // would reverse contour
        }

        // Score: prefer closest, break ties with expectancy
        var score = (3 - dist);  // closeness: 3 for same, 2 for 1st, 1 for 2nd
        if (typeof MelodicExpectancy !== 'undefined' && MelodicExpectancy.predict) {
          var pred = MelodicExpectancy.predict(voiceName);
          if (pred && pred.dist) {
            score += pred.dist[ct] * 2.0;  // expectancy tiebreaker
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestPC = ct;
        }
      }

      if (bestPC >= 0 && bestPC !== pc) {
        _monitorSubCount++;
        return bestPC;
      }

      return pc;  // no valid substitution found — pass through
    }

    // ── V7 Phase 8D: Dynamic Expression ──
    // Computes per-note velocity and duration shaping based on phrase position,
    // harmonic function, arc phase, beat weight, and peer density.
    function computeExpression(pc, voiceName) {
      var velMult = 1.0;
      var durMult = 1.0;
      // v8.2 Fix 1: Read committed context if available; fall back to live state
      var ctx = currentPhrase ? currentPhrase._commitContext : null;

      // Phrase progress (0-1) — correctly live (tracks current position)
      var progress = Scheduler.getPhraseProgress(voiceName);
      var phraseCtx = Scheduler.getPhraseContext(voiceName);
      var totalNotes = phraseCtx ? phraseCtx.totalNotes : 8;

      // (a) Phrase arch (Sundberg 1987): parabolic velocity curve, peak at 60%
      var archCenter = 0.6;
      var archHeight = 0.12;
      var archDev = progress - archCenter;
      velMult += archHeight * Math.max(0, 1.0 - 4.0 * archDev * archDev);

      // (b) Harmonic function: chord tones slightly louder, passing tones softer
      // Stays LIVE — harmonic reality-check should track current harmony
      if (typeof HarmonicPlanner !== 'undefined' && HarmonicPlanner.getCurrentContext) {
        var hCtx = HarmonicPlanner.getCurrentContext();
        if (hCtx && hCtx.chordTones) {
          var isChord = false;
          for (var ci = 0; ci < hCtx.chordTones.length; ci++) {
            if (pc === hCtx.chordTones[ci]) { isChord = true; break; }
          }
          velMult += isChord ? 0.06 : -0.04;
        }
      }

      // (c) Arc phase energy: use committed context (phrase character stays consistent)
      var arcEnergy = 1.0;
      if (ctx && ctx.arcEnergy !== undefined) {
        arcEnergy = ctx.arcEnergy;
      } else if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getEnergyModifier) {
        arcEnergy = NarrativeArc.getEnergyModifier(voiceName);
      }
      velMult *= 0.85 + 0.15 * arcEnergy;

      // (d) Beat weight: downbeat emphasis — stays LIVE (tracks actual bar position)
      if (typeof BarTracker !== 'undefined' && BarTracker.getBarPhase) {
        var barPhase = BarTracker.getBarPhase();
        if (barPhase < 0.1 || barPhase > 0.95) velMult += 0.04;  // downbeat
        else if (barPhase > 0.45 && barPhase < 0.55) velMult += 0.02;  // backbeat
      }

      // (e) Peer density: removed PeerModel.getActivePeerCount (doesn't exist)
      // Peer density modulation deferred until PeerModel exposes a count API

      // (f) Duration shaping: phrase-ending ritardando, section feel
      if (phraseCtx && phraseCtx.currentIdx >= totalNotes - 2) {
        durMult = 1.25;  // last 2 notes slightly longer
      }
      // Use committed section state (phrase plays with consistent character)
      var secState = null;
      if (ctx && ctx.sectionState) {
        secState = ctx.sectionState.state || null;
      } else if (typeof SectionTracker !== 'undefined') {
        try { secState = SectionTracker.getVoiceState(voiceName).state; } catch (e) {}
      }
      if (secState === 'RELEASE') durMult *= 1.15;
      else if (secState === 'PEAK') durMult *= 0.88;

      // (g) Conviction expression (Juslin 2003 GERMS): conviction modulates
      // articulation + dynamics. High conviction = legato/confident, low = staccato/tentative.
      if (typeof ConvictionExpression !== 'undefined' && ConvictionExpression.getExpressionMod) {
        var _cvMod = ConvictionExpression.getExpressionMod(voiceName);
        velMult *= _cvMod.velocityMult;
        durMult *= _cvMod.durationMult;
        // Velocity variance: controlled randomness proportional to uncertainty (Palmer 1997)
        if (_cvMod.velocityVariance > 0.01) {
          velMult += (Math.random() - 0.5) * _cvMod.velocityVariance * 2;
        }
      }

      return {
        velocityMult: Math.max(0.5, Math.min(1.4, velMult)),
        durationMult: Math.max(0.7, Math.min(1.5, durMult))
      };
    }

    // v8.2 Fix 1: Capture musical context at phrase commitment time.
    // Expression shaping reads from this snapshot instead of live state,
    // so a phrase generated for 'establish' doesn't get shaped for 'climax'
    // if the arc transitions mid-phrase. Beat weight stays live (correctly reactive).
    function _captureCommitContext() {
      return {
        arcEnergy: (typeof NarrativeArc !== 'undefined' && NarrativeArc.getEnergyModifier) ?
          NarrativeArc.getEnergyModifier(name) : 1.0,
        sectionState: (typeof SectionTracker !== 'undefined' && SectionTracker.getVoiceState) ?
          SectionTracker.getVoiceState(name) : null,
        intent: (typeof MelodicIntent !== 'undefined') ? MelodicIntent.getIntent(name) : null,
        beliefSnapshot: (typeof BeliefState !== 'undefined') ? BeliefState.getBelief(name) : null,
        commitTime: Date.now()
      };
    }

    // v3 Phase 3: Ensemble context cache
    var _cachedEns = null;
    var _ensCacheTime = 0;

    var hooks = config.hooks || {};

    // ── Ensemble context (shared) ──
    function refreshEnsembleContext() {
      var now = Date.now();
      var ttl = (typeof ENSEMBLE_CACHE_TTL !== 'undefined') ? ENSEMBLE_CACHE_TTL : 250;
      if (_cachedEns && now - _ensCacheTime < ttl) return _cachedEns;
      _ensCacheTime = now;
      _cachedEns = {
        snapshot: (typeof ContextIntegrator !== 'undefined') ? ContextIntegrator.getEnsembleSnapshot() : null,
        voiceKeyBelief: (typeof KeyBelief !== 'undefined') ? KeyBelief.getDistribution(name) : null,
        voiceConfidence: (typeof KeyBelief !== 'undefined') ? KeyBelief.getConfidence(name) : 0,
        keyDivergence: (typeof KeyBelief !== 'undefined') ? KeyBelief.getDivergence() : 0,
        peerRecentPCs: (typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getPeerRecentPCs) ? ContextIntegrator.getPeerRecentPCs(name) : null,
        melodicIntent: (typeof MelodicIntent !== 'undefined') ? MelodicIntent.getIntent(name) : null,
        contrastOpportunity: (typeof ContextIntegrator !== 'undefined') ? ContextIntegrator.getContrastOpportunity(name) : 0.5,
        peerVelocity: (typeof PeerVelocity !== 'undefined') ? PeerVelocity.getVelocity(name) : 1.0,
        orderParameter: (typeof PhaseCoupling !== 'undefined') ? PhaseCoupling.getOrderParameter() : 0,
        dialogueStance: (typeof DialogueEngine !== 'undefined') ? DialogueEngine.getStance() : null,
        // v5 Phase 3: Harmonic foresight
        modulationMomentum: (typeof KeyBelief !== 'undefined' && KeyBelief.getModulationMomentum) ? KeyBelief.getModulationMomentum(name) : null,
        sectionForecast: (typeof SectionTracker !== 'undefined' && SectionTracker.getForecast) ? SectionTracker.getForecast(name) : null,
        // v5 Phase 4: Narrative arc
        narrativeArc: (typeof NarrativeArc !== 'undefined' && NarrativeArc.getArc) ? NarrativeArc.getArc(name) : null,
        // v5 Phase 4b: Mood state
        mood: (typeof MoodState !== 'undefined' && MoodState.getMood) ? MoodState.getMood(name) : null,
        // v5 Phase 5: Peer intelligence
        ensembleVariation: (typeof PeerModel !== 'undefined' && PeerModel.getEnsembleVariation) ? PeerModel.getEnsembleVariation() : null,
        anticipatedSpace: (typeof PeerModel !== 'undefined' && PeerModel.getAnticipatedSpace) ? PeerModel.getAnticipatedSpace(name) : 2000,
        // v8.8.0: Section state for extraScorer section-dependent behavior
        sectionState: (typeof SectionTracker !== 'undefined') ? (SectionTracker.getState().state || 'STABLE') : 'STABLE'
      };
      return _cachedEns;
    }

    // ── Lexicon loading (shared) ──
    // Three-tier cascade: per-artist per-role → generic per-role → genre fallback
    function _applyLexicon(src, label) {
      lexicon = src;
      lexiconLoaded = true;
      console.log(name.charAt(0).toUpperCase() + name.slice(1) + ' lexicon loaded (' + label + '): ' + lexicon.length + ' patterns');
      if (typeof PhraseGenerator !== 'undefined') {
        PhraseGenerator.learnFromLexicon(lexicon, name);
      }
    }
    function _extractPatterns(data) {
      var src = data.patterns || data[config.lexiconKey || (name + '_lexicon')];
      if (!src && config.lexiconFallbacks) {
        for (var fi = 0; fi < config.lexiconFallbacks.length; fi++) {
          src = data[config.lexiconFallbacks[fi]];
          if (src) break;
        }
      }
      return (src && Array.isArray(src) && src.length > 0) ? src : null;
    }
    // Genre family map — sparse roles fall back to merged family lexicon before generic root
    var _GENRE_FAMILY = { bach: 'classical', mozart: 'classical', beethoven: 'classical' };

    function loadLexicon(genre) {
      function _loadTier2() {
        // Tier 2: generic per-role (e.g. roles/bass.json)
        var rolePath = 'data/Lexicon/roles/' + name + '.json';
        fetch(rolePath).then(function(r) {
          if (!r.ok) throw new Error('no role file');
          return r.json();
        }).then(function(data) {
          if (!data) throw new Error('empty');
          var src = _extractPatterns(data);
          if (!src) throw new Error('no patterns');
          _applyLexicon(src, 'per-role');
        }).catch(function() {
          // Tier 3: legacy genre file (e.g. electronic_td.json)
          var genrePath = 'data/Lexicon/' + genre + '.json';
          fetch(genrePath).then(function(r) {
            if (!r.ok) { lexiconLoaded = false; return null; }
            return r.json();
          }).then(function(data) {
            if (!data) { lexiconLoaded = false; return; }
            var src = _extractPatterns(data);
            if (!src) { lexiconLoaded = false; return; }
            _applyLexicon(src, 'genre fallback ' + genre);
          }).catch(function(e) {
            console.log(name.charAt(0).toUpperCase() + name.slice(1) + ' lexicon unavailable for ' + genre + ': ' + e.message);
            lexiconLoaded = false;
          });
        });
      }

      // Tier 1: per-artist per-role (e.g. roles/bass_radiohead.json)
      var artistRolePath = 'data/Lexicon/roles/' + name + '_' + genre + '.json';
      fetch(artistRolePath).then(function(r) {
        if (!r.ok) throw new Error('no artist role file');
        return r.json();
      }).then(function(data) {
        if (!data) throw new Error('empty');
        var src = _extractPatterns(data);
        if (!src) throw new Error('no patterns');
        _applyLexicon(src, 'per-artist ' + genre);
      }).catch(function() {
        // Tier 1.5: genre family per-role (e.g. roles/lead_classical.json for bach/mozart/beethoven)
        var family = _GENRE_FAMILY[genre];
        if (!family) { _loadTier2(); return; }
        var familyPath = 'data/Lexicon/roles/' + name + '_' + family + '.json';
        fetch(familyPath).then(function(r) {
          if (!r.ok) throw new Error('no family file');
          return r.json();
        }).then(function(data) {
          if (!data) throw new Error('empty');
          var src = _extractPatterns(data);
          if (!src) throw new Error('no patterns');
          _applyLexicon(src, 'family ' + family);
        }).catch(_loadTier2);
      });
    }

    // ── Note observation (shared) ──
    function observeNote(pc) {
      currentNote = observeNoteSTM(pc, currentNote, stm, SharedState.keyC);
    }

    function observePlayerNote(pc, time) {
      lastHumanTime = time || Date.now();
      patternBuffer.push({ pc: pc, time: lastHumanTime });
      if (patternBuffer.length > PATTERN_BUFFER_MAX) patternBuffer.shift();
      observeNote(pc);
      _detectLoop();
      if (hooks.onObservePlayer) hooks.onObservePlayer(agent, pc, lastHumanTime);
    }

    // ── Loop detection (shared) ──
    function _detectLoop() {
      var pcs = patternBuffer.map(function(n) { return n.pc; });
      var result = detectLoopInBuffer(pcs, {
        minLength: lc.minBufferLen,
        maxLag: lc.maxLag,
        threshold: lc.threshold
      });
      if (result) {
        loopPattern = result.pattern;
        loopIdx = 0;
        loopConfidence = result.confidence;
      } else {
        loopConfidence *= lc.decay;
        if (loopConfidence < 0.3) loopPattern = null;
      }
    }

    // v9.2.0: tier1_liveLoop removed — dead code, never called in production.
    // Was retained for future SharedLoopDetector integration but never wired.
    // Available in git history if needed.

    // ── Contour fingerprint: first 3 intervals of a phrase ──
    // Used to prevent selecting different lexicon entries that have the
    // same melodic shape (e.g. root→b7→5→root appearing in 20 patterns).
    var recentContours = [];  // rolling buffer of recent contour fingerprints
    var CONTOUR_MEMORY = 4;   // remember last 4 contours

    // v9.1.0: Track recently played starting PCs to prevent repetitive pitch fixation.
    // Penalizes phrases that start on the same PC as recent phrases — breaks the
    // deterministic loop where the same starting note keeps winning pool selection.
    var _recentStartPCs = [];
    var _START_PC_MEMORY = 6;

    function _contourFingerprint(sd) {
      if (!sd || sd.length < 3) return '';
      var fp = '';
      for (var i = 1; i < Math.min(sd.length, 4); i++) {
        var interval = sd[i] - sd[i - 1];
        if (interval > 6) interval -= 12;
        if (interval < -6) interval += 12;
        fp += interval + ',';
      }
      return fp;
    }

    // ── selectPhrase (shared scaffold, per-role weights via config) ──
    // speculative: if true, skip state updates (recentPhraseIds, recentContours).
    // Used by soloist anticipatory evaluation to score candidates without polluting
    // the agent's memory of what it has actually played.
    function selectPhrase(key, speculative) {
      var scanLimit = (typeof LEXICON_SCAN_LIMIT !== 'undefined') ? LEXICON_SCAN_LIMIT : 50;
      var _st = (typeof SectionTracker !== 'undefined' && SectionTracker.getVoiceState) ? SectionTracker.getVoiceState(name) : ((typeof SectionTracker !== 'undefined') ? SectionTracker.getState() : null);
      // v9.3.0: Compute consensus ONCE per phrase selection, reuse everywhere.
      // Consensus now lives in ChordBelief (unified harmonic truth).
      var _cachedConsensus = (typeof ChordBelief !== 'undefined') ? ChordBelief.getConsensus(name) : null;
      var context = {
        role: name,
        chord: SharedState.currentChord,
        saturatedPCs: (typeof ContextIntegrator !== 'undefined') ? ContextIntegrator.getSaturatedPCs() : [],
        bassRoot: (typeof FinalCoordinator !== 'undefined') ? FinalCoordinator.getBassRoot() : null,
        mode: SharedState.mode,
        sectionState: _st ? _st.state : 'STABLE',
        sectionEnergy: _st ? _st.energy : 0.5,
        ensembleContext: refreshEnsembleContext(),
        harmonicConsensus: _cachedConsensus,
        // v8.12.1: Flag for scoring to boost consensus weight when bass not grounding
        bassGrounding: (typeof BassAssistant !== 'undefined' && BassAssistant.getBassState)
          ? BassAssistant.getBassState() === 'groove' : true
      };
      var weights = (typeof PHRASE_SCORE_WEIGHTS !== 'undefined' && PHRASE_SCORE_WEIGHTS[name])
        ? PHRASE_SCORE_WEIGHTS[name] : config.phraseWeights;

      var candidates = [];
      for (var i = 0; i < Math.min(lexicon.length, scanLimit); i++) {
        if (recentPhraseIds.indexOf(i) >= 0) continue;
        var result = scoreLexiconEntry(lexicon[i], key, context, weights);
        if (result.passed) {
          lexicon[i]._idx = i;
          candidates.push({ entry: lexicon[i], score: result.score, idx: i });
        }
      }

      // Penalize candidates whose contour matches recent phrases.
      // This prevents different lexicon entries with the same interval
      // pattern from being selected consecutively.
      if (recentContours.length > 0) {
        for (var ci = 0; ci < candidates.length; ci++) {
          var cfp = _contourFingerprint(candidates[ci].entry.sd);
          if (cfp && recentContours.indexOf(cfp) >= 0) {
            candidates[ci].score *= 0.3; // heavy penalty, not elimination
          }
        }
      }

      // v9.1.0: Penalize candidates starting on recently-played PCs.
      // Prevents pitch fixation where lead/soloist obsessively return to
      // the same starting note (observed: 31% unison rate in lead, PC dominance 23%).
      if (_recentStartPCs.length > 0) {
        for (var spi = 0; spi < candidates.length; spi++) {
          var _cStartPC = (candidates[spi].entry.sd[0] + key) % 12;
          for (var rpi = 0; rpi < _recentStartPCs.length; rpi++) {
            if (_recentStartPCs[rpi] === _cStartPC) {
              // More recent = stronger penalty (×0.5 for most recent, ×0.7 for oldest)
              var _recencyFade = 0.5 + 0.2 * (rpi / _recentStartPCs.length);
              candidates[spi].score *= _recencyFade;
              break;  // only penalize once per candidate
            }
          }
        }
      }

      var pick = selectFromCandidates(candidates, 5);
      if (!pick) return null;

      // Skip state updates when speculative (anticipatory evaluation)
      if (!speculative) {
        var recMem = config.recentPhraseMemory ||
          ((typeof RECENT_PHRASE_MEMORY !== 'undefined') ? RECENT_PHRASE_MEMORY : 5);
        recentPhraseIds.push(pick.idx);
        if (recentPhraseIds.length > recMem) recentPhraseIds.shift();

        // Track contour fingerprint
        var pickFp = _contourFingerprint(pick.entry.sd);
        if (pickFp) {
          recentContours.push(pickFp);
          if (recentContours.length > CONTOUR_MEMORY) recentContours.shift();
        }

        // v9.1.0: Track starting PC for recency penalty
        var _pickStartPC = (pick.entry.sd[0] + key) % 12;
        _recentStartPCs.unshift(_pickStartPC);
        if (_recentStartPCs.length > _START_PC_MEMORY) _recentStartPCs.pop();
      }

      return pick.entry;
    }

    // ── Scheduling helper ──
    function _getScheduleBpm() {
      var bpm = TempoEngine.getEffectiveBPM();
      if (config.bpmUseScopeMultiplier !== false) bpm *= scope.multiplier;
      // v5 Phase 4b: Mood tempo — minor keys slightly slower (Post & Huron 2009)
      if (typeof MoodState !== 'undefined' && MoodState.getTempoMultiplier) {
        bpm *= MoodState.getTempoMultiplier(name);
      }
      return bpm;
    }

    function _getBarAlignConfig() {
      return (typeof BAR_ALIGN_CONFIG !== 'undefined' && BAR_ALIGN_CONFIG[name])
        ? BAR_ALIGN_CONFIG[name] : { enabled: false };
    }

    // ── Tier A: Lexicon retrieval (shared) ──
    // v9.3.0: Renamed from tier2_lexicon. Pattern retrieval from curated lexicon.
    function tier_a_lexicon() {
      if (!lexiconLoaded || lexicon.length === 0) return null;

      // Continue active NON-scheduled phrase
      if (currentPhrase && !currentPhrase.scheduled && currentPhrase.idx < currentPhrase.notes.length) {
        var pc = currentPhrase.notes[currentPhrase.idx];
        currentPhrase.idx++;
        return { pc: pc, source: 'lexicon', confidence: 0.7 };
      }

      // Don't select new phrase if Scheduler is still playing one
      if (Scheduler.hasActivePhrase(name)) return null;

      // v3 Phase 2: L2 intent — seed replay for continuation
      if (typeof MelodicIntent !== 'undefined') {
        var _intent = MelodicIntent.getIntent(name);
        if (_intent === 'continuation' && MelodicIntent.hasSeed(name)) {
          var replay = MelodicIntent.getSeedReplay(name, SharedState.keyC);
          if (replay && replay.ioiRatios && replay.notes.length > 1) {
            var _bpm = _getScheduleBpm();
            buildPhraseSchedule(name, replay.notes, replay.ioiRatios, _bpm, _getBarAlignConfig());
            currentPhrase = {
              notes: replay.notes, idx: replay.notes.length,
              ioiRatios: replay.ioiRatios, loopable: false, scheduled: true,
              _commitContext: _captureCommitContext()
            };
            lastPhraseTime = Date.now();
            return { pc: replay.notes[0], source: 'intent_continue', confidence: 0.8 };
          }
        }
      }

      // Select a new phrase
      var key = SharedState.keyC;
      var phrase = selectPhrase(key);
      if (!phrase) return null;

      var notes = phrase.sd.map(function(sd) { return (sd + key) % 12; });
      var hasIoi = phrase.ioi_ratios && phrase.ioi_ratios.length > 0;

      if (hasIoi && notes.length > 1) {
        var bpm = _getScheduleBpm();
        var result = buildPhraseSchedule(name, notes, phrase.ioi_ratios, bpm, _getBarAlignConfig());
        var _cc = _captureCommitContext();
        currentPhrase = {
          notes: notes, idx: notes.length,
          ioiRatios: phrase.ioi_ratios,
          loopable: phrase.loopable,
          scheduled: true,
          entryIdx: phrase._idx,
          _commitContext: _cc
        };
        lastPhraseTime = Date.now();
        if (result.barDelay > 0) return null;
      } else {
        currentPhrase = {
          notes: notes, idx: 1,
          ioiRatios: null,
          loopable: phrase.loopable,
          scheduled: false,
          entryIdx: phrase._idx,
          _commitContext: _captureCommitContext()
        };
        lastPhraseTime = Date.now();
      }

      // Capture seed for MotifDeveloper
      if (typeof MotifDeveloper !== 'undefined' && phrase.sd.length >= 3) {
        MotifDeveloper.captureSeed(phrase.sd, phrase.ioi_ratios, name);
      }

      // Publish to shared phrase memory for cross-voice motivic conversation
      if (typeof SharedPhraseMemory !== 'undefined' && phrase.sd && phrase.sd.length >= 3) {
        SharedPhraseMemory.publish(name, phrase);
      }

      // v9.0.0: Archive to ThematicMemory for session-scale recall
      // (higher notability threshold than SharedPhraseMemory — only truly memorable phrases)
      if (typeof ThematicMemory !== 'undefined' && phrase.sd && phrase.sd.length >= 4) {
        ThematicMemory.capture(name, phrase);
      }

      // v3 Phase 2: store first phrase as seed during continuation
      if (typeof MelodicIntent !== 'undefined' && !MelodicIntent.hasSeed(name) && phrase.sd) {
        MelodicIntent.setSeed(name, phrase, key);
      }

      return { pc: notes[0], source: 'lexicon', confidence: 0.7 };
    }

    // ── Tier B: PPM-backed generation (shared) ──
    // v9.3.0: Merged from tier2_5_generate + tier3_ppm.
    // Phase 1: Multi-note phrase generation using PPM 5-viewpoint prediction
    //          (replaces order-2 Markov chains — single statistical model).
    // Phase 2: Single-note PPM fallback if phrase generation unavailable.
    function tier_b_generate() {

      // ══ Phase 1: Multi-note phrase generation ══
      if (typeof PhraseGenerator !== 'undefined' && PhraseGenerator.isReady(name)) {
        if (!(currentPhrase && currentPhrase.idx < currentPhrase.notes.length) &&
            !Scheduler.hasActivePhrase(name)) {

          var scale = getScale(SharedState.keyC, SharedState.mode);
          // Precision-weighted expectancy (Vuust et al. 2022, sqrt scaling)
          var _expectancy = null;
          if (typeof MelodicExpectancy !== 'undefined' && MelodicExpectancy.predict) {
            _expectancy = MelodicExpectancy.predict(name);
            if (_expectancy) {
              var _maxH = Math.log2(12);
              var _rawPrec = 1.0 - (_expectancy.entropy / _maxH);
              var _prec = Math.sqrt(Math.max(0, _rawPrec));
              var _precFloor = (typeof PRECISION_FLOOR !== 'undefined') ? PRECISION_FLOOR : 0.02;
              if (_rawPrec < _precFloor) {
                _expectancy = null;
              } else {
                _expectancy.precision = _prec;
              }
            }
          }

          var context = {
            key: SharedState.keyC, scale: scale, mode: SharedState.mode,
            bassRoot: (typeof FinalCoordinator !== 'undefined') ? FinalCoordinator.getBassRoot() : null,
            chord: SharedState.currentChord,
            saturatedPCs: (typeof ContextIntegrator !== 'undefined') ? ContextIntegrator.getSaturatedPCs() : [],
            recentNotes: stm.recent,
            humanAdv: SharedState.getHumanAdventurousness(),
            bpm: TempoEngine.getEffectiveBPM(),
            behaviorMode: (typeof MelodicIntent !== 'undefined') ? MelodicIntent.getIntent(name) : null,
            barPhase: (typeof BarTracker !== 'undefined' && BarTracker.getBarPhase) ? BarTracker.getBarPhase() : 0,
            barConfidence: (typeof BarTracker !== 'undefined' && BarTracker.getBarConfidence) ? BarTracker.getBarConfidence() : 0,
            beatsPerBar: (typeof BarTracker !== 'undefined' && BarTracker.getBeatsPerBar) ? BarTracker.getBeatsPerBar() : 4,
            voiceKeyBelief: _cachedEns ? _cachedEns.voiceKeyBelief : null,
            keyDivergence: _cachedEns ? _cachedEns.keyDivergence : 0,
            expectancy: _expectancy,
            voiceStance: (typeof DialogueEngine !== 'undefined' && DialogueEngine.getStance) ?
              DialogueEngine.getStance(name).stance : 'support',
            harmonicTargets: null,
            chordHint: agent._chordHint || null,
            tonicBias: agent._tonicBias || 0,
            // v9.3.0: PPM prediction function — PhraseGenerator uses this for
            // note-by-note generation instead of redundant Markov chains.
            predict: function(curPC) {
              return SharedState.predict(curPC, stm, SharedState.genre);
            }
          };

          // Harmonic direction targets
          if (typeof HarmonicPlanner !== 'undefined' && HarmonicPlanner.getNextChordsForVoice) {
            var _nextChords = HarmonicPlanner.getNextChordsForVoice(name);
            if (_nextChords && _nextChords.length > 0 && typeof PhraseGenerator !== 'undefined' &&
                PhraseGenerator.computeHarmonicTargets) {
              context.harmonicTargets = PhraseGenerator.computeHarmonicTargets(
                _nextChords, 8, context.bpm
              );
            }
            // Publish harmonic intent via ChordBelief (stigmergic coordination)
            if (_nextChords && _nextChords.length > 0) {
              var _topChord = _nextChords[0];
              if (typeof ChordBelief !== 'undefined') {
                ChordBelief.publishIntent(name, _topChord.rootPC, _topChord.type,
                  _topChord.confidence || 0, _topChord.beatsAway || 0);
              }
            }
          }

          // Peer harmonic consensus from ChordBelief
          context.harmonicConsensus = (typeof ChordBelief !== 'undefined') ? ChordBelief.getConsensus(name) : null;

          var phrase = PhraseGenerator.generate(context, name);
          if (phrase) {
            var scaleLen = scale.length;
            var notes = phrase.sd.map(function(deg) {
              var d = ((deg % scaleLen) + scaleLen) % scaleLen;
              return scale[d];
            });

            var hasIoi = phrase.ioi_ratios && phrase.ioi_ratios.length > 0;
            var _genCC = _captureCommitContext();
            if (hasIoi && notes.length > 1) {
              var bpm = _getScheduleBpm();
              var result = buildPhraseSchedule(name, notes, phrase.ioi_ratios, bpm, _getBarAlignConfig());
              currentPhrase = {
                notes: notes, idx: notes.length,
                ioiRatios: phrase.ioi_ratios,
                loopable: false, scheduled: true, generated: true,
                _commitContext: _genCC
              };
              lastPhraseTime = Date.now();
              if (result.barDelay > 0) return null;
            } else {
              currentPhrase = {
                notes: notes, idx: 1,
                ioiRatios: null,
                loopable: false, scheduled: false, generated: true,
                _commitContext: _genCC
              };
              lastPhraseTime = Date.now();
            }

            // Store generated phrase as seed
            if (typeof MelodicIntent !== 'undefined' && !MelodicIntent.hasSeed(name) && phrase.sd) {
              MelodicIntent.setSeed(name, phrase, SharedState.keyC);
            }

            return { pc: notes[0], source: 'generate', confidence: 0.6 };
          }
        }
      }

      // ══ Phase 2: Single-note PPM fallback ══
      // Resolution-proportional harmonic boost (Bigand 1996, Lerdahl & Jackendoff 1983).
      var cur = currentNote !== null ? currentNote : SharedState.keyC;
      var probs = SharedState.predict(cur, stm, SharedState.genre);

      if (hooks.tier3Bias) {
        hooks.tier3Bias(agent, probs, stm);
      }

      // Structural voices: urgency-scaled chord-tone boost
      var _isStructural = (name === 'bass' || name === 'rhythm' || name === 'percussion');
      if (_isStructural && typeof HarmonicPlanner !== 'undefined') {
        var hCtx = HarmonicPlanner.getCurrentContext(name);
        var urgency = 0;
        if (typeof SectionTracker !== 'undefined') {
          var ss = SectionTracker.getState();
          urgency = ss.resolutionUrgency || 0;
        }
        var harmonicBoost = 1.0 + urgency * 1.5;
        if (hCtx && hCtx.chordTones && harmonicBoost > 1.01) {
          for (var hbi = 0; hbi < hCtx.chordTones.length; hbi++) {
            probs[hCtx.chordTones[hbi] % 12] *= harmonicBoost;
          }
        }
      }

      // Melodic voices: mild chord bias (1.3× — gentle, not groupthink)
      if (!_isStructural && typeof HarmonicPlanner !== 'undefined') {
        var _mCtx = HarmonicPlanner.getCurrentContext(name);
        if (_mCtx && _mCtx.chordTones) {
          for (var _mi = 0; _mi < _mCtx.chordTones.length; _mi++) {
            probs[_mCtx.chordTones[_mi] % 12] *= 1.3;
          }
        }
      }

      var temp = 0.4 + (SharedState.getHumanAdventurousness() || 0) * 0.4;
      var pc = tempSample(probs, temp);
      return { pc: pc, source: 'ppm', confidence: 0.4 };
    }

    // ── Replan ──
    function replan() {
      currentPhrase = null;
      Scheduler.cancel(name);
      // v8.11.0: Reset scope on replan so voice must re-accumulate before firing.
      // Without this, section transitions (key change → replan) leave scope high,
      // letting bass fire single notes every tick through PPM fallback.
      scope.accumulator = 0;
    }

    // ── Reset (shared + hook) ──
    function reset() {
      stm.pitch.reset(); stm.interval.reset(); stm.sd.reset();
      stm.contour.reset(); stm.linked.reset(); stm.recent = [];
      currentNote = null;
      lastHumanTime = 0;
      patternBuffer = [];
      loopPattern = null; loopIdx = 0; loopConfidence = 0;
      currentPhrase = null; recentPhraseIds = [];
      lastPhraseTime = 0;
      scope.accumulator = 0; scope.frozen = false; scope.muted = false;
      _cachedEns = null; _ensCacheTime = 0;
      Scheduler.cancel(name);
      if (hooks.onReset) hooks.onReset(agent);
    }

    // ── Main tick (shared orchestration) ──
    function onTick(dt) {
      // v9.0.0: Collective breath — tick once per frame (bass runs first, guards others)
      if (name === 'bass') _breathTick(dt);

      // ── V7 Phase 0: Gate diagnostic logging ──
      _gateCounters.ticks++;
      _gateLogTimer += dt;
      if (_gateLogTimer >= 30000) {
        var t = _gateCounters.ticks || 1;
        console.log('[GATE ' + name + '] ticks=' + t +
          ' race=' + (100 * _gateCounters.raceBlock / t).toFixed(1) + '%' +
          ' preGate=' + (100 * _gateCounters.preGateBlock / t).toFixed(1) + '%' +
          ' belief=' + (100 * _gateCounters.beliefBlock / t).toFixed(1) + '%' +
          ' scope=' + (100 * _gateCounters.scopeBlock / t).toFixed(1) + '%' +
          ' phraseGap=' + (100 * _gateCounters.phraseGapBlock / t).toFixed(1) + '%' +
          ' postGap=' + (100 * _gateCounters.postGapBlock / t).toFixed(1) + '%' +
          ' stagger=' + (100 * _gateCounters.staggerBlock / t).toFixed(1) + '%' +
          ' stateBypass=' + (100 * (_gateCounters.stateBypass || 0) / t).toFixed(1) + '%' +
          ' tierFail=' + (100 * _gateCounters.tierFail / t).toFixed(1) + '%' +
          ' activePhrase=' + (100 * _gateCounters.activePhrase / t).toFixed(1) + '%' +
          ' produced=' + _gateCounters.produced +
          ' passRate=' + (100 * _gateCounters.produced / t).toFixed(2) + '%');
        _gateLogTimer = 0;
        _gateCounters = {
          ticks: 0, raceBlock: 0, preGateBlock: 0, beliefBlock: 0,
          scopeBlock: 0, phraseGapBlock: 0, postGapBlock: 0, staggerBlock: 0,
          stateBypass: 0, tierFail: 0, activePhrase: 0, produced: 0
        };
      }

      // Race guard: avoid near-simultaneous human+AI note at same moment.
      var raceGuard = (typeof ASSISTANT_RACE_GUARD_MS !== 'undefined') ? ASSISTANT_RACE_GUARD_MS : 100;
      if (Date.now() - lastHumanTime < raceGuard) { _gateCounters.raceBlock++; return null; }

      // Pre-gate hook (e.g. lead section intensity, bass state machine)
      // Returns: null = continue, 'skip' = block tick, 'passthrough' = skip unified gate
      var _preGatePassthrough = false;
      if (hooks.preGate) {
        var preResult = hooks.preGate(agent, dt);
        if (preResult === 'skip') { _gateCounters.preGateBlock++; return null; }
        if (preResult === 'passthrough') { _preGatePassthrough = true; _gateCounters.stateBypass++; }
      }

      // Belief gate
      var _beliefDecision = (typeof BeliefState !== 'undefined') ? BeliefState.shouldPlay(name) : null;

      // Always advance scope accumulator
      var _scopeReady = scope.tick(dt);

      // Consume scheduled phrases (active phrases complete regardless of gate)
      if (Scheduler.hasActivePhrase(name)) {
        var scheduled = Scheduler.consumeNext(name);
        if (scheduled !== null) {
          // v7 Phase 8A: Phrase monitor — harmonic reality check before scaleSnap
          scheduled = monitorNote(scheduled, name);
          scheduled = scaleSnap(scheduled, name);
          // v7 Phase 8D: Compute and stash expression for playVoiceNote
          var _exprResult = computeExpression(scheduled, name);
          // v8.6.0: Optional per-voice expression hook (e.g. rhythm articulation)
          if (config.computeExpression) {
            _exprResult = config.computeExpression(scheduled, name, _exprResult);
          }
          Scheduler.setExpression(name, _exprResult);
          observeNote(scheduled);
          _gateCounters.activePhrase++;
          _gateCounters.produced++;
          return scheduled;
        }
        // v8.2 Fix 5: Post-phrase evaluation — did the phrase achieve its intent?
        // Uses multiple metrics since single-need delta near equilibrium is too small.
        if (currentPhrase && currentPhrase._commitContext) {
          var _cc = currentPhrase._commitContext;
          var _currentBelief = (typeof BeliefState !== 'undefined') ? BeliefState.getBelief(name) : null;
          if (_cc.beliefSnapshot && _currentBelief) {
            var _needKeys = ['needs_stability', 'needs_energy', 'needs_space', 'needs_surprise', 'needs_resolution'];
            // Dominant need at commit
            var _commitDom = null, _commitDomVal = 0;
            var _currentDom = null, _currentDomVal = 0;
            // Belief vector L2 distance + per-need deltas
            var _l2sum = 0;
            var _needDeltas = {};
            for (var _ni = 0; _ni < _needKeys.length; _ni++) {
              var _nk = _needKeys[_ni];
              var _cv = _cc.beliefSnapshot[_nk] || 0;
              var _nv = _currentBelief[_nk] || 0;
              var _nd = _nv - _cv;
              _needDeltas[_nk] = _nd;
              _l2sum += _nd * _nd;
              if (_cv > _commitDomVal) { _commitDomVal = _cv; _commitDom = _nk; }
              if (_nv > _currentDomVal) { _currentDomVal = _nv; _currentDom = _nk; }
            }
            var _l2dist = Math.sqrt(_l2sum);
            // Entropy change (more certain = phrase focused beliefs)
            var _commitH = _cc.beliefSnapshot._entropy || 0;
            var _currentH = _currentBelief._entropy || 0;
            var _entropyDelta = _currentH - _commitH;
            // Dominant need shift
            var _domShifted = (_commitDom !== _currentDom);
            // Phrase duration
            var _phraseDurMs = _cc.commitTime ? (Date.now() - _cc.commitTime) : 0;

            _phraseOutcomes.push({
              intent: _cc.intent,
              source: currentPhrase.generated ? 'generate' : 'lexicon',
              commitDom: _commitDom,
              currentDom: _currentDom,
              domShifted: _domShifted,
              l2dist: +_l2dist.toFixed(6),
              entropyDelta: +_entropyDelta.toFixed(6),
              needDeltas: _needDeltas,
              monitorSubs: _monitorSubCount,
              durationMs: _phraseDurMs,
              section: _cc.sectionState ? (_cc.sectionState.state || null) : null,
              timestamp: Date.now()
            });
            if (_phraseOutcomes.length > OUTCOME_BUFFER_SIZE) _phraseOutcomes.shift();
          }
        }

        // Phrase just finished — check for loop replay (groove continuity)
        // Groove roles (bass/rhythm) with loopable phrases re-schedule immediately
        // with a short loop gap instead of falling through to the 1200ms phrase gap gate.
        // This is the key groove mechanism: repetition with minimal silence.
        if (currentPhrase && currentPhrase.loopable && currentPhrase.notes &&
            currentPhrase.ioiRatios && (name === 'bass' || name === 'rhythm')) {
          // Limit loop count to prevent infinite repetition (staleness system handles the rest)
          var _loopCount = (currentPhrase._loopCount || 0) + 1;
          var _maxLoops = (name === 'bass') ? 6 : 4;  // bass loops more (anchor), rhythm less
          if (_loopCount <= _maxLoops) {
            var gc = (typeof getGenreConfig === 'function') ? getGenreConfig(SharedState.genre) : {};
            var loopGapBeats = gc.loopGap !== undefined ? gc.loopGap : 1.0;
            // Bass loops breathe more — 2 beats between repeats instead of 1
            if (name === 'bass') loopGapBeats = Math.max(loopGapBeats, 2.0);
            var _bpm = _getScheduleBpm();
            // v8.6.0 Gap 5: Optional loop variation hook — voice provides variation function
            var _loopNotes = currentPhrase.notes;
            var _loopIOI = currentPhrase.ioiRatios;
            if (config.loopVariation) {
              var _varied = config.loopVariation(_loopNotes, _loopIOI, _loopCount);
              _loopNotes = _varied.notes;
              _loopIOI = _varied.ioiRatios;
            }
            Scheduler.schedulePhrase(name, _loopNotes, _loopIOI, _bpm, null, loopGapBeats);
            currentPhrase._loopCount = _loopCount;
            lastPhraseTime = Date.now();
            return null;  // v8.11.0: exit immediately after scheduling loop
          }
        }
        // v8.11.0: Clear currentPhrase after loop section to prevent re-entering
        // loop replay on subsequent ticks while waiting for the new schedule.
        currentPhrase = null;
        return null;
      }

      // v8.12.0: State-machine voices (bass) bypass unified gate when in SEARCHING/ANCHORING.
      // They manage their own timing via beat-locking in tierCascade.
      if (!_preGatePassthrough) {
      // ── v8.11.0: Unified Gate (V7 Phase 8E) ──
      // Replaces 5 sequential binary gates with a single multiplicative readiness score [0,1].
      // Each factor contributes a continuous value instead of a hard block. Floor at 0.05
      // prevents total starvation. Target NPS: 7-9 (up from 4-7 with binary gates).
      //
      // readiness = beliefProb × scopeRamp × phraseGapRamp × peerSpaceMod
      // roll = random() < readiness → proceed
      //
      // Why this works better than binary gates:
      // - Binary gates compound multiplicatively: 5 × 50% pass = 3.1% overall
      // - Continuous readiness: 5 × 0.7 = 16.8% → more phrases, less starvation
      // - Voices can still play when one factor is weak if others are strong
      // - Diagnostic counters track which factor suppressed most (top suppressor logged)

      // Factor 1: Belief gate — binary roll against gateProb (preserves POMDP semantics)
      // skipBeliefGate voices (soloist, lead) have their own deliberation → always pass.
      // This stays as a binary roll because gateProb IS a probability — using it as a
      // multiplier would double-count (0.8 gateProb × other factors ≠ 0.8 chance).
      var _ugBeliefPass = true;
      if (!config.skipBeliefGate && _beliefDecision) {
        _ugBeliefPass = _beliefDecision.allowed;  // already rolled against gateProb
      }

      // Factor 2: Scope accumulator → sigmoid ramp (smooth, not binary threshold)
      // Center at 0.5: accumulator 0.3 → ~0.12. At 0.5 → 0.50. At 0.7 → ~0.88.
      //
      // Role-specific scope scaling: bass accumulator is compressed before entering
      // the sigmoid so it needs more raw accumulation to reach the pass zone.
      // Bass produces phrases in tight loops (groove anchor) — without this scaling,
      // its high belief + fast loops overwhelm the ensemble.
      var _ugScopeAcc = scope.accumulator !== undefined ? scope.accumulator : (scope._accumulator || 0);
      // v9.1.0: Soloist scope scaling 1.3× — soloist self-regulates via prediction pool
      // + evidence gates (skipBeliefGate=true), but unified gate still multiplies everything.
      // Without scope boost, soloist's accumulator passes sigmoid too slowly, compounding
      // with 2500ms cooldown ceiling to starve output to ~75 notes/160s.
      var _ugScopeScale = (name === 'bass') ? 0.7 : (name === 'percussion') ? 0.8 : (name === 'soloist') ? 1.3 : 1.0;
      var _ugScaledAcc = _ugScopeAcc * _ugScopeScale;
      var _ugScopeRamp = 1.0 / (1.0 + Math.exp(-10 * (_ugScaledAcc - 0.5)));

      // Factor 3: Phrase gap → sigmoid ramp (time since last phrase / effective gap)
      var _ugPhraseGapRamp = 1.0;  // default: no gap constraint
      if (typeof BeliefState !== 'undefined') {
        var _ugParams = BeliefState.getParams(name);
        if (_ugParams && _ugParams.minPhraseGapMs > 0 && lastPhraseTime > 0) {
          var _ugDialogueMult = 1.0;
          if (typeof DialogueEngine !== 'undefined') {
            var _ugDMod = DialogueEngine.getDensityModifier(name);
            _ugDialogueMult = 1.0 - _ugDMod * 2.0;
            _ugDialogueMult = Math.max(0.6, Math.min(1.4, _ugDialogueMult));
          }
          var _ugMoodMult = 1.0;
          if (typeof MoodState !== 'undefined' && MoodState.getDensityModifier) {
            var _ugMoodDens = MoodState.getDensityModifier(name);
            _ugMoodMult = 1.0 / Math.max(0.80, _ugMoodDens);
          }
          var _ugEffectiveGap = _ugParams.minPhraseGapMs * _ugDialogueMult * _ugMoodMult;
          _ugEffectiveGap = Math.min(_ugEffectiveGap, 2000);
          var _ugGapElapsed = (Date.now() - lastPhraseTime) / _ugEffectiveGap;
          // Sigmoid: threshold controls where ramp reaches 0.50 (midpoint).
          // v8.14.0: Melodic voices (lead/soloist) use 0.4 threshold — they need tighter
          // phrase timing to maintain melodic interest. Bass/rhythm/percussion use 0.7
          // (original value — groove voices need longer gaps between phrases).
          // Lead scope investigation showed 65% tick blocking during phrase gap with 0.7.
          // v9.0.1: Lead gap threshold 0.40→0.30 — lead retreated during PEAK (gate 0.27)
          // because gap ramp was too restrictive. Soloist stays at 0.40.
          var _ugGapThreshold = (name === 'lead') ? 0.30 : (name === 'soloist') ? 0.40 : 0.70;
          _ugPhraseGapRamp = 1.0 / (1.0 + Math.exp(-8 * (_ugGapElapsed - _ugGapThreshold)));
        }
      }

      // Factor 4: Peer space modifier — soft penalty when peer just started (not binary block)
      var _ugPeerSpaceMod = 1.0;
      if (typeof PeerModel !== 'undefined' && PeerModel.getAnticipatedSpace) {
        var _ugAntSpace = PeerModel.getAnticipatedSpace(name);
        if (_ugAntSpace < 800) {
          _ugPeerSpaceMod = 0.7;  // 30% reduction, not total block
        }
      }

      // Compute unified readiness: belief is binary (pre-rolled), rest are continuous
      // readiness = scopeRamp × phraseGapRamp × peerSpaceMod (belief already decided)
      var _ugReadiness = _ugScopeRamp * _ugPhraseGapRamp * _ugPeerSpaceMod;

      // v9.0.0: Collective breath modifier — progressive ensemble withdrawal
      var _ugBreathMod = _getBreathModifier(name);
      if (_ugBreathMod < 1.0) {
        _ugReadiness *= _ugBreathMod;
      }

      // v9.0.1: Session ending modifier — one-way voice withdrawal for composed conclusion
      var _ugEndingMod = 1.0;
      if (typeof SessionEnding !== 'undefined' && SessionEnding.isActive()) {
        _ugEndingMod = SessionEnding.getGateModifier(name);
        _ugReadiness *= _ugEndingMod;
      }

      // v9.1.0: Player gesture space signal (Keller 2014 joint action)
      // When the player creates space (sustained note, silence), boost ensemble readiness.
      // When the player builds energy (ascending run), encourage melodic voices.
      // When the player grooves (repeated pattern), encourage rhythm section.
      if (typeof GestureClassifier !== 'undefined' && GestureClassifier.getGesture) {
        var _gesture = GestureClassifier.getGesture();
        if (_gesture.confidence > 0.5) {
          // Sustained note / silence → boost readiness (fill the space the player opened)
          if (_gesture.influence.space > 0.7) {
            _ugReadiness *= 1.0 + (_gesture.influence.space - 0.7) * 0.25;
          }
          // Ascending run → encourage melodic voices to join the energy
          if (_gesture.type === 'ascending_run' && _gesture.confidence > 0.6) {
            if (name === 'lead' || name === 'soloist') _ugReadiness *= 1.12;
          }
          // Repeated pattern → encourage rhythm/bass groove lock
          if (_gesture.type === 'repeated_pattern' && _gesture.confidence > 0.6) {
            if (name === 'bass' || name === 'rhythm') _ugReadiness *= 1.10;
          }
        }
      }

      // Anti-starvation floor: bass/percussion lower (groove loops prevent starvation),
      // melodic voices higher (need the safety net more).
      // v9.0.0: Floor disabled during breath withdrawal (voice should actually go silent)
      // v9.0.1: Floor disabled during ending (voices must actually stop)
      var _ugFloor = (_ugBreathMod > 0.1 && _ugEndingMod > 0.1)
        ? ((name === 'bass' || name === 'percussion') ? 0.01 : 0.05)
        : 0.0;
      _ugReadiness = Math.max(_ugFloor, _ugReadiness);

      // Two-stage gate: belief binary pass, then readiness roll
      if (!_ugBeliefPass) {
        _gateCounters.beliefBlock++;
        // Even when belief blocks, floor gives small chance (anti-starvation)
        if (Math.random() >= _ugFloor) return null;
      } else if (Math.random() >= _ugReadiness) {
        // Track which factor suppressed most (for diagnostics)
        var _ugMin = _ugScopeRamp;
        var _ugMinName = 'scopeBlock';
        if (_ugPhraseGapRamp < _ugMin) { _ugMin = _ugPhraseGapRamp; _ugMinName = 'phraseGapBlock'; }
        if (_ugPeerSpaceMod < _ugMin) { _ugMin = _ugPeerSpaceMod; _ugMinName = 'staggerBlock'; }
        _gateCounters[_ugMinName]++;
        return null;
      }

      } // end if (!_preGatePassthrough) — state-machine voices bypass unified gate

      // Post-gap hook (role-specific behavior, not a generic gate — kept separate)
      // e.g. bass kick-lock, rhythm counterbalance/hat/stagger
      if (hooks.postGap) {
        var postResult = hooks.postGap(agent, dt);
        if (postResult === 'skip') { _gateCounters.postGapBlock++; return null; }
      }

      // PhrasePlanner constraint query
      var _plan = (typeof PhrasePlanner !== 'undefined') ? PhrasePlanner.planPhrase(name) : null;

      // v9.3.0: Two-tier cascade (Tier A: lexicon, Tier B: PPM generation).
      // Intent-aware ordering. Role-specific hooks still override when present.
      var result = null;
      if (hooks.tierCascade) {
        result = hooks.tierCascade(agent);
      } else {
        var _cascadeIntent = (typeof MelodicIntent !== 'undefined') ? MelodicIntent.getIntent(name) : null;
        if (_cascadeIntent === 'contrast' || _cascadeIntent === 'punctuation') {
          // Generator first — context-responsive novelty
          result = tier_b_generate();
          if (!result) result = tier_a_lexicon();
        } else {
          // Continuation/consonance: lexicon first (pattern recall, groove)
          result = tier_a_lexicon();
          if (!result) result = tier_b_generate();
        }
      }

      if (result) {
        result.pc = scaleSnap(result.pc, name);
        if (config.observeOwnOutput) observeNote(result.pc);
        if (hooks.onResult) hooks.onResult(agent, result);
        _gateCounters.produced++;
        // v8.11.0: Update lastPhraseTime on ANY note production — not just scheduled phrases.
        // Without this, single-note PPM fallback bypasses the phrase gap ramp entirely,
        // allowing bass to fire notes every tick (~5ms) with no cooldown.
        lastPhraseTime = Date.now();
        return result.pc;
      }
      _gateCounters.tierFail++;
      return null;
    }

    // ── Build the agent object ──
    var agent = {
      scope: scope,
      stm: stm,
      loadLexicon: loadLexicon,
      observePlayerNote: observePlayerNote,
      observeNote: observeNote,
      onTick: onTick,
      replan: replan,
      reset: reset,
      refreshEnsembleContext: refreshEnsembleContext,
      selectPhrase: selectPhrase,
      // v9.3.0: Two-tier cascade (A: lexicon, B: PPM generation)
      tier_a_lexicon: tier_a_lexicon,
      tier_b_generate: tier_b_generate,
      // Backward-compatible aliases for assistant hooks
      tier2_lexicon: tier_a_lexicon,
      tier2_5_generate: tier_b_generate,
      tier3_ppm: tier_b_generate,
      getLoopConfidence: function() { return loopConfidence; },
      getLoopPattern: function() { return loopPattern; },
      getCurrentSource: function() {
        if (currentPhrase) return currentPhrase.generated ? 'generate' : 'lexicon';
        return loopPattern ? 'loop' : 'ppm';
      },
      getPhraseProgress: function() {
        if (Scheduler.hasActivePhrase(name)) return Scheduler.getPhraseProgress(name);
        if (currentPhrase && !currentPhrase.scheduled && currentPhrase.idx < currentPhrase.notes.length) {
          return currentPhrase.idx / currentPhrase.notes.length;
        }
        if (loopPattern && loopPattern.length > 0) return loopIdx / loopPattern.length;
        return 0.5;
      },
      // v8.2 Fix 1+5: Expose context capture for role-specific hooks
      _captureCommitContext: _captureCommitContext,
      // v8.2 Fix 5: Expose phrase outcome buffer + summary for diagnostics
      _getPhraseOutcomes: function() { return _phraseOutcomes; },
      _getOutcomeSummary: function() {
        if (_phraseOutcomes.length === 0) return { count: 0 };
        var total = _phraseOutcomes.length;
        var avgL2 = 0, avgEntropy = 0, domShifts = 0, avgDur = 0;
        var intentCounts = {}, sourceCounts = {};
        for (var oi = 0; oi < total; oi++) {
          var o = _phraseOutcomes[oi];
          avgL2 += o.l2dist || 0;
          avgEntropy += o.entropyDelta || 0;
          if (o.domShifted) domShifts++;
          avgDur += o.durationMs || 0;
          intentCounts[o.intent] = (intentCounts[o.intent] || 0) + 1;
          sourceCounts[o.source] = (sourceCounts[o.source] || 0) + 1;
        }
        return {
          count: total,
          avgL2dist: +(avgL2 / total).toFixed(6),
          avgEntropyDelta: +(avgEntropy / total).toFixed(6),
          domShiftRate: +(domShifts / total).toFixed(3),
          avgDurationMs: Math.round(avgDur / total),
          intents: intentCounts,
          sources: sourceCounts
        };
      },
      // Expose internals for hooks that need them
      _name: name,
      _getCurrentPhrase: function() { return currentPhrase; },
      _setCurrentPhrase: function(p) { currentPhrase = p; },
      _getLastPhraseTime: function() { return lastPhraseTime; },
      _setLastPhraseTime: function(t) { lastPhraseTime = t; },
      _getCurrentNote: function() { return currentNote; },
      _getLexicon: function() { return lexicon; },
      _isLexiconLoaded: function() { return lexiconLoaded; },
      _getLoopIdx: function() { return loopIdx; },
      _setLoopIdx: function(i) { loopIdx = i; },
      _getLoopPattern: function() { return loopPattern; },
      _setLoopPattern: function(p) { loopPattern = p; },
      _setLoopConfidence: function(c) { loopConfidence = c; },
      _getScheduleBpm: _getScheduleBpm,
      _getBarAlignConfig: _getBarAlignConfig,
      _getCachedEns: function() { return _cachedEns; }
    };

    return agent;
  }

  return {
    scaleSnap:            scaleSnap,
    tempSample:           tempSample,
    observeNoteSTM:       observeNoteSTM,
    detectLoopInBuffer:   detectLoopInBuffer,
    buildPhraseSchedule:  buildPhraseSchedule,
    scoreLexiconEntry:    scoreLexiconEntry,
    selectFromCandidates: selectFromCandidates,
    createVoiceAgent:     createVoiceAgent,
    getActiveMomentum:    getActiveMomentum,
    getTensionLevel:      getTensionLevel
  };

})();

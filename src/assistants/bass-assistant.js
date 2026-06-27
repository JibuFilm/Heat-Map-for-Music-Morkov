'use strict';
// ═══ BASS ASSISTANT (v4.0 — 3-state machine) ═══
// Foundation voice: anchors harmony via deterministic pattern-based output.
//
// v4.0 changes (v8.12.0):
//   - 3-state machine: GROOVE / SEARCHING / ANCHORING
//   - GROOVE: loop/phrase playing (existing mechanism). No gate involvement.
//   - SEARCHING: beat-locked pedal root/fifth during transitions. Max 2 bars.
//   - ANCHORING: root on beat 1 only during high ensemble density.
//   - Single-note PPM fallback not used for bass. No random single notes.
//   - Same-PC cooldown (Plomp & Levelt 1965). Silence budget (Madison 2006).
//   - Bypasses unified gate in SEARCHING/ANCHORING via 'passthrough' preGate.
//
// Research: info/research/bass-gate-dual-state-model.md (14 citations)
//   Hove 2014: auditory system encodes timing more precisely for low-pitched sounds
//   London 2012: entrainment requires predictable temporal structure
//   Madison 2006: quantized precision is as groovy or more groovy than humanized
//   Pressing 2002: groove is a kinetic framework for reliable prediction
//   Danielsen 2006: bass groove patterns are holistic rhythmic units
//   Plomp & Levelt 1965: repeated tones in bass register increase roughness

var BassAssistant = (function() {

  // ── State machine ──
  var _bassState = 'groove';
  var _stateEnteredAt = 0;
  var _lastBassPC = -1;
  var _lastBassPCTime = 0;
  var _lastNoteTime = 0;
  var _searchBarCount = 0;
  var _lastBarPhaseForCount = -1;  // track bar wrapping for search bar counting
  var _prevSection = 'STABLE';
  var _logTimer = 0;

  function _transitionTo(newState) {
    if (newState === _bassState) return;
    console.log('[BASS STATE] ' + _bassState + ' → ' + newState);
    _bassState = newState;
    _stateEnteredAt = Date.now();
    if (newState === 'searching') {
      _searchBarCount = 0;
      _lastBarPhaseForCount = -1;
    }
  }

  // Publish bass harmonic intent during SEARCHING/ANCHORING.
  // Bass pedal notes declare tonal center even when not in GROOVE.
  // Other voices read this via ChordBelief.getConsensus() — keeps ensemble anchored.
  // Confidence is LOWER than GROOVE intent (which comes from phrase scoring ~0.4-0.8).
  // This prevents bass from dominating consensus during transitions —
  // enough to anchor, not enough to force convergence.
  function _publishBassIntent(rootPC) {
    // SEARCHING: moderate confidence (anchoring, not dictating)
    // ANCHORING: slightly higher (beat 1 root is a strong statement)
    var conf = (_bassState === 'anchoring') ? 0.55 : 0.45;
    if (typeof ChordBelief !== 'undefined') {
      ChordBelief.publishIntent('bass', rootPC,
        SharedState.mode === 'major' ? 'major' : 'minor', conf, 0);
    }
  }

  // ── Beat detection from bar phase ──
  function _getBarInfo() {
    var barPhase = 0;
    var barMs = 0;
    if (typeof BarTracker !== 'undefined' && BarTracker.getBarConfidence() > 0) {
      barPhase = BarTracker.getBarPhase();
      barMs = BarTracker.getBarPeriod();
    } else if (typeof PhaseCoupling !== 'undefined') {
      barPhase = PhaseCoupling.getBarPhase('bass') || 0;
      barMs = 60000 / Math.max(30, PhaseCoupling.getConsensusBPM() || 120) * 4;
    }
    return { phase: barPhase, barMs: barMs };
  }

  function _isOnBeat(barPhase) {
    var BSM = BASS_STATE_MACHINE;
    if (barPhase >= BSM.beat1Lo && barPhase < BSM.beat1Hi) return 'beat1';
    if (barPhase >= BSM.beat3Lo && barPhase < BSM.beat3Hi) return 'beat3';
    return null;
  }

  // ── Harmonic context ──
  function _getRootAndFifth() {
    var root = SharedState.keyC || 0;
    // If we have a current chord, use its root instead
    if (SharedState.currentChord && SharedState.currentChord.rootPC !== undefined) {
      root = SharedState.currentChord.rootPC;
    }
    var fifth = (root + 7) % 12;
    return { root: root, fifth: fifth };
  }

  // ── Same-PC cooldown (Plomp & Levelt 1965) ──
  function _samePCBlocked(pc) {
    if (pc !== _lastBassPC) return false;
    var bpm = (typeof PhaseCoupling !== 'undefined') ? (PhaseCoupling.getConsensusBPM() || 120) : 120;
    var beatMs = 60000 / bpm;
    var cooldownMs = BASS_STATE_MACHINE.samePCCooldownBeats * beatMs;
    return (Date.now() - _lastBassPCTime) < cooldownMs;
  }

  // ── Track note production (called from onNoteProduced) ──
  function _onBassNote(pc) {
    _lastBassPC = pc;
    _lastBassPCTime = Date.now();
    _lastNoteTime = Date.now();
  }

  // ── Force a root pedal pattern (4 quarter notes) ──
  function _scheduleForcedPedal() {
    var harm = _getRootAndFifth();
    var BSM = BASS_STATE_MACHINE;
    // Harmonically informative pedal: root-third-fifth-root
    // Gives KeyBelief 3 distinct PCs to anchor the key (was root-root-root-root)
    var third = (harm.root + (SharedState.mode === 'major' ? 4 : 3)) % 12;
    var notes = [harm.root, third, harm.fifth, harm.root];
    var ioiRatios = [BSM.forcedPedalIOI, BSM.forcedPedalIOI, BSM.forcedPedalIOI, BSM.forcedPedalIOI];
    var bpm = agent._getScheduleBpm();
    Scheduler.schedulePhrase('bass', notes.slice(1), ioiRatios.slice(1), bpm, null, ioiRatios[0]);
    agent._setCurrentPhrase({
      notes: notes, idx: notes.length, ioiRatios: ioiRatios,
      loopable: true, scheduled: true, generated: false,
      _commitContext: agent._captureCommitContext()
    });
    agent._setLastPhraseTime(Date.now());
    _transitionTo('groove');
    return { pc: notes[0], source: 'pedal', confidence: 0.6 };
  }

  // ═══ Create the agent ═══
  var agent = AssistantShared.createVoiceAgent({
    name: 'bass',
    scopeMultiplier: 0.5,
    lexiconKey: 'bass_lexicon',
    phraseWeights: {
      freq: 0.2, interest: 0.3, contextFit: 0.3, loopBonus: 0.15, randomSpread: 0.15,
      metricStartW: 0.7, metricEndW: 0.3, metricScale: 0.2,
      bassRootIntervals: [7], bassRootBoost: 0.1
    },
    observeOwnOutput: true,
    bpmUseScopeMultiplier: true,
    hooks: {

      // ── preGate: State machine brain ──
      // Manages transitions between GROOVE / SEARCHING / ANCHORING.
      // Returns 'passthrough' in SEARCHING/ANCHORING to bypass unified gate.
      preGate: function(ag, dt) {
        // Read context
        var section = 'STABLE';
        if (typeof SectionTracker !== 'undefined') {
          section = SectionTracker.getVoiceState('bass').state;
        }

        // ── Section transition detection ──
        if (section !== _prevSection) {
          _prevSection = section;
          // Section changed — if in groove with active phrase, let replan handle it.
          // If no phrase, go to searching.
          if (_bassState === 'groove' && !Scheduler.hasActivePhrase('bass') && !ag._getCurrentPhrase()) {
            _transitionTo('searching');
          }
        }

        // ── Silence budget (Madison 2006) ──
        var BSM = BASS_STATE_MACHINE;
        var bar = _getBarInfo();
        if (bar.barMs > 0 && _lastNoteTime > 0) {
          var silenceMs = Date.now() - _lastNoteTime;
          var maxSilenceMs = BSM.maxSilenceBars * bar.barMs;
          if (silenceMs > maxSilenceMs && _bassState !== 'searching') {
            _transitionTo('searching');
          }
        }

        // ── State-specific logic ──
        if (_bassState === 'groove') {
          // Check: do we still have a phrase or active schedule?
          if (!Scheduler.hasActivePhrase('bass') && !ag._getCurrentPhrase()) {
            // Phrase ended, no new one queued — transition to searching
            _transitionTo('searching');
            return 'passthrough';
          }

          // Check ANCHORING trigger: high density + needs_space
          var ens = (typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getEnsembleSnapshot)
            ? ContextIntegrator.getEnsembleSnapshot() : null;
          var beliefs = (typeof BeliefState !== 'undefined') ? BeliefState.getBelief('bass') : null;
          if (ens && beliefs) {
            var density = ens.totalDensity || 0;
            var activeCount = ens.activeVoiceCount || 0;
            var needsSpace = beliefs.needs_space || 0;
            if (density > BSM.anchoringDensityThresh &&
                activeCount >= BSM.anchoringVoiceCount &&
                needsSpace > BSM.anchoringNeedsSpace) {
              _transitionTo('anchoring');
              return 'passthrough';
            }
          }

          // Normal groove — let active phrase path handle it
          return null;
        }

        if (_bassState === 'searching') {
          // Check: did a phrase get scheduled externally (e.g. loop replay)?
          if (Scheduler.hasActivePhrase('bass') || ag._getCurrentPhrase()) {
            _transitionTo('groove');
            return null;
          }
          return 'passthrough';
        }

        if (_bassState === 'anchoring') {
          // Exit ANCHORING when density drops
          var ens2 = (typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getEnsembleSnapshot)
            ? ContextIntegrator.getEnsembleSnapshot() : null;
          var beliefs2 = (typeof BeliefState !== 'undefined') ? BeliefState.getBelief('bass') : null;
          if (ens2 && beliefs2) {
            var density2 = ens2.totalDensity || 0;
            var needsSpace2 = beliefs2.needs_space || 0;
            if (density2 < BSM.anchoringDensityThresh * 0.8 || needsSpace2 < BSM.anchoringNeedsSpace * 0.7) {
              _transitionTo('searching');
              return 'passthrough';
            }
          }
          return 'passthrough';
        }

        return null;
      },

      // ── Bass-kick positive sync (v3.2) ──
      // Clayton 2012: bass-percussion coupling 0.7-0.9 in tight ensembles.
      // Large & Jones 1999: entrainment requires predictable temporal alignment.
      // Kept for GROOVE state — helps phrase starts align with kicks.
      // In SEARCHING/ANCHORING, beat-locking in tierCascade handles timing.
      postGap: function(ag, dt) {
        // Only apply kick-lock during GROOVE (phrases benefit from kick alignment)
        if (_bassState !== 'groove') return null;

        // Phase source: prefer BarTracker (human-calibrated), fall back to PhaseCoupling (freerun)
        var barPhase = 0;
        var barMs = 0;
        if (typeof BarTracker !== 'undefined' && BarTracker.getBarConfidence() > 0) {
          barPhase = BarTracker.getBarPhase();
          barMs = BarTracker.getBarPeriod();
        } else if (typeof PhaseCoupling !== 'undefined') {
          barPhase = PhaseCoupling.getBarPhase('bass') || 0;
          barMs = 60000 / Math.max(30, PhaseCoupling.getConsensusBPM() || 120) * 4;
        }
        if (barMs <= 0) return null;

        // Section-dependent coupling: max ms to wait for next kick
        var section = 'STABLE';
        if (typeof SectionTracker !== 'undefined') {
          section = SectionTracker.getVoiceState('bass').state;
        }
        var maxWaitMs = 400;
        if (section === 'STABLE' || section === 'RELEASE') maxWaitMs = 600;
        else if (section === 'BUILD') maxWaitMs = 400;
        else if (section === 'PEAK') maxWaitMs = 200;

        // Dual data source for kick positions
        var kickPositions = null;
        if (typeof PercussionAssistant !== 'undefined' && PercussionAssistant.getKickPositions) {
          kickPositions = PercussionAssistant.getKickPositions();
        }
        if (!kickPositions && typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getRecentKickPhases) {
          kickPositions = ContextIntegrator.getRecentKickPhases();
        }
        if (!kickPositions || kickPositions.length === 0) return null;

        var minDist = 1.0;
        for (var i = 0; i < kickPositions.length; i++) {
          var d = Math.abs(barPhase - kickPositions[i]);
          if (d > 0.5) d = 1 - d;
          if (d < minDist) minDist = d;
        }

        // Near a kick → play now (Hirsh 1959: simultaneity window 20-50ms)
        if (minDist < 0.08) return null;

        // Find next kick
        var nextKickDist = 1.0;
        for (var j = 0; j < kickPositions.length; j++) {
          var forward = kickPositions[j] - barPhase;
          if (forward < 0) forward += 1.0;
          if (forward > 0 && forward < nextKickDist) nextKickDist = forward;
        }

        var waitMs = nextKickDist * barMs;
        if (waitMs <= maxWaitMs) return 'skip';

        var lockStrength = 0.3;
        if (section === 'STABLE' || section === 'RELEASE') lockStrength = 0.4;
        else if (section === 'PEAK') lockStrength = 0.1;
        if (minDist > 0.1 && Math.random() < lockStrength) return 'skip';

        return null;
      },

      // ── Tier cascade: state-aware note production ──
      // GROOVE: motif → lexicon → generator (no PPM)
      // SEARCHING: beat-locked root/fifth + active phrase search
      // ANCHORING: beat 1 root only
      tierCascade: function(ag) {
        var BSM = BASS_STATE_MACHINE;

        // ═══ GROOVE ═══
        if (_bassState === 'groove') {
          var result = null;
          var _mode = (typeof BehaviorModes !== 'undefined')
            ? BehaviorModes.selectMode('bass') : 'bassline';
          var _modeHandler = (typeof BehaviorModes !== 'undefined')
            ? BehaviorModes.getHandler('bass', _mode) : null;

          if (_modeHandler) {
            result = _modeHandler('bass');
            if (!result) return null;
          } else if (_mode === 'rhythmic') {
            result = ag.tier_b_generate();
            if (!result) result = ag.tier_a_lexicon();
            // No PPM fallthrough — transition to searching instead
            if (!result) { _transitionTo('searching'); return null; }
          } else {
            // Bassline (default): MotifDeveloper → lexicon → generate
            var _plan = (typeof PhrasePlanner !== 'undefined') ? PhrasePlanner.planPhrase('bass') : null;
            var _pref = _plan ? _plan.preferredTier : null;
            if (_pref === 'motif' && typeof MotifDeveloper !== 'undefined' && MotifDeveloper.hasSeed('bass')) {
              var dev = MotifDeveloper.develop('bass',
                (typeof SectionTracker !== 'undefined') ? SectionTracker.getVoiceState('bass').state : 'STABLE',
                _plan ? _plan.chordTones : null);
              if (dev && dev.sd && dev.sd.length > 0) {
                var notes = dev.sd;
                if (dev.ioi_ratios && notes.length > 1) {
                  var bpm = ag._getScheduleBpm();
                  Scheduler.schedulePhrase('bass', notes.slice(1), dev.ioi_ratios.slice(1), bpm, null, dev.ioi_ratios[0]);
                  ag._setCurrentPhrase({
                    notes: notes, idx: notes.length, ioiRatios: dev.ioi_ratios,
                    loopable: false, scheduled: true, generated: true,
                    _commitContext: ag._captureCommitContext()
                  });
                  ag._setLastPhraseTime(Date.now());
                  if (typeof MotifDeveloper !== 'undefined') MotifDeveloper.captureSeed(dev.sd, dev.ioi_ratios, 'bass');
                  result = { pc: notes[0], source: 'motif', confidence: 0.75 };
                }
              }
            }
            if (!result) result = ag.tier_a_lexicon();
            if (!result) result = ag.tier_b_generate();
            // No PPM fallthrough — transition to searching
            if (!result) { _transitionTo('searching'); return null; }
          }
          return result;
        }

        // ═══ SEARCHING ═══
        // Beat-locked pedal root/fifth while actively searching for a phrase.
        if (_bassState === 'searching') {
          var bar = _getBarInfo();
          if (bar.barMs <= 0) return null;

          // Track bar count: detect when bar phase wraps past beat 1
          if (_lastBarPhaseForCount >= 0 && bar.phase < _lastBarPhaseForCount && _lastBarPhaseForCount > 0.8) {
            _searchBarCount++;
          }
          _lastBarPhaseForCount = bar.phase;

          // After maxSearchBars, force a root pedal pattern
          if (_searchBarCount >= BSM.maxSearchBars) {
            console.log('[BASS STATE] SEARCHING exceeded ' + BSM.maxSearchBars + ' bars — forcing pedal pattern');
            return _scheduleForcedPedal();
          }

          // Attempt phrase selection every tick (actively searching)
          var phraseResult = ag.tier_a_lexicon();
          if (!phraseResult) phraseResult = ag.tier_b_generate();
          if (phraseResult) {
            // Found a phrase — transition to groove
            _transitionTo('groove');
            return phraseResult;
          }

          // No phrase yet — play beat-locked pedal notes
          var beat = _isOnBeat(bar.phase);
          if (!beat) return null;

          var harm = _getRootAndFifth();
          var third = (harm.root + (SharedState.mode === 'major' ? 4 : 3)) % 12;
          var pc = (beat === 'beat1') ? harm.root : harm.fifth;

          // Same-PC cooldown — try alternatives (third provides harmonic grounding)
          if (_samePCBlocked(pc)) {
            pc = (beat === 'beat1') ? harm.fifth : third;
            if (_samePCBlocked(pc)) {
              pc = (beat === 'beat1') ? third : harm.root;
              if (_samePCBlocked(pc)) return null;
            }
          }

          _onBassNote(pc);
          ag._setLastPhraseTime(Date.now());
          // Publish harmonic intent — bass pedal IS tonal center declaration
          _publishBassIntent(harm.root);
          return { pc: pc, source: 'pedal', confidence: 0.5 };
        }

        // ═══ ANCHORING ═══
        // Root on beat 1 only — minimal presence for maximum ensemble space.
        if (_bassState === 'anchoring') {
          var barA = _getBarInfo();
          if (barA.barMs <= 0) return null;

          var beatA = _isOnBeat(barA.phase);
          if (beatA !== 'beat1') return null;

          var harmA = _getRootAndFifth();
          if (_samePCBlocked(harmA.root)) return null;

          _onBassNote(harmA.root);
          ag._setLastPhraseTime(Date.now());
          // Publish harmonic intent — anchoring root is strong tonal declaration
          _publishBassIntent(harmA.root);
          return { pc: harmA.root, source: 'anchor', confidence: 0.6 };
        }

        return null;
      }

      // tier3Bias removed — PPM is never reached for bass.
    }
  });

  // ── Track note production via EventBus ──
  if (typeof EventBus !== 'undefined') {
    EventBus.on('noteProduced', function(data) {
      if (data && data.voiceName === 'bass') {
        _onBassNote(data.pc);
      }
    });
  }

  // ── Diagnostic logging ──
  var _origOnTick = agent.onTick;
  agent.onTick = function(dt) {
    _logTimer += dt;
    if (_logTimer >= 30000) {
      console.log('[BASS STATE] state=' + _bassState +
        ' searchBars=' + _searchBarCount +
        ' sinceNote=' + (Date.now() - _lastNoteTime) + 'ms');
      _logTimer = 0;
    }
    return _origOnTick(dt);
  };

  // ── Expose state for diagnostics ──
  agent.getBassState = function() { return _bassState; };
  // How long since bass was last in SEARCHING (ms). Used by SectionTracker
  // to suppress spurious keyChanged events that fire after bass returns to GROOVE.
  agent.getTimeSinceSearching = function() {
    if (_bassState !== 'groove') return 0; // currently not in groove
    return Date.now() - _stateEnteredAt; // time since we entered groove
  };

  // ── Reset hook ──
  var _origReset = agent.reset;
  agent.reset = function() {
    _bassState = 'groove';
    _stateEnteredAt = 0;
    _lastBassPC = -1;
    _lastBassPCTime = 0;
    _lastNoteTime = 0;
    _searchBarCount = 0;
    _lastBarPhaseForCount = -1;
    _prevSection = 'STABLE';
    _logTimer = 0;
    if (_origReset) _origReset();
  };

  return agent;
})();

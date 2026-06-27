'use strict';
// ═══ RHYTHM ASSISTANT (v9.1.0 — chord-voicing-first comping architecture) ═══
//
// Fundamental redesign: rhythm is a CHORD VOICING voice, not a melody voice.
// Previous architecture selected lexicon phrases by melodic fitness, discarded
// the scale degrees, and mapped chord tones to IOI positions. This was wrong —
// rhythm's job is to voice chords, create harmonic rhythm, and support the
// ensemble's harmonic progression.
//
// New architecture:
//   1. ChordVoicing is the PRIMARY note source (shell/close/drop2/open)
//   2. IOI patterns are RHYTHM ARCHETYPES selected by section + density
//   3. Technique (arpeggiate/stab/rolled) chosen by section + intent
//   4. Harmonic anticipation: voice-leads to upcoming chords
//   5. Publishes harmonic intent so authority weight (0.85) contributes
//
// All expression hooks preserved: syncopation (Witek 2014), loop variation
// (Margulis 2014), metric articulation (Lerdahl & Jackendoff 1983), and
// FGSR-based density control (PeerModel selective listening).
//
// Research basis:
//   Lerdahl & Jackendoff 1983 — metric position hierarchy
//   Witek et al. 2014 — inverted-U groove syncopation
//   Margulis 2014 — repetition-with-variation
//   Pressing 1999 — micro-timing as groove mechanism
//   Bregman 1990 — streaming, temporal masking, scene analysis
//   Plomp & Levelt 1965 — critical bandwidth, register roughness
//   Huron 2006 — ITPRA expectation model
//   Large & Jones 1999 — entrainment modulation

var RhythmAssistant = (function() {

  // ── Rhythm-specific state ──
  var staggerSkips = 0;
  var _prevVoicing = null;

  // ═══════════════════════════════════════
  // IOI RHYTHM ARCHETYPES
  // ═══════════════════════════════════════
  // Pre-defined rhythmic patterns for chord voicing. Each archetype has
  // IOI ratios (in beats) and a section affinity. Selected by section
  // state and ensemble density — NOT by melodic scoring.
  //
  // These replace the lexicon-as-IOI-template approach. The lexicon's
  // melodic scale degrees are irrelevant for rhythm; only timing matters.

  var IOI_ARCHETYPES = {
    // Sparse patterns (STABLE, RELEASE, low density)
    whole:     { ioi: [4.0],                       sections: ['STABLE', 'RELEASE'], density: 'sparse' },
    half:      { ioi: [2.0, 2.0],                  sections: ['STABLE', 'RELEASE'], density: 'sparse' },
    half_dot:  { ioi: [3.0, 1.0],                  sections: ['STABLE', 'RELEASE'], density: 'sparse' },

    // Medium patterns (BUILD, moderate density)
    quarter:   { ioi: [1.0, 1.0, 1.0, 1.0],        sections: ['STABLE', 'BUILD'], density: 'medium' },
    dotted_q:  { ioi: [1.5, 0.5, 1.5, 0.5],        sections: ['BUILD'],           density: 'medium' },
    charleston:{ ioi: [1.5, 0.5, 1.0, 1.0],        sections: ['BUILD'],           density: 'medium' },
    offbeat:   { ioi: [0.5, 1.5, 0.5, 1.5],        sections: ['BUILD', 'PEAK'],   density: 'medium' },

    // Dense patterns (PEAK, high density)
    eighth:    { ioi: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], sections: ['PEAK'], density: 'dense' },
    driving:   { ioi: [0.5, 0.5, 1.0, 0.5, 0.5, 1.0],           sections: ['PEAK'], density: 'dense' },
    triplet:   { ioi: [0.67, 0.67, 0.67, 0.67, 0.67, 0.67],     sections: ['PEAK', 'BUILD'], density: 'dense' },

    // Syncopated patterns (any section, groove-oriented)
    funk:      { ioi: [0.75, 0.75, 0.5, 1.0, 1.0],              sections: ['BUILD', 'PEAK'], density: 'medium' },
    bossa:     { ioi: [1.5, 1.0, 0.5, 1.0],                     sections: ['STABLE', 'BUILD'], density: 'medium' },
    habanera:  { ioi: [1.0, 0.5, 1.0, 0.5, 1.0],                sections: ['STABLE', 'BUILD'], density: 'medium' }
  };

  // Archetype names grouped by density for selection
  var _sparsePatterns = ['whole', 'half', 'half_dot'];
  var _mediumPatterns = ['quarter', 'dotted_q', 'charleston', 'offbeat', 'funk', 'bossa', 'habanera'];
  var _densePatterns  = ['eighth', 'driving', 'triplet'];

  // ── Select IOI archetype based on section + peer density ──
  function _selectArchetype(section, peerDensity) {
    var pool;
    if (section === 'PEAK') {
      pool = peerDensity > 0.6 ? _mediumPatterns : _densePatterns;
    } else if (section === 'BUILD') {
      pool = peerDensity > 0.7 ? _sparsePatterns : _mediumPatterns;
    } else if (section === 'RELEASE' || section === 'TRANSITION') {
      pool = _sparsePatterns;
    } else {
      // STABLE: medium density default
      pool = peerDensity > 0.5 ? _sparsePatterns : _mediumPatterns;
    }
    // Filter by section affinity
    var filtered = pool.filter(function(name) {
      return IOI_ARCHETYPES[name].sections.indexOf(section) >= 0;
    });
    if (filtered.length === 0) filtered = pool; // fallback to full pool
    return IOI_ARCHETYPES[filtered[Math.floor(Math.random() * filtered.length)]];
  }

  // ═══════════════════════════════════════
  // SYNCOPATION (Witek 2014 inverted-U groove)
  // ═══════════════════════════════════════
  function _syncopateIOI(ioi, sec, intent) {
    var level = 0.10;
    if (sec === 'BUILD')   level = 0.30;
    if (sec === 'PEAK')    level = 0.40;
    if (sec === 'RELEASE') level = 0.15;
    if (intent === 'punctuation') level *= 0.5;
    if (intent === 'contrast')    level = Math.min(0.50, level * 1.5);
    if (level < 0.05 || ioi.length < 2) return ioi;

    var result = ioi.slice();
    var DISPLACE = 0.25;
    var cumulative = 0;
    for (var i = 0; i < result.length; i++) {
      cumulative += result[i];
      if (Math.abs(cumulative - Math.round(cumulative)) < 0.1) continue;
      if (result[i] < DISPLACE + 0.16) continue;
      if (i + 1 < result.length && result[i + 1] < DISPLACE + 0.16) continue;
      if (Math.random() < level) {
        var dir = (Math.random() < 0.65) ? -1 : 1;
        result[i] += dir * DISPLACE;
        if (i + 1 < result.length) result[i + 1] -= dir * DISPLACE;
      }
    }
    return result;
  }

  // ═══════════════════════════════════════
  // LOOP VARIATION (Margulis 2014, Pressing 1999)
  // ═══════════════════════════════════════
  function _varyLoop(notes, ioiRatios, loopCount) {
    var cfg = (typeof LOOP_VARIATION !== 'undefined') ? LOOP_VARIATION : {
      ESTABLISH_LOOPS: 2, SUBTLE_PROB: 0.25, FULL_PROB: 0.50,
      MAX_VARS_PER_LOOP: 2, IOI_MICRO_RANGE: 0.10
    };
    if (loopCount < cfg.ESTABLISH_LOOPS) return { notes: notes, ioiRatios: ioiRatios };

    var prob = (loopCount < 4) ? cfg.SUBTLE_PROB : cfg.FULL_PROB;
    var variedNotes = notes.slice();
    var variedIOI = ioiRatios ? ioiRatios.slice() : null;
    var varsApplied = 0;

    var chordTones = null;
    if (SharedState.currentChord) {
      var r = SharedState.currentChord.rootPC;
      var isMinor = SharedState.currentChord.type === 'minor';
      chordTones = [r, (r + (isMinor ? 3 : 4)) % 12, (r + 7) % 12];
    }

    for (var i = 0; i < variedNotes.length && varsApplied < cfg.MAX_VARS_PER_LOOP; i++) {
      if (Math.random() > prob) continue;
      var type = Math.floor(Math.random() * 3);
      if (type === 0 && chordTones) {
        var currentMod = ((variedNotes[i] % 12) + 12) % 12;
        var alternatives = chordTones.filter(function(ct) { return ct !== currentMod; });
        if (alternatives.length > 0) {
          variedNotes[i] = alternatives[Math.floor(Math.random() * alternatives.length)];
          varsApplied++;
        }
      } else if (type === 1 && variedIOI && i < variedIOI.length) {
        var scale = 1.0 + (Math.random() * 2 - 1) * cfg.IOI_MICRO_RANGE;
        var original = variedIOI[i];
        variedIOI[i] = Math.max(0.16, original * scale);
        if (i + 1 < variedIOI.length) {
          var diff = original - variedIOI[i];
          variedIOI[i + 1] = Math.max(0.16, variedIOI[i + 1] + diff);
        }
        varsApplied++;
      } else if (type === 2 && chordTones) {
        var altTones = chordTones.filter(function(ct) {
          return ct !== (((variedNotes[i]) % 12 + 12) % 12);
        });
        if (altTones.length > 0) {
          variedNotes[i] = altTones[Math.floor(Math.random() * altTones.length)];
          varsApplied++;
        }
      }
    }
    return { notes: variedNotes, ioiRatios: variedIOI };
  }

  // ═══════════════════════════════════════
  // METRIC ARTICULATION (Lerdahl & Jackendoff 1983, Sundberg 1991)
  // ═══════════════════════════════════════
  function _getArticulationMult(barPhase, phraseProgress, section) {
    var cfg = (typeof RHYTHM_ARTICULATION !== 'undefined') ? RHYTHM_ARTICULATION : {
      BEAT1_ACCENT: 1.15, BEAT3_ACCENT: 1.08, BEAT24_ACCENT: 0.92,
      OFFBEAT_ACCENT: 0.85, PHASE_TOLERANCE: 0.04,
      PHRASE_ARC_BOOST: 1.10, PHRASE_ARC_DIM: 0.90,
      SECTION_INTENSITY: { STABLE: 0.6, BUILD: 0.8, PEAK: 1.0, RELEASE: 0.5 }
    };
    var tol = cfg.PHASE_TOLERANCE;
    var metricMult = cfg.OFFBEAT_ACCENT;
    if (barPhase < tol || barPhase > (1.0 - tol)) metricMult = cfg.BEAT1_ACCENT;
    else if (Math.abs(barPhase - 0.5) < tol) metricMult = cfg.BEAT3_ACCENT;
    else if (Math.abs(barPhase - 0.25) < tol || Math.abs(barPhase - 0.75) < tol) metricMult = cfg.BEAT24_ACCENT;

    var arcMult = 1.0;
    if (phraseProgress >= 0 && phraseProgress <= 1.0) {
      var arcPos = 1.0 - Math.abs(phraseProgress * 2.0 - 1.0);
      arcMult = cfg.PHRASE_ARC_DIM + arcPos * (cfg.PHRASE_ARC_BOOST - cfg.PHRASE_ARC_DIM);
    }
    var rawAccent = metricMult * arcMult;
    var intensity = (cfg.SECTION_INTENSITY && cfg.SECTION_INTENSITY[section]) || 0.6;
    return 1.0 + (rawAccent - 1.0) * intensity;
  }

  // ═══════════════════════════════════════
  // CHORD VOICING PROGRESSION GENERATOR
  // ═══════════════════════════════════════
  // The heart of the redesign. Generates a phrase by:
  //   1. Getting current chord voicing from ChordVoicing
  //   2. Selecting an IOI archetype by section + density
  //   3. Mapping voicing PCs to archetype positions
  //   4. Voice-leading final notes toward next predicted chord
  //   5. Applying syncopation + section IOI scaling
  //
  // Returns { pc, source, confidence, _isChord? } or null.

  function _chordProgression(ag) {
    if (typeof HarmonicPlanner === 'undefined' || !HarmonicPlanner.getCurrentContext) return null;
    if (typeof ChordVoicing === 'undefined') return null;

    var ctx = HarmonicPlanner.getCurrentContext();
    if (!ctx) return null;

    var section = (typeof SectionTracker !== 'undefined' && SectionTracker.getVoiceState)
      ? SectionTracker.getVoiceState('rhythm') : { state: 'STABLE' };
    var sec = section.state;
    var intent = (typeof MelodicIntent !== 'undefined' && MelodicIntent.getIntent)
      ? MelodicIntent.getIntent('rhythm') : 'continuation';

    // ── 1. Voicing style from section + intent ──
    var style = 'close';
    if (sec === 'STABLE' || sec === 'RELEASE') style = 'shell';
    if (sec === 'BUILD') style = 'close';
    if (sec === 'PEAK') style = 'drop2';
    if (intent === 'punctuation') style = (style === 'drop2') ? 'close' : 'shell';
    else if (intent === 'contrast') style = (style === 'shell') ? 'close' : 'drop2';

    // ── 2. Technique: arpeggiate vs stab vs rolled ──
    // v9.1.0: Technique selection based on section + intent, not confidence gate.
    // Previous conf >= 0.3 gate meant stab dominated when confidence was high.
    // Now: stab only for punctuation intent, rolled only for PEAK contrast.
    // Arpeggiate is the default — streaming masks pitch uncertainty (Bregman 1990).
    var technique = 'arpeggiate';
    if (intent === 'punctuation' && (sec === 'STABLE' || sec === 'RELEASE')) {
      technique = 'stab';
    } else if (sec === 'PEAK' && intent === 'contrast') {
      technique = 'rolled';
    }

    // ── 3. Get chord voicing (2-4 PCs with voice-leading) ──
    var voicing = ChordVoicing.voiceChord(ctx.rootPC, ctx.type, style, {});
    if (!voicing || voicing.length < 2) return null;
    _prevVoicing = voicing;

    // ── 4. Publish harmonic intent (v9.3.0: via ChordBelief) ──
    // Rhythm's authority weight (0.85) contributes to harmonic consensus.
    if (typeof ChordBelief !== 'undefined') {
      ChordBelief.publishIntent('rhythm', ctx.rootPC, ctx.type, 0.7, 0);
    }

    // v9.2.0: Rhythm voicing confirms chord to ChordBelief (multi-voice voting)
    if (typeof ChordBelief !== 'undefined') {
      ChordBelief.observe(ctx.rootPC, ctx.type, 'rhythm_voicing');
    }

    // ── 5. Stab/Rolled short-circuit ──
    if (technique === 'stab' || technique === 'rolled') {
      var chordResult = voicing.slice();
      chordResult._isChord = true;
      if (technique === 'rolled') chordResult._rolled = true;
      ag._setLastPhraseTime(Date.now());
      ag._setCurrentPhrase({
        notes: voicing, idx: voicing.length, ioiRatios: null,
        loopable: false, scheduled: false,
        harmonicArp: true, chordRoot: ctx.rootPC,
        _commitContext: ag._captureCommitContext()
      });
      return { pc: chordResult, source: 'chord-' + technique, confidence: 0.8, _isChord: true };
    }

    // ── 6. Select IOI archetype (replaces lexicon-as-template) ──
    var peerDensity = 0.5;
    if (typeof PeerModel !== 'undefined' && PeerModel.getFeatureSurpriseMagnitudes) {
      var mags = PeerModel.getFeatureSurpriseMagnitudes('rhythm');
      var soloistMag = (mags.soloist && mags.soloist.energy) || 0;
      var leadMag = (mags.lead && mags.lead.energy) || 0;
      peerDensity = Math.max(soloistMag, leadMag);
    }
    var archetype = _selectArchetype(sec, peerDensity);
    var ioi = archetype.ioi.slice();
    var noteCount = ioi.length + 1;

    // ── 7. IOI scaling by section (Large & Jones entrainment) ──
    var ioiScale = 1.0;
    if (sec === 'BUILD')   ioiScale = 0.85;   // slightly faster (was 0.75 — too aggressive)
    if (sec === 'PEAK')    ioiScale = 0.70;    // faster (was 0.5 — too extreme)
    if (sec === 'RELEASE') ioiScale = 1.3;     // relaxed (was 1.5)
    if (ioiScale !== 1.0) {
      for (var si = 0; si < ioi.length; si++) {
        ioi[si] = Math.max(ioi[si] * ioiScale, 0.16);
      }
    }

    // ── 8. Syncopation (Witek 2014 inverted-U groove) ──
    ioi = _syncopateIOI(ioi, sec, intent);

    // ── 9. Map archetype positions to voicing PCs (cycle through chord tones) ──
    var notes = [];
    for (var i = 0; i < noteCount; i++) {
      notes.push(voicing[i % voicing.length]);
    }

    // ── 10. Harmonic anticipation — voice-lead final notes to next chord ──
    if (HarmonicPlanner.getNextChords) {
      var nextChords = HarmonicPlanner.getNextChords();
      if (nextChords.length > 0 && nextChords[0].confidence > 0.4 &&
          nextChords[0].beatsAway !== undefined && nextChords[0].beatsAway < 3) {
        var nextRoot = nextChords[0].rootPC;
        var nextType = nextChords[0].type || 'minor';
        var nextTones = [
          nextRoot,
          (nextRoot + (nextType === 'minor' ? 3 : 4)) % 12,
          (nextRoot + 7) % 12
        ];
        // Voice-lead last 1-2 notes toward next chord
        var splice = Math.min(2, Math.floor(notes.length / 3));
        for (var ni = 0; ni < splice; ni++) {
          notes[notes.length - 1 - ni] = nextTones[ni % nextTones.length];
        }
      }
    }

    // ── 11. Schedule phrase ──
    var bpm = ag._getScheduleBpm();
    var barConfig = ag._getBarAlignConfig();
    AssistantShared.buildPhraseSchedule('rhythm', notes, ioi, bpm, barConfig);

    ag._setCurrentPhrase({
      notes: notes, idx: notes.length, ioiRatios: ioi,
      loopable: true, scheduled: true,
      harmonicArp: true, chordRoot: ctx.rootPC,
      _commitContext: ag._captureCommitContext()
    });
    ag._setLastPhraseTime(Date.now());

    return { pc: notes[0], source: 'chord-arp', confidence: 0.8 };
  }

  // ═══════════════════════════════════════
  // VOICE AGENT CREATION
  // ═══════════════════════════════════════

  var agent = AssistantShared.createVoiceAgent({
    name: 'rhythm',
    scopeMultiplier: 1.0,
    lexiconKey: 'rhythm_lexicon',
    bpmUseScopeMultiplier: false,
    phraseWeights: {
      freq: 0.15, interest: 0.25, contextFit: 0.25, loopBonus: 0.25, randomSpread: 0.1,
      metricStartW: 0.4, metricEndW: 0.4, metricScale: 0.15,
      bassRootIntervals: [4, 7], bassRootBoost: 0.07
    },
    observeOwnOutput: true,
    // Progressive loop variation (Huron 2006, Margulis 2014)
    loopVariation: function(notes, ioiRatios, loopCount) {
      return _varyLoop(notes, ioiRatios, loopCount);
    },
    // Metric articulation — accents + phrase arc
    computeExpression: function(pc, voiceName, baseExpr) {
      var barPhase = 0;
      if (typeof BarTracker !== 'undefined' && BarTracker.getBarConfidence && BarTracker.getBarConfidence() > 0) {
        barPhase = BarTracker.getBarPhase();
      } else if (typeof PhaseCoupling !== 'undefined' && PhaseCoupling.getBarPhase) {
        barPhase = PhaseCoupling.getBarPhase('rhythm') || 0;
      }
      var progress = (typeof Scheduler !== 'undefined' && Scheduler.getPhraseProgress)
        ? Scheduler.getPhraseProgress('rhythm') : 0.5;
      var sec = 'STABLE';
      try {
        if (typeof SectionTracker !== 'undefined') sec = SectionTracker.getVoiceState('rhythm').state || 'STABLE';
      } catch (e) {}
      var artMult = _getArticulationMult(barPhase, progress, sec);
      baseExpr.velocityMult = Math.max(0.5, Math.min(1.4, baseExpr.velocityMult * artMult));
      return baseExpr;
    },
    hooks: {
      // ── Post-gap: FGSR density control (preserved from v8.6.0) ──
      postGap: function(ag, dt) {
        // 1. Mid-phrase thinning via FGSR (Bregman 1990)
        if (typeof Scheduler !== 'undefined' && Scheduler.hasActivePhrase('rhythm')) {
          var _shouldThin = false;
          if (typeof PeerModel !== 'undefined' && PeerModel.getFeatureSurprises) {
            var surprises = PeerModel.getFeatureSurprises('rhythm');
            if (surprises && surprises.soloist && surprises.soloist.energy) _shouldThin = true;
            if (surprises && surprises.lead && surprises.lead.energy) _shouldThin = true;
          }
          if (_shouldThin && !Scheduler.isThinning('rhythm')) Scheduler.setThinning('rhythm', true);
          else if (!_shouldThin && Scheduler.isThinning('rhythm')) Scheduler.setThinning('rhythm', false);
        } else if (typeof Scheduler !== 'undefined' && Scheduler.isThinning('rhythm')) {
          Scheduler.setThinning('rhythm', false);
        }

        // 2. Phrase gap modulation via FGSR magnitude
        var gapMult = 1.0;
        if (typeof PeerModel !== 'undefined' && PeerModel.getFeatureSurpriseMagnitudes) {
          var mags = PeerModel.getFeatureSurpriseMagnitudes('rhythm');
          var soloistMag = (mags.soloist && mags.soloist.energy) || 0;
          var leadMag = (mags.lead && mags.lead.energy) || 0;
          gapMult += Math.max(soloistMag, leadMag) * 0.4;
        }
        if (typeof BeliefState !== 'undefined') {
          var _bsParams = BeliefState.getParams('rhythm');
          if (_bsParams && _bsParams.minPhraseGapMs > 0 && ag._getLastPhraseTime() > 0) {
            if (typeof DialogueEngine !== 'undefined') {
              var dMod = DialogueEngine.getDensityModifier('rhythm');
              var dialogueGapMult = Math.max(0.6, Math.min(1.4, 1.0 - dMod * 2.0));
              gapMult *= dialogueGapMult;
            }
            var effectiveGap = _bsParams.minPhraseGapMs * gapMult;
            if (Date.now() - ag._getLastPhraseTime() < effectiveGap) return 'skip';
          }
        }

        // 3. Bass & drum yielding via FGSR
        if (typeof PeerModel !== 'undefined') {
          if (PeerModel.getEnergyDirection && PeerModel.getFeatureSurpriseMagnitudes) {
            var bassDirection = PeerModel.getEnergyDirection('bass');
            var bassMags = PeerModel.getFeatureSurpriseMagnitudes('rhythm');
            var bassMag = (bassMags.bass && bassMags.bass.energy) || 0;
            if (bassDirection > 0 && bassMag > 0.3) {
              if (Math.random() < bassMag * 0.35) return 'skip';
            }
          }
          if (PeerModel.getDrumSurprise) {
            var hatState = PeerModel.getDrumSurprise('hat');
            if (hatState.surprise && hatState.magnitude > 0.4) {
              if (Math.random() < (1.0 - hatState.magnitude) * 0.25) return 'skip';
            }
          }
        }

        // Stagger
        var cp = ag._getCurrentPhrase();
        if (!cp && !ag._getLoopPattern() &&
            typeof ContextIntegrator !== 'undefined' && ContextIntegrator.shouldStagger('rhythm')) {
          if (staggerSkips < 2) { staggerSkips++; return 'skip'; }
        }
        staggerSkips = 0;
        return null;
      },

      // ── Tier cascade: chord voicing progression (v9.1.0 redesign) ──
      tierCascade: function(ag) {
        // 1. Loop re-scheduling with chord-match guard
        var cp = ag._getCurrentPhrase();
        if (cp && cp.scheduled && !Scheduler.hasActivePhrase('rhythm')) {
          var _chordMatch = true;
          if (cp.harmonicArp && cp.chordRoot !== undefined) {
            var _curChord = SharedState.currentChord;
            if (_curChord && _curChord.rootPC !== cp.chordRoot) _chordMatch = false;
          }
          var _grooveInv = 0;
          try {
            if (typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getPeerGrooveInvitation) {
              _grooveInv = ContextIntegrator.getPeerGrooveInvitation('rhythm');
            }
          } catch(e) {}
          var _loopMax = 4 + Math.round(_grooveInv * 4);
          try {
            if (typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getRepetitionNoveltyPerVoice) {
              var _rhythmNovelty = ContextIntegrator.getRepetitionNoveltyPerVoice('rhythm');
              if (_rhythmNovelty < 0.15) _loopMax = Math.max(2, _loopMax - 2);
            }
          } catch(e) {}

          if (cp.loopable && (cp.loopCount || 0) < _loopMax && _chordMatch) {
            var bpm = TempoEngine.getEffectiveBPM();
            cp.loopCount = (cp.loopCount || 0) + 1;
            var gc = getGenreConfig(SharedState.genre);
            var loopGap = gc.loopGap !== undefined ? gc.loopGap : 1.0;
            var _varied = _varyLoop(cp.notes, cp.ioiRatios, cp.loopCount);
            Scheduler.schedulePhrase('rhythm', _varied.notes, _varied.ioiRatios, bpm, null, loopGap);
            return null;
          } else {
            ag._setCurrentPhrase(null);
          }
        }

        // 2. Chord voicing progression (PRIMARY — replaces lexicon-first approach)
        var _chordResult = _chordProgression(ag);
        if (_chordResult) return _chordResult;

        // 3. Fallback: lexicon when chord context unavailable, then PPM generation
        // This should be rare — HarmonicPlanner provides context almost always.
        var result = ag.tier_a_lexicon();
        if (!result) result = ag.tier_b_generate();
        return result;
      },

      // Tier 3 bias: chord + bass root + saturation (preserved)
      tier3Bias: function(ag, probs, stm) {
        var biases = [];
        if (SharedState.currentChord) {
          var chRoot = SharedState.currentChord.rootPC;
          var chThird = (chRoot + (SharedState.currentChord.type === 'minor' ? 3 : 4)) % 12;
          var chFifth = (chRoot + 7) % 12;
          biases.push({ pc: chRoot,  boost: 1.3 });
          biases.push({ pc: chThird, boost: 1.2 });
          biases.push({ pc: chFifth, boost: 1.2 });
        }
        var bassRoot = FinalCoordinator.getBassRoot();
        if (bassRoot !== null) {
          var bThird = (bassRoot + (SharedState.mode === 'minor' ? 3 : 4)) % 12;
          var bFifth = (bassRoot + 7) % 12;
          var covered = {};
          for (var bi = 0; bi < biases.length; bi++) covered[biases[bi].pc] = true;
          if (!covered[bThird]) biases.push({ pc: bThird, boost: 1.15 });
          if (!covered[bFifth]) biases.push({ pc: bFifth, boost: 1.15 });
        }
        var satBiases = ContextIntegrator.getSaturationBiases();
        for (var si = 0; si < satBiases.length; si++) biases.push(satBiases[si]);
        if (biases.length > 0) applyRoleBias(probs, biases, stm.recent);
      },

      onReset: function(ag) {
        staggerSkips = 0;
        _prevVoicing = null;
      }
    }
  });

  // Override getCurrentSource for chord progression tracking
  var _origGetCurrentSource = agent.getCurrentSource;
  agent.getCurrentSource = function() {
    var cp = agent._getCurrentPhrase();
    if (cp && cp.harmonicArp) return 'chord-prog';
    return _origGetCurrentSource();
  };

  return agent;
})();

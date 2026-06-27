'use strict';
// ═══ LEAD ASSISTANT (v8.3 — Deliberative Melodist Redesign) ═══
//
// Redesigned from thin wrapper to deliberative melodist.
// 3-mode cognitive model:
//   Mode 1: MELODIC — carry the tune, develop themes via MotifDeveloper
//   Mode 2: SUPPORTIVE — short chord-tone fills when soloist is active
//   Mode 3: ACTIVE_SILENCE — deliberate non-playing
//
// Lead ≠ Soloist:
//   Soloist = conversationalist (react, respond, burst)
//   Lead = melodist (carry melody, develop themes, provide continuity)
//
// Research grounding:
//   - Huron 2006: Melodic arch (28.6% of all phrases), phrase-final descent
//   - Narmour I-R: Proximity, reversal, melodic regression
//   - Frieler 2016: Motivic development (repetition 30%, sequence 20%, fragment 10%)
//   - Wilson & MacDonald 2012: Active silence as musical decision
//   - Zamm 2021: Variable deliberation timing (200-1500ms for lead)
//   - Givan 2016: Lead-soloist dialogic pair (selective listening)
//
// Preserved: createVoiceAgent factory, all integration points, expression (8D),
//   phrase monitor (8A), v8.2 context snapshot, expectancy scoring, EventBus listeners

var LeadAssistant = (function() {

  // ═══════════════════════════════════════════════════════════
  // §1  CONSTANTS (research-cited)
  // ═══════════════════════════════════════════════════════════

  // Deliberation timing (Zamm 2021 — lead enters slightly earlier than soloist)
  var DELIB_BASE_MS = 300;
  var DELIB_MIN_MS  = 200;
  var DELIB_MAX_MS  = 1500;

  // Section modulation of deliberation speed
  var DELIB_SECTION_FACTOR = {
    STABLE: 1.2, BUILD: 0.8, PEAK: 0.6, RELEASE: 1.0, TRANSITION: 1.3
  };

  // Mode base probabilities (lead's primary function is melody)
  var MODE_BASE_PROBS = {
    melodic:    0.60,   // carry the tune, develop themes
    supportive: 0.25,   // chord-tone fills around other voices
    silence:    0.15    // deliberate non-playing (Wilson & MacDonald 2012)
  };

  // Section modulation of mode probabilities
  var MODE_SECTION_MOD = {
    STABLE:     { melodic: 0.7,  supportive: 0.5, silence: 1.5 },
    BUILD:      { melodic: 1.2,  supportive: 0.8, silence: 0.6 },
    PEAK:       { melodic: 1.3,  supportive: 0.5, silence: 0.3 },
    RELEASE:    { melodic: 0.6,  supportive: 1.0, silence: 1.8 },
    TRANSITION: { melodic: 0.5,  supportive: 0.8, silence: 1.5 }
  };

  // Evidence accumulation weights (4 dimensions — simpler than soloist)
  var EVIDENCE_WEIGHTS = {
    harmonic: 0.30,   // key confidence (K-K profiles)
    metric:   0.25,   // bar phase alignment — lead enters on strong beats
    intent:   0.25,   // belief clarity
    space:    0.20    // ensemble density (inverse)
  };

  var COMMIT_THRESHOLD = 0.40;  // lower than soloist — lead enters more readily

  var THRESHOLD_SECTION_MOD = {
    STABLE: 1.05, BUILD: 0.90, PEAK: 0.80, RELEASE: 1.00, TRANSITION: 1.10
  };

  // Cooldowns
  var MELODIC_COOLDOWN_MS    = 3000;
  var SUPPORTIVE_COOLDOWN_MS = 1500;

  // Silence duration
  var SILENCE_BASE_MS = 1500;
  var SILENCE_MIN_MS  = 800;
  var SILENCE_MAX_MS  = 4000;

  // Phrase length bounds
  var MELODIC_MIN_NOTES = 4;

  // Percussion response
  var _percTempBoost = 0;
  var _percTempDecay = 0.995;

  // ═══════════════════════════════════════════════════════════
  // §2  DELIBERATION STATE
  // ═══════════════════════════════════════════════════════════

  // State machine: LISTENING → MELODIC/SUPPORTIVE → COMMITTED → LISTENING
  //                LISTENING → ACTIVE_SILENCE → LISTENING
  var _state           = 'LISTENING';
  var _stateStartMs    = Date.now();
  var _delibTargetMs   = DELIB_BASE_MS;
  var _currentMode     = null;
  var _evidenceScore   = 0;
  var _silenceTargetMs = 0;

  // Cooldown tracking
  var _lastMelodicMs    = Date.now();  // v8.14.0: init to now (not 0) to avoid +0.15 evidence spike on first boot
  var _lastSupportiveMs = Date.now();

  // Section intensity (retained from original for diagnostics)
  var _sectionIntensity = 0.5;

  // ── Melodic phrase memory (antecedent-consequent pairing) ──
  // Tracks phrase-level structure so lead creates question-answer pairs
  // Research: lead-universal-research.md §3 (Period = antecedent + consequent)
  var _melodicMemory = {
    lastEndSD: -1,          // scale degree the last melodic phrase ended on (-1 = none)
    lastContour: 'none',    // 'ascending', 'descending', 'arch', 'none'
    phraseRole: 'antecedent', // next phrase should be antecedent or consequent
    consecutiveMelodic: 0   // how many melodic phrases in a row
  };

  // Response mode statistics (diagnostic)
  var _modeStats = { melodic: 0, supportive: 0, silence: 0, total: 0 };

  // ═══════════════════════════════════════════════════════════
  // §3  HELPERS
  // ═══════════════════════════════════════════════════════════

  // Analyze a phrase's contour and ending for melodic memory
  function _analyzePhrase(notes) {
    if (!notes || notes.length < 3) return { contour: 'none', endSD: -1 };
    var half = Math.floor(notes.length / 2);
    var ascFirst = 0, ascSecond = 0;
    for (var i = 1; i < notes.length; i++) {
      if (notes[i] > notes[i - 1]) {
        if (i <= half) ascFirst++; else ascSecond++;
      }
    }
    var firstRatio = ascFirst / Math.max(1, half);
    var secondRatio = ascSecond / Math.max(1, notes.length - 1 - half);
    var contour;
    if (firstRatio > 0.5 && secondRatio < 0.5) contour = 'arch';
    else if (firstRatio > 0.5) contour = 'ascending';
    else if (firstRatio < 0.5 && secondRatio < 0.5) contour = 'descending';
    else contour = 'arch';  // default to arch for ambiguous
    return { contour: contour, endSD: notes[notes.length - 1] % 12 };
  }

  // Update melodic memory after a melodic phrase commits
  function _updateMelodicMemory(notes) {
    var analysis = _analyzePhrase(notes);
    _melodicMemory.lastEndSD = analysis.endSD;
    _melodicMemory.lastContour = analysis.contour;
    _melodicMemory.consecutiveMelodic++;

    // Determine if this was antecedent or consequent
    // Antecedent: ends on non-tonic (unresolved). Consequent: ends on tonic (resolved).
    var keyRoot = 0;
    if (typeof KeyBelief !== 'undefined') {
      var kb = KeyBelief.getDistribution('lead');
      if (kb && kb.topKey !== undefined) keyRoot = kb.topKey;
    }
    var endedOnTonic = (analysis.endSD === keyRoot) || (analysis.endSD === (keyRoot + 7) % 12);
    if (endedOnTonic) {
      // This was a consequent (resolved) → next should be antecedent (new question)
      _melodicMemory.phraseRole = 'antecedent';
    } else {
      // This was an antecedent (unresolved) → next should be consequent (answer)
      _melodicMemory.phraseRole = 'consequent';
    }
  }

  // Get contour bias for phrase scoring based on melodic memory
  // Returns a preference hint for the melodic cascade
  function _getMelodicBias() {
    var bias = { preferDescending: false, preferTonic: false, preferContrast: false };
    if (_melodicMemory.phraseRole === 'consequent') {
      // Answer the question: descend, resolve to tonic
      bias.preferDescending = true;
      bias.preferTonic = true;
    }
    // After 3+ consecutive melodic phrases, prefer contrast or silence
    if (_melodicMemory.consecutiveMelodic >= 3) {
      bias.preferContrast = true;
    }
    return bias;
  }

  function _getSection() {
    if (typeof SectionTracker !== 'undefined') {
      var vs = SectionTracker.getVoiceState('lead');
      return (vs && vs.state) ? vs.state : 'STABLE';
    }
    return 'STABLE';
  }

  // Variable deliberation timing (Zamm 2021)
  function _computeDeliberationMs() {
    var beliefConf = 0.5;
    if (typeof BeliefState !== 'undefined') {
      var params = BeliefState.getParams('lead');
      if (params && params.dominantProb) beliefConf = params.dominantProb;
    }
    var confidenceFactor = 1.0 / Math.max(0.3, beliefConf);

    var section = _getSection();
    var sectionFactor = DELIB_SECTION_FACTOR[section] || 1.0;

    var densityFactor = 1.0;
    if (typeof ContextIntegrator !== 'undefined') {
      var snap = ContextIntegrator.getEnsembleSnapshot();
      if (snap && typeof snap.totalDensity === 'number') {
        densityFactor = 1.0 + (snap.totalDensity - 1.5) * 0.2;
      }
    }

    var raw = DELIB_BASE_MS * confidenceFactor * sectionFactor * densityFactor;
    return Math.max(DELIB_MIN_MS, Math.min(DELIB_MAX_MS, raw));
  }

  // 4-dimension evidence accumulation
  function _computeEvidence() {
    var score = 0;

    // 1. Harmonic clarity
    var harmonicScore = 0.5;
    if (typeof KeyBelief !== 'undefined') {
      harmonicScore = KeyBelief.getConfidence('lead') || 0.5;
    }
    score += EVIDENCE_WEIGHTS.harmonic * harmonicScore;

    // 2. Metric alignment — downbeat preferred for lead (melodic entrance)
    var metricScore = 0.5;
    if (typeof BarTracker !== 'undefined') {
      var barPhase = BarTracker.getBarPhase();
      var distToDown = Math.min(barPhase, 1.0 - barPhase);
      var distToThree = Math.abs(barPhase - 0.5);
      // Weight downbeat higher than beat 3 for lead
      var distToStrong = Math.min(distToDown * 0.8, distToThree);
      metricScore = 1.0 - distToStrong * 3.5;
      metricScore = Math.max(0, Math.min(1, metricScore));
    }
    score += EVIDENCE_WEIGHTS.metric * metricScore;

    // 3. Intent clarity
    var intentScore = 0.5;
    if (typeof BeliefState !== 'undefined') {
      var params = BeliefState.getParams('lead');
      if (params && params.dominantProb) intentScore = params.dominantProb;
    }
    score += EVIDENCE_WEIGHTS.intent * intentScore;

    // 4. Ensemble space
    var spaceScore = 0.5;
    if (typeof ContextIntegrator !== 'undefined') {
      var snap = ContextIntegrator.getEnsembleSnapshot();
      if (snap && typeof snap.totalDensity === 'number') {
        spaceScore = 1.0 - Math.min(1.0, snap.totalDensity / 3.0);
      }
    }
    score += EVIDENCE_WEIGHTS.space * spaceScore;

    // v8.14.0: Silence-recovery signal — if lead hasn't committed a phrase in 1+ seconds,
    // boost evidence to prevent the deliberation lockout identified in scope investigation.
    // Lead's LISTENING state returns 'skip' every tick, creating 200-1500ms hard blocks.
    // Without recovery, these blocks compound into 99% scope blocking after ~60s.
    // Linear ramp from 0 at 1s silence to +0.15 cap at 1.75s. Ensures lead re-enters
    // within one deliberation cycle after silence.
    var _silenceMs = Date.now() - Math.max(_lastMelodicMs, _lastSupportiveMs);
    if (_silenceMs > 1000) {
      // v9.0.1: 0.15→0.22, 5000→4000 — faster recovery prevents indefinite LISTENING loops
      var _recoveryBoost = Math.min(0.22, (_silenceMs - 1000) / 4000);
      score += _recoveryBoost;
    }

    return score;
  }

  // Mode selection with section + soloist modulation
  function _selectMode() {
    var probs = {
      melodic:    MODE_BASE_PROBS.melodic,
      supportive: MODE_BASE_PROBS.supportive,
      silence:    MODE_BASE_PROBS.silence
    };

    // 1. Section modulation
    var section = _getSection();
    var secMod = MODE_SECTION_MOD[section] || MODE_SECTION_MOD.STABLE;
    probs.melodic    *= secMod.melodic;
    probs.supportive *= secMod.supportive;
    probs.silence    *= secMod.silence;

    // 2. Resolution urgency — gentle bias toward supportive (Bigand 1996)
    //    Lead CAN still play melodically during cadence — countermelody is musical.
    //    Just mildly prefer supportive mode, don't suppress melodic.
    var urgency = 0;
    if (typeof SectionTracker !== 'undefined') {
      urgency = SectionTracker.getState().resolutionUrgency || 0;
    }
    if (urgency > 0.3) {
      probs.melodic    *= Math.max(0.5, 1.0 - urgency * 0.5);  // 0.85→0.5 (halved, not killed)
      probs.supportive *= 1.0 + urgency * 0.5;                   // 1.15→1.5 (gentle)
      // silence unchanged — lead doesn't need to go quiet for resolution
    }

    // 3. Soloist awareness — dialogic pair (Givan 2016)
    //    Only defer strongly during soloist DIRECTIONAL phrases (the rare big statements).
    //    During soloist comp fills, lead should keep its melodic identity.
    if (typeof Scheduler !== 'undefined' && Scheduler.hasActivePhrase('soloist')) {
      var soloInDirectional = (typeof SoloAssistant !== 'undefined' &&
        SoloAssistant.getDeliberationState &&
        SoloAssistant.getDeliberationState().state === 'DIR_COMMITTED');
      if (soloInDirectional) {
        // Strong deference: soloist is making a directional statement
        probs.supportive *= 2.0;
        probs.melodic    *= 0.3;
      } else {
        // Mild deference: soloist is just doing a comp fill — lead can still be melodic
        probs.supportive *= 1.2;
        probs.melodic    *= 0.8;
      }
    }

    // 3. Density modulation (Wilson & MacDonald 2012)
    var density = 1.0;
    if (typeof ContextIntegrator !== 'undefined') {
      var snap = ContextIntegrator.getEnsembleSnapshot();
      if (snap && typeof snap.totalDensity === 'number') density = snap.totalDensity;
    }
    if (density > 2.0) {
      probs.silence    *= 1.5;
      probs.supportive *= 0.5;
    } else if (density < 1.0) {
      probs.melodic *= 1.3;
      probs.silence *= 0.5;
    }

    // 4. Dialogue stance modulation
    if (typeof DialogueEngine !== 'undefined') {
      var stance = DialogueEngine.getStance('lead');
      if (stance) {
        var st = stance.stance || stance.type || '';
        if (st === 'lead' || st === 'contradict') {
          probs.melodic *= 1.3;
        } else if (st === 'question') {
          probs.silence *= 1.3;
        } else if (st === 'support' || st === 'agree') {
          probs.supportive *= 1.3;
        }
      }
    }

    // 5. Melodic fatigue — after 3+ consecutive melodic, bias toward rest
    if (_melodicMemory.consecutiveMelodic >= 3) {
      probs.silence    *= 1.5;
      probs.supportive *= 1.3;
      probs.melodic    *= 0.6;
    }

    // 6. Percussion boost
    if (_percTempBoost > 0.05) {
      probs.melodic *= 1.2;
      probs.silence *= 0.7;
    }

    // Normalize
    var total = probs.melodic + probs.supportive + probs.silence;
    if (total <= 0) return 'silence';
    probs.melodic    /= total;
    probs.supportive /= total;
    probs.silence    /= total;

    var r = Math.random();
    if (r < probs.melodic) return 'melodic';
    r -= probs.melodic;
    if (r < probs.supportive) return 'supportive';
    return 'silence';
  }

  function _computeSilenceDuration() {
    var section = _getSection();
    var secFactors = { STABLE: 1.2, BUILD: 0.7, PEAK: 0.5, RELEASE: 1.5, TRANSITION: 1.0 };
    var factor = secFactors[section] || 1.0;
    var raw = SILENCE_BASE_MS * factor * (0.7 + Math.random() * 0.6);
    return Math.max(SILENCE_MIN_MS, Math.min(SILENCE_MAX_MS, raw));
  }

  // Update section intensity for diagnostics
  function _updateSectionIntensity() {
    var section = _getSection();
    var targets = { STABLE: 0.15, BUILD: 0.55, PEAK: 0.85, RELEASE: 0.35, TRANSITION: 0.20 };
    var target = targets[section] || 0.3;
    _sectionIntensity += (target - _sectionIntensity) * 0.1;
  }

  // ═══════════════════════════════════════════════════════════
  // §4  DELIBERATION STATE MACHINE
  // ═══════════════════════════════════════════════════════════

  function _updateDeliberation(ag, dt) {
    var now = Date.now();

    _updateSectionIntensity();
    _percTempBoost *= _percTempDecay;
    if (_percTempBoost < 0.005) _percTempBoost = 0;

    // ── COMMITTED: phrase playing ──
    if (_state === 'COMMITTED') {
      if (!Scheduler.hasActivePhrase('lead') && !ag._getCurrentPhrase()) {
        _state = 'LISTENING';
        _stateStartMs = now;
        _delibTargetMs = _computeDeliberationMs();
        _currentMode = null;
      }
      return null;
    }

    // ── ACTIVE_SILENCE ──
    if (_state === 'ACTIVE_SILENCE') {
      if (now - _stateStartMs >= _silenceTargetMs) {
        _state = 'LISTENING';
        _stateStartMs = now;
        _delibTargetMs = _computeDeliberationMs();
        _currentMode = null;
      }
      return 'skip';
    }

    // ── MELODIC / SUPPORTIVE: let tierCascade run ──
    if (_state === 'MELODIC' || _state === 'SUPPORTIVE') {
      return null;
    }

    // ── LISTENING: accumulate evidence ──
    var elapsed = now - _stateStartMs;

    if (elapsed >= _delibTargetMs) {
      _evidenceScore = _computeEvidence();
      var section = _getSection();
      // v8.14.0: Evidence falloff — threshold decays toward 60% of base after 2s waiting.
      // This is the escape hatch: if lead has been in LISTENING for 2+ seconds, lower the bar.
      // At 0s: full threshold. At 2s: starts dropping. At 4s: reaches 60% floor.
      // Prevents the indefinite LISTENING→skip→LISTENING loop that causes 99% blocking.
      var _delibDecay = elapsed > 2000 ? Math.max(0.6, 1.0 - (elapsed - 2000) / 5000) : 1.0;
      var adjustedThreshold = COMMIT_THRESHOLD * (THRESHOLD_SECTION_MOD[section] || 1.0) * _delibDecay;

      // v9.0.1: PEAK commitment boost — lead should commit at climax, not retreat.
      // Arc test showed gate dropping to 0.27 during PEAK (needs_space dominates evidence).
      // Direct evidence boost ensures lead participates in the most dramatic moments.
      if (section === 'PEAK') _evidenceScore += 0.15;
      else if (section === 'BUILD') _evidenceScore += 0.08;

      if (_evidenceScore >= adjustedThreshold) {
        var melodicReady    = (now - _lastMelodicMs) >= MELODIC_COOLDOWN_MS;
        var supportiveReady = (now - _lastSupportiveMs) >= SUPPORTIVE_COOLDOWN_MS;

        var mode = _selectMode();

        // Enforce cooldowns
        if (mode === 'melodic' && !melodicReady) {
          mode = supportiveReady ? 'supportive' : 'silence';
        } else if (mode === 'supportive' && !supportiveReady) {
          mode = melodicReady ? 'melodic' : 'silence';
        }

        if (mode === 'silence') {
          _state = 'ACTIVE_SILENCE';
          _stateStartMs = now;
          _silenceTargetMs = _computeSilenceDuration();
          _currentMode = 'silence';
          _melodicMemory.consecutiveMelodic = 0;  // silence breaks the melodic thread
          _modeStats.silence++;
          _modeStats.total++;
          return 'skip';
        }

        _state = mode === 'melodic' ? 'MELODIC' : 'SUPPORTIVE';
        _stateStartMs = now;
        _currentMode = mode;
        return null;
      } else {
        _delibTargetMs += 150;
        _delibTargetMs = Math.min(_delibTargetMs, DELIB_MAX_MS);
      }
    }

    return 'skip';
  }

  // ═══════════════════════════════════════════════════════════
  // §5  TIER CASCADES (mode-driven)
  // ═══════════════════════════════════════════════════════════

  // Melodic: MotifDeveloper → lexicon → generate → PPM
  // Thematic continuity: develop own ideas before reaching for new ones
  function _melodicCascade(ag) {
    var section = _getSection();

    // v8.14.0: Always set chordHint for lead, even in melodic mode.
    // Previously only supportive mode set this, leaving melodic mode (~60% of phrases)
    // without the +0.15/-0.05 chord-tone scoring bonus. Lead's HARMONIC_AUTHORITY_WEIGHT
    // (0.95) demands harmonic grounding in all modes. The chordHint biases scoring
    // but doesn't force chord tones — melodic contour still dominates via I-R weights.
    if (typeof HarmonicPlanner !== 'undefined') {
      var _mCtx = HarmonicPlanner.getCurrentContext('lead');
      if (_mCtx && _mCtx.chordTones) ag._chordHint = _mCtx.chordTones;
    }

    // 0. Shared phrase answering — when in consequent mode, answer peer's phrase
    // Givan 2016: lead-soloist dialogic pair. Lead answers soloist's "question".
    if (_melodicMemory.phraseRole === 'consequent' &&
        typeof SharedPhraseMemory !== 'undefined' && SharedPhraseMemory.getPoolSize() > 0) {
      var chordCtx = null;
      if (typeof HarmonicPlanner !== 'undefined') {
        var hCtx = HarmonicPlanner.getCurrentContext('lead');
        if (hCtx && hCtx.chordTones) chordCtx = hCtx.chordTones;
      }
      var shared = SharedPhraseMemory.selectAndAdapt('lead', section, chordCtx);
      if (shared && shared.sd && shared.sd.length >= MELODIC_MIN_NOTES) {
        var sIoi = shared.ioi_ratios;
        if (!sIoi || sIoi.length < shared.sd.length - 1) {
          sIoi = [];
          for (var si = 0; si < shared.sd.length; si++) sIoi.push(1.0);
        }
        var bpm = TempoEngine.getEffectiveBPM();
        Scheduler.schedulePhrase('lead', shared.sd.slice(1), sIoi.slice(1), bpm, null, sIoi[0]);
        ag._setCurrentPhrase({
          notes: shared.sd, idx: shared.sd.length, ioiRatios: sIoi,
          loopable: false, scheduled: true, generated: true,
          _commitContext: ag._captureCommitContext()
        });
        ag._setLastPhraseTime(Date.now());
        if (typeof MotifDeveloper !== 'undefined') {
          MotifDeveloper.captureSeed(shared.sd, sIoi, 'lead');
        }
        _updateMelodicMemory(shared.sd);
        return { pc: shared.sd[0], source: 'shared_answer', confidence: 0.80 };
      }
    }

    // 1. MotifDeveloper — develop existing theme
    // Frieler 2016: repetition 30%, sequence 20%, fragmentation 10%
    if (typeof MotifDeveloper !== 'undefined' && MotifDeveloper.hasSeed('lead')) {
      var chordTones = null;
      if (typeof HarmonicPlanner !== 'undefined') {
        var ctx = HarmonicPlanner.getCurrentContext('lead');
        if (ctx && ctx.chordTones) chordTones = ctx.chordTones;
      }
      var dev = MotifDeveloper.develop('lead', section, chordTones);
      if (dev && dev.sd && dev.sd.length >= MELODIC_MIN_NOTES && dev.ioi_ratios) {
        var notes = dev.sd;
        var bpm = TempoEngine.getEffectiveBPM();
        Scheduler.schedulePhrase('lead', notes.slice(1), dev.ioi_ratios.slice(1), bpm, null, dev.ioi_ratios[0]);
        ag._setCurrentPhrase({
          notes: notes, idx: notes.length, ioiRatios: dev.ioi_ratios,
          loopable: false, scheduled: true, generated: true,
          _commitContext: ag._captureCommitContext()
        });
        ag._setLastPhraseTime(Date.now());
        MotifDeveloper.captureSeed(dev.sd, dev.ioi_ratios, 'lead');
        return { pc: notes[0], source: 'motif_dev', confidence: 0.80 };
      }
    }

    // v9.1.0: Wire melodic bias into scoring context.
    // When in consequent mode, lead prefers tonic-ending phrases (Lerdahl & Jackendoff 1983).
    // The bias is read by scoreLexiconEntry via agent._tonicBias.
    var _bias = _getMelodicBias();
    ag._tonicBias = _bias.preferTonic ? 0.12 : 0;  // additive bonus for tonic-ending phrases

    // 2. Intent-aware tier cascade (v8.2 shared logic)
    var intent = (typeof MelodicIntent !== 'undefined') ? MelodicIntent.getIntent('lead') : null;
    var result = null;

    if (intent === 'contrast') {
      result = ag.tier_b_generate();
      if (!result) result = ag.tier_a_lexicon();
    } else {
      // Default: lexicon first — lead prefers established melodic material
      result = ag.tier_a_lexicon();
      if (!result) result = ag.tier_b_generate();
    }

    // Capture seed from committed phrase for future MotifDeveloper development
    if (result && typeof MotifDeveloper !== 'undefined') {
      var cp = ag._getCurrentPhrase();
      if (cp && cp.notes && cp.notes.length >= 3) {
        // Generate default IOI ratios if not present (PPM/loop phrases lack them)
        var seedIOI = cp.ioiRatios;
        if (!seedIOI || seedIOI.length < cp.notes.length - 1) {
          seedIOI = [];
          for (var ii = 0; ii < cp.notes.length; ii++) seedIOI.push(1.0);  // quarter-note default
        }
        MotifDeveloper.captureSeed(cp.notes, seedIOI, 'lead');
      }
    }

    return result;
  }

  // Supportive: chord-tone fill → PPM generation with chord bias
  function _supportiveCascade(ag) {
    if (typeof HarmonicPlanner !== 'undefined') {
      var ctx = HarmonicPlanner.getCurrentContext('lead');
      if (ctx && ctx.chordTones) {
        ag._chordHint = ctx.chordTones;
      }
    }
    var result = ag.tier_b_generate();
    ag._chordHint = null;
    return result;
  }

  // ═══════════════════════════════════════════════════════════
  // §6  VOICE AGENT CREATION
  // ═══════════════════════════════════════════════════════════

  var agent = AssistantShared.createVoiceAgent({
    name: 'lead',
    scopeMultiplier: 1.5,  // match soloist — prevents deliberation starvation (was 1.0, 99% scope block)
    lexiconKey: 'solo_lexicon',
    lexiconFallbacks: ['rhythm_lexicon'],
    bpmUseScopeMultiplier: false,
    ownershipCheck: false,
    skipBeliefGate: true,  // lead has its own evidence-based deliberation gate
    recentPhraseMemory: (typeof RECENT_PHRASE_MEMORY !== 'undefined') ? RECENT_PHRASE_MEMORY : 5,
    phraseWeights: {
      freq: 0.1, interest: 0.4, contextFit: 0.3,
      loopBonus: 0.05, randomSpread: 0.15,
      metricStartW: 0.6, metricEndW: 0.4, metricScale: 0.15,
      // v8.6.0 QW4: Section intensity → phrase selection (Lead-role-research.md §9)
      // STABLE: moderate length, slower IOI. BUILD: longer, faster. PEAK: max length.
      // RELEASE: shorter, slower. Phrases that match section energy score higher.
      extraScorer: function(entry, key, score) {
        var intensity = _sectionIntensity;
        var bonus = 0;
        // Length preference: intensity 0→short (4-6), 0.5→medium (5-8), 1.0→long (8+)
        var idealLen = 4 + intensity * 8; // 4 at STABLE, 12 at PEAK
        var lenDist = Math.abs((entry.length || 5) - idealLen) / idealLen;
        bonus -= lenDist * 0.08; // penalty for length mismatch (max ~0.08)
        // IOI speed: high intensity → prefer shorter IOI ratios
        if (entry.ioi_ratios && entry.ioi_ratios.length > 0) {
          var avgIOI = 0;
          for (var i = 0; i < entry.ioi_ratios.length; i++) avgIOI += entry.ioi_ratios[i];
          avgIOI /= entry.ioi_ratios.length;
          var idealIOI = 1.5 - intensity * 0.8; // 1.5 at rest, 0.7 at peak
          var ioiDist = Math.abs(avgIOI - idealIOI) / idealIOI;
          bonus -= ioiDist * 0.06; // penalty for speed mismatch
        }
        return bonus;
      }
    },
    observeOwnOutput: true,
    hooks: {
      // ── Post-gap: deliberation state machine driver ──
      postGap: function(ag, dt) {
        return _updateDeliberation(ag, dt);
      },

      // ── Tier cascade: mode-driven ──
      tierCascade: function(ag) {
        var cp = ag._getCurrentPhrase();
        if (cp && cp.scheduled && !Scheduler.hasActivePhrase('lead')) {
          ag._setCurrentPhrase(null);
        }

        if (_state !== 'MELODIC' && _state !== 'SUPPORTIVE') return null;

        var result = null;
        if (_currentMode === 'melodic') {
          result = _melodicCascade(ag);
          ag._chordHint = null;  // v8.14.0: clear after melodic cascade (set inside for scoring)
        } else if (_currentMode === 'supportive') {
          result = _supportiveCascade(ag);
        }

        if (result) {
          _state = 'COMMITTED';
          _stateStartMs = Date.now();
          // Increment stats FIRST (before any other state changes)
          var modeForStats = _currentMode;
          _modeStats[modeForStats] = (_modeStats[modeForStats] || 0) + 1;
          _modeStats.total++;
          if (modeForStats === 'melodic') {
            _lastMelodicMs = Date.now();
            // Update melodic memory — track antecedent/consequent pairing
            var committedPhrase = ag._getCurrentPhrase();
            if (committedPhrase && committedPhrase.notes) {
              _updateMelodicMemory(committedPhrase.notes);
            }
          } else {
            _lastSupportiveMs = Date.now();
            // Non-melodic resets consecutive count
            _melodicMemory.consecutiveMelodic = 0;
          }
        } else {
          // Cascade failed → return to LISTENING
          _state = 'LISTENING';
          _stateStartMs = Date.now();
          _delibTargetMs = _computeDeliberationMs();
          _currentMode = null;
        }
        return result;
      },

      // ── Tier 3 bias: key root/fifth/third + chord awareness ──
      tier3Bias: function(ag, probs, stm) {
        var keyRoot = null;
        if (typeof KeyBelief !== 'undefined') {
          var kb = KeyBelief.getDistribution('lead');
          if (kb && kb.topKey !== undefined) keyRoot = kb.topKey;
        }
        if (keyRoot !== null) {
          var biases = [
            { pc: keyRoot, boost: 1.2 },
            { pc: (keyRoot + 7) % 12, boost: 1.3 },
            { pc: (keyRoot + 4) % 12, boost: 1.1 },
            { pc: (keyRoot + 3) % 12, boost: 1.1 }
          ];
          if (typeof HarmonicPlanner !== 'undefined') {
            var ctx = HarmonicPlanner.getCurrentContext('lead');
            if (ctx && ctx.chordTones) {
              // Mild resolution-proportional chord-tone boost
              // Lead should be aware of harmony but not locked to it (Sawyer 2003)
              var _urg = 0;
              if (typeof SectionTracker !== 'undefined') {
                _urg = SectionTracker.getState().resolutionUrgency || 0;
              }
              var ctBoost = 1.15 + _urg * 0.45; // 1.15 → 1.6 during resolution
              for (var ci = 0; ci < ctx.chordTones.length; ci++) {
                biases.push({ pc: ctx.chordTones[ci] % 12, boost: ctBoost });
              }
            }
          }
          var satBiases = ContextIntegrator.getSaturationBiases();
          for (var si = 0; si < satBiases.length; si++) biases.push(satBiases[si]);
          applyRoleBias(probs, biases, stm.recent);
        }
      },

      // ── Reset ──
      onReset: function(ag) {
        _state = 'LISTENING';
        _stateStartMs = Date.now();
        _delibTargetMs = DELIB_BASE_MS;
        _currentMode = null;
        _evidenceScore = 0;
        _silenceTargetMs = 0;
        _sectionIntensity = 0.5;
        _lastMelodicMs = Date.now();
        _lastSupportiveMs = Date.now();
        _percTempBoost = 0;
        _modeStats = { melodic: 0, supportive: 0, silence: 0, total: 0 };
        _melodicMemory = { lastEndSD: -1, lastContour: 'none', phraseRole: 'antecedent', consecutiveMelodic: 0 };
      }
    }
  });

  // ═══════════════════════════════════════════════════════════
  // §7  OVERRIDES
  // ═══════════════════════════════════════════════════════════

  agent.getCurrentSource = function() {
    if (_state === 'LISTENING') return 'deliberating';
    if (_state === 'ACTIVE_SILENCE') return 'silence';
    if (_state === 'MELODIC') return 'melodic';
    if (_state === 'SUPPORTIVE') return 'supportive';
    var cp = agent._getCurrentPhrase();
    if (cp) return cp.generated ? 'generate' : 'lexicon';
    return agent._getLoopPattern() ? 'loop' : 'ppm';
  };

  agent.getPhraseProgress = function() {
    if (_state === 'LISTENING' || _state === 'ACTIVE_SILENCE') return 0.0;
    if (_state === 'MELODIC' || _state === 'SUPPORTIVE') return 0.0;
    if (Scheduler.hasActivePhrase('lead')) return Scheduler.getPhraseProgress('lead');
    var cp = agent._getCurrentPhrase();
    if (cp && !cp.scheduled && cp.idx < cp.notes.length) return cp.idx / cp.notes.length;
    var lp = agent._getLoopPattern();
    if (lp && lp.length > 0) return agent._getLoopIdx() / lp.length;
    return 0.5;
  };

  // ═══════════════════════════════════════════════════════════
  // §8  DIAGNOSTIC APIs
  // ═══════════════════════════════════════════════════════════

  agent.getDeliberationState = function() {
    return {
      state: _state,
      mode: _currentMode,
      deliberationMs: Date.now() - _stateStartMs,
      targetMs: _delibTargetMs,
      evidenceScore: +_evidenceScore.toFixed(3),
      sectionIntensity: +_sectionIntensity.toFixed(3),
      silenceTargetMs: _silenceTargetMs,
      hasMotifSeed: (typeof MotifDeveloper !== 'undefined') ? MotifDeveloper.hasSeed('lead') : false,
      melodicMemory: {
        phraseRole: _melodicMemory.phraseRole,
        lastContour: _melodicMemory.lastContour,
        lastEndSD: _melodicMemory.lastEndSD,
        consecutiveMelodic: _melodicMemory.consecutiveMelodic
      }
    };
  };

  agent.getModeStats = function() {
    var t = _modeStats.total || 1;
    return {
      total: _modeStats.total,
      melodic:    +(_modeStats.melodic / t).toFixed(3),
      supportive: +(_modeStats.supportive / t).toFixed(3),
      silence:    +(_modeStats.silence / t).toFixed(3),
      raw: {
        melodic: _modeStats.melodic,
        supportive: _modeStats.supportive,
        silence: _modeStats.silence
      }
    };
  };

  // Backward compatibility
  agent.getSectionIntensity = function() { return _sectionIntensity; };

  // ═══════════════════════════════════════════════════════════
  // §9  EVENT LISTENERS
  // ═══════════════════════════════════════════════════════════

  if (typeof EventBus !== 'undefined') {
    EventBus.on('lexiconLoaded', function(data) {
      if (data && data.genre) agent.loadLexicon(data.genre);
    });
    var _PERC_ESCALATION = { 'sparse': 0, 'basic': 1, 'driving': 2 };
    EventBus.on('percPatternChange', function(ev) {
      var fromLevel = _PERC_ESCALATION[ev.from] || 0;
      var toLevel = _PERC_ESCALATION[ev.to] || 0;
      if (toLevel > fromLevel) {
        _percTempBoost = Math.min(0.15, (toLevel - fromLevel) * 0.08);
      }
    });
    EventBus.on('percFillSignal', function() {
      _percTempBoost = 0.15;
      if (_state === 'LISTENING') {
        _delibTargetMs = Math.max(DELIB_MIN_MS, _delibTargetMs * 0.6);
      }
    });
  }

  return agent;
})();

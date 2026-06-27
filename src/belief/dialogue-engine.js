'use strict';
// ═══ DIALOGUE STANCE ENGINE (Phase D — Hierarchical Prediction) ═══
//
// Models the musical conversation between human and machine.
// Determines whether the system should FOLLOW (agree, support),
// EXTEND (develop, elaborate), QUESTION (introduce tension),
// or LEAD (take initiative when human is sparse).
//
// The stance influences:
//   - PhraseGenerator temperature and adventurousness
//   - MotifDeveloper operation selection
//   - Voice density decisions
//   - How tightly the system tracks the human's harmonic choices
//
// Stance is computed from:
//   - Human activity level (notes per second, density)
//   - System vs human ownership balance
//   - SectionTracker state (BUILD → extend, RELEASE → agree)
//   - Harmonic divergence (is the human exploring?)
//   - Surprise thermostat readings
//
// Depends on: event-bus.js, prediction-engine.js (SharedState),
//             section-tracker.js, context-integrator.js, ownership-detector.js
// Load order: after section-tracker.js, before phrase-planner.js

var DialogueEngine = (function() {

  // ══════════════════════════════════════
  // STANCE DEFINITIONS
  // ══════════════════════════════════════
  // Each stance is a point on two axes:
  //   initiative: 0 (follow) to 1 (lead)
  //   agreement:  0 (contradict/question) to 1 (agree/support)

  var STANCES = {
    agree:      { initiative: 0.1, agreement: 0.9, label: 'agree' },
    support:    { initiative: 0.2, agreement: 0.8, label: 'support' },
    extend:     { initiative: 0.4, agreement: 0.6, label: 'extend' },
    question:   { initiative: 0.5, agreement: 0.3, label: 'question' },
    lead:       { initiative: 0.8, agreement: 0.5, label: 'lead' },
    contradict: { initiative: 0.6, agreement: 0.1, label: 'contradict' }
  };

  // ── Current state (smoothed) ──
  var currentStance = 'support';
  var initiative = 0.2;
  var agreement = 0.8;
  var targetInitiative = 0.2;
  var targetAgreement = 0.8;

  // ── Tracking ──
  var humanNoteCount = 0;      // notes in current window
  var humanNoteWindow = [];    // timestamps
  var WINDOW_MS = 4000;        // 4-second density window
  var humanActiveRoles = 0;    // how many roles does the human own?
  var lastHumanNoteTime = 0;
  var silenceBeats = 0;

  // ── Smoothing ──
  var SMOOTH_RATE = 0.12;  // v2.4: increased from 0.08 for faster stance transitions

  // ══════════════════════════════════════
  // STANCE COMPUTATION
  // ══════════════════════════════════════

  // v2.2: Music-centric — also track AI notes for ensemble density.
  // Without this, autoplay with no human locks into 'lead' forever.
  var ensembleNoteWindow = [];

  function onEnsembleNote(now) {
    ensembleNoteWindow.push(now || Date.now());
  }

  function computeStance(dt, bpm) {
    var now = Date.now();

    // ── Human density ──
    var cutoff = now - WINDOW_MS;
    while (humanNoteWindow.length > 0 && humanNoteWindow[0] < cutoff) {
      humanNoteWindow.shift();
    }
    while (ensembleNoteWindow.length > 0 && ensembleNoteWindow[0] < cutoff) {
      ensembleNoteWindow.shift();
    }
    var humanDensity = humanNoteWindow.length / (WINDOW_MS / 1000);
    // v2.2: Use blended density — when human is absent, ensemble density
    // prevents the stance from locking into 'lead' permanently.
    var aiDensity = ensembleNoteWindow.length / (WINDOW_MS / 1000);
    var density = humanDensity > 0 ? humanDensity : aiDensity * 0.5;

    // ── Silence tracking ──
    var beatMs = 60000 / Math.max(30, bpm);
    // v2.2: Use ensemble last note time when no human present
    var lastNote = lastHumanNoteTime > 0 ? lastHumanNoteTime :
      (ensembleNoteWindow.length > 0 ? ensembleNoteWindow[ensembleNoteWindow.length - 1] : now);
    silenceBeats = (now - lastNote) / beatMs;

    // ── Surprise reading ──
    var surprise = (typeof SharedState.getSurpriseAvg === 'function') ?
      SharedState.getSurpriseAvg() : 0;

    // ── Section context ──
    var sectionState = 'STABLE';
    var sectionEnergy = 0.3;
    var adventurousness = 0.2;
    if (typeof SectionTracker !== 'undefined') {
      var ss = SectionTracker.getState();
      sectionState = ss.state;
      sectionEnergy = ss.energy;
      adventurousness = ss.adventurousness;
    }

    // ── Human adventurousness ──
    var humanAdv = (typeof SharedState.getHumanAdventurousness === 'function') ?
      SharedState.getHumanAdventurousness() : 0.5;

    // ══════════════════════════════════════
    // INITIATIVE AXIS (0=follow, 1=lead)
    // ══════════════════════════════════════

    var initTarget = 0.2;  // default: supportive

    // Sparse human → take more initiative
    // Blend with ensemble density: if total texture is also sparse, lead more
    var ensembleDensity = (typeof ContextIntegrator !== 'undefined' &&
      ContextIntegrator.getTotalDensity) ? ContextIntegrator.getTotalDensity() : 0;
    var blendedDensity = density > 0 ? density * 0.6 + ensembleDensity * 4 * 0.4 : ensembleDensity * 4;
    if (blendedDensity < 1.0) {
      initTarget += (1.0 - blendedDensity) * 0.3;
    }

    // Long silence → strong lead signal
    if (silenceBeats > 4) {
      initTarget += Math.min(0.3, (silenceBeats - 4) * 0.05);
    }

    // Human owns many roles → stay back
    if (humanActiveRoles >= 2) {
      initTarget -= 0.15;
    }

    // Section BUILD/PEAK → more initiative
    if (sectionState === 'BUILD') initTarget += 0.1;
    if (sectionState === 'PEAK') initTarget += 0.15;

    // Section RELEASE → pull back
    if (sectionState === 'RELEASE') initTarget -= 0.1;

    initTarget = Math.max(0, Math.min(1, initTarget));

    // ══════════════════════════════════════
    // AGREEMENT AXIS (0=contradict, 1=agree)
    // ══════════════════════════════════════

    var agreeTarget = 0.7;  // default: mostly agreeable

    // Low surprise → system is tracking well → stay agreeable
    if (surprise < 0.3) {
      agreeTarget += 0.1;
    }

    // High surprise → human is doing something unexpected → question more
    if (surprise > 0.6) {
      agreeTarget -= (surprise - 0.6) * 0.5;
    }

    // v6 7E: IC (surprisal) from MelodicExpectancy — human playing unexpected notes
    // High IC → human introducing new material → bias toward 'support'/'extend' (respond to novelty)
    // Accumulated with decay so single surprise notes don't thrash stance.
    if (typeof MelodicExpectancy !== 'undefined' && MelodicExpectancy.getIC) {
      var _humanIC = MelodicExpectancy.getIC('human');
      if (_humanIC > 3.0) {
        // High surprisal: human is introducing something truly unexpected
        agreeTarget -= Math.min(0.15, (_humanIC - 3.0) * 0.05);
        initTarget -= 0.05;  // yield initiative to human's new idea
      }
    }

    // Human adventurous → match with some questioning
    if (humanAdv > 0.6) {
      agreeTarget -= (humanAdv - 0.6) * 0.3;
    }

    // PEAK state → can be more adventurous harmonically
    if (sectionState === 'PEAK') agreeTarget -= 0.15;

    // RELEASE → strongly agree (resolve together)
    if (sectionState === 'RELEASE') agreeTarget += 0.2;

    // STABLE → default agreeable
    if (sectionState === 'STABLE') agreeTarget += 0.05;

    // v9.1.0: Gesture-informed stance (Keller 2014: joint action anticipation)
    // Player gesture type modulates initiative and agreement targets.
    if (typeof GestureClassifier !== 'undefined' && GestureClassifier.getGesture) {
      var gesture = GestureClassifier.getGesture();
      if (gesture.confidence > 0.5) {
        var inf = gesture.influence;
        // Player initiative shifts system response: high player initiative → system follows
        initTarget += (inf.initiative - 0.5) * 0.15;
        agreeTarget += (1.0 - inf.initiative) * 0.10;
        // Clamp after gesture modulation
        initTarget = Math.max(0, Math.min(1, initTarget));
      }
    }

    agreeTarget = Math.max(0, Math.min(1, agreeTarget));

    // ── v2.4: Freerun stance drivers — prevent DialogueEngine from freezing ──
    // Driver 1: If no human notes for 10+ seconds, push initiative toward 0.7
    var silenceMs = now - (lastHumanNoteTime > 0 ? lastHumanNoteTime : now);
    if (silenceMs > 10000) {
      var silencePush = Math.min(0.3, (silenceMs - 10000) / 30000);  // ramp over 30s
      initTarget = Math.min(1, initTarget + silencePush);
      // After 10s silence, also drift toward 'extend' (moderate agreement)
      if (agreeTarget > 0.55) {
        agreeTarget -= 0.005;  // slow drift per tick
      }
    }
    // Driver 2: If ensemble density is high (>6 nps), decrease agreement slightly
    if (ensembleDensity > 6) {
      agreeTarget = Math.max(0, agreeTarget - 0.01);
    }

    // ── Set targets ──
    targetInitiative = initTarget;
    targetAgreement = agreeTarget;

    // ── Smooth toward targets ──
    initiative += (targetInitiative - initiative) * SMOOTH_RATE;
    agreement += (targetAgreement - agreement) * SMOOTH_RATE;

    // ── Determine discrete stance label ──
    currentStance = _classifyStance(initiative, agreement);
  }

  // Pre-computed stance keys and coordinates (avoid per-call Object.keys)
  var _stanceKeys = Object.keys(STANCES);
  var _stanceCount = _stanceKeys.length;
  // Pre-extract initiative/agreement arrays for branchless iteration
  var _stanceInits = new Array(_stanceCount);
  var _stanceAgrees = new Array(_stanceCount);
  for (var _ski = 0; _ski < _stanceCount; _ski++) {
    _stanceInits[_ski] = STANCES[_stanceKeys[_ski]].initiative;
    _stanceAgrees[_ski] = STANCES[_stanceKeys[_ski]].agreement;
  }

  // Classify the continuous (initiative, agreement) point to nearest stance
  function _classifyStance(init, agree) {
    var best = 'support';
    var bestDist = Infinity;
    for (var i = 0; i < _stanceCount; i++) {
      var di = init - _stanceInits[i];
      var da = agree - _stanceAgrees[i];
      var d = di * di + da * da;
      if (d < bestDist) {
        bestDist = d;
        best = _stanceKeys[i];
      }
    }
    return best;
  }

  // ══════════════════════════════════════
  // PER-VOICE DIALOGUE STANCE (v4 Phase 5)
  // ══════════════════════════════════════
  //
  // Each voice derives its own (initiative, agreement) from per-voice beliefs
  // and section perception. Consensus = average (backward compat for getStance()).
  // No peer-pressure convergence — stance divergence IS role identity.

  var _voices = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
  var _voiceStances = {};

  // Role baselines — personality expressed as stance
  var _ROLE_INIT_BASE  = { bass: 0.15, rhythm: 0.20, soloist: 0.35, lead: 0.40, percussion: 0.25 };
  var _ROLE_AGREE_BASE = { bass: 0.85, rhythm: 0.75, soloist: 0.55, lead: 0.50, percussion: 0.70 };

  // Initialize per-voice stances
  for (var _vi = 0; _vi < _voices.length; _vi++) {
    var _v = _voices[_vi];
    _voiceStances[_v] = {
      initiative: _ROLE_INIT_BASE[_v] || 0.25,
      agreement: _ROLE_AGREE_BASE[_v] || 0.65,
      smoothedInit: _ROLE_INIT_BASE[_v] || 0.25,
      smoothedAgree: _ROLE_AGREE_BASE[_v] || 0.65,
      stance: 'support'
    };
  }

  function _computeVoiceInitiative(voice) {
    var init = _ROLE_INIT_BASE[voice] || 0.25;

    // Belief modulation
    if (typeof BeliefState !== 'undefined') {
      var b = BeliefState.getBelief(voice);
      if (b) {
        init += (b.needs_energy || 0) * 0.20;
        init -= (b.needs_space || 0) * 0.15;
        init += (b.needs_surprise || 0) * 0.10;
      }
    }

    // Per-voice section energy
    if (typeof SectionTracker !== 'undefined' && SectionTracker.getVoiceState) {
      var vs = SectionTracker.getVoiceState(voice);
      if (vs.state === 'BUILD') init += 0.10;
      if (vs.state === 'PEAK') init += 0.15;
      if (vs.state === 'RELEASE') init -= 0.10;
    }

    // Human silence (global signal, same for all)
    if (silenceBeats > 4) {
      init += Math.min(0.15, (silenceBeats - 4) * 0.03);
    }

    // Human owns many roles → back off
    if (humanActiveRoles >= 2) init -= 0.10;

    // v8 Feature E: Anticipatory stance shift (ADAM model, Keller 2014)
    // If projected energy is rising, pre-position for initiative.
    // If projected space is rising, yield preemptively.
    if (typeof BeliefState !== 'undefined' && BeliefState.projectBelief) {
      var proj = BeliefState.projectBelief(voice, 4);  // 4 beats ahead
      var cur = BeliefState.getBelief(voice);
      if (proj && cur) {
        var dEnergy = (proj[1] || 0) - (cur.needs_energy || 0);
        var dSpace = (proj[2] || 0) - (cur.needs_space || 0);
        if (dEnergy > 0.10) init += 0.08;   // energy surge coming → take initiative
        if (dSpace > 0.10) init -= 0.05;    // space need coming → yield
      }
    }

    return Math.max(0, Math.min(1, init));
  }

  function _computeVoiceAgreement(voice) {
    var agree = _ROLE_AGREE_BASE[voice] || 0.65;

    if (typeof BeliefState !== 'undefined') {
      var b = BeliefState.getBelief(voice);
      if (b) {
        agree += (b.needs_stability || 0) * 0.15;
        agree -= (b.needs_surprise || 0) * 0.20;
      }
    }

    if (typeof SectionTracker !== 'undefined' && SectionTracker.getVoiceState) {
      var vs = SectionTracker.getVoiceState(voice);
      if (vs.state === 'PEAK') agree -= 0.15;
      if (vs.state === 'RELEASE') agree += 0.20;
      if (vs.state === 'STABLE') agree += 0.05;
    }

    // Surprise reading (global)
    var surprise = (typeof SharedState.getSurpriseAvg === 'function') ?
      SharedState.getSurpriseAvg() : 0;
    if (surprise > 0.6) agree -= (surprise - 0.6) * 0.3;

    // v8 Feature E: Anticipatory agreement shift (ADAM model)
    // If projected surprise is rising, prepare to question.
    if (typeof BeliefState !== 'undefined' && BeliefState.projectBelief) {
      var proj = BeliefState.projectBelief(voice, 4);
      var cur = BeliefState.getBelief(voice);
      if (proj && cur) {
        var dSurprise = (proj[3] || 0) - (cur.needs_surprise || 0);
        if (dSurprise > 0.10) agree -= 0.05;  // surprise coming → prepare to question
      }
    }

    return Math.max(0, Math.min(1, agree));
  }

  function _updateVoiceStances() {
    if (window.PER_VOICE_DIALOGUE === false) return;

    for (var i = 0; i < _voices.length; i++) {
      var v = _voices[i];
      var vs = _voiceStances[v];

      var targetInit = _computeVoiceInitiative(v);
      var targetAgree = _computeVoiceAgreement(v);

      vs.smoothedInit += (targetInit - vs.smoothedInit) * SMOOTH_RATE;
      vs.smoothedAgree += (targetAgree - vs.smoothedAgree) * SMOOTH_RATE;
      vs.initiative = vs.smoothedInit;
      vs.agreement = vs.smoothedAgree;
      vs.stance = _classifyStance(vs.initiative, vs.agreement);
    }
  }

  function _getVoiceStance(voice) {
    var vs = _voiceStances[voice];
    return {
      stance: vs.stance,
      initiative: vs.initiative,
      agreement: vs.agreement
    };
  }

  function _getVoiceTempMod(voice) {
    var vs = _voiceStances[voice];
    var tempMod = 0;
    tempMod += (vs.initiative - 0.3) * 0.3;
    tempMod += (0.7 - vs.agreement) * 0.2;
    return Math.max(-0.3, Math.min(0.4, tempMod));
  }

  function _getVoiceDensityMod(voice) {
    var vs = _voiceStances[voice];
    var mod = (vs.initiative - 0.3) * 0.3;
    mod -= (vs.agreement - 0.5) * 0.1;
    return Math.max(-0.1, Math.min(0.15, mod));
  }

  function getVoiceStances() {
    var result = {};
    for (var i = 0; i < _voices.length; i++) {
      var v = _voices[i];
      var vs = _voiceStances[v];
      result[v] = { stance: vs.stance, init: +vs.initiative.toFixed(3), agree: +vs.agreement.toFixed(3) };
    }
    result._consensus = currentStance;
    return result;
  }

  // ══════════════════════════════════════
  // EVENT HANDLERS
  // ══════════════════════════════════════

  // v3.8.2: OwnershipDetector removed. Human presence detected via
  // ContextIntegrator.getVoiceDensity('human') in belief-state.js.
  // humanActiveRoles stays 0 (no ownership tracking) — dialogue stance
  // now reads human presence from beliefs directly.

  // ══════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════

  function onHumanNote(now) {
    humanNoteWindow.push(now || Date.now());
    lastHumanNoteTime = now || Date.now();
  }

  function tick(dt, bpm) {
    computeStance(dt, bpm);
    // v4 Phase 5: update per-voice stances from belief trajectories
    _updateVoiceStances();
  }

  // getStance(voice) — per-voice if voice arg, consensus if no arg
  function getStance(voice) {
    if (voice && window.PER_VOICE_DIALOGUE !== false && _voiceStances[voice]) {
      return _getVoiceStance(voice);
    }
    return {
      stance: currentStance,
      initiative: initiative,
      agreement: agreement
    };
  }

  // getTemperatureModifier(voice) — per-voice or consensus
  function getTemperatureModifier(voice) {
    if (voice && window.PER_VOICE_DIALOGUE !== false && _voiceStances[voice]) {
      return _getVoiceTempMod(voice);
    }
    var tempMod = 0;
    tempMod += (initiative - 0.3) * 0.3;
    tempMod += (0.7 - agreement) * 0.2;
    return Math.max(-0.3, Math.min(0.4, tempMod));
  }

  // getDensityModifier(voice) — per-voice or consensus
  function getDensityModifier(voice) {
    if (voice && window.PER_VOICE_DIALOGUE !== false && _voiceStances[voice]) {
      return _getVoiceDensityMod(voice);
    }
    var mod = (initiative - 0.3) * 0.3;
    mod -= (agreement - 0.5) * 0.1;
    return Math.max(-0.1, Math.min(0.15, mod));
  }

  // Should the system use motif development? (vs. fresh generation)
  // Extend and question stances favor development; agree favors loops/lexicon
  function shouldDevelop() {
    return currentStance === 'extend' || currentStance === 'question' ||
           currentStance === 'lead';
  }

  function reset() {
    currentStance = 'support';
    initiative = 0.2;
    agreement = 0.8;
    targetInitiative = 0.2;
    targetAgreement = 0.8;
    humanNoteWindow = [];
    ensembleNoteWindow = [];
    humanActiveRoles = 0;
    lastHumanNoteTime = Date.now();
    silenceBeats = 0;
    // Reset per-voice stances
    for (var ri = 0; ri < _voices.length; ri++) {
      var rv = _voices[ri];
      var rvs = _voiceStances[rv];
      rvs.initiative = _ROLE_INIT_BASE[rv] || 0.25;
      rvs.agreement = _ROLE_AGREE_BASE[rv] || 0.65;
      rvs.smoothedInit = rvs.initiative;
      rvs.smoothedAgree = rvs.agreement;
      rvs.stance = 'support';
    }
  }

  return {
    onHumanNote:           onHumanNote,
    onEnsembleNote:        onEnsembleNote,
    tick:                  tick,
    getStance:             getStance,
    getTemperatureModifier: getTemperatureModifier,
    getDensityModifier:    getDensityModifier,
    getVoiceStances:       getVoiceStances,
    shouldDevelop:         shouldDevelop,
    reset:                 reset
  };

})();

console.log('%cDialogueEngine loaded', 'color:#a94;font-family:monospace');

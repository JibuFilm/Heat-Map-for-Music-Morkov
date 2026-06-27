'use strict';
// ═══ PHASE COUPLING — Kuramoto Oscillator Network for Voice Coordination ═══
//
// Solves the "equal importance" problem: when 3+ voices all independently
// decide to play based on the same belief state, they pile on. Phase coupling
// gives each voice a natural rhythm of activity/rest that self-organizes
// through mutual influence — no conductor, no authority hierarchy.
//
// Each voice is an oscillator with:
//   - phase θ (0 to 2π): where in the play/rest cycle
//   - natural frequency ω: how fast the voice cycles (bass=slow, soloist=fast)
//   - coupling K: how strongly peers influence timing
//   - frustration α: preferred phase offset between voices
//
// The Kuramoto-Sakaguchi equation:
//   dθ_i/dt = ω_i + (K/N) * Σ_j sin(θ_j - θ_i - α_ij)
//
// Phase mapping:
//   θ near 0 (or 2π) = peak readiness (play)
//   θ near π = trough (rest/listen)
//
// The attending strength (von Mises):
//   A(θ) = exp(κ * cos(θ))
//   Peaks at θ=0, troughs at θ=π. κ controls sharpness.
//
// This module modulates BeliefState's gate probability:
//   final_gate = belief_gate * phase_readiness
//
// From Large & Jones (1999) Dynamic Attending Theory — the same framework
// already used in TempoEngine and BarTracker.
//
// Depends on: context-integrator.js (for peer activity observation)
// Load order: after context-integrator.js, before belief-state.js

var PhaseCoupling = (function() {

  var TWO_PI = 2 * Math.PI;

  // ═══════════════════════════════════════
  // PER-VOICE OSCILLATOR STATE
  // ═══════════════════════════════════════

  var oscillators = {
    bass:       { phase: 0, omega: 0 },
    rhythm:     { phase: TWO_PI * 0.33, omega: 0 },   // start offset — staggered entry
    soloist:     { phase: TWO_PI * 0.67, omega: 0 },   // start offset
    lead:       { phase: TWO_PI * 0.17, omega: 0 },   // PLACEHOLDER — research pending
    percussion: { phase: TWO_PI * 0.50, omega: 0 }    // between rhythm and soloist
  };

  // ═══════════════════════════════════════
  // BAR-LEVEL OSCILLATORS (Large & Jones 1999 — hierarchical entrainment)
  // ═══════════════════════════════════════
  // Each voice has a bar-level phase in addition to beat-level.
  // Bar oscillators cycle at 1/4 the beat frequency (one cycle per 4-beat bar).
  // They provide downbeat emphasis: when bar-phase ≈ 0, beat-level readiness
  // is boosted (downbeat accent). When bar-phase ≈ π, beat readiness is dampened
  // (weak beats within bar). κ_bar controls emphasis sharpness.
  //
  // The bar oscillator couples to beat oscillators: it doesn't have its own
  // Kuramoto coupling between voices — it inherits the consensus from beat level.
  // Only its PHASE matters for the readiness modulation.

  var barOscillators = {
    bass:       { phase: 0 },
    rhythm:     { phase: 0 },
    soloist:    { phase: 0 },
    lead:       { phase: 0 },
    percussion: { phase: 0 }
  };

  var KAPPA_BAR = 1.2;  // softer than beat-level κ=2.0 (bar emphasis is gentler)

  // Pre-computed von Mises constants (avoid per-call Math.exp)
  var _KAPPA_BAR_MAX = Math.exp(KAPPA_BAR);
  var _KAPPA_BAR_MIN = Math.exp(-KAPPA_BAR);
  var _KAPPA_BAR_RANGE = _KAPPA_BAR_MAX - _KAPPA_BAR_MIN;

  // Bar-level emphasis: von Mises at bar frequency
  // Returns 0.7-1.3 modulator (±30% emphasis on downbeats)
  function getBarEmphasis(voice) {
    var theta = barOscillators[voice] ? barOscillators[voice].phase : 0;
    var raw = Math.exp(KAPPA_BAR * Math.cos(theta));
    var norm = (raw - _KAPPA_BAR_MIN) / _KAPPA_BAR_RANGE;  // 0 to 1
    return 0.7 + 0.6 * norm;  // 0.7 at trough (weak beat), 1.3 at peak (downbeat)
  }

  // Bar phase fraction (0-1, 0=downbeat) for external consumers
  function getBarPhase(voice) {
    var theta = barOscillators[voice] ? barOscillators[voice].phase : 0;
    return theta / TWO_PI;
  }

  // ── v8 Feature D: Phrase-level oscillators (Large & Jones 1999, London 2012) ──
  // Third hierarchical level: one cycle per arc (16-32 bars typically).
  // Couples to bar oscillator (hierarchical, not peer). Phrase emphasis is
  // the gentlest modulator (0.85-1.15), creating a macro-rhythm conversation.
  var phraseOscillators = {
    bass:       { phase: 0 },
    rhythm:     { phase: Math.PI * 0.5 },
    soloist:    { phase: Math.PI },
    lead:       { phase: Math.PI * 1.5 },
    percussion: { phase: Math.PI * 0.67 }
  };
  var _phraseTargetFreq = { bass: 1/16, rhythm: 1/16, soloist: 1/16, lead: 1/12, percussion: 1/24 };
  var _phraseEffectiveFreq = { bass: 1/16, rhythm: 1/16, soloist: 1/16, lead: 1/12, percussion: 1/24 };

  var KAPPA_PHRASE = 0.8;  // softest in hierarchy (beat=2.0, bar=1.2, phrase=0.8)
  var _KAPPA_PHRASE_MAX = Math.exp(KAPPA_PHRASE);
  var _KAPPA_PHRASE_MIN = Math.exp(-KAPPA_PHRASE);
  var _KAPPA_PHRASE_RANGE = _KAPPA_PHRASE_MAX - _KAPPA_PHRASE_MIN;

  // Phrase-level emphasis: 0.85-1.15 (±15% — suggestive, not prescriptive)
  function getPhraseEmphasis(voice) {
    var theta = phraseOscillators[voice] ? phraseOscillators[voice].phase : 0;
    var raw = Math.exp(KAPPA_PHRASE * Math.cos(theta));
    var norm = (raw - _KAPPA_PHRASE_MIN) / _KAPPA_PHRASE_RANGE;
    return 0.85 + 0.3 * norm;
  }

  function getPhrasePhase(voice) {
    var theta = phraseOscillators[voice] ? phraseOscillators[voice].phase : 0;
    return theta / TWO_PI;
  }

  // ═══════════════════════════════════════
  // NATURAL FREQUENCIES (cycles per beat)
  // ═══════════════════════════════════════
  // Bass: slow cycle (~every 4 beats → 0.25 cycles/beat)
  // Rhythm:  moderate (~every 3 beats → 0.33 cycles/beat)
  // Soloist: faster (~every 2 beats → 0.5 cycles/beat)
  //
  // These determine how frequently each voice naturally enters
  // its "ready to play" phase. Faster = more frequent entries.

  var NATURAL_FREQ = {
    bass:       0.25,   // ~4-beat phrase/rest cycle
    rhythm:     0.33,   // ~3-beat cycle
    soloist:     0.50,   // ~2-beat cycle
    lead:       0.33,   // ~3-beat cycle (moderate — melodic themes, not embellishments)
    percussion: 0.50    // ~2-beat cycle (similar to soloist — rhythmic voice)
  };

  // ═══════════════════════════════════════
  // COUPLING PARAMETERS
  // ═══════════════════════════════════════

  // Global coupling strength (0=independent, 1=strongly coupled)
  // At K=0, voices ignore each other entirely.
  // At K~0.5, voices tend to stagger but can override.
  // At K>1, voices lock into rigid patterns.
  var K = 0.4;

  // Phase frustration α_ij: preferred offset between voice i and voice j
  // α=0: voices want to be in-phase (play together)
  // α=π/3: voices want ~60° offset (slight stagger)
  // α=π/2: voices want ~90° offset (quarter-cycle alternation)
  // α=π: voices want anti-phase (strict alternation)
  var FRUSTRATION = {
    'bass-rhythm':           Math.PI / 4,     // bass and rhythm: slight offset (groove together but not identical)
    'bass-soloist':        Math.PI / 2.5,   // bass and solo: moderate offset (complementary timing)
    'bass-lead':           Math.PI / 4,     // bass and lead: slight offset (both melodic-core)
    'rhythm-soloist':         Math.PI / 3,     // rhythm and solo: moderate offset
    'rhythm-lead':         Math.PI / 3,     // rhythm and lead: moderate offset
    'lead-soloist':        Math.PI / 2,     // lead and soloist: significant offset (lead sustains, solo embellishes)
    'bass-percussion':    Math.PI / 5,     // bass and percussion: tight (rhythm section groove)
    'rhythm-percussion':     Math.PI / 4,     // rhythm and percussion: slight offset
    'lead-percussion':     Math.PI / 4,     // lead and percussion: moderate (both drive energy)
    'percussion-soloist':  Math.PI / 3      // percussion and solo: moderate (independent)
  };

  // Attending sharpness κ (von Mises concentration)
  // Higher = sharper peaks and troughs (more decisive play/rest).
  // Lower = flatter (less influence on gating).
  var KAPPA = 2.0;

  // ═══════════════════════════════════════
  // MODE-DEPENDENT COUPLING (modulated by BeliefState)
  // ═══════════════════════════════════════
  // The coupling parameters change based on what the music needs.
  // Tight coupling (high K, low frustration) = groove lock.
  // Loose coupling (low K, high frustration) = temporal independence.

  var MODE_COUPLING = {
    needs_stability:  { K: 0.6,  frustMult: 0.5,  freqMult: { bass: 0.8,  rhythm: 0.8,  soloist: 0.8,  lead: 0.7,  percussion: 0.8  } },
    needs_energy:     { K: 0.4,  frustMult: 1.0,  freqMult: { bass: 1.0,  rhythm: 1.0,  soloist: 1.0,  lead: 1.2,  percussion: 1.0  } },
    needs_space:      { K: 0.2,  frustMult: 1.5,  freqMult: { bass: 1.0,  rhythm: 1.0,  soloist: 1.0,  lead: 0.8,  percussion: 0.8  } },
    needs_surprise:   { K: 0.15, frustMult: 1.8,  freqMult: { bass: 1.0,  rhythm: 1.1,  soloist: 1.3,  lead: 1.1,  percussion: 1.1  } },
    needs_resolution: { K: 0.5,  frustMult: 0.6,  freqMult: { bass: 1.0,  rhythm: 0.9,  soloist: 0.7,  lead: 0.9,  percussion: 0.9  } }
  };

  // Current effective parameters (smoothed, not instantaneous)
  var _effectiveK = K;
  var _effectiveFrustMult = 1.0;
  var _effectiveFreqMult = { bass: 1.0, rhythm: 1.0, soloist: 1.0, lead: 1.0, percussion: 1.0 };
  var SMOOTH = 0.05; // lerp rate per tick (~20 ticks to converge)

  // v8 Feature F: Ensemble coherence tracking (Dotov et al. 2022)
  // Smoothed order parameter and rate of change for direct modulation.
  var _rEMA = 0.5;        // smoothed r (start at moderate)
  var _drdt = 0;          // rate of change of r
  var _R_ALPHA = 0.05;    // EMA smoothing for r
  var _COHERENCE_K_CAP = 0.15;  // max K boost from convergence feedback

  // ── v6 Phase 7D: Predictive→Reactive Coupling Bridges ──
  // Bridge 1: Arc phase → coupling K and frustration (Ravignani 2014)
  var ARC_COUPLING_MOD = {
    establish:  { K: +0.15, frust: -0.2 },  // tighter, less frustration
    develop:    { K: 0,     frust: 0 },      // neutral
    climax:     { K: -0.10, frust: +0.3 },   // looser, more frustration
    resolve:    { K: +0.10, frust: -0.1 },   // re-tightening
    transition: { K: -0.05, frust: +0.1 }    // slightly loose
  };
  // Bridge 2: Intent → frequency modulation
  var INTENT_FREQ_MOD = {
    continuation: -0.05,   // slower cycling (sustain phrases)
    consonance:    0.00,   // neutral
    punctuation:  +0.08,   // faster cycling (quick entries)
    contrast:     +0.10    // fastest (active disruption)
  };

  // Pre-allocated target frequency multiplier (avoid per-tick object allocation)
  var _targetFreqMult = { bass: 0, rhythm: 0, soloist: 0, lead: 0, percussion: 0 };
  var _needs = ['needs_stability', 'needs_energy', 'needs_space', 'needs_surprise', 'needs_resolution'];

  // Pre-allocated blend object for mass-weighted belief averaging (avoid per-tick GC)
  var _blendNeeds = { needs_stability: 0, needs_energy: 0, needs_space: 0, needs_surprise: 0, needs_resolution: 0 };

  function _updateModeParameters() {
    if (typeof BeliefState === 'undefined') return;
    // v8.2 Fix 0: Mass-weighted blend across all voices using TEMPO_MASS as authority.
    // Bass/percussion (mass 1.0) anchor coupling; soloist (mass 0.2) has proportional
    // but reduced influence. Replaces single-voice bass read that incorrectly dominated.
    var _blendTotal = 0;
    _blendNeeds.needs_stability = 0; _blendNeeds.needs_energy = 0;
    _blendNeeds.needs_space = 0; _blendNeeds.needs_surprise = 0;
    _blendNeeds.needs_resolution = 0;
    for (var _bvi = 0; _bvi < _N_VOICES; _bvi++) {
      var _bvn = _voiceNames[_bvi];
      var _bvBelief = BeliefState.getBelief(_bvn);
      if (!_bvBelief) continue;
      var _bvMass = TEMPO_MASS[_bvn] || 0.5;
      for (var _bni = 0; _bni < 5; _bni++) {
        var _needKey = _needs[_bni];
        _blendNeeds[_needKey] += (_bvBelief[_needKey] || 0) * _bvMass;
      }
      _blendTotal += _bvMass;
    }
    if (_blendTotal === 0) return;
    // Normalize
    for (var _bnj = 0; _bnj < 5; _bnj++) {
      _blendNeeds[_needs[_bnj]] /= _blendTotal;
    }
    var belief = _blendNeeds;

    // Weighted blend across all need states
    var targetK = 0;
    var targetFrustMult = 0;
    var targetFreqMult = _targetFreqMult;
    // Reset pre-allocated object
    targetFreqMult.bass = 0; targetFreqMult.rhythm = 0; targetFreqMult.soloist = 0;
    targetFreqMult.lead = 0; targetFreqMult.percussion = 0;

    for (var i = 0; i < 5; i++) {
      var w = belief[_needs[i]] || 0;
      var mc = MODE_COUPLING[_needs[i]];
      targetK += w * mc.K;
      targetFrustMult += w * mc.frustMult;
      var freqM = mc.freqMult;
      targetFreqMult.bass += w * (freqM.bass || 1.0);
      targetFreqMult.rhythm += w * (freqM.rhythm || 1.0);
      targetFreqMult.soloist += w * (freqM.soloist || 1.0);
      targetFreqMult.lead += w * (freqM.lead || 1.0);
      targetFreqMult.percussion += w * (freqM.percussion || 1.0);
    }

    // ── v6 7D Bridge 1: Arc-driven coupling modulation ──
    // NarrativeArc phase directly implies coupling behavior (Ravignani 2014)
    if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getArc) {
      var _arcKMod = 0, _arcFrustMod = 0, _arcCount = 0;
      var _arcVoices = _voiceNames;
      for (var ai = 0; ai < _arcVoices.length; ai++) {
        var _arc = NarrativeArc.getArc(_arcVoices[ai]);
        if (!_arc || !_arc.active) continue;
        var _acm = ARC_COUPLING_MOD[_arc.phase];
        if (_acm) { _arcKMod += _acm.K; _arcFrustMod += _acm.frust; }
        _arcCount++;
      }
      if (_arcCount > 0) {
        _arcKMod /= _arcCount;
        _arcFrustMod /= _arcCount;
        // 70% belief-driven, 30% arc-driven
        targetK = targetK * 0.7 + (targetK + _arcKMod) * 0.3;
        targetFrustMult = targetFrustMult * 0.7 + (targetFrustMult + _arcFrustMod) * 0.3;
      }
    }

    // ── v6 7D Bridge 2: Intent-driven frequency modulation ──
    // MelodicIntent contrast → faster cycling, continuation → slower
    if (typeof MelodicIntent !== 'undefined' && MelodicIntent.getIntent) {
      var _intVoices = _voiceNames;
      for (var ii = 0; ii < _intVoices.length; ii++) {
        var _iv = _intVoices[ii];
        var _intent = MelodicIntent.getIntent(_iv);
        var _ifm = INTENT_FREQ_MOD[_intent];
        if (_ifm !== undefined && targetFreqMult[_iv] !== undefined) {
          targetFreqMult[_iv] += _ifm;
        }
      }
    }

    // v8 Feature F — Bridge 4: Coherence positive feedback (Dotov 2022, Heggli 2019)
    // When ensemble converges (drdt > 0), gently increase K to reinforce lock-in.
    // Asymmetric: no reduction on divergence (natural dynamics handle it).
    var _r = getOrderParameter();
    _drdt = _r - _rEMA;
    _rEMA += (_r - _rEMA) * _R_ALPHA;
    if (_drdt > 0.02) {
      var _coherenceBoost = Math.min(_COHERENCE_K_CAP, 0.05 * _drdt);
      targetK += _coherenceBoost;
    }

    // Smooth transitions (lerp)
    _effectiveK += (targetK - _effectiveK) * SMOOTH;
    _effectiveFrustMult += (targetFrustMult - _effectiveFrustMult) * SMOOTH;
    for (var _fmi = 0; _fmi < _N_VOICES; _fmi++) {
      var _fmv = _voiceNames[_fmi];
      _effectiveFreqMult[_fmv] += ((targetFreqMult[_fmv] || 1.0) - _effectiveFreqMult[_fmv]) * SMOOTH;
    }
  }

  // ═══════════════════════════════════════
  // TEMPORAL OFFSET — phase-derived start delay
  // ═══════════════════════════════════════
  // When a voice schedules a phrase, the oscillator phase determines
  // a start delay in beats. Phase 0 = no delay. Phase π = maximum delay.
  // This creates the actual temporal stagger the Kuramoto math implies.
  //
  // The delay is scaled by the inverse of effective K: tight coupling
  // (needs_stability) → small offsets. Loose coupling (needs_space) → large.

  function getTemporalOffset(voice) {
    var theta = oscillators[voice] ? oscillators[voice].phase : 0;
    // Map phase to a delay: 0 at θ=0, max at θ=π, back to 0 at θ=2π
    // Using (1 - cos(θ))/2 gives smooth 0→1→0 curve
    var delayNorm = (1 - Math.cos(theta)) / 2;  // 0 at peak, 1 at trough

    // Scale by coupling: tight coupling → small max delay, loose → large
    // At K=0.6 (stability): maxDelay = 0.1 beats
    // At K=0.2 (space): maxDelay = 0.4 beats
    // At K=0.15 (surprise): maxDelay = 0.5 beats
    var maxDelayBeats = Math.max(0.05, 0.5 * (1 - _effectiveK));

    return delayNorm * maxDelayBeats;
  }

  // ═══════════════════════════════════════
  // EXTERNAL PERTURBATION
  // ═══════════════════════════════════════
  // When a voice actually produces a note, it perturbs other oscillators.
  // This is the "event coupling" from Large & Jones — external events
  // pull the oscillator phase toward alignment.

  var PERTURBATION_STRENGTH = 0.15;  // how strongly a note event shifts peer phases

  // ═══════════════════════════════════════
  // TICK — Kuramoto-Sakaguchi update
  // ═══════════════════════════════════════

  // Pre-allocated voice name array and phase buffer (avoid per-tick Object.keys + object alloc)
  var _voiceNames = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
  var _N_VOICES = _voiceNames.length;
  var _newPhases = { bass: 0, rhythm: 0, soloist: 0, lead: 0, percussion: 0 };

  function tick(dt) {
    // Use own consensus BPM for beat conversion (avoids circular TempoEngine dependency)
    var consensusPeriod = tempoOsc.bass.period; // quick read, full consensus in getConsensusBPM()
    var beatMs = Math.max(150, consensusPeriod);
    var dtBeats = dt / beatMs;

    // Tempo negotiation: 5-party coupling
    _tickTempo(dt);

    // Update mode-dependent parameters from BeliefState
    _updateModeParameters();

    var voiceNames = _voiceNames;
    var N = _N_VOICES;

    // Compute new phases (reuse pre-allocated buffer)
    var newPhases = _newPhases;

    for (var i = 0; i < N; i++) {
      var vi = voiceNames[i];
      var oi = oscillators[vi];

      // Natural frequency term: dθ = ω * freqMult * dt
      var freqMult = _effectiveFreqMult[vi] || 1.0;
      var dTheta = NATURAL_FREQ[vi] * freqMult * TWO_PI * dtBeats;

      // Coupling term: (K_eff/N) * Σ_j sin(θ_j - θ_i - α_ij * frustMult)
      var couplingSum = 0;
      for (var j = 0; j < N; j++) {
        if (i === j) continue;
        var vj = voiceNames[j];
        var oj = oscillators[vj];
        var alpha = _getFrustration(vi, vj) * _effectiveFrustMult;
        couplingSum += Math.sin(oj.phase - oi.phase - alpha);
      }
      dTheta += (_effectiveK / N) * couplingSum * dtBeats;

      // Wrap to [0, 2π)
      var newPhase = (oi.phase + dTheta) % TWO_PI;
      if (newPhase < 0) newPhase += TWO_PI;
      newPhases[vi] = newPhase;
    }

    // Apply new phases
    for (var k = 0; k < N; k++) {
      oscillators[voiceNames[k]].phase = newPhases[voiceNames[k]];
    }

    // ── Bar-level oscillator update (v3.17.0 — Large & Jones 1999) ──
    // Bar oscillators advance at 1/4 the beat frequency (one cycle per bar = 4 beats).
    // They couple to the beat consensus, not to each other — hierarchical, not peer.
    // When bar-phase nears 0, the next beat peak gains a downbeat accent.
    var barDtBeats = dtBeats / 4;  // 4 beats per bar
    for (var bi = 0; bi < N; bi++) {
      var bVoice = voiceNames[bi];
      var barOsc = barOscillators[bVoice];
      if (!barOsc) continue;

      // Natural advance
      var barFreqMult = _effectiveFreqMult[bVoice] || 1.0;
      var barDTheta = NATURAL_FREQ[bVoice] * barFreqMult * TWO_PI * barDtBeats;

      // Couple to beat oscillator: bar phase tracks the 4-beat grouping.
      // Pull bar-phase toward alignment with beat-phase ÷ 4.
      var beatPhase = newPhases[bVoice];
      var barTarget = (beatPhase / 4) % TWO_PI;  // where bar should be if perfectly entrained
      var barError = barTarget - barOsc.phase;
      // Wrap to [-π, π]
      if (barError > Math.PI) barError -= TWO_PI;
      if (barError < -Math.PI) barError += TWO_PI;
      barDTheta += 0.1 * barError * dtBeats;  // gentle coupling (0.1)

      barOsc.phase = (barOsc.phase + barDTheta) % TWO_PI;
      if (barOsc.phase < 0) barOsc.phase += TWO_PI;
    }

    // ── v8 Feature D: Phrase-level oscillator update (Large & Jones 1999) ──
    // One cycle per arc. Couples to bar oscillator (hierarchical). Frequency adapts
    // to current arc template via NarrativeArc.getArc(voice).barsTotal.
    if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getArc) {
      for (var phi = 0; phi < N; phi++) {
        var phVoice = voiceNames[phi];
        var phOsc = phraseOscillators[phVoice];
        if (!phOsc) continue;

        // Update target frequency from arc template bar count
        var arcState = NarrativeArc.getArc(phVoice);
        if (arcState && arcState.barsTotal > 0) {
          _phraseTargetFreq[phVoice] = 1.0 / arcState.barsTotal;  // cycles per bar
        }
        // Smooth frequency transitions (prevents jumps on template change)
        _phraseEffectiveFreq[phVoice] += (_phraseTargetFreq[phVoice] - _phraseEffectiveFreq[phVoice]) * SMOOTH;

        // Natural advance (in bars per tick)
        var phraseDtBars = dtBeats / 4;  // assumes 4 beats per bar
        var phraseDTheta = _phraseEffectiveFreq[phVoice] * TWO_PI * phraseDtBars;

        // Couple to bar oscillator (hierarchical): phrase phase tracks bar grouping
        var barPhaseHere = barOscillators[phVoice] ? barOscillators[phVoice].phase : 0;
        var barsPerArc = 1.0 / Math.max(0.01, _phraseEffectiveFreq[phVoice]);
        var phraseTarget = (barPhaseHere / barsPerArc) % TWO_PI;
        var phraseError = phraseTarget - phOsc.phase;
        if (phraseError > Math.PI) phraseError -= TWO_PI;
        if (phraseError < -Math.PI) phraseError += TWO_PI;
        phraseDTheta += 0.05 * phraseError * phraseDtBars;  // gentle coupling (softer than bar's 0.1)

        phOsc.phase = (phOsc.phase + phraseDTheta) % TWO_PI;
        if (phOsc.phase < 0) phOsc.phase += TWO_PI;
      }
    }

    // ── v6 7D Bridge 3: Peer anticipatory phase adjustment (Ravignani temporal herding) ──
    // When PeerModel predicts a peer is about to enter (density rising + recently silent),
    // pre-adjust the observer's phase toward rest to create room.
    // Keller 2014, Palmer & Loehr 2013.
    if (typeof PeerModel !== 'undefined' && PeerModel.getPeerPrediction) {
      for (var _pi = 0; _pi < N; _pi++) {
        var _pv = voiceNames[_pi];
        for (var _pj = 0; _pj < N; _pj++) {
          if (_pi === _pj) continue;
          var _peer = voiceNames[_pj];
          var _pred = PeerModel.getPeerPrediction(_pv, _peer);
          // enteringSoon: peer has been silent > 1s but density trend is rising
          if (_pred && _pred.anticipatedSilence < 800 && _pred.nextDensityEstimate > 0.2) {
            // Nudge this voice's phase toward rest to make room
            var _dtr = Math.PI - oscillators[_pv].phase;
            if (_dtr > Math.PI) _dtr -= TWO_PI;
            if (_dtr < -Math.PI) _dtr += TWO_PI;
            oscillators[_pv].phase += _dtr * 0.03;  // gentle anticipatory nudge
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════
  // EVENT PERTURBATION
  // ═══════════════════════════════════════
  // Called when a voice produces a note. Pushes peer oscillators
  // slightly toward their rest phase (anti-phase perturbation).
  // This is what creates turn-taking: when bass plays, it nudges
  // rhythm and soloist away from their play phase.

  function onNoteProduced(voice) {
    var voiceNames = _voiceNames;
    for (var i = 0; i < voiceNames.length; i++) {
      if (voiceNames[i] === voice) continue;
      var oj = oscillators[voiceNames[i]];
      // Push peer toward rest (phase π)
      var distToRest = Math.PI - oj.phase;
      // Wrap distance
      if (distToRest > Math.PI) distToRest -= TWO_PI;
      if (distToRest < -Math.PI) distToRest += TWO_PI;
      oj.phase += distToRest * PERTURBATION_STRENGTH;
      // Wrap
      oj.phase = oj.phase % TWO_PI;
      if (oj.phase < 0) oj.phase += TWO_PI;
    }
  }

  // ═══════════════════════════════════════
  // READINESS — von Mises attending strength
  // ═══════════════════════════════════════
  // Returns 0-1: how ready this voice is to play.
  // 1.0 at phase=0 (peak), ~0.13 at phase=π (trough) for κ=2.

  // Pre-computed von Mises constants for readiness (avoid per-call Math.exp)
  var _KAPPA_MAX = Math.exp(KAPPA);
  var _KAPPA_MIN = Math.exp(-KAPPA);
  var _KAPPA_RANGE = _KAPPA_MAX - _KAPPA_MIN;

  function getReadiness(voice) {
    var theta = oscillators[voice] ? oscillators[voice].phase : 0;
    // von Mises: exp(κ * cos(θ)), normalized to [0, 1]
    var raw = Math.exp(KAPPA * Math.cos(theta));
    var beatReadiness = (raw - _KAPPA_MIN) / _KAPPA_RANGE;
    // Hierarchical emphasis: bar × phrase modulate beat readiness
    // Beat: 0.13-1.0, Bar: 0.7-1.3 (v3.17.0), Phrase: 0.85-1.15 (v8 Feature D)
    var barMod = getBarEmphasis(voice);
    var phraseMod = getPhraseEmphasis(voice);
    return Math.min(1.0, beatReadiness * barMod * phraseMod);
  }

  // ═══════════════════════════════════════
  // ORDER PARAMETER — ensemble cohesion
  // ═══════════════════════════════════════
  // r ∈ [0, 1]: 0 = total incoherence, 1 = perfect synchronization.
  // This single number captures how "locked in" the ensemble is.
  // Could feed into UI or ensemble-level decisions.

  function getOrderParameter() {
    var voiceNames = _voiceNames;
    var cosSum = 0, sinSum = 0;
    for (var i = 0; i < voiceNames.length; i++) {
      var theta = oscillators[voiceNames[i]].phase;
      cosSum += Math.cos(theta);
      sinSum += Math.sin(theta);
    }
    var N = voiceNames.length;
    return Math.sqrt(Math.pow(cosSum / N, 2) + Math.pow(sinSum / N, 2));
  }

  // ═══════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════

  // Pre-computed frustration lookup (avoid per-tick string concatenation)
  var _frustrationCache = {};
  (function _initFrustrationCache() {
    var _fvn = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
    for (var _fi = 0; _fi < _fvn.length; _fi++) {
      _frustrationCache[_fvn[_fi]] = {};
      for (var _fj = 0; _fj < _fvn.length; _fj++) {
        var v1 = _fvn[_fi], v2 = _fvn[_fj];
        var key = v1 < v2 ? v1 + '-' + v2 : v2 + '-' + v1;
        _frustrationCache[v1][v2] = FRUSTRATION[key] || 0;
      }
    }
  })();

  function _getFrustration(v1, v2) {
    return _frustrationCache[v1][v2];
  }

  // ═══════════════════════════════════════
  // TEMPO NEGOTIATION (v2.1)
  // ═══════════════════════════════════════
  //
  // 5-party tempo consensus: bass, rhythm, soloist, percussion, human.
  // Each party has its own tempo oscillator (period in ms/beat).
  //
  // Coupling is DIRECTED via mass:
  //   Heavy roles (rhythm section) resist change, pull lighter roles.
  //   Light roles (melody) follow easily, don't pull others.
  //
  // Coupling STRENGTH derived from existing frustration matrix:
  //   Tighter frustration (π/5) = stronger tempo coupling
  //   Looser frustration (π/3) = weaker tempo coupling
  //   No new magic numbers — reuses the same musical relationships.
  //
  // AI roles have tempo OPINIONS from belief state (bpmBias in ROLE_RESPONSE).
  //   needs_energy → all roles want slightly faster
  //   needs_space → all roles want slightly slower
  //   Amount varies by role: percussion is conservative, soloist is expressive.
  //
  // Human oscillator uses L&J adaptive tracking (same algorithm as old TempoEngine).
  // TempoEngine.getEffectiveBPM() reads consensus from here.

  var tempoOsc = {
    bass:       { period: 500 },
    rhythm:     { period: 500 },
    soloist:     { period: 500 },
    lead:       { period: 500 },
    percussion: { period: 500 },
    human:      { period: 500 }
  };

  var _manualPeriod = 500;  // anchor from manual BPM setting

  // Mass: three tiers from musical role — the ONLY new parameters.
  //   ANCHOR (1.0): defines the pulse. Bass, percussion, human.
  //   FOLLOW (0.5): locks to rhythm section. Rhythm.
  //   FREE   (0.2): plays freely over the pulse. Soloist.
  //
  // Coupling formula: pull(target ← source) = baseCoupling × source.mass / target.mass
  //   bass→soloist: baseCoup × 1.0/0.2 = 5× (soloist follows bass hard)
  //   soloist→bass: baseCoup × 0.2/1.0 = 0.2× (soloist barely pulls bass)
  //   bass↔perc:   baseCoup × 1.0/1.0 = 1× (equal, rhythm section lock)
  var TEMPO_MASS = { bass: 1.0, percussion: 1.0, rhythm: 0.5, soloist: 0.2, lead: 0.8, human: 1.0 };

  // Human L&J oscillator state
  var _humanIOIs = [];
  var _humanLastTime = 0;
  var _humanLastBeatTime = 0;
  var _humanConfidence = 0;

  // ── Cold-start tempo initiation ──
  // The lead voice (bass for electronic, percussion for rock/jazz) "counts in"
  // by holding strong tether to manualBPM. Fades over INITIATION_DURATION as
  // the ensemble locks in. Like a drummer counting "1-2-3-4" before the song.
  var _sessionStartTime = Date.now();
  var INITIATION_DURATION = 15000; // 15s count-in window
  // Which role leads tempo initiation (from cold-start order: whoever enters first)
  var _tempoLeader = 'bass'; // default, updated by setManualTempo/init

  // Human-to-role frustration (human couples like bass — rhythm section authority)
  var HUMAN_FRUSTRATION = {
    'bass':       Math.PI / 5,     // tight — human directly affects bass tempo
    'percussion': Math.PI / 5,     // tight — human directly affects percussion tempo
    'rhythm':        Math.PI / 4,     // moderate
    'soloist':     Math.PI / 3      // loose — human doesn't constrain melody tempo
  };

  function onHumanTempo(time, register) {
    // L&J adaptive tracking for human oscillator.
    // Same algorithm as the original TempoEngine, isolated to one oscillator.
    if (_humanLastTime === 0) {
      _humanLastTime = time;
      _humanLastBeatTime = time;
      return;
    }
    var ioi = time - _humanLastTime;
    _humanLastTime = time;

    if (ioi < 100 || ioi > 3000) {
      if (ioi > 3000) _humanLastBeatTime = time;
      return;
    }

    // Adaptive outlier filter
    if (_humanIOIs.length >= 3) {
      var ratio = ioi / tempoOsc.human.period;
      if (ratio < 0.3 || ratio > 3.0) return;
    }

    _humanIOIs.push(ioi);
    if (_humanIOIs.length > 12) _humanIOIs.shift();

    // Median IOI
    var sorted = _humanIOIs.slice().sort(function(a, b) { return a - b; });
    var medianIOI = sorted[Math.floor(sorted.length / 2)];

    // L&J period coupling
    var gc = typeof getGenreConfig === 'function'
      ? getGenreConfig(typeof SharedState !== 'undefined' ? SharedState.genre : 'pop')
      : { tempoCouplePeriod: 0.2 };
    var periodCoupling = gc.tempoCouplePeriod;

    var expectedOnset = _humanLastBeatTime + tempoOsc.human.period;
    var error = time - expectedOnset;
    var prevPeriod = tempoOsc.human.period;
    tempoOsc.human.period += periodCoupling * error;
    tempoOsc.human.period = tempoOsc.human.period * 0.7 + medianIOI * 0.3;

    // Rate-of-change damping
    var maxDelta = 0.08 * prevPeriod;
    if (tempoOsc.human.period > prevPeriod + maxDelta) tempoOsc.human.period = prevPeriod + maxDelta;
    if (tempoOsc.human.period < prevPeriod - maxDelta) tempoOsc.human.period = prevPeriod - maxDelta;
    tempoOsc.human.period = Math.max(150, Math.min(2000, tempoOsc.human.period));

    _humanLastBeatTime = time;

    // Confidence from IOI variance
    if (_humanIOIs.length >= 4) {
      var mean = _humanIOIs.reduce(function(a, b) { return a + b; }, 0) / _humanIOIs.length;
      var v = _humanIOIs.reduce(function(a, b) { return a + (b - mean) * (b - mean); }, 0) / _humanIOIs.length;
      var cv = Math.sqrt(v) / mean;
      _humanConfidence = Math.max(0, Math.min(1, 1 - cv * 3));
    }
  }

  function _getTempoBaseCoupling(v1, v2) {
    // Derive from frustration: lower frustration = tighter coupling.
    // coupling = minFrust / frust  (inverted, normalized to [0, 1])
    var frust;
    if (v1 === 'human' || v2 === 'human') {
      var other = (v1 === 'human') ? v2 : v1;
      frust = HUMAN_FRUSTRATION[other] || Math.PI / 3;
    } else {
      frust = _getFrustration(v1, v2);
    }
    if (frust === 0) return 0;
    var minFrust = Math.PI / 5;  // tightest in our system
    return Math.min(1.0, minFrust / frust);
  }

  function _tickTempo(dt) {
    var dtSec = dt / 1000;
    var gc = typeof getGenreConfig === 'function'
      ? getGenreConfig(typeof SharedState !== 'undefined' ? SharedState.genre : 'pop')
      : { tempoCouplePeriod: 0.2 };
    var couplingRate = gc.tempoCouplePeriod;

    // Read bpmBias from belief state for each AI role
    var biases = { bass: 0, rhythm: 0, soloist: 0, lead: 0, percussion: 0, human: 0 };
    var aiRoles = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
    if (typeof BeliefState !== 'undefined') {
      for (var r = 0; r < aiRoles.length; r++) {
        try {
          // Use getParams() not shouldPlay() — avoids gate roll side effects
          var params = BeliefState.getParams(aiRoles[r]);
          biases[aiRoles[r]] = (params && params.bpmBias) || 0;
        } catch (e) {}
      }
    }

    var names = ['bass', 'rhythm', 'soloist', 'lead', 'percussion', 'human'];
    var newPeriods = {};

    for (var i = 0; i < names.length; i++) {
      var vi = names[i];
      var oi = tempoOsc[vi];

      // Start from current period with belief-driven bias
      // bpmBias > 0 → wants faster → shorter period
      // Scale by dtSec so bias is per-second, not per-tick
      var target = oi.period * (1 - biases[vi] * dtSec);

      // ── Dynamic mass: leader gets boosted mass during count-in ──
      // Instead of an artificial tether, the leader simply has more authority
      // during cold start. Other voices couple to it naturally — real consensus.
      // As the session matures, leader mass decays to normal (equal party).
      var sessionAge = Date.now() - _sessionStartTime;
      var massI = TEMPO_MASS[vi];
      if (sessionAge < INITIATION_DURATION && vi === _tempoLeader) {
        // Leader mass: 3.0 → 1.0 over 15s (3x authority at start, fading to equal)
        var boost = 2.0 * (1 - sessionAge / INITIATION_DURATION);
        massI = TEMPO_MASS[vi] + boost;
      }

      // Coupling pull from peers
      var pull = 0;
      for (var j = 0; j < names.length; j++) {
        if (i === j) continue;
        var vj = names[j];
        var oj = tempoOsc[vj];

        // Source mass also boosted if source is the leader during count-in
        var massJ = TEMPO_MASS[vj];
        if (sessionAge < INITIATION_DURATION && vj === _tempoLeader) {
          var boostJ = 2.0 * (1 - sessionAge / INITIATION_DURATION);
          massJ = TEMPO_MASS[vj] + boostJ;
        }

        // Directed coupling: baseCoupling × source.mass / target.mass
        var baseCoup = _getTempoBaseCoupling(vi, vj);
        var directed = baseCoup * (massJ / massI);

        pull += directed * (oj.period - target);
      }

      // Apply coupling (scaled by genre and dt)
      target += pull * couplingRate * dtSec;

      // Anchor toward manual tempo — prevents unbounded drift from bpmBias
      // v2.3: Per-voice anchor strength — perception-based time allows
      // ANCHOR roles (bass, percussion) to stay close to manual BPM
      // while FREE roles (soloist) orbit more loosely (more rubato).
      // Lead is near-anchor but with slight freedom for expressive drive.
      // Fades when human is playing (human sets the real anchor).
      // v3.17.0: Anchor raised 0.02→0.05, soloist 0.25→0.50, rhythm 0.5→0.6,
      // lead 0.75→0.80. At 0.02 base, anchor was 6× weaker than space-driven
      // bpmBias for soloist — net drift overwhelmed restoring force. At 0.05,
      // bass/perc become net-restoring at ~100ms deviation, and soloist/lead
      // reach equilibrium at ~80-100ms deviation (~3.5 BPM/min steady-state).
      var ANCHOR_SCALE = { bass: 1.0, percussion: 1.0, rhythm: 0.6, soloist: 0.50, lead: 0.80, human: 1.0 };
      var anchorStrength = 0.05 * (ANCHOR_SCALE[vi] || 1.0) * (1 - _humanConfidence);
      target += (_manualPeriod - target) * anchorStrength * dtSec;

      // Clamp to reasonable range (30-400 BPM)
      newPeriods[vi] = Math.max(150, Math.min(2000, target));
    }

    // Apply new periods
    for (var k = 0; k < names.length; k++) {
      tempoOsc[names[k]].period = newPeriods[names[k]];
    }
  }

  function getConsensusBPM() {
    // Mass-weighted average of all oscillator periods
    var totalMass = 0;
    var weightedPeriod = 0;
    var names = ['bass', 'rhythm', 'soloist', 'lead', 'percussion', 'human'];
    for (var i = 0; i < names.length; i++) {
      var m = TEMPO_MASS[names[i]];
      weightedPeriod += m * tempoOsc[names[i]].period;
      totalMass += m;
    }
    return 60000 / (weightedPeriod / totalMass);
  }

  function getRoleBPM(role) {
    if (tempoOsc[role]) return 60000 / tempoOsc[role].period;
    return getConsensusBPM();
  }

  function getHumanConfidence() {
    return _humanConfidence;
  }

  function setManualTempo(bpm) {
    _manualPeriod = 60000 / bpm;
    var names = ['bass', 'rhythm', 'soloist', 'lead', 'percussion', 'human'];
    for (var i = 0; i < names.length; i++) {
      tempoOsc[names[i]].period = _manualPeriod;
    }
    _humanIOIs = [];
    _humanConfidence = 0;
    _humanLastTime = 0;
    _humanLastBeatTime = 0;
    _sessionStartTime = Date.now();

    // Determine tempo leader from genre cold-start order
    // Whoever enters first (delay=0) drives the count-in
    if (typeof BeliefState !== 'undefined' && BeliefState.getColdStartDelays) {
      var delays = BeliefState.getColdStartDelays();
      var minDelay = Infinity;
      var leader = 'bass';
      var roles = ['bass', 'rhythm', 'soloist', 'percussion'];
      for (var r = 0; r < roles.length; r++) {
        if ((delays[roles[r]] || 0) < minDelay) {
          minDelay = delays[roles[r]] || 0;
          leader = roles[r];
        }
      }
      _tempoLeader = leader;
    }
  }

  // ═══════════════════════════════════════
  // STATE & RESET
  // ═══════════════════════════════════════

  function getPhase(voice) {
    return oscillators[voice] ? oscillators[voice].phase : 0;
  }

  function getState() {
    return {
      bass:       { phase: oscillators.bass.phase, barPhase: barOscillators.bass.phase, readiness: getReadiness('bass'), bpm: getRoleBPM('bass') },
      rhythm:     { phase: oscillators.rhythm.phase, barPhase: barOscillators.rhythm.phase, readiness: getReadiness('rhythm'), bpm: getRoleBPM('rhythm') },
      soloist:    { phase: oscillators.soloist.phase, barPhase: barOscillators.soloist.phase, readiness: getReadiness('soloist'), bpm: getRoleBPM('soloist') },
      lead:       { phase: oscillators.lead.phase, barPhase: barOscillators.lead.phase, readiness: getReadiness('lead'), bpm: getRoleBPM('lead') },
      percussion: { phase: oscillators.percussion.phase, barPhase: barOscillators.percussion.phase, readiness: getReadiness('percussion'), bpm: getRoleBPM('percussion') },
      human:      { bpm: getRoleBPM('human'), confidence: _humanConfidence },
      orderParameter: getOrderParameter(),
      consensusBPM: getConsensusBPM()
    };
  }

  function reset() {
    oscillators.bass.phase = 0;
    oscillators.rhythm.phase = TWO_PI * 0.33;
    oscillators.soloist.phase = TWO_PI * 0.67;
    oscillators.lead.phase = TWO_PI * 0.17;
    oscillators.percussion.phase = TWO_PI * 0.50;
    // v3.17.0: Reset bar-level oscillators
    barOscillators.bass.phase = 0;
    barOscillators.rhythm.phase = 0;
    barOscillators.soloist.phase = 0;
    barOscillators.lead.phase = 0;
    barOscillators.percussion.phase = 0;
    // v8 Feature D: Reset phrase oscillators (decorrelated)
    phraseOscillators.bass.phase = 0;
    phraseOscillators.rhythm.phase = Math.PI * 0.5;
    phraseOscillators.soloist.phase = Math.PI;
    phraseOscillators.lead.phase = Math.PI * 1.5;
    phraseOscillators.percussion.phase = Math.PI * 0.67;
    setManualTempo(120);
  }

  return {
    tick:              tick,
    onNoteProduced:    onNoteProduced,
    getReadiness:      getReadiness,
    getTemporalOffset: getTemporalOffset,
    getOrderParameter: getOrderParameter,
    getPhase:          getPhase,
    getState:          getState,
    reset:             reset,
    // v3.17.0: Bar-level hierarchical entrainment API
    getBarEmphasis:    getBarEmphasis,
    getBarPhase:       getBarPhase,
    // Tempo negotiation API
    onHumanTempo:      onHumanTempo,
    getConsensusBPM:   getConsensusBPM,
    getRoleBPM:        getRoleBPM,
    getHumanConfidence: getHumanConfidence,
    setManualTempo:    setManualTempo,
    TEMPO_MASS:        TEMPO_MASS,
    // v8 Feature F: Ensemble coherence API (Dotov 2022)
    getCoherenceState: function() { return { r: _rEMA, drdt: _drdt }; },
    // v8 Feature D: Phrase-level entrainment API (Large & Jones 1999)
    getPhraseEmphasis: getPhraseEmphasis,
    getPhrasePhase:    getPhrasePhase
  };

})();

console.log('%cPhaseCoupling loaded (Kuramoto + TempoNegotiation)', 'color:#f6a;font-family:monospace');

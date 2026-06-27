'use strict';
// ═══ BELIEF STATE v2 — Music-Need Sensing (POMDP) ═══
//
// Reframe from v1.3 (human-intent tracking) to v2 (music-need sensing).
//
// The core insight: each voice should sense "what the music needs right now"
// rather than "what does the human want." The hidden state is the musical
// situation, not any individual's intent. This works whether there are
// 0, 1, or 4 humans in the jam.
//
// Hidden states (what the music needs):
//   0: NEEDS_STABILITY   — harmonic anchor missing, rhythm scattered
//   1: NEEDS_ENERGY      — too static, predictability high, density flat
//   2: NEEDS_SPACE        — too dense, voices stepping on each other
//   3: NEEDS_SURPRISE     — too predictable, surprise avg below target
//   4: NEEDS_RESOLUTION   — tension accumulated, dissonance needs to resolve
//
// Observations are PER-VOICE where possible, some global:
//   notesPerBeat, intervalTension, phraseProgress (per-voice since v2.2)
//   harmonicRhythm (global), harmonicDrift (global, v3.8.0), repetitionNovelty (per-voice),
//   onsetRegularity (per-voice), ensembleCoherence (global, v3.8.0)
//   + discrete: activeVoiceCount, sectionState, resolutionUrgency, humanPresence
//
// v3.8.0: Per-role ROLE_SENSITIVITY weights each channel's logL contribution differently.
// Each voice also interprets beliefs via ROLE_RESPONSE tables (bass=anchor, etc.).
//
// v3.17.0: Tiered multi-timescale observation banks.
// Problem: all 11 channels updated every tick (~5ms), so fast signals (notesPerBeat)
// dominated slow structural signals (harmonicDrift, ensembleCoherence) by sheer
// update frequency. Fix: cache slow channels (500ms) and medium channels (200ms),
// apply TIMESCALE_WEIGHT so slow channels carry proportional influence per evaluation.
// Also: stability minimum hold (5s, London's perceptual present) and density σ widening.
//
// Per-voice energy (fatigue/recovery) is kept as a simple ODE.
//
// Depends on: prediction-engine.js (SharedState), section-tracker.js,
//             context-integrator.js, phase-coupling.js, shared-loop-detector.js
// Load order: after context-integrator.js, before assistant-shared.js

var BeliefState = (function() {

  // ═══════════════════════════════════════
  // MUSIC-NEED STATES
  // ═══════════════════════════════════════

  var _lastHumanNoteTime = 0;  // tracks last time any human was ACTIVE (for continuous humanPresence)

  var NEEDS = ['needs_stability', 'needs_energy', 'needs_space', 'needs_surprise', 'needs_resolution'];
  var N_STATES = 5;

  // Backward compat: assistants read INTENTS
  var INTENTS = NEEDS;

  // ═══════════════════════════════════════
  // PER-VOICE BELIEF + ENERGY
  // ═══════════════════════════════════════

  // Per-voice initial beliefs reflect musical role hierarchy at cold start:
  //
  // Bass starts with HIGH confidence the music needs_stability — it's the
  // anchor, it should go first and establish harmonic ground. Low entropy
  // prior means "I know what to do: provide stability."
  //
  // Rhythm starts moderately certain about stability but more spread — ready
  // to support whatever bass establishes, open to other needs emerging.
  //
  // Soloist starts with near-maximum entropy — "I don't know what the music
  // needs yet, I'll listen first." This causes the belief gate to suppress
  // soloist early (low concentration → low gate probability), which is
  // musically correct: the melodic voice waits for context before entering.
  // Identity: melodic lead (electronic synth melody), not jazz soloist.
  //
  // This asymmetry matches KEY_VOICE_WEIGHTS (bass=2.5, soloist=0.5),
  // PhaseCoupling initial phases (bass=0/ready, soloist=0.67τ/resting),
  // and ROLE_RESPONSE gate weights (bass stability=1.3, soloist=0.5).

  var INITIAL_BELIEFS = {
    //              stability  energy   space    surprise  resolution
    bass:       [0.50, 0.15, 0.10, 0.10, 0.15],  // strong stability prior (anchor goes first)
    rhythm:     [0.30, 0.25, 0.15, 0.15, 0.15],  // moderate — open to multiple needs
    soloist:     [0.15, 0.30, 0.15, 0.25, 0.15],  // leans toward energy/surprise (wants to contribute, not lay out)
    percussion: [0.40, 0.20, 0.10, 0.15, 0.15],  // stability-leaning prior — count-in establishes groove first
    lead:       [0.20, 0.35, 0.10, 0.20, 0.15]   // energy-leaning (driver role)
  };

  // ── Temporal awareness ──
  // Each voice tracks real-time durations for urge-based decisions.
  // These modulate belief parameters (gateW, tempBias, densityBias) so that
  // time itself drives musical decisions:
  //   "We've been on this groove too long" → urge to change mode
  //   "Nothing happened for 8 bars" → urge to play
  //   "Just started" → suppress adventurousness
  var _sessionStartTime = Date.now();  // init immediately so maturity ramp starts on load

  var voices = {
    bass: {
      belief: INITIAL_BELIEFS.bass.slice(),
      _prevBelief: INITIAL_BELIEFS.bass.slice(),  // v2.7.0: velocity tracking
      energy: 0.8,       // bass starts with more stamina (anchor endurance)
      isActive: false,
      // Temporal awareness (real-time, not tick-based)
      lastNoteTime: 0,        // when this voice last produced a note
      lastModeChange: 0,      // when behavior mode last changed
      currentMode: null,      // current behavior mode name
      dominantSince: 0,       // when current dominant belief became dominant
      _spaceDomSec: 0         // v3.8.2: seconds needs_space has been dominant (restlessness)
    },
    rhythm: {
      belief: INITIAL_BELIEFS.rhythm.slice(),
      _prevBelief: INITIAL_BELIEFS.rhythm.slice(),
      energy: 0.7,
      isActive: false,
      lastNoteTime: 0, lastModeChange: 0, currentMode: null, dominantSince: 0, _spaceDomSec: 0
    },
    soloist: {
      belief: INITIAL_BELIEFS.soloist.slice(),
      _prevBelief: INITIAL_BELIEFS.soloist.slice(),
      energy: 0.6,       // soloist starts with less energy (patience before entering)
      isActive: false,
      lastNoteTime: 0, lastModeChange: 0, currentMode: null, dominantSince: 0, _spaceDomSec: 0
    },
    percussion: {
      belief: INITIAL_BELIEFS.percussion.slice(),
      _prevBelief: INITIAL_BELIEFS.percussion.slice(),
      energy: 0.7,       // moderate stamina (rhythmic endurance)
      isActive: false,
      lastNoteTime: 0, lastModeChange: 0, currentMode: null, dominantSince: 0, _spaceDomSec: 0
    },
    lead: {
      belief: INITIAL_BELIEFS.lead.slice(),
      _prevBelief: INITIAL_BELIEFS.lead.slice(),
      energy: 0.7,       // moderate stamina (sustained themes)
      isActive: false,
      lastNoteTime: 0, lastModeChange: 0, currentMode: null, dominantSince: 0, _spaceDomSec: 0
    }
  };

  // ═══════════════════════════════════════
  // ENERGY DYNAMICS (unchanged from v1.3)
  // ═══════════════════════════════════════

  var ENERGY_PARAMS = {
    bass:       { fatigueRate: 0.02, recoveryRate: 0.04 },
    rhythm:     { fatigueRate: 0.03, recoveryRate: 0.05 },
    soloist:     { fatigueRate: 0.04, recoveryRate: 0.035 },
    percussion: { fatigueRate: 0.025, recoveryRate: 0.045 },
    lead:       { fatigueRate: 0.035, recoveryRate: 0.04 }
  };

  // ═══════════════════════════════════════
  // MODE TIME CONSTANTS (v2.1)
  // ═══════════════════════════════════════
  // Each mode has a "natural breathing rate" in absolute milliseconds —
  // the temporal grain at which that mode expects musical events.
  // Independent of BPM: stability wants 5s between events whether at 60 or 180 BPM.
  var MODE_TIME_GRAIN = {
    needs_stability:  5000,   // psychological present boundary (5s)
    needs_energy:     1800,   // London's ideal experiential measure (~2s)
    needs_space:      6500,   // metric cycle ceiling (London 5-6s)
    needs_surprise:    900,   // ITPRA pre-surprise tension (~2 beats)
    needs_resolution: 3500    // echoic memory / integration window boundary (3.5s)
  };

  // ── Perceptual time constants (research-backed cognitive thresholds) ──
  // These are absolute boundaries in human auditory cognition, independent of
  // tempo, genre, or musical context. Other modules can reference these via
  // BeliefState.PERCEPTUAL to replace hardcoded magic numbers.
  var PERCEPTUAL = {
    ECHOIC_MEMORY:     3500,  // sensory trace lingers (Cowan/Neisser) — events older fade to STM
    INTEGRATION_WINDOW: 2500, // Poeppel's binding window — events within are one percept
    PERCEPTUAL_PRESENT: 5000, // outer edge of "now" (Fraisse) — beyond = memory-based
    BEAT_ANCHOR:         500, // spontaneous motor tempo / indifference interval (120 BPM)
    METRIC_CEILING:     6000, // longest bottom-up rhythmic cycle (London)
    SILENCE_SALIENCE:   1500  // gap transitions from rhythmic rest to structural silence
  };

  // Effective time grain: weighted sum of beliefs, modulated by arousal.
  // Arousal speeds up the brain's internal clock (Droit-Volet et al., 2013),
  // so high-energy states tick faster (0.7×) and low-energy states stretch (1.3×).
  function _getTimeGrain(voice) {
    var b = voices[voice].belief;
    var grain = 0;
    for (var i = 0; i < N_STATES; i++) {
      grain += b[i] * MODE_TIME_GRAIN[NEEDS[i]];
    }
    // Adaptive arousal multiplier: energy 0→1 maps to factor 1.3→0.7
    var energy = voices[voice].energy;
    var arousalFactor = 1.3 - energy * 0.6;  // 0→1.3, 0.5→1.0, 1→0.7
    return grain * arousalFactor;
  }

  // ═══════════════════════════════════════
  // SUBJECTIVE TIME MULTIPLIER (v2.3 — Perception-Based Time)
  // ═══════════════════════════════════════
  // Each voice perceives time differently based on its belief state.
  // The multiplier scales IOI ratios at scheduling time:
  //   mult > 1.0 → stretched IOIs (feels slower, more space)
  //   mult < 1.0 → compressed IOIs (feels faster, more urgency)
  //   mult = 1.0 → neutral (BPM-aligned)
  //
  // BPM becomes a suggestion — actual note timing diverges per voice.
  // Bass stays metronomic (near 1.0), soloist drifts most (rubato).
  //
  // Research basis:
  //   - Droit-Volet (2013): arousal speeds internal clock
  //   - Large & Jones (1999): attention narrows temporal window
  //   - London (2012): metric levels as temporal scaffolding
  //
  // Clamped to [0.70, 1.35] — max ~30% deviation from base tempo.
  // Voices stay "in the same song" but perceive time differently.

  var SUBJECTIVE_TIME_MULTS = {
    needs_stability:  1.00,   // neutral — maintain pulse
    needs_energy:     0.85,   // compress IOIs — feels faster, more urgent
    needs_space:      1.20,   // stretch IOIs — feels slower, more breath
    needs_surprise:   1.00,   // base neutral — jitter added separately
    needs_resolution: 1.05    // slight deceleration — cadential broadening
  };

  function _getSubjectiveTimeMult(voice) {
    var v = voices[voice];
    if (!v) return 1.0;
    var b = v.belief;

    // Belief-weighted blend of time multipliers
    var mult = 0;
    for (var i = 0; i < N_STATES; i++) {
      mult += b[i] * SUBJECTIVE_TIME_MULTS[NEEDS[i]];
    }

    // Surprise jitter: when surprise is dominant, add per-call random deviation
    // ±10% scaled by surprise belief weight — creates genuine unpredictability
    var surpriseW = b[3]; // needs_surprise index
    if (surpriseW > 0.2) {
      mult += (Math.random() * 2 - 1) * 0.10 * surpriseW;
    }

    // Resolution deceleration ramp: gradual broadening as resolution urgency increases
    if (typeof SectionTracker !== 'undefined') {
      try {
        var resUrg = SectionTracker.getState().resolutionUrgency || 0;
        mult += resUrg * 0.10;  // up to +10% slower at full urgency
      } catch (e) {}
    }

    // Clamp: max ~30% deviation from base tempo
    return Math.max(0.70, Math.min(1.35, mult));
  }

  // ═══════════════════════════════════════
  // TRANSITION MODEL  T(s'|s)
  // ═══════════════════════════════════════
  // How the music's needs evolve between ticks.
  // Key transitions: resolution → stability (cadences resolve to ground),
  // surprise is least sticky (novelty is momentary).

  var TRANSITION = [
    //  stability  energy   space    surprise  resolution
    [   0.80,      0.08,    0.04,    0.04,     0.04   ],  // stability: v3.5.1 stickier (0.70→0.80, Krumhansl tonic persistence ≥5s)
    [   0.08,      0.65,    0.12,    0.10,     0.05   ],  // energy: fairly sticky, can lead to space
    [   0.10,      0.05,    0.65,    0.10,     0.10   ],  // space: sticky, may need resolution
    [   0.15,      0.10,    0.20,    0.25,     0.30   ],  // surprise: least sticky (0.40→0.25), exits strongly to space/resolution
    [   0.25,      0.05,    0.10,    0.05,     0.55   ]   // resolution: resolves to stability (0.25)
  ];

  // ═══════════════════════════════════════
  // OBSERVATION MODEL  P(obs|state)
  // ═══════════════════════════════════════
  // Per-voice + global observations. Each dimension is a Gaussian likelihood.
  // Gaussian obs: notesPerBeat, intervalTension, phraseProgress,
  //   harmonicRhythm, harmonicDrift, repetitionNovelty, onsetRegularity, ensembleCoherence
  // Discrete obs: activeVoiceCount, sectionState, resolutionUrgency, humanPresence
  //
  // v3.8.0: Observation layer redesign — replaced 3 frozen channels:
  //   surpriseDelta    → harmonicDrift     (KeyBelief.getDivergence(), 0-0.444)
  //   dynamicArc       → ensembleCoherence (PhaseCoupling.getOrderParameter(), 0.3-0.95)
  //   repetitionNovelty kept but unfrozen (test per-voice variance)
  // Added ROLE_SENSITIVITY: per-voice channel weighting in logL computation.
  // Design: Farbood 2012 (rate > level), Kaelbling 1998 (quality > quantity),
  //   Butterfield 2010 (rhythm continuous output), Keller 2014 (role-based attending)

  // OBS_MODELS: Gaussian [mean, stddev] per channel per hidden state.
  // Calibrated v2.1: means shifted toward empirical data from eval sessions
  // while preserving theoretical ranking structure across states.
  // Stddevs widened where empirical variance was larger than theoretical.
  var OBS_MODELS = {
    //                       stability        energy           space            surprise         resolution
    // Per-voice density (normalized: 0=silent, 1=2 notes/beat per-voice)
    // v3.5.1: Recalibrated for per-voice mode (divisor=2, not ensemble divisor=6).
    // Old energy mean 0.85 was unreachable (required 1.7 notes/beat solo). Crossover
    // with stability was at 0.65 normalized — above realistic per-voice range.
    // New: energy=0.50 (crossover at 0.45, reachable at ~1 note/beat).
    // Stability 0.55→0.40: idle voice stays stable, doesn't flip to space.
    // v3.17.0: space σ reverted to 0.15 (was widened to 0.22, but wider σ made
    // space Gaussian FLATTER — more observations scored well for space, increasing
    // space dominance from 58%→71%). Tight σ=0.15 keeps space basin narrow.
    notesPerBeat:         [ [0.40, 0.18],    [0.50, 0.16],    [0.3, 0.15],     [0.75, 0.18],    [0.55, 0.15]  ],
    // Harmonic tension between voices (0-1)
    // Empirical range 0.19-0.36. Resolution=high tension, stability=low.
    intervalTension:      [ [0.2, 0.12],     [0.35, 0.15],    [0.5, 0.15],     [0.4, 0.18],     [0.7, 0.12]   ],
    // Phrase progress (0=start, 1=end/gap)
    // Empirical range 0.19-0.50. Space=mid-phrase gaps, energy=early in phrase.
    phraseProgress:       [ [0.45, 0.18],    [0.3, 0.15],     [0.6, 0.15],     [0.35, 0.18],    [0.5, 0.15]   ],
    // Rate of harmonic change (0=pedal point, 1=rapid)
    // Empirical range 0.54-0.69 (higher than expected). Resolution=rapid, stability=slower.
    harmonicRhythm:       [ [0.45, 0.12],    [0.55, 0.12],    [0.4, 0.15],     [0.65, 0.12],    [0.75, 0.1]   ],
    // v3.8.0: Key divergence across voices (0=consensus, ~0.444=max disagreement)
    // Source: KeyBelief.getDivergence(). Empirical range 0-0.444, mean ~0.069.
    // Stability/resolution want near-zero drift (key settled). Surprise wants high drift.
    harmonicDrift:        [ [0.05, 0.06],    [0.15, 0.10],    [0.08, 0.08],    [0.25, 0.12],    [0.03, 0.05]  ],
    // How different current material is from recent past (0=repetition, 1=novel)
    // Empirical: near 0 in auto-eval (repetitive patterns). Wider range expected with human input.
    repetitionNovelty:    [ [0.15, 0.15],    [0.3, 0.15],     [0.2, 0.18],     [0.5, 0.15],     [0.1, 0.12]   ],
    // Onset alignment to rhythmic grid (0=random, 1=metronomic)
    // Empirical range 0.48-0.53 (narrow). Energy/surprise=regular, space=loose.
    onsetRegularity:      [ [0.45, 0.15],    [0.65, 0.12],    [0.35, 0.18],    [0.6, 0.12],     [0.5, 0.15]   ],
    // v3.8.0: Kuramoto phase synchronization (0=incoherent, 1=locked)
    // Source: PhaseCoupling.getOrderParameter(). Empirical range 0.3-0.95.
    // Stability wants high coherence (groove lock). Surprise wants low (incoherence).
    ensembleCoherence:    [ [0.80, 0.10],    [0.75, 0.12],    [0.50, 0.15],    [0.45, 0.15],    [0.70, 0.12]  ],
    // ── v5 Phase 2: Derivative observation channels ──
    // These channels let the POMDP "see the future" — not just where things ARE but
    // where they're GOING. Source: belief history buffer (Phase 1) trend analysis.
    // Range: [-1, +1]. Positive = rising, negative = falling.
    // Farbood 2012: rate of change > absolute level for musical tension perception.
    //
    // densityTrend: is needs_space belief rising or falling? (inverted: positive = density rising = space falling)
    //   stability wants ~0 (flat), energy wants +0.3 (density rising), space wants -0.2 (density falling)
    densityTrend:         [ [0.0, 0.20],     [0.30, 0.18],    [-0.20, 0.18],   [0.15, 0.22],    [-0.10, 0.20] ],
    // coherenceTrend: is ensemble tightening or loosening?
    //   stability wants +0.1 (tightening), surprise wants -0.2 (loosening)
    coherenceTrend:       [ [0.10, 0.18],    [0.05, 0.20],    [-0.05, 0.20],   [-0.20, 0.18],   [0.10, 0.18]  ],
    // energyTrend: is needs_energy belief rising or falling?
    //   energy wants +0.3 (building), resolution wants -0.2 (decaying), stability wants ~0 (flat)
    energyTrend:          [ [0.0, 0.18],     [0.30, 0.16],    [-0.10, 0.20],   [0.15, 0.20],    [-0.20, 0.18] ],
    // ── v3.17.0: Percussion-specific observation channels ──
    // Replace dead pitch channels (intervalTension, harmonicRhythm, harmonicDrift)
    // with rhythm-aware signals. Only percussion has non-zero ROLE_SENSITIVITY for these.
    //
    // arcPhaseCompat: compatibility between current arc phase and percussion gesture density.
    // 0 = gestural silence (establish), 1 = full activity (climax).
    // Stability/resolve want low (0.2), energy/surprise want high (0.7/0.8).
    arcPhaseCompat:         [ [0.2, 0.20],     [0.7, 0.18],     [0.3, 0.20],     [0.8, 0.15],     [0.2, 0.18]  ],
    // ensembleDensityDelta: how different is percussion density from ensemble average?
    // 0.5 = matched, >0.5 = percussion denser, <0.5 = sparser.
    // Stability wants matched (0.5), energy wants denser (0.65), space wants sparser (0.35).
    ensembleDensityDelta:   [ [0.50, 0.15],    [0.65, 0.18],    [0.35, 0.15],    [0.55, 0.20],    [0.45, 0.15] ],
    // rhythmSectionCohere: coherence between percussion and bass/rhythm timing.
    // High = locked groove, low = independent. Source: onset time correlation.
    // Stability/resolution want high (0.7/0.65), surprise wants low (0.35).
    rhythmSectionCohere:    [ [0.70, 0.12],    [0.60, 0.15],    [0.45, 0.18],    [0.35, 0.15],    [0.65, 0.12] ],
    // ── v6 Phase 7E: Melodic entropy from MelodicExpectancy (IDyOM-inspired) ──
    // High entropy = system can't predict what's next → needs_stability (anchor).
    // Low entropy = confident predictions → needs_surprise (push into unknown).
    // Range: 0-1 (normalized from raw bits: max ~3.58 bits for 12-PC uniform).
    // Source: MelodicExpectancy.getEntropy() averaged across pitched voices. Slow bank (500ms).
    // Pearce 2018, Gold et al. 2019: surprisal predicts neural ERP, aesthetic pleasure.
    melodicEntropy:         [ [0.75, 0.15],    [0.50, 0.20],    [0.50, 0.20],    [0.25, 0.15],    [0.60, 0.18] ],
    // v8.16.0 Phase D: Section state as continuous Gaussian (replaces discrete switch block).
    // Encoding: STABLE=0.0, BUILD=0.33, TRANSITION=0.5, PEAK=0.67, RELEASE=1.0
    // Grounding: Huron 2006 (closure), London 2012 (metric regularity), Farbood 2012 (tension),
    //            Lerdahl 2001 (hierarchical resolution), Pearce 2018 (prediction violation).
    //   [needs_stability, needs_energy, needs_space, needs_surprise, needs_resolution]
    sectionTransition:      [ [0.15, 0.20],    [0.50, 0.20],    [0.10, 0.25],    [0.65, 0.18],    [0.90, 0.15] ]
  };

  // Normalize raw observations to [0, 1] range for Gaussian consumption.
  // v2.1 redesign: all 8 Gaussian channels are naturally [0,1] by construction.
  // Only notesPerBeat needs division (raw is notes/beat, cap at 6).
  // _normalizeObsVoice: voice name for pool lookup, set before calling _normalizeObs
  var _normObsVoiceName = '_global';

  function _normalizeObs(obs, perVoice) {
    // v2.2: per-voice density is ~3-4x lower than ensemble total.
    // Divide by 2 (single voice max ~2 notes/beat) instead of 6 (ensemble max).
    var npbDivisor = perVoice ? 2 : 6;
    // Reuse pre-allocated normalized obs object (zero GC pressure)
    var norm = _normObsPool[_normObsVoiceName];
    // 3 kept channels
    // v3.17.0: Per-voice floor at 0.345 — the exact crossover point where space
    // Gaussian (mean=0.30, σ=0.15) and stability Gaussian (mean=0.40, σ=0.18)
    // score equally (both ≈0.955). Solved from: ((x-0.30)/0.15)² = ((x-0.40)/0.18)²
    // → x = 0.345. Previous floors: 0.05 (v3.8.0, 33.8% space advantage),
    // 0.25 (v3.8.1, still below space mean), 0.33 (v3.17.0a, 5.7% advantage).
    norm.notesPerBeat      = Math.max(perVoice ? 0.345 : 0, Math.min(1, obs.notesPerBeat / npbDivisor));
    norm.intervalTension   = obs.intervalTension;
    norm.phraseProgress    = obs.phraseProgress;
    // 5 channels (already 0-1 from their computation)
    norm.harmonicRhythm    = obs.harmonicRhythm;
    norm.harmonicDrift     = obs.harmonicDrift;
    norm.repetitionNovelty = obs.repetitionNovelty;
    norm.onsetRegularity   = obs.onsetRegularity;
    norm.ensembleCoherence = obs.ensembleCoherence;
    // v5 Phase 2: Derivative channels (already [-1, +1] from trend analysis)
    norm.densityTrend      = obs.densityTrend;
    norm.coherenceTrend    = obs.coherenceTrend;
    norm.energyTrend       = obs.energyTrend;
    // v3.17.0: Percussion-specific channels (already 0-1 from computation)
    norm.arcPhaseCompat        = obs.arcPhaseCompat;
    norm.ensembleDensityDelta  = obs.ensembleDensityDelta;
    norm.rhythmSectionCohere   = obs.rhythmSectionCohere;
    // v6 7E: Melodic entropy (normalized 0-1 from slow bank)
    norm.melodicEntropy        = obs.melodicEntropy;
    // v8.16.0 Phase D: Section state as continuous value
    norm.sectionTransition     = obs.sectionTransition;
    // Non-Gaussian fields (discrete/categorical)
    norm.activeVoiceCount  = obs.activeVoiceCount;
    norm.sectionState      = obs.sectionState;  // kept for diagnostic logging
    norm.resolutionUrgency = obs.resolutionUrgency;
    norm.humanPresence     = obs.humanPresence;
    return norm;
  }

  // v3.8.0: Per-role observation sensitivity — each voice weights channels differently.
  // Fixes last centralization violation: all voices previously used identical OBS_MODELS.
  // Multiplies logL contribution per channel. 1.0 = neutral, <1.0 = dampened, >1.0 = amplified.
  // Psychoacoustic grounding:
  //   Rhythm selfDensity 0.6x — breaks density→space feedback loop (Butterfield 2010: continuous output)
  //   Rhythm ensembleCoherence 1.5x — groove lock-in over self-density (Large & Jones 1999)
  //   Bass harmonicDrift 1.5x — harmonic anchor cares about key stability (Krumhansl 1990)
  //   Soloist intervalTension 1.5x — melodic explorer cares about harmonic interest
  //   Percussion harmonicDrift 0.2x — non-pitched voice, harmonic signals are noise
  var ROLE_SENSITIVITY = {
    bass:       { notesPerBeat: 1.0, intervalTension: 0.7, phraseProgress: 0.8,
                  harmonicRhythm: 1.0, harmonicDrift: 1.5, repetitionNovelty: 0.5,
                  onsetRegularity: 0.8, ensembleCoherence: 1.2,
                  densityTrend: 0.8, coherenceTrend: 1.3, energyTrend: 0.8,
                  arcPhaseCompat: 0.0, ensembleDensityDelta: 0.0, rhythmSectionCohere: 0.0,
                  melodicEntropy: 0.8, sectionTransition: 1.2 },  // Krumhansl 1990: bass anchors section
    rhythm:     { notesPerBeat: 0.6, intervalTension: 0.5, phraseProgress: 1.3,
                  harmonicRhythm: 0.8, harmonicDrift: 0.5, repetitionNovelty: 0.6,
                  onsetRegularity: 1.0, ensembleCoherence: 1.5,
                  densityTrend: 0.5, coherenceTrend: 1.5, energyTrend: 0.7,
                  arcPhaseCompat: 0.0, ensembleDensityDelta: 0.0, rhythmSectionCohere: 0.0,
                  melodicEntropy: 0.5, sectionTransition: 1.3 },  // Butterfield 2010: rhythm most section-responsive
    soloist:    { notesPerBeat: 0.7, intervalTension: 1.5, phraseProgress: 0.8,
                  harmonicRhythm: 1.0, harmonicDrift: 0.8, repetitionNovelty: 1.3,
                  onsetRegularity: 0.6, ensembleCoherence: 0.8,
                  densityTrend: 0.8, coherenceTrend: 0.6, energyTrend: 1.3,
                  arcPhaseCompat: 0.0, ensembleDensityDelta: 0.0, rhythmSectionCohere: 0.0,
                  melodicEntropy: 1.0, sectionTransition: 0.8 },  // Pressing 1999: soloist maintains independence
    lead:       { notesPerBeat: 0.8, intervalTension: 1.2, phraseProgress: 0.8,
                  harmonicRhythm: 1.0, harmonicDrift: 1.2, repetitionNovelty: 1.0,
                  onsetRegularity: 0.7, ensembleCoherence: 0.8,
                  densityTrend: 1.0, coherenceTrend: 0.8, energyTrend: 1.0,
                  arcPhaseCompat: 0.0, ensembleDensityDelta: 0.0, rhythmSectionCohere: 0.0,
                  melodicEntropy: 0.9, sectionTransition: 0.9 },
    percussion: { notesPerBeat: 0.5, intervalTension: 0.0, phraseProgress: 1.0,
                  harmonicRhythm: 0.0, harmonicDrift: 0.0, repetitionNovelty: 0.5,
                  onsetRegularity: 1.2, ensembleCoherence: 1.5,
                  densityTrend: 0.6, coherenceTrend: 1.5, energyTrend: 0.8,
                  arcPhaseCompat: 1.0, ensembleDensityDelta: 0.8, rhythmSectionCohere: 1.2,
                  melodicEntropy: 0.0, sectionTransition: 1.2 }  // Zbikowski 2004: percussion section-driven
  };

  // ═══════════════════════════════════════
  // TIERED OBSERVATION BANKS (v3.17.0)
  // ═══════════════════════════════════════
  // Match observation update rates to psychoacoustic time constants.
  // Fast channels (density, tension): every tick (~5ms) — immediate auditory response.
  // Medium channels (phrase, regularity, novelty, harmonic rhythm): every 200ms —
  //   metric perception (London 2012), attention (Berlyne 1971).
  // Slow channels (harmonic drift, ensemble coherence): every 500ms —
  //   key stability (Krumhansl 1990 perceptual present), entrainment (Large & Jones 1999).
  // Derivative channels: already on 500ms history interval (v3.9.1).
  var _MEDIUM_INTERVAL_MS = 200;
  var _SLOW_INTERVAL_MS = 500;
  var _lastMediumRefreshMs = 0;
  var _lastSlowRefreshMs = 0;
  var _cachedMediumObs = {};   // per-voice: { phraseProgress, onsetRegularity, repetitionNovelty }
  var _cachedGlobalMedium = { harmonicRhythm: 0 };
  var _cachedSlowObs = { harmonicDrift: 0, ensembleCoherence: 0.5, melodicEntropy: 0.5,
    _densityTrend: 0, _energyTrend: 0, _coherenceTrend: 0 };

  // ── v8.15.0: Peer-based trend ring buffers ──
  // Track peer density, ensemble energy, and ensemble coherence over 5-second windows.
  // 10 samples × 500ms = 5 seconds. Replaces disabled self-referential trend observations.
  var TREND_WINDOW = 10;
  var _trendBuf = {
    density: new Float64Array(TREND_WINDOW),
    energy: new Float64Array(TREND_WINDOW),
    coherence: new Float64Array(TREND_WINDOW),
    idx: 0, count: 0
  };

  // Linear regression over a float ring buffer → trend in [-1, +1].
  // Reuses slope formula from _getBeliefTrend but on simple float arrays.
  function _computeTrend(buf, idx, count) {
    var n = Math.min(count, TREND_WINDOW);
    if (n < 3) return 0;
    var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (var i = 0; i < n; i++) {
      var ri = (idx - n + i + TREND_WINDOW) % TREND_WINDOW;
      var y = buf[ri];
      sumX += i;
      sumY += y;
      sumXY += i * y;
      sumX2 += i * i;
    }
    var denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return 0;
    var slope = (n * sumXY - sumX * sumY) / denom;
    // Normalize: values are 0-1 range, max slope ~0.1/sample, ×10 maps to [-1,+1]
    return Math.max(-1, Math.min(1, slope * 10));
  }

  // ── Pre-allocated observation objects (avoid per-tick GC pressure) ──
  // One reusable obs object per voice + one for global fallback.
  // These are written to in _gatherObservations and read in _updateBelief.
  // NEVER hold references to these across ticks.
  var _obsPool = {};
  var _normObsPool = {};
  (function _initObsPools() {
    var _poolVoices = ['bass', 'rhythm', 'soloist', 'percussion', 'lead', '_global'];
    for (var _pvi = 0; _pvi < _poolVoices.length; _pvi++) {
      var _pv = _poolVoices[_pvi];
      _obsPool[_pv] = {
        notesPerBeat: 0, intervalTension: 0, phraseProgress: 0.5,
        harmonicRhythm: 0, harmonicDrift: 0, repetitionNovelty: 0.5,
        onsetRegularity: 0.5, ensembleCoherence: 0.5,
        densityTrend: 0, coherenceTrend: 0, energyTrend: 0,
        arcPhaseCompat: 0.3, ensembleDensityDelta: 0.5, rhythmSectionCohere: 0.5,
        melodicEntropy: 0.5, sectionTransition: 0.0,
        activeVoiceCount: 0, humanPresence: 0, sectionState: 'STABLE', resolutionUrgency: 0
      };
      _normObsPool[_pv] = {
        notesPerBeat: 0, intervalTension: 0, phraseProgress: 0.5,
        harmonicRhythm: 0, harmonicDrift: 0, repetitionNovelty: 0.5,
        onsetRegularity: 0.5, ensembleCoherence: 0.5,
        densityTrend: 0, coherenceTrend: 0, energyTrend: 0,
        arcPhaseCompat: 0.3, ensembleDensityDelta: 0.5, rhythmSectionCohere: 0.5,
        melodicEntropy: 0.5, sectionTransition: 0.0,
        activeVoiceCount: 0, humanPresence: 0, sectionState: 'STABLE', resolutionUrgency: 0
      };
    }
  })();

  // Timescale influence weights: all 1.0. With tiered caching, slow channels
  // contribute their CACHED values at every tick (not only at refresh). This means
  // slow evidence compounds through repeated Bayesian updates naturally — a stable
  // slow signal reinforces itself 100× between refreshes. Weight amplification was
  // double-counting: it boosted already-compounding evidence, creating binary
  // whipsaw (space=0.74 ↔ stability=0.74 snap on slow refresh). Uniform weights
  // let the caching architecture do the work smoothly.
  var TIMESCALE_WEIGHT = {
    // Fast bank (every tick)
    notesPerBeat: 1.0, intervalTension: 1.0,
    // Medium bank (cached, refreshed every 200ms)
    phraseProgress: 1.0, onsetRegularity: 1.0, repetitionNovelty: 1.0, harmonicRhythm: 1.0,
    // Slow bank (cached, refreshed every 500ms)
    harmonicDrift: 1.0, ensembleCoherence: 1.0,
    // Derivative bank (cached, refreshed every 500ms)
    densityTrend: 1.0, coherenceTrend: 1.0, energyTrend: 1.0,
    // Percussion-specific channels (medium bank, 200ms)
    arcPhaseCompat: 1.0, ensembleDensityDelta: 1.0, rhythmSectionCohere: 1.0,
    // v6 7E: Melodic entropy (slow bank, 500ms)
    melodicEntropy: 1.0,
    // v8.16.0 Phase D: Section state (slow bank — transitions are infrequent)
    sectionTransition: 1.0
  };

  // ═══════════════════════════════════════
  // BELIEF HISTORY BUFFER (v5 Phase 1)
  // ═══════════════════════════════════════
  // Rolling 30-second memory of each voice's belief trajectory.
  // Sampled every 500ms (not every tick — too much data, too little change).
  // 60 samples × 5 states per voice = 300 floats per voice, 1500 total.
  // Enables: trend detection, cycle counting, staleness detection, trajectory phase.
  // Foundation for Phases 2-6 (derivative observations, narrative arcs, peer models).

  var HISTORY_SAMPLES = 60;       // 60 × 500ms = 30 seconds
  var HISTORY_INTERVAL_MS = 500;  // sample every 500ms

  var _beliefHistory = {};
  function _initHistory() {
    var voiceNames = ['bass', 'rhythm', 'soloist', 'percussion', 'lead'];
    for (var i = 0; i < voiceNames.length; i++) {
      var v = voiceNames[i];
      _beliefHistory[v] = {
        buffer: new Float32Array(HISTORY_SAMPLES * N_STATES),  // flat: [s0,s1,s2,s3,s4, s0,s1,...]
        head: 0,
        count: 0,
        lastSampleTime: 0
      };
    }
  }
  _initHistory();

  // Write current belief into circular buffer
  function _sampleHistory(voice, now) {
    var h = _beliefHistory[voice];
    if (!h) return;
    if (now - h.lastSampleTime < HISTORY_INTERVAL_MS) return;
    h.lastSampleTime = now;

    var b = voices[voice].belief;
    var offset = h.head * N_STATES;
    for (var i = 0; i < N_STATES; i++) {
      h.buffer[offset + i] = b[i];
    }
    h.head = (h.head + 1) % HISTORY_SAMPLES;
    if (h.count < HISTORY_SAMPLES) h.count++;
  }

  // Read sample at index (0 = oldest available, count-1 = newest)
  function _readHistory(voice, idx) {
    var h = _beliefHistory[voice];
    if (!h || idx < 0 || idx >= h.count) return null;
    // oldest is at (head - count + HISTORY_SAMPLES) % HISTORY_SAMPLES
    var start = (h.head - h.count + HISTORY_SAMPLES) % HISTORY_SAMPLES;
    var actual = (start + idx) % HISTORY_SAMPLES;
    var offset = actual * N_STATES;
    var result = new Array(N_STATES);
    for (var i = 0; i < N_STATES; i++) {
      result[i] = h.buffer[offset + i];
    }
    return result;
  }

  // ── Trajectory Analysis API ──

  // Linear regression slope of a single belief state over a window.
  // windowSamples: how many recent samples to use (default: all available).
  // Returns: -1.0 to +1.0 (positive = rising, negative = falling).
  function _getBeliefTrend(voice, stateIdx, windowSamples) {
    var h = _beliefHistory[voice];
    if (!h || h.count < 3) return 0;  // need at least 3 points
    var n = Math.min(windowSamples || h.count, h.count);
    if (n < 3) return 0;

    // Simple linear regression: slope = (n*Σxy - Σx*Σy) / (n*Σx² - (Σx)²)
    var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    var startIdx = h.count - n;
    for (var i = 0; i < n; i++) {
      var sample = _readHistory(voice, startIdx + i);
      if (!sample) continue;
      var x = i;
      var y = sample[stateIdx];
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }
    var denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return 0;
    var slope = (n * sumXY - sumX * sumY) / denom;
    // Normalize: slope is per-sample, scale to [-1, +1] range
    // Max possible slope ~0.016 per sample (0→0.8 over 50 samples), so ×60 maps to [-1,1]
    return Math.max(-1, Math.min(1, slope * 60));
  }

  // Count oscillations of the dominant state over the window.
  // An oscillation = dominant flips away and comes back.
  function _getBeliefCycleCount(voice, stateIdx, windowSamples) {
    var h = _beliefHistory[voice];
    if (!h || h.count < 4) return 0;
    var n = Math.min(windowSamples || h.count, h.count);
    var startIdx = h.count - n;
    var cycles = 0;
    var wasDominant = false;
    var wasAway = false;

    for (var i = 0; i < n; i++) {
      var sample = _readHistory(voice, startIdx + i);
      if (!sample) continue;
      // Find dominant state in this sample
      var maxVal = -1, maxIdx = -1;
      for (var j = 0; j < N_STATES; j++) {
        if (sample[j] > maxVal) { maxVal = sample[j]; maxIdx = j; }
      }
      var isDominant = (maxIdx === stateIdx);

      if (isDominant && wasAway) {
        cycles++;  // returned to this state after being away
        wasAway = false;
      } else if (!isDominant && wasDominant) {
        wasAway = true;
      }
      wasDominant = isDominant;
    }
    return cycles;
  }

  // Variance of a single belief state over the window.
  // Returns: 0 (constant) to ~0.25 (maximum variance for [0,1] bounded values).
  function _getBeliefVariance(voice, stateIdx, windowSamples) {
    var h = _beliefHistory[voice];
    if (!h || h.count < 2) return 0;
    var n = Math.min(windowSamples || h.count, h.count);
    var startIdx = h.count - n;

    var sum = 0, sumSq = 0, count = 0;
    for (var i = 0; i < n; i++) {
      var sample = _readHistory(voice, startIdx + i);
      if (!sample) continue;
      var y = sample[stateIdx];
      sum += y;
      sumSq += y * y;
      count++;
    }
    if (count < 2) return 0;
    var mean = sum / count;
    return Math.max(0, sumSq / count - mean * mean);
  }

  // Overall trajectory phase based on dominant state's trend and variance.
  // Returns: 'rising' | 'falling' | 'plateau' | 'oscillating'
  function _getTrajectoryPhase(voice) {
    var h = _beliefHistory[voice];
    if (!h || h.count < 4) return 'plateau';

    // Find current dominant state
    var b = voices[voice].belief;
    var domIdx = 0;
    for (var i = 1; i < N_STATES; i++) {
      if (b[i] > b[domIdx]) domIdx = i;
    }

    var trend = _getBeliefTrend(voice, domIdx, 20);     // ~10 second window
    var variance = _getBeliefVariance(voice, domIdx, 20);
    var cycles = _getBeliefCycleCount(voice, domIdx, 20);

    // High cycle count (≥2) with moderate variance = oscillating
    if (cycles >= 2 && variance > 0.01) return 'oscillating';
    // Strong upward trend
    if (trend > 0.2) return 'rising';
    // Strong downward trend
    if (trend < -0.2) return 'falling';
    // Low variance, low trend = plateau
    return 'plateau';
  }

  // Stale pattern detection: is this voice stuck in a repetitive cycle?
  // Returns: { stale: bool, cycleCount: int, suggestion: 'contrast'|'develop'|null }
  function _isStalePattern(voice, windowSamples) {
    var h = _beliefHistory[voice];
    if (!h || h.count < 10) return { stale: false, cycleCount: 0, suggestion: null };
    var n = Math.min(windowSamples || 40, h.count);  // default ~20 second window

    // Find dominant state
    var b = voices[voice].belief;
    var domIdx = 0;
    for (var i = 1; i < N_STATES; i++) {
      if (b[i] > b[domIdx]) domIdx = i;
    }

    var cycles = _getBeliefCycleCount(voice, domIdx, n);
    var variance = _getBeliefVariance(voice, domIdx, n);

    // Oscillating: same 2 states flipping ≥3 times
    if (cycles >= 3) {
      return { stale: true, cycleCount: cycles, suggestion: 'contrast' };
    }
    // Plateau: dominant state held >70% of window with low variance
    if (variance < 0.005) {
      // Check if dominant was same for >70% of samples
      var startIdx = h.count - n;
      var domCount = 0;
      for (var i = 0; i < n; i++) {
        var sample = _readHistory(voice, startIdx + i);
        if (!sample) continue;
        var maxVal = -1, maxIdx = -1;
        for (var j = 0; j < N_STATES; j++) {
          if (sample[j] > maxVal) { maxVal = sample[j]; maxIdx = j; }
        }
        if (maxIdx === domIdx) domCount++;
      }
      if (domCount / n > 0.70) {
        return { stale: true, cycleCount: 0, suggestion: 'develop' };
      }
    }
    return { stale: false, cycleCount: cycles, suggestion: null };
  }

  // ── v8 Feature E: Anticipatory belief projection (ADAM model, Keller 2014) ──
  // Linear extrapolation of belief trajectory using existing trend infrastructure.
  // Returns projected belief distribution N beats ahead. Read-only — does NOT modify beliefs.
  // Only projects when trajectory phase is 'rising' or 'falling' (not noise/plateau).
  var _projectScratch = new Array(N_STATES);
  function _projectBelief(voice, beatsAhead) {
    var v = voices[voice];
    if (!v) return null;
    var phase = _getTrajectoryPhase(voice);
    // Only project on clear directional trends
    if (phase !== 'rising' && phase !== 'falling') return v.belief;

    var bpm = (typeof TempoEngine !== 'undefined') ? TempoEngine.getEffectiveBPM() : 120;
    var beatMs = 60000 / Math.max(30, bpm);
    var samplesAhead = Math.min(16, (beatsAhead * beatMs) / HISTORY_INTERVAL_MS);

    var sum = 0;
    for (var i = 0; i < N_STATES; i++) {
      var trend = _getBeliefTrend(voice, i, 20);
      var slopePerSample = trend / 60;  // trend is ×60 normalized
      _projectScratch[i] = Math.max(0.05, Math.min(0.80, v.belief[i] + slopePerSample * samplesAhead));
      sum += _projectScratch[i];
    }
    // Renormalize
    if (sum > 0) for (var i = 0; i < N_STATES; i++) _projectScratch[i] /= sum;
    return _projectScratch;
  }

  // v3.8.2: Restlessness — musicians don't sit silent forever.
  // When needs_space dominates too long, a growing urge to play ("boredom") pushes
  // the voice toward needs_energy, breaking the space trap.
  // Psychoacoustic basis: Huron 2006 (expectation drives re-engagement),
  // Butterfield 2010 (drummer maintains pulse through silence),
  // Large & Jones 1999 (rhythmic attending decays without input, then resets).
  // Percussion breaks out first (reinitiator), rhythm second (groove anchor),
  // pitch voices follow. This creates a natural re-entry cascade.
  var RESTLESS_THRESHOLD = {
    percussion: 4,   // drummer breaks silence first (Butterfield: continuous output)
    rhythm:     6,   // groove anchor re-enters second
    bass:      10,   // harmonic anchor follows
    lead:      10,   // thematic voice follows
    soloist:   12    // explorer enters last (patience before solo)
  };

  // v3.17.0: Stability minimum hold duration — London's perceptual present (5s).
  // Stability needs ≥5s to establish harmonic grounding before modulation feels
  // like departure (Krumhansl 1990). Without this, density-driven observation
  // cycles erode stability within 1-2s. The hold dampens observation pressure
  // that would push away from stability during the first 5s of dominance,
  // then releases fully so the system can transition naturally.
  // Huron 2006: contrastive valence — surprise only satisfying against stable baseline.
  var STABILITY_MIN_HOLD_MS = 5000;

  // Pre-computed observation field names (avoid per-call array allocation)
  var _OBS_FIELDS = ['notesPerBeat', 'intervalTension', 'phraseProgress',
                'harmonicRhythm', 'harmonicDrift', 'repetitionNovelty', 'onsetRegularity', 'ensembleCoherence',
                'densityTrend', 'coherenceTrend', 'energyTrend',
                'arcPhaseCompat', 'ensembleDensityDelta', 'rhythmSectionCohere',
                'melodicEntropy',
                'sectionTransition'];  // v8.16.0 Phase D
  var _OBS_FIELDS_LEN = _OBS_FIELDS.length;

  // Pre-compute 1/sigma for each field×state (avoid per-call division)
  // _OBS_INV_SIGMA[fieldIdx][stateIdx] = 1/sigma
  var _OBS_INV_SIGMA = [];
  (function _initInvSigma() {
    for (var fi = 0; fi < _OBS_FIELDS.length; fi++) {
      var model = OBS_MODELS[_OBS_FIELDS[fi]];
      var inv = new Array(N_STATES);
      for (var si = 0; si < N_STATES; si++) {
        inv[si] = 1.0 / model[si][1];
      }
      _OBS_INV_SIGMA.push(inv);
    }
  })();

  // Pre-compute combined sensitivity × timescale weight per role per field
  // _ROLE_COMBINED_WEIGHT[role][fieldIdx] = sensitivity * timescaleWeight
  var _ROLE_COMBINED_WEIGHT = {};
  (function _initCombinedWeights() {
    var roles = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
    for (var ri = 0; ri < roles.length; ri++) {
      var r = roles[ri];
      var sens = ROLE_SENSITIVITY[r];
      var weights = new Array(_OBS_FIELDS.length);
      for (var fi = 0; fi < _OBS_FIELDS.length; fi++) {
        var key = _OBS_FIELDS[fi];
        var s = (sens && sens[key] !== undefined) ? sens[key] : 1.0;
        var t = (TIMESCALE_WEIGHT[key] !== undefined) ? TIMESCALE_WEIGHT[key] : 1.0;
        weights[fi] = s * t;
      }
      _ROLE_COMBINED_WEIGHT[r] = weights;
    }
  })();

  // v3.8.0: voice parameter enables per-role sensitivity weighting.
  function _observationLikelihood(stateIdx, obs, voice) {
    // Log-space computation prevents underflow from Gaussian product collapse.
    // When observations hit extremes (0.0 or 1.0), individual Gaussians → 0,
    // zeroing the entire product. Log-space + per-term floor keeps discrimination.
    var logL = 0;
    var LOG_FLOOR = -4;  // floor per observation: exp(-4) ≈ 0.018
    var combinedWeights = voice ? _ROLE_COMBINED_WEIGHT[voice] : null;

    // ── Continuous Gaussian observations (all normalized to 0-1) ──
    // v3.8.0: harmonicDrift replaces frozen surpriseDelta, ensembleCoherence replaces frozen dynamicArc
    for (var f = 0; f < _OBS_FIELDS_LEN; f++) {
      var key = _OBS_FIELDS[f];
      var obsVal = obs[key];
      if (obsVal !== undefined) {
        var params = OBS_MODELS[key][stateIdx];
        var d = (obsVal - params[0]) * _OBS_INV_SIGMA[f][stateIdx];
        var term = Math.max(-0.5 * d * d, LOG_FLOOR);
        // Per-role sensitivity × timescale weight (pre-combined)
        if (combinedWeights) {
          term *= combinedWeights[f];
        }
        logL += term;
      }
    }
    var L = Math.exp(logL);

    // ── Active voice count (discrete) ──
    var avc = obs.activeVoiceCount || 0;
    switch (stateIdx) {
      case 2: // needs_space: more voices = stronger signal
        if (avc >= 3) L *= 1.4;
        else if (avc <= 1) L *= 0.5;
        break;
      case 1: // needs_energy: fewer voices = stronger signal
        if (avc <= 1) L *= 1.3;
        else if (avc >= 3) L *= 0.8;
        break;
      case 0: // needs_stability: moderate voice count is fine
        if (avc === 0) L *= 1.3; // total silence = definitely needs stability
        break;
    }

    // v8.16.0 Phase D: Section state compatibility now handled by sectionTransition
    // Gaussian channel in OBS_MODELS (replaces discrete switch block).
    // The continuous encoding (STABLE=0.0, BUILD=0.33, PEAK=0.67, RELEASE=1.0)
    // provides smooth interpolation between section states instead of hard multipliers.
    // Per-role ROLE_SENSITIVITY modulates channel influence (rhythm 1.3×, soloist 0.8×).

    // ── Resolution urgency (direct boost from SectionTracker) ──
    var ru = obs.resolutionUrgency || 0;
    if (stateIdx === 4) L *= (1 + ru * 0.8);   // v2.2: reduced from 1.5 to 0.8 — per-voice intervalTension carries dissonance signal, this is now a gentle nudge not a 2.5x amplifier
    if (stateIdx === 1) L *= (1 - ru * 0.5);   // suppress needs_energy during resolution

    // ── v8.7.1: Musical momentum — when a peer voice is in a peak moment,
    // boost needs_energy and suppress needs_space for OTHER voices.
    // This is how ensembles "follow" a soloist's stunning line: hear intensity → engage.
    // Keller 2014: anticipation-driven coupling; Pressing 1999: referent tracking.
    if (voice && typeof SharedState !== 'undefined' && SharedState.musicalMomentum) {
      var _mmNow = Date.now();
      var _mmDecay = 4000;
      for (var _mmV in SharedState.musicalMomentum) {
        if (_mmV === voice) continue;  // don't boost self
        var _mm = SharedState.musicalMomentum[_mmV];
        if (!_mm || _mmNow - _mm.timestamp > _mmDecay) continue;
        var _mmStr = _mm.strength * (1.0 - (_mmNow - _mm.timestamp) / _mmDecay);
        if (_mmStr < 0.2) continue;
        // Boost energy, suppress space — "follow the leader"
        if (stateIdx === 1) L *= (1 + _mmStr * 0.5);  // needs_energy boost
        if (stateIdx === 0) L *= (1 + _mmStr * 0.3);  // needs_stability (maintain groove)
        if (stateIdx === 2) L *= (1 - _mmStr * 0.4);  // suppress needs_space
        break;  // only respond to strongest momentum source
      }
    }

    // ── v3.8.1: Human presence — counteract needs_space, boost engagement ──
    // When human is playing, ensemble should engage, not withdraw.
    // Keller 2014: ensemble attention is pulled toward active sound sources.
    // Large & Jones 1999: dynamic attending entrains to external input.
    // Without this, human input → section PEAK → needs_space → all voices silent.
    var hp = obs.humanPresence || 0;
    if (hp > 0.2) {
      switch (stateIdx) {
        case 0: L *= (1 + hp * 0.3); break;   // needs_stability: human provides anchor direction
        case 1: L *= (1 + hp * 0.4); break;   // needs_energy: human is energizing, match it
        case 2: L *= (1 - hp * 0.5); break;   // needs_space: suppress — don't retreat from human
      }
    }

    // ── v3.8.2: Restlessness — break the needs_space trap ──
    // When a voice has been dominated by needs_space too long, growing pressure
    // boosts needs_energy and suppresses needs_space. Models musician's natural
    // urge to re-enter after prolonged silence.
    var vData = voice ? voices[voice] : null;
    if (vData && vData._spaceDomSec > 0) {
      var threshold = RESTLESS_THRESHOLD[voice] || 10;
      var overtime = vData._spaceDomSec - threshold;
      if (overtime > 0) {
        // Pressure grows from 0→1 over 8 seconds past threshold
        var pressure = Math.min(overtime / 8, 1.0);
        switch (stateIdx) {
          case 1: L *= (1 + pressure * 2.5); break;  // needs_energy: strong re-engagement drive
          case 2: L *= (1 - pressure * 0.6); break;  // needs_space: weaken the trap
          case 0: L *= (1 + pressure * 0.5); break;  // needs_stability: also acceptable exit
        }
      }
    }

    return L;  // No floor needed — log-space computation with per-term floor prevents true zeros
  }

  function _gaussian(x, mean, sigma) {
    var d = (x - mean) / sigma;
    return Math.exp(-0.5 * d * d);
  }

  // ═══════════════════════════════════════
  // BELIEF UPDATE (Bayes' rule — unchanged structure)
  // ═══════════════════════════════════════

  // Pre-allocated arrays for _updateBelief (avoid per-tick GC pressure)
  // One pair per voice, reused each tick.
  var _predictedPool = {};
  var _updatedPool = {};
  (function _initBeliefPools() {
    var _bpVoices = ['bass', 'rhythm', 'soloist', 'percussion', 'lead'];
    for (var _bpi = 0; _bpi < _bpVoices.length; _bpi++) {
      _predictedPool[_bpVoices[_bpi]] = new Array(N_STATES);
      _updatedPool[_bpVoices[_bpi]] = new Array(N_STATES);
    }
  })();

  function _updateBelief(voice, obs, _tickNow) {
    var b = voices[voice].belief;

    // Predict: b_predicted(s') = SUM_s T(s'|s) * b(s)
    var predicted = _predictedPool[voice];
    for (var sp = 0; sp < N_STATES; sp++) {
      predicted[sp] = 0;
      for (var s = 0; s < N_STATES; s++) {
        predicted[sp] += TRANSITION[s][sp] * b[s];
      }
    }

    // Update: b_new(s') ∝ P(obs|s') * b_predicted(s')
    var updated = _updatedPool[voice];
    var total = 0;
    for (var i = 0; i < N_STATES; i++) {
      updated[i] = _observationLikelihood(i, obs, voice) * predicted[i];
      total += updated[i];
    }

    // Normalize
    if (total > 0) {
      for (var j = 0; j < N_STATES; j++) {
        updated[j] /= total;
      }
    } else {
      for (var k = 0; k < N_STATES; k++) {
        updated[k] = 1.0 / N_STATES;
      }
    }

    // v3.17.0: Stability minimum hold — London's perceptual present (5s).
    // When stability is dominant, dampen observation pressure pushing away from it
    // during the first 5s, allowing harmonic grounding to establish.
    var vData = voices[voice];
    var _now = _tickNow;
    if (vData._dominantIdx === undefined) { vData._dominantIdx = -1; vData._dominantEntryMs = _now; }
    // What was dominant before this update? (from pre-update belief b)
    var prevDomIdx = 0;
    for (var pd = 1; pd < N_STATES; pd++) {
      if (b[pd] > b[prevDomIdx]) prevDomIdx = pd;
    }
    // Track dominant state transitions
    if (prevDomIdx !== vData._dominantIdx) {
      vData._dominantIdx = prevDomIdx;
      vData._dominantEntryMs = _now;
    }
    // Apply hold when stability is the current dominant
    if (prevDomIdx === 0 && STABILITY_MIN_HOLD_MS > 0) {
      var holdElapsed = _now - vData._dominantEntryMs;
      if (holdElapsed < STABILITY_MIN_HOLD_MS) {
        var holdFactor = holdElapsed / STABILITY_MIN_HOLD_MS;  // 0→1 over 5s
        // Dampen growth of non-stability states relative to prediction
        for (var hi = 1; hi < N_STATES; hi++) {
          var growth = updated[hi] - predicted[hi];
          if (growth > 0) {
            updated[hi] = predicted[hi] + growth * holdFactor;
          }
        }
        // Renormalize after dampening
        var hTotal = 0;
        for (var hn = 0; hn < N_STATES; hn++) hTotal += updated[hn];
        if (hTotal > 0) {
          for (var hr = 0; hr < N_STATES; hr++) updated[hr] /= hTotal;
        }
      }
    }

    // Fix 3B: Belief momentum — blend 30% of previous belief to prevent snapping
    var MOMENTUM = 0.3;
    for (var m = 0; m < N_STATES; m++) {
      updated[m] = (1 - MOMENTUM) * updated[m] + MOMENTUM * b[m];
    }

    // Fix 3C: Concentration cap — no belief exceeds MAX_CONC, redistribute excess
    // v2.2: lowered from 0.85 to 0.70. Fixed point was (1-0.15)*0.70 + 0.15*0.2 = 0.625
    // v2.7.0: raised to 0.80 to allow stronger conviction. New eq: (0.90*0.80)+(0.10*0.05) = 0.725
    // v8.15.0: Role-differentiated conviction ceilings.
    // Bass (anchor) needs strong conviction; soloist (explorer) needs fluid beliefs.
    // Lower ceiling → beliefs can't concentrate as much → L2 intent shifts more freely.
    var _MAX_CONC_PER_ROLE = {
      bass: 0.92,        // Anchor: strong conviction, slow to change mind
      rhythm: 0.88,      // Groove: moderately certain, follows bass
      percussion: 0.85,  // Texture: follows ensemble energy
      lead: 0.82,        // Melodist: moderate conviction, responsive to context
      soloist: 0.78      // Explorer: fluid beliefs, shifts intent freely
    };
    var MAX_CONC = _MAX_CONC_PER_ROLE[voice] || 0.85;
    var excess = 0;
    for (var c = 0; c < N_STATES; c++) {
      if (updated[c] > MAX_CONC) {
        excess += updated[c] - MAX_CONC;
        updated[c] = MAX_CONC;
      }
    }
    if (excess > 0) {
      // Redistribute excess uniformly among non-capped states
      var uncapped = 0;
      for (var u = 0; u < N_STATES; u++) {
        if (updated[u] < MAX_CONC) uncapped++;
      }
      if (uncapped > 0) {
        var share = excess / uncapped;
        for (var r = 0; r < N_STATES; r++) {
          if (updated[r] < MAX_CONC) updated[r] += share;
        }
      }
    }

    // Fix 3D: Entropy regularization — blend 5% uniform to prevent permanent dominance
    var UNIFORM_BLEND = 0.10;  // v8.7.1: restored to 0.10 — 0.04 was too weak, caused group-to-group circularity (all voices lock stability). With MAX_CONC 0.92, equilibrium ~0.848.
    var uniform = 1.0 / N_STATES;
    for (var e = 0; e < N_STATES; e++) {
      updated[e] = (1 - UNIFORM_BLEND) * updated[e] + UNIFORM_BLEND * uniform;
    }

    // v2.7.0: Store current beliefs as previous (for velocity tracking)
    var prev = voices[voice]._prevBelief;
    var cur = voices[voice].belief;
    for (var pv = 0; pv < N_STATES; pv++) prev[pv] = cur[pv];

    voices[voice].belief = updated;

    // v3.8.2: Track needs_space dominance duration for restlessness
    var domIdx = _maxBelief(updated).index;
    if (domIdx === 2) { // needs_space
      voices[voice]._spaceDomSec = (voices[voice]._spaceDomSec || 0) + 0.05; // ~50ms tick
    } else {
      voices[voice]._spaceDomSec = 0;
    }
  }

  // ═══════════════════════════════════════
  // ENTROPY + DERIVED PARAMETERS
  // ═══════════════════════════════════════

  var LOG2 = Math.log(2);
  var H_MAX = Math.log(N_STATES) / LOG2;

  function _entropy(belief) {
    var h = 0;
    for (var i = 0; i < belief.length; i++) {
      if (belief[i] > 0.0001) {
        h -= belief[i] * Math.log(belief[i]) / LOG2;
      }
    }
    return h;
  }

  function _maxBelief(belief) {
    var max = 0;
    var maxIdx = 0;
    for (var i = 0; i < belief.length; i++) {
      if (belief[i] > max) {
        max = belief[i];
        maxIdx = i;
      }
    }
    return { value: max, index: maxIdx };
  }

  // ═══════════════════════════════════════
  // ═══════════════════════════════════════
  // PER-ROLE NEED INTERPRETATION  (v2.1 — grounded in ensemble research)
  // ═══════════════════════════════════════
  //
  // Each voice interprets the same belief distribution differently.
  // gateW: multiplier on gate probability (>1 = more likely to play, <1 = less)
  // tempBias: temperature shift (+ = more adventurous pitch choices)
  // densityBias: note rate shift (+ = more notes, - = fewer)
  //
  // ── BASS: Harmonic anchor ──
  // Always present. Simplest voice. Provides root motion and harmonic ground.
  // In real ensembles: bass is last to drop out, first to enter after silence.
  // Plays into stability and resolution (its primary job). Reduces density
  // for space but never fully drops out (gateW floor 0.8). Conservative on
  // surprise — bass shouldn't wander harmonically.
  //
  // ── MID (Rhythm): Harmonic fill / comping ──
  // Fills the space between bass and soloist. Chords, arpeggios, pads.
  // First voice to thin out for space — it's the most expendable layer.
  // Responsive to energy (drives groove when needed). Most flexible density.
  // In electronic music: sequencer patterns, chord stabs, pad layers.
  //
  // ── SOLOIST: Melodic voice ──
  // The memorable line. Speaks in phrases, not continuous output.
  // Appears after context is established (enters last). In electronic music
  // (TD, Kraftwerk, Jarre): the lead synth melody — not a jazz soloist.
  // High initiative on energy/surprise (it creates the moments), but
  // deliberately silent during stability (let the groove breathe) and
  // space (leave room). Uses temperature for melodic interest.
  //
  // ── PERCUSSION: Temporal anchor ──
  // Most consistent voice. Enters first, provides groove reference.
  // High gate in stability/energy (always present during groove).
  // Drops pattern complexity for space, not silence — percussion can
  // thin to sparse pattern but rarely stops entirely (unlike melodic voices).
  // In electronic context: drum machines are relentless, hypnotic.

  // v2.4: gateW recalibrated from universal ensemble research.
  // Cross-genre principles: Jamerson beat-placement, Basie "less is more",
  // Narmour I-R for soloist, Miles Davis space principle, Huron melodic arch.
  //
  // Key v2.4 changes (research-driven):
  //   bass needs_space: 0.8→0.55 (reggae one-drop, funk ghost notes — bass breathes deeply)
  //   rhythm needs_space: 0.5→0.35 ("less is more" — Freddie Green, Monk)
  //   rhythm needs_resolution: 0.8→0.95 (harmonic rhythm accelerates toward cadences)
  //   soloist needs_surprise: 1.4→1.15 (responds to surprise, doesn't drive it)
  //   lead needs_surprise: 1.1→1.35 (lead IS the dynamic driver during rising action)
  //   lead needs_resolution: 0.9→1.05 (sustains through resolution — melodic close)
  var ROLE_RESPONSE = {
    bass: {
      //                 gateW   tempBias  densityBias  bpmBias
      needs_stability:  { gateW: 1.3,  tempBias: -0.2,  densityBias: 0.05,  bpmBias:  0.0  },  // anchor — maintain tempo
      needs_energy:     { gateW: 1.2,  tempBias: 0.05,  densityBias: 0.1,   bpmBias:  0.02 },  // slight push
      needs_space:      { gateW: 0.55, tempBias: -0.15, densityBias: -0.1,  bpmBias: -0.02 },  // v2.4: breathe deeply (was 0.8; research: reggae/funk space)
      needs_surprise:   { gateW: 0.8,  tempBias: 0.0,   densityBias: 0.0,   bpmBias:  0.0  },  // neutral
      needs_resolution: { gateW: 1.2,  tempBias: -0.25, densityBias: 0.05,  bpmBias:  0.0  }   // v2.6.1: bpmBias 0 — resolution is harmonic, not temporal
    },
    rhythm: {
      needs_stability:  { gateW: 1.0,  tempBias: -0.1,  densityBias: 0.0,   bpmBias:  0.0  },  // follow groove
      needs_energy:     { gateW: 1.3,  tempBias: 0.15,  densityBias: 0.1,   bpmBias:  0.03 },  // drive energy
      needs_space:      { gateW: 0.50, tempBias: -0.15, densityBias: -0.1,  bpmBias: -0.02 },  // v3.2.1: groove anchor (was 0.35 jazz-biased; research: Large & Jones entrainment)
      needs_surprise:   { gateW: 0.9,  tempBias: 0.2,   densityBias: 0.0,   bpmBias:  0.02 },  // slight push
      needs_resolution: { gateW: 0.95, tempBias: -0.15, densityBias: -0.05, bpmBias:  0.0  }   // v2.6.1: bpmBias 0 — resolution is harmonic, not temporal
    },
    soloist: {
      needs_stability:  { gateW: 0.8,  tempBias: -0.1,  densityBias: -0.05, bpmBias:  0.0  },  // present but calm (was 0.4)
      needs_energy:     { gateW: 1.3,  tempBias: 0.25,  densityBias: 0.1,   bpmBias:  0.05 },  // expressive
      needs_space:      { gateW: 0.45, tempBias: -0.15, densityBias: -0.1,  bpmBias: -0.03 },  // pull back — Miles Davis silence principle
      needs_surprise:   { gateW: 1.15, tempBias: 0.35,  densityBias: 0.05,  bpmBias:  0.04 },  // v2.4: responds to surprise, doesn't drive it (was 1.4; research: lead drives, soloist responds)
      needs_resolution: { gateW: 0.7,  tempBias: -0.2,  densityBias: -0.05, bpmBias:  0.0  }   // v2.6.1: bpmBias 0 — resolution is harmonic, not temporal
    },
    // Percussion: temporal anchor, structural signpost.
    // High gate across all states — percussion provides continuity.
    // Pattern complexity changes, not on/off gating.
    percussion: {
      needs_stability:  { gateW: 1.3,  tempBias: -0.1,  densityBias: 0.1,   bpmBias:  0.0  },  // steady — maintain tempo
      needs_energy:     { gateW: 1.4,  tempBias: 0.1,   densityBias: 0.15,  bpmBias:  0.02 },  // push
      needs_space:      { gateW: 0.8,  tempBias: -0.1,  densityBias: -0.1,  bpmBias: -0.02 },  // lighter — genre-dependent (motorik=high, jazz=low via percMuteResist)
      needs_surprise:   { gateW: 0.9,  tempBias: 0.15,  densityBias: 0,     bpmBias:  0.01 },  // steady
      needs_resolution: { gateW: 1.0,  tempBias: -0.1,  densityBias: 0.05,  bpmBias:  0.0  }   // v2.6.1: bpmBias 0 — resolution is harmonic, not temporal
    },
    // Lead: Dynamic driver. Pushes BUILD→PEAK.
    // Highest gate weight during energy (1.5). Quiet during stability.
    // v2.4: raised surprise (1.1→1.35) and resolution (0.9→1.05) per research:
    //   lead drives rising action (surprise/excitement) and sustains melodic close.
    lead: {
      needs_stability:  { gateW: 0.6,  tempBias: -0.1,  densityBias: 0.0,   bpmBias:  0.0  },  // quiet when stable
      needs_energy:     { gateW: 1.5,  tempBias: 0.30,  densityBias: 0.15,  bpmBias:  0.04 },  // DRIVES energy up (highest gateW)
      needs_space:      { gateW: 0.3,  tempBias: -0.2,  densityBias: -0.15, bpmBias: -0.03 },  // backs off hard
      needs_surprise:   { gateW: 1.35, tempBias: 0.20,  densityBias: 0.05,  bpmBias:  0.02 },  // v2.4: drives rising action (was 1.1; research: lead = dynamic driver)
      needs_resolution: { gateW: 1.05, tempBias: -0.15, densityBias: 0.0,   bpmBias:  0.0  }   // v2.6.1: bpmBias 0 — resolution is harmonic, not temporal
    }
  };

  function _deriveParams(voice) {
    var b = voices[voice].belief;
    var h = _entropy(b);
    var hNorm = h / H_MAX;
    var dominant = _maxBelief(b);
    var energy = voices[voice].energy;
    var roleMap = ROLE_RESPONSE[voice] || ROLE_RESPONSE.rhythm;

    // ── Gate probability ──
    // Weighted sum of gate weights across beliefs, modulated by energy and phase
    var gateWeightedSum = 0;
    for (var i = 0; i < N_STATES; i++) {
      gateWeightedSum += b[i] * roleMap[NEEDS[i]].gateW;
    }
    // Concentration from dominant belief (how clear is the need?)
    var concentration = dominant.value;
    // Use a gentler sigmoid slope (3 instead of 5) so low-concentration states
    // (like soloist's flat prior at 0.20) still get reasonable gate probability.
    // Old: sigmoid((0.20 - 0.25) * 5) = 0.438. New: sigmoid((0.20 - 0.15) * 3) = 0.562
    var gateProbRaw = _sigmoid((concentration - 0.15) * 3) * gateWeightedSum;

    // Energy modulation
    var gateProb = gateProbRaw * Math.min(1.0, energy * 1.5);

    // Phase coupling modulation (Kuramoto turn-taking)
    if (typeof PhaseCoupling !== 'undefined') {
      var phaseReadiness = PhaseCoupling.getReadiness(voice);
      // Reduce phase suppression: 0.7 + 0.3*readiness instead of 0.6 + 0.4*readiness
      // This ensures voices at trough phase still have ~70% of their base probability
      // instead of ~60%, preventing PhaseCoupling from compounding with low concentration.
      gateProb *= (0.7 + 0.3 * phaseReadiness);
    }

    // Floor: ensure every voice has at least 15% gate probability per tick.
    // Without this, compounding low-concentration * low-energy * low-readiness
    // can drive the gate to near-zero, creating a deadlock where voices never
    // start and therefore never generate the observations needed to improve beliefs.
    gateProb = Math.max(0.15, Math.min(1, gateProb));

    // ── Temperature ──
    // Base from entropy (uncertain → explore), plus role-weighted need biases
    var tempBase = 0.4 + hNorm * 0.7;
    var tempBias = 0;
    for (var i = 0; i < N_STATES; i++) {
      tempBias += b[i] * roleMap[NEEDS[i]].tempBias;
    }
    var temperature = Math.max(0.3, Math.min(1.5, tempBase + tempBias));

    // ── Phrase length ──
    // stability + resolution → longer (anchor/resolve). space + surprise → shorter (nimble).
    // ── Time grain (v2.1) ──
    // Absolute ms breathing rate, blended from beliefs. Independent of BPM.
    var grain = _getTimeGrain(voice);
    var beatMs = 60000 / Math.max(30, (typeof TempoEngine !== 'undefined') ?
      TempoEngine.getEffectiveBPM() : 120);
    var grainBeats = grain / beatMs;

    // ── Phrase length ──
    // Time-grain-derived: 4 beats is the neutral reference point.
    // stability grain (5s @ 120bpm = 10 beats) → lengthMult ~2.0
    // surprise grain (1.2s @ 120bpm = 2.4 beats) → lengthMult ~0.6
    var lengthMult = Math.max(0.3, Math.min(2.0, grainBeats / 4));

    // ── Minimum phrase gap (absolute ms) ──
    // Groove roles (bass/rhythm) use shorter gaps to maintain pulse continuity.
    // Melodic voices use standard 30% for structural breathing.
    // Bass/rhythm at 15%: stability=750ms, energy=270ms (tight grooves).
    // Others at 30%: stability=1500ms, energy=600ms (melodic phrasing).
    var _gapMult = (voice === 'bass' || voice === 'rhythm') ? 0.15 : 0.3;
    var minPhraseGapMs = grain * _gapMult;

    // ── BPM bias (v2.1) ──
    // Per-role tempo preference: fractional period change.
    // Positive = wants faster, negative = wants slower.
    // Fed into PhaseCoupling tempo oscillators.
    var bpmBias = 0;
    for (var i = 0; i < N_STATES; i++) {
      bpmBias += b[i] * (roleMap[NEEDS[i]].bpmBias || 0);
    }

    // ── Density ──
    // Role-weighted sum of density biases, modulated by energy
    var density = 0;
    for (var i = 0; i < N_STATES; i++) {
      density += b[i] * roleMap[NEEDS[i]].densityBias;
    }
    density -= (1 - energy) * 0.1;
    density = Math.max(-0.3, Math.min(0.3, density));

    // ── Density budget (time-grain-aware) ──
    // Events allowed per grain window, converted to notes/sec ceiling
    var sectionDensity = 0.5;
    if (typeof SectionTracker !== 'undefined') {
      try { sectionDensity = SectionTracker.getState().density || 0.5; } catch (e) {}
    }
    var eventsPerGrain = 2 + sectionDensity * 6;
    var densityBudgetNps = eventsPerGrain / (grain / 1000);

    // ── Temporal urge modulation (v2.2) ──
    // Real-time awareness adjusts existing parameters:
    var urges = getTemporalUrges(voice);

    // maturity: suppress adventurousness early in session
    // At maturity=0 (just started): temperature halved, positive bpmBias suppressed
    // At maturity=1 (30s+): no effect
    // This lets the count-in voice establish tempo before anyone pushes it around.
    // v3.5.1: Asymmetric bpmBias attenuation by maturity.
    // v3.17.0: Negative bias now attenuated to 50% floor during cold start (was
    // unattenuated). At maturity=0: negative bpmBias halved, positive suppressed.
    // At maturity=1: both at full strength. The 50% floor preserves the "safety
    // brake" principle (deceleration is never fully suppressed) while preventing
    // the cold-start drift cascade where space-driven bpmBias (-0.03) overwhelmed
    // anchor resistance (0.005 for soloist) from the first tick.
    temperature = temperature * (0.5 + 0.5 * urges.maturity);
    if (bpmBias > 0) {
      bpmBias = bpmBias * urges.maturity;  // positive (accelerate) waits
    } else {
      bpmBias = bpmBias * (0.5 + 0.5 * urges.maturity);  // negative floors at 50%
    }

    // playUrge: after prolonged silence, boost gate probability
    // Adds up to +0.3 gate after 8 bars of silence
    gateProb = Math.min(1, gateProb + urges.playUrge * 0.3);

    // modeUrge: after 32 bars on same mode, push temperature up (explore new patterns)
    // Adds up to +0.3 temperature bias
    temperature = Math.min(1.5, temperature + urges.modeUrge * 0.3);

    // ── Dialogue stance modulation (v2.2 Layer 3e) ──
    // DialogueEngine models the musical conversation (initiative × agreement).
    // Its outputs modulate the same params that belief and urges do:
    //   initiative > baseline → explore (temperature up, density up)
    //   agreement below baseline → chromatic tension (temperature up)
    //   lead stance → boost gate (play more)
    var dialogueTempMod = 0;
    var dialogueDensityMod = 0;
    var dialogueGateMod = 0;
    if (typeof DialogueEngine !== 'undefined') {
      try {
        dialogueTempMod = DialogueEngine.getTemperatureModifier(voice);
        dialogueDensityMod = DialogueEngine.getDensityModifier(voice);
        // Lead stance boosts gate; follow suppresses slightly
        var stance = DialogueEngine.getStance(voice);
        if (stance.initiative > 0.6) dialogueGateMod = 0.15;
        else if (stance.initiative < 0.2) dialogueGateMod = -0.05;
      } catch (e) {}
    }
    temperature = Math.max(0.3, Math.min(1.5, temperature + dialogueTempMod));
    density = Math.max(-0.3, Math.min(0.3, density + dialogueDensityMod));
    gateProb = Math.max(0.15, Math.min(1, gateProb + dialogueGateMod));

    // v8 Feature F: Ensemble coherence modulation (Dotov 2022, Heggli 2019)
    // High r (locked in) → adventurous: longer phrases, wider leaps OK.
    // Low r (drifting) → conservative: shorter phrases, stick to roots.
    if (typeof PhaseCoupling !== 'undefined' && PhaseCoupling.getOrderParameter) {
      var _r = PhaseCoupling.getOrderParameter();
      // Temperature: ±0.1 (high r = adventurous, low r = conservative)
      temperature = Math.max(0.3, Math.min(1.5, temperature + (_r - 0.5) * 0.2));
      // Phrase length: 0.85x at r=0, 1.15x at r=1
      lengthMult *= 0.85 + 0.3 * _r;
    }

    return {
      gateProb: gateProb,
      temperature: temperature,
      lengthMult: lengthMult,
      density: density,
      bpmBias: bpmBias,
      entropy: h,
      entropyNorm: hNorm,
      dominantIntent: NEEDS[dominant.index],
      dominantProb: dominant.value,
      energy: energy,
      // v2.1 time constants
      timeGrain: grain,
      timeGrainBeats: grainBeats,
      minPhraseGapMs: minPhraseGapMs,
      densityBudgetNps: densityBudgetNps,
      // v2.2 temporal urges (for research/debugging)
      modeUrge: urges.modeUrge,
      playUrge: urges.playUrge,
      maturity: urges.maturity,
      // v2.2 dialogue stance (for research/debugging)
      dialogueTempMod: dialogueTempMod,
      dialogueDensityMod: dialogueDensityMod,
      dialogueGateMod: dialogueGateMod
    };
  }

  function _sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  // ═══════════════════════════════════════
  // GATHER OBSERVATIONS (ensemble-wide)
  // ═══════════════════════════════════════

  // Last observation vector — exposed for ResearchState logging
  var _lastObs = null;       // legacy global (kept for backward compat)
  var _lastNormObs = null;   // legacy global
  // v2.2: per-voice observation storage
  var _lastObsPerVoice = {};
  var _lastNormObsPerVoice = {};

  // v3.8.0: Per-voice observations. When voice is provided, 5 channels use
  // per-voice data (notesPerBeat, intervalTension, phraseProgress,
  // repetitionNovelty, onsetRegularity). 3 channels are global
  // (harmonicRhythm, harmonicDrift, ensembleCoherence). 4 discrete stay global.
  function _gatherObservations(voice, refreshMedium, refreshSlow) {
    // Reuse pre-allocated object from pool (zero GC pressure)
    var obs = _obsPool[voice || '_global'];
    // Reset to defaults (faster than creating new object)
    obs.notesPerBeat = 0;
    obs.intervalTension = 0;
    obs.phraseProgress = 0.5;
    obs.harmonicRhythm = 0;
    obs.harmonicDrift = 0;
    obs.repetitionNovelty = 0.5;
    obs.onsetRegularity = 0.5;
    obs.ensembleCoherence = 0.5;
    obs.densityTrend = 0;
    obs.coherenceTrend = 0;
    obs.energyTrend = 0;
    obs.arcPhaseCompat = 0.3;
    obs.ensembleDensityDelta = 0.5;
    obs.rhythmSectionCohere = 0.5;
    obs.melodicEntropy = 0.5;
    obs.sectionTransition = 0.0;  // v8.16.0 Phase D: STABLE = 0.0
    obs.activeVoiceCount = 0;
    obs.humanPresence = 0;
    obs.sectionState = 'STABLE';
    obs.resolutionUrgency = 0;

    var bpm = 120;
    if (typeof TempoEngine !== 'undefined' && typeof TempoEngine.getEffectiveBPM === 'function') {
      bpm = Math.max(30, TempoEngine.getEffectiveBPM());
    }
    var beatsPerSec = bpm / 60;

    // ── ContextIntegrator ──
    if (typeof ContextIntegrator !== 'undefined') {
      try {
        var snap = ContextIntegrator.getEnsembleSnapshot();
        obs.activeVoiceCount = snap.activeVoiceCount || 0;

        if (voice) {
          // ── PER-VOICE channels ──
          // v8.7.1: notesPerBeat — observe PEER density (ensemble minus self).
          // Previously read own density → circular: silence→needs_space→more silence.
          // Now asks "how active is the ensemble around me?" — external signal.
          var _peerDensTotal = 0, _peerDensCount = 0;
          var _allVoices = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
          for (var _pdi = 0; _pdi < _allVoices.length; _pdi++) {
            if (_allVoices[_pdi] === voice) continue;
            var _pd = ContextIntegrator.getVoiceDensity(_allVoices[_pdi]);
            if (_pd !== null && _pd !== undefined) { _peerDensTotal += _pd; _peerDensCount++; }
          }
          var peerDensity = _peerDensCount > 0 ? _peerDensTotal / _peerDensCount : 0.2;

          obs.notesPerBeat = peerDensity / beatsPerSec;

          // intervalTension: this voice's tension vs active peers only
          // Skip silent peers (tension=0) to avoid diluting real tension
          var peers = ['bass', 'rhythm', 'soloist', 'percussion'];
          var tensionSum = 0;
          var tensionCount = 0;
          for (var pi = 0; pi < peers.length; pi++) {
            if (peers[pi] === voice) continue;
            var pt = ContextIntegrator.getPairwiseTension(voice, peers[pi]);
            if (pt !== null && pt !== undefined && pt > 0) {
              tensionSum += pt;
              tensionCount++;
            }
          }
          obs.intervalTension = tensionCount > 0 ? tensionSum / tensionCount : 0;

          // v3.17.0: MEDIUM BANK (200ms) — phraseProgress, repetitionNovelty, onsetRegularity
          // These channels track metric/phrase-level phenomena (1-8s time constants).
          // Caching prevents fast-tick density from drowning their influence.
          // v8.7.1: repetitionNovelty + onsetRegularity now read PEER averages (not self).
          //   phraseProgress kept as self — scheduling info, not circular.
          if (refreshMedium) {
            var _mc = {};
            try {
              var vs = ContextIntegrator.getVoiceState(voice);
              _mc.phraseProgress = (vs && vs.progress !== undefined) ? vs.progress : 0.5;
            } catch (e) { _mc.phraseProgress = 0.5; }
            // Peer novelty: "how varied are the others?" (not "how varied am I?")
            var _rnTotal = 0, _rnCount = 0;
            for (var _rni = 0; _rni < _allVoices.length; _rni++) {
              if (_allVoices[_rni] === voice || _allVoices[_rni] === 'percussion') continue;
              var _rnv = ContextIntegrator.getRepetitionNoveltyPerVoice(_allVoices[_rni]);
              if (_rnv !== null && _rnv !== undefined) { _rnTotal += _rnv; _rnCount++; }
            }
            _mc.repetitionNovelty = _rnCount > 0 ? _rnTotal / _rnCount : 0.5;
            // Peer regularity: "how tight is the ensemble?" (not "how regular am I?")
            var _orTotal = 0, _orCount = 0;
            for (var _ori = 0; _ori < _allVoices.length; _ori++) {
              if (_allVoices[_ori] === voice) continue;
              var _orv = ContextIntegrator.getOnsetRegularityPerVoice(_allVoices[_ori]);
              if (_orv !== null && _orv !== undefined) { _orTotal += _orv; _orCount++; }
            }
            _mc.onsetRegularity = _orCount > 0 ? _orTotal / _orCount : 0.5;
            _cachedMediumObs[voice] = _mc;
          }
          var mcv = _cachedMediumObs[voice];
          obs.phraseProgress = mcv ? mcv.phraseProgress : 0.5;
          obs.repetitionNovelty = mcv ? mcv.repetitionNovelty : 0.5;
          obs.onsetRegularity = mcv ? mcv.onsetRegularity : 0.5;

          // v3.17.0: Percussion-specific medium-bank channels
          // Replace dead pitch channels (intervalTension, harmonicRhythm, harmonicDrift)
          // with rhythm-aware signals that give percussion meaningful observation data.
          if (voice === 'percussion' && refreshMedium) {
            var _pc = _cachedMediumObs[voice] || {};

            // arcPhaseCompat: map current arc phase to 0-1 activity expectation
            _pc.arcPhaseCompat = 0.3; // default neutral
            if (typeof NarrativeArc !== 'undefined') {
              var percArc = NarrativeArc.getArc('percussion');
              var phaseMap = { establish: 0.15, develop: 0.45, climax: 0.85, resolve: 0.25, transition: 0.3 };
              _pc.arcPhaseCompat = phaseMap[percArc.phase] || 0.3;
            }

            // ensembleDensityDelta: percussion density vs ensemble average (mapped to 0-1 around 0.5)
            _pc.ensembleDensityDelta = 0.5; // default: matched
            var percDens = ContextIntegrator.getVoiceDensity('percussion') || 0;
            var ensTotal = 0, ensCount = 0;
            var dVoices = ['bass', 'rhythm', 'soloist', 'lead'];
            for (var dv = 0; dv < dVoices.length; dv++) {
              var vd = ContextIntegrator.getVoiceDensity(dVoices[dv]);
              if (vd !== null && vd !== undefined) { ensTotal += vd; ensCount++; }
            }
            var ensAvg = ensCount > 0 ? ensTotal / ensCount : percDens;
            // Map delta to 0-1: 0.5 = matched, 0 = much sparser, 1 = much denser
            var delta = ensAvg > 0.01 ? percDens / ensAvg : 1.0;
            _pc.ensembleDensityDelta = Math.max(0, Math.min(1, 0.5 * delta));

            // rhythmSectionCohere: onset alignment between percussion and bass+rhythm
            // Uses existing onsetRegularity as proxy, blended with ensemble coherence
            _pc.rhythmSectionCohere = 0.5; // default
            var bassReg = ContextIntegrator.getOnsetRegularityPerVoice('bass');
            var rhythmReg = ContextIntegrator.getOnsetRegularityPerVoice('rhythm');
            var percReg = ContextIntegrator.getOnsetRegularityPerVoice('percussion');
            // Cross-correlation proxy: geometric mean of regularity values
            var bassCohere = Math.sqrt(Math.max(0, percReg * bassReg));
            var rhythmCohere = Math.sqrt(Math.max(0, percReg * rhythmReg));
            _pc.rhythmSectionCohere = (bassCohere * 0.5 + rhythmCohere * 0.5);

            _cachedMediumObs[voice] = _pc;
          }
          // Read percussion-specific channels from cache
          if (voice === 'percussion') {
            var _pcc = _cachedMediumObs[voice];
            obs.arcPhaseCompat = _pcc ? _pcc.arcPhaseCompat : 0.3;
            obs.ensembleDensityDelta = _pcc ? _pcc.ensembleDensityDelta : 0.5;
            obs.rhythmSectionCohere = _pcc ? _pcc.rhythmSectionCohere : 0.5;
          }
        } else {
          // ── GLOBAL fallback (backward compat) ──
          var rawDensity = snap.totalDensity || 0;
          obs.notesPerBeat = rawDensity / beatsPerSec;
          obs.intervalTension = snap.intervalTension || 0;

          var progTotal = 0, progCount = 0;
          var vnames = ['bass', 'rhythm', 'soloist'];
          for (var vi = 0; vi < vnames.length; vi++) {
            try {
              var vst = ContextIntegrator.getVoiceState(vnames[vi]);
              if (vst && vst.progress !== undefined) { progTotal += vst.progress; progCount++; }
            } catch (e) {}
          }
          obs.phraseProgress = progCount > 0 ? progTotal / progCount : 0.5;

          obs.repetitionNovelty = ContextIntegrator.getRepetitionNovelty();
          obs.onsetRegularity = ContextIntegrator.getOnsetRegularity();
        }

        // ── GLOBAL channels (same for all voices) ──
        // v3.17.0: harmonicRhythm on MEDIUM bank (200ms) — chord change rate
        if (refreshMedium) {
          _cachedGlobalMedium.harmonicRhythm = ContextIntegrator.getHarmonicRhythm();
        }
        obs.harmonicRhythm = _cachedGlobalMedium.harmonicRhythm;
      } catch (e) {}
    }

    // ── v3.17.0: SLOW BANK (500ms) — harmonicDrift, ensembleCoherence ──
    // These channels track structural phenomena (5s+ time constants).
    // Key stability (Krumhansl 1990) and entrainment (Large & Jones 1999) evolve slowly.
    if (refreshSlow) {
      if (typeof KeyBelief !== 'undefined') {
        _cachedSlowObs.harmonicDrift = KeyBelief.getDivergence();
      }
      if (typeof PhaseCoupling !== 'undefined') {
        _cachedSlowObs.ensembleCoherence = PhaseCoupling.getOrderParameter();
      }
      // v6 7E: Melodic entropy from MelodicExpectancy (IDyOM-inspired)
      // v8.7.1: Per-voice — average entropy of PEERS only (exclude self).
      // Previously averaged all 4 pitched voices including self → circular:
      // predictable voice observes low self-entropy → believes stability → repeats → confirms.
      if (typeof MelodicExpectancy !== 'undefined') {
        var _meVoices = ['bass', 'rhythm', 'soloist', 'lead'];
        // Store per-voice peer entropy (each voice sees different average)
        for (var _mvi = 0; _mvi < _meVoices.length; _mvi++) {
          var _meV = _meVoices[_mvi];
          var _meSum = 0, _meCount = 0;
          for (var _mei = 0; _mei < _meVoices.length; _mei++) {
            if (_meVoices[_mei] === _meV) continue; // exclude self
            var _meE = MelodicExpectancy.getEntropy(_meVoices[_mei]);
            if (_meE > 0) { _meSum += _meE; _meCount++; }
          }
          if (_meCount > 0) {
            if (!_cachedSlowObs._perVoiceME) _cachedSlowObs._perVoiceME = {};
            _cachedSlowObs._perVoiceME[_meV] = Math.min(1.0, (_meSum / _meCount) / 3.58);
          }
        }
        // Global fallback (for non-voice queries)
        _cachedSlowObs.melodicEntropy = 0.5;
        if (_cachedSlowObs._perVoiceME) {
          var _gmeS = 0, _gmeC = 0;
          for (var _gk in _cachedSlowObs._perVoiceME) { _gmeS += _cachedSlowObs._perVoiceME[_gk]; _gmeC++; }
          if (_gmeC > 0) _cachedSlowObs.melodicEntropy = _gmeS / _gmeC;
        }
      }

      // v8.15.0: Peer-based trend observations — record current values into ring buffer
      // and compute trends. All signals are peer-observed, not self-referential.
      var _tbIdx = _trendBuf.idx;

      // densityTrend: peer density average (already computed for notesPerBeat in fast bank)
      // Use ensemble snapshot totalDensity as proxy — shared, not self-referential
      var _tdSnap = null;
      if (typeof ContextIntegrator !== 'undefined') {
        try { _tdSnap = ContextIntegrator.getEnsembleSnapshot(); } catch (e) {}
      }
      _trendBuf.density[_tbIdx] = _tdSnap ? Math.min(1.0, _tdSnap.totalDensity / 10.0) : 0.2;

      // energyTrend: SectionTracker smoothed energy (density + pitch range + surprise + harmonic distance)
      var _teEnergy = 0.3;
      if (typeof SectionTracker !== 'undefined') {
        try { var _teSt = SectionTracker.getState(); _teEnergy = _teSt.energy || 0.3; } catch (e) {}
      }
      _trendBuf.energy[_tbIdx] = _teEnergy;

      // coherenceTrend: Kuramoto order parameter (already read above into _cachedSlowObs)
      _trendBuf.coherence[_tbIdx] = _cachedSlowObs.ensembleCoherence;

      _trendBuf.idx = (_tbIdx + 1) % TREND_WINDOW;
      _trendBuf.count++;

      // Compute trends from ring buffers
      _cachedSlowObs._densityTrend = _computeTrend(_trendBuf.density, _trendBuf.idx, _trendBuf.count);
      _cachedSlowObs._energyTrend = _computeTrend(_trendBuf.energy, _trendBuf.idx, _trendBuf.count);
      _cachedSlowObs._coherenceTrend = _computeTrend(_trendBuf.coherence, _trendBuf.idx, _trendBuf.count);
    }
    obs.harmonicDrift = _cachedSlowObs.harmonicDrift;
    obs.ensembleCoherence = _cachedSlowObs.ensembleCoherence;
    // v8.7.1: Per-voice peer entropy (each voice sees peers' entropy, not its own)
    if (voice && _cachedSlowObs._perVoiceME && _cachedSlowObs._perVoiceME[voice] !== undefined) {
      obs.melodicEntropy = _cachedSlowObs._perVoiceME[voice];
    } else {
      obs.melodicEntropy = _cachedSlowObs.melodicEntropy;
    }

    // ── Human presence — from ContextIntegrator density (v3.8.2: no OwnershipDetector) ──
    // Human density > 0 means human is playing. Scale to 0-1 (2 nps = full presence).
    // Decays naturally as ContextIntegrator's rolling window expires old timestamps.
    obs.humanPresence = 0;
    if (typeof ContextIntegrator !== 'undefined') {
      try {
        var humanDens = ContextIntegrator.getVoiceDensity('human');
        obs.humanPresence = Math.min(1.0, humanDens / 2.0);
      } catch (e) {}
    }

    // ── v8.15.0: Peer-based trend observations ──
    // Replaced self-referential belief trends (disabled v8.7.0) with peer-observed signals:
    // densityTrend: ensemble density trend over 5s (ContextIntegrator totalDensity)
    // energyTrend: ensemble energy trend over 5s (SectionTracker smoothed energy)
    // coherenceTrend: ensemble coherence trend over 5s (PhaseCoupling order parameter)
    obs.densityTrend = _cachedSlowObs._densityTrend || 0;
    obs.coherenceTrend = _cachedSlowObs._coherenceTrend || 0;
    obs.energyTrend = _cachedSlowObs._energyTrend || 0;

    // ── Section state + resolution urgency — global ──
    if (typeof SectionTracker !== 'undefined') {
      try {
        var ss = SectionTracker.getState();
        obs.sectionState = ss.state || 'STABLE';
        // v8.16.0 Phase D: Continuous section encoding for Gaussian channel
        var _secMap = { 'STABLE': 0.0, 'BUILD': 0.33, 'TRANSITION': 0.5, 'PEAK': 0.67, 'RELEASE': 1.0 };
        obs.sectionTransition = _secMap[obs.sectionState] || 0.0;
        obs.resolutionUrgency = ss.resolutionUrgency || 0;
      } catch (e) {}
    }

    // Store for debugging
    if (voice) {
      _lastObsPerVoice[voice] = obs;
    } else {
      _lastObs = obs;
    }
    return obs;
  }

  // ═══════════════════════════════════════
  // AUDIT: Old human-intent model (parallel comparison)
  // ═══════════════════════════════════════

  var _AUDIT_ENABLED = false;  // v2.2: disabled — served its purpose during v1.3→v2 transition, saves CPU before per-voice 4x observation cost
  var _auditCount = 0;
  var _auditDisagree = 0;

  // Simplified old observation model for comparison
  function _auditOldGate(voice) {
    // Approximate old VP1+VP2 gate using the same energy + a simple heuristic
    var energy = voices[voice].energy;
    // Old system: gate ≈ 0.3 + energy*0.4 (rough approximation)
    var oldGate = 0.3 + energy * 0.4;
    if (typeof PhaseCoupling !== 'undefined') {
      oldGate *= (0.6 + 0.4 * PhaseCoupling.getReadiness(voice));
    }
    return Math.random() < oldGate;
  }

  // ═══════════════════════════════════════
  // PUBLIC API (unchanged from v1.3)
  // ═══════════════════════════════════════

  // ── updateBeliefs(dt) ──
  // v3.8.0: Per-voice observations + per-role sensitivity (ROLE_SENSITIVITY).
  // Per-voice: density, tension, phrase progress, novelty, regularity.
  // Global: harmonicRhythm, harmonicDrift, ensembleCoherence, section state.
  // Beliefs diverge both from different observations AND different channel weights.
  function updateBeliefs(dt) {
    var voiceNames = ['bass', 'rhythm', 'soloist', 'percussion', 'lead'];
    var now = Date.now();

    // v3.17.0: Tiered observation banks — check which tiers need refresh this tick
    var refreshMedium = (now - _lastMediumRefreshMs) >= _MEDIUM_INTERVAL_MS;
    var refreshSlow = (now - _lastSlowRefreshMs) >= _SLOW_INTERVAL_MS;
    if (refreshMedium) _lastMediumRefreshMs = now;
    if (refreshSlow) _lastSlowRefreshMs = now;

    for (var i = 0; i < voiceNames.length; i++) {
      var v = voiceNames[i];
      var rawObs = _gatherObservations(v, refreshMedium, refreshSlow);  // tiered per-voice observations
      _normObsVoiceName = v;                           // set pool key for _normalizeObs
      var obs = _normalizeObs(rawObs, true);          // per-voice normalization (notesPerBeat / 2)
      _lastNormObsPerVoice[v] = obs;                  // store per-voice for debugging
      _updateBelief(v, obs, now);
      _sampleHistory(v, now);                          // v5 Phase 1: belief history sampling
    }
    // Keep legacy global obs for backward compat (getLastObservations with no arg)
    _lastNormObs = _lastNormObsPerVoice.bass || null;
    _lastObs = _lastObsPerVoice.bass || null;
  }

  // ── updateEnergy(voice, dt, isActive) ──
  function updateEnergy(voice, dt, isActive) {
    var v = voices[voice];
    if (!v) return;

    var ep = ENERGY_PARAMS[voice];
    var beatMs = 60000 / Math.max(30, (typeof TempoEngine !== 'undefined') ?
      TempoEngine.getEffectiveBPM() : 120);
    var dtBeats = dt / beatMs;

    if (isActive) {
      v.energy -= ep.fatigueRate * dtBeats;
      v.isActive = true;
    } else {
      v.energy += ep.recoveryRate * dtBeats;
      v.isActive = false;
    }
    v.energy = Math.max(0, Math.min(1, v.energy));
  }

  // v2.1: Genre-configurable cold-start stagger.
  // Entry order reflects how real ensembles in each genre begin playing:
  //   Electronic/Berlin: sequencer(bass) first → percussion reinforces → layers in
  //   Rock/Pop: drums count in → bass locks → layers in
  //   Jazz: drums+bass together → comping → melody
  // Cold-start voice staggering — psychoacoustic profiles for ensemble genesis.
  // _default: Balanced entry — rhythm section anchors, melody layers in.
  //   Pressing 1999: ensemble coordination requires ~1s anticipation window.
  //   London 2012: metric pulse (bass+perc) should establish before melody enters.
  var COLD_START_ORDERS = {
    _default:    { bass: 0, percussion: 500, rhythm: 2000, lead: 3000, soloist: 4000 },
    electronic:  { bass: 0, percussion: 1500, rhythm: 3000, lead: 3500, soloist: 4500 },
    rock:        { percussion: 0, bass: 1000, rhythm: 2500, lead: 3000, soloist: 4000 },
    jazz:        { percussion: 0, bass: 0, rhythm: 2000, lead: 2500, soloist: 3500 }
  };
  // Map genre names to cold-start profiles
  var GENRE_TO_START = {
    electronic_td:'electronic', electronic_kw:'electronic', electronic_jmj:'electronic',
    electronic_mg:'electronic', electronic_no:'electronic', berlin_school:'electronic',
    electronic:'electronic',
    rock:'rock', pop:'rock', blues:'rock',
    jazz:'jazz', classical:'jazz'
  };
  function _getColdStartDelays() {
    var genre = (typeof SharedState !== 'undefined') ? SharedState.genre : '';
    var profile = GENRE_TO_START[genre] || '_default';
    return COLD_START_ORDERS[profile];
  }
  var COLD_START_DELAY_MS = _getColdStartDelays();
  var _autoStartTime = 0;
  var _coldStartActive = true;

  function _initColdStart() {
    _autoStartTime = Date.now();
    _coldStartActive = true;
    // Always reset session start on Auto press — maturity ramp starts from NOW
    _sessionStartTime = _autoStartTime;
    // Re-read genre at start time (genre may have changed since module load)
    COLD_START_DELAY_MS = _getColdStartDelays();
  }

  // ── shouldPlay(voice) ──
  function shouldPlay(voice) {
    // Cold-start stagger: suppress voice until its delay has elapsed
    if (_coldStartActive) {
      var elapsed = Date.now() - _autoStartTime;
      var delay = COLD_START_DELAY_MS[voice] || 0;
      if (elapsed < delay) {
        return { allowed: false, params: _deriveParams(voice) };
      }
      // Check if all voices have passed their delay
      if (elapsed > 5000) _coldStartActive = false;
    }

    var params = _deriveParams(voice);
    var roll = Math.random();
    var allowed = roll < params.gateProb;

    // Audit comparison
    if (_AUDIT_ENABLED) {
      _auditCount++;
      var oldAllowed = _auditOldGate(voice);
      if (oldAllowed !== allowed) {
        _auditDisagree++;
        if (_auditCount % 200 === 0) {
          console.warn('[BELIEF AUDIT] ' + voice + ' disagreement rate: ' +
            Math.round(_auditDisagree / _auditCount * 100) + '% (' +
            _auditDisagree + '/' + _auditCount + ') dominant: ' +
            NEEDS[_maxBelief(voices[voice].belief).index]);
        }
      }
    }

    return {
      allowed: allowed,
      params: params
    };
  }

  // ── getParams(voice) ──
  function getParams(voice) {
    return _deriveParams(voice);
  }

  // ── getBeliefVelocity(voice) — v2.7.0 ──
  // Returns per-state rate of change (delta since last update).
  // Positive = belief is rising, negative = falling.
  // Used by L2 melodic intent to distinguish "moving toward energy" from "stuck at energy".
  function getBeliefVelocity(voice) {
    var v = voices[voice];
    if (!v) return null;
    var result = {};
    for (var i = 0; i < N_STATES; i++) {
      result[NEEDS[i]] = +(v.belief[i] - v._prevBelief[i]).toFixed(4);
    }
    return result;
  }

  // ── getBelief(voice) ──
  function getBelief(voice) {
    var b = voices[voice].belief;
    var result = {};
    for (var i = 0; i < N_STATES; i++) {
      result[NEEDS[i]] = b[i];
    }
    result._entropy = _entropy(b);
    result._energy = voices[voice].energy;
    return result;
  }

  // ── reset() ──
  function reset() {
    var voiceNames = ['bass', 'rhythm', 'soloist', 'percussion', 'lead'];
    var initialEnergy = { bass: 0.8, rhythm: 0.7, soloist: 0.6, percussion: 0.7, lead: 0.7 };
    for (var i = 0; i < voiceNames.length; i++) {
      var vn = voiceNames[i];
      voices[vn].belief = INITIAL_BELIEFS[vn].slice();
      voices[vn]._prevBelief = INITIAL_BELIEFS[vn].slice();
      voices[vn].energy = initialEnergy[vn];
      voices[vn].isActive = false;
      // Reset temporal awareness
      voices[vn].lastNoteTime = 0;
      voices[vn].lastModeChange = 0;
      voices[vn].currentMode = null;
      voices[vn].dominantSince = 0;
      voices[vn]._spaceDomSec = 0;
      // v3.17.0: Reset stability hold tracking
      voices[vn]._dominantIdx = -1;
      voices[vn]._dominantEntryMs = 0;
    }
    _auditCount = 0;
    _auditDisagree = 0;
    _sessionStartTime = Date.now();
    // v3.17.0: Reset tiered observation bank caches
    _lastMediumRefreshMs = 0;
    _lastSlowRefreshMs = 0;
    _cachedMediumObs = {};
    _cachedGlobalMedium = { harmonicRhythm: 0 };
    _cachedSlowObs = { harmonicDrift: 0, ensembleCoherence: 0.5 };
    _initHistory();  // v5 Phase 1: clear belief history on reset
    // surprise delta is stateless (computed from SharedState.getRecentSurprises)
    _initColdStart();
  }

  function getLastObservations(voice) {
    // v2.2: accepts optional voice param for per-voice observations
    var normObs = voice ? _lastNormObsPerVoice[voice] : _lastNormObs;
    var rawObs = voice ? _lastObsPerVoice[voice] : _lastObs;
    if (!normObs) return rawObs;
    var result = {};
    for (var k in normObs) result[k] = normObs[k];
    if (rawObs) {
      result._raw_notesPerBeat = rawObs.notesPerBeat;
      result._raw_harmonicDrift = rawObs.harmonicDrift;
      result._raw_harmonicRhythm = rawObs.harmonicRhythm;
    }
    return result;
  }

  // ═══════════════════════════════════════
  // TEMPORAL AWARENESS (v2.2)
  // ═══════════════════════════════════════
  //
  // Real-time awareness gives voices a sense of duration, not just state.
  // Urges modulate existing belief parameters (gateW, tempBias, densityBias):
  //   - modeUrge: "been on this groove too long" → push for mode change
  //   - playUrge: "silence building" → push to play
  //   - maturity: "session is young" → suppress risk-taking
  //
  // These are continuous [0,1] signals fed into _deriveParams().

  function onVoiceNote(voice) {
    // Called when a voice produces a note
    if (voices[voice]) {
      voices[voice].lastNoteTime = Date.now();
    }
  }

  function onModeChange(voice, newMode) {
    // Called when a voice's behavior mode changes
    if (voices[voice]) {
      voices[voice].lastModeChange = Date.now();
      voices[voice].currentMode = newMode;
    }
  }

  function getTemporalUrges(voice) {
    var v = voices[voice];
    if (!v) return { modeUrge: 0, playUrge: 0, maturity: 0 };

    var now = Date.now();
    var bpm = (typeof TempoEngine !== 'undefined') ? TempoEngine.getEffectiveBPM() : 120;
    var barMs = (60000 / bpm) * 4;  // 4 beats per bar

    // modeUrge: grows as time-in-current-mode increases.
    // Saturates at 1.0 after ~32 bars on the same mode.
    var modeAge = v.lastModeChange > 0 ? (now - v.lastModeChange) : 0;
    var modeUrge = Math.min(1, modeAge / (barMs * 32));

    // playUrge: grows during silence. Saturates after ~4 bars of silence.
    // v3.4.1: halved from 8 bars (16s) to 4 bars (8s) for faster recovery.
    var silenceAge = v.lastNoteTime > 0 ? (now - v.lastNoteTime) : 0;
    var playUrge = Math.min(1, silenceAge / (barMs * 4));

    // maturity: how far into the session. 0 at start, 1 after ~30s.
    // Suppresses adventurousness early (cold-start caution).
    var sessionAge = _sessionStartTime > 0 ? (now - _sessionStartTime) : 0;
    var maturity = Math.min(1, sessionAge / 30000);

    return { modeUrge: modeUrge, playUrge: playUrge, maturity: maturity };
  }

  return {
    updateBeliefs:       updateBeliefs,
    updateEnergy:        updateEnergy,
    shouldPlay:          shouldPlay,
    getParams:           getParams,
    getBelief:           getBelief,
    getBeliefVelocity:   getBeliefVelocity,
    getLastObservations: getLastObservations,
    reset:               reset,
    initColdStart:       _initColdStart,
    getColdStartDelay:   function(voice) { return COLD_START_DELAY_MS[voice] || 0; },
    getColdStartDelays:  function() { return COLD_START_DELAY_MS; },
    onVoiceNote:         onVoiceNote,
    onModeChange:        onModeChange,
    getTemporalUrges:    getTemporalUrges,
    getSubjectiveTimeMult: _getSubjectiveTimeMult,
    // v5 Phase 1: Belief history + trajectory analysis
    getBeliefTrend:      _getBeliefTrend,
    getBeliefCycleCount: _getBeliefCycleCount,
    getBeliefVariance:   _getBeliefVariance,
    getTrajectoryPhase:  _getTrajectoryPhase,
    isStalePattern:      _isStalePattern,
    // v8 Feature E: Anticipatory belief projection (ADAM model)
    projectBelief:       _projectBelief,
    getHistory:          function(voice) { return _beliefHistory[voice] || null; },
    getHistoryLength:    function(voice) { var h = _beliefHistory[voice]; return h ? h.count : 0; },
    INTENTS:             INTENTS,
    NEEDS:               NEEDS,
    PERCEPTUAL:          PERCEPTUAL,
    // v5 Phase 6: Warm-start override from LTM session history
    applyWarmStart: function(adjust) {
      if (!adjust) return;
      // Nudge initial beliefs by small amounts based on session history.
      // adjust = { stability, energy, space, surprise, resolution }
      var map = [adjust.stability||0, adjust.energy||0, adjust.space||0, adjust.surprise||0, adjust.resolution||0];
      var vnames = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
      for (var i = 0; i < vnames.length; i++) {
        var v = voices[vnames[i]];
        if (!v) continue;
        for (var j = 0; j < 5; j++) {
          v.belief[j] = Math.max(0.02, Math.min(0.80, v.belief[j] + map[j]));
        }
        // Re-normalize to sum=1
        var sum = 0;
        for (var j = 0; j < 5; j++) sum += v.belief[j];
        if (sum > 0) for (var j = 0; j < 5; j++) v.belief[j] /= sum;
        v._prevBelief = v.belief.slice();
      }
    }
  };

})();

console.log('%cBeliefState v2 loaded (music-need sensing, 5 states)', 'color:#6af;font-family:monospace');

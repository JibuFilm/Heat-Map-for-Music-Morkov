'use strict';
// ═══ SECTION TRACKER (Phase A — Hierarchical Prediction) ═══
//
// Tracks large-scale musical form via a state machine:
//   STABLE → BUILD → PEAK → RELEASE → STABLE
//   Any state → TRANSITION → STABLE (on key change or silence)
//
// Outputs continuous 0-1 values for energy, adventurousness, density,
// developmentBias, and resolutionUrgency. These constrain lower layers.
//
// Depends on: constants.js, event-bus.js, prediction-engine.js, tempo-engine.js
// Load order: after prediction-engine.js, before assistant files.

var SectionTracker = (function() {

  // ── Constants (read from constants.js or defaults) ──
  var STABLE_THRESH = (typeof SECTION_STABLE_THRESHOLD !== 'undefined') ? SECTION_STABLE_THRESHOLD : 8;
  var BUILD_MIN = (typeof SECTION_BUILD_MIN !== 'undefined') ? SECTION_BUILD_MIN : 4;
  var PEAK_DUR = (typeof SECTION_PEAK_DURATION !== 'undefined') ? SECTION_PEAK_DURATION : [2, 4];
  var JITTER = (typeof SECTION_JITTER !== 'undefined') ? SECTION_JITTER : 0.15;

  // ── State ──
  var state = 'STABLE';
  var stateStartTime = Date.now();
  var stateBars = 0;

  // ── Measurements ──
  var lastChordTime = Date.now();
  var barsSinceChordChange = 0;
  var energyLevel = 0.3;
  var noteDensity = 0;       // notes per second, smoothed
  var pitchRangeWidth = 0;   // semitone span of recent notes
  var recentNotes = [];      // {pc, register, time}
  var noteCountWindow = [];  // timestamps for density calc
  var harmonicDistance = 0;
  var silenceDuration = 0;
  var lastNoteTime = Date.now();

  // ── Output state (smoothed) ──
  var output = {
    state: 'STABLE',
    energy: 0.3,
    adventurousness: 0.2,
    density: 0.4,
    developmentBias: 0.3,
    resolutionUrgency: 0.0
  };

  // ── Jitter helper ──
  function jitter(val) {
    return val * (1 + (Math.random() * 2 - 1) * JITTER);
  }

  // ── Noise helper ──
  function noise(val, amount) {
    return val + (Math.random() * 2 - 1) * amount;
  }

  // ── Harmonic distance from tonal center ──
  function computeHarmonicDistance(chordRootPC) {
    if (chordRootPC === null || chordRootPC === undefined) return 0;
    var keyC = SharedState.keyC;
    var dist = Math.abs(chordRootPC - keyC);
    if (dist > 6) dist = 12 - dist;
    // Normalize: tritone (6) = 1.0, unison (0) = 0.0
    return dist / 6;
  }

  // ── Energy computation ──
  function computeEnergy() {
    // Note density: count notes in last 4 seconds
    var now = Date.now();
    var cutoff = now - 4000;
    while (noteCountWindow.length > 0 && noteCountWindow[0] < cutoff) {
      noteCountWindow.shift();
    }
    noteDensity = noteCountWindow.length / 4.0; // notes per second

    // Pitch range: span of recent notes
    if (recentNotes.length >= 2) {
      var pcs = [];
      for (var i = 0; i < recentNotes.length; i++) pcs.push(recentNotes[i].pc);
      var minPC = 12, maxPC = 0;
      for (var j = 0; j < pcs.length; j++) {
        if (pcs[j] < minPC) minPC = pcs[j];
        if (pcs[j] > maxPC) maxPC = pcs[j];
      }
      pitchRangeWidth = maxPC - minPC;
    }

    // Combine: density (0-1 mapped from 0-6 nps) + range (0-1 mapped from 0-12)
    // v2.2: surprise weight redistributed — PPM trie is cold so surpriseAvg=0 always.
    // Harmonic distance added as proxy for tension/movement.
    var densityNorm = Math.min(1, noteDensity / 6);
    var rangeNorm = Math.min(1, pitchRangeWidth / 11);
    var surprise = SharedState.getSurpriseAvg ? SharedState.getSurpriseAvg() : 0;
    var harmDistNorm = Math.min(1, harmonicDistance / 6);

    var _rawEnergy = densityNorm * 0.4 + rangeNorm * 0.25 + surprise * 0.15 + harmDistNorm * 0.2;

    // v5 Phase 4: Narrative arc energy modifier
    // During climax phases, energy is boosted to ensure BUILD→PEAK transition.
    // Uses ensemble average across voices (consensus effect).
    if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getEnergyModifier) {
      var arcEnergySum = 0;
      var arcVoices = ['bass', 'rhythm', 'soloist', 'lead'];
      for (var avi = 0; avi < arcVoices.length; avi++) {
        arcEnergySum += NarrativeArc.getEnergyModifier(arcVoices[avi]);
      }
      var arcEnergyMod = arcEnergySum / arcVoices.length; // 0.85-1.4 range
      _rawEnergy *= arcEnergyMod;
    }

    _rawEnergy = Math.max(0, Math.min(1, _rawEnergy));

    // v8.2 Fix #2: Asymmetric EMA smoothing on energy level.
    // Phrase gaps cause instantaneous density drops that crash energy,
    // preventing BUILD→PEAK transitions. Smoothing lets energy persist
    // through natural phrase gaps while still responding to real changes.
    // Rise α=0.3 (responds in ~1s), decay α=0.08 (persists ~5s).
    // Matches Farbood 2012: tension rises faster than it decays.
    var _alpha = _rawEnergy > energyLevel ? 0.3 : 0.08;
    energyLevel += (_rawEnergy - energyLevel) * _alpha;
  }

  // ── State transition logic ──
  function checkTransitions(dt, bpm) {
    var now = Date.now();
    var beatMs = 60000 / Math.max(30, bpm);
    var barMs = beatMs * 4;

    // Update bars in state
    var timeInState = now - stateStartTime;
    stateBars = timeInState / barMs;

    // Silence tracking
    silenceDuration = (now - lastNoteTime) / barMs; // in bars

    // Long silence → TRANSITION from any state
    if (silenceDuration > 8 && state !== 'TRANSITION') {
      _transition('TRANSITION');
      return;
    }

    switch (state) {
      case 'STABLE':
        // → BUILD when stable too long OR human increases activity
        var stableThresh = jitter(STABLE_THRESH);
        // v2.2: lowered from 0.6 to 0.45 — practical energy range is 0.15-0.6 with cold surprise
        if (barsSinceChordChange > stableThresh || (energyLevel > 0.45 && stateBars > 2)) {
          _transition('BUILD');
        }
        break;

      case 'BUILD':
        // → PEAK when energy is high enough for long enough
        // v2.2: lowered from 0.7 to 0.55. v8.7.1: lowered to 0.48 — peer observations
        // dampen raw energy signal (voices observe ensemble avg, not own density).
        // Practical energy range with peer obs: 0.15-0.55. 0.48 is reachable during
        // sustained ensemble activity. BUILD_MIN ensures we don't trigger too early.
        //
        // v9.0.0: Session arc modulates BUILD→PEAK threshold via peakCeiling.
        // During Exposition (peakCeiling 0.60): threshold raised → PEAKs are harder to reach.
        // During Recapitulation (peakCeiling 1.0): threshold at default → PEAKs fire naturally.
        // This creates accumulating drama: each cycle's PEAK is harder-won than the last.
        var _buildThreshold = 0.48;
        if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getSessionPhase) {
          var _sp = NarrativeArc.getSessionPhase();
          // peakCeiling 0.60→1.0 maps to threshold 0.52→0.48
          // Lower ceiling = harder to reach PEAK (inverted: ceiling dampens, threshold rises)
          _buildThreshold = 0.48 + (1.0 - _sp.peakCeiling) * 0.10;
        }
        if (energyLevel > _buildThreshold && stateBars > jitter(BUILD_MIN)) {
          _transition('PEAK');
        }
        // Fall back to STABLE if energy drops and we've been building long enough
        // v2.2: lowered from 0.3 to 0.25 to match recalibrated energy range
        if (energyLevel < 0.25 && stateBars > BUILD_MIN * 2) {
          _transition('STABLE');
        }
        break;

      case 'PEAK':
        // v8.13.0: Energy-sustained PEAK — stay while energy supports it.
        // PEAK_DUR[0] = minimum bars (3), PEAK_DUR[1] = maximum bars (16).
        // Exit conditions (after minimum):
        //   1. Energy crash: ensemble energy drops below 0.35 (was playing, now thinning)
        //   2. Tonic resolution + energy declining: harmonic resolution with waning energy
        //   3. Silence guard: no notes for >4 bars = ensemble is stuck, not peaking
        //   4. Maximum duration safety cap
        // This replaces the old 2-4 bar hard cap that killed climaxes prematurely.
        // The cascade failure was: short PEAK → RELEASE → voices read section change →
        // all yield → energy drops → confirms RELEASE. Now PEAK sustains while energy
        // is genuinely high, and exits on musical evidence, not a timer.
        //
        // v9.0.0: Session arc scales PEAK duration via peakCeiling.
        // Exposition (0.60): peakMax × 0.60 = ~10 bars max (short, restrained)
        // Development (0.70-0.90): scaling up per cycle
        // Recapitulation (1.0): full 16-bar maximum (climactic)
        var peakMin = PEAK_DUR[0];
        var peakMax = PEAK_DUR[1];
        if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getSessionPhase) {
          var _spPeak = NarrativeArc.getSessionPhase();
          peakMax = Math.round(PEAK_DUR[1] * _spPeak.peakCeiling);
          peakMax = Math.max(peakMin + 1, peakMax);  // at least 1 bar more than minimum
        }
        if (stateBars > peakMin) {
          // Exit condition 1: energy crash (ensemble thinning)
          if (energyLevel < 0.35) {
            _transition('RELEASE');
            break;
          }
          // Exit condition 2: tonic resolution with declining energy
          var tonicRes = SharedState.currentChord &&
            SharedState.currentChord.rootPC === SharedState.keyC;
          if (tonicRes && energyLevel < 0.45) {
            _transition('RELEASE');
            break;
          }
          // Exit condition 3: silence guard — if no notes for 4+ bars, PEAK is
          // stuck (energy frozen from stale EMA). A real PEAK has active voices.
          if (silenceDuration > 4) {
            _transition('TRANSITION');
            break;
          }
        }
        // Exit condition 4: maximum duration safety cap
        if (stateBars > peakMax) {
          _transition('RELEASE');
        }
        break;

      case 'RELEASE':
        // → STABLE when tonic resolution detected and energy drops
        var tonicResolution = SharedState.currentChord &&
          SharedState.currentChord.rootPC === SharedState.keyC;
        if (tonicResolution && energyLevel < 0.3) {
          _transition('STABLE');
        }
        // Timeout: if we've been releasing for too long, go stable anyway
        if (stateBars > 8) {
          _transition('STABLE');
        }
        break;

      case 'TRANSITION':
        // → STABLE after 2 bars
        if (stateBars > 2) {
          _transition('STABLE');
        }
        break;
    }
  }

  function _transition(newState) {
    if (newState === state) return;
    state = newState;
    stateStartTime = Date.now();
    stateBars = 0;

    _updateOutputs();
    EventBus.emit('sectionChange', {
      state: output.state,
      energy: output.energy,
      adventurousness: output.adventurousness,
      density: output.density,
      developmentBias: output.developmentBias,
      resolutionUrgency: output.resolutionUrgency
    });
  }

  // ── Output computation (continuous values based on state) ──
  function _updateOutputs() {
    var targets;
    // v9.0.0: Read session arc peakCeiling for PEAK output scaling
    var _peakCeiling = 1.0;
    if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getSessionPhase) {
      _peakCeiling = NarrativeArc.getSessionPhase().peakCeiling;
    }
    switch (state) {
      case 'STABLE':
        targets = { energy: 0.3, adventurousness: 0.2, density: 0.4, developmentBias: 0.3, resolutionUrgency: 0.0 };
        break;
      case 'BUILD':
        // Ramp up over time in build
        var buildProgress = Math.min(1, stateBars / (BUILD_MIN * 2));
        targets = {
          energy: 0.4 + buildProgress * 0.35,
          adventurousness: 0.3 + buildProgress * 0.3,
          density: 0.5 + buildProgress * 0.2,
          developmentBias: 0.5 + buildProgress * 0.3,
          resolutionUrgency: 0.0
        };
        break;
      case 'PEAK':
        // v9.0.0: Session arc scales PEAK intensity via peakCeiling.
        // Exposition PEAKs are mild (ceiling 0.60). Recapitulation at full (1.0).
        targets = {
          energy: 0.50 + 0.35 * _peakCeiling,
          adventurousness: 0.35 + 0.35 * _peakCeiling,
          density: 0.45 + 0.35 * _peakCeiling,
          developmentBias: 0.50 + 0.30 * _peakCeiling,
          resolutionUrgency: 0.1
        };
        break;
      case 'RELEASE':
        var releaseProgress = Math.min(1, stateBars / 4);
        targets = {
          energy: 0.7 - releaseProgress * 0.5,
          adventurousness: 0.4 - releaseProgress * 0.2,
          density: 0.6 - releaseProgress * 0.3,
          developmentBias: 0.4,
          resolutionUrgency: 0.3 + releaseProgress * 0.5
        };
        break;
      case 'TRANSITION':
        targets = { energy: 0.2, adventurousness: 0.1, density: 0.3, developmentBias: 0.1, resolutionUrgency: 0.0 };
        break;
      default:
        targets = { energy: 0.3, adventurousness: 0.2, density: 0.4, developmentBias: 0.3, resolutionUrgency: 0.0 };
    }

    // Smooth toward targets with noise
    var alpha = 0.15; // smoothing rate
    output.state = state;
    output.energy = output.energy + (targets.energy - output.energy) * alpha;
    output.adventurousness = output.adventurousness + (targets.adventurousness - output.adventurousness) * alpha;
    output.density = output.density + (targets.density - output.density) * alpha;
    output.developmentBias = output.developmentBias + (targets.developmentBias - output.developmentBias) * alpha;
    output.resolutionUrgency = output.resolutionUrgency + (targets.resolutionUrgency - output.resolutionUrgency) * alpha;

    // Add ±0.05 noise
    output.energy = Math.max(0, Math.min(1, noise(output.energy, 0.02)));
    output.adventurousness = Math.max(0, Math.min(1, noise(output.adventurousness, 0.02)));
    output.density = Math.max(0, Math.min(1, noise(output.density, 0.02)));
    output.developmentBias = Math.max(0, Math.min(1, noise(output.developmentBias, 0.02)));
    output.resolutionUrgency = Math.max(0, Math.min(1, noise(output.resolutionUrgency, 0.02)));
  }

  // ── EventBus subscriptions ──
  // v9.1.0: Debounce keyChanged events to prevent rapid BUILD→TRANSITION oscillation.
  // Arc test showed 10 TRANSITION states in 185s (one every 18s) with no STABLE or
  // RELEASE. Root cause: low key confidence (0.03) allowed spurious keyChanged events.
  // Debounce suppresses keyChanged if last TRANSITION was < 8 bars ago (~16s at 120 BPM).
  var _lastKeyChangeTransitionTime = 0;
  var KEY_CHANGE_DEBOUNCE_MS = 16000;  // ~8 bars at 120 BPM

  EventBus.on('keyChanged', function() {
    // v8.12.1: Use centralized grounding flag from KeyBelief.
    // Suppresses key-change transitions when bass is not grounding (SEARCHING/ANCHORING
    // or recently exited SEARCHING). Key changes during harmonic thinning are noise.
    if (typeof KeyBelief !== 'undefined' && KeyBelief.isGroundingLost && KeyBelief.isGroundingLost()) {
      return;
    }
    // v9.1.0: Debounce — suppress if recent TRANSITION already handled a key change
    var now = Date.now();
    if (now - _lastKeyChangeTransitionTime < KEY_CHANGE_DEBOUNCE_MS) {
      return;
    }
    if (state !== 'TRANSITION') {
      _lastKeyChangeTransitionTime = now;
      _transition('TRANSITION');
    }
  });

  EventBus.on('chordChanged', function(data) {
    barsSinceChordChange = 0;
    lastChordTime = Date.now();
    if (data && data.rootPC !== undefined) {
      harmonicDistance = computeHarmonicDistance(data.rootPC);
    }
  });

  EventBus.on('phraseBoundary', function() {
    // Phrase boundaries can influence energy computation
    // but don't directly cause state transitions
  });

  // ══════════════════════════════════════
  // PER-VOICE SECTION PERCEPTION (v4 Phase 4)
  // ══════════════════════════════════════
  //
  // Each voice derives section perception from its own belief trajectory.
  // Consensus = average of per-voice perceptions (backward compat for getState).
  // TRANSITION stays global (key change / silence are external events).

  var _voices = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
  var _voicePerceptions = {};
  var _consensusEnergy = 0.3;
  var _consensusState = 'STABLE';
  var _consensusBars = 0;
  var _consensusStartTime = Date.now();

  // Initialize per-voice perceptions
  for (var _vi = 0; _vi < _voices.length; _vi++) {
    _voicePerceptions[_voices[_vi]] = {
      state: 'STABLE',
      energy: 0.3,
      smoothedEnergy: 0.3,
      stateBars: 0,
      stateStartTime: Date.now(),
      disagreeBars: 0  // how long this voice disagrees with majority
    };
  }

  // Per-voice energy from belief trajectory
  function _computeVoiceSectionEnergy(voice) {
    if (typeof BeliefState === 'undefined') return 0.3;
    var b = BeliefState.getBelief(voice);
    if (!b) return 0.3;
    return b.needs_energy * 0.4 +
           b.needs_surprise * 0.3 +
           (1 - b.needs_space) * 0.2 +
           (1 - b.needs_stability) * 0.1;
  }

  // Per-voice section inference with hysteresis
  // Thresholds calibrated for belief-derived energy range (~0.15-0.45 in practice).
  // needs_space dominance in freerun caps typical energy at ~0.30; human input pushes higher.
  function _inferVoiceSection(energy, prevState, sBars) {
    // TRANSITION is global — don't override it here
    if (state === 'TRANSITION') return 'TRANSITION';

    switch (prevState) {
      case 'STABLE':
        if (energy > 0.32) return 'BUILD';
        break;
      case 'BUILD':
        if (energy > 0.45) return 'PEAK';
        if (energy < 0.22 && sBars > 4) return 'STABLE';
        break;
      case 'PEAK':
        // v8.13.0: per-voice PEAK also energy-sustained (matches global logic)
        if (sBars > PEAK_DUR[0] && energy < 0.35) return 'RELEASE';
        if (sBars > PEAK_DUR[1]) return 'RELEASE';
        break;
      case 'RELEASE':
        if (energy < 0.25) return 'STABLE';
        if (sBars > 8) return 'STABLE';
        break;
      case 'TRANSITION':
        if (sBars > 2) return 'STABLE';
        break;
    }
    return prevState;
  }

  // Find majority section state
  function _getMajorityState() {
    var counts = {};
    for (var i = 0; i < _voices.length; i++) {
      var s = _voicePerceptions[_voices[i]].state;
      counts[s] = (counts[s] || 0) + 1;
    }
    var best = 'STABLE', bestCount = 0;
    for (var k in counts) {
      if (counts[k] > bestCount) { best = k; bestCount = counts[k]; }
    }
    return best;
  }

  // Update all per-voice perceptions (called from tick)
  function _updateVoicePerceptions(dt, bpm) {
    if (window.PER_VOICE_SECTION === false) return;  // A/B toggle

    var beatMs = 60000 / Math.max(30, bpm);
    var barMs = beatMs * 4;
    var majorityState = _getMajorityState();
    var alpha = 0.15;

    var totalEnergy = 0;

    for (var i = 0; i < _voices.length; i++) {
      var v = _voices[i];
      var vp = _voicePerceptions[v];

      // Compute raw energy from beliefs
      var rawEnergy = _computeVoiceSectionEnergy(v);

      // Peer-pressure: if disagreeing with majority > 8 bars, smooth faster toward consensus
      // dt is in milliseconds; convert to bars
      var dtBars = (dt / barMs);
      if (vp.state !== majorityState) {
        vp.disagreeBars += dtBars;
      } else {
        vp.disagreeBars = Math.max(0, vp.disagreeBars - dtBars * 2);
      }
      var smoothAlpha = (vp.disagreeBars > 8) ? 0.30 : alpha;

      // Smooth energy
      vp.smoothedEnergy += (rawEnergy - vp.smoothedEnergy) * smoothAlpha;
      vp.energy = Math.max(0, Math.min(1, vp.smoothedEnergy));

      // Update bars in state
      vp.stateBars = (Date.now() - vp.stateStartTime) / barMs;

      // Infer section
      var newState = _inferVoiceSection(vp.energy, vp.state, vp.stateBars);
      if (newState !== vp.state) {
        vp.state = newState;
        vp.stateStartTime = Date.now();
        vp.stateBars = 0;
      }

      totalEnergy += vp.energy;
    }

    // Consensus energy
    _consensusEnergy = totalEnergy / _voices.length;
    var prevConsensus = _consensusState;
    _consensusBars = (Date.now() - _consensusStartTime) / barMs;
    _consensusState = _inferVoiceSection(_consensusEnergy, _consensusState, _consensusBars);
    if (_consensusState !== prevConsensus) {
      _consensusStartTime = Date.now();
      _consensusBars = 0;
    }
  }

  // Build per-voice output (same shape as getState())
  function _buildVoiceOutput(vp) {
    var targets;
    // v9.0.0: Session arc peakCeiling for per-voice PEAK scaling
    var _vpCeiling = 1.0;
    if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getSessionPhase) {
      _vpCeiling = NarrativeArc.getSessionPhase().peakCeiling;
    }
    switch (vp.state) {
      case 'STABLE':
        targets = { energy: 0.3, adventurousness: 0.2, density: 0.4, developmentBias: 0.3, resolutionUrgency: 0.0 };
        break;
      case 'BUILD':
        var bp = Math.min(1, vp.stateBars / (BUILD_MIN * 2));
        targets = { energy: 0.4 + bp * 0.35, adventurousness: 0.3 + bp * 0.3, density: 0.5 + bp * 0.2, developmentBias: 0.5 + bp * 0.3, resolutionUrgency: 0.0 };
        break;
      case 'PEAK':
        targets = {
          energy: 0.50 + 0.35 * _vpCeiling,
          adventurousness: 0.35 + 0.35 * _vpCeiling,
          density: 0.45 + 0.35 * _vpCeiling,
          developmentBias: 0.50 + 0.30 * _vpCeiling,
          resolutionUrgency: 0.1
        };
        break;
      case 'RELEASE':
        var rp = Math.min(1, vp.stateBars / 4);
        targets = { energy: 0.7 - rp * 0.5, adventurousness: 0.4 - rp * 0.2, density: 0.6 - rp * 0.3, developmentBias: 0.4, resolutionUrgency: 0.3 + rp * 0.5 };
        break;
      case 'TRANSITION':
        targets = { energy: 0.2, adventurousness: 0.1, density: 0.3, developmentBias: 0.1, resolutionUrgency: 0.0 };
        break;
      default:
        targets = { energy: 0.3, adventurousness: 0.2, density: 0.4, developmentBias: 0.3, resolutionUrgency: 0.0 };
    }
    // Blend toward targets using voice's own energy as weight
    var w = Math.max(0.3, vp.energy);
    return {
      state: vp.state,
      energy: targets.energy * w + (1 - w) * 0.3,
      adventurousness: targets.adventurousness,
      density: targets.density,
      developmentBias: targets.developmentBias,
      resolutionUrgency: targets.resolutionUrgency
    };
  }

  function getVoiceState(voice) {
    if (window.PER_VOICE_SECTION === false || !_voicePerceptions[voice]) {
      return getState();
    }
    return _buildVoiceOutput(_voicePerceptions[voice]);
  }

  function getVoicePerceptions() {
    var result = {};
    for (var i = 0; i < _voices.length; i++) {
      var v = _voices[i];
      var vp = _voicePerceptions[v];
      result[v] = { state: vp.state, energy: +vp.energy.toFixed(3), disagreeBars: +vp.disagreeBars.toFixed(1) };
    }
    result._consensus = _consensusState;
    result._consensusEnergy = +_consensusEnergy.toFixed(3);
    return result;
  }

  // ══════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════

  function onNote(pc, register, now, isHuman) {
    recentNotes.push({ pc: pc, register: register, time: now });
    // Keep last 32 notes
    if (recentNotes.length > 32) recentNotes.shift();

    // v3.8.1: Human notes update lastNoteTime (silence detection) and recentNotes
    // (pitch range) but are discounted in noteCountWindow (density computation).
    // Human is a wildcard — their activity shouldn't be interpreted as ensemble
    // saturation. Without this, active human → energyLevel > 0.55 → PEAK section
    // → needs_space boost for ALL voices → compound silence.
    // Aging trick: push timestamp 2800ms in the past so it expires in ~1.2s instead
    // of the full 4s window — 30% effective contribution to density.
    if (isHuman) {
      noteCountWindow.push(now - 2800);
    } else {
      noteCountWindow.push(now);
    }
    lastNoteTime = now;

    computeEnergy();
  }

  function tick(dt, bpm) {
    // Update bars since last chord change
    var beatMs = 60000 / Math.max(30, bpm);
    var barMs = beatMs * 4;
    barsSinceChordChange = (Date.now() - lastChordTime) / barMs;

    checkTransitions(dt, bpm);
    _updateOutputs();

    // v4 Phase 4: update per-voice perceptions from belief trajectories
    _updateVoicePerceptions(dt, bpm);
  }

  function getState() {
    return {
      state: output.state,
      energy: output.energy,
      adventurousness: output.adventurousness,
      density: output.density,
      developmentBias: output.developmentBias,
      resolutionUrgency: output.resolutionUrgency
    };
  }

  function reset() {
    state = 'STABLE';
    stateStartTime = Date.now();
    stateBars = 0;
    lastChordTime = Date.now();
    barsSinceChordChange = 0;
    energyLevel = 0.3;
    noteDensity = 0;
    pitchRangeWidth = 0;
    recentNotes = [];
    noteCountWindow = [];
    harmonicDistance = 0;
    silenceDuration = 0;
    lastNoteTime = Date.now();
    output = {
      state: 'STABLE',
      energy: 0.3,
      adventurousness: 0.2,
      density: 0.4,
      developmentBias: 0.3,
      resolutionUrgency: 0.0
    };
    // Reset per-voice perceptions
    _consensusEnergy = 0.3;
    _consensusState = 'STABLE';
    _consensusBars = 0;
    _consensusStartTime = Date.now();
    for (var ri = 0; ri < _voices.length; ri++) {
      var rv = _voicePerceptions[_voices[ri]];
      rv.state = 'STABLE'; rv.energy = 0.3; rv.smoothedEnergy = 0.3;
      rv.stateBars = 0; rv.stateStartTime = Date.now(); rv.disagreeBars = 0;
    }
  }

  // ── v5 Phase 2: Predictive Section Forecast ──
  // Uses belief trajectory trends to predict upcoming section transitions.
  // Each voice predicts independently (decentralized — no shared forecast).
  // Returns: { predictedState: string, confidence: 0-1 }
  function getForecast(voice) {
    if (typeof BeliefState === 'undefined') {
      return { predictedState: null, confidence: 0 };
    }

    var currentState;
    if (voice) {
      var vs = getVoiceState(voice);
      currentState = vs ? vs.state : output.state;
    } else {
      currentState = output.state;
    }

    // Read belief trends (8 samples ≈ 4 bars)
    var energyTrend = BeliefState.getBeliefTrend(voice || 'bass', 1, 8);
    var spaceTrend = BeliefState.getBeliefTrend(voice || 'bass', 2, 8);
    var surpriseTrend = BeliefState.getBeliefTrend(voice || 'bass', 3, 8);
    var stabilityTrend = BeliefState.getBeliefTrend(voice || 'bass', 0, 8);

    // Confidence from trend magnitude and consistency (low variance = high confidence)
    var variance = BeliefState.getBeliefVariance(voice || 'bass', 1, 8);
    var trendStrength = Math.abs(energyTrend) + Math.abs(spaceTrend) * 0.5;
    var consistency = Math.max(0, 1 - variance * 20);  // low variance → high consistency

    var predicted = null;
    var conf = 0;

    if (currentState === 'STABLE') {
      // Energy rising → BUILD coming
      if (energyTrend > 0.15) {
        predicted = 'BUILD';
        conf = Math.min(1, Math.abs(energyTrend) * consistency);
      }
    } else if (currentState === 'BUILD') {
      // Strong energy + surprise rising → PEAK coming
      if (energyTrend > 0.3 || (energyTrend > 0.15 && surpriseTrend > 0.1)) {
        predicted = 'PEAK';
        conf = Math.min(1, (Math.abs(energyTrend) + Math.abs(surpriseTrend) * 0.5) * consistency);
      }
    } else if (currentState === 'PEAK') {
      // Energy falling or space rising → RELEASE coming
      if (energyTrend < -0.15 || spaceTrend > 0.2) {
        predicted = 'RELEASE';
        conf = Math.min(1, (Math.abs(energyTrend) + Math.abs(spaceTrend) * 0.5) * consistency);
      }
    } else if (currentState === 'RELEASE') {
      // Stability rising → back to STABLE
      if (stabilityTrend > 0.15) {
        predicted = 'STABLE';
        conf = Math.min(1, Math.abs(stabilityTrend) * consistency);
      }
    } else if (currentState === 'TRANSITION') {
      // High stability trend → STABLE; high energy → BUILD
      if (stabilityTrend > energyTrend && stabilityTrend > 0.1) {
        predicted = 'STABLE';
        conf = Math.min(1, Math.abs(stabilityTrend) * consistency);
      } else if (energyTrend > 0.1) {
        predicted = 'BUILD';
        conf = Math.min(1, Math.abs(energyTrend) * consistency);
      }
    }

    return { predictedState: predicted, confidence: Math.max(0, Math.min(1, conf)) };
  }

  return {
    onNote: onNote,
    tick: tick,
    getState: getState,
    getVoiceState: getVoiceState,
    getVoicePerceptions: getVoicePerceptions,
    getForecast: getForecast,
    reset: reset
  };

})();

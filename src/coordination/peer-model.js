'use strict';
// ═══ PEER MODEL (v8.3 — FGSR: Feature-Gated Selective Response) ═══
//
// Per-peer predictive models with multi-timescale feature tracking.
// Each voice maintains a lightweight model of every other voice (including human).
// Voices become anticipatory peers — they predict, complement, and coordinate
// without a conductor.
//
// v8.3 FGSR extension: Multi-timescale EMAs track how peers change over time
// (not just current state). Feature surprise detection flags notable deviations.
// Asymmetric attention matrix (PEER_ATTENTION) determines which voice listens
// to which features from which peers. Responses are complementary by default.
//
// Research grounding:
//   Keller 2014 (joint action), Palmer & Loehr 2013 (ensemble prediction),
//   Deutsch 2013 (figure-ground), Pressing 1999 (internal partner models),
//   Washburn et al. 2019 (selective auditory attention in ensembles),
//   Clayton 2012 (multi-timescale entrainment),
//   Frieler et al. 2016 (motivic interaction ~25% cap),
//   selective-listening-research.md (cross-genre attention patterns)
//
// Architecture: Passive observer (same pattern as ContextIntegrator).
// Reads from ContextIntegrator, PeerVelocity, NarrativeArc, MelodicIntent.
// Outputs feed into AssistantShared.scoreLexiconEntry() and MelodicIntent.
// No feedback path to BeliefState — no circular dependency.
//
// Tick rate: 500ms (same as MelodicIntent), not every frame.
// Memory: ~6KB total (6 peers × ~300 bytes each + FGSR state).
//
// Depends on: context-integrator.js, peer-velocity.js, event-bus.js, constants.js
// Optional reads: narrative-arc.js, melodic-intent.js, melodic-expectancy.js
// Load order: after peer-velocity.js, before app.js

var PeerModel = (function() {

  // ── Constants ──

  var VOICES = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
  var ALL_PEERS = ['bass', 'rhythm', 'soloist', 'lead', 'percussion', 'human'];
  var TICK_INTERVAL_MS = 500;

  // PC histogram decay per tick — how fast pitch memory fades
  var PC_HIST_DECAY = 0.90;

  // EMA smoothing factors (per 500ms tick)
  var DENSITY_EMA_ALPHA = 0.3;     // ~1.5s effective window
  var CONTOUR_EMA_ALPHA = 0.25;    // ~2s effective window
  var DENSITY_TREND_ALPHA = 0.2;   // ~2.5s effective window

  // Repetition detection
  var PATTERN_WINDOW = 8;          // PCs to hash for pattern matching
  var REP_SCORE_RISE = 0.15;       // per consecutive match
  var REP_SCORE_DECAY = 0.08;      // per non-match tick

  // Ensemble variation budget
  // Tolerance: how much repetition each role tolerates before being asked to vary.
  // Bass/rhythm are ground — high tolerance. Soloist/lead are figure — low tolerance.
  // Grounding: Deutsch 2013 figure-ground segregation in auditory streams.
  var ROLE_REP_TOLERANCE = { bass: 0.80, rhythm: 0.85, soloist: 0.40, lead: 0.45, percussion: 0.90 };
  var ENSEMBLE_REP_THRESHOLD = 0.55; // avg repetition above this → variation needed

  // Complementary scoring weights
  var REGISTER_COMP_WEIGHT = 0.08;   // +0.00 to +0.08 for register separation
  var DENSITY_COMP_WEIGHT = 0.05;    // +0.00 to +0.05 for density complementarity
  var FIGUREGROUND_WEIGHT = 0.06;    // +0.00 to +0.06 for repetition figure-ground

  // Anticipatory spacing
  var SPACE_PREDICTION_HORIZON_MS = 2000; // look 2s ahead

  // ── FGSR: Slow EMA alphas (multi-timescale feature tracking) ──
  // Clayton 2012: coordination timescale = seconds to minutes
  // Alpha values calibrated for 500ms tick interval:
  //   alpha 0.10 → ~5s half-life (~12 bars at 120BPM)
  //   alpha 0.08 → ~6.25s half-life (~16 bars)
  //   alpha 0.05 → ~10s half-life (~32 bars)
  var DENSITY_SLOW_ALPHA  = 0.10;   // ~12 bar window
  var REGISTER_SLOW_ALPHA = 0.15;   // ~8 bar window
  var CONTOUR_SLOW_ALPHA  = 0.08;   // ~16 bar window
  var TENSION_EMA_ALPHA   = 0.05;   // ~32 bar window

  // Feature surprise detection thresholds
  var SURPRISE_THRESH_ENERGY   = 0.25;  // density deviation
  var SURPRISE_THRESH_REGISTER = 3.0;   // PC distance (circular)
  var SURPRISE_THRESH_CONTOUR  = 0.4;   // contour direction flip
  var SURPRISE_THRESH_TENSION  = 0.3;   // IC deviation

  // Surprise habituation (prevents noise from constant surprising voices)
  var HABITUATION_RISE  = 0.05;   // +5% per consecutive surprise
  var HABITUATION_DECAY = 0.01;   // -1% per non-surprise tick (toward 1.0)

  // FGSR scoring cap
  var FGSR_MAX_BONUS = 0.10;      // maximum contribution to phrase score
  var FGSR_L2_GATE   = 0.25;      // Frieler 2016: contour cross-referencing cap

  // FGSR dynamic attention modulation
  var _attentionModifier = 1.0;
  var _convergenceLevel = 0;
  var _convergenceCooldownTicks = 0;
  var _lastFeatureResponse = {};  // per-voice last computed score (diagnostic)

  // v8.6.0: Per-drum density tracking for FGSR-based density control
  // Replaces brute-force ContextIntegrator.getDrumDensity() reads in rhythm postGap.
  // Faster tick (every frame via drumTick) for tight drum-rhythm coupling.
  var DRUM_DENSITY_ALPHA = 0.15;          // ~4-bar EMA window (fast response)
  var DRUM_DENSITY_SLOW_ALPHA = 0.05;     // ~16-bar EMA window (baseline)
  var DRUM_SURPRISE_THRESH = 0.20;        // deviation threshold for drum surprise
  var _drumDensityModels = {};            // per-drum: { fast, slow, surprise, magnitude }
  var _DRUM_NAMES = ['kick', 'snare', 'hat', 'ride', 'crash'];

  function _initDrumDensityModel() {
    return { fast: 0, slow: 0, surprise: false, magnitude: 0, habituation: 1.0 };
  }

  // ── Per-peer model state ──
  // _models[peer] = { ... } (shared across all observers — one model per peer)
  var _models = {};

  // Self-repetition tracking (each voice tracks its own repetition)
  var _selfRepetition = {};

  // Tick accumulator
  var _accumMs = 0;

  // ── Initialize ──
  function _initPeerModel(peer) {
    return {
      // Density prediction
      lastDensity: 0,
      densityEMA: 0,
      prevDensityEMA: 0,        // for trend
      densityTrend: 0,          // rising/falling

      // Pitch tendency
      pcHistogram: new Float32Array(12),
      centerPC: 0,
      spread: 0,

      // Contour
      contourEMA: 0,

      // Intent inference (observation-based for human, read internals for AI)
      inferredPhase: 'grounding',  // grounding | exploring | climaxing | resting

      // Repetition tracking
      recentPCs: [],             // rolling window of last PATTERN_WINDOW PCs
      prevPatternHash: 0,
      patternMatchCount: 0,
      repetitionScore: 0,

      // Silence prediction
      lastNoteTime: 0,

      // ── FGSR: Multi-timescale feature tracking ──
      // Slow EMAs track how peers change over 8-32 bars (Clayton 2012)
      densityEMA_slow: 0,       // slow density (α=0.10, ~12 bar window)
      registerEMA_slow: 6,      // centerPC slow tracker (α=0.15, ~8 bar window)
      contourEMA_slow: 0,       // contour direction slow (α=0.08, ~16 bar window)
      tensionEMA: 0.5,          // IC/tension slow tracker (α=0.05, ~32 bar window)

      // Feature surprise state
      featureSurprise: { energy: false, register: false, contour: false, tension: false },
      // Habituation: threshold multiplier, rises with consecutive surprises
      surpriseHabituation: { energy: 1.0, register: 1.0, contour: 1.0, tension: 1.0 }
    };
  }

  function _init() {
    for (var i = 0; i < ALL_PEERS.length; i++) {
      _models[ALL_PEERS[i]] = _initPeerModel(ALL_PEERS[i]);
    }
    for (var j = 0; j < VOICES.length; j++) {
      _selfRepetition[VOICES[j]] = 0;
    }
  }

  // ── Simple hash of PC array ──
  function _hashPCs(pcs) {
    var h = 0;
    for (var i = 0; i < pcs.length; i++) {
      h = ((h << 5) - h + pcs[i]) | 0;  // DJB2-style
    }
    return h;
  }

  // ── Update a single peer model from observations ──
  function _updatePeer(peer) {
    var m = _models[peer];
    if (!m) return;

    // Read density from ContextIntegrator
    var density = 0;
    if (typeof ContextIntegrator !== 'undefined') {
      density = ContextIntegrator.getVoiceDensity(peer);
    }

    // Density EMA + trend
    m.prevDensityEMA = m.densityEMA;
    m.densityEMA = m.densityEMA * (1 - DENSITY_EMA_ALPHA) + density * DENSITY_EMA_ALPHA;
    m.densityTrend = m.densityTrend * (1 - DENSITY_TREND_ALPHA) +
      (m.densityEMA - m.prevDensityEMA) * DENSITY_TREND_ALPHA;
    m.lastDensity = density;

    // Contour EMA
    var contour = 0;
    if (typeof ContextIntegrator !== 'undefined') {
      contour = ContextIntegrator.getVoiceContour(peer);
    }
    m.contourEMA = m.contourEMA * (1 - CONTOUR_EMA_ALPHA) + contour * CONTOUR_EMA_ALPHA;

    // PC histogram from voice state
    var voiceState = null;
    if (typeof ContextIntegrator !== 'undefined') {
      voiceState = ContextIntegrator.getVoiceState(peer);
    }

    // Decay histogram
    for (var i = 0; i < 12; i++) {
      m.pcHistogram[i] *= PC_HIST_DECAY;
    }

    // Add current PC if voice recently played
    if (voiceState && voiceState.pc !== null && voiceState.pc !== undefined) {
      var pc = voiceState.pc % 12;
      m.pcHistogram[pc] += 1.0;
      m.lastNoteTime = voiceState.time || Date.now();

      // Update recent PCs for pattern matching
      m.recentPCs.push(pc);
      if (m.recentPCs.length > PATTERN_WINDOW) {
        m.recentPCs.shift();
      }
    }

    // Compute centerPC and spread from histogram
    var totalWeight = 0;
    var maxBin = 0;
    var maxPC = 0;
    for (var i = 0; i < 12; i++) {
      totalWeight += m.pcHistogram[i];
      if (m.pcHistogram[i] > maxBin) {
        maxBin = m.pcHistogram[i];
        maxPC = i;
      }
    }
    m.centerPC = maxPC;

    // Spread: how many PCs have significant weight (normalized 0-6)
    if (totalWeight > 0) {
      var activePCs = 0;
      var threshold = totalWeight / 12 * 0.5; // 50% of uniform
      for (var i = 0; i < 12; i++) {
        if (m.pcHistogram[i] > threshold) activePCs++;
      }
      m.spread = Math.min(6, activePCs);
    } else {
      m.spread = 0;
    }

    // ── Repetition detection via rolling PC-hash ──
    if (m.recentPCs.length >= PATTERN_WINDOW) {
      var currentHash = _hashPCs(m.recentPCs);
      if (currentHash === m.prevPatternHash && m.prevPatternHash !== 0) {
        m.patternMatchCount++;
        m.repetitionScore = Math.min(1.0, m.repetitionScore + REP_SCORE_RISE);
      } else {
        m.patternMatchCount = Math.max(0, m.patternMatchCount - 1);
        m.repetitionScore = Math.max(0, m.repetitionScore - REP_SCORE_DECAY);
      }
      m.prevPatternHash = currentHash;
    }

    // ── FGSR: Update slow EMAs and detect feature surprises ──
    _updateFGSR(m, density, contour);

    // ── Intent inference ──
    // For AI voices: read NarrativeArc if available (ground truth)
    var isAI = (peer !== 'human');
    if (isAI && typeof NarrativeArc !== 'undefined' && NarrativeArc.getArc) {
      var arc = NarrativeArc.getArc(peer);
      if (arc && arc.phase) {
        // Map arc phase → intent phase
        var phaseMap = {
          'establish': 'grounding',
          'develop': 'exploring',
          'climax': 'climaxing',
          'resolve': 'grounding',
          'transition': 'resting'
        };
        m.inferredPhase = phaseMap[arc.phase] || 'grounding';
      }
    } else {
      // Observation-based inference for human and percussion
      if (density < 0.5 && m.densityTrend < -0.02) {
        m.inferredPhase = 'resting';
      } else if (density > 3.0 && m.contourEMA > 0.3) {
        m.inferredPhase = 'climaxing';
      } else if (m.densityTrend > 0.02 || m.contourEMA > 0.15) {
        m.inferredPhase = 'exploring';
      } else {
        m.inferredPhase = 'grounding';
      }
    }
  }

  // ── Ensemble variation budget ──
  var _ensembleVariation = { budget: 1.0, variationNeeded: false, suggestedVarier: null };

  function _computeEnsembleVariation() {
    var totalRep = 0;
    var count = 0;
    for (var i = 0; i < VOICES.length; i++) {
      var v = VOICES[i];
      var m = _models[v];
      if (m) {
        _selfRepetition[v] = m.repetitionScore;
        totalRep += m.repetitionScore;
        count++;
      }
    }
    var avgRep = count > 0 ? totalRep / count : 0;

    var needed = avgRep > ENSEMBLE_REP_THRESHOLD;
    var bestVarier = null;

    if (needed) {
      // Pick voice most over its tolerance — that voice should vary first
      var worstExcess = -Infinity;
      for (var i = 0; i < VOICES.length; i++) {
        var v = VOICES[i];
        var excess = _selfRepetition[v] - ROLE_REP_TOLERANCE[v];
        if (excess > worstExcess) {
          worstExcess = excess;
          bestVarier = v;
        }
      }
      // Only suggest if actually over tolerance
      if (worstExcess <= 0) bestVarier = null;
    }

    _ensembleVariation = {
      budget: Math.max(0, 1.0 - avgRep),
      variationNeeded: needed,
      suggestedVarier: bestVarier
    };
  }

  // ── Complementary scoring ──

  // Register complementarity: how different is this phrase's pitch center from peers?
  function _registerComplementarity(observer, entrySD) {
    if (!entrySD || entrySD.length === 0) return 0;

    // Estimate phrase center PC from scale degrees
    var sum = 0;
    for (var i = 0; i < entrySD.length; i++) {
      sum += (entrySD[i] % 12 + 12) % 12;
    }
    var phraseCenter = Math.round(sum / entrySD.length) % 12;

    // Average distance from peer centers
    var totalDist = 0;
    var peerCount = 0;
    for (var i = 0; i < ALL_PEERS.length; i++) {
      var peer = ALL_PEERS[i];
      if (peer === observer) continue;
      var m = _models[peer];
      if (!m || m.lastDensity < 0.3) continue; // skip silent peers
      var dist = Math.min(Math.abs(phraseCenter - m.centerPC),
                          12 - Math.abs(phraseCenter - m.centerPC));
      totalDist += dist;
      peerCount++;
    }

    if (peerCount === 0) return 0;
    var avgDist = totalDist / peerCount;
    // Normalize: 0 (unison) → 6 (tritone). Map to 0-1, then weight.
    return (avgDist / 6) * REGISTER_COMP_WEIGHT;
  }

  // Density complementarity: sparse when peers are dense, dense when peers rest
  function _densityComplementarity(observer) {
    var peerDensitySum = 0;
    var peerCount = 0;
    for (var i = 0; i < ALL_PEERS.length; i++) {
      var peer = ALL_PEERS[i];
      if (peer === observer) continue;
      var m = _models[peer];
      if (!m) continue;
      peerDensitySum += m.densityEMA;
      peerCount++;
    }
    if (peerCount === 0) return 0;
    var avgPeerDensity = peerDensitySum / peerCount;

    // High peer density → bonus for this voice to be sparse (negative score for dense phrases)
    // Low peer density → bonus for this voice to be dense
    // Return value is added to sparse phrases when peers are dense, so it's always a positive bonus
    // for phrases that complement the ensemble density.
    // Map: peer density 0→0 bonus, peer density 3+→full bonus
    var densityPressure = Math.min(1.0, avgPeerDensity / 3.0);
    return densityPressure * DENSITY_COMP_WEIGHT;
  }

  // Figure-ground: ground roles get continuation bonus when figure roles vary
  function _figureGroundBonus(observer) {
    var isGround = (observer === 'bass' || observer === 'rhythm');
    var figureVoices = isGround ? ['soloist', 'lead'] : ['bass', 'rhythm'];
    var groundVoices = isGround ? ['bass', 'rhythm'] : ['soloist', 'lead'];

    // How much are figure voices varying? (low repetition = high variation)
    var figureVariation = 0;
    var figureCount = 0;
    for (var i = 0; i < figureVoices.length; i++) {
      var m = _models[figureVoices[i]];
      if (m) {
        figureVariation += (1.0 - m.repetitionScore);
        figureCount++;
      }
    }
    if (figureCount === 0) return 0;
    figureVariation /= figureCount;

    if (isGround) {
      // Ground role: when figure is varying, bonus for maintaining repetition (continuation)
      // The caller (scoreLexiconEntry) will apply this as bonus to repetitive/continuation phrases
      return figureVariation * FIGUREGROUND_WEIGHT;
    } else {
      // Figure role: when ground is stable, bonus for varying
      var groundStability = 0;
      var groundCount = 0;
      for (var i = 0; i < groundVoices.length; i++) {
        var m = _models[groundVoices[i]];
        if (m) {
          groundStability += m.repetitionScore;
          groundCount++;
        }
      }
      groundStability = groundCount > 0 ? groundStability / groundCount : 0;
      return groundStability * FIGUREGROUND_WEIGHT;
    }
  }

  // ── Anticipatory spacing ──
  function _getAnticipatedSpace(observer) {
    // Find nearest predicted peer entry: peer with high density trend + low current density
    var minTimeToEntry = SPACE_PREDICTION_HORIZON_MS;

    for (var i = 0; i < ALL_PEERS.length; i++) {
      var peer = ALL_PEERS[i];
      if (peer === observer) continue;
      var m = _models[peer];
      if (!m) continue;

      // If peer is currently silent but density trend is rising → about to enter
      if (m.densityEMA < 0.5 && m.densityTrend > 0.01) {
        // Estimate time to entry from trend slope
        // Rough: needs density ~1.0 to enter, currently at densityEMA
        var needed = 1.0 - m.densityEMA;
        var ratePerSec = m.densityTrend * 2; // trend is per-tick (500ms), convert to per-sec
        if (ratePerSec > 0) {
          var timeMs = (needed / ratePerSec) * 1000;
          if (timeMs < minTimeToEntry) minTimeToEntry = timeMs;
        }
      }

      // If peer's phrase is almost done → they'll start a new phrase soon
      if (typeof ContextIntegrator !== 'undefined') {
        var progress = ContextIntegrator.getPhraseProgress(peer);
        if (progress > 0.8 && progress < 1.0) {
          // ~20% left in phrase. Estimate remaining time.
          var remainingFrac = 1.0 - progress;
          // Assume phrases are ~2-4s. Conservative: 500ms until new phrase.
          var estRemaining = Math.max(300, remainingFrac * 3000);
          if (estRemaining < minTimeToEntry) minTimeToEntry = estRemaining;
        }
      }
    }

    return minTimeToEntry;
  }

  // ═══ FGSR: Feature-Gated Selective Response ═══

  // Update slow EMAs and detect feature surprises for a peer
  function _updateFGSR(m, density, contour) {
    // 1. Update slow EMAs
    m.densityEMA_slow = m.densityEMA_slow * (1 - DENSITY_SLOW_ALPHA) + density * DENSITY_SLOW_ALPHA;
    m.registerEMA_slow = m.registerEMA_slow * (1 - REGISTER_SLOW_ALPHA) + m.centerPC * REGISTER_SLOW_ALPHA;
    m.contourEMA_slow = m.contourEMA_slow * (1 - CONTOUR_SLOW_ALPHA) + contour * CONTOUR_SLOW_ALPHA;

    // 2. Tension: from MelodicExpectancy IC (normalized 0-1) or default 0.5
    var tension = 0.5;
    // MelodicExpectancy doesn't expose per-peer IC directly; use contour + density proxy
    // High density + positive contour ≈ high tension (Farbood 2012 onset density)
    tension = Math.min(1.0, (density / 4.0) * 0.5 + Math.abs(contour) * 0.5);
    m.tensionEMA = m.tensionEMA * (1 - TENSION_EMA_ALPHA) + tension * TENSION_EMA_ALPHA;

    // 3. Detect feature surprises: fast value deviates from slow EMA
    var features = [
      { key: 'energy',   fast: m.densityEMA,  slow: m.densityEMA_slow, thresh: SURPRISE_THRESH_ENERGY },
      { key: 'register', fast: m.centerPC,     slow: m.registerEMA_slow, thresh: SURPRISE_THRESH_REGISTER, circular: true },
      { key: 'contour',  fast: m.contourEMA,   slow: m.contourEMA_slow,  thresh: SURPRISE_THRESH_CONTOUR },
      { key: 'tension',  fast: tension,         slow: m.tensionEMA,       thresh: SURPRISE_THRESH_TENSION }
    ];

    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      var dev;
      if (f.circular) {
        // Circular distance for PC (0-11)
        dev = Math.min(Math.abs(f.fast - f.slow), 12 - Math.abs(f.fast - f.slow));
      } else {
        dev = Math.abs(f.fast - f.slow);
      }

      var adaptedThresh = f.thresh * m.surpriseHabituation[f.key];
      if (dev > adaptedThresh) {
        m.featureSurprise[f.key] = true;
        // Habituate: raise threshold for consecutive surprises
        m.surpriseHabituation[f.key] = Math.min(3.0, m.surpriseHabituation[f.key] + HABITUATION_RISE);
      } else {
        m.featureSurprise[f.key] = false;
        // Decay habituation back toward 1.0
        if (m.surpriseHabituation[f.key] > 1.0) {
          m.surpriseHabituation[f.key] = Math.max(1.0, m.surpriseHabituation[f.key] - HABITUATION_DECAY);
        }
      }
    }
  }

  // Get active feature surprises for peers the observer attends to
  function _getFeatureSurprises(observer) {
    var attention = (typeof PEER_ATTENTION !== 'undefined') ? PEER_ATTENTION[observer] : null;
    if (!attention) return {};
    var result = {};
    var peers = Object.keys(attention);
    for (var i = 0; i < peers.length; i++) {
      var peer = peers[i];
      var m = _models[peer];
      if (!m) continue;
      var peerAttn = attention[peer];
      var surprises = {};
      var hasAny = false;
      var featureKeys = ['energy', 'register', 'contour', 'tension'];
      for (var f = 0; f < featureKeys.length; f++) {
        var feat = featureKeys[f];
        if ((peerAttn[feat] || 0) > 0.1 && m.featureSurprise[feat]) {
          surprises[feat] = true;
          hasAny = true;
        }
      }
      if (hasAny) result[peer] = surprises;
    }
    return result;
  }

  // v8.6.0: Get feature surprise magnitude per peer (continuous 0-1, not binary)
  // Replaces brute-force density reads with confidence-weighted surprise magnitude.
  // magnitude = |fast - slow| / (threshold × habituation), clamped 0-1
  function _getFeatureSurpriseMagnitudes(observer) {
    var attention = (typeof PEER_ATTENTION !== 'undefined') ? PEER_ATTENTION[observer] : null;
    if (!attention) return {};
    var result = {};
    var peers = Object.keys(attention);
    for (var i = 0; i < peers.length; i++) {
      var peer = peers[i];
      var m = _models[peer];
      if (!m) continue;
      var peerAttn = attention[peer];
      var mags = {};
      var features = [
        { key: 'energy',   fast: m.densityEMA,  slow: m.densityEMA_slow, thresh: SURPRISE_THRESH_ENERGY },
        { key: 'register', fast: m.centerPC,     slow: m.registerEMA_slow, thresh: SURPRISE_THRESH_REGISTER, circular: true },
        { key: 'contour',  fast: m.contourEMA,   slow: m.contourEMA_slow,  thresh: SURPRISE_THRESH_CONTOUR },
        { key: 'tension',  fast: 0.5,            slow: m.tensionEMA,       thresh: SURPRISE_THRESH_TENSION }
      ];
      for (var f = 0; f < features.length; f++) {
        var feat = features[f];
        if ((peerAttn[feat.key] || 0) <= 0.1) continue;
        var dev;
        if (feat.circular) {
          dev = Math.min(Math.abs(feat.fast - feat.slow), 12 - Math.abs(feat.fast - feat.slow));
        } else {
          dev = Math.abs(feat.fast - feat.slow);
        }
        var adaptedThresh = feat.thresh * (m.surpriseHabituation[feat.key] || 1.0);
        // Continuous magnitude: 0 at no deviation, 1 at threshold, >1 for strong surprise
        var mag = (adaptedThresh > 0) ? Math.min(1.0, dev / adaptedThresh) : 0;
        // Weight by attention
        mags[feat.key] = +(mag * (peerAttn[feat.key] || 0)).toFixed(3);
      }
      result[peer] = mags;
    }
    return result;
  }

  // v8.6.0: Get energy direction for a peer (rising = positive, falling = negative)
  // Used by rhythm to distinguish "soloist getting denser" from "soloist getting sparser"
  function _getEnergyDirection(peer) {
    var m = _models[peer];
    if (!m) return 0;
    return m.densityEMA - m.densityEMA_slow; // positive = rising, negative = falling
  }

  // v8.6.0: Per-drum density surprise — fast update for tight drum-rhythm coupling
  // Called from tick() at the same rate as PeerModel tick (500ms) but can also be
  // called more frequently via drumTick() from the rhythm assistant's postGap.
  function _updateDrumDensity() {
    if (typeof ContextIntegrator === 'undefined' || !ContextIntegrator.getDrumDensity) return;
    for (var i = 0; i < _DRUM_NAMES.length; i++) {
      var drumName = _DRUM_NAMES[i];
      var density = ContextIntegrator.getDrumDensity(drumName);
      var dm = _drumDensityModels[drumName];
      if (!dm) { dm = _initDrumDensityModel(); _drumDensityModels[drumName] = dm; }

      dm.fast = dm.fast * (1 - DRUM_DENSITY_ALPHA) + density * DRUM_DENSITY_ALPHA;
      dm.slow = dm.slow * (1 - DRUM_DENSITY_SLOW_ALPHA) + density * DRUM_DENSITY_SLOW_ALPHA;

      var dev = Math.abs(dm.fast - dm.slow);
      var adaptedThresh = DRUM_SURPRISE_THRESH * dm.habituation;
      dm.magnitude = (adaptedThresh > 0) ? Math.min(1.0, dev / adaptedThresh) : 0;

      if (dev > adaptedThresh) {
        dm.surprise = true;
        dm.habituation = Math.min(3.0, dm.habituation + HABITUATION_RISE);
      } else {
        dm.surprise = false;
        if (dm.habituation > 1.0) {
          dm.habituation = Math.max(1.0, dm.habituation - HABITUATION_DECAY);
        }
      }
    }
  }

  function _getDrumSurprise(drumName) {
    var dm = _drumDensityModels[drumName];
    if (!dm) return { surprise: false, magnitude: 0, density: 0 };
    return { surprise: dm.surprise, magnitude: dm.magnitude, density: dm.fast };
  }

  // Score a candidate phrase's fit to active peer feature surprises.
  // Returns 0.00 to FGSR_MAX_BONUS (0.10).
  // Response is complementary by default (Sawyer 2003: imitation → groupthink).
  function _getPeerFeatureResponse(observer, entrySD, key) {
    var surprises = _getFeatureSurprises(observer);
    var surprisedPeers = Object.keys(surprises);
    if (surprisedPeers.length === 0) {
      _lastFeatureResponse[observer] = 0;
      return 0;
    }

    var attention = (typeof PEER_ATTENTION !== 'undefined') ? PEER_ATTENTION[observer] : null;
    if (!attention) return 0;

    // Get dialogue stance for response mediation
    var stanceModifier = 1.0;
    if (typeof DialogueEngine !== 'undefined') {
      var stance = DialogueEngine.getStance(observer);
      var stanceType = (stance && (stance.stance || stance.type)) || 'support';
      if (stanceType === 'lead') stanceModifier = 0.0;        // ignore peers when leading
      else if (stanceType === 'question' || stanceType === 'contradict') stanceModifier = 0.5;
      else if (stanceType === 'extend') stanceModifier = 0.7;
      // agree/support: 1.0 (default)
    }

    if (stanceModifier === 0) {
      _lastFeatureResponse[observer] = 0;
      return 0;
    }

    // Compute phrase properties for scoring
    var phraseLen = (entrySD && entrySD.length) || 0;
    var phraseContour = 0;
    var phraseCenter = 6;
    if (entrySD && phraseLen >= 2) {
      phraseContour = entrySD[phraseLen - 1] - entrySD[0];  // positive = ascending
      var sum = 0;
      for (var k = 0; k < phraseLen; k++) sum += (entrySD[k] % 12 + 12) % 12;
      phraseCenter = sum / phraseLen;
    }

    var totalScore = 0;
    var isGround = (observer === 'bass' || observer === 'rhythm' || observer === 'percussion');

    for (var i = 0; i < surprisedPeers.length; i++) {
      var peer = surprisedPeers[i];
      var peerSurp = surprises[peer];
      var peerAttn = attention[peer];
      var m = _models[peer];
      if (!m || !peerAttn) continue;

      // Energy surprise: complement density
      if (peerSurp.energy && (peerAttn.energy || 0) > 0.1) {
        var energyRising = m.densityEMA > m.densityEMA_slow;
        // If peer getting denser, prefer sparser phrases (shorter)
        var energyFit = energyRising ? (1.0 - phraseLen / 10.0) : (phraseLen / 10.0);
        energyFit = Math.max(0, Math.min(1, energyFit));
        totalScore += energyFit * peerAttn.energy * 0.03;
      }

      // Register surprise: anti-collision (Peter Hook model)
      if (peerSurp.register && (peerAttn.register || 0) > 0.1) {
        var peerRegisterDir = m.centerPC - m.registerEMA_slow;  // positive = moving up
        // Move opposite direction: if peer went up, prefer lower phrases
        var regFit = (peerRegisterDir > 0) ? (1.0 - phraseCenter / 11.0) : (phraseCenter / 11.0);
        regFit = Math.max(0, Math.min(1, regFit));
        totalScore += regFit * peerAttn.register * 0.03;
      }

      // Contour surprise: complementary direction (counterpoint)
      // Capped at 25% probability (Frieler 2016)
      if (peerSurp.contour && (peerAttn.contour || 0) > 0.1) {
        if (Math.random() < FGSR_L2_GATE) {
          var peerContourDir = m.contourEMA > 0 ? 1 : -1;
          // Bonus for opposite contour (counterpoint)
          var contourFit = (peerContourDir > 0 && phraseContour < 0) ? 1.0 :
                           (peerContourDir < 0 && phraseContour > 0) ? 1.0 : 0.2;
          totalScore += contourFit * peerAttn.contour * 0.03;
        }
      }

      // Tension surprise: role-dependent response
      if (peerSurp.tension && (peerAttn.tension || 0) > 0.1) {
        var tensionRising = m.tensionEMA > 0.55;
        var tensionFit;
        if (isGround) {
          // Ground roles stabilize: bonus for root-anchored, shorter phrases
          tensionFit = tensionRising ? (1.0 - phraseLen / 10.0) : 0.5;
        } else {
          // Figure roles can ride tension: bonus for longer phrases when tension rises
          tensionFit = tensionRising ? (phraseLen / 10.0) : 0.5;
        }
        tensionFit = Math.max(0, Math.min(1, tensionFit));
        totalScore += tensionFit * peerAttn.tension * 0.03;
      }
    }

    // Apply stance and attention modifier, clamp
    totalScore *= stanceModifier * _attentionModifier;
    totalScore = Math.min(FGSR_MAX_BONUS, Math.max(0, totalScore));

    _lastFeatureResponse[observer] = totalScore;
    return totalScore;
  }

  // Dynamic attention modulation: convergence detection + density modulation
  function _updateAttentionModifiers() {
    // 1. Convergence: average register overlap between active voice pairs
    var totalOverlap = 0;
    var pairCount = 0;
    for (var i = 0; i < VOICES.length; i++) {
      var mi = _models[VOICES[i]];
      if (!mi || mi.lastDensity < 0.3) continue;
      for (var j = i + 1; j < VOICES.length; j++) {
        var mj = _models[VOICES[j]];
        if (!mj || mj.lastDensity < 0.3) continue;
        var dist = Math.min(Math.abs(mi.centerPC - mj.centerPC),
                            12 - Math.abs(mi.centerPC - mj.centerPC));
        // overlap: 0 (unison) → 1.0, 6 (tritone) → 0.0
        totalOverlap += 1.0 - (dist / 6.0);
        pairCount++;
      }
    }
    _convergenceLevel = pairCount > 0 ? totalOverlap / pairCount : 0;

    // 2. Compute modifier
    var mod = 1.0;

    // Convergence cooldown: reduce attention for 8 ticks (~4s) after convergence detected
    if (_convergenceLevel > 0.60) {
      _convergenceCooldownTicks = 8;   // 4 seconds at 500ms tick
    }
    if (_convergenceCooldownTicks > 0) {
      mod *= 0.6;
      _convergenceCooldownTicks--;
    }

    // Density modulation — threshold calibrated for 5-voice ensemble (~4-6 nps normal)
    var totalDensity = 0;
    if (typeof ContextIntegrator !== 'undefined') {
      var snap = ContextIntegrator.getEnsembleSnapshot();
      if (snap) totalDensity = snap.totalDensity || 0;
    }
    if (totalDensity > 5.0) mod *= 0.7;       // very high density → self-monitoring priority
    else if (totalDensity < 1.5) mod *= 1.2;   // sparse → more responsive

    _attentionModifier = Math.max(0.3, Math.min(1.5, mod));
  }

  // Listening diagnostics for arc testing and MusicMetrics
  function _getListeningDiagnostics(voice) {
    var surprises = _getFeatureSurprises(voice);
    var attention = (typeof PEER_ATTENTION !== 'undefined') ? PEER_ATTENTION[voice] : {};
    var attended = [];
    var peers = Object.keys(attention);
    for (var i = 0; i < peers.length; i++) {
      attended.push({
        peer: peers[i],
        features: attention[peers[i]],
        surpriseActive: surprises[peers[i]] || null
      });
    }
    return {
      attendedPeers: attended,
      convergenceLevel: +_convergenceLevel.toFixed(3),
      attentionModifier: +_attentionModifier.toFixed(3),
      featureResponseScore: +(_lastFeatureResponse[voice] || 0).toFixed(4)
    };
  }

  // ── Main tick ──
  function tick(dt) {
    _accumMs += dt;
    if (_accumMs < TICK_INTERVAL_MS) return;
    _accumMs -= TICK_INTERVAL_MS;

    // Update all peer models
    for (var i = 0; i < ALL_PEERS.length; i++) {
      _updatePeer(ALL_PEERS[i]);
    }

    // Compute ensemble variation budget
    _computeEnsembleVariation();

    // v8.6.0: Per-drum density tracking (for FGSR density control)
    _updateDrumDensity();

    // FGSR: Update dynamic attention modulation (convergence + density)
    _updateAttentionModifiers();
  }

  // ── Public API ──

  function getPeerPrediction(observer, peer) {
    var m = _models[peer];
    if (!m) return null;
    return {
      nextDensityEstimate: Math.min(1.0, m.densityEMA / 3.0), // normalize to 0-1
      pitchTendency: { centerPC: m.centerPC, spread: m.spread },
      intentPhase: m.inferredPhase,
      repetitionScore: m.repetitionScore,
      anticipatedSilence: (Date.now() - m.lastNoteTime > 3000) ?
        SPACE_PREDICTION_HORIZON_MS : Math.max(0, SPACE_PREDICTION_HORIZON_MS - (Date.now() - m.lastNoteTime))
    };
  }

  function getEnsembleVariation() {
    return _ensembleVariation;
  }

  function getComplementaryBonus(observer, entrySD, key) {
    var bonus = 0;
    bonus += _registerComplementarity(observer, entrySD);
    bonus += _densityComplementarity(observer);
    bonus += _figureGroundBonus(observer);
    return bonus;
  }

  function getAnticipatedSpace(observer) {
    return _getAnticipatedSpace(observer);
  }

  function getDiagnostics() {
    var diag = {};
    for (var i = 0; i < ALL_PEERS.length; i++) {
      var p = ALL_PEERS[i];
      var m = _models[p];
      if (!m) continue;
      diag[p] = {
        densityEMA: +m.densityEMA.toFixed(3),
        densityTrend: +m.densityTrend.toFixed(4),
        centerPC: m.centerPC,
        spread: m.spread,
        contourEMA: +m.contourEMA.toFixed(3),
        inferredPhase: m.inferredPhase,
        repetitionScore: +m.repetitionScore.toFixed(3),
        patternMatchCount: m.patternMatchCount,
        // FGSR slow EMAs
        densityEMA_slow: +m.densityEMA_slow.toFixed(3),
        registerEMA_slow: +m.registerEMA_slow.toFixed(2),
        contourEMA_slow: +m.contourEMA_slow.toFixed(3),
        tensionEMA: +m.tensionEMA.toFixed(3),
        featureSurprise: Object.assign({}, m.featureSurprise),
        surpriseHabituation: {
          energy: +m.surpriseHabituation.energy.toFixed(2),
          register: +m.surpriseHabituation.register.toFixed(2),
          contour: +m.surpriseHabituation.contour.toFixed(2),
          tension: +m.surpriseHabituation.tension.toFixed(2)
        }
      };
    }
    diag.ensemble = _ensembleVariation;
    diag.fgsr = {
      attentionModifier: +_attentionModifier.toFixed(3),
      convergenceLevel: +_convergenceLevel.toFixed(3),
      convergenceCooldown: _convergenceCooldownTicks,
      lastFeatureResponse: {}
    };
    for (var lr = 0; lr < VOICES.length; lr++) {
      diag.fgsr.lastFeatureResponse[VOICES[lr]] = +(_lastFeatureResponse[VOICES[lr]] || 0).toFixed(4);
    }
    return diag;
  }

  function reset() {
    _accumMs = 0;
    _ensembleVariation = { budget: 1.0, variationNeeded: false, suggestedVarier: null };
    _attentionModifier = 1.0;
    _convergenceLevel = 0;
    _convergenceCooldownTicks = 0;
    _lastFeatureResponse = {};
    _drumDensityModels = {};
    for (var di = 0; di < _DRUM_NAMES.length; di++) {
      _drumDensityModels[_DRUM_NAMES[di]] = _initDrumDensityModel();
    }
    _init();
  }

  // ── Bootstrap ──
  _init();
  for (var _dbi = 0; _dbi < _DRUM_NAMES.length; _dbi++) {
    _drumDensityModels[_DRUM_NAMES[_dbi]] = _initDrumDensityModel();
  }

  // Listen to noteProduced for more precise timing tracking
  if (typeof EventBus !== 'undefined') {
    EventBus.on('noteProduced', function(data) {
      var voice = data.voiceName || data.voice;
      if (voice && _models[voice]) {
        _models[voice].lastNoteTime = Date.now();
      }
    });
  }

  return {
    tick: tick,
    getPeerPrediction: getPeerPrediction,
    getEnsembleVariation: getEnsembleVariation,
    getComplementaryBonus: getComplementaryBonus,
    getAnticipatedSpace: getAnticipatedSpace,
    getDiagnostics: getDiagnostics,
    reset: reset,
    // FGSR: Feature-Gated Selective Response (v8.3)
    getFeatureSurprises: _getFeatureSurprises,
    getPeerFeatureResponse: _getPeerFeatureResponse,
    getListeningDiagnostics: _getListeningDiagnostics,
    // v8.6.0: Continuous surprise magnitude + per-drum density
    getFeatureSurpriseMagnitudes: _getFeatureSurpriseMagnitudes,
    getEnergyDirection: _getEnergyDirection,
    getDrumSurprise: _getDrumSurprise,
    // v5 Phase 6: Pre-seed human model from LTM session history
    applyWarmStart: function(humanProfile) {
      if (!humanProfile) return;
      var m = _models.human;
      if (!m) return;
      m.densityEMA = humanProfile.density || 0;
      m.centerPC = Math.round(((humanProfile.registerMin || 60) + (humanProfile.registerMax || 72)) / 2) % 12;
      m.inferredPhase = 'grounding';
    }
  };

})();

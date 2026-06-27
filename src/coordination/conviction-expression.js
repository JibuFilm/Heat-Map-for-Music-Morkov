// ═══════════════════════════════════════════════════════════════
// ConvictionExpression — Belief Conviction → Audible Expression (v9.1.0)
// ═══════════════════════════════════════════════════════════════
// Makes conviction AUDIBLE. A convinced bass sounds grounded and
// legato. A searching soloist sounds tentative and staccato. The
// contrast between them creates emotional depth.
//
// Reads BeliefState.getParams(voice).dominantProb as the conviction
// signal, normalizes per-role, and outputs expression modifiers that
// shape articulation, velocity dynamics, and timbral warmth.
//
// This is NOT a new belief dimension — it surfaces the existing
// conviction signal into the audible domain.
//
// Psychoacoustic basis:
//   Juslin 2003 — GERMS model: conviction maps to articulation + dynamics.
//     High certainty → legato, louder, less timing variability.
//     Low certainty → staccato, softer, more variable.
//   Eerola et al. 2013 — Emotional expression correlates with spectral
//     centroid (brightness), attack time, and dynamic range.
//   Gabrielsson & Lindstrom 2010 — Confident = bright timbre, firm attacks.
//     Tentative = muted timbre, soft attacks, longer IOIs.
//   Palmer 1997 — Expressive timing deviations are larger for uncertain
//     passages (higher velocity variance when searching).
//
// Depends on: belief-state.js (BeliefState.getParams)
// Load order: after peer-velocity.js, before peer-model.js
// ═══════════════════════════════════════════════════════════════

'use strict';

var ConvictionExpression = (function() {

  // ── Per-voice smoothed conviction (0 = searching, 1 = certain) ──
  var _conviction = { bass: 0.5, rhythm: 0.5, soloist: 0.5, lead: 0.5, percussion: 0.5 };

  // Smoothing rate: slower than DialogueEngine (0.12) for musical stability.
  // ~16 ticks to reach 90% of target. Conviction should feel like a slow
  // emotional shift, not a reactive jump.
  var SMOOTH_RATE = 0.06;

  // ── Normalization ranges ──
  // Derived from per-role MAX_CONC ceilings (belief-state.js line 1082-1088)
  // and observed equilibrium values. Maps raw dominantProb onto 0-1 where
  // small raw changes produce proportional normalized swings.
  // A bass dropping from 0.85 to 0.65 is a dramatic event (normalized: ~0.78→0.16).
  var NORM_RANGE = {
    bass:       { min: 0.60, max: 0.92 },   // equilibrium ~0.848
    rhythm:     { min: 0.55, max: 0.88 },   // equilibrium ~0.80
    soloist:    { min: 0.45, max: 0.78 },   // equilibrium ~0.722
    lead:       { min: 0.50, max: 0.82 },   // equilibrium ~0.76
    percussion: { min: 0.50, max: 0.85 }    // equilibrium ~0.78
  };

  // ── Per-role expression profiles ──
  // Maps conviction (0-1) to audible parameters via linear interpolation.
  // [lowConviction, highConviction] for each parameter.
  //
  // dur:      Duration multiplier (staccato ↔ legato)
  // vel:      Velocity multiplier (soft ↔ confident)
  // variance: Velocity randomness (exploratory ↔ steady)
  // filter:   Filter frequency multiplier (muted ↔ open)
  var PROFILES = {
    bass: {
      dur:      [0.82, 1.12],   // low: shorter (tentative), high: sustained (grounded)
      vel:      [0.88, 1.08],   // low: softer, high: confident
      variance: [0.07, 0.02],   // low: more varied (Palmer 1997), high: steady
      filter:   [0.88, 1.08]    // low: warmer/muffled, high: full/open
    },
    rhythm: {
      dur:      [0.92, 1.04],   // narrow: groove voice, steady articulation
      vel:      [0.94, 1.01],   // near-neutral: rhythm conviction is consistently high
      variance: [0.04, 0.02],
      filter:   [0.95, 1.02]    // minimal timbral shift
    },
    soloist: {
      dur:      [0.72, 1.04],   // widest range: very staccato when searching
      vel:      [0.78, 1.04],   // much softer when uncertain
      variance: [0.10, 0.03],   // high variance when exploring (Gabrielsson 2010)
      filter:   [0.78, 1.12]    // thin/breathy when searching, brilliant when certain
    },
    lead: {
      dur:      [0.78, 1.08],
      vel:      [0.82, 1.06],
      variance: [0.08, 0.03],
      filter:   [0.82, 1.10]
    },
    percussion: {
      dur:      [0.92, 1.04],   // narrow range: percussion always confident
      vel:      [0.94, 1.04],
      variance: [0.03, 0.01],
      filter:   [0.96, 1.04]
    }
  };

  // ── Tick: read conviction from BeliefState, smooth toward it ──
  function tick(dt) {
    if (typeof BeliefState === 'undefined' || !BeliefState.getParams) return;

    var voices = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      var params = BeliefState.getParams(v);
      var raw = (params && params.dominantProb) ? params.dominantProb : 0.5;

      // Normalize to 0-1 using per-role range
      var range = NORM_RANGE[v] || { min: 0.5, max: 0.85 };
      var norm = (raw - range.min) / (range.max - range.min);
      norm = Math.max(0, Math.min(1, norm));

      // Smooth toward normalized target
      _conviction[v] += (norm - _conviction[v]) * SMOOTH_RATE;
    }
  }

  // ── Get expression modifiers for computeExpression hook ──
  function getExpressionMod(voiceName) {
    var c = _conviction[voiceName];
    if (c === undefined) c = 0.5;
    var profile = PROFILES[voiceName] || PROFILES.rhythm;

    return {
      velocityMult: _lerp(profile.vel[0], profile.vel[1], c),
      durationMult: _lerp(profile.dur[0], profile.dur[1], c),
      velocityVariance: _lerp(profile.variance[0], profile.variance[1], c)
    };
  }

  // ── Get filter frequency multiplier for TimbralEvolution ──
  function getFilterMod(voiceName) {
    var c = _conviction[voiceName];
    if (c === undefined) c = 0.5;
    var profile = PROFILES[voiceName] || PROFILES.rhythm;
    return _lerp(profile.filter[0], profile.filter[1], c);
  }

  // ── Get raw conviction (for diagnostics / other modules) ──
  function getConviction(voiceName) {
    return _conviction[voiceName] !== undefined ? _conviction[voiceName] : 0.5;
  }

  function getAll() {
    return {
      bass: +_conviction.bass.toFixed(3),
      rhythm: +_conviction.rhythm.toFixed(3),
      soloist: +_conviction.soloist.toFixed(3),
      lead: +_conviction.lead.toFixed(3),
      percussion: +_conviction.percussion.toFixed(3)
    };
  }

  function reset() {
    var voices = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
    for (var i = 0; i < voices.length; i++) {
      _conviction[voices[i]] = 0.5;
    }
  }

  // ── Utility ──
  function _lerp(a, b, t) {
    return a + (b - a) * t;
  }

  return {
    tick:             tick,
    getExpressionMod: getExpressionMod,
    getFilterMod:     getFilterMod,
    getConviction:    getConviction,
    getAll:           getAll,
    reset:            reset
  };

})();

console.log('%cConvictionExpression loaded (Juslin 2003 GERMS)', 'color:#f9a;font-family:monospace');

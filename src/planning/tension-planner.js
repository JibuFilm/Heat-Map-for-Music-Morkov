'use strict';
// ═══ TENSION PLANNER (VP2 — Ensemble-Aware Tension Suggestions) ═══
//
// Second viewpoint for per-voice tension curves. Reads ensemble context
// from ContextIntegrator and produces a tension suggestion for each voice.
// Each assistant blends this with its own VP1 (internal desire/patience)
// to produce the final tension value that gates phrase generation.
//
// This module SUGGESTS — it never commands. Each voice's persona has final say.
//
// Update: called from app.js tick, after ContextIntegrator.update() but before
//         assistant onTick() calls.
//
// Query:  TensionPlanner.getSuggestion(voice) → 0.0 to 1.0
//         TensionPlanner.getSuggestions() → { bass, rhythm, soloist }
//
// Design principles (from research):
//   - Cypher inverse relation: when others are dense, suggest lower tension
//   - Musebot density accounting: respect a global density budget
//   - Conversational turn-taking: voices that just finished should breathe
//   - Section awareness: BUILD → rising curves, RELEASE → falling curves
//   - No authority: suggestions are weighted 0.45, voice persona is 0.55

var TensionPlanner = (function() {

  // Per-voice suggestion state
  var suggestions = { bass: 0.5, rhythm: 0.5, soloist: 0.5 };

  // Smoothing — don't jump, glide toward targets
  var SMOOTH_RATE = 0.12;  // how fast suggestions track targets (0=frozen, 1=instant)

  // ── tick() — called each frame from app.js ──
  function tick(dt) {
    var ensemble = null;
    if (typeof ContextIntegrator !== 'undefined' &&
        typeof ContextIntegrator.getEnsembleSnapshot === 'function') {
      ensemble = ContextIntegrator.getEnsembleSnapshot();
    }

    var section = { state: 'STABLE', energy: 0.3, density: 0.4 };
    if (typeof SectionTracker !== 'undefined') {
      section = SectionTracker.getState();
    }

    var voices = ['bass', 'rhythm', 'soloist'];
    for (var i = 0; i < voices.length; i++) {
      var target = _computeTarget(voices[i], ensemble, section);
      // Exponential smoothing toward target
      suggestions[voices[i]] += (target - suggestions[voices[i]]) * SMOOTH_RATE;
      // Clamp
      suggestions[voices[i]] = Math.max(0, Math.min(1, suggestions[voices[i]]));
    }
  }

  // ── _computeTarget() — raw tension target for a voice ──
  function _computeTarget(voice, ensemble, section) {
    var target = 0.5;  // neutral baseline

    // ──────────────────────────────────
    // Factor 1: Section state (weight 0.30)
    // ──────────────────────────────────
    var sectionTension = 0.5;
    switch (section.state) {
      case 'STABLE':     sectionTension = 0.35; break;
      case 'BUILD':      sectionTension = 0.5 + section.energy * 0.4; break;
      case 'PEAK':       sectionTension = 0.8 + section.energy * 0.2; break;
      case 'RELEASE':    sectionTension = 0.3 - section.energy * 0.15; break;
      case 'TRANSITION': sectionTension = 0.2; break;
    }

    // ──────────────────────────────────
    // Factor 2: Inverse peer density (weight 0.30)
    // Cypher principle — when peers are dense, pull back
    // ──────────────────────────────────
    var inverseDensity = 0.5;
    if (ensemble) {
      var myDensity = ensemble.voiceDensities[voice] || 0;
      var peerDensity = 0;
      var peerCount = 0;
      var allVoices = ['bass', 'rhythm', 'soloist'];
      for (var i = 0; i < allVoices.length; i++) {
        if (allVoices[i] !== voice) {
          peerDensity += ensemble.voiceDensities[allVoices[i]] || 0;
          peerCount++;
        }
      }
      var avgPeerDensity = peerCount > 0 ? peerDensity / peerCount : 0;

      // High peer density → low suggestion for me (inverse relation)
      // avgPeerDensity of 0 nps → inverseDensity = 0.8 (room to play)
      // avgPeerDensity of 3+ nps → inverseDensity = 0.15 (pull back)
      inverseDensity = Math.max(0.1, 0.8 - avgPeerDensity * 0.22);

      // But if I'm already very sparse and peers are dense, don't suppress further
      // (prevents all voices going silent simultaneously)
      if (myDensity < 0.5 && avgPeerDensity > 2) {
        inverseDensity = Math.max(inverseDensity, 0.35);
      }
    }

    // ──────────────────────────────────
    // Factor 3: Phrase phase — breathing (weight 0.20)
    // Just finished a phrase → breathe before starting new one
    // Mid-phrase → sustain tension to complete it
    // ──────────────────────────────────
    var phaseBreathing = 0.5;
    if (typeof ContextIntegrator !== 'undefined') {
      var progress = ContextIntegrator.getPhraseProgress(voice);
      if (progress >= 0.95) {
        // Between phrases — breathe
        phaseBreathing = 0.2;
      } else if (progress < 0.1) {
        // Just started — commit to it
        phaseBreathing = 0.7;
      } else if (progress > 0.7) {
        // Resolving — maintain but prepare to wind down
        phaseBreathing = 0.4;
      } else {
        // Mid-phrase — sustain
        phaseBreathing = 0.6;
      }
    }

    // ──────────────────────────────────
    // Factor 4: Ensemble relational state (weight 0.20)
    // High tension between voices → calm down (avoid mud)
    // Low tension → room to add energy
    // ──────────────────────────────────
    var relationalMod = 0.5;
    if (ensemble) {
      // intervalTension 0 (consonant) → room to add, relationalMod high
      // intervalTension 1 (dissonant) → back off, relationalMod low
      relationalMod = 0.7 - ensemble.intervalTension * 0.5;

      // If all voices moving same direction, this voice could diverge (add interest)
      var contours = ensemble.voiceContours;
      var myContour = contours[voice];
      var peersSameDir = true;
      var allV = ['bass', 'rhythm', 'soloist'];
      for (var j = 0; j < allV.length; j++) {
        if (allV[j] !== voice && contours[allV[j]] !== myContour && contours[allV[j]] !== 0) {
          peersSameDir = false;
        }
      }
      if (peersSameDir && myContour !== 0) {
        // Everyone moving together — mild boost to break monotony
        relationalMod += 0.1;
      }
    }

    // ──────────────────────────────────
    // Blend factors
    // ──────────────────────────────────
    target = sectionTension * 0.30 +
             inverseDensity * 0.30 +
             phaseBreathing * 0.20 +
             relationalMod  * 0.20;

    // ──────────────────────────────────
    // Role-specific bias
    // Bass: slightly lower baseline (anchor, should be more consistent)
    // Soloist: slightly higher baseline (melodic, more expressive range)
    // Rhythm: neutral
    // ──────────────────────────────────
    if (voice === 'bass')   target *= 0.9;
    if (voice === 'soloist') target *= 1.1;

    return Math.max(0, Math.min(1, target));
  }

  // ── Query API ──
  function getSuggestion(voice) {
    return suggestions[voice] || 0.5;
  }

  function getSuggestions() {
    return {
      bass:   suggestions.bass,
      rhythm: suggestions.rhythm,
      soloist: suggestions.soloist
    };
  }

  function reset() {
    suggestions.bass = 0.5;
    suggestions.rhythm = 0.5;
    suggestions.soloist = 0.5;
  }

  return {
    tick:           tick,
    getSuggestion:  getSuggestion,
    getSuggestions:  getSuggestions,
    reset:          reset
  };

})();

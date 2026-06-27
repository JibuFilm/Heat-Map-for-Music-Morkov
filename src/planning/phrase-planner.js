'use strict';
// ═══ PHRASE PLANNER (Phase E — Hierarchical Prediction Integration) ═══
//
// Top-level decision layer that sits above the existing tier cascade
// (loop → lexicon → generate → PPM) and below the section tracker.
//
// The Phrase Planner answers: "What KIND of phrase should this voice
// play next?" — before the assistant's tier cascade answers "Which
// specific phrase?"
//
// It synthesizes constraints from all hierarchical layers:
//   SectionTracker  → energy, adventurousness, developmentBias
//   HarmonicPlanner → next chord targets, harmonic rhythm
//   DialogueEngine  → stance (follow/lead), temperature modifier
//   MotifDeveloper  → seed availability, development readiness
//   ContextIntegrator → peer voice states, saturation
//
// Output: a PhraseConstraint object consumed by assistant tier selection.
//
// Depends on: All Phase A-D modules, context-integrator.js, assistant-shared.js
// Load order: after dialogue-engine.js & motif-developer.js, before assistants

var PhrasePlanner = (function() {

  // ══════════════════════════════════════
  // PHRASE CONSTRAINT OBJECT
  // ══════════════════════════════════════
  //
  // {
  //   preferredTier: 'loop'|'lexicon'|'motif'|'generate'|'ppm'|null,
  //   temperature:    0.3 - 1.5 (modifies tempSample)
  //   targetLength:   suggested phrase length in notes (or null for default)
  //   chordTones:     [pc, ...] from HarmonicPlanner's next chord
  //   avoidPCs:       [pc, ...] saturated pitch classes to avoid
  //   motifOp:        suggested MotifDeveloper operation (or null)
  //   urgency:        0-1 how urgently this voice needs a new phrase
  //   stagger:        bool — should this voice delay to avoid pile-on?
  //   density:        -0.2 to 0.2 modifier on note density
  //   resolveTarget:  pc to resolve toward (or null)
  // }

  function createConstraint() {
    return {
      preferredTier: null,
      temperature: 0.7,
      targetLength: null,
      chordTones: null,
      avoidPCs: [],
      motifOp: null,
      urgency: 0.5,
      stagger: false,
      density: 0,
      resolveTarget: null,
      melodicIntent: null,     // v3 Phase 2: L2 intent name
      seedAvailable: false     // v3 Phase 2: seed phrase stored for continuation
    };
  }

  // ══════════════════════════════════════
  // PLAN FOR A SPECIFIC VOICE
  // ══════════════════════════════════════

  function planPhrase(role) {
    var c = createConstraint();
    var voiceName = role === 'rhythm' ? 'rhythm' : role;  // bass, rhythm, soloist

    // ── Section state ──
    var section = { state: 'STABLE', energy: 0.3, adventurousness: 0.2,
      density: 0.4, developmentBias: 0.3, resolutionUrgency: 0 };
    if (typeof SectionTracker !== 'undefined') {
      section = (SectionTracker.getVoiceState) ? SectionTracker.getVoiceState(role) : SectionTracker.getState();
    }

    // ── Section forecast (v5 Phase 2) ──
    var forecast = null;
    if (typeof SectionTracker !== 'undefined' && typeof SectionTracker.getForecast === 'function') {
      forecast = SectionTracker.getForecast(role);
    }

    // ── Dialogue stance ──
    var stance = { stance: 'support', initiative: 0.2, agreement: 0.8 };
    var tempMod = 0;
    var densityMod = 0;
    if (typeof DialogueEngine !== 'undefined') {
      stance = DialogueEngine.getStance(role);
      tempMod = DialogueEngine.getTemperatureModifier(role);
      densityMod = DialogueEngine.getDensityModifier(role);
    }

    // ── Harmonic targets ──
    if (typeof HarmonicPlanner !== 'undefined') {
      c.chordTones = HarmonicPlanner.getNextChordTones();

      // If we're close to a chord change, prepare resolution
      var nextChords = HarmonicPlanner.getNextChords();
      if (nextChords.length > 0 && nextChords[0].beatsAway < 2) {
        c.resolveTarget = nextChords[0].rootPC;
      }
    }

    // ── Saturation avoidance ──
    if (typeof ContextIntegrator !== 'undefined') {
      c.avoidPCs = ContextIntegrator.getSaturatedPCs();
    }

    // ── Stagger check ──
    if (typeof ContextIntegrator !== 'undefined') {
      c.stagger = ContextIntegrator.shouldStagger(voiceName);
    }

    // ══════════════════════════════════════
    // TIER PREFERENCE LOGIC
    // ══════════════════════════════════════

    // Default: no preference (let assistant's existing cascade decide)
    c.preferredTier = null;

    // STABLE + agree/support → prefer loops and lexicon (consistency)
    if (section.state === 'STABLE' && stance.agreement > 0.6) {
      c.preferredTier = 'loop';
    }

    // BUILD + extend/lead → prefer motif development (coherent evolution)
    if (section.state === 'BUILD' && section.developmentBias > 0.5) {
      if (typeof MotifDeveloper !== 'undefined' && MotifDeveloper.hasSeed(voiceName)) {
        c.preferredTier = 'motif';
      } else {
        c.preferredTier = 'lexicon';  // fallback: pick from corpus
      }
    }

    // PEAK → prefer generation or motif (maximum variety)
    if (section.state === 'PEAK') {
      if (typeof MotifDeveloper !== 'undefined' && MotifDeveloper.hasSeed(voiceName)) {
        c.preferredTier = Math.random() < 0.6 ? 'motif' : 'generate';
      } else {
        c.preferredTier = 'generate';
      }
    }

    // RELEASE → strong loop/lexicon preference (resolution, predictability)
    if (section.state === 'RELEASE') {
      c.preferredTier = section.resolutionUrgency > 0.5 ? 'loop' : 'lexicon';
      // Force resolution target to tonic
      c.resolveTarget = SharedState.keyC;
    }

    // TRANSITION → sparse PPM (minimal output during section change)
    if (section.state === 'TRANSITION') {
      c.preferredTier = 'ppm';
      c.density = -0.15;
    }

    // ── Section forecast adjustments (v5 Phase 2) ──
    // Anticipate upcoming section transitions and prepare accordingly
    if (forecast && forecast.confidence > 0.5) {
      var pred = forecast.predictedState;
      if (pred === 'PEAK' && section.state !== 'PEAK') {
        // PEAK approaching: boost urgency, prefer active tiers
        c.urgency = Math.min(1.0, c.urgency + 0.2);
        if (c.preferredTier === 'loop' || c.preferredTier === 'ppm') {
          c.preferredTier = 'lexicon'; // prepare more interesting material
        }
      } else if (pred === 'BUILD' && section.state === 'STABLE') {
        // BUILD approaching from STABLE: start warming up
        c.targetLength = Math.min(16, Math.round(c.targetLength * 1.15));
        c.temperature = Math.min(1.5, c.temperature + 0.05);
      } else if (pred === 'RELEASE' && section.state === 'PEAK') {
        // RELEASE approaching from PEAK: prepare to resolve
        c.resolveTarget = c.resolveTarget || SharedState.keyC;
        c.temperature = Math.max(0.3, c.temperature - 0.1);
      } else if (pred === 'STABLE' && section.state === 'RELEASE') {
        // STABLE approaching from RELEASE: prefer grounding tiers
        if (!c.preferredTier) c.preferredTier = 'lexicon';
      }
    }

    // ── Dialogue override: lead stance forces more active tiers ──
    if (stance.stance === 'lead' && c.preferredTier === 'loop') {
      c.preferredTier = 'lexicon';  // don't just loop when leading
    }
    if (stance.stance === 'question') {
      c.preferredTier = 'generate';  // questioning = fresh material
    }

    // ══════════════════════════════════════
    // TEMPERATURE
    // ══════════════════════════════════════

    // Base temperature from section energy
    c.temperature = 0.5 + section.energy * 0.5;  // 0.5 (calm) to 1.0 (peak)

    // Dialogue modifier — reduced proportionally when thermostat is already active.
    // The surprise thermostat inside predict() applies its own temperature adjustment.
    // To prevent double-stacking (both flatten or both sharpen), we read the thermostat's
    // current adjustment and scale back our own modifier proportionally.
    var thermostatAdj = (typeof SharedState.getTemperatureAdjust === 'function') ?
      SharedState.getTemperatureAdjust() : 0;
    // If thermostat is already pushing in the same direction as dialogue, reduce dialogue's push
    if (tempMod * thermostatAdj > 0) {
      // Same direction: reduce dialogue modifier by thermostat's contribution
      tempMod *= Math.max(0.2, 1.0 - Math.abs(thermostatAdj) * 2);
    }
    c.temperature += tempMod;

    // Role adjustment: bass is more conservative, solo more adventurous
    if (role === 'bass') c.temperature *= 0.8;
    if (role === 'soloist') c.temperature *= 1.15;

    // Clamp
    c.temperature = Math.max(0.3, Math.min(1.5, c.temperature));

    // ══════════════════════════════════════
    // PHRASE LENGTH
    // ══════════════════════════════════════

    // Section-aware: BUILD → longer phrases, RELEASE → shorter
    var gc = getGenreConfig(SharedState.genre);
    var baseLen = gc.phraseLen;

    if (section.state === 'BUILD') baseLen = Math.round(baseLen * 1.2);
    if (section.state === 'PEAK') baseLen = Math.round(baseLen * 0.9);
    if (section.state === 'RELEASE') baseLen = Math.round(baseLen * 0.7);
    if (section.state === 'TRANSITION') baseLen = Math.max(2, Math.round(baseLen * 0.5));

    // Role scaling
    if (role === 'bass') baseLen = Math.max(2, Math.round(baseLen * 0.7));
    if (role === 'soloist') baseLen = Math.round(baseLen * 1.2);

    c.targetLength = Math.max(2, Math.min(16, baseLen));

    // ══════════════════════════════════════
    // DENSITY & URGENCY
    // ══════════════════════════════════════

    c.density = densityMod + (section.density - 0.5) * 0.2;
    c.density = Math.max(-0.2, Math.min(0.2, c.density));

    // Urgency: how much does this voice need a new phrase right now?
    c.urgency = 0.5;

    // Voice between phrases → high urgency
    if (typeof ContextIntegrator !== 'undefined') {
      var progress = ContextIntegrator.getPhraseProgress(voiceName);
      if (progress >= 0.9) c.urgency = 0.8;
      if (progress >= 1.0) c.urgency = 1.0;
    }

    // Section transition → lower urgency (let things breathe)
    if (section.state === 'TRANSITION') c.urgency *= 0.5;

    // Staggering → reduce urgency to delay
    if (c.stagger) c.urgency *= 0.6;

    // ══════════════════════════════════════
    // L2 MELODIC INTENT (v3 Phase 2)
    // ══════════════════════════════════════

    if (typeof MelodicIntent !== 'undefined') {
      var intent = MelodicIntent.getIntent(role);
      c.melodicIntent = intent;
      c.seedAvailable = MelodicIntent.hasSeed(role);

      // Intent modulates existing constraint fields
      if (intent === 'continuation') {
        c.targetLength = Math.min(16, Math.round(c.targetLength * 1.4));
        if (c.seedAvailable) c.preferredTier = 'lexicon'; // reuse seed
      } else if (intent === 'punctuation') {
        c.targetLength = Math.min(3, c.targetLength);
        c.temperature = Math.max(0.3, c.temperature - 0.15);
        c.resolveTarget = c.resolveTarget || SharedState.keyC;
      } else if (intent === 'consonance') {
        c.temperature = Math.max(0.3, c.temperature - 0.10);
        c.resolveTarget = c.resolveTarget || SharedState.keyC;
      } else if (intent === 'contrast') {
        c.temperature = Math.min(1.5, c.temperature + 0.15);
        c.preferredTier = 'generate'; // fresh material
      }
    }

    return c;
  }

  // ══════════════════════════════════════
  // QUERY: should this voice replan now?
  // ══════════════════════════════════════
  // Called by assistants to decide whether to replan their current phrase.
  // Returns true if the hierarchical layers suggest replanning.

  function shouldReplan(role) {
    var voiceName = role === 'rhythm' ? 'rhythm' : role;

    // If DialogueEngine says lead and voice is idle → yes
    if (typeof DialogueEngine !== 'undefined') {
      var stance = DialogueEngine.getStance(role);
      if (stance.initiative > 0.6) {
        if (typeof ContextIntegrator !== 'undefined') {
          var prog = ContextIntegrator.getPhraseProgress(voiceName);
          if (prog >= 0.8) return true;
        }
      }
    }

    // Section just changed → voices should consider replanning
    // (handled via sectionChange event in the assistants)

    return false;
  }

  // ══════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════

  function reset() {
    // Stateless — nothing to reset (all state is in the modules we query)
  }

  return {
    planPhrase:   planPhrase,    // → PhraseConstraint for a role
    shouldReplan: shouldReplan,  // → bool
    reset:        reset
  };

})();

console.log('%cPhrasePlanner loaded', 'color:#9a4;font-family:monospace');

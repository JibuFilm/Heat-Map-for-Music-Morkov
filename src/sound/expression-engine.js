'use strict';
// ═══ EXPRESSION ENGINE (v5.1.0) ═══
//
// Computes per-note expressive techniques based on the intersection of:
//   1. Role vocabulary — what the voice WANTS to express (musical intent)
//   2. Instrument capability — what the timbre CAN express (physical validity)
//
// The engine is stateless: given a voice, MIDI note, and context, it returns
// an expression descriptor that SoundEngine.noteOn applies as audio graph
// modifications (LFO for vibrato, detune ramps for bend/portamento, envelope
// overrides for ghost/mute/swell).
//
// Expression techniques:
//   vibrato    — LFO on detune. Delayed onset (150-200ms) preserves attack clarity.
//                Depth/rate scale with section energy and mood valence.
//   portamento — detune ramp from previous pitch to current. Lead signature.
//   bend       — detune ramp from below target (approach tone). Soloist blues feel.
//   swell      — slow attack envelope. Used on phrase entries after silence.
//   ghost      — reduced velocity + shorter envelope. Rhythmic fill between beats.
//   mute       — ultra-short envelope (percussive). Rhythmic drive without harmony.
//   graceNote  — separate pre-note (30-40ms). Returned as { midi, durationSec, vol }.
//
// Probability model: each technique has a base probability that scales with
// section energy, intent state, and belief parameters. Not every eligible note
// gets expression — this prevents fatigue and preserves musical surprise.
//
// References:
//   Sundberg 1987 — expressive performance timing and dynamics
//   Friberg et al. 2006 — overview of music performance modeling
//   Palmer 1997 — music performance (timing, dynamics, articulation)
//   Bresin & Friberg 2011 — emotional expression in music performance
//
// Public API:
//   compute(voiceName, midi, opts) → expression descriptor or null
//     opts: { prevMidi, durationMs, volMult, gapBefore }
//
// Load order: after timbre-profile.js, before voice-manager.js.

var ExpressionEngine = (function() {

  // ═══ ROLE VOCABULARIES ═══
  //
  // Each role declares which expressions it wants, under what conditions,
  // with what probability, and with what parameters. The ExpressionEngine
  // intersects these desires with the instrument's TimbreProfile capabilities.

  var ROLE_VOCAB = {

    // ── Bass: gravitational anchor ──
    // Ghost notes add groove between main beats. Muted notes add percussive drive.
    // No pitch modulation — bass must be rock-solid in intonation.
    bass: {
      ghost: {
        probability: 0.18,
        condition: function(ctx) {
          return ctx.sectionEnergy > 0.5 && !ctx.isFirstInPhrase;
        }
      },
      mute: {
        probability: 0.12,
        condition: function(ctx) {
          return ctx.sectionEnergy > 0.4 && !ctx.isFirstInPhrase && !ctx.isLastInPhrase;
        }
      }
    },

    // ── Rhythm: harmonic texture ──
    // Ghost strums between main chords. Muted hits for percussive rhythm.
    // No pitch modulation — rhythm chords need clean intonation.
    rhythm: {
      ghost: {
        probability: 0.15,
        condition: function(ctx) {
          return ctx.sectionEnergy > 0.5;
        }
      },
      mute: {
        probability: 0.10,
        condition: function(ctx) {
          return ctx.sectionState === 'STABLE' && !ctx.isFirstInPhrase;
        }
      }
    },

    // ── Soloist: expressive storyteller ──
    // Vibrato on sustained notes. Bend into leaps (blues approach).
    // Grace notes as ornaments. Swell on entries after silence.
    soloist: {
      vibrato: {
        probability: 0.40,
        energyBoost: 0.18,
        condition: function(ctx) {
          return ctx.durationMs > 400;
        },
        params: function(ctx) {
          // Depth: 12-22 cents (scales with energy)
          var depth = 12 + ctx.sectionEnergy * 10;
          // Rate: ~5Hz, faster in major (brighter mood → quicker oscillation)
          var rate = 5.0 + (ctx.moodValence || 0) * 0.8;
          return { rateHz: rate, depthCents: depth, onsetDelaySec: 0.15 };
        }
      },
      bend: {
        probability: 0.22,
        condition: function(ctx) {
          // Bend into notes approached by leap (≥3 semitones)
          return ctx.interval !== null && Math.abs(ctx.interval) >= 3;
        },
        params: function(ctx) {
          // Approach from one semitone below, 50-80ms duration
          return { cents: -100, durationSec: 0.05 + Math.random() * 0.03 };
        }
      },
      grace: {
        probability: 0.15,
        condition: function(ctx) {
          return ctx.durationMs > 300 && ctx.isOnBeat;
        },
        params: function(ctx) {
          // Grace from neighbor below (70%) or above (30%)
          var offset = Math.random() < 0.7 ? -1 : 1;
          // If we have scale info, try to use a scale tone
          var graceMidi = ctx.midi + offset;
          return { midi: graceMidi, durationSec: 0.04, vol: 0.35 };
        }
      },
      swell: {
        probability: 0.25,
        condition: function(ctx) {
          return ctx.isFirstInPhrase && ctx.gapBefore > 1500;
        },
        params: function() {
          return { durationSec: 0.15 };
        }
      }
    },

    // ── Lead: sustained counterpoint ──
    // Prominent vibrato (signature). Portamento between close intervals.
    // Grace notes as ornamental turns. Swell on entries from silence.
    lead: {
      vibrato: {
        probability: 0.60,
        energyBoost: 0.15,
        condition: function(ctx) {
          return ctx.durationMs > 300;
        },
        params: function(ctx) {
          // Wider depth than soloist: 18-32 cents (lead's identity IS vibrato)
          var depth = 18 + ctx.sectionEnergy * 14;
          // Slower rate: 4.5Hz base, modulated by mood
          var rate = 4.5 + (ctx.moodValence || 0) * 0.6;
          // Longer onset delay: 200ms (let the note establish before modulation)
          return { rateHz: rate, depthCents: depth, onsetDelaySec: 0.20 };
        }
      },
      portamento: {
        probability: 0.35,
        condition: function(ctx) {
          // Glide between close intervals (1-5 semitones)
          return ctx.interval !== null &&
                 Math.abs(ctx.interval) >= 1 &&
                 Math.abs(ctx.interval) <= 5;
        },
        params: function(ctx) {
          var intervalST = ctx.interval || 0;
          // Larger intervals get slightly longer glide
          var glideSec = 0.04 + Math.abs(intervalST) * 0.015;
          // fromCents: negative interval means we're going DOWN, so previous pitch
          // is ABOVE current → positive cents offset. Vice versa.
          return { fromCents: -intervalST * 100, durationSec: glideSec };
        }
      },
      grace: {
        probability: 0.12,
        condition: function(ctx) {
          return ctx.isLastInPhrase && ctx.sectionEnergy > 0.5;
        },
        params: function(ctx) {
          // Ornamental turn on phrase endings
          var offset = Math.random() < 0.5 ? 1 : -1;
          return { midi: ctx.midi + offset, durationSec: 0.035, vol: 0.30 };
        }
      },
      swell: {
        probability: 0.30,
        condition: function(ctx) {
          return ctx.isFirstInPhrase && ctx.gapBefore > 2000;
        },
        params: function() {
          // Longer swell than soloist — lead enters gently
          return { durationSec: 0.20 };
        }
      }
    }
  };


  // ═══ MAIN COMPUTATION ═══

  function compute(voiceName, midi, opts) {
    opts = opts || {};
    var vocab = ROLE_VOCAB[voiceName];
    if (!vocab) return null;

    // Get instrument and its timbre profile capabilities
    var instName = _getInstrumentName(voiceName);
    var profileCanDo = function(expr) {
      return (typeof TimbreProfile !== 'undefined') ?
        TimbreProfile.canDo(instName, expr) : true;
    };

    // Gather musical context from globally available modules
    var ctx = _gatherContext(voiceName, midi, opts);

    var result = {};
    var hasAny = false;

    // Evaluate each expression in the role's vocabulary
    for (var exprName in vocab) {
      var def = vocab[exprName];

      // Gate 1: instrument must physically support this expression
      if (!profileCanDo(exprName)) continue;

      // Gate 2: musical condition must be met
      if (def.condition && !def.condition(ctx)) continue;

      // Gate 3: probability roll (with energy boost)
      var prob = def.probability || 0;
      if (def.energyBoost) prob += def.energyBoost * ctx.sectionEnergy;
      prob = Math.min(prob, 0.95); // never guaranteed
      if (Math.random() >= prob) continue;

      // Compute parameters
      if (def.params) {
        result[exprName] = def.params(ctx);
      } else {
        result[exprName] = true;
      }
      hasAny = true;
    }

    // ── De-conflict ──
    // bend + portamento both use detune ramps → keep portamento (more musical)
    if (result.bend && result.portamento) {
      delete result.bend;
    }
    // swell + mute are contradictory → keep mute (shorter = safer)
    if (result.swell && result.mute) {
      delete result.swell;
    }
    // ghost + mute are both envelope-level → keep ghost
    if (result.ghost && result.mute) {
      delete result.mute;
    }

    // Grace notes become a graceNote sub-object (handled differently — separate noteOn)
    if (result.grace) {
      result.graceNote = result.grace;
      delete result.grace;
    }

    return hasAny ? result : null;
  }


  // ═══ CONTEXT GATHERING ═══
  //
  // Reads from globally available modules. All checks are guarded with
  // typeof !== 'undefined' so the engine works even if modules aren't loaded.

  function _getInstrumentName(voiceName) {
    if (typeof SoundEngine !== 'undefined') {
      // getVoiceInstrument added in v5.1.0
      if (SoundEngine.getVoiceInstrument) {
        return SoundEngine.getVoiceInstrument(voiceName);
      }
    }
    return 'piano';
  }

  function _gatherContext(voiceName, midi, opts) {
    var prevMidi = (opts.prevMidi !== undefined && opts.prevMidi !== null) ?
                   opts.prevMidi : null;
    var interval = (prevMidi !== null) ? (midi - prevMidi) : null;

    // Section state
    var sectionState = 'STABLE';
    var sectionEnergy = 0.5;
    if (typeof SectionTracker !== 'undefined' && SectionTracker.getState) {
      var st = SectionTracker.getState();
      sectionState = st.state || 'STABLE';
      sectionEnergy = st.energy || 0.5;
    }

    // Mood valence (modal brightness)
    var moodValence = 0;
    if (typeof MoodState !== 'undefined' && MoodState.getMoodOutput) {
      var mood = MoodState.getMoodOutput(voiceName);
      if (mood) moodValence = mood.modeValence || 0;
    }

    // Phrase progress (0 = start, 1 = end)
    var phraseProgress = 0.5;
    if (typeof Scheduler !== 'undefined' && Scheduler.getPhraseProgress) {
      phraseProgress = Scheduler.getPhraseProgress(voiceName);
    }

    // Beat position (approximate — for grace note placement)
    var isOnBeat = true;
    if (typeof BarTracker !== 'undefined' && BarTracker.getBeatPhase) {
      var beatPhase = BarTracker.getBeatPhase();
      isOnBeat = beatPhase < 0.15 || beatPhase > 0.85;
    }

    return {
      midi: midi,
      prevMidi: prevMidi,
      interval: interval,
      durationMs: opts.durationMs || 500,
      volMult: opts.volMult || 1,
      gapBefore: opts.gapBefore || 0,
      sectionState: sectionState,
      sectionEnergy: sectionEnergy,
      moodValence: moodValence,
      phraseProgress: phraseProgress,
      isFirstInPhrase: phraseProgress < 0.1,
      isLastInPhrase: phraseProgress > 0.85,
      isOnBeat: isOnBeat
    };
  }


  // ── PUBLIC ──
  return {
    compute: compute
  };
})();

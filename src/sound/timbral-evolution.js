// ═══════════════════════════════════════════════════════════════
// TimbralEvolution — Session-Arc Sound Color Modulation (v9.0.0)
// ═══════════════════════════════════════════════════════════════
// Modulates sound color (filter cutoff, reverb depth, envelope shape,
// stereo width, drum brightness) across the session arc so that
// the music doesn't just change in notes — it changes in TEXTURE.
//
// Exposition:      Clean, transparent, intimate. Low reverb, narrow stereo,
//                  shorter releases. The music is introducing itself.
// Development:     Growing warmth, wider stereo, moderate reverb.
//                  Voices begin to fill the sonic space.
// Recapitulation:  Rich, full, expansive. Deep reverb, wide stereo,
//                  longer releases, brighter overtones. Full arrival.
//
// All modulation uses smooth ramps (2-4 second transitions) to avoid
// audible artifacts. Parameters are interpolated, never jumped.
//
// Psychoacoustic basis:
//   Helmholtz 1863 — timbre as carrier of musical identity
//   McAdams 1999 — timbre perception and auditory scene analysis
//   Grey 1977 — perceptual dimensions of timbre (brightness, attack)
//   Kendall & Carterette 1993 — musical context affects timbre perception
//   Alluri & Toiviainen 2010 — timbral features track musical tension
// ═══════════════════════════════════════════════════════════════

'use strict';

var TimbralEvolution = (function() {

  // ── Phase Presets ──
  // Each parameter has a target value for each session phase.
  // Tick interpolates toward the target for smooth transitions.

  var PHASE_TARGETS = {
    exposition: {
      reverb:           0.18,    // dry, intimate
      bassFilterFreq:   600,     // warm, round
      bassFilterQ:      0.7,
      soloistFilterFreq: 3200,   // slightly muffled — not fully open
      soloistFilterQ:   0.5,
      leadFilterFreq:   2800,    // reserved — not yet shining
      leadFilterQ:      0.5,
      panWidth:         0.6,     // narrow stereo (×0.6 of default pans)
      releaseScale:     0.8,     // shorter releases — tighter, more precise
      drumBrightness:   0.75,    // subdued
      drumDecay:        0.8      // tight
    },
    development: {
      reverb:           0.30,    // moderate space
      bassFilterFreq:   900,     // opening up
      bassFilterQ:      0.7,
      soloistFilterFreq: 5500,   // brighter
      soloistFilterQ:   0.5,
      leadFilterFreq:   5000,    // expanding
      leadFilterQ:      0.5,
      panWidth:         0.85,    // widening
      releaseScale:     1.0,     // normal
      drumBrightness:   1.0,     // natural
      drumDecay:        1.0      // natural
    },
    recapitulation: {
      reverb:           0.42,    // spacious, full
      bassFilterFreq:   1200,    // full warmth
      bassFilterQ:      0.6,
      soloistFilterFreq: 8000,   // fully open, brilliant
      soloistFilterQ:   0.4,
      leadFilterFreq:   7500,    // radiant
      leadFilterQ:      0.4,
      panWidth:         1.0,     // full stereo
      releaseScale:     1.2,     // longer releases — notes breathe
      drumBrightness:   1.15,    // shimmer
      drumDecay:        1.15     // bloom
    }
  };

  // Section-level micro-modulation ON TOP of session phase.
  // These are additive deltas applied during specific sections.
  var SECTION_DELTAS = {
    STABLE:   { reverb: -0.03, brightness:  0.0,  decay:  0.0  },
    BUILD:    { reverb:  0.0,  brightness:  0.05, decay: -0.05 },
    PEAK:     { reverb:  0.05, brightness:  0.10, decay:  0.10 },
    RELEASE:  { reverb:  0.08, brightness: -0.05, decay:  0.05 },
    TRANSITION:{ reverb: 0.0,  brightness:  0.0,  decay:  0.0  }
  };

  // Default voice pans (from SoundEngine STRIP_DEFAULTS)
  var DEFAULT_PANS = {
    bass: -0.2, rhythm: 0.0, soloist: 0.2, lead: 0.1, percussion: 0.0
  };

  // Default envelopes (from SoundEngine)
  var DEFAULT_ENVELOPES = {
    bass:    { a: 0.008, d: 0.10, s: 0.5,  r: 0.25 },
    rhythm:  { a: 0.005, d: 0.08, s: 0.4,  r: 0.20 },
    soloist: { a: 0.005, d: 0.08, s: 0.4,  r: 0.30 },
    lead:    { a: 0.006, d: 0.10, s: 0.45, r: 0.35 }
  };

  // ── State ──
  var _current = {
    reverb: 0.30,
    bassFilterFreq: 800,
    soloistFilterFreq: 5000,
    leadFilterFreq: 5000,
    panWidth: 1.0,
    releaseScale: 1.0,
    drumBrightness: 1.0,
    drumDecay: 1.0
  };

  var _initialized = false;
  var _lastApplyTime = 0;
  var APPLY_INTERVAL_MS = 2000;  // apply changes every 2s (smooth, not CPU-heavy)
  var LERP_SPEED = 0.08;          // interpolation rate per apply (0-1, 0.08 = ~12 applies to 90%)

  // ── Smooth Interpolation ──
  function _lerp(current, target, speed) {
    var diff = target - current;
    if (Math.abs(diff) < 0.001) return target;  // snap when close
    return current + diff * speed;
  }

  // ── Get Blended Target ──
  // Session phase provides the base target, section provides micro-modulation.
  // v9.0.1: SessionEnding override takes precedence when active.
  function _getTarget() {
    // v9.0.1: SessionEnding timbral override — warm, intimate, closing down
    if (typeof SessionEnding !== 'undefined' && SessionEnding.isActive()) {
      var endingTarget = SessionEnding.getTimbralOverride();
      if (endingTarget) return endingTarget;
    }

    // Session phase
    var phase = 'development';
    if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getSessionPhase) {
      phase = NarrativeArc.getSessionPhase().phase || 'development';
    }
    var base = PHASE_TARGETS[phase] || PHASE_TARGETS.development;

    // Section micro-modulation
    var section = 'STABLE';
    if (typeof SectionTracker !== 'undefined') {
      section = SectionTracker.getState().state || 'STABLE';
    }
    var delta = SECTION_DELTAS[section] || SECTION_DELTAS.STABLE;

    return {
      reverb:           base.reverb + delta.reverb,
      bassFilterFreq:   base.bassFilterFreq,
      bassFilterQ:      base.bassFilterQ,
      soloistFilterFreq: base.soloistFilterFreq,
      soloistFilterQ:   base.soloistFilterQ,
      leadFilterFreq:   base.leadFilterFreq,
      leadFilterQ:      base.leadFilterQ,
      panWidth:         base.panWidth,
      releaseScale:     base.releaseScale,
      drumBrightness:   Math.max(0.3, base.drumBrightness + delta.brightness),
      drumDecay:        Math.max(0.5, base.drumDecay + delta.decay)
    };
  }

  // ── Apply Current State to SoundEngine ──
  function _apply() {
    if (typeof SoundEngine === 'undefined') return;

    // Reverb
    SoundEngine.setReverb(Math.max(0, Math.min(0.8, _current.reverb)));

    // Bass lowpass filter
    SoundEngine.setVoiceFilter('bass', 'lowpass',
      _current.bassFilterFreq, PHASE_TARGETS.development.bassFilterQ);

    // Soloist highpass filter (opens up over session)
    // Use lowpass instead — highpass on soloist removes body
    SoundEngine.setVoiceFilter('soloist', 'lowpass',
      _current.soloistFilterFreq, PHASE_TARGETS.development.soloistFilterQ);

    // Lead lowpass filter
    SoundEngine.setVoiceFilter('lead', 'lowpass',
      _current.leadFilterFreq, PHASE_TARGETS.development.leadFilterQ);

    // Conviction-modulated filter: certain = fuller tone, searching = thinner (Eerola 2013)
    // Applied as multiplier on current filter freq (additive layer, not replacement)
    if (typeof ConvictionExpression !== 'undefined' && ConvictionExpression.getFilterMod) {
      var cvBass = ConvictionExpression.getFilterMod('bass');
      var cvSoloist = ConvictionExpression.getFilterMod('soloist');
      var cvLead = ConvictionExpression.getFilterMod('lead');
      SoundEngine.setVoiceFilter('bass', 'lowpass',
        _current.bassFilterFreq * cvBass, PHASE_TARGETS.development.bassFilterQ);
      SoundEngine.setVoiceFilter('soloist', 'lowpass',
        _current.soloistFilterFreq * cvSoloist, PHASE_TARGETS.development.soloistFilterQ);
      SoundEngine.setVoiceFilter('lead', 'lowpass',
        _current.leadFilterFreq * cvLead, PHASE_TARGETS.development.leadFilterQ);
    }

    // Stereo width: scale default pans by width factor
    var voices = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      var defaultPan = DEFAULT_PANS[v] || 0;
      SoundEngine.setVoicePan(v, defaultPan * _current.panWidth);
    }

    // Envelope release scaling
    for (var v2 in DEFAULT_ENVELOPES) {
      if (DEFAULT_ENVELOPES.hasOwnProperty(v2)) {
        var base = DEFAULT_ENVELOPES[v2];
        SoundEngine.setVoiceEnvelope(v2, {
          a: base.a,
          d: base.d,
          s: base.s,
          r: base.r * _current.releaseScale
        });
      }
    }
  }

  // ── Public API ──

  return {

    // Tick: called from app.js tick loop (or EventBus). Smoothly interpolates
    // toward target timbral state based on session phase + section.
    tick: function(dt) {
      if (typeof SoundEngine === 'undefined') return;

      var now = Date.now();

      // Initialize on first tick
      if (!_initialized) {
        _initialized = true;
        _lastApplyTime = now;
        // Set initial state to exposition
        var init = PHASE_TARGETS.exposition;
        _current.reverb = init.reverb;
        _current.bassFilterFreq = init.bassFilterFreq;
        _current.soloistFilterFreq = init.soloistFilterFreq;
        _current.leadFilterFreq = init.leadFilterFreq;
        _current.panWidth = init.panWidth;
        _current.releaseScale = init.releaseScale;
        _current.drumBrightness = init.drumBrightness;
        _current.drumDecay = init.drumDecay;
        _apply();
        return;
      }

      // Rate-limit: only apply every APPLY_INTERVAL_MS
      if (now - _lastApplyTime < APPLY_INTERVAL_MS) return;
      _lastApplyTime = now;

      // Get blended target
      var target = _getTarget();

      // Interpolate each parameter toward target
      _current.reverb = _lerp(_current.reverb, target.reverb, LERP_SPEED);
      _current.bassFilterFreq = _lerp(_current.bassFilterFreq, target.bassFilterFreq, LERP_SPEED);
      _current.soloistFilterFreq = _lerp(_current.soloistFilterFreq, target.soloistFilterFreq, LERP_SPEED);
      _current.leadFilterFreq = _lerp(_current.leadFilterFreq, target.leadFilterFreq, LERP_SPEED);
      _current.panWidth = _lerp(_current.panWidth, target.panWidth, LERP_SPEED);
      _current.releaseScale = _lerp(_current.releaseScale, target.releaseScale, LERP_SPEED);
      _current.drumBrightness = _lerp(_current.drumBrightness, target.drumBrightness, LERP_SPEED);
      _current.drumDecay = _lerp(_current.drumDecay, target.drumDecay, LERP_SPEED);

      // Apply to SoundEngine
      _apply();
    },

    // Get current drum timbre parameters (called by percussion assistant)
    getDrumParams: function() {
      return {
        brightness: _current.drumBrightness,
        decayMult: _current.drumDecay
      };
    },

    // Get current state for diagnostics
    getState: function() {
      var phase = 'unknown';
      if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getSessionPhase) {
        phase = NarrativeArc.getSessionPhase().phase;
      }
      return {
        sessionPhase: phase,
        reverb: +_current.reverb.toFixed(3),
        bassFilter: Math.round(_current.bassFilterFreq) + 'Hz',
        soloistFilter: Math.round(_current.soloistFilterFreq) + 'Hz',
        leadFilter: Math.round(_current.leadFilterFreq) + 'Hz',
        panWidth: +_current.panWidth.toFixed(2),
        releaseScale: +_current.releaseScale.toFixed(2),
        drumBrightness: +_current.drumBrightness.toFixed(2),
        drumDecay: +_current.drumDecay.toFixed(2)
      };
    },

    reset: function() {
      _initialized = false;
      _current = {
        reverb: 0.30,
        bassFilterFreq: 800,
        soloistFilterFreq: 5000,
        leadFilterFreq: 5000,
        panWidth: 1.0,
        releaseScale: 1.0,
        drumBrightness: 1.0,
        drumDecay: 1.0
      };
    }
  };

})();

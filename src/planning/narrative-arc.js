'use strict';
// ═══ NARRATIVE ARC — v5 Phase 4 ═══
//
// Per-voice 16-32 bar narrative arcs with built-in variety.
// Repetition breaks naturally because the arc demands change at specific points.
//
// Arc phases: establish → develop → climax → resolve → (transition)
// Each phase maps to a preferred MelodicIntent, creating planned intent sequences
// that produce musical form rather than random switching.
//
// The arc is a GUIDE, not a cage — beliefs can override when musical context demands it.
//
// Depends on: belief-state.js, section-tracker.js, phase-coupling.js
// Load order: after belief-state.js, before melodic-intent.js

var NarrativeArc = (function() {

  var PITCH_VOICES = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];

  // ── Arc phase definitions ──
  // Each phase has a preferred intent and a character description.
  var PHASE_INTENT = {
    establish:  'continuation',  // repeat/ground the material
    develop:    'consonance',    // smooth evolution
    climax:     'contrast',      // peak tension, new material
    resolve:    'continuation',  // return to grounding
    transition: 'punctuation'    // brief punctuation between arcs
  };

  // ── Arc templates (structured tension curves) ──
  // bars: total arc length. phases: [{ name, bars }]
  var TEMPLATES = {
    standard: {
      bars: 16,
      phases: [
        { name: 'establish',  bars: 4 },
        { name: 'develop',    bars: 4 },
        { name: 'climax',     bars: 4 },
        { name: 'resolve',    bars: 4 }
      ]
    },
    extended: {
      bars: 24,
      phases: [
        { name: 'establish',  bars: 4 },
        { name: 'develop',    bars: 8 },
        { name: 'climax',     bars: 4 },
        { name: 'resolve',    bars: 4 },
        { name: 'transition', bars: 4 }
      ]
    },
    dramatic: {
      bars: 32,
      phases: [
        { name: 'establish',  bars: 8 },
        { name: 'develop',    bars: 8 },
        { name: 'climax',     bars: 8 },
        { name: 'resolve',    bars: 8 }
      ]
    },
    short: {
      bars: 12,
      phases: [
        { name: 'establish',  bars: 3 },
        { name: 'develop',    bars: 3 },
        { name: 'climax',     bars: 3 },
        { name: 'resolve',    bars: 3 }
      ]
    }
  };

  // ── Per-role arc preferences ──
  // templateWeights: probability of selecting each template type
  // phaseIntentOverride: role-specific intent for certain phases
  var ROLE_ARC_CONFIG = {
    bass: {
      templateWeights: { standard: 0.15, extended: 0.45, dramatic: 0.35, short: 0.05 },
      phaseIntentOverride: {
        establish: 'continuation',  // ostinato grounding
        climax:    'contrast',
        resolve:   'consonance'     // tonic anchoring
      }
    },
    rhythm: {
      templateWeights: { standard: 0.50, extended: 0.25, dramatic: 0.05, short: 0.20 },
      phaseIntentOverride: {}  // follows defaults
    },
    soloist: {
      templateWeights: { standard: 0.10, extended: 0.30, dramatic: 0.50, short: 0.10 },
      phaseIntentOverride: {
        develop: 'continuation',  // long melodic arcs
        climax:  'contrast'       // dramatic peak
      }
    },
    lead: {
      templateWeights: { standard: 0.35, extended: 0.15, dramatic: 0.10, short: 0.40 },
      phaseIntentOverride: {
        climax: 'contrast'  // high contrast ratio
      }
    },
    // Percussion as textural colorist: long arcs, silence-heavy.
    // Extended/dramatic dominate → long establish phases = sustained silence.
    // Gestures emerge during develop (blend) and climax (accent/disrupt).
    percussion: {
      templateWeights: { standard: 0.10, extended: 0.50, dramatic: 0.30, short: 0.10 },
      phaseIntentOverride: {
        establish: 'continuation',  // silence / sustain texture
        develop:   'consonance',    // blend gestures (wash, brush)
        climax:    'contrast',      // accent / disrupt
        resolve:   'continuation'   // decay to silence
      }
    }
  };

  // ── Per-voice arc state ──
  var _arcs = {};

  function _initVoice(voice) {
    _arcs[voice] = {
      template: null,       // current template name
      phases: null,         // current template phases array
      phaseIdx: 0,          // index into phases array
      barsTotal: 0,         // total bars in arc
      barsElapsed: 0,       // bars elapsed in current arc
      phaseBarsElapsed: 0,  // bars elapsed in current phase
      startTime: 0,         // when arc started (ms)
      phaseStartTime: 0,    // when current phase started (ms)
      active: false         // whether an arc is running
    };
  }

  PITCH_VOICES.forEach(_initVoice);

  // ── Template selection ──
  function _selectTemplate(voice) {
    var config = ROLE_ARC_CONFIG[voice] || ROLE_ARC_CONFIG.rhythm;
    var weights = config.templateWeights;
    var roll = Math.random();
    var cumulative = 0;
    var names = Object.keys(weights);
    for (var i = 0; i < names.length; i++) {
      cumulative += weights[names[i]];
      if (roll <= cumulative) return names[i];
    }
    return names[names.length - 1];
  }

  // ── Initial phase offsets to decorrelate voices ──
  // Without this, bass and rhythm start at phase 0 simultaneously and stay locked.
  // Offset is in phase-index units (0 = start at establish, 1 = start at develop, etc.)
  var INITIAL_PHASE_OFFSET = {
    bass: 0,         // anchor starts at establish
    rhythm: 1,       // groove starts one phase ahead (develop)
    soloist: 2,      // melodic starts at climax
    lead: 3,         // expressive starts at resolve
    percussion: 1    // textural starts at develop (offset from bass)
  };

  // ── Start a new arc ──
  function _startArc(voice, templateName, useOffset) {
    var arc = _arcs[voice];
    var tmpl = TEMPLATES[templateName];
    if (!tmpl) tmpl = TEMPLATES.standard;

    arc.template = templateName;
    arc.phases = tmpl.phases;
    arc.barsTotal = tmpl.bars;
    arc.startTime = Date.now();
    arc.phaseStartTime = Date.now();
    arc._staleFiredThisPhase = false;
    arc.active = true;

    // Apply initial phase offset only on first arc start
    var offset = 0;
    if (useOffset && INITIAL_PHASE_OFFSET[voice]) {
      offset = INITIAL_PHASE_OFFSET[voice] % arc.phases.length;
    }
    arc.phaseIdx = offset;

    // Calculate elapsed bars to reflect offset
    var offsetBars = 0;
    for (var pi = 0; pi < offset; pi++) {
      offsetBars += arc.phases[pi].bars;
    }
    arc.barsElapsed = offsetBars;
    arc.phaseBarsElapsed = 0;
  }

  // ── Get bars per millisecond ──
  function _getBarsPerMs() {
    var bpm = 120;
    if (typeof PhaseCoupling !== 'undefined') {
      bpm = PhaseCoupling.getConsensusBPM() || 120;
    }
    var barMs = 60000 / bpm * 4; // 4 beats per bar
    return 1 / barMs;
  }

  // ── Tick: advance arc state ──
  var _accumMs = 0;
  var _TICK_INTERVAL = 500; // check every 500ms

  function tick(dt) {
    _accumMs += dt;
    if (_accumMs < _TICK_INTERVAL) return;
    var elapsed = _accumMs;
    _accumMs = 0;

    // v9.0.0: Session arc tick (tracks peak cycles, manages session phase)
    _sessionTick();

    var barsPerMs = _getBarsPerMs();

    for (var vi = 0; vi < PITCH_VOICES.length; vi++) {
      var voice = PITCH_VOICES[vi];
      var arc = _arcs[voice];

      // Auto-start if no arc active
      if (!arc.active) {
        var tmplName = _selectTemplate(voice);
        _startArc(voice, tmplName, true); // useOffset=true for first arc
        continue;
      }

      // Advance bars
      var barsAdvanced = elapsed * barsPerMs;
      arc.barsElapsed += barsAdvanced;
      arc.phaseBarsElapsed += barsAdvanced;

      // Check phase boundary
      var currentPhase = arc.phases[arc.phaseIdx];
      if (currentPhase && arc.phaseBarsElapsed >= currentPhase.bars) {
        // v3.17.0: Metric-aligned phase transition (Large & Jones 1999)
        // Prefer transitioning on a downbeat. If bar oscillator shows we're
        // not near a downbeat, delay up to 1 bar (but no more).
        var shouldTransition = true;
        if (typeof PhaseCoupling !== 'undefined' && PhaseCoupling.getBarPhase) {
          var _barPh = PhaseCoupling.getBarPhase(voice);
          // Near downbeat: barPhase < 0.15 or > 0.85
          var _distDown = _barPh < 0.5 ? _barPh : (1.0 - _barPh);
          // If not near downbeat AND haven't exceeded +1 bar grace period, wait
          if (_distDown > 0.15 && arc.phaseBarsElapsed < currentPhase.bars + 1.0) {
            shouldTransition = false;
          }
        }

        if (shouldTransition) {
          // Advance to next phase
          arc.phaseIdx++;
          arc.phaseBarsElapsed = 0;
          arc.phaseStartTime = Date.now();
          arc._staleFiredThisPhase = false; // reset stale guard for new phase

          // Arc complete?
          if (arc.phaseIdx >= arc.phases.length) {
            // Select contrasting template for next arc
            var nextTmpl = _selectContrastingTemplate(voice, arc.template);
            _startArc(voice, nextTmpl);
          }
        }
      }

      // ── Belief-responsive adjustment ──
      // Only check once per phase (when >60% through), not every tick.
      // Prevents energy trend from chewing through phases in seconds.
      var phase = arc.phases[arc.phaseIdx];
      if (phase && arc.phaseBarsElapsed > phase.bars * 0.6) {
        if (typeof BeliefState !== 'undefined' && typeof BeliefState.getBeliefTrend === 'function') {
          var energyTrend = BeliefState.getBeliefTrend(voice, 1, 8);
          // Arc says resolve but energy is strongly rising → skip to next arc
          if (phase.name === 'resolve' && energyTrend > 0.5) {
            arc.phaseIdx = arc.phases.length;
            var nextTmpl2 = _selectContrastingTemplate(voice, arc.template);
            _startArc(voice, nextTmpl2);
          }
          // Arc says establish but energy is strongly high → skip to develop
          else if (phase.name === 'establish' && energyTrend > 0.6) {
            arc.phaseIdx = Math.min(arc.phaseIdx + 1, arc.phases.length - 1);
            arc.phaseBarsElapsed = 0;
            arc.phaseStartTime = Date.now();
          }
        }
      }

      // ── Staleness override ──
      // Only fires once per arc (not every tick). Must be deep into current phase
      // AND staleness must be strong (cycleCount >= 4). Prevents rapid phase churn.
      if (phase && !arc._staleFiredThisPhase && arc.phaseBarsElapsed > phase.bars * 0.8) {
        if (typeof BeliefState !== 'undefined' && typeof BeliefState.isStalePattern === 'function') {
          var staleness = BeliefState.isStalePattern(voice, 40);
          if (staleness.stale && staleness.cycleCount >= 4) {
            arc._staleFiredThisPhase = true;
            arc.phaseIdx++;
            arc.phaseBarsElapsed = 0;
            arc.phaseStartTime = Date.now();
            if (arc.phaseIdx >= arc.phases.length) {
              _startArc(voice, 'dramatic');
            }
          }
        }
      }
    }
  }

  // ── Select a contrasting template ──
  // Avoid repeating the same template type twice
  function _selectContrastingTemplate(voice, lastTemplate) {
    var attempts = 0;
    var tmpl;
    do {
      tmpl = _selectTemplate(voice);
      attempts++;
    } while (tmpl === lastTemplate && attempts < 4);
    return tmpl;
  }

  // ── Public API ──

  // ── Pre-allocated return objects for getArc (one per voice, reused to avoid GC) ──
  var _arcResults = {};
  var _inactiveArcResult = { phase: 'establish', progress: 0, barsTotal: 16, barsElapsed: 0, template: null, active: false };
  (function() {
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      _arcResults[PITCH_VOICES[i]] = {
        phase: 'establish', phaseProgress: 0, progress: 0,
        barsTotal: 16, barsElapsed: 0, phaseBarsElapsed: 0,
        template: null, phaseIdx: 0, phaseCount: 4, active: false
      };
    }
  })();

  // Get current arc state for a voice (reuses pre-allocated return object)
  function getArc(voice) {
    var arc = _arcs[voice];
    if (!arc || !arc.active || !arc.phases) {
      return _inactiveArcResult;
    }

    var currentPhase = arc.phases[arc.phaseIdx];
    var phaseName = currentPhase ? currentPhase.name : 'establish';
    var phaseBars = currentPhase ? currentPhase.bars : 4;
    var phaseProgress = phaseBars > 0 ? Math.min(1, arc.phaseBarsElapsed / phaseBars) : 0;
    var arcProgress = arc.barsTotal > 0 ? Math.min(1, arc.barsElapsed / arc.barsTotal) : 0;

    // Reuse per-voice result object (callers must not cache across calls)
    var r = _arcResults[voice] || _inactiveArcResult;
    r.phase = phaseName;
    r.phaseProgress = +phaseProgress.toFixed(2);
    r.progress = +arcProgress.toFixed(2);
    r.barsTotal = arc.barsTotal;
    r.barsElapsed = +arc.barsElapsed.toFixed(1);
    r.phaseBarsElapsed = +arc.phaseBarsElapsed.toFixed(1);
    r.template = arc.template;
    r.phaseIdx = arc.phaseIdx;
    r.phaseCount = arc.phases.length;
    r.active = true;
    return r;
  }

  // Get the arc-preferred intent for a voice
  function getPreferredIntent(voice) {
    var arc = _arcs[voice];
    if (!arc || !arc.active || !arc.phases) return null;

    var currentPhase = arc.phases[arc.phaseIdx];
    if (!currentPhase) return null;

    // Check role-specific override first
    var config = ROLE_ARC_CONFIG[voice] || {};
    if (config.phaseIntentOverride && config.phaseIntentOverride[currentPhase.name]) {
      return config.phaseIntentOverride[currentPhase.name];
    }

    return PHASE_INTENT[currentPhase.name] || 'continuation';
  }

  // Get energy modifier for current arc phase.
  // Climax/develop phases boost energy to ensure BUILD→PEAK transition fires.
  // Without this, stable arc phases keep the system in BUILD indefinitely.
  // Returns: multiplier for gateProb/density (1.0 = neutral)
  var PHASE_ENERGY = {
    establish:  0.95,  // mild suppression (0.85 caused tempo drift via needs_space)
    develop:    1.05,  // slight lift to prevent BUILD deadlock
    climax:     1.3,   // energy boost → drives BUILD→PEAK (1.4 caused tempo drift)
    resolve:    0.95,  // gentle winding down
    transition: 1.0    // neutral
  };

  function getEnergyModifier(voice) {
    var arc = _arcs[voice];
    if (!arc || !arc.active || !arc.phases) return 1.0;
    var phase = arc.phases[arc.phaseIdx];
    if (!phase) return 1.0;
    return PHASE_ENERGY[phase.name] || 1.0;
  }

  // Force arc to next phase (used by cycle detection)
  function advancePhase(voice) {
    var arc = _arcs[voice];
    if (!arc || !arc.active) return;
    arc.phaseIdx++;
    arc.phaseBarsElapsed = 0;
    arc.phaseStartTime = Date.now();
    if (arc.phaseIdx >= arc.phases.length) {
      _startArc(voice, _selectContrastingTemplate(voice, arc.template));
    }
  }

  // Diagnostics (reuses a single result object)
  var _allResult = {};
  function getAll() {
    for (var i = 0; i < PITCH_VOICES.length; i++) {
      _allResult[PITCH_VOICES[i]] = getArc(PITCH_VOICES[i]);
    }
    return _allResult;
  }

  function reset() {
    PITCH_VOICES.forEach(_initVoice);
    _accumMs = 0;
    _sessionReset();
  }

  // ═══ SESSION ARC (v9.0.0) ═══
  // Session-level dramatic arc that modulates section cycling.
  // Unlike per-voice arcs (16-32 bars), this spans the entire performance.
  //
  // 3 phases:
  //   Exposition (0-30%):  Opening. PEAKs are short and restrained.
  //   Development (30-75%): Middle. Each PEAK cycle higher than the last.
  //   Recapitulation (75-100%): Closing. Final PEAK at full intensity.
  //
  // The session arc creates dramatic ACCUMULATION — the first PEAK is a question,
  // the second is an answer that raises a bigger question, the third is the climax.
  //
  // Psychoacoustic basis:
  //   Lerdahl & Jackendoff 1983 (GTTM hierarchical structure)
  //   Meyer 1956 (emotion as expectation violation across multiple timescales)
  //   Narmour 1990 (I-R model hierarchical application)

  var _SESSION_TARGET_DURATION = 480000;  // 8 minutes default (ms)
  var _SESSION_EXPOSITION_END = 0.30;     // first 30%
  var _SESSION_DEVELOPMENT_END = 0.75;    // 30-75%
  // Recapitulation: 75-100%

  // Peak ceiling ramps per completed cycle during Development
  // Exposition: 0.60 (restrained PEAKs)
  // Development cycle 1: 0.70, cycle 2: 0.80, cycle 3+: 0.90
  // Recapitulation: 1.0 (full intensity)
  var _SESSION_PEAK_CEILINGS = {
    exposition: 0.60,
    development: [0.70, 0.80, 0.90],  // per completed peak cycle
    recapitulation: 1.0
  };

  var _sessionStartTime = 0;
  var _sessionPeakCount = 0;
  var _sessionActive = false;
  var _sessionLastState = 'STABLE';  // track SectionTracker transitions for peak counting

  // Pre-allocated return object
  var _sessionPhaseResult = {
    phase: 'exposition',
    progress: 0,
    peakCeiling: 0.60,
    peakCount: 0,
    targetDuration: _SESSION_TARGET_DURATION,
    elapsed: 0
  };

  function _sessionReset() {
    _sessionStartTime = 0;
    _sessionPeakCount = 0;
    _sessionActive = false;
    _sessionLastState = 'STABLE';
  }

  function _sessionTick() {
    // Auto-start session on first tick
    if (!_sessionActive) {
      _sessionStartTime = Date.now();
      _sessionActive = true;
    }

    // Track peak cycles by observing SectionTracker state transitions
    if (typeof SectionTracker !== 'undefined') {
      var currentState = SectionTracker.getState().state;
      // Count when we ENTER PEAK (transition from non-PEAK to PEAK)
      if (currentState === 'PEAK' && _sessionLastState !== 'PEAK') {
        _sessionPeakCount++;
      }
      _sessionLastState = currentState;
    }
  }

  // Get current session arc phase and parameters.
  // Returns: { phase, progress, peakCeiling, peakCount, targetDuration, elapsed }
  //
  // peakCeiling (0-1): multiplier for PEAK intensity. SectionTracker uses this
  // to modulate BUILD→PEAK threshold and PEAK output targets.
  //   - Exposition: 0.60 (restrained — early PEAKs are short, mild)
  //   - Development: 0.70→0.90 (rising per cycle — each PEAK higher than last)
  //   - Recapitulation: 1.0 (full intensity — the climax)
  function getSessionPhase() {
    if (!_sessionActive) {
      _sessionPhaseResult.phase = 'exposition';
      _sessionPhaseResult.progress = 0;
      _sessionPhaseResult.peakCeiling = _SESSION_PEAK_CEILINGS.exposition;
      _sessionPhaseResult.peakCount = 0;
      _sessionPhaseResult.targetDuration = _SESSION_TARGET_DURATION;
      _sessionPhaseResult.elapsed = 0;
      return _sessionPhaseResult;
    }

    var elapsed = Date.now() - _sessionStartTime;
    var progress = Math.min(1.0, elapsed / _SESSION_TARGET_DURATION);

    var phase, peakCeiling;

    if (progress < _SESSION_EXPOSITION_END) {
      phase = 'exposition';
      peakCeiling = _SESSION_PEAK_CEILINGS.exposition;
    } else if (progress < _SESSION_DEVELOPMENT_END) {
      phase = 'development';
      // Peak ceiling rises with each completed peak cycle during development
      var devCeilings = _SESSION_PEAK_CEILINGS.development;
      var ceilingIdx = Math.min(_sessionPeakCount, devCeilings.length - 1);
      // Peaks completed BEFORE development started don't count toward escalation
      // (exposition peaks were restrained, development peaks accumulate)
      peakCeiling = devCeilings[Math.max(0, ceilingIdx)];
    } else {
      phase = 'recapitulation';
      peakCeiling = _SESSION_PEAK_CEILINGS.recapitulation;
    }

    _sessionPhaseResult.phase = phase;
    _sessionPhaseResult.progress = +progress.toFixed(3);
    _sessionPhaseResult.peakCeiling = peakCeiling;
    _sessionPhaseResult.peakCount = _sessionPeakCount;
    _sessionPhaseResult.targetDuration = _SESSION_TARGET_DURATION;
    _sessionPhaseResult.elapsed = elapsed;
    return _sessionPhaseResult;
  }

  return {
    tick:               tick,
    getArc:             getArc,
    getPreferredIntent: getPreferredIntent,
    getEnergyModifier:  getEnergyModifier,
    advancePhase:       advancePhase,
    getAll:             getAll,
    reset:              reset,
    getSessionPhase:    getSessionPhase
  };

})();

console.log('%cNarrativeArc loaded (v9.0.0 — per-voice arcs + session arc)', 'color:#a8e;font-family:monospace');

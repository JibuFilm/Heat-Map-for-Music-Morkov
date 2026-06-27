// ═══════════════════════════════════════════════════════════════
// SessionEnding — Macro-Breath: Convergence & Rebirth (v9.0.1)
// ═══════════════════════════════════════════════════════════════
// Not a death — a rebirth. When the session arc reaches late
// recapitulation, voices thin to near-silence. Then a single
// voice speaks into the void, and the ensemble comes back alive.
//
// The ending is the collective breath at its largest scale:
//   1. APPROACHING — voices simplify, tempo eases
//   2. THINNING — voices withdraw (lead → soloist → rhythm → percussion)
//   3. CADENCE — bass alone, final resolution, ritardando
//   4. SILENCE — held breath (the seed's empty bars)
//   5. REBIRTH — a single voice (lead) begins a new thread
//   6. REENTRY — voices return one by one, tempo rebuilds
//
// After re-entry, the session arc resets to exposition BUT
// ThematicMemory PERSISTS — the new cycle remembers the old.
// Each rebirth carries the ghosts of previous cycles.
//
// For installations: the music runs indefinitely, breathing at
// the largest scale. Each cycle is a new story that remembers
// the previous one. Hours of continuous performance.
//
// Trigger: NarrativeArc recapitulation progress > 0.88
//          AND at least one PEAK during recapitulation
//          AND current section is RELEASE or STABLE
//
// Psychoacoustic basis:
//   Huron 2006 — ITPRA: anticipation through silence, surprise at rebirth
//   Narmour 1990 — closure through regression, then new implication
//   Meyer 1956 — emotion through expectation: rebirth VIOLATES the
//                expectation of ending, creating the deepest surprise
//   Repp 1992 — ritardando as expressive transition, not termination
//   Margulis 2014 — repetition at large scale creates deep meaning
// ═══════════════════════════════════════════════════════════════

'use strict';

var SessionEnding = (function() {

  // ── Phases ──
  // approaching → thinning → cadence → silence → rebirth → reentry → inactive
  var _phase = 'inactive';
  var _phaseStartTime = 0;
  var _startBPM = 120;       // captured at trigger time
  var _cycleCount = 0;       // how many macro-breaths completed

  // ── Timing ──
  var APPROACHING_MS  = 12000;  // 12s — voices simplify, tempo starts easing
  var THINNING_MS     = 16000;  // 16s — voices withdraw one by one
  var CADENCE_MS      = 10000;  // 10s — bass alone with final resolution
  var SILENCE_MS      =  6000;  //  6s — held breath (the void)
  var REBIRTH_MS      =  8000;  //  8s — solo voice speaks into silence
  var REENTRY_MS      = 14000;  // 14s — ensemble rebuilds

  // ── Voice Withdrawal Order (lead first, bass last via cadence) ──
  var THIN_ORDER = ['lead', 'soloist', 'rhythm', 'percussion'];
  // Re-entry: bass already playing, others return in reverse
  var REENTRY_ORDER = ['percussion', 'rhythm', 'soloist', 'lead'];

  // ── Rebirth Voice ──
  // The voice that speaks first after silence. Rotates each cycle.
  var REBIRTH_VOICES = ['lead', 'soloist', 'lead', 'bass'];
  var _rebirthVoice = 'lead';

  // ── Ritardando ──
  var RIT_TARGET_RATIO = 0.65;  // final BPM = start × 0.65 (120 → 78)

  // ── Trigger State ──
  var _triggered = false;
  var _recapPeakSeen = false;
  var _lastSectionState = '';

  // ── Progress within current phase (0-1) ──
  function _phaseProgress() {
    if (_phase === 'inactive') return 0;
    var elapsed = Date.now() - _phaseStartTime;
    var duration;
    switch (_phase) {
      case 'approaching': duration = APPROACHING_MS; break;
      case 'thinning':    duration = THINNING_MS; break;
      case 'cadence':     duration = CADENCE_MS; break;
      case 'silence':     duration = SILENCE_MS; break;
      case 'rebirth':     duration = REBIRTH_MS; break;
      case 'reentry':     duration = REENTRY_MS; break;
      default:            duration = 10000;
    }
    return Math.min(1.0, elapsed / duration);
  }

  // ── Check trigger conditions ──
  function _shouldTrigger() {
    if (_triggered) return false;
    if (typeof NarrativeArc === 'undefined' || !NarrativeArc.getSessionPhase) return false;

    var sp = NarrativeArc.getSessionPhase();
    if (sp.phase !== 'recapitulation') return false;
    if (sp.progress < 0.88) return false;
    if (!_recapPeakSeen) return false;

    // Only trigger during RELEASE or STABLE (not mid-PEAK)
    if (typeof SectionTracker !== 'undefined') {
      var sec = SectionTracker.getState().state;
      if (sec !== 'RELEASE' && sec !== 'STABLE') return false;
    }

    return true;
  }

  // ── Ritardando: compute current BPM ──
  // Slows during approaching→silence, then rebuilds during rebirth→reentry
  function _getRitBPM() {
    if (_phase === 'inactive') return null;

    // Slowdown phases: approaching → cadence
    if (_phase === 'approaching' || _phase === 'thinning' || _phase === 'cadence') {
      var slowElapsed = Date.now() - _phaseStartTime;
      if (_phase === 'thinning') slowElapsed += APPROACHING_MS;
      else if (_phase === 'cadence') slowElapsed += APPROACHING_MS + THINNING_MS;

      var slowTotal = APPROACHING_MS + THINNING_MS + CADENCE_MS;
      var slowProgress = Math.min(1.0, slowElapsed / slowTotal);
      var curve = slowProgress * slowProgress;  // quadratic ease-in
      var ratio = 1.0 - (1.0 - RIT_TARGET_RATIO) * curve;
      return _startBPM * ratio;
    }

    // Silence: stay at slowest
    if (_phase === 'silence') {
      return _startBPM * RIT_TARGET_RATIO;
    }

    // Rebuild phases: rebirth → reentry (accelerando back to original)
    if (_phase === 'rebirth' || _phase === 'reentry') {
      var fastElapsed = Date.now() - _phaseStartTime;
      if (_phase === 'reentry') fastElapsed += REBIRTH_MS;

      var fastTotal = REBIRTH_MS + REENTRY_MS;
      var fastProgress = Math.min(1.0, fastElapsed / fastTotal);
      // Smooth rebuild: slow start, natural acceleration
      var fastCurve = 1.0 - (1.0 - fastProgress) * (1.0 - fastProgress);
      var slowBPM = _startBPM * RIT_TARGET_RATIO;
      return slowBPM + (_startBPM - slowBPM) * fastCurve;
    }

    return null;
  }

  // ── Reset session arc for new cycle ──
  function _resetForNewCycle() {
    // Reset NarrativeArc to exposition (new story)
    // BUT do NOT reset ThematicMemory (carry memories forward)
    if (typeof NarrativeArc !== 'undefined' && NarrativeArc.reset) {
      NarrativeArc.reset();
    }
    // Reset TimbralEvolution (back to intimate opening sound)
    if (typeof TimbralEvolution !== 'undefined' && TimbralEvolution.reset) {
      TimbralEvolution.reset();
    }
    // Reset SectionTracker to STABLE
    if (typeof SectionTracker !== 'undefined' && SectionTracker.reset) {
      SectionTracker.reset();
    }

    if (typeof EventBus !== 'undefined') {
      EventBus.emit('sessionRebirth', {
        cycle: _cycleCount,
        rebirthVoice: _rebirthVoice,
        themesCarried: (typeof ThematicMemory !== 'undefined') ? ThematicMemory.getArchiveSize() : 0
      });
    }
  }

  // ── Public API ──

  return {

    tick: function(dt) {
      // Track PEAK during recapitulation
      if (typeof SectionTracker !== 'undefined' && typeof NarrativeArc !== 'undefined') {
        var sec = SectionTracker.getState().state;
        var sp = NarrativeArc.getSessionPhase();
        if (sp.phase === 'recapitulation' && sec === 'PEAK' && _lastSectionState !== 'PEAK') {
          _recapPeakSeen = true;
        }
        _lastSectionState = sec;
      }

      if (_phase === 'inactive') {
        if (_shouldTrigger()) {
          _triggered = true;
          _phase = 'approaching';
          _phaseStartTime = Date.now();
          _startBPM = (typeof PhaseCoupling !== 'undefined')
            ? (PhaseCoupling.getConsensusBPM() || 120) : 120;
          _rebirthVoice = REBIRTH_VOICES[_cycleCount % REBIRTH_VOICES.length];

          if (typeof EventBus !== 'undefined') {
            EventBus.emit('sessionEnding', { phase: 'approaching', cycle: _cycleCount });
          }
          console.log('%c[SessionEnding] Cycle ' + _cycleCount + ' — approaching', 'color:#f80;font-weight:bold');
        }
        return;
      }

      var progress = _phaseProgress();
      var now = Date.now();

      // Apply tempo modulation continuously
      var ritBPM = _getRitBPM();
      if (ritBPM !== null && typeof PhaseCoupling !== 'undefined') {
        PhaseCoupling.setManualTempo(ritBPM);
      }

      // Phase transitions
      switch (_phase) {
        case 'approaching':
          if (progress >= 1.0) {
            _phase = 'thinning';
            _phaseStartTime = now;
            if (typeof EventBus !== 'undefined') {
              EventBus.emit('sessionEnding', { phase: 'thinning' });
            }
            console.log('%c[SessionEnding] Thinning — voices withdrawing', 'color:#f80');
          }
          break;

        case 'thinning':
          if (progress >= 1.0) {
            _phase = 'cadence';
            _phaseStartTime = now;
            if (typeof EventBus !== 'undefined') {
              EventBus.emit('sessionEnding', { phase: 'cadence' });
            }
            console.log('%c[SessionEnding] Cadence — bass alone', 'color:#f80');
          }
          break;

        case 'cadence':
          if (progress >= 1.0) {
            _phase = 'silence';
            _phaseStartTime = now;
            if (typeof EventBus !== 'undefined') {
              EventBus.emit('sessionEnding', { phase: 'silence' });
            }
            console.log('%c[SessionEnding] Silence — held breath', 'color:#f80');
          }
          break;

        case 'silence':
          if (progress >= 1.0) {
            _phase = 'rebirth';
            _phaseStartTime = now;
            // Reset session arc for new cycle (but keep ThematicMemory)
            _resetForNewCycle();
            if (typeof EventBus !== 'undefined') {
              EventBus.emit('sessionEnding', { phase: 'rebirth', voice: _rebirthVoice });
            }
            console.log('%c[SessionEnding] Rebirth — ' + _rebirthVoice + ' speaks', 'color:#0f0;font-weight:bold');
          }
          break;

        case 'rebirth':
          if (progress >= 1.0) {
            _phase = 'reentry';
            _phaseStartTime = now;
            if (typeof EventBus !== 'undefined') {
              EventBus.emit('sessionEnding', { phase: 'reentry' });
            }
            console.log('%c[SessionEnding] Re-entry — ensemble rebuilds', 'color:#0f0');
          }
          break;

        case 'reentry':
          if (progress >= 1.0) {
            // Cycle complete — return to inactive, ready for next macro-breath
            _phase = 'inactive';
            _triggered = false;
            _recapPeakSeen = false;
            _cycleCount++;
            console.log('%c[SessionEnding] Cycle ' + (_cycleCount - 1) + ' complete — new session begins', 'color:#0f0;font-weight:bold');
          }
          break;
      }
    },

    // Get gate modifier for a voice during the macro-breath.
    getGateModifier: function(voiceName) {
      if (_phase === 'inactive') return 1.0;

      var progress = _phaseProgress();

      // ── CONVERGENCE: approaching → thinning → cadence → silence ──

      if (_phase === 'approaching') {
        if (voiceName === 'bass') return 1.0;
        if (voiceName === 'percussion') return 1.0 - progress * 0.3;
        return 1.0 - progress * 0.4;  // melodic voices: 1.0 → 0.6
      }

      if (_phase === 'thinning') {
        if (voiceName === 'bass') return 1.0;
        var orderIdx = THIN_ORDER.indexOf(voiceName);
        if (orderIdx < 0) return 1.0;
        var voiceCount = THIN_ORDER.length;
        var windowStart = orderIdx / voiceCount;
        var windowEnd = (orderIdx + 1) / voiceCount;
        if (progress < windowStart) return 0.6;
        if (progress >= windowEnd) return 0.0;
        var windowProgress = (progress - windowStart) / (windowEnd - windowStart);
        return 0.6 * (1.0 - windowProgress);
      }

      if (_phase === 'cadence') {
        if (voiceName === 'bass') return 1.0 - progress * 0.7;  // 1.0 → 0.3
        return 0.0;
      }

      if (_phase === 'silence') {
        return 0.0;  // the void
      }

      // ── REBIRTH: single voice → ensemble rebuilds ──

      if (_phase === 'rebirth') {
        if (voiceName === _rebirthVoice) {
          // Rebirth voice fades in from silence
          return Math.min(1.0, progress * 2.0);  // 0→1.0 over first 50%
        }
        return 0.0;  // everyone else still silent
      }

      if (_phase === 'reentry') {
        if (voiceName === _rebirthVoice) return 1.0;  // already active
        if (voiceName === 'bass') {
          // Bass returns early (first 30% of reentry)
          return Math.min(1.0, progress / 0.30);
        }
        // Others follow re-entry order
        var reIdx = REENTRY_ORDER.indexOf(voiceName);
        if (reIdx < 0) return 1.0;
        var reCount = REENTRY_ORDER.length;
        var reStart = (reIdx / reCount) * 0.85 + 0.15;  // staggered from 15% to 100%
        var reEnd = reStart + (0.85 / reCount);
        if (progress < reStart) return 0.0;
        if (progress >= reEnd) return 1.0;
        return (progress - reStart) / (reEnd - reStart);
      }

      return 1.0;
    },

    // Timbral override for convergence and rebirth phases.
    getTimbralOverride: function() {
      if (_phase === 'inactive') return null;

      // Overall progress across convergence (approaching→silence)
      var convergenceTotal = APPROACHING_MS + THINNING_MS + CADENCE_MS + SILENCE_MS;
      var rebirthTotal = REBIRTH_MS + REENTRY_MS;

      var overallProgress;

      if (_phase === 'approaching' || _phase === 'thinning' ||
          _phase === 'cadence' || _phase === 'silence') {
        // Convergence: close down, warm up, intimate
        var convElapsed = Date.now() - _phaseStartTime;
        if (_phase === 'thinning') convElapsed += APPROACHING_MS;
        else if (_phase === 'cadence') convElapsed += APPROACHING_MS + THINNING_MS;
        else if (_phase === 'silence') convElapsed += APPROACHING_MS + THINNING_MS + CADENCE_MS;
        overallProgress = Math.min(1.0, convElapsed / convergenceTotal);

        return {
          reverb:           0.35 + overallProgress * 0.30,         // → 0.65
          bassFilterFreq:   800 - overallProgress * 400,            // → 400 Hz
          bassFilterQ:      0.6,
          soloistFilterFreq: 4000 - overallProgress * 2500,         // → 1500
          soloistFilterQ:   0.5,
          leadFilterFreq:   3500 - overallProgress * 2000,          // → 1500
          leadFilterQ:      0.5,
          panWidth:         0.8 - overallProgress * 0.5,            // → 0.3
          releaseScale:     1.2 + overallProgress * 0.6,            // → 1.8
          drumBrightness:   1.0 - overallProgress * 0.5,            // → 0.5
          drumDecay:        1.0 - overallProgress * 0.3             // → 0.7
        };
      }

      if (_phase === 'rebirth' || _phase === 'reentry') {
        // Rebirth: open back up gradually (intimate → expanding)
        var rebElapsed = Date.now() - _phaseStartTime;
        if (_phase === 'reentry') rebElapsed += REBIRTH_MS;
        overallProgress = Math.min(1.0, rebElapsed / rebirthTotal);

        // Transition from convergence endpoint back toward exposition
        // (but not all the way — keep some warmth from the journey)
        return {
          reverb:           0.65 - overallProgress * 0.45,          // 0.65 → 0.20
          bassFilterFreq:   400 + overallProgress * 250,             // 400 → 650
          bassFilterQ:      0.7,
          soloistFilterFreq: 1500 + overallProgress * 2000,          // 1500 → 3500
          soloistFilterQ:   0.5,
          leadFilterFreq:   1500 + overallProgress * 1500,           // 1500 → 3000
          leadFilterQ:      0.5,
          panWidth:         0.3 + overallProgress * 0.35,            // 0.3 → 0.65
          releaseScale:     1.8 - overallProgress * 0.9,             // 1.8 → 0.9
          drumBrightness:   0.5 + overallProgress * 0.3,             // 0.5 → 0.8
          drumDecay:        0.7 + overallProgress * 0.15             // 0.7 → 0.85
        };
      }

      return null;
    },

    isActive: function() {
      return _phase !== 'inactive';
    },

    getCycleCount: function() {
      return _cycleCount;
    },

    getState: function() {
      return {
        phase: _phase,
        progress: +_phaseProgress().toFixed(3),
        cycleCount: _cycleCount,
        rebirthVoice: _rebirthVoice,
        triggered: _triggered,
        recapPeakSeen: _recapPeakSeen,
        startBPM: _startBPM,
        currentBPM: _getRitBPM() ? +_getRitBPM().toFixed(1) : null,
        targetSlowBPM: +(_startBPM * RIT_TARGET_RATIO).toFixed(1)
      };
    },

    reset: function() {
      _phase = 'inactive';
      _phaseStartTime = 0;
      _triggered = false;
      _recapPeakSeen = false;
      _lastSectionState = '';
      _startBPM = 120;
      _cycleCount = 0;
    }
  };

})();

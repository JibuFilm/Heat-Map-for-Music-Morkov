'use strict';
// ═══ BAR TRACKER (Phase 5B — metric phase inference) ═══
//
// Infers bar-level phase from three perceptual viewpoints:
//   VP1: Harmonic change timing — chord changes cluster on strong beats
//        (Temperley Rule 5; strongest single cue in the literature)
//   VP2: IOI gap boundaries — re-entries after silence target downbeats
//        (Lerdahl & Jackendoff MPR 2; Goto downbeat detection)
//   VP3: Bass register onset clustering — bass onsets prefer beat 1
//        (Klapuri 2006; Goto multi-level beat tracking)
//
// Phase 6 TODO — Viewpoint 4: Onset Density Periodicity
// ─────────────────────────────────────────────────────
// Autocorrelation at bar-level timescales to distinguish 3/4 from 4/4.
// Currently hardcoded to 4/4 (beatsPerBar = 4). Adding this viewpoint
// requires hierarchical inference: TempoEngine settles the tactus first,
// then BarTracker infers grouping from residual periodicity. Risk: the
// same accent pattern that signals "bar boundary" to the grouping detector
// can confuse TempoEngine into tracking bar-rate as beat-rate (e.g. 120 BPM
// in 3/4 → TempoEngine drifts toward 40 BPM). Mitigation: only infer
// grouping when TempoEngine confidence > 0.5 and tactus is stable.
// Design interface so beatsPerBar can change without downstream rewiring:
// getBeatsPerBar() is a method, not a constant.
// ─────────────────────────────────────────────────────
//
// Architecture:
//   Event-driven — updates on human notes and chord changes.
//   Phase is computed lazily from lastDownbeatTime + barPeriod.
//   No tick() needed; barPeriod derived from TempoEngine on each query.
//
// Coupling model (Large & Jones Dynamic Attending Theory):
//   Each viewpoint produces a phase correction that shifts lastDownbeatTime.
//   Corrections are confidence-weighted and asymmetric:
//   confirming evidence couples gently, contradicting evidence couples harder.
//   Genre coupling strength derived from GENRE_CONFIG.antiOsc:
//   high antiOsc (sequencer) → strong coupling, low (jazz) → weak.
//
// Only HUMAN notes update the tracker — assistant notes are excluded.
// The player is the authority on metric feel; the system follows.
//
// Wiring (app.js):
//   onNoteInput → BarTracker.onHumanNote(pc, register, time)
//   EventBus 'chordChanged' → self-registered listener
//
// Script load order: after ownership-detector, before context-integrator.

var BarTracker = (function() {

  // ── State ──
  var lastDownbeatTime = 0;    // estimated time of most recent beat 1
  var barConfidence = 0;        // 0.0 (unknown) to 1.0 (locked)
  var beatsPerBar = 4;          // hardcoded 4/4; Phase 6 viewpoint 4 may infer this
  var lastHumanNoteTime = 0;    // for IOI gap detection (VP2)
  var lastChordChangeTime = 0;  // for harmonic rhythm interval (VP1)
  var lastConfidenceTime = 0;   // for time-based confidence decay
  var eventCount = 0;           // total events processed (warm-up gate)

  // ── Coupling constants ──
  // Tuned for 200Hz tick rate, ~120 BPM baseline.
  // Asymmetric: contradicting evidence corrects faster than confirming
  // evidence reinforces. This prevents false lock from persisting.
  var CONFIRM_COUPLING = 0.08;
  var CONTRADICT_COUPLING = 0.15;

  // Confirming threshold: events within this phase distance (in bar fraction)
  // of the expected strong beat count as "confirming." 0.12 ≈ half a beat in 4/4.
  var CONFIRM_THRESHOLD = 0.12;

  // Confidence dynamics
  var CONFIDENCE_GAIN = 0.06;    // per confirming event (weighted)
  var CONFIDENCE_LOSS = 0.12;    // per contradicting event (2× gain)
  var CONFIDENCE_HALFLIFE_BARS = 4; // confidence halves after 4 bars of silence

  // Viewpoint weights — sum to ~1.0
  // Harmonic change is the strongest single cue (Temperley).
  // Bass clustering is the most consistent (Klapuri/Goto).
  // Gap boundaries are episodic but high-confidence when they fire.
  var VP_WEIGHT_CHORD = 0.45;
  var VP_WEIGHT_GAP = 0.30;
  var VP_WEIGHT_BASS = 0.25;

  // ── Core: bar period from tempo ──
  function getBarPeriod() {
    var beatMs = 60000 / Math.max(30, TempoEngine.getEffectiveBPM());
    return beatMs * beatsPerBar;
  }

  // ── Core: current phase (0.0 = downbeat, 1.0 = next downbeat) ──
  // Lazy computation — derived from lastDownbeatTime and current barPeriod.
  // No tick() accumulator needed.
  function getBarPhase(atTime) {
    var now = atTime || Date.now();
    if (lastDownbeatTime === 0) return 0;
    var barMs = getBarPeriod();
    if (barMs <= 0) return 0;
    var elapsed = now - lastDownbeatTime;
    // Modular phase, handles negative elapsed (shouldn't happen but safe)
    var phase = ((elapsed % barMs) + barMs) % barMs;
    return phase / barMs;
  }

  // ── Core: beat within bar (0 = beat 1, 1 = beat 2, ... 3 = beat 4) ──
  function getBeatInBar(atTime) {
    return Math.floor(getBarPhase(atTime) * beatsPerBar);
  }

  // ── Core: convenience checks ──
  // toleranceBeats: how close to the target (in beats) counts as "near"
  function isNearDownbeat(toleranceBeats) {
    toleranceBeats = toleranceBeats || 0.5;
    var phase = getBarPhase();
    var beatPhase = phase * beatsPerBar;
    // Near beat 1: phase near 0 or wrapping around near beatsPerBar
    return beatPhase < toleranceBeats || beatPhase > (beatsPerBar - toleranceBeats);
  }

  function isNearStrongBeat(toleranceBeats) {
    toleranceBeats = toleranceBeats || 0.5;
    var phase = getBarPhase();
    var beatPhase = phase * beatsPerBar;
    // Beat 1 (0.0) or beat 3 (midpoint of bar)
    var halfBar = beatsPerBar / 2;
    return beatPhase < toleranceBeats ||
           beatPhase > (beatsPerBar - toleranceBeats) ||
           Math.abs(beatPhase - halfBar) < toleranceBeats;
  }

  // ── Time-based confidence decay ──
  // Applied on each event. Confidence halves after CONFIDENCE_HALFLIFE_BARS
  // bars of silence. During active play (events every ~200-500ms), decay
  // is negligible. During long pauses, confidence drops steadily.
  function decayConfidence(time) {
    if (lastConfidenceTime === 0) {
      lastConfidenceTime = time;
      return;
    }
    var elapsed = time - lastConfidenceTime;
    if (elapsed <= 0) {
      lastConfidenceTime = time;
      return;
    }
    var halfLifeMs = getBarPeriod() * CONFIDENCE_HALFLIFE_BARS;
    if (halfLifeMs > 0) {
      barConfidence *= Math.exp(-0.693 * elapsed / halfLifeMs);
    }
    lastConfidenceTime = time;
  }

  // ── Phase correction engine ──
  // Called by each viewpoint with:
  //   eventTime:   when the event occurred
  //   targetPhase: where the viewpoint expects a strong beat (0.0 = downbeat)
  //   weight:      viewpoint weight (VP_WEIGHT_*)
  //   genreCoupling: 0-1, from genre config (high = rigid meter)
  function applyPhaseCorrection(eventTime, targetPhase, weight, genreCoupling) {
    var barMs = getBarPeriod();
    if (barMs <= 0) return;

    var currentPhase = getBarPhase(eventTime);

    // Phase error: signed distance from current phase to target.
    // Wrap to [-0.5, 0.5] — shortest angular path.
    var error = currentPhase - targetPhase;
    if (error > 0.5) error -= 1.0;
    if (error < -0.5) error += 1.0;

    var absError = Math.abs(error);
    var isConfirming = absError < CONFIRM_THRESHOLD;

    // Select coupling strength — asymmetric
    var coupling = isConfirming ? CONFIRM_COUPLING : CONTRADICT_COUPLING;
    coupling *= weight * genreCoupling;

    // Shift lastDownbeatTime to reduce phase error
    var correctionMs = error * barMs * coupling;
    lastDownbeatTime += correctionMs;

    // Update confidence
    if (isConfirming) {
      barConfidence = Math.min(1.0, barConfidence + CONFIDENCE_GAIN * weight);
    } else {
      barConfidence = Math.max(0, barConfidence - CONFIDENCE_LOSS * weight * absError);
    }

    eventCount++;
  }

  // ── Genre coupling ──
  // Derived from antiOsc: high = metronomic (electronic), low = flexible (jazz).
  // Maps antiOsc range [0.3, 0.95] → coupling [0.3, 1.0].
  function getGenreCoupling() {
    var gc = getGenreConfig(SharedState.genre);
    return 0.3 + Math.max(0, Math.min(1, (gc.antiOsc - 0.3) / 0.65)) * 0.7;
  }

  // ═══ VIEWPOINT 1: Harmonic Change ═══
  // Chord changes are the strongest metric cue (Temperley).
  // Most likely on beat 1; if phase is close to beat 3, allow that interpretation.
  // Regular harmonic rhythm (chord changes at ~barPeriod intervals) gets a bonus.
  function onChordChange(time) {
    time = time || Date.now();
    decayConfidence(time);
    var gc = getGenreCoupling();

    // Bootstrap: first chord change sets the downbeat estimate
    if (lastDownbeatTime === 0 || eventCount < 2) {
      lastDownbeatTime = time;
      lastChordChangeTime = time;
      barConfidence = 0.1;
      eventCount++;
      return;
    }

    // Regular harmonic rhythm bonus: if the interval between consecutive
    // chord changes is ~1 bar or ~2 bars, this is strong phase evidence.
    var harmonicRhythmBonus = 1.0;
    if (lastChordChangeTime > 0) {
      var intervalMs = time - lastChordChangeTime;
      var barMs = getBarPeriod();
      if (barMs > 0) {
        var barRatio = intervalMs / barMs;
        if (Math.abs(barRatio - 1.0) < 0.2 || Math.abs(barRatio - 2.0) < 0.2) {
          harmonicRhythmBonus = 1.5;
        }
      }
    }

    // Determine target phase: beat 1 (0.0) or beat 3 (0.5 in 4/4).
    // When confidence is low, always assume beat 1 — don't guess beat 3
    // when the estimate is still forming.
    var targetPhase = 0.0;
    if (barConfidence > 0.3) {
      var phase = getBarPhase(time);
      var halfBar = beatsPerBar / 2;
      var beatPhase = phase * beatsPerBar;
      if (Math.abs(beatPhase - halfBar) < 1.0) {
        targetPhase = 0.5;  // close enough to beat 3 to interpret as such
      }
    }

    applyPhaseCorrection(time, targetPhase, VP_WEIGHT_CHORD * harmonicRhythmBonus, gc);
    lastChordChangeTime = time;
  }

  // ═══ VIEWPOINT 2: IOI Gap Boundaries ═══
  // Notes arriving after > 1.5 beats of silence strongly suggest a downbeat.
  // Longer gap → stronger pull toward beat 1 (Goto: re-entries after long
  // pauses almost always target the downbeat).
  function checkGapBoundary(time) {
    if (lastHumanNoteTime === 0) return;
    var gap = time - lastHumanNoteTime;
    var beatMs = 60000 / Math.max(30, TempoEngine.getEffectiveBPM());

    // Only trigger on meaningful gaps (> 1.5 beats)
    if (gap < beatMs * 1.5) return;

    var gc = getGenreCoupling();

    // Gap strength: moderate at 1.5 beats, strong at 4+ beats. Capped at 1.5.
    var gapStrength = Math.min(1.5, gap / (beatMs * 4));

    // Re-entry after gap targets beat 1 (phase 0.0)
    applyPhaseCorrection(time, 0.0, VP_WEIGHT_GAP * gapStrength, gc);
  }

  // ═══ VIEWPOINT 3: Bass Register Clustering ═══
  // Bass onsets disproportionately land on beat 1 in tonal music (Klapuri, Goto).
  // Only human bass notes — assistant bass is excluded to prevent circular
  // reinforcement (tracker confirms its own hypothesis via BassAssistant).
  function checkBassOnset(pc, register, time) {
    if (register !== 'bass') return;
    var gc = getGenreCoupling();

    // Bass onsets pull toward beat 1 (phase 0.0).
    // Consistent over time, so no gap-style modulation needed.
    applyPhaseCorrection(time, 0.0, VP_WEIGHT_BASS, gc);
  }

  // ═══ PUBLIC: Human Note Event ═══
  // Called from app.js onNoteInput — human notes ONLY.
  // Feeds VP2 (gap detection) and VP3 (bass clustering).
  // VP1 (chord changes) is fed via EventBus listener.
  function onHumanNote(pc, register, time) {
    time = time || Date.now();
    decayConfidence(time);

    // Bootstrap: first note sets the downbeat
    if (lastDownbeatTime === 0) {
      lastDownbeatTime = time;
      lastHumanNoteTime = time;
      lastConfidenceTime = time;
      eventCount++;
      return;
    }

    // VP2: check for silence gap before this note
    checkGapBoundary(time);

    // VP3: bass onset clustering
    checkBassOnset(pc, register, time);

    lastHumanNoteTime = time;
  }

  // ── Self-register EventBus listener for chord changes ──
  if (typeof EventBus !== 'undefined') {
    EventBus.on('chordChanged', function(data) {
      onChordChange(Date.now());
    });
  }

  function getBarConfidence() {
    return barConfidence;
  }

  // ── Phase 5B: Metric fitness scoring for phrase selection ──
  // Used by assistant selectPhrase() to prefer metrically aligned phrases.
  // All scores are pre-multiplied by barConfidence — returns 0 when uncertain.

  // How many beats until the next downbeat from current time.
  function getBeatsUntilDownbeat() {
    var phase = getBarPhase();
    if (phase < 0.001) return 0;  // already at downbeat
    return (1.0 - phase) * beatsPerBar;
  }

  // How many beats until the nearest strong beat (beat 1 or beat 3 in 4/4).
  // Used by rhythm for bar-aligned scheduling — rhythm targets any strong beat,
  // not just the downbeat.
  function getBeatsUntilStrongBeat() {
    var phase = getBarPhase();
    if (phase < 0.001) return 0;
    var toBeat1 = (1.0 - phase) * beatsPerBar;
    // Beat 3 is at phase 0.5 in 4/4
    var halfPhase = 0.5;
    var toHalf = ((halfPhase - phase + 1.0) % 1.0) * beatsPerBar;
    return Math.min(toBeat1, toHalf);
  }

  // Score how close "now" is to a strong metric position (0.0–1.0).
  // 1.0 = right on beat 1, ~0.7 = on beat 3, 0.0 = beat 2 or 4.
  // Pre-multiplied by confidence.
  function scoreStartMetric() {
    if (barConfidence < 0.03) return 0;
    var beatPos = getBarPhase() * beatsPerBar;
    // Distance to nearest strong beat (0 or beatsPerBar/2)
    var halfBar = beatsPerBar / 2;
    var distToBeat1 = beatPos < halfBar ? beatPos : beatsPerBar - beatPos;
    var distToBeat3 = Math.abs(beatPos - halfBar);
    var minDist = Math.min(distToBeat1, distToBeat3);
    // Score: 1.0 at strong beat, decays to 0 at 1 beat away
    var raw = Math.max(0, 1.0 - minDist);
    // Beat 1 is stronger than beat 3
    if (distToBeat1 <= distToBeat3) raw *= 1.0;
    else raw *= 0.7;
    return raw * barConfidence;
  }

  // Score how close "now + durationBeats" lands to a strong beat (0.0–1.0).
  // Used to evaluate whether a phrase's ending resolves on a downbeat.
  // Pre-multiplied by confidence.
  function scoreEndMetric(durationBeats) {
    if (barConfidence < 0.03 || durationBeats <= 0) return 0;
    var startPhase = getBarPhase();
    var endPhase = startPhase + durationBeats / beatsPerBar;
    endPhase = endPhase - Math.floor(endPhase);  // wrap to [0, 1)
    var beatPos = endPhase * beatsPerBar;
    var halfBar = beatsPerBar / 2;
    var distToBeat1 = beatPos < halfBar ? beatPos : beatsPerBar - beatPos;
    var distToBeat3 = Math.abs(beatPos - halfBar);
    var minDist = Math.min(distToBeat1, distToBeat3);
    var raw = Math.max(0, 1.0 - minDist);
    if (distToBeat1 <= distToBeat3) raw *= 1.0;
    else raw *= 0.7;
    return raw * barConfidence;
  }

  // Combined phrase metric score for quick use in selectPhrase().
  // startWeight/endWeight let each role emphasize differently:
  //   bass: high startWeight (anchor beat 1), moderate endWeight
  //   rhythm: balanced (fill the bar evenly)
  //   solo: low startWeight (free entry), moderate endWeight (resolve well)
  function scorePhraseMetric(durationBeats, startWeight, endWeight) {
    return scoreStartMetric() * (startWeight || 0.5) +
           scoreEndMetric(durationBeats) * (endWeight || 0.5);
  }

  function reset() {
    lastDownbeatTime = 0;
    barConfidence = 0;
    lastHumanNoteTime = 0;
    lastChordChangeTime = 0;
    lastConfidenceTime = 0;
    eventCount = 0;
  }

  return {
    onHumanNote:          onHumanNote,
    onChordChange:        onChordChange,
    getBarPhase:          getBarPhase,
    getBarPeriod:         getBarPeriod,
    getBarConfidence:     getBarConfidence,
    getBeatInBar:         getBeatInBar,
    getBeatsUntilDownbeat:  getBeatsUntilDownbeat,
    getBeatsUntilStrongBeat: getBeatsUntilStrongBeat,
    isNearDownbeat:       isNearDownbeat,
    isNearStrongBeat:     isNearStrongBeat,
    scoreStartMetric:     scoreStartMetric,
    scoreEndMetric:       scoreEndMetric,
    scorePhraseMetric:    scorePhraseMetric,
    getBeatsPerBar:       function() { return beatsPerBar; },
    reset:                reset
  };

})();

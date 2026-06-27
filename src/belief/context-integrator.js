'use strict';
// ═══ CONTEXT INTEGRATOR (Gen3 Phase 3 + Cross-Voice Awareness) ═══
// Cross-assistant awareness hub. Passive — assistants query it, it does not push.
// Each assistant reads this shared state and applies its own listening rules.
// No assistant commands another — only measured ensemble properties are published.
//
// Responsibilities:
//   1. Pitch saturation tracking — which PCs are overrepresented across all voices
//   2. Voice stability state — whether peers are in stable/exploratory mode
//   3. Per-voice activity tracking — density, contour, recent note history
//   4. Pairwise measurements — harmonic intervals, rhythmic phase alignment
//   5. Ensemble snapshot — total density, register distribution, relational entropy
//
// Update flow (app.js, once per tick after FinalCoordinator.coordinate()):
//   ContextIntegrator.update(resolvedBassPC, resolvedRhythmPC, resolvedSoloistPC, sources)
//
// Query flow (called inside assistant onTick() — always one tick behind, which is fine):
//   ContextIntegrator.getSaturationBiases()  → [{pc, boost}] with boost < 1.0
//   ContextIntegrator.getSaturatedPCs()      → [pc, ...]
//   ContextIntegrator.getVoiceState(voice)   → {pc, source, time}
//   ContextIntegrator.isRhythmStable()       → bool
//   ContextIntegrator.isBassStable()         → bool
//   ContextIntegrator.getEnsembleSnapshot()  → {totalDensity, registerSpread, ...}
//   ContextIntegrator.getVoiceDensity(voice) → notes/sec
//   ContextIntegrator.getVoiceContour(voice) → -1 (desc), 0 (static), 1 (asc)
//   ContextIntegrator.getPairwiseInterval(v1, v2) → semitones (0-11) or null
//   ContextIntegrator.getRelationalEntropy() → 0-1 cross-voice tension

var ContextIntegrator = (function() {

  // ── Saturation bins ──
  // 12 bins (one per pitch class), weighted by voice authority.
  // Bass notes contribute the most (1.0) — bass defines the harmony.
  // Rhythm notes contribute 0.8, solo 0.6.
  // Decayed per update() call so recent notes matter most.
  var saturationBins = [0,0,0,0,0,0,0,0,0,0,0,0];
  var SATURATION_DECAY = 0.92;   // per-tick decay — ~2-beat half-life at 120BPM/16ms ticks
  // Aligned with HARMONIC_AUTHORITY_WEIGHT (constants.js).
  // Terhardt 1974: bass defines harmonic identity. Parncutt 1989: pitch salience logarithmic toward low register.
  var SAT_VOICE_WEIGHT = { bass: 1.0, rhythm: 0.85, soloist: 0.45, lead: 0.95, human: 0.50 };

  // ── Voice state ──
  // Per-voice snapshot of the most recently resolved note.
  // source: 'ppm' | 'lexicon' | 'loop' | 'motif' | 'generate'
  // progress: 0.0 (just started phrase) to 1.0 (done/between phrases)
  var voiceStates = {
    bass:   { pc: null, source: 'ppm', time: 0, progress: 1.0 },
    rhythm: { pc: null, source: 'ppm', time: 0, progress: 1.0 },
    soloist: { pc: null, source: 'ppm', time: 0, progress: 1.0 },
    lead:   { pc: null, source: 'ppm', time: 0, progress: 1.0 }
  };

  // ── Per-voice activity tracking (Cross-Voice Awareness) ──
  // Echoic memory window — how long sounds linger in sensory memory (Cowan/Neisser)
  var DENSITY_WINDOW_MS = (typeof BeliefState !== 'undefined' && BeliefState.PERCEPTUAL)
    ? BeliefState.PERCEPTUAL.ECHOIC_MEMORY : 3500;
  var CONTOUR_WINDOW = 4;        // last N notes for contour direction

  var voiceActivity = {
    bass:       { noteTimestamps: [], recentPCs: [], density: 0, contour: 0 },
    rhythm:     { noteTimestamps: [], recentPCs: [], density: 0, contour: 0 },
    soloist:     { noteTimestamps: [], recentPCs: [], density: 0, contour: 0 },
    percussion: { noteTimestamps: [], recentPCs: [], density: 0, contour: 0 },
    lead:       { noteTimestamps: [], recentPCs: [], density: 0, contour: 0 },
    human:      { noteTimestamps: [], recentPCs: [], density: 0, contour: 0 }
  };

  // ── Observation channel tracking (v2.1 redesign) ──
  // Harmonic rhythm: track PC-set snapshots at beat-rate intervals
  var _harmonicWindows = [];       // rolling array of {pcSet: Object, time: ms}
  var _HARMONIC_SNAP_INTERVAL = 250; // snapshot every ~250ms (roughly 8th-note at 120bpm)
  var _lastHarmonicSnapTime = 0;
  var _HARMONIC_SHIFT_THRESHOLD = 1; // v2.2: reverted to 1. Threshold=2 over-corrected (0.03 range, pushed needs_space)

  // Repetition novelty: rolling PC-set snapshots for Jaccard comparison
  var _noveltyWindows = [];        // rolling array of Set objects (1 per half-beat)
  var _NOVELTY_COMPARE_DEPTH = 8;  // compare current against last 8 windows
  var _noveltyAccumMs = 0;

  // Onset regularity: all recent onset timestamps (cross-voice)
  // Already tracked in voiceActivity.noteTimestamps per voice

  // Dynamic arc: velocity tracking (time-based rolling window)
  var _velocityHistory = [];       // {vel: 0-127, time: ms} — all voices combined (global)
  var _VELOCITY_TIME_WINDOW_MS = 5000; // 5-second rolling window (replaces note-count _VELOCITY_WINDOW)

  // v2.2: Per-voice observation data structures
  var _velocityHistoryPerVoice = {
    bass: [], rhythm: [], soloist: [], percussion: [], lead: [], human: []
  };
  var _noveltyWindowsPerVoice = {
    bass: [], rhythm: [], soloist: [], percussion: [], lead: [], human: []
  };

  // ── Ensemble snapshot (recomputed each tick) ──
  var ensembleSnapshot = {
    totalDensity: 0,        // sum of all voice densities (notes/sec)
    activeVoiceCount: 0,    // how many voices played in last 2 seconds
    registerSpread: 0,      // 0 (all same range) to 1 (max spread)
    relationalEntropy: 0,   // 0 (all voices similar) to 1 (maximum tension)
    intervalTension: 0,     // 0 (consonant) to 1 (dissonant) across all pairs
    phaseAlignment: 0       // 0 (all starting phrases together) to 1 (staggered)
  };

  // ── Interval consonance table (for tension measurement) ──
  // 0=unison, 7=fifth are most consonant; 1,2,6,11 are most tense
  var INTERVAL_TENSION = [0, 0.9, 0.7, 0.3, 0.2, 0.5, 1.0, 0.1, 0.3, 0.2, 0.5, 0.8];

  // ── update() ──
  // Called from app.js once per tick, with the PCs that actually played
  // (already collision-resolved by FinalCoordinator — null if voice was silent).
  // sources: {bass: string, rhythm: string, soloist: string}
  // progress: {bass: 0-1, rhythm: 0-1, soloist: 0-1} — phrase arc position (Phase 5B)
  function update(bassPC, rhythmPC, soloistPC, sources, progress, velocities) {
    sources = sources || {};
    progress = progress || {};
    velocities = velocities || {};
    var now = Date.now();

    // Decay all bins each tick
    for (var i = 0; i < 12; i++) saturationBins[i] *= SATURATION_DECAY;

    // Record bass
    _updateVoice('bass', bassPC, sources.bass, progress.bass, now, velocities.bass);
    // Record rhythm
    _updateVoice('rhythm', rhythmPC, sources.rhythm, progress.rhythm, now, velocities.rhythm);
    // Record solo
    _updateVoice('soloist', soloistPC, sources.soloist, progress.soloist, now, velocities.soloist);

    // Update observation channel trackers
    _updateHarmonicWindows(now);
    _updateNoveltyWindows(now);

    // Recompute ensemble snapshot
    _updateEnsembleSnapshot(now);
  }

  // ── _updateVoice() — per-voice state + activity tracking ──
  function _updateVoice(voice, pc, source, prog, now, vel) {
    if (pc !== null) {
      saturationBins[pc] += SAT_VOICE_WEIGHT[voice];
      voiceStates[voice] = {
        pc: pc,
        source: source || 'ppm',
        time: now,
        progress: (prog !== undefined) ? prog : 1.0
      };

      // Velocity tracking for dynamic arc (global + per-voice, time-based window)
      if (vel !== undefined && vel > 0) {
        _velocityHistory.push({ vel: vel, time: now });
        // Prune entries older than time window
        var velCutoff = now - _VELOCITY_TIME_WINDOW_MS;
        while (_velocityHistory.length > 0 && _velocityHistory[0].time < velCutoff) {
          _velocityHistory.shift();
        }
        // v2.2: per-voice velocity history
        var pvh = _velocityHistoryPerVoice[voice];
        if (pvh) {
          pvh.push({ vel: vel, time: now });
          while (pvh.length > 0 && pvh[0].time < velCutoff) {
            pvh.shift();
          }
        }
      }

      // Activity tracking
      var act = voiceActivity[voice];
      act.noteTimestamps.push(now);
      act.recentPCs.push(pc);
      if (act.recentPCs.length > CONTOUR_WINDOW) act.recentPCs.shift();

      // Trim old timestamps
      var cutoff = now - DENSITY_WINDOW_MS;
      while (act.noteTimestamps.length > 0 && act.noteTimestamps[0] < cutoff) {
        act.noteTimestamps.shift();
      }

      // Compute density (notes/sec)
      act.density = act.noteTimestamps.length / (DENSITY_WINDOW_MS / 1000);

      // Compute contour direction from recent PCs
      act.contour = _computeContour(act.recentPCs);

      // Bass note bar-phase tracking for bidirectional percussion coupling
      // Prefer BarTracker (human-input calibrated), fall back to PhaseCoupling (freerun)
      if (voice === 'bass') {
        var _bassPhase = 0;
        if (typeof BarTracker !== 'undefined' && BarTracker.getBarConfidence() > 0) {
          _bassPhase = BarTracker.getBarPhase();
        } else if (typeof PhaseCoupling !== 'undefined' && PhaseCoupling.getBarPhase) {
          _bassPhase = PhaseCoupling.getBarPhase('bass') || 0;
        }
        _bassNotePhases.push({ phase: _bassPhase, time: now });
        if (_bassNotePhases.length > _BASS_PHASE_MAX) _bassNotePhases.shift();
      }
    } else {
      // No note this tick — just update progress and decay density slightly
      if (prog !== undefined) {
        voiceStates[voice].progress = prog;
      }
      // Trim old timestamps even when silent
      var act2 = voiceActivity[voice];
      var cutoff2 = now - DENSITY_WINDOW_MS;
      while (act2.noteTimestamps.length > 0 && act2.noteTimestamps[0] < cutoff2) {
        act2.noteTimestamps.shift();
      }
      act2.density = act2.noteTimestamps.length / (DENSITY_WINDOW_MS / 1000);
    }
  }

  // ── _computeContour() — direction of recent pitch motion ──
  // Returns -1 (descending), 0 (static/ambiguous), 1 (ascending)
  function _computeContour(recentPCs) {
    if (recentPCs.length < 2) return 0;
    var ups = 0;
    var downs = 0;
    for (var i = 1; i < recentPCs.length; i++) {
      var diff = recentPCs[i] - recentPCs[i - 1];
      // Wrap around pitch class circle (shortest distance)
      if (diff > 6) diff -= 12;
      if (diff < -6) diff += 12;
      if (diff > 0) ups++;
      else if (diff < 0) downs++;
    }
    var total = ups + downs;
    if (total === 0) return 0;
    var ratio = (ups - downs) / total;  // -1 to 1
    if (ratio > 0.3) return 1;
    if (ratio < -0.3) return -1;
    return 0;
  }

  // ── _updateEnsembleSnapshot() — aggregate metrics ──
  function _updateEnsembleSnapshot(now) {
    var voices = ['bass', 'rhythm', 'soloist', 'lead'];

    // Total density (including percussion)
    var totalDens = 0;
    var activeCount = 0;
    var recentCutoff = now - 2000;
    for (var i = 0; i < voices.length; i++) {
      totalDens += voiceActivity[voices[i]].density;
      if (voiceStates[voices[i]].time > recentCutoff) activeCount++;
    }
    // Percussion contributes to density and active count
    var percDens = voiceActivity.percussion ? voiceActivity.percussion.density : 0;
    totalDens += percDens;
    if (percDens > 0) activeCount++;

    ensembleSnapshot.totalDensity = totalDens;
    ensembleSnapshot.activeVoiceCount = activeCount;

    // Register spread — measure how far apart voice PCs are
    // (placeholder using PC distance; will use actual MIDI registers when available)
    var activePCs = [];
    for (var j = 0; j < voices.length; j++) {
      if (voiceStates[voices[j]].pc !== null && voiceStates[voices[j]].time > recentCutoff) {
        activePCs.push(voiceStates[voices[j]].pc);
      }
    }
    ensembleSnapshot.registerSpread = _computeRegisterSpread(activePCs);

    // Interval tension — average consonance/dissonance between all active pairs
    ensembleSnapshot.intervalTension = _computeIntervalTension(activePCs);

    // Phase alignment — how synchronized are phrase arcs?
    var progresses = [];
    for (var k = 0; k < voices.length; k++) {
      progresses.push(voiceStates[voices[k]].progress);
    }
    ensembleSnapshot.phaseAlignment = _computePhaseAlignment(progresses);

    // Relational entropy — composite of tension + density variance + contour opposition
    ensembleSnapshot.relationalEntropy = _computeRelationalEntropy();
  }

  // ── _computeRegisterSpread() ──
  function _computeRegisterSpread(pcs) {
    if (pcs.length < 2) return 0;
    var maxDist = 0;
    for (var i = 0; i < pcs.length; i++) {
      for (var j = i + 1; j < pcs.length; j++) {
        var d = Math.abs(pcs[i] - pcs[j]);
        if (d > 6) d = 12 - d;
        if (d > maxDist) maxDist = d;
      }
    }
    return maxDist / 6;  // normalize: 6 semitones (tritone) = max spread
  }

  // ── _computeIntervalTension() ──
  function _computeIntervalTension(pcs) {
    if (pcs.length < 2) return 0;
    var totalTension = 0;
    var pairs = 0;
    for (var i = 0; i < pcs.length; i++) {
      for (var j = i + 1; j < pcs.length; j++) {
        var interval = ((pcs[j] - pcs[i]) % 12 + 12) % 12;
        totalTension += INTERVAL_TENSION[interval];
        pairs++;
      }
    }
    return pairs > 0 ? totalTension / pairs : 0;
  }

  // ── _computePhaseAlignment() ──
  // 0 = all voices at same phrase position (synchronized)
  // 1 = voices maximally staggered
  function _computePhaseAlignment(progresses) {
    if (progresses.length < 2) return 0;
    var variance = 0;
    var mean = 0;
    for (var i = 0; i < progresses.length; i++) mean += progresses[i];
    mean /= progresses.length;
    for (var j = 0; j < progresses.length; j++) {
      variance += Math.pow(progresses[j] - mean, 2);
    }
    variance /= progresses.length;
    // Max variance when values are 0 and 1 = 0.25, so normalize by that
    return Math.min(1, variance / 0.25);
  }

  // ── _computeRelationalEntropy() ──
  // Composite measure of cross-voice tension from multiple dimensions:
  //   - interval tension (harmonic)
  //   - density variance (rhythmic)
  //   - contour opposition (melodic)
  function _computeRelationalEntropy() {
    var voices = ['bass', 'rhythm', 'soloist', 'lead'];

    // Density variance — are voices equally active or wildly different?
    var densities = [];
    for (var i = 0; i < voices.length; i++) {
      densities.push(voiceActivity[voices[i]].density);
    }
    var densVar = _variance(densities);
    // Normalize: max reasonable variance is ~4 (one voice at 4nps, others silent)
    var densityEntropy = Math.min(1, densVar / 4);

    // Contour opposition — voices moving in different directions = more tension
    var contours = [];
    for (var j = 0; j < voices.length; j++) {
      contours.push(voiceActivity[voices[j]].contour);
    }
    var contourOpposition = 0;
    var contourPairs = 0;
    for (var a = 0; a < contours.length; a++) {
      for (var b = a + 1; b < contours.length; b++) {
        if (contours[a] !== 0 && contours[b] !== 0 && contours[a] !== contours[b]) {
          contourOpposition += 1;  // contrary motion
        }
        contourPairs++;
      }
    }
    var contourEntropy = contourPairs > 0 ? contourOpposition / contourPairs : 0;

    // Blend: interval tension (40%), density variance (30%), contour opposition (30%)
    return ensembleSnapshot.intervalTension * 0.4 +
           densityEntropy * 0.3 +
           contourEntropy * 0.3;
  }

  // ── _variance() helper ──
  function _variance(arr) {
    if (arr.length < 2) return 0;
    var mean = 0;
    for (var i = 0; i < arr.length; i++) mean += arr[i];
    mean /= arr.length;
    var v = 0;
    for (var j = 0; j < arr.length; j++) v += Math.pow(arr[j] - mean, 2);
    return v / arr.length;
  }

  // ── getSaturationBiases() ──
  // Returns [{pc, boost}] for PCs that are overrepresented.
  // boost < 1.0 — assistants append this to their biases[] array and pass to applyRoleBias().
  // Only fires when there's enough ensemble activity to have meaningful saturation data.
  // Max downweight is 0.80 (never silence a note, just reduce its pull).
  function getSaturationBiases() {
    var biases = [];

    var maxBin = 0;
    for (var i = 0; i < 12; i++) {
      if (saturationBins[i] > maxBin) maxBin = saturationBins[i];
    }

    // Below this threshold the ensemble hasn't converged yet — no saturation signal
    if (maxBin < 1.5) return biases;

    for (var j = 0; j < 12; j++) {
      var norm = saturationBins[j] / maxBin;
      if (norm > 0.6) {
        // Linear scale: norm 0.6 → boost 1.0 (no change), norm 1.0 → boost 0.80
        var boost = 1.0 - (norm - 0.6) * 0.5;
        biases.push({ pc: j, boost: boost });
      }
    }
    return biases;
  }

  // ── getSaturatedPCs() ──
  // Returns the set of PCs currently above the saturation threshold.
  // Used by selectPhrase() to penalize phrase starts that would pile on.
  function getSaturatedPCs() {
    var maxBin = 0;
    for (var i = 0; i < 12; i++) {
      if (saturationBins[i] > maxBin) maxBin = saturationBins[i];
    }
    if (maxBin < 1.5) return [];

    var saturated = [];
    for (var j = 0; j < 12; j++) {
      if (saturationBins[j] / maxBin > 0.7) saturated.push(j);
    }
    return saturated;
  }

  // ── getVoiceState(voice) ──
  // Returns {pc, source, time} for the requested voice ('bass'|'rhythm'|'soloist').
  // Lets peer assistants inspect what the other voices are doing right now.
  function getVoiceState(voice) {
    return voiceStates[voice] || { pc: null, source: 'ppm', time: 0 };
  }

  // ── isRhythmStable() ──
  // True when rhythm is in loop or lexicon mode (reliable groove is present).
  // Solo can be more adventurous when rhythm is holding down a stable pattern.
  function isRhythmStable() {
    var src = voiceStates.rhythm.source;
    return src === 'loop' || src === 'lexicon';
  }

  // ── isBassStable() ──
  // True when bass is in loop or lexicon mode (harmonic anchor is solid).
  // Rhythm can extend further from chord tones when bass is locked in.
  function isBassStable() {
    var src = voiceStates.bass.source;
    return src === 'loop' || src === 'lexicon';
  }

  // ── Phase 5B: Phrase arc queries ──

  // getPhraseProgress(voice) — returns 0.0 to 1.0
  // Lets peer assistants know where a voice is in its current phrase.
  // 0.0 = just started, 1.0 = done/between phrases, 0.8+ = resolving.
  function getPhraseProgress(voice) {
    return voiceStates[voice] ? voiceStates[voice].progress : 1.0;
  }

  // isResolving(voice) — true when a voice is in the final 20% of its phrase.
  // Peers should avoid clashing with a resolving voice (it's heading toward
  // a resolution tone, likely root or fifth).
  function isResolving(voice) {
    return getPhraseProgress(voice) >= 0.8 && getPhraseProgress(voice) < 1.0;
  }

  // anyPeerReplanReady(excludeVoice) — true if any peer voice is between
  // phrases (progress = 1.0). Used by the stagger signal: when one voice
  // finishes, others delay replan by 1-2 beats.
  function anyPeerReplanReady(excludeVoice) {
    var voices = ['bass', 'rhythm', 'soloist', 'lead'];
    for (var i = 0; i < voices.length; i++) {
      if (voices[i] === excludeVoice) continue;
      if (voiceStates[voices[i]].progress >= 1.0 && voiceStates[voices[i]].source !== 'ppm') {
        return true;
      }
    }
    return false;
  }

  // shouldStagger(voice) — true if this voice should delay its replan
  // because a peer just started a new phrase (progress near 0).
  // The stagger window is progress < 0.15 on any peer — meaning a peer
  // just began a phrase within the last ~1 beat. Don't pile on.
  // Note: progress=0.0 means "phrase just scheduled, no notes consumed yet"
  // and progress=1.0 means "between phrases" — both are valid states.
  // v3.8.3: Added staleness check — if peer's progress hasn't been updated
  // recently (>3s), it's stale (voice is silent, not actively phrasing).
  // Stale progress=0 was causing permanent deadlock: all voices see a peer
  // at 0, all stagger, nobody can start.
  function shouldStagger(voice) {
    var voices = ['bass', 'rhythm', 'soloist', 'lead'];
    var now = Date.now();
    for (var i = 0; i < voices.length; i++) {
      if (voices[i] === voice) continue;
      var vs = voiceStates[voices[i]];
      var p = vs.progress;
      if (p < 0.15) {
        // Only stagger if this peer's state was recently updated (active phrasing)
        var lastNote = vs.time || 0;
        if (now - lastNote > 3000) continue;  // stale — peer is silent, not phrasing
        return true;
      }
    }
    return false;
  }

  // ══════════════════════════════════════
  // NEW QUERY METHODS (Cross-Voice Awareness)
  // ══════════════════════════════════════

  // getVoiceDensity(voice) — notes/sec for a specific voice
  function getVoiceDensity(voice) {
    return voiceActivity[voice] ? voiceActivity[voice].density : 0;
  }

  // getVoiceContour(voice) — melodic direction: -1 (desc), 0 (static), 1 (asc)
  function getVoiceContour(voice) {
    return voiceActivity[voice] ? voiceActivity[voice].contour : 0;
  }

  // getPairwiseInterval(v1, v2) — pitch class interval between two voices
  // Returns 0-11 semitones or null if either voice is silent
  function getPairwiseInterval(v1, v2) {
    var pc1 = voiceStates[v1] ? voiceStates[v1].pc : null;
    var pc2 = voiceStates[v2] ? voiceStates[v2].pc : null;
    if (pc1 === null || pc2 === null) return null;
    return ((pc2 - pc1) % 12 + 12) % 12;
  }

  // getPairwiseTension(v1, v2) — consonance/dissonance between two voices (0-1)
  function getPairwiseTension(v1, v2) {
    var interval = getPairwiseInterval(v1, v2);
    if (interval === null) return 0;
    return INTERVAL_TENSION[interval];
  }

  // getEnsembleSnapshot() — full ensemble state for persona interpretation
  // This is the primary read-only "shared context" that each assistant reads.
  // Each assistant applies its own listening rules to this data.
  function getEnsembleSnapshot() {
    return {
      totalDensity:      ensembleSnapshot.totalDensity,
      activeVoiceCount:  ensembleSnapshot.activeVoiceCount,
      registerSpread:    ensembleSnapshot.registerSpread,
      intervalTension:   ensembleSnapshot.intervalTension,
      phaseAlignment:    ensembleSnapshot.phaseAlignment,
      relationalEntropy: ensembleSnapshot.relationalEntropy,
      // Per-voice quick reads (so assistants don't need separate calls)
      voiceDensities: {
        bass:   voiceActivity.bass.density,
        rhythm: voiceActivity.rhythm.density,
        soloist: voiceActivity.soloist.density,
        lead:   voiceActivity.lead.density
      },
      voiceContours: {
        bass:   voiceActivity.bass.contour,
        rhythm: voiceActivity.rhythm.contour,
        soloist: voiceActivity.soloist.contour,
        lead:   voiceActivity.lead.contour
      },
      voiceSources: {
        bass:   voiceStates.bass.source,
        rhythm: voiceStates.rhythm.source,
        soloist: voiceStates.soloist.source,
        lead:   voiceStates.lead.source
      },
      voicePCs: {
        bass:   voiceStates.bass.pc,
        rhythm: voiceStates.rhythm.pc,
        soloist: voiceStates.soloist.pc,
        lead:   voiceStates.lead.pc
      },
      // Percussion fields
      percussionPattern: _lastPercPattern,
      kickDensity: getDrumDensity('kick'),
      hatDensity:  getDrumDensity('hat'),
      percussionDensity: getPercussionDensity()
    };
  }

  // getRelationalEntropy() — quick access for temperature/adventurousness calcs
  function getRelationalEntropy() {
    return ensembleSnapshot.relationalEntropy;
  }

  // isDensityBudgetExceeded(sectionDensity) — true if ensemble is too dense
  // sectionDensity: 0-1 from SectionTracker, used as target density level
  // timeGrainMs: optional mode time grain from BeliefState (v2.1)
  // Returns true when total note density exceeds the section's budget
  function isDensityBudgetExceeded(sectionDensity, timeGrainMs) {
    var budget;
    if (timeGrainMs && timeGrainMs > 0) {
      // v2.1: time-grain-aware budget — events per grain window → nps
      var eventsPerGrain = 2 + sectionDensity * 6;
      budget = eventsPerGrain / (timeGrainMs / 1000);
    } else {
      // Fallback: original fixed budget
      budget = 2 + sectionDensity * 8;
    }
    return ensembleSnapshot.totalDensity > budget;
  }

  // getPeerRecentPCs(excludeVoice) — recent PCs from all peers except the caller
  // Returns {bass: [pc,...], rhythm: [pc,...], ...} excluding the requesting voice.
  // Used by ensemble-aware scoring (v3 Phase 3) so each voice can avoid or complement peers.
  function getPeerRecentPCs(excludeVoice) {
    var result = {};
    var voices = ['bass', 'rhythm', 'soloist', 'lead'];
    for (var i = 0; i < voices.length; i++) {
      if (voices[i] === excludeVoice) continue;
      result[voices[i]] = voiceActivity[voices[i]].recentPCs.slice();
    }
    return result;
  }

  // getContrastOpportunity(voice) — does this voice have room to contrast?
  // Returns 0-1. High when peers are consonant and in similar motion (room to diverge).
  // Low when peers are already tense (adding more tension would be muddy).
  function getContrastOpportunity(voice) {
    var peers = ['bass', 'rhythm', 'soloist', 'lead'].filter(function(v) { return v !== voice; });
    if (peers.length === 0) return 0.5;

    // If peers are consonant with each other → room for this voice to add spice
    var peerInterval = getPairwiseInterval(peers[0], peers[1]);
    var peerTension = peerInterval !== null ? INTERVAL_TENSION[peerInterval] : 0.5;

    // If peers move similarly → room for contrary motion
    var peerContours = peers.map(function(p) { return voiceActivity[p].contour; });
    var sameDirection = (peerContours[0] === peerContours[1] && peerContours[0] !== 0) ? 1 : 0;

    // High opportunity when peers are consonant and moving together
    return (1 - peerTension) * 0.5 + sameDirection * 0.5;
  }

  // getPeerGrooveInvitation(voice) — detect groove invitation from peers
  // Returns 0-1. High when peers play repetitive, regular, dynamically flat patterns.
  // Psychoacoustic basis: Witek 2014 (groove), Large & Jones 1999 (entrainment).
  // Human groove weighs 2x — explicit invitation from bandleader.
  function getPeerGrooveInvitation(voice) {
    var peers = ['bass', 'rhythm', 'soloist', 'lead', 'percussion', 'human'];
    var HUMAN_WEIGHT = 2.0;
    var totalSignal = 0, totalWeight = 0;

    for (var i = 0; i < peers.length; i++) {
      if (peers[i] === voice) continue;
      var act = voiceActivity[peers[i]];
      if (!act || act.noteTimestamps.length < 4) continue;

      // Three groove indicators (multiplicative — all must be present):
      // 1. Repetitive pitch content (low novelty)
      var novelty = getRepetitionNoveltyPerVoice(peers[i]);
      var repScore = Math.min(1.0, Math.max(0, 1.0 - novelty / 0.3));
      // 2. Regular timing (high onset regularity)
      var regularity = getOnsetRegularityPerVoice(peers[i]);
      var regScore = Math.max(0, (regularity - 0.6) / 0.4);
      // 3. Flat dynamics (steady groove, not building/fading)
      var dynArc = getDynamicArcPerVoice(peers[i]);
      var dynScore = Math.min(1.0, Math.max(0, 1.0 - Math.abs(dynArc - 0.5) / 0.15));

      var peerGroove = repScore * regScore * dynScore;
      var w = (peers[i] === 'human') ? HUMAN_WEIGHT : 1.0;
      totalSignal += peerGroove * w;
      totalWeight += w;
    }
    return totalWeight > 0 ? totalSignal / totalWeight : 0;
  }

  function reset() {
    for (var i = 0; i < 12; i++) saturationBins[i] = 0;
    voiceStates.bass   = { pc: null, source: 'ppm', time: 0, progress: 1.0 };
    voiceStates.rhythm    = { pc: null, source: 'ppm', time: 0, progress: 1.0 };
    voiceStates.soloist = { pc: null, source: 'ppm', time: 0, progress: 1.0 };
    voiceStates.lead   = { pc: null, source: 'ppm', time: 0, progress: 1.0 };
    voiceActivity.bass   = { noteTimestamps: [], recentPCs: [], density: 0, contour: 0 };
    voiceActivity.rhythm    = { noteTimestamps: [], recentPCs: [], density: 0, contour: 0 };
    voiceActivity.soloist = { noteTimestamps: [], recentPCs: [], density: 0, contour: 0 };
    voiceActivity.lead   = { noteTimestamps: [], recentPCs: [], density: 0, contour: 0 };
    voiceActivity.human  = { noteTimestamps: [], recentPCs: [], density: 0, contour: 0 };
    ensembleSnapshot = {
      totalDensity: 0, activeVoiceCount: 0, registerSpread: 0,
      relationalEntropy: 0, intervalTension: 0, phaseAlignment: 0
    };
    // Bass-percussion coupling state
    _bassNotePhases = [];
    _kickTimestamps = [];
    // v2.1 observation channel state
    _harmonicWindows = [];
    _lastHarmonicSnapTime = 0;
    _noveltyWindows = [];
    _velocityHistory = [];
    _noveltyAccumMs = 0;
    // v2.2 per-voice observation state
    var _pvVoices = ['bass', 'rhythm', 'soloist', 'percussion', 'lead', 'human'];
    for (var pvi = 0; pvi < _pvVoices.length; pvi++) {
      _velocityHistoryPerVoice[_pvVoices[pvi]] = [];
      _noveltyWindowsPerVoice[_pvVoices[pvi]] = [];
    }
  }

  // ══════════════════════════════════════
  // OBSERVATION CHANNEL METHODS (v2.1)
  // ══════════════════════════════════════

  // _updateHarmonicWindows() — snapshot current PC-set at beat-rate intervals
  function _updateHarmonicWindows(now) {
    // Only snapshot every _HARMONIC_SNAP_INTERVAL ms to avoid flooding
    if (now - _lastHarmonicSnapTime < _HARMONIC_SNAP_INTERVAL) return;
    _lastHarmonicSnapTime = now;

    var voices = ['bass', 'rhythm', 'soloist', 'lead'];
    var currentPCSet = {};
    var recentCutoff = now - 500; // half-beat window at 120bpm
    for (var i = 0; i < voices.length; i++) {
      var vs = voiceStates[voices[i]];
      if (vs.pc !== null && vs.time > recentCutoff) {
        currentPCSet[vs.pc] = true;
      }
    }
    _harmonicWindows.push({ pcSet: currentPCSet, time: now });
    // Keep last ~8 seconds (32 snapshots at 250ms interval)
    while (_harmonicWindows.length > 32) {
      _harmonicWindows.shift();
    }
  }

  // getHarmonicRhythm() — rate of PC-set changes per beat
  // 0 = pedal point (no changes), 1 = rapid harmonic movement
  function getHarmonicRhythm() {
    if (_harmonicWindows.length < 2) return 0.5; // neutral during warmup (matches other channels)
    var shifts = 0;
    for (var i = 1; i < _harmonicWindows.length; i++) {
      var prev = _harmonicWindows[i - 1].pcSet;
      var curr = _harmonicWindows[i].pcSet;
      // Count new PCs not in previous window
      var newPCs = 0;
      for (var pc in curr) {
        if (!prev[pc]) newPCs++;
      }
      if (newPCs >= _HARMONIC_SHIFT_THRESHOLD) shifts++;
    }
    // Normalize: shifts per window, capped at 1
    return Math.min(1, shifts / Math.max(1, _harmonicWindows.length - 1));
  }

  // _updateNoveltyWindows() — snapshot PC-set periodically for repetition comparison
  function _updateNoveltyWindows(now) {
    // Build current PC-set from all active voices (global)
    var vnames = ['bass', 'rhythm', 'soloist', 'percussion', 'lead'];
    var pcSet = {};
    var recentCutoff = now - 1000; // 1-second window
    for (var i = 0; i < vnames.length; i++) {
      var act = voiceActivity[vnames[i]];
      for (var j = 0; j < act.recentPCs.length; j++) {
        pcSet[act.recentPCs[j]] = true;
      }
    }
    _noveltyWindows.push({ pcSet: pcSet, time: now });
    if (_noveltyWindows.length > _NOVELTY_COMPARE_DEPTH + 1) {
      _noveltyWindows.shift();
    }
    // v2.2: per-voice novelty windows (includes human for groove invitation detection)
    var pvNames = ['bass', 'rhythm', 'soloist', 'percussion', 'lead', 'human'];
    for (var vi = 0; vi < pvNames.length; vi++) {
      var v = pvNames[vi];
      var vPcSet = {};
      var vAct = voiceActivity[v];
      for (var pi = 0; pi < vAct.recentPCs.length; pi++) {
        vPcSet[vAct.recentPCs[pi]] = true;
      }
      var pvn = _noveltyWindowsPerVoice[v];
      pvn.push({ pcSet: vPcSet, time: now });
      if (pvn.length > _NOVELTY_COMPARE_DEPTH + 1) pvn.shift();
    }
  }

  // getRepetitionNovelty() — how different is current material from recent past
  // 0 = exact repetition, 1 = completely novel
  function getRepetitionNovelty() {
    if (_noveltyWindows.length < 2) return 0.5; // uncertain during warmup
    var current = _noveltyWindows[_noveltyWindows.length - 1].pcSet;
    var totalDist = 0;
    var comparisons = 0;
    // Compare against all previous windows
    for (var i = 0; i < _noveltyWindows.length - 1; i++) {
      var prev = _noveltyWindows[i].pcSet;
      totalDist += _jaccard(current, prev);
      comparisons++;
    }
    return comparisons > 0 ? totalDist / comparisons : 0.5;
  }

  // _jaccard() — Jaccard distance between two PC-set objects
  function _jaccard(setA, setB) {
    var union = 0;
    var intersection = 0;
    var all = {};
    for (var k in setA) all[k] = true;
    for (var k2 in setB) all[k2] = true;
    for (var k3 in all) {
      union++;
      if (setA[k3] && setB[k3]) intersection++;
    }
    if (union === 0) return 0;
    return 1 - (intersection / union);
  }

  // getOnsetRegularity() — how tightly onsets align to a regular grid
  // 1 = metronomic, 0 = random timing
  function getOnsetRegularity() {
    // Collect all recent onset timestamps across voices
    var allOnsets = [];
    var voices = ['bass', 'rhythm', 'soloist', 'percussion', 'lead'];
    for (var i = 0; i < voices.length; i++) {
      var ts = voiceActivity[voices[i]].noteTimestamps;
      for (var j = 0; j < ts.length; j++) {
        allOnsets.push(ts[j]);
      }
    }
    if (allOnsets.length < 4) return 0.5; // uncertain during warmup

    allOnsets.sort(function(a, b) { return a - b; });

    // Compute IOIs
    var iois = [];
    for (var k = 1; k < allOnsets.length; k++) {
      var ioi = allOnsets[k] - allOnsets[k - 1];
      if (ioi > 10 && ioi < 2000) iois.push(ioi); // filter outliers
    }
    if (iois.length < 3) return 0.5;

    // Find dominant IOI (median as robust estimate)
    iois.sort(function(a, b) { return a - b; });
    var medianIOI = iois[Math.floor(iois.length / 2)];

    // Compute deviation from grid: for each onset, how far from nearest grid position?
    var totalDeviation = 0;
    for (var m = 0; m < iois.length; m++) {
      // Deviation = distance to nearest multiple of medianIOI, normalized
      var remainder = iois[m] % medianIOI;
      var dev = Math.min(remainder, medianIOI - remainder) / medianIOI;
      totalDeviation += dev;
    }
    var meanDeviation = totalDeviation / iois.length;
    // Map: 0 deviation = regularity 1.0, 0.5 deviation = regularity 0.0
    return Math.max(0, Math.min(1, 1 - meanDeviation * 2));
  }

  // getDynamicArc() — velocity trend direction
  // 0 = strong decrescendo, 0.5 = flat, 1 = strong crescendo
  function getDynamicArc() {
    if (_velocityHistory.length < 4) return 0.5; // flat during warmup
    // Simple linear regression: velocity vs time
    var n = _velocityHistory.length;
    var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    var t0 = _velocityHistory[0].time;
    for (var i = 0; i < n; i++) {
      var x = (_velocityHistory[i].time - t0) / 1000; // seconds
      var y = _velocityHistory[i].vel / 127; // normalize to 0-1
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }
    var denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 0.001) return 0.5;
    var slope = (n * sumXY - sumX * sumY) / denom;
    // Map slope to 0-1: slope of ±0.1/sec is "strong" crescendo/decrescendo
    return Math.max(0, Math.min(1, 0.5 + slope * 5));
  }

  // ══════════════════════════════════════
  // PER-VOICE OBSERVATION QUERIES (v2.2)
  // ══════════════════════════════════════

  // getOnsetRegularityPerVoice(voice) — how regular is THIS voice's timing
  function getOnsetRegularityPerVoice(voice) {
    var act = voiceActivity[voice];
    if (!act) return 0.5;
    var ts = act.noteTimestamps;
    if (ts.length < 4) return 0.5;
    // Compute IOIs from this voice's timestamps only
    var iois = [];
    for (var k = 1; k < ts.length; k++) {
      var ioi = ts[k] - ts[k - 1];
      if (ioi > 10 && ioi < 2000) iois.push(ioi);
    }
    if (iois.length < 3) return 0.5;
    iois.sort(function(a, b) { return a - b; });
    var medianIOI = iois[Math.floor(iois.length / 2)];
    var totalDeviation = 0;
    for (var m = 0; m < iois.length; m++) {
      var remainder = iois[m] % medianIOI;
      var dev = Math.min(remainder, medianIOI - remainder) / medianIOI;
      totalDeviation += dev;
    }
    var meanDeviation = totalDeviation / iois.length;
    return Math.max(0, Math.min(1, 1 - meanDeviation * 2));
  }

  // getRepetitionNoveltyPerVoice(voice) — how novel is THIS voice's material
  function getRepetitionNoveltyPerVoice(voice) {
    var pvn = _noveltyWindowsPerVoice[voice];
    if (!pvn || pvn.length < 2) return 0.5;
    var current = pvn[pvn.length - 1].pcSet;
    var totalDist = 0;
    var comparisons = 0;
    for (var i = 0; i < pvn.length - 1; i++) {
      totalDist += _jaccard(current, pvn[i].pcSet);
      comparisons++;
    }
    return comparisons > 0 ? totalDist / comparisons : 0.5;
  }

  // getDynamicArcPerVoice(voice) — THIS voice's velocity trend
  function getDynamicArcPerVoice(voice) {
    var pvh = _velocityHistoryPerVoice[voice];
    if (!pvh || pvh.length < 4) return 0.5;
    var n = pvh.length;
    var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    var t0 = pvh[0].time;
    for (var i = 0; i < n; i++) {
      var x = (pvh[i].time - t0) / 1000;
      var y = pvh[i].vel / 127;
      sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
    }
    var denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 0.001) return 0.5;
    var slope = (n * sumXY - sumX * sumY) / denom;
    return Math.max(0, Math.min(1, 0.5 + slope * 5));
  }

  // getVoiceVelocityAvg(voice) — time-windowed average velocity for a voice
  // Returns 0-1 (normalized from 0-127 range) or 0.5 if no data
  function getVoiceVelocityAvg(voice) {
    var pvh = _velocityHistoryPerVoice[voice];
    if (!pvh || pvh.length === 0) return 0.5;
    var now = Date.now();
    var cutoff = now - _VELOCITY_TIME_WINDOW_MS;
    var sum = 0;
    var count = 0;
    for (var i = 0; i < pvh.length; i++) {
      if (pvh[i].time >= cutoff) {
        sum += pvh[i].vel;
        count++;
      }
    }
    if (count === 0) return 0.5;
    // Normalize: velocity is 0-1 (already normalized in percussion, 0-127 for melodic)
    var avg = sum / count;
    return avg > 1 ? avg / 127 : avg; // handle both 0-1 and 0-127 scales
  }

  // getDensityVariance() — variance of per-voice note densities
  // High variance = one voice dominating; low = balanced texture
  function getDensityVariance() {
    var densities = [voiceActivity.bass.density, voiceActivity.rhythm.density, voiceActivity.soloist.density, voiceActivity.lead.density];
    if (voiceActivity.percussion) densities.push(voiceActivity.percussion.density);
    return _variance(densities);
  }

  // ══════════════════════════════════════
  // PERCUSSION TRACKING (Cross-Voice Reactions)
  // ══════════════════════════════════════

  // Per-drum-type timestamps for granular density tracking
  var _drumTimestamps = { kick: [], snare: [], hat: [] };
  // Rolling kick pattern: bar-phase positions from last 2 bars
  var _kickPattern = [];
  var _kickTimestamps = [];    // parallel timestamps for recency filtering
  var _KICK_PATTERN_MAX = 16;  // max kick positions to remember
  // Last pattern name (for change detection)
  var _lastPercPattern = '';

  // Bass note bar-phase tracking (enables bidirectional bass-percussion coupling)
  // Clayton 2012: entrainment is bidirectional between rhythmic layers
  var _bassNotePhases = [];    // [{phase, time}, ...]
  var _BASS_PHASE_MAX = 16;

  // onPercussionHit() — called by PercussionAssistant when a drum fires.
  // Tracks per-drum density + kick bar-phase positions for bass-kick lock.
  function onPercussionHit(drumName, barPhase, vel) {
    var now = Date.now();
    if (vel === undefined) vel = 0.7; // default if not provided

    var va = voiceActivity.percussion;
    va.noteTimestamps.push(now);
    // Prune old timestamps
    var cutoff = now - DENSITY_WINDOW_MS;
    while (va.noteTimestamps.length > 0 && va.noteTimestamps[0] < cutoff) {
      va.noteTimestamps.shift();
    }
    va.density = va.noteTimestamps.length / (DENSITY_WINDOW_MS / 1000);

    // Velocity tracking for percussion (per-voice)
    var pvh = _velocityHistoryPerVoice.percussion;
    pvh.push({ vel: vel, time: now });
    // Prune entries older than time window
    var velCutoff = now - _VELOCITY_TIME_WINDOW_MS;
    while (pvh.length > 0 && pvh[0].time < velCutoff) {
      pvh.shift();
    }

    // Also feed into global velocity history
    _velocityHistory.push({ vel: vel, time: now });
    var globalCutoff = now - _VELOCITY_TIME_WINDOW_MS;
    while (_velocityHistory.length > 0 && _velocityHistory[0].time < globalCutoff) {
      _velocityHistory.shift();
    }

    // Per-drum tracking
    if (_drumTimestamps[drumName]) {
      _drumTimestamps[drumName].push(now);
      while (_drumTimestamps[drumName].length > 0 && _drumTimestamps[drumName][0] < cutoff) {
        _drumTimestamps[drumName].shift();
      }
    }

    // Kick pattern: record bar-phase positions for bass-kick alignment
    if (drumName === 'kick' && barPhase !== undefined) {
      _kickPattern.push(barPhase);
      _kickTimestamps.push(now);
      if (_kickPattern.length > _KICK_PATTERN_MAX) {
        _kickPattern.shift();
        _kickTimestamps.shift();
      }
    }
  }

  // getKickPattern() — rolling array of kick bar-phase positions (0-1)
  // Bass uses this to align its note timing toward kick positions.
  function getKickPattern() {
    return _kickPattern;
  }

  // getRecentKickPhases(maxAgeMs) — kick phases from within the recency window.
  // Filters out stale kicks from many bars ago. Default window: 2 bar periods.
  function getRecentKickPhases(maxAgeMs) {
    var now = Date.now();
    if (!maxAgeMs) {
      var barMs = (typeof BarTracker !== 'undefined') ? BarTracker.getBarPeriod() : 2000;
      maxAgeMs = barMs * 2;
    }
    var cutoff = now - maxAgeMs;
    var result = [];
    for (var i = 0; i < _kickPattern.length; i++) {
      if (i < _kickTimestamps.length && _kickTimestamps[i] >= cutoff) {
        result.push(_kickPattern[i]);
      }
    }
    return result;
  }

  // getNextKickPhase(currentPhase) — finds the nearest upcoming kick (forward in bar phase).
  // Returns {phase, distance} or null if no recent kicks.
  // Used by bass for positive kick synchronization (Clayton 2012).
  function getNextKickPhase(currentPhase) {
    if (_kickPattern.length === 0) return null;
    var now = Date.now();
    var barMs = (typeof BarTracker !== 'undefined') ? BarTracker.getBarPeriod() : 2000;
    var cutoff = now - barMs * 2;

    var minForward = 1.0;
    var bestPhase = null;
    for (var i = 0; i < _kickPattern.length; i++) {
      if (i < _kickTimestamps.length && _kickTimestamps[i] < cutoff) continue;
      var forward = _kickPattern[i] - currentPhase;
      if (forward < 0) forward += 1.0;
      if (forward < 0.01) forward = 0; // essentially on a kick
      if (forward < minForward) {
        minForward = forward;
        bestPhase = _kickPattern[i];
      }
    }
    return bestPhase !== null ? { phase: bestPhase, distance: minForward } : null;
  }

  // getBassNotePhases() — rolling array of bass note bar-phase positions with timestamps.
  // Used by percussion for bidirectional coupling (Enhancement 5).
  function getBassNotePhases() {
    return _bassNotePhases;
  }

  // getDrumDensity(drumName) — per-drum-type notes/sec
  function getDrumDensity(drumName) {
    var ts = _drumTimestamps[drumName];
    if (!ts) return 0;
    return ts.length / (DENSITY_WINDOW_MS / 1000);
  }

  // getPercussionDensity() — total percussion notes/sec
  function getPercussionDensity() {
    return voiceActivity.percussion ? voiceActivity.percussion.density : 0;
  }

  // onPercPatternChange(from, to) — called when percussion pattern changes
  function onPercPatternChange(from, to) {
    _lastPercPattern = to;
  }

  // getPercussionPattern() — current percussion pattern name
  function getPercussionPattern() {
    return _lastPercPattern;
  }

  // onNote() — feed a single voice note into the tracker (for voices outside the update() signature)
  function onNote(voice, pc, source, progress, vel) {
    if (pc === null || pc === undefined) return;
    _updateVoice(voice, pc, source, progress, Date.now(), vel);
  }

  return {
    update:                update,
    onNote:                onNote,
    getSaturationBiases:   getSaturationBiases,
    getSaturatedPCs:       getSaturatedPCs,
    getVoiceState:         getVoiceState,
    isRhythmStable:        isRhythmStable,
    isBassStable:          isBassStable,
    getPhraseProgress:     getPhraseProgress,
    isResolving:           isResolving,
    anyPeerReplanReady:    anyPeerReplanReady,
    shouldStagger:         shouldStagger,
    // Cross-Voice Awareness API
    getVoiceDensity:       getVoiceDensity,
    getVoiceContour:       getVoiceContour,
    getPairwiseInterval:   getPairwiseInterval,
    getPairwiseTension:    getPairwiseTension,
    getEnsembleSnapshot:   getEnsembleSnapshot,
    getRelationalEntropy:  getRelationalEntropy,
    isDensityBudgetExceeded: isDensityBudgetExceeded,
    getContrastOpportunity:    getContrastOpportunity,
    getPeerRecentPCs:          getPeerRecentPCs,
    getDensityVariance:        getDensityVariance,
    getPeerGrooveInvitation:   getPeerGrooveInvitation,
    // v2.1 observation channels
    getHarmonicRhythm:       getHarmonicRhythm,
    getRepetitionNovelty:    getRepetitionNovelty,
    getOnsetRegularity:      getOnsetRegularity,
    getDynamicArc:           getDynamicArc,
    // v2.2 per-voice observation queries
    getOnsetRegularityPerVoice:    getOnsetRegularityPerVoice,
    getRepetitionNoveltyPerVoice:  getRepetitionNoveltyPerVoice,
    getDynamicArcPerVoice:         getDynamicArcPerVoice,
    getVoiceVelocityAvg:           getVoiceVelocityAvg,
    onPercussionHit:         onPercussionHit,
    getKickPattern:          getKickPattern,
    getRecentKickPhases:     getRecentKickPhases,
    getNextKickPhase:        getNextKickPhase,
    getBassNotePhases:       getBassNotePhases,
    getDrumDensity:          getDrumDensity,
    getPercussionDensity:    getPercussionDensity,
    onPercPatternChange:     onPercPatternChange,
    getPercussionPattern:    getPercussionPattern,
    reset:                   reset
  };

})();


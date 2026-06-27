'use strict';
// ═══ LONG-TERM MEMORY (v5 Phase 6 — Session-to-Session Learning) ═══
//
// Persists session summaries and computes warm-start priors per genre.
// On Auto stop: extracts session profile from ResearchState snapshots,
//   saves to userData/ltm/{genre}.json via Electron IPC.
// On Auto start: loads prior sessions, computes warm-start overrides
//   for BeliefState, NarrativeArc, and PeerModel.
//
// Non-Electron fallback: if window.gen3.ltm is unavailable (preview server),
// all operations silently no-op and the system uses cold-start defaults.
//
// Depends on: ResearchState (read snapshots), BeliefState (warm-start),
//   NarrativeArc (warm-start), PeerModel (warm-start)
// Load order: after research-state.js, before ui-wiring.js

var LTM = (function() {

  var MAX_SESSIONS = 20;       // max sessions per genre file
  var RECENCY_DECAY = 0.85;    // exponential decay for averaging
  var MIN_SESSION_DURATION_S = 30; // don't save sessions shorter than 30s
  var WARM_START_SESSIONS = 5; // use last N sessions for priors

  var _warmStartLoaded = false;
  var _currentPriors = null;

  // ── Check Electron IPC availability ──
  function _hasIPC() {
    return typeof window !== 'undefined' && window.gen3 && window.gen3.ltm;
  }

  // ═══ SESSION SUMMARY EXTRACTION ═══

  // Extract session summary from ResearchState snapshots
  function _extractSessionSummary() {
    if (typeof ResearchState === 'undefined') return null;

    var notes = ResearchState.getNotes();
    if (!notes || notes.length < 10) return null;

    var duration = notes[notes.length - 1].time - notes[0].time;
    if (duration < MIN_SESSION_DURATION_S * 1000) return null;

    // ── Human profile ──
    var humanNotes = notes.filter(function(n) { return n.voice === 'human'; });
    var humanDensity = humanNotes.length / (duration / 1000);
    var humanPCs = {};
    var humanMidiMin = 127, humanMidiMax = 0;
    for (var i = 0; i < humanNotes.length; i++) {
      var pc = humanNotes[i].pc;
      if (pc !== undefined) humanPCs[pc] = (humanPCs[pc] || 0) + 1;
      var midi = humanNotes[i].midi;
      if (midi !== undefined) {
        if (midi < humanMidiMin) humanMidiMin = midi;
        if (midi > humanMidiMax) humanMidiMax = midi;
      }
    }

    // Mode bias: count notes in major vs minor scale intervals
    var majorIntervals = [0, 2, 4, 5, 7, 9, 11]; // major scale PCs relative to root
    var majorCount = 0, totalPCCount = 0;
    for (var pc in humanPCs) {
      totalPCCount += humanPCs[pc];
      if (majorIntervals.indexOf(parseInt(pc) % 12) >= 0) majorCount += humanPCs[pc];
    }
    var modeBias = totalPCCount > 0 ? majorCount / totalPCCount : 0.5;

    var humanProfile = {
      density: +humanDensity.toFixed(3),
      registerMin: humanMidiMin < 127 ? humanMidiMin : 60,
      registerMax: humanMidiMax > 0 ? humanMidiMax : 72,
      modeBias: +modeBias.toFixed(3),
      noteCount: humanNotes.length
    };

    // ── Ensemble metrics ──
    var voiceDensity = {};
    var voiceCounts = { bass: 0, rhythm: 0, soloist: 0, lead: 0, percussion: 0 };
    for (var i = 0; i < notes.length; i++) {
      var v = notes[i].voice;
      if (voiceCounts[v] !== undefined) voiceCounts[v]++;
    }
    var durationSec = duration / 1000;
    for (var v in voiceCounts) {
      voiceDensity[v] = +(voiceCounts[v] / durationSec).toFixed(3);
    }

    // Section distribution from snapshots
    var sectionCounts = { STABLE: 0, BUILD: 0, PEAK: 0, RELEASE: 0, TRANSITION: 0 };
    var totalSections = 0;

    // Sample notes at regular intervals for section state
    var sampleInterval = Math.max(1, Math.floor(notes.length / 50));
    for (var i = 0; i < notes.length; i += sampleInterval) {
      var snap = notes[i].snapshot || notes[i];
      var sec = snap.section || (snap.sectionState && snap.sectionState.state);
      if (sec && sectionCounts[sec] !== undefined) {
        sectionCounts[sec]++;
        totalSections++;
      }
    }
    var sectionDist = {};
    for (var s in sectionCounts) {
      sectionDist[s] = totalSections > 0 ? +(sectionCounts[s] / totalSections).toFixed(3) : 0.2;
    }

    var ensembleMetrics = {
      voiceDensity: voiceDensity,
      sectionDistribution: sectionDist,
      totalNotes: notes.length,
      durationSec: Math.round(durationSec),
      nps: +(notes.length / durationSec).toFixed(2)
    };

    // ── Arc stats ──
    var arcStats = {};
    if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getArc) {
      var arcVoices = ['bass', 'rhythm', 'soloist', 'lead'];
      for (var i = 0; i < arcVoices.length; i++) {
        var arc = NarrativeArc.getArc(arcVoices[i]);
        if (arc && arc.template) {
          arcStats[arcVoices[i]] = {
            lastTemplate: arc.template,
            barsElapsed: arc.barsElapsed || 0,
            barsTotal: arc.barsTotal || 16
          };
        }
      }
    }

    return {
      timestamp: Date.now(),
      duration: Math.round(durationSec),
      humanProfile: humanProfile,
      ensembleMetrics: ensembleMetrics,
      arcStats: arcStats
    };
  }

  // ═══ WARM-START PRIOR COMPUTATION ═══

  // Compute warm-start priors from session history
  function _computeWarmStart(sessions) {
    if (!sessions || sessions.length === 0) return null;

    // Use last N sessions, recency-weighted
    var recent = sessions.slice(-WARM_START_SESSIONS);
    var totalWeight = 0;
    var weights = [];
    for (var i = 0; i < recent.length; i++) {
      var w = Math.pow(RECENCY_DECAY, recent.length - 1 - i);
      weights.push(w);
      totalWeight += w;
    }

    // ── Belief priors ──
    // Compute average section distribution → map to initial beliefs.
    // High BUILD time → more energy prior. High STABLE → more stability.
    var avgSection = { STABLE: 0, BUILD: 0, PEAK: 0, RELEASE: 0, TRANSITION: 0 };
    for (var i = 0; i < recent.length; i++) {
      var sd = recent[i].ensembleMetrics && recent[i].ensembleMetrics.sectionDistribution;
      if (sd) {
        for (var s in avgSection) {
          avgSection[s] += (sd[s] || 0) * weights[i];
        }
      }
    }
    for (var s in avgSection) avgSection[s] /= totalWeight;

    // Map section tendencies to belief adjustments (small — max ±0.10)
    // STABLE → boost stability, BUILD → boost energy, PEAK → boost surprise
    var beliefAdjust = {
      stability:  Math.min(0.10, avgSection.STABLE * 0.3),
      energy:     Math.min(0.10, avgSection.BUILD * 0.25),
      surprise:   Math.min(0.10, avgSection.PEAK * 0.2),
      space:      Math.min(0.10, avgSection.RELEASE * 0.15),
      resolution: Math.min(0.10, avgSection.TRANSITION * 0.15)
    };

    // ── Human profile average ──
    var avgHuman = { density: 0, registerMin: 0, registerMax: 0, modeBias: 0 };
    var humanCount = 0;
    for (var i = 0; i < recent.length; i++) {
      var hp = recent[i].humanProfile;
      if (hp && hp.noteCount > 0) {
        avgHuman.density += hp.density * weights[i];
        avgHuman.registerMin += hp.registerMin * weights[i];
        avgHuman.registerMax += hp.registerMax * weights[i];
        avgHuman.modeBias += hp.modeBias * weights[i];
        humanCount += weights[i];
      }
    }
    if (humanCount > 0) {
      avgHuman.density /= humanCount;
      avgHuman.registerMin = Math.round(avgHuman.registerMin / humanCount);
      avgHuman.registerMax = Math.round(avgHuman.registerMax / humanCount);
      avgHuman.modeBias /= humanCount;
    }

    // ── NPS average for genre physics ──
    var avgNPS = 0;
    for (var i = 0; i < recent.length; i++) {
      var em = recent[i].ensembleMetrics;
      if (em && em.nps) avgNPS += em.nps * weights[i];
    }
    avgNPS /= totalWeight;

    return {
      beliefAdjust: beliefAdjust,
      humanProfile: avgHuman,
      genrePhysics: {
        avgNPS: +avgNPS.toFixed(2),
        sessionCount: sessions.length
      }
    };
  }

  // ═══ WARM-START APPLICATION ═══

  function _applyWarmStart(priors) {
    if (!priors) return;

    // Apply belief adjustments
    if (priors.beliefAdjust && typeof BeliefState !== 'undefined' && BeliefState.applyWarmStart) {
      BeliefState.applyWarmStart(priors.beliefAdjust);
    }

    // Pre-seed PeerModel human predictions
    if (priors.humanProfile && typeof PeerModel !== 'undefined' && PeerModel.applyWarmStart) {
      PeerModel.applyWarmStart(priors.humanProfile);
    }

    _warmStartLoaded = true;
    _currentPriors = priors;
    console.log('LTM warm-start applied:', JSON.stringify(priors.genrePhysics || {}));
  }

  // ═══ PUBLIC API ═══

  // Save current session data to persistent storage
  function saveSession(genre) {
    if (!_hasIPC()) return;

    var summary = _extractSessionSummary();
    if (!summary) {
      console.log('LTM: session too short or no data — not saving');
      return;
    }

    // Load existing data, append, prune, recompute warm-start, save
    window.gen3.ltm.load(genre).then(function(existing) {
      var data = existing || { genre: genre, sessions: [] };
      data.sessions.push(summary);

      // Prune to MAX_SESSIONS
      if (data.sessions.length > MAX_SESSIONS) {
        data.sessions = data.sessions.slice(-MAX_SESSIONS);
      }

      // Recompute warm-start priors
      data.warmStart = _computeWarmStart(data.sessions);

      return window.gen3.ltm.save(genre, data);
    }).then(function(ok) {
      if (ok) console.log('LTM: session saved for genre "' + genre + '"');
    }).catch(function(err) {
      console.log('LTM save error:', err.message || err);
    });
  }

  // Load warm-start priors for a genre
  function loadWarmStart(genre) {
    if (!_hasIPC()) return;

    window.gen3.ltm.load(genre).then(function(data) {
      if (data && data.warmStart) {
        _applyWarmStart(data.warmStart);
      } else {
        console.log('LTM: no warm-start data for "' + genre + '" — cold start');
        _warmStartLoaded = false;
        _currentPriors = null;
      }
    }).catch(function(err) {
      console.log('LTM load error:', err.message || err);
      _warmStartLoaded = false;
    });
  }

  function getSessionHistory(genre) {
    if (!_hasIPC()) return Promise.resolve([]);
    return window.gen3.ltm.load(genre).then(function(data) {
      return data && data.sessions ? data.sessions : [];
    });
  }

  function isWarmStartAvailable() {
    return _warmStartLoaded;
  }

  function getDiagnostics() {
    return {
      warmStartLoaded: _warmStartLoaded,
      priors: _currentPriors
    };
  }

  return {
    saveSession: saveSession,
    loadWarmStart: loadWarmStart,
    getSessionHistory: getSessionHistory,
    isWarmStartAvailable: isWarmStartAvailable,
    getDiagnostics: getDiagnostics
  };

})();

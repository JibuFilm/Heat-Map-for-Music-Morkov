'use strict';
// ═══ RESEARCH STATE — Session Data Collector for Post-Run Analysis ═══
//
// Records every generated note alongside the full system state snapshot:
//   belief distribution, behavior mode, section state, key context,
//   octave placement, phase coupling, energy, surprise, etc.
//
// Data stays in memory during a session. Export to JSON via console:
//   ResearchState.exportJSON()        → downloads a .json file
//   ResearchState.getSummary()        → quick stats overview
//   ResearchState.getNotes()          → raw note array
//   ResearchState.getVoiceProfile(v)  → per-voice breakdown
//
// Hooks into EventBus 'noteProduced' event (emitted from playVoiceNote).
// No dependencies on generation pipeline — read-only observer.
//
// Load order: after app.js (needs all modules defined)

var ResearchState = (function() {

  // ═══════════════════════════════════════
  // STORAGE
  // ═══════════════════════════════════════

  var _notes = [];          // all note events
  var _snapshots = [];      // periodic system-wide snapshots (every ~2s)
  var _sessionStart = 0;
  var _recording = false;
  var _lastSnapshotTime = 0;
  var SNAPSHOT_INTERVAL_MS = 2000;

  // ═══════════════════════════════════════
  // NOTE CAPTURE
  // ═══════════════════════════════════════

  // Called for every generated note via EventBus 'noteProduced'
  function _onNoteProduced(data) {
    if (!_recording) return;

    var now = Date.now();
    var voice = data.voiceName || data.voice;

    // Build full state snapshot for this note
    var entry = {
      t: now - _sessionStart,       // ms since session start
      ts: now,                       // absolute timestamp
      voice: voice,
      pc: data.pc,                   // pitch class 0-11
      midi: data.midi,               // absolute MIDI after octave placement
      volMult: data.volMult || 1.0,

      // ── Belief state ──
      belief: _safeCall(function() {
        if (typeof BeliefState === 'undefined') return null;
        var b = BeliefState.getBelief(voice);
        if (!b) return null;
        return {
          needs_stability: _r(b.needs_stability),
          needs_energy: _r(b.needs_energy),
          needs_space: _r(b.needs_space),
          needs_surprise: _r(b.needs_surprise),
          needs_resolution: _r(b.needs_resolution),
          entropy: _r(b._entropy),
          energy: _r(b._energy)
        };
      }),

      // ── Belief params (derived) ──
      beliefParams: _safeCall(function() {
        if (typeof BeliefState === 'undefined') return null;
        var p = BeliefState.getParams(voice);
        if (!p) return null;
        return {
          dominantIntent: p.dominantIntent,
          entropyNorm: _r(p.entropyNorm),
          temperature: _r(p.temperature),
          density: _r(p.density),
          lengthMult: _r(p.lengthMult),
          // v2.2: tempo bias
          bpmBias: _r(p.bpmBias),
          // v2.2: temporal urges
          maturity: _r(p.maturity),
          playUrge: _r(p.playUrge),
          modeUrge: _r(p.modeUrge),
          // v2.2: dialogue modifiers
          dialogueTempMod: _r(p.dialogueTempMod),
          dialogueDensityMod: _r(p.dialogueDensityMod),
          dialogueGateMod: _r(p.dialogueGateMod)
        };
      }),

      // ── Behavior mode ──
      behaviorMode: _safeCall(function() {
        if (typeof BehaviorModes === 'undefined') return null;
        return BehaviorModes.getCurrentMode(voice);
      }),

      // ── Section state ──
      section: _safeCall(function() {
        if (typeof SectionTracker === 'undefined') return null;
        var s = SectionTracker.getState();
        var result = {
          state: s.state,
          energy: _r(s.energy),
          adventurousness: _r(s.adventurousness),
          density: _r(s.density),
          resolutionUrgency: _r(s.resolutionUrgency)
        };
        // v4 Phase 4: per-voice section perceptions
        if (SectionTracker.getVoicePerceptions) {
          result.voicePerceptions = SectionTracker.getVoicePerceptions();
        }
        return result;
      }),

      // ── Key context ──
      key: _safeCall(function() {
        if (typeof SharedState === 'undefined') return null;
        var result = {
          keyC: SharedState.keyC,
          mode: SharedState.mode
        };
        if (typeof SharedState.getKeyDistribution === 'function') {
          var kd = SharedState.getKeyDistribution();
          if (kd) {
            result.confidence = _r(kd.confidence);
            result.entropy = _r(kd.entropy);
            result.topKey = kd.topKey;
            result.topMode = kd.topMode;
          }
        }
        return result;
      }),

      // ── Octave placement context ──
      octave: _safeCall(function() {
        if (typeof OctavePlacement === 'undefined') return null;
        return {
          lastMidi_bass: OctavePlacement.getLastMidi('bass'),
          lastMidi_rhythm: OctavePlacement.getLastMidi('rhythm'),
          lastMidi_soloist: OctavePlacement.getLastMidi('soloist')
        };
      }),

      // ── Surprise / temperature ──
      surprise: _safeCall(function() {
        if (typeof SharedState === 'undefined') return null;
        return {
          surpriseAvg: _r(typeof SharedState.getSurpriseAvg === 'function' ? SharedState.getSurpriseAvg() : null),
          tempAdjust: _r(typeof SharedState.getTemperatureAdjust === 'function' ? SharedState.getTemperatureAdjust() : null),
          humanAdventurousness: _r(typeof SharedState.getHumanAdventurousness === 'function' ? SharedState.getHumanAdventurousness() : null)
        };
      }),

      // ── Tempo ──
      tempo: _safeCall(function() {
        if (typeof TempoEngine === 'undefined') return null;
        var result = {
          bpm: _r(typeof TempoEngine.getEffectiveBPM === 'function' ? TempoEngine.getEffectiveBPM() : null),
          confidence: _r(typeof TempoEngine.getConfidence === 'function' ? TempoEngine.getConfidence() : null)
        };
        // v2.2: per-role BPM from PhaseCoupling tempo oscillators
        if (typeof PhaseCoupling !== 'undefined' && PhaseCoupling.getRoleBPM) {
          result.bassBPM = _r(PhaseCoupling.getRoleBPM('bass'));
          result.rhythmBPM = _r(PhaseCoupling.getRoleBPM('rhythm'));
          result.soloistBPM = _r(PhaseCoupling.getRoleBPM('soloist'));
          result.percBPM = _r(PhaseCoupling.getRoleBPM('percussion'));
          result.humanBPM = _r(PhaseCoupling.getRoleBPM('human'));
        }
        return result;
      }),

      // ── Observation vector (per-voice, v2.2) ──
      observations: _safeCall(function() {
        if (typeof BeliefState === 'undefined' || typeof BeliefState.getLastObservations !== 'function') return null;
        // Capture per-voice observations to show belief divergence
        var perVoice = {};
        var vnames = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
        for (var oi = 0; oi < vnames.length; oi++) {
          var obs = BeliefState.getLastObservations(vnames[oi]);
          if (obs) {
            perVoice[vnames[oi]] = {
              notesPerBeat: _r(obs.notesPerBeat),
              intervalTension: _r(obs.intervalTension),
              phraseProgress: _r(obs.phraseProgress),
              harmonicRhythm: _r(obs.harmonicRhythm),
              harmonicDrift: _r(obs.harmonicDrift),
              repetitionNovelty: _r(obs.repetitionNovelty),
              onsetRegularity: _r(obs.onsetRegularity),
              ensembleCoherence: _r(obs.ensembleCoherence),
              humanPresence: obs.humanPresence,
              activeVoiceCount: obs.activeVoiceCount,
              sectionState: obs.sectionState
            };
          }
        }
        return perVoice;
      })
    };

    _notes.push(entry);

    // Periodic full-system snapshot (not per-note — too expensive)
    if (now - _lastSnapshotTime > SNAPSHOT_INTERVAL_MS) {
      _takeSnapshot(now);
      _lastSnapshotTime = now;
    }
  }

  // ═══════════════════════════════════════
  // SYSTEM SNAPSHOTS (periodic)
  // ═══════════════════════════════════════

  function _takeSnapshot(now) {
    var snap = {
      t: now - _sessionStart,
      ts: now,
      noteCount: _notes.length,

      // All four voices' belief distributions
      beliefs: {},
      modes: {},
      energies: {}
    };

    var voiceNames = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
    for (var i = 0; i < voiceNames.length; i++) {
      var v = voiceNames[i];

      snap.beliefs[v] = _safeCall(function() {
        if (typeof BeliefState === 'undefined') return null;
        var b = BeliefState.getBelief(v);
        if (!b) return null;
        return {
          needs_stability: _r(b.needs_stability),
          needs_energy: _r(b.needs_energy),
          needs_space: _r(b.needs_space),
          needs_surprise: _r(b.needs_surprise),
          needs_resolution: _r(b.needs_resolution)
        };
      });

      snap.modes[v] = _safeCall(function() {
        if (typeof BehaviorModes === 'undefined') return null;
        return BehaviorModes.getCurrentModeName(v);
      });

      snap.energies[v] = _safeCall(function() {
        if (typeof BeliefState === 'undefined') return null;
        var b = BeliefState.getBelief(v);
        return b ? _r(b._energy) : null;
      });

      // v2.7.0: Belief velocity (rate of change per state)
      snap.beliefVelocity = snap.beliefVelocity || {};
      snap.beliefVelocity[v] = _safeCall(function() {
        if (typeof BeliefState === 'undefined' || !BeliefState.getBeliefVelocity) return null;
        return BeliefState.getBeliefVelocity(v);
      });
    }

    snap.section = _safeCall(function() {
      if (typeof SectionTracker === 'undefined') return null;
      return SectionTracker.getState().state;
    });

    // Percussion-specific snapshot data
    snap.percussion = _safeCall(function() {
      var result = {};
      if (typeof PercussionAssistant !== 'undefined') {
        result.pattern = PercussionAssistant.getCurrentPattern();
        result.noteCount = PercussionAssistant.getNoteCount();
        result.enabled = PercussionAssistant.isEnabled();
      }
      if (typeof ContextIntegrator !== 'undefined') {
        result.kickDensity = _r(ContextIntegrator.getDrumDensity('kick'));
        result.hatDensity = _r(ContextIntegrator.getDrumDensity('hat'));
        result.percDensity = _r(ContextIntegrator.getPercussionDensity());
      }
      return result;
    });

    // Phase coupling snapshot
    snap.phaseCoupling = _safeCall(function() {
      if (typeof PhaseCoupling === 'undefined') return null;
      var result = {};
      var vn = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
      for (var j = 0; j < vn.length; j++) {
        result[vn[j]] = _r(PhaseCoupling.getReadiness(vn[j]));
      }
      return result;
    });

    // v2.2: Dialogue stance snapshot (consensus)
    snap.dialogue = _safeCall(function() {
      if (typeof DialogueEngine === 'undefined') return null;
      var s = DialogueEngine.getStance();
      return {
        stance: s.stance,
        initiative: _r(s.initiative),
        agreement: _r(s.agreement),
        tempMod: _r(DialogueEngine.getTemperatureModifier()),
        densityMod: _r(DialogueEngine.getDensityModifier()),
        shouldDevelop: DialogueEngine.shouldDevelop()
      };
    });

    // v3.4: Per-voice dialogue stances
    snap.voiceStances = _safeCall(function() {
      if (typeof DialogueEngine === 'undefined' || !DialogueEngine.getVoiceStances) return null;
      return DialogueEngine.getVoiceStances();
    });

    // v2.5.3: Ensemble density snapshot for cross-voice analysis
    snap.ensembleDensity = _safeCall(function() {
      if (typeof ContextIntegrator === 'undefined') return null;
      var s = ContextIntegrator.getEnsembleSnapshot();
      return {
        total: _r(s.totalDensity), bass: _r(s.voiceDensities.bass),
        rhythm: _r(s.voiceDensities.rhythm), soloist: _r(s.voiceDensities.soloist),
        lead: _r(s.voiceDensities.lead), tension: _r(s.intervalTension),
        entropy: _r(s.relationalEntropy), phaseAlign: _r(s.phaseAlignment)
      };
    });

    // v2.2: Temporal urges snapshot (all voices)
    snap.temporalUrges = _safeCall(function() {
      if (typeof BeliefState === 'undefined' || !BeliefState.getTemporalUrges) return null;
      var result = {};
      var vn2 = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
      for (var k = 0; k < vn2.length; k++) {
        result[vn2[k]] = BeliefState.getTemporalUrges(vn2[k]);
      }
      return result;
    });

    // v2.2: Per-role tempo snapshot
    snap.tempoOscillators = _safeCall(function() {
      if (typeof PhaseCoupling === 'undefined' || !PhaseCoupling.getState) return null;
      var ps = PhaseCoupling.getState();
      return {
        consensusBPM: _r(ps.consensusBPM),
        bass: _r(ps.bass.bpm),
        rhythm: _r(ps.rhythm.bpm),
        soloist: _r(ps.soloist.bpm),
        percussion: _r(ps.percussion.bpm),
        human: _r(ps.human.bpm),
        humanConfidence: _r(ps.human.confidence)
      };
    });

    // v2.5.1: Peer velocity envelope snapshot
    snap.peerVelocity = _safeCall(function() {
      if (typeof PeerVelocity === 'undefined') return null;
      return PeerVelocity.getAll();
    });

    // v3 Phase 1: Per-voice key belief snapshot
    snap.keyBelief = _safeCall(function() {
      if (typeof KeyBelief === 'undefined') return null;
      return KeyBelief.getAll();
    });

    // v3 Phase 2: L2 melodic intent snapshot
    snap.melodicIntent = _safeCall(function() {
      if (typeof MelodicIntent === 'undefined') return null;
      return MelodicIntent.getAll();
    });

    // v3 Phase 3: Ensemble scoring diagnostics
    snap.ensembleScoring = _safeCall(function() {
      return {
        keyDivergence: (typeof KeyBelief !== 'undefined') ? KeyBelief.getDivergence() : 0,
        orderParameter: (typeof PhaseCoupling !== 'undefined') ? PhaseCoupling.getOrderParameter() : 0,
        contrastOpportunity: {
          bass: (typeof ContextIntegrator !== 'undefined') ? ContextIntegrator.getContrastOpportunity('bass') : 0,
          rhythm: (typeof ContextIntegrator !== 'undefined') ? ContextIntegrator.getContrastOpportunity('rhythm') : 0,
          soloist: (typeof ContextIntegrator !== 'undefined') ? ContextIntegrator.getContrastOpportunity('soloist') : 0,
          lead: (typeof ContextIntegrator !== 'undefined') ? ContextIntegrator.getContrastOpportunity('lead') : 0
        }
      };
    });

    // v3.5 Phase 6: Per-voice conviction snapshot
    snap.conviction = _safeCall(function() {
      if (typeof FinalCoordinator === 'undefined' || !FinalCoordinator.getConviction) return null;
      return {
        bass: _r(FinalCoordinator.getConviction('bass', null)),
        rhythm: _r(FinalCoordinator.getConviction('rhythm', null)),
        soloist: _r(FinalCoordinator.getConviction('soloist', null)),
        lead: _r(FinalCoordinator.getConviction('lead', null))
      };
    });

    // v3.7: Peer groove invitation snapshot
    snap.grooveInvitation = _safeCall(function() {
      if (typeof ContextIntegrator === 'undefined' || !ContextIntegrator.getPeerGrooveInvitation) return null;
      return {
        bass: _r(ContextIntegrator.getPeerGrooveInvitation('bass')),
        rhythm: _r(ContextIntegrator.getPeerGrooveInvitation('rhythm')),
        soloist: _r(ContextIntegrator.getPeerGrooveInvitation('soloist')),
        lead: _r(ContextIntegrator.getPeerGrooveInvitation('lead'))
      };
    });

    _snapshots.push(snap);
  }

  // ═══════════════════════════════════════
  // SESSION CONTROL
  // ═══════════════════════════════════════

  function start() {
    _notes = [];
    _snapshots = [];
    _sessionStart = Date.now();
    _lastSnapshotTime = _sessionStart;
    _recording = true;
    console.log('%c[ResearchState] Recording started', 'color:#0af;font-weight:bold');
  }

  function stop() {
    _recording = false;
    console.log('%c[ResearchState] Recording stopped — ' + _notes.length + ' notes captured', 'color:#0af;font-weight:bold');
  }

  function isRecording() {
    return _recording;
  }

  // ═══════════════════════════════════════
  // QUERY / ANALYSIS
  // ═══════════════════════════════════════

  function getNotes() {
    return _notes;
  }

  function getSnapshots() {
    return _snapshots;
  }

  function getSummary() {
    if (_notes.length === 0) return { noteCount: 0, message: 'No notes recorded. Call ResearchState.start() first.' };

    var voiceCounts = { bass: 0, rhythm: 0, soloist: 0, lead: 0, percussion: 0 };
    var modeUsage = { bass: {}, rhythm: {}, soloist: {}, lead: {}, percussion: {} };
    var beliefDominant = { bass: {}, rhythm: {}, soloist: {}, lead: {}, percussion: {} };
    var midiRange = { bass: [127, 0], rhythm: [127, 0], soloist: [127, 0], lead: [127, 0], percussion: [127, 0] };
    var pcHist = { bass: new Array(12).fill(0), rhythm: new Array(12).fill(0), soloist: new Array(12).fill(0), lead: new Array(12).fill(0), percussion: new Array(12).fill(0) };

    for (var i = 0; i < _notes.length; i++) {
      var n = _notes[i];
      var v = n.voice;
      voiceCounts[v] = (voiceCounts[v] || 0) + 1;

      // Mode usage
      if (n.behaviorMode) {
        var mn = typeof n.behaviorMode === 'string' ? n.behaviorMode : n.behaviorMode.name;
        if (mn) modeUsage[v][mn] = (modeUsage[v][mn] || 0) + 1;
      }

      // Dominant belief
      if (n.beliefParams && n.beliefParams.dominantIntent) {
        var di = n.beliefParams.dominantIntent;
        beliefDominant[v][di] = (beliefDominant[v][di] || 0) + 1;
      }

      // MIDI range
      if (n.midi !== undefined && n.midi !== null) {
        if (n.midi < midiRange[v][0]) midiRange[v][0] = n.midi;
        if (n.midi > midiRange[v][1]) midiRange[v][1] = n.midi;
      }

      // PC histogram
      if (n.pc !== undefined) {
        pcHist[v][n.pc]++;
      }
    }

    var durationSec = _notes.length > 0
      ? (_notes[_notes.length - 1].t - _notes[0].t) / 1000
      : 0;

    return {
      noteCount: _notes.length,
      durationSec: _r(durationSec),
      snapshotCount: _snapshots.length,
      voiceCounts: voiceCounts,
      notesPerSecond: {
        bass: durationSec > 0 ? _r(voiceCounts.bass / durationSec) : 0,
        rhythm: durationSec > 0 ? _r(voiceCounts.rhythm / durationSec) : 0,
        soloist: durationSec > 0 ? _r(voiceCounts.soloist / durationSec) : 0,
        lead: durationSec > 0 ? _r(voiceCounts.lead / durationSec) : 0,
        percussion: durationSec > 0 ? _r(voiceCounts.percussion / durationSec) : 0
      },
      midiRange: midiRange,
      modeUsage: modeUsage,
      beliefDominant: beliefDominant,
      pcHistogram: pcHist
    };
  }

  function getVoiceProfile(voice) {
    var voiceNotes = [];
    for (var i = 0; i < _notes.length; i++) {
      if (_notes[i].voice === voice) voiceNotes.push(_notes[i]);
    }

    if (voiceNotes.length === 0) return { voice: voice, noteCount: 0 };

    // Interval distribution (consecutive note distances)
    var intervals = [];
    for (var j = 1; j < voiceNotes.length; j++) {
      if (voiceNotes[j].midi !== undefined && voiceNotes[j - 1].midi !== undefined) {
        intervals.push(voiceNotes[j].midi - voiceNotes[j - 1].midi);
      }
    }

    // IOI distribution (time between notes)
    var iois = [];
    for (var k = 1; k < voiceNotes.length; k++) {
      iois.push(voiceNotes[k].t - voiceNotes[k - 1].t);
    }

    // Gravity usage: how often outside home range
    var outsideHome = 0;
    var ranges = (typeof OctavePlacement !== 'undefined') ? OctavePlacement.RANGES : null;
    var homeRange = ranges ? ranges[voice] : null;
    if (homeRange) {
      for (var m = 0; m < voiceNotes.length; m++) {
        var mid = voiceNotes[m].midi;
        if (mid !== undefined && (mid < homeRange.home[0] || mid > homeRange.home[1])) {
          outsideHome++;
        }
      }
    }

    // Temperature over time
    var temps = [];
    for (var p = 0; p < voiceNotes.length; p++) {
      if (voiceNotes[p].beliefParams && voiceNotes[p].beliefParams.temperature !== null) {
        temps.push({ t: voiceNotes[p].t, temp: voiceNotes[p].beliefParams.temperature });
      }
    }

    return {
      voice: voice,
      noteCount: voiceNotes.length,
      durationMs: voiceNotes[voiceNotes.length - 1].t - voiceNotes[0].t,
      intervals: {
        mean: _mean(intervals),
        absMax: _absMax(intervals),
        histogram: _histogramBins(intervals, -24, 24, 1)
      },
      iois: {
        meanMs: _r(_mean(iois)),
        minMs: Math.min.apply(null, iois.length > 0 ? iois : [0]),
        maxMs: Math.max.apply(null, iois.length > 0 ? iois : [0])
      },
      rangeUsage: {
        outsideHomePercent: voiceNotes.length > 0 ? _r(100 * outsideHome / voiceNotes.length) : 0,
        outsideHomeCount: outsideHome
      },
      temperatureTrace: temps
    };
  }

  // ═══════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════

  function exportJSON() {
    var data = {
      session: {
        start: _sessionStart,
        exported: Date.now(),
        noteCount: _notes.length,
        snapshotCount: _snapshots.length
      },
      summary: getSummary(),
      voiceProfiles: {
        bass: getVoiceProfile('bass'),
        rhythm: getVoiceProfile('rhythm'),
        soloist: getVoiceProfile('soloist'),
        lead: getVoiceProfile('lead'),
        percussion: getVoiceProfile('percussion')
      },
      notes: _notes,
      snapshots: _snapshots
    };

    var json = JSON.stringify(data, null, 2);

    // Try download in browser
    if (typeof document !== 'undefined') {
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'research-session-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      console.log('%c[ResearchState] Exported ' + _notes.length + ' notes to JSON', 'color:#0af;font-weight:bold');
    } else {
      // Node/Electron fallback
      console.log(json);
    }

    return data;
  }

  // ═══════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════

  function _r(v) {
    if (v === null || v === undefined) return null;
    return Math.round(v * 1000) / 1000;
  }

  function _safeCall(fn) {
    try { return fn(); } catch (e) { return null; }
  }

  function _mean(arr) {
    if (!arr || arr.length === 0) return 0;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return _r(sum / arr.length);
  }

  function _absMax(arr) {
    if (!arr || arr.length === 0) return 0;
    var max = 0;
    for (var i = 0; i < arr.length; i++) {
      var a = Math.abs(arr[i]);
      if (a > max) max = a;
    }
    return max;
  }

  function _histogramBins(arr, min, max, step) {
    var bins = {};
    for (var v = min; v <= max; v += step) bins[v] = 0;
    for (var i = 0; i < arr.length; i++) {
      var b = Math.round(arr[i] / step) * step;
      if (b < min) b = min;
      if (b > max) b = max;
      bins[b] = (bins[b] || 0) + 1;
    }
    return bins;
  }

  // ═══════════════════════════════════════
  // INIT — hook into EventBus
  // ═══════════════════════════════════════

  function init() {
    if (typeof EventBus !== 'undefined') {
      EventBus.on('noteProduced', _onNoteProduced);
      console.log('%c[ResearchState] Hooked into noteProduced event', 'color:#0af');
    } else {
      console.warn('[ResearchState] EventBus not found — manual hook required');
    }

    // Auto-start recording
    start();
  }

  // Run init on load
  init();

  return {
    start:            start,
    stop:             stop,
    isRecording:      isRecording,
    getNotes:         getNotes,
    getSnapshots:     getSnapshots,
    getSummary:       getSummary,
    getVoiceProfile:  getVoiceProfile,
    exportJSON:       exportJSON
  };

})();

console.log('%cResearchState loaded (session data collector)', 'color:#0af;font-family:monospace');

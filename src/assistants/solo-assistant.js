'use strict';
// ═══ SOLO ASSISTANT (v8.8 — Prediction-Reaction Soloist: Antescofo Architecture) ═══
//
// Core insight (Cont 2008, Antescofo): Anticipation reduces real-time complexity
// through pre-computed futures. The soloist ALWAYS predicts — maintaining a pool
// of pre-evaluated phrase candidates. When the moment comes to play, it selects
// from what it already predicted. No generation-on-demand. No PPM fallback.
// Silence is always better than a wrong note.
//
// Architecture:
//   PREDICTION (continuous): Maintain candidate pool (refreshed every 1s)
//     - Lexicon phrases (short + long), motif developments, generated phrases
//     - All scored against current harmonic trajectory + section + peers
//     - Re-scored instantly when chord changes (no regeneration needed)
//   REACTION (event-driven): Pick best candidate from pool
//     - Complementary: pick best short candidate (≤5 notes)
//     - Directional: pick best long candidate (≥6 notes)
//     - No candidate? → chord-tone fill (2-3 notes) or active silence
//     - NEVER PPM. Pool or silence.
//
// State machine:
//   LISTENING → [comp gate] → COMP_COMMITTED → LISTENING
//   LISTENING → [dir gate]  → DIR_COMMITTED  → LISTENING
//   LISTENING → ACTIVE_SILENCE → LISTENING
//   (INTENDING states removed — pool selection is instant, no tier cascade needed)
//
// Research grounding:
//   - Cont 2008 (Antescofo): Anticipatory score following — pre-computed futures
//   - Pressing 1988: Planning horizon 4-16 beats ahead
//   - Huron 2006 ITPRA: Prediction → Reaction → Evaluation cycle
//   - Frieler et al. 2016: ~25% motivic, ~40% independent, ~25% silence
//   - Zamm 2021: Variable deliberation gaps (250-2000ms)
//   - Wilson & MacDonald 2012: Active silence is a musical decision
//   - Bigand 1996: Resolution increases chord-tone preference
//   - Lerdahl & Jackendoff 1983: Strong beats require harmonic stability

var SoloAssistant = (function() {

  // ═══════════════════════════════════════════════════════════
  // §1  CONSTANTS
  // ═══════════════════════════════════════════════════════════

  // ── Deliberation timing (Zamm 2021) ──
  var DELIB_BASE_MS  = 400;
  var DELIB_MIN_MS   = 250;
  var DELIB_MAX_MS   = 2000;

  var DELIB_SECTION_FACTOR = {
    STABLE: 1.2, BUILD: 0.9, PEAK: 0.6, RELEASE: 1.0, TRANSITION: 1.3
  };

  // ── Complementary mode (low gate) ──
  var COMP_THRESHOLD       = 0.25;  // lowered from 0.30 — pool filtering adds its own quality gate
  var COMP_COOLDOWN_MS     = 1500;  // v9.1.0: was 2500 — ceiling of 64 phrases/160s starved output
  var COMP_MAX_NOTES       = 5;

  // ── Directional mode (high gate) ──
  var DIR_THRESHOLD        = 0.55;
  var DIR_COOLDOWN_MS      = 10000; // v9.1.0: was 15000 — allows more directional development
  var DIR_MIN_NOTES        = 6;

  // Section modulation of thresholds
  var THRESHOLD_SECTION_MOD = {
    STABLE:     { comp: 1.10, dir: 1.10 },
    BUILD:      { comp: 0.95, dir: 0.90 },
    PEAK:       { comp: 0.85, dir: 0.75 },
    RELEASE:    { comp: 1.00, dir: 1.05 },
    TRANSITION: { comp: 1.05, dir: 1.15 }
  };

  // ── Evidence weights ──
  var EVIDENCE_WEIGHTS = {
    harmonic: 0.25,
    metric:   0.20,
    density:  0.20,
    intent:   0.20,
    peer:     0.15
  };

  var DIR_TRAJECTORY_WEIGHT = 0.30;

  // ── Active silence ──
  var SILENCE_BASE_MS = 2000;
  var SILENCE_MIN_MS  = 800;
  var SILENCE_MAX_MS  = 6000;

  // ── Prediction pool (Cont 2008 — Antescofo) ──
  var POOL_REFRESH_MS        = 1000;   // re-evaluate/extend pool every 1s
  var POOL_MAX_SIZE          = 5;      // max candidates in pool
  var POOL_MIN_SCORE         = 0.15;   // restored from 0.25: new scoring factors (metric-position, tension, phrase-end) reduced score floor
  var DIR_TRAJECTORY_FLOOR   = 0.20;   // directional needs at least this trajectory score

  // ── Motif capture ──
  var MOTIF_CAP_MIN = (typeof MOTIF_CAPTURE_MIN_NOTES !== 'undefined') ? MOTIF_CAPTURE_MIN_NOTES : 3;
  var MOTIF_CAP_MAX = 8;

  // Percussion interaction
  var _percTempBoost = 0;
  var _percTempDecay = 0.995;
  var _fillResponsePending = false;

  // ═══════════════════════════════════════════════════════════
  // §2  STATE
  // ═══════════════════════════════════════════════════════════

  // Deliberation state machine
  // States: LISTENING, COMP_READY, DIR_READY, COMP_COMMITTED, DIR_COMMITTED, ACTIVE_SILENCE
  // READY states: postGap selects from pool, tierCascade commits and returns result
  var _state          = 'LISTENING';
  var _stateStartMs   = Date.now();
  var _delibTargetMs  = DELIB_BASE_MS;
  var _compEvidence   = 0;
  var _dirEvidence    = 0;
  var _silenceTargetMs = 0;
  var _pendingCandidate = null;  // candidate selected in postGap, committed in tierCascade

  // Cooldown tracking
  var _lastCompPhraseMs = 0;
  var _lastDirPhraseMs  = 0;

  // Motif capture
  var capturedMotif        = null;
  var motifResponsePending = false;

  // ── Prediction pool (Antescofo) ──
  // Each candidate: {notes, ioiRatios, source, score, phrase?, devResult?}
  var _candidatePool    = [];    // all pre-evaluated candidates
  var _lastPoolRefresh  = 0;     // timestamp of last pool refresh
  var _lastChordRoot    = -1;    // track chord changes for re-scoring

  // Diagnostics
  var _modeStats = {
    comp_pool: 0, comp_motif: 0, comp_fill: 0,
    directional: 0, silence: 0, total: 0
  };

  // ═══════════════════════════════════════════════════════════
  // §3  HELPERS
  // ═══════════════════════════════════════════════════════════

  function _getSection() {
    if (typeof SectionTracker !== 'undefined') {
      return SectionTracker.getVoiceState('soloist').state || 'STABLE';
    }
    return 'STABLE';
  }

  function _getDensity() {
    if (typeof ContextIntegrator !== 'undefined') {
      var snap = ContextIntegrator.getEnsembleSnapshot();
      if (snap && typeof snap.totalDensity === 'number') return snap.totalDensity;
    }
    return 1.0;
  }

  // Get upcoming chord tones from HarmonicPlanner (shared harmonic context)
  function _getChordContext() {
    var chordTones = [];
    if (typeof HarmonicPlanner !== 'undefined' && HarmonicPlanner.getNextChords) {
      var nextChords = HarmonicPlanner.getNextChords();
      if (nextChords && nextChords.length > 0) {
        for (var c = 0; c < nextChords.length; c++) {
          var chord = nextChords[c];
          if (chord && chord.rootPC !== undefined) {
            var root = chord.rootPC % 12;
            chordTones.push(root);
            if (chord.type === 'minor') {
              chordTones.push((root + 3) % 12);
            } else {
              chordTones.push((root + 4) % 12);
            }
            chordTones.push((root + 7) % 12);
          }
        }
      }
    }
    var seen = {};
    var unique = [];
    for (var i = 0; i < chordTones.length; i++) {
      if (!seen[chordTones[i]]) {
        seen[chordTones[i]] = true;
        unique.push(chordTones[i]);
      }
    }
    return unique;
  }

  // Get CURRENT chord root (for change detection)
  function _getCurrentChordRoot() {
    if (typeof HarmonicPlanner !== 'undefined' && HarmonicPlanner.getCurrentContext) {
      var ctx = HarmonicPlanner.getCurrentContext('soloist');
      if (ctx && ctx.rootPC !== undefined) return ctx.rootPC % 12;
    }
    return -1;
  }

  // Variable deliberation timing (Zamm 2021, Vuust 2022)
  function _computeDeliberationMs() {
    var beliefConf = 0.5;
    if (typeof BeliefState !== 'undefined') {
      var params = BeliefState.getParams('soloist');
      if (params && params.dominantProb) beliefConf = params.dominantProb;
    }
    var confidenceFactor = 1.0 / Math.max(0.3, beliefConf);
    var sectionFactor = DELIB_SECTION_FACTOR[_getSection()] || 1.0;
    var densityFactor = 1.0 + (_getDensity() - 1.5) * 0.3;
    var raw = DELIB_BASE_MS * confidenceFactor * sectionFactor * densityFactor;
    return Math.max(DELIB_MIN_MS, Math.min(DELIB_MAX_MS, raw));
  }

  // Base evidence score (5 dimensions)
  function _computeBaseEvidence() {
    var score = 0;

    // 1. Harmonic clarity
    // v9.1.0: Floor at 0.30 — soloist is an explorer (HARMONIC_AUTHORITY 0.45).
    // Low key confidence should reduce harmonic weight, not prevent all output.
    // Without floor: confidence 0.03 → harmonic contribution 0.25×0.03 = 0.0075
    // (only 1.5% of max), bottlenecking total evidence below thresholds.
    // With floor: minimum contribution 0.25×0.30 = 0.075 (15% of max).
    var harmonicScore = 0.5;
    if (typeof KeyBelief !== 'undefined') {
      harmonicScore = Math.max(0.30, KeyBelief.getConfidence('soloist') || 0.5);
    }
    score += EVIDENCE_WEIGHTS.harmonic * harmonicScore;

    // 2. Metric alignment
    var metricScore = 0.5;
    if (typeof BarTracker !== 'undefined') {
      var barPhase = BarTracker.getBarPhase();
      var distToStrong = Math.min(barPhase, Math.abs(barPhase - 0.5), 1.0 - barPhase);
      metricScore = 1.0 - distToStrong * 4.0;
      metricScore = Math.max(0, Math.min(1, metricScore));
    }
    score += EVIDENCE_WEIGHTS.metric * metricScore;

    // 3. Ensemble space
    var densityScore = 1.0 - Math.min(1.0, _getDensity() / 3.0);
    score += EVIDENCE_WEIGHTS.density * densityScore;

    // 4. Intent clarity
    var intentScore = 0.5;
    if (typeof BeliefState !== 'undefined') {
      var params = BeliefState.getParams('soloist');
      if (params && params.dominantProb) intentScore = params.dominantProb;
    }
    score += EVIDENCE_WEIGHTS.intent * intentScore;

    // 5. Peer state
    var peerScore = 0.5;
    if (typeof Scheduler !== 'undefined') {
      var leadActive = Scheduler.hasActivePhrase('lead');
      var bassActive = Scheduler.hasActivePhrase('bass');
      peerScore = 1.0;
      if (leadActive) peerScore -= 0.3;
      if (bassActive) peerScore -= 0.2;
      peerScore = Math.max(0, peerScore);
    }
    score += EVIDENCE_WEIGHTS.peer * peerScore;

    return score;
  }

  // Directional evidence = base + best trajectory fit (Cont 2008)
  function _computeDirectionalEvidence() {
    var base = _computeBaseEvidence();
    var bestTrajectory = _getBestDirectionalScore();
    return (1.0 - DIR_TRAJECTORY_WEIGHT) * base + DIR_TRAJECTORY_WEIGHT * bestTrajectory;
  }

  // Best trajectory score from pool (directional candidates only)
  function _getBestDirectionalScore() {
    var best = 0;
    for (var i = 0; i < _candidatePool.length; i++) {
      if (_candidatePool[i].notes.length >= DIR_MIN_NOTES && _candidatePool[i].score > best) {
        best = _candidatePool[i].score;
      }
    }
    return best;
  }

  // Active silence duration (Wilson & MacDonald 2012)
  function _computeSilenceDuration() {
    var secFactors = { STABLE: 1.2, BUILD: 0.8, PEAK: 0.5, RELEASE: 1.4, TRANSITION: 1.0 };
    var factor = secFactors[_getSection()] || 1.0;
    var raw = SILENCE_BASE_MS * factor * (0.7 + Math.random() * 0.6);
    return Math.max(SILENCE_MIN_MS, Math.min(SILENCE_MAX_MS, raw));
  }

  // ═══════════════════════════════════════════════════════════
  // §3b  PREDICTION POOL (Cont 2008 — Antescofo Architecture)
  // ═══════════════════════════════════════════════════════════

  // Score candidate phrase against harmonic trajectory + section + peers
  function _scoreCandidate(notes) {
    if (!notes || notes.length < 2) return 0.1;

    var score = 0;
    var checks = 0;

    // 1. Tension-resolution pattern scoring (Narmour 1990, Huron 2006)
    //    Soloist's harmonic role is TENSION, not conformity.
    //    Reward: boundary anchoring, approach tones, resolution movements
    //    Neutral: interior non-chord tones (passing tones, blue notes, exploration)
    //    The soloist creates tension that B/R/P then resolve.
    var chordCtx = _getChordContext();
    if (chordCtx.length > 0) {
      var chordSet = {};
      for (var ci = 0; ci < chordCtx.length; ci++) chordSet[chordCtx[ci]] = true;

      var tensionScore = 0;

      // 1a. Boundary anchoring: first/last notes as chord tones (phrase entry/exit)
      var firstPC = notes[0] % 12;
      var lastPC = notes[notes.length - 1] % 12;
      if (chordSet[firstPC]) tensionScore += 0.12;
      if (chordSet[lastPC]) tensionScore += 0.15;

      // 1b. Approach tones: semitone below chord tone resolving to it
      //     B→C over Cmaj = leading tone → root = musical tension
      var approachCount = 0;
      for (var ai = 0; ai < notes.length - 1; ai++) {
        var thisPC = notes[ai] % 12;
        var nextPC = notes[ai + 1] % 12;
        if (!chordSet[thisPC] && chordSet[nextPC] &&
            ((thisPC + 1) % 12 === nextPC || (thisPC + 11) % 12 === nextPC)) {
          approachCount++;
        }
      }
      tensionScore += Math.min(0.15, approachCount * 0.06);

      // 1c. Resolution movements: non-chord → chord tone transitions
      var resolutions = 0;
      for (var ri = 1; ri < notes.length; ri++) {
        if (!chordSet[notes[ri - 1] % 12] && chordSet[notes[ri] % 12]) resolutions++;
      }
      tensionScore += Math.min(0.10, resolutions * 0.04);

      score += tensionScore;
      checks++;
    }

    // 2. Energy trajectory alignment
    if (typeof NarrativeArc !== 'undefined') {
      var arc = NarrativeArc.getArc('soloist');
      if (arc) {
        var arcEnergy = arc.energy || 0.5;
        var phraseLengthFit = notes.length >= 6 ? arcEnergy : (1.0 - arcEnergy) * 0.5;
        score += phraseLengthFit * 0.25;
        checks++;
      }
    }

    // 3. Contour direction vs section
    var section = _getSection();
    if (notes.length >= 3) {
      var ascending = 0;
      for (var j = 1; j < notes.length; j++) {
        if (notes[j] > notes[j - 1]) ascending++;
      }
      var ascRatio = ascending / (notes.length - 1);
      if (section === 'BUILD' || section === 'PEAK') {
        score += ascRatio * 0.2;
      } else if (section === 'RELEASE') {
        score += (1.0 - ascRatio) * 0.2;
      } else {
        score += 0.1;
      }
      checks++;
    }

    // 4. MelodicExpectancy fit
    if (typeof MelodicExpectancy !== 'undefined') {
      var expectDist = MelodicExpectancy.predict('soloist');
      if (expectDist && expectDist.dist) {
        var expectScore = 0;
        for (var k = 0; k < notes.length; k++) {
          expectScore += expectDist.dist[notes[k] % 12] || 0;
        }
        expectScore /= notes.length;
        score += Math.min(1.0, expectScore / 0.15) * 0.2;
        checks++;
      }
    }

    // 5. v9.1.0: Internal repetition penalty (Huron 2006)
    // Phrases with consecutive repeated PCs sound stuck, not melodic.
    // Penalize proportionally to how repetitive the phrase is.
    if (notes.length >= 3) {
      var _repCount = 0;
      for (var ri2 = 1; ri2 < notes.length; ri2++) {
        if ((notes[ri2] % 12) === (notes[ri2 - 1] % 12)) _repCount++;
      }
      var _repRate = _repCount / (notes.length - 1);
      // Penalty kicks in above 20% repetition (some repetition is natural)
      if (_repRate > 0.2) {
        score -= (_repRate - 0.2) * 0.5;
      }
      checks++;
    }

    return checks > 0 ? Math.min(1.0, score) : 0.1;
  }

  // Refresh pool: generate new candidates + re-score existing ones
  // Called every POOL_REFRESH_MS during LISTENING
  function _refreshPool(ag) {
    var keyC = (typeof SharedState !== 'undefined') ? SharedState.keyC : 0;
    var newCandidates = [];

    // ── Generate new candidates ──

    // 1-2. Lexicon phrases (speculatively selected — short + long)
    if (ag._isLexiconLoaded()) {
      for (var li = 0; li < 3; li++) {
        var lexPhrase = ag.selectPhrase(keyC, true); // speculative
        if (lexPhrase && lexPhrase.sd && lexPhrase.sd.length >= 2) {
          var isDup = false;
          for (var di = 0; di < newCandidates.length; di++) {
            if (newCandidates[di].notes.length === lexPhrase.sd.length &&
                newCandidates[di].notes[0] === lexPhrase.sd[0]) {
              isDup = true; break;
            }
          }
          // Also check against existing pool
          if (!isDup) {
            for (var pi = 0; pi < _candidatePool.length; pi++) {
              if (_candidatePool[pi].notes.length === lexPhrase.sd.length &&
                  _candidatePool[pi].notes[0] === lexPhrase.sd[0]) {
                isDup = true; break;
              }
            }
          }
          if (!isDup) {
            // v9.1.0: Convert functional degrees → chromatic PCs.
            // Lexicon .sd contains scale degrees (0-6), not pitch classes (0-11).
            // Without conversion, degrees are played as PCs → wrong notes.
            // Bass/rhythm convert via (sd + key) % 12 in tier_a_lexicon; soloist's
            // pool must do it here since it bypasses the normal pathway.
            var _convNotes = new Array(lexPhrase.sd.length);
            for (var ci = 0; ci < lexPhrase.sd.length; ci++) {
              _convNotes[ci] = (lexPhrase.sd[ci] + keyC) % 12;
            }
            newCandidates.push({
              notes: _convNotes,
              ioiRatios: lexPhrase.ioi_ratios,
              source: 'lexicon',
              phrase: lexPhrase,
              score: 0
            });
          }
        }
      }
    }

    // 3. MotifDeveloper developmental phrase
    if (typeof MotifDeveloper !== 'undefined' && MotifDeveloper.hasSeed('soloist')) {
      var dev = MotifDeveloper.develop('soloist', _getSection(), _getChordContext());
      if (dev && dev.sd && dev.sd.length >= 2 && dev.ioi_ratios) {
        // v9.1.0: Convert degrees → PCs (same fix as lexicon above)
        var _devNotes = new Array(dev.sd.length);
        for (var di = 0; di < dev.sd.length; di++) {
          _devNotes[di] = (dev.sd[di] + keyC) % 12;
        }
        newCandidates.push({
          notes: _devNotes,
          ioiRatios: dev.ioi_ratios,
          source: 'motif_dev',
          devResult: dev,
          score: 0
        });
      }
    }

    // 4. Motif response (if pending)
    if (motifResponsePending && capturedMotif && capturedMotif.pcs.length >= 3) {
      var motif = capturedMotif.pcs;
      var response;
      var r = Math.random();
      if (r < 0.4) {
        response = motif.map(function(pc) { return (pc + 5) % 12; });
      } else if (r < 0.7) {
        response = [motif[0]];
        for (var mi = 1; mi < motif.length; mi++) {
          var interval = motif[mi] - motif[mi - 1];
          response.push(((response[response.length - 1] - interval) % 12 + 12) % 12);
        }
      } else {
        response = motif.slice().reverse();
      }
      if (response.length > COMP_MAX_NOTES) response = response.slice(0, COMP_MAX_NOTES);
      newCandidates.push({
        notes: response,
        ioiRatios: null,
        source: 'motif_response',
        score: 0
      });
    }

    // 5. Shared phrase from cross-voice memory (v8.8.0)
    if (typeof SharedPhraseMemory !== 'undefined' && SharedPhraseMemory.getPoolSize() > 0) {
      var shared = SharedPhraseMemory.selectAndAdapt('soloist', _getSection(), _getChordContext());
      if (shared && shared.sd && shared.sd.length >= 2) {
        // v9.1.0: Convert degrees → PCs (same fix as lexicon above)
        var _sharedNotes = new Array(shared.sd.length);
        for (var si = 0; si < shared.sd.length; si++) {
          _sharedNotes[si] = (shared.sd[si] + keyC) % 12;
        }
        newCandidates.push({
          notes: _sharedNotes,
          ioiRatios: shared.ioi_ratios,
          source: 'shared_phrase',
          sourceVoice: shared.sourceVoice,
          score: 0
        });
      }
    }

    // v9.1.0: Harmonic floor check — reject candidates with extreme dissonance.
    // Soloist is designed for 40-50% non-chord-tone rate (exploratory role).
    // But phrases with >70% off-chord notes sound "extremely wrong," not exploratory.
    // This hard gate prevents the worst harmonic errors while preserving variety.
    var _hfChord = SharedState.currentChord;
    if (_hfChord) {
      var _hfRoot = _hfChord.rootPC;
      var _hfThird = (_hfRoot + (_hfChord.type === 'minor' ? 3 : 4)) % 12;
      var _hfFifth = (_hfRoot + 7) % 12;
      var _hfFiltered = [];
      for (var hfi = 0; hfi < newCandidates.length; hfi++) {
        var _hfNotes = newCandidates[hfi].notes;
        var _hfHits = 0;
        for (var hfj = 0; hfj < _hfNotes.length; hfj++) {
          var _hfPC = ((_hfNotes[hfj] % 12) + 12) % 12;
          if (_hfPC === _hfRoot || _hfPC === _hfThird || _hfPC === _hfFifth) _hfHits++;
        }
        var _hfRate = _hfNotes.length > 0 ? _hfHits / _hfNotes.length : 0;
        if (_hfRate >= 0.25) {  // at least 25% chord tones (allows 75% non-chord = very free)
          _hfFiltered.push(newCandidates[hfi]);
        }
      }
      // Only apply filter if it doesn't empty the pool entirely
      if (_hfFiltered.length > 0) newCandidates = _hfFiltered;
    }

    // ── Score all candidates (new + existing) ──
    for (var ni = 0; ni < newCandidates.length; ni++) {
      newCandidates[ni].score = _scoreCandidate(newCandidates[ni].notes);
    }
    // Re-score existing pool (harmonic context may have changed)
    for (var ei = 0; ei < _candidatePool.length; ei++) {
      _candidatePool[ei].score = _scoreCandidate(_candidatePool[ei].notes);
    }

    // ── Merge: keep best POOL_MAX_SIZE candidates ──
    var all = _candidatePool.concat(newCandidates);
    all.sort(function(a, b) { return b.score - a.score; });

    // Remove duplicates and low-scorers
    var kept = [];
    for (var ki = 0; ki < all.length && kept.length < POOL_MAX_SIZE; ki++) {
      if (all[ki].score < POOL_MIN_SCORE) continue;
      var dup = false;
      for (var kj = 0; kj < kept.length; kj++) {
        if (kept[kj].notes.length === all[ki].notes.length &&
            kept[kj].notes[0] === all[ki].notes[0] &&
            kept[kj].source === all[ki].source) {
          dup = true; break;
        }
      }
      if (!dup) kept.push(all[ki]);
    }

    _candidatePool = kept;
    _lastPoolRefresh = Date.now();

    // v8.8.0: Publish soloist's harmonic intent from top candidate
    // The pool refresh uses speculative=true which skips intent publishing.
    // But the ensemble needs to know where the soloist is heading for consensus.
    // Top candidate's ending pitch class IS the soloist's harmonic direction.
    // v9.3.0: Publish via ChordBelief (unified harmonic truth)
    if (_candidatePool.length > 0 && typeof ChordBelief !== 'undefined') {
      var _topNotes = _candidatePool[0].notes;
      var _keyC = (typeof SharedState !== 'undefined') ? SharedState.keyC : 0;
      var _endPC = (_topNotes[_topNotes.length - 1] + _keyC) % 12;
      ChordBelief.publishIntent('soloist', _endPC, 'major',
        Math.min(0.8, _candidatePool[0].score), 2);
    }
  }

  // Re-score pool without regenerating (called on chord change)
  function _rescorePool() {
    for (var i = 0; i < _candidatePool.length; i++) {
      _candidatePool[i].score = _scoreCandidate(_candidatePool[i].notes);
    }
    // Re-sort
    _candidatePool.sort(function(a, b) { return b.score - a.score; });
    // Prune low-scorers
    while (_candidatePool.length > 0 &&
           _candidatePool[_candidatePool.length - 1].score < POOL_MIN_SCORE) {
      _candidatePool.pop();
    }
  }

  // v9.1.0: Track recently played PCs for recency penalty
  var _recentPlayedPCs = [];  // rolling buffer of last 8 starting PCs
  var _RECENCY_BUFFER_SIZE = 8;

  // Pick best candidate from pool, filtered by length constraint.
  // v9.1.0: Applies recency penalty and slight randomness to break
  // deterministic loops where the same phrase wins repeatedly.
  function _pickFromPool(maxNotes, minNotes) {
    var best = null;
    var bestScore = -1;
    var bestIdx = -1;
    for (var i = 0; i < _candidatePool.length; i++) {
      var c = _candidatePool[i];
      var len = c.notes.length;
      if (maxNotes && len > maxNotes) continue;
      if (minNotes && len < minNotes) continue;

      var adjustedScore = c.score;

      // Recency penalty: penalize phrases starting on recently played PCs
      // Prevents soloist from obsessively returning to the same note
      var startPC = ((c.notes[0] % 12) + 12) % 12;
      for (var ri = 0; ri < _recentPlayedPCs.length; ri++) {
        if (_recentPlayedPCs[ri] === startPC) {
          // More recent = stronger penalty (0.08 for most recent, decaying)
          adjustedScore -= 0.08 * (1.0 - ri / _recentPlayedPCs.length);
        }
      }

      // Slight randomness (±0.04) to break deterministic ties
      adjustedScore += (Math.random() - 0.5) * 0.08;

      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        best = c;
        bestIdx = i;
      }
    }
    if (best && bestIdx >= 0) {
      _candidatePool.splice(bestIdx, 1);
      // Track this PC in recency buffer
      var _pickedPC = ((best.notes[0] % 12) + 12) % 12;
      _recentPlayedPCs.unshift(_pickedPC);
      if (_recentPlayedPCs.length > _RECENCY_BUFFER_SIZE) _recentPlayedPCs.pop();
    }
    return best;
  }

  // Chord-tone fill: instant 2-3 note phrase from current chord tones
  // Last resort before silence — guaranteed harmonic safety
  function _chordToneFill() {
    // Try chord tones first
    var chordCtx = _getChordContext();
    if (chordCtx.length >= 2) {
      var fillLen = 2 + (Math.random() < 0.5 ? 1 : 0);
      var fill = [];
      var available = chordCtx.slice();
      for (var i = 0; i < fillLen && available.length > 0; i++) {
        var idx = Math.floor(Math.random() * available.length);
        fill.push(available[idx]);
        available.splice(idx, 1);
      }
      if (fill.length >= 2) {
        return { notes: fill, ioiRatios: null, source: 'chord_fill', score: 0.3 };
      }
    }
    // Fallback: scale tones (guaranteed in-scale, harmonically safe enough)
    var keyC = (typeof SharedState !== 'undefined') ? SharedState.keyC : 0;
    var mode = (typeof SharedState !== 'undefined') ? SharedState.mode : 'major';
    var scale = (typeof getScale === 'function') ? getScale(keyC, mode) : null;
    if (scale && scale.length >= 5) {
      var sFillLen = 2 + (Math.random() < 0.5 ? 1 : 0);
      var sFill = [];
      for (var si = 0; si < sFillLen; si++) {
        sFill.push(scale[Math.floor(Math.random() * scale.length)]);
      }
      return { notes: sFill, ioiRatios: null, source: 'scale_fill', score: 0.2 };
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // §4  DELIBERATION STATE MACHINE
  // ═══════════════════════════════════════════════════════════

  function _updateDeliberation(ag, dt) {
    var now = Date.now();

    // ── READY states: candidate selected, waiting for tierCascade to commit ──
    if (_state === 'COMP_READY' || _state === 'DIR_READY') {
      return null;  // proceed to tierCascade which will commit
    }

    // ── COMMITTED states: phrase playing, wait for completion ──
    if (_state === 'COMP_COMMITTED' || _state === 'DIR_COMMITTED') {
      if (!Scheduler.hasActivePhrase('soloist') && !ag._getCurrentPhrase()) {
        if (_state === 'DIR_COMMITTED') {
          _lastDirPhraseMs = now;
        } else {
          _lastCompPhraseMs = now;
        }
        _state = 'LISTENING';
        _stateStartMs = now;
        _delibTargetMs = _computeDeliberationMs();
      }
      return null;  // let pipeline consume scheduled notes
    }

    // ── ACTIVE_SILENCE: deliberate non-playing ──
    if (_state === 'ACTIVE_SILENCE') {
      if (now - _stateStartMs >= _silenceTargetMs) {
        _state = 'LISTENING';
        _stateStartMs = now;
        _delibTargetMs = _computeDeliberationMs();
      }
      return 'skip';
    }

    // ── LISTENING: prediction + reaction ──
    var elapsed = now - _stateStartMs;

    // Prediction: refresh pool periodically (Cont 2008)
    if (now - _lastPoolRefresh >= POOL_REFRESH_MS) {
      _refreshPool(ag);
    }

    // Chord change detection: re-score pool when harmony shifts
    var currentRoot = _getCurrentChordRoot();
    if (currentRoot >= 0 && currentRoot !== _lastChordRoot) {
      _lastChordRoot = currentRoot;
      _rescorePool();
    }

    // Wait for base deliberation period
    if (elapsed < _delibTargetMs) {
      return 'skip';
    }

    // ── Check both gates ──
    var section = _getSection();
    var secMod = THRESHOLD_SECTION_MOD[section] || THRESHOLD_SECTION_MOD.STABLE;
    var baseEvidence = _computeBaseEvidence();
    _compEvidence = baseEvidence;

    // Directional check (needs trajectory candidate in pool)
    var dirReady = (now - _lastDirPhraseMs) >= DIR_COOLDOWN_MS;
    _dirEvidence = _computeDirectionalEvidence();
    var dirThreshold = DIR_THRESHOLD * secMod.dir;

    // Complementary check
    var compReady = (now - _lastCompPhraseMs) >= COMP_COOLDOWN_MS;
    var compThreshold = COMP_THRESHOLD * secMod.comp;

    // ── Priority: directional wins if trajectory evidence high ──
    if (dirReady && _dirEvidence >= dirThreshold &&
        _getBestDirectionalScore() >= DIR_TRAJECTORY_FLOOR) {
      // React: pick best long candidate from pool
      var dirCandidate = _pickFromPool(null, DIR_MIN_NOTES);
      if (dirCandidate) {
        _pendingCandidate = dirCandidate;
        _pendingCandidate._statKey = 'directional';
        _state = 'DIR_READY';
        _stateStartMs = now;
        return null;  // proceed to tierCascade for commit
      }
      // No long candidate — don't fallback, extend deliberation
    }

    // Complementary gate
    if (compReady && _compEvidence >= compThreshold) {
      // Silence decision (Wilson & MacDonald 2012)
      var density = _getDensity();
      var silenceProb = 0.08;  // reduced from 0.10 — pool selection already filters quality
      if (density > 2.5) silenceProb = 0.25;
      if (section === 'RELEASE') silenceProb += 0.10;
      if (section === 'PEAK') silenceProb = Math.max(0.05, silenceProb - 0.05);

      if (Math.random() < silenceProb) {
        _state = 'ACTIVE_SILENCE';
        _stateStartMs = now;
        _silenceTargetMs = _computeSilenceDuration();
        _modeStats.silence++;
        _modeStats.total++;
        return 'skip';
      }

      // React: pick best short candidate from pool
      var compCandidate = _pickFromPool(COMP_MAX_NOTES, null);
      if (compCandidate) {
        _pendingCandidate = compCandidate;
        _pendingCandidate._statKey = 'comp_' + (compCandidate.source === 'motif_response' ? 'motif' : 'pool');
        _state = 'COMP_READY';
        _stateStartMs = now;
        return null;  // proceed to tierCascade for commit
      }

      // Pool empty — try chord-tone fill (guaranteed harmonic safety)
      var fill = _chordToneFill();
      if (fill) {
        _pendingCandidate = fill;
        _pendingCandidate._statKey = 'comp_fill';
        _state = 'COMP_READY';
        _stateStartMs = now;
        return null;  // proceed to tierCascade for commit
      }

      // Nothing available — active silence (NEVER PPM)
      _state = 'ACTIVE_SILENCE';
      _stateStartMs = now;
      _silenceTargetMs = _computeSilenceDuration();
      _modeStats.silence++;
      _modeStats.total++;
      return 'skip';
    }

    // Neither gate — extend deliberation
    _delibTargetMs += 200;
    _delibTargetMs = Math.min(_delibTargetMs, DELIB_MAX_MS);
    return 'skip';
  }

  // ═══════════════════════════════════════════════════════════
  // §5  COMMIT CANDIDATE (shared commit logic)
  // ═══════════════════════════════════════════════════════════

  // Commit a candidate from pool to playing state
  function _commitCandidate(ag, candidate, newState, statKey) {
    var notes = candidate.notes;
    var ioiRatios = candidate.ioiRatios;
    var now = Date.now();

    if (notes && notes.length >= 2) {
      if (ioiRatios && ioiRatios.length >= notes.length - 1) {
        // Schedule full phrase
        var bpm = (typeof TempoEngine !== 'undefined') ? TempoEngine.getEffectiveBPM() : 120;
        Scheduler.schedulePhrase('soloist', notes.slice(1), ioiRatios.slice(1), bpm, null, ioiRatios[0]);
        ag._setCurrentPhrase({
          notes: notes, idx: notes.length, ioiRatios: ioiRatios,
          loopable: false, scheduled: true,
          generated: candidate.source === 'motif_dev' || candidate.source === 'chord_fill',
          _commitContext: ag._captureCommitContext()
        });
      } else {
        // No IOI — use tick-driven consumption
        ag._setCurrentPhrase({
          notes: notes, idx: 1,
          ioiRatios: null, loopable: false,
          scheduled: false, loopCount: 0,
          _commitContext: ag._captureCommitContext()
        });
      }

      ag._setLastPhraseTime(now);

      // Capture as motif seed for future development
      if (typeof MotifDeveloper !== 'undefined' && ioiRatios) {
        MotifDeveloper.captureSeed(notes, ioiRatios, 'soloist');
      }

      // Clear motif response state if used
      if (candidate.source === 'motif_response') {
        motifResponsePending = false;
        capturedMotif = null;
      }
    }

    _state = newState;
    _stateStartMs = now;
    _modeStats[statKey] = (_modeStats[statKey] || 0) + 1;
    _modeStats.total++;

    return { pc: notes[0], source: candidate.source, confidence: Math.max(0.5, candidate.score) };
  }

  // ═══════════════════════════════════════════════════════════
  // §6  VOICE AGENT CREATION
  // ═══════════════════════════════════════════════════════════

  var agent = AssistantShared.createVoiceAgent({
    name: 'soloist',
    scopeMultiplier: 1.5,
    lexiconKey: 'solo_lexicon',
    bpmUseScopeMultiplier: false,
    skipBeliefGate: true,  // soloist self-regulates via prediction pool + evidence gates
    recentPhraseMemory: (typeof RECENT_PHRASE_MEMORY_SOLO !== 'undefined') ? RECENT_PHRASE_MEMORY_SOLO : 8,
    phraseWeights: {
      freq: 0.1, interest: 0.35, contextFit: 0.2, loopBonus: 0.0, randomSpread: 0.15,
      metricStartW: 0.2, metricEndW: 0.5, metricScale: 0.12,
      bassRootIntervals: [2, 5, 9], bassRootBoost: 0.06
    },
    observeOwnOutput: true,
    hooks: {
      // ── Player note observation → motif capture + urgency ──
      onObservePlayer: function(ag, pc, time) {
        if (_state === 'LISTENING' && motifResponsePending) {
          _delibTargetMs = Math.max(DELIB_MIN_MS, _delibTargetMs * 0.7);
        }
      },

      // ── Post-gap: prediction-reaction driver ──
      postGap: function(ag, dt) {
        _percTempBoost *= _percTempDecay;
        if (_percTempBoost < 0.005) _percTempBoost = 0;
        return _updateDeliberation(ag, dt);
      },

      // ── Tier cascade: commit pending candidate from pool ──
      tierCascade: function(ag) {
        // Clear completed scheduled phrases
        var cp = ag._getCurrentPhrase();
        if (cp && cp.scheduled && !Scheduler.hasActivePhrase('soloist')) {
          ag._setCurrentPhrase(null);
        }

        // Commit pending candidate (selected in postGap → _updateDeliberation)
        if ((_state === 'COMP_READY' || _state === 'DIR_READY') && _pendingCandidate) {
          var candidate = _pendingCandidate;
          var commitState = _state === 'DIR_READY' ? 'DIR_COMMITTED' : 'COMP_COMMITTED';
          var statKey = candidate._statKey || 'comp_pool';
          _pendingCandidate = null;
          return _commitCandidate(ag, candidate, commitState, statKey);
        }

        return null;
      },

      // ── Tier 3 bias: approach tones + bass-relative + saturation ──
      // Soloist's harmonic role is TENSION, not chord-tone conformity.
      // During resolution: boost approach tones (semitone below chord tones)
      // to create the tension that B/R/P then resolve. Mild chord-tone
      // boost for phrase endings only. (Narmour 1990, Huron 2006)
      tier3Bias: function(ag, probs, stm) {
        var allBiases = [];

        var chordCtx = _getChordContext();
        if (chordCtx.length > 0) {
          var urgency = 0;
          if (typeof SectionTracker !== 'undefined') {
            urgency = SectionTracker.getState().resolutionUrgency || 0;
          }

          // Approach tones: semitone below each chord tone (tension creators)
          // Stronger during resolution — soloist leans into tension before B/R/P resolve
          var approachBoost = 1.1 + urgency * 0.4;  // 1.1 → 1.5 during resolution
          for (var ch = 0; ch < chordCtx.length; ch++) {
            var approachPC = (chordCtx[ch] + 11) % 12;  // semitone below
            allBiases.push({ pc: approachPC, boost: approachBoost });
          }

          // Mild chord-tone awareness (not dominance)
          // Soloist should know where the chord tones are without being locked to them
          var mildBoost = 1.05 + urgency * 0.25;  // 1.05 → 1.30 (subtle, not groupthink)
          for (var ch2 = 0; ch2 < chordCtx.length; ch2++) {
            allBiases.push({ pc: chordCtx[ch2], boost: mildBoost });
          }
        }

        // Bass-relative intervals (complementary register)
        var bassRoot = (typeof FinalCoordinator !== 'undefined') ? FinalCoordinator.getBassRoot() : null;
        if (bassRoot !== null) {
          allBiases.push({ pc: (bassRoot + 2) % 12, boost: 1.1 });
          allBiases.push({ pc: (bassRoot + 5) % 12, boost: 1.1 });
          allBiases.push({ pc: (bassRoot + 9) % 12, boost: 1.1 });
        }

        // Saturation biases
        if (typeof ContextIntegrator !== 'undefined') {
          var satBiases = ContextIntegrator.getSaturationBiases();
          for (var si = 0; si < satBiases.length; si++) allBiases.push(satBiases[si]);
        }

        if (allBiases.length > 0) {
          applyRoleBias(probs, allBiases, stm.recent);
        }
      },

      // ── Reset ──
      onReset: function(ag) {
        _percTempBoost = 0;
        _fillResponsePending = false;
        capturedMotif = null;
        motifResponsePending = false;
        _state = 'LISTENING';
        _stateStartMs = Date.now();
        _delibTargetMs = DELIB_BASE_MS;
        _compEvidence = 0;
        _dirEvidence = 0;
        _silenceTargetMs = 0;
        _lastCompPhraseMs = 0;
        _lastDirPhraseMs = 0;
        _candidatePool = [];
        _lastPoolRefresh = 0;
        _lastChordRoot = -1;
        _pendingCandidate = null;
        _modeStats = {
          comp_pool: 0, comp_motif: 0, comp_fill: 0,
          directional: 0, silence: 0, total: 0
        };
      }
    }
  });

  // ═══════════════════════════════════════════════════════════
  // §7  OVERRIDES
  // ═══════════════════════════════════════════════════════════

  var _origObservePlayer = agent.observePlayerNote;
  agent.observePlayerNote = function(pc, time) {
    _origObservePlayer(pc, time);
    var now = time || Date.now();
    if (agent.stm.recent.length >= MOTIF_CAP_MIN) {
      capturedMotif = {
        pcs: agent.stm.recent.slice(-Math.min(agent.stm.recent.length, MOTIF_CAP_MAX)),
        time: now
      };
      motifResponsePending = true;
    }
  };

  agent.getCurrentSource = function() {
    if (_state === 'LISTENING') return 'deliberating';
    if (_state === 'ACTIVE_SILENCE') return 'silence';
    if (_state === 'COMP_COMMITTED') {
      var cp = agent._getCurrentPhrase();
      return cp ? (cp.generated ? 'comp_gen' : 'comp_pool') : 'comp_fill';
    }
    if (_state === 'DIR_COMMITTED') return 'directional';
    var cpFallback = agent._getCurrentPhrase();
    if (cpFallback) return cpFallback.generated ? 'generate' : 'lexicon';
    return agent._getLoopPattern() ? 'loop' : 'pool';
  };

  agent.getPhraseProgress = function() {
    if (_state === 'LISTENING' || _state === 'ACTIVE_SILENCE') return 0.0;
    if (Scheduler.hasActivePhrase('soloist')) return Scheduler.getPhraseProgress('soloist');
    var cp = agent._getCurrentPhrase();
    if (cp && !cp.scheduled && cp.idx < cp.notes.length) return cp.idx / cp.notes.length;
    var lp = agent._getLoopPattern();
    if (lp && lp.length > 0) return agent._getLoopIdx() / lp.length;
    return 0.5;
  };

  // ═══════════════════════════════════════════════════════════
  // §8  DIAGNOSTIC APIs
  // ═══════════════════════════════════════════════════════════

  agent.getDeliberationState = function() {
    return {
      state: _state,
      mode: _state.indexOf('COMP') >= 0 ? 'complementary' :
            _state.indexOf('DIR') >= 0 ? 'directional' : 'listening',
      deliberationMs: Date.now() - _stateStartMs,
      compEvidence: +_compEvidence.toFixed(3),
      dirEvidence: +_dirEvidence.toFixed(3),
      poolSize: _candidatePool.length,
      poolScores: _candidatePool.map(function(c) {
        return { source: c.source, len: c.notes.length, score: +c.score.toFixed(3) };
      }),
      compCooldownMs: Math.max(0, COMP_COOLDOWN_MS - (Date.now() - _lastCompPhraseMs)),
      dirCooldownMs: Math.max(0, DIR_COOLDOWN_MS - (Date.now() - _lastDirPhraseMs)),
      silenceTargetMs: _silenceTargetMs
    };
  };

  agent.getResponseModeStats = function() {
    var t = _modeStats.total || 1;
    return {
      total: _modeStats.total,
      comp_pool:     +(_modeStats.comp_pool / t).toFixed(3),
      comp_motif:    +(_modeStats.comp_motif / t).toFixed(3),
      comp_fill:     +(_modeStats.comp_fill / t).toFixed(3),
      directional:   +(_modeStats.directional / t).toFixed(3),
      silence:       +(_modeStats.silence / t).toFixed(3),
      raw: _modeStats
    };
  };

  agent.getCandidatePool = function() { return _candidatePool; };
  agent.getCapturedMotif = function() { return capturedMotif; };
  agent.isMotifPending = function() { return motifResponsePending; };

  // ═══════════════════════════════════════════════════════════
  // §9  EVENT LISTENERS
  // ═══════════════════════════════════════════════════════════

  if (typeof EventBus !== 'undefined') {
    var _PERC_ESCALATION = { 'sparse': 0, 'basic': 1, 'driving': 2 };
    EventBus.on('percPatternChange', function(ev) {
      var fromLevel = _PERC_ESCALATION[ev.from] || 0;
      var toLevel = _PERC_ESCALATION[ev.to] || 0;
      if (toLevel > fromLevel) {
        _percTempBoost = Math.min(0.2, (toLevel - fromLevel) * 0.1);
      }
    });
    EventBus.on('percFillSignal', function() {
      _percTempBoost = 0.2;
      _fillResponsePending = true;
      if (_state === 'LISTENING') {
        _delibTargetMs = Math.max(DELIB_MIN_MS, _delibTargetMs * 0.5);
      }
    });
    // Chord change → re-score pool instantly (Antescofo reactive re-evaluation)
    EventBus.on('chord:change', function() {
      _rescorePool();
    });
  }

  return agent;
})();

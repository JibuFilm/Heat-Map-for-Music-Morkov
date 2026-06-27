// ═══════════════════════════════════════════════════════════════
// ThematicMemory — Session-Scale Motif Archive (v9.0.0)
// ═══════════════════════════════════════════════════════════════
// Long-term thematic memory that persists for the ENTIRE session.
// Unlike SharedPhraseMemory (120s TTL, improvisation tool), this
// archives notable phrases permanently so they can be recalled
// minutes later — turning improvisation into composition.
//
// A motif stated in minute 1 (exposition) can return at minute 12
// (recapitulation), transformed for the current harmonic context.
// The soloist's opening statement becomes the bass's closing ground.
//
// Recall probability is modulated by NarrativeArc session phase:
//   Exposition:      LOW recall (0.05) — establishing new themes
//   Development:     MODERATE recall (0.20) — developing themes
//   Recapitulation:  HIGH recall (0.40) — returning to earlier themes
//
// Psychoacoustic basis:
//   Margulis 2014 — repetition creates musical meaning
//   Ockelford 2005 — repetition as fundamental structural force
//   Huron 2006 — fulfilled expectation produces pleasure (ITPRA)
//   Narmour 1990 — contour as primary melodic identity marker
//   Reti 1951 — thematic process in classical composition
// ═══════════════════════════════════════════════════════════════

'use strict';

var ThematicMemory = (function() {

  // ── Archive Storage ──
  var _archive = [];      // Theme objects — NO TTL, persist entire session
  var _idCounter = 0;
  var _recallLog = {};    // per-voice: last 4 recalled theme IDs (dedup)
  var _lastCaptureTime = {};  // per-voice cooldown

  // ── Constants ──
  var ARCHIVE_MAX = 24;          // max themes stored (oldest pruned by notability)
  var CAPTURE_COOLDOWN_MS = 8000; // min 8s between captures per voice
  var NOTABILITY_THRESHOLD = 0.55; // higher than SharedPhraseMemory (0.45) — only memorable phrases
  var MIN_PHRASE_LENGTH = 4;      // themes need substance
  var MAX_PHRASE_LENGTH = 16;     // cap storage size

  // Session-phase recall probabilities
  // During exposition: mostly creating new themes, rarely recalling
  // During recapitulation: actively seeking thematic callbacks
  var RECALL_PROBABILITY = {
    exposition:      0.05,
    development:     0.20,
    recapitulation:  0.40
  };

  // Score bonus range for thematic recall in selectPhrase
  var THEME_SCORE_BONUS_MAX = 0.14; // stronger than SharedPhraseMemory's 0.08

  // ── Contour Utilities (Narmour 1990) ──

  // Parsons contour code: +1 (up), -1 (down), 0 (same)
  function _parsonsCode(sdArr) {
    var code = [];
    for (var i = 1; i < sdArr.length; i++) {
      var diff = sdArr[i] - sdArr[i - 1];
      code.push(diff > 0 ? 1 : (diff < 0 ? -1 : 0));
    }
    return code;
  }

  // Contour similarity: normalized dot product of Parsons codes
  // 1.0 = identical contour, 0.0 = orthogonal, -1.0 = inverse
  function _contourSimilarity(sdA, sdB) {
    var cA = _parsonsCode(sdA);
    var cB = _parsonsCode(sdB);
    if (cA.length === 0 || cB.length === 0) return 0;
    // Compare shorter length
    var len = Math.min(cA.length, cB.length);
    var dot = 0, magA = 0, magB = 0;
    for (var i = 0; i < len; i++) {
      dot += cA[i] * cB[i];
      magA += cA[i] * cA[i];
      magB += cB[i] * cB[i];
    }
    var denom = Math.sqrt(magA) * Math.sqrt(magB);
    if (denom < 0.001) return 0;
    // Length penalty: shorter overlap = less confident similarity
    var lenRatio = len / Math.max(cA.length, cB.length);
    return (dot / denom) * lenRatio;
  }

  // Interval profile: signed semitone differences
  function _intervals(sdArr) {
    var iv = [];
    for (var i = 1; i < sdArr.length; i++) {
      iv.push(sdArr[i] - sdArr[i - 1]);
    }
    return iv;
  }

  // ── Notability Scoring ──
  // Only truly memorable phrases enter the archive.
  // Factors: contour distinctiveness, harmonic richness, rhythmic shape

  function _contourDistinctiveness(sdArr) {
    // How varied is the contour? (not just stepwise, not monotone)
    var parsons = _parsonsCode(sdArr);
    if (parsons.length < 2) return 0;
    var changes = 0;
    for (var i = 1; i < parsons.length; i++) {
      if (parsons[i] !== parsons[i - 1]) changes++;
    }
    // Range contributes too — wider phrases are more distinctive
    var min = sdArr[0], max = sdArr[0];
    for (var j = 1; j < sdArr.length; j++) {
      if (sdArr[j] < min) min = sdArr[j];
      if (sdArr[j] > max) max = sdArr[j];
    }
    var range = max - min;
    var changeRatio = changes / (parsons.length - 1);
    var rangeScore = Math.min(1, range / 12); // 12 semitones = max
    return changeRatio * 0.6 + rangeScore * 0.4;
  }

  function _rhythmicShape(ioiRatios) {
    if (!ioiRatios || ioiRatios.length < 2) return 0.3;
    // Coefficient of variation — moderate variation = interesting rhythm
    var sum = 0;
    for (var i = 0; i < ioiRatios.length; i++) sum += ioiRatios[i];
    var mean = sum / ioiRatios.length;
    if (mean <= 0) return 0;
    var variance = 0;
    for (var j = 0; j < ioiRatios.length; j++) {
      var d = ioiRatios[j] - mean;
      variance += d * d;
    }
    var cv = Math.sqrt(variance / ioiRatios.length) / mean;
    return Math.min(1.0, Math.max(0, cv / 0.5));
  }

  function _computeNotability(sdArr, ioiRatios) {
    var contour = _contourDistinctiveness(sdArr);
    var rhythm = _rhythmicShape(ioiRatios);
    // Weight contour most — it's what humans remember (Dowling 1978)
    return contour * 0.65 + rhythm * 0.35;
  }

  // ── Archive Management ──

  function _pruneArchive() {
    // No TTL — themes live forever. Only prune by count.
    while (_archive.length > ARCHIVE_MAX) {
      // Remove least notable theme (but protect themes from exposition —
      // those are the "opening statements" most worth recalling)
      var minIdx = -1, minScore = Infinity;
      for (var i = 0; i < _archive.length; i++) {
        // Exposition themes get a 0.15 bonus to notability for pruning purposes
        var effectiveScore = _archive[i].notability;
        if (_archive[i].sessionPhase === 'exposition') effectiveScore += 0.15;
        if (effectiveScore < minScore) {
          minScore = effectiveScore;
          minIdx = i;
        }
      }
      if (minIdx >= 0) _archive.splice(minIdx, 1);
    }
  }

  // ── Session Phase Helper ──

  function _getSessionPhase() {
    if (typeof NarrativeArc !== 'undefined' && NarrativeArc.getSessionPhase) {
      return NarrativeArc.getSessionPhase().phase || 'exposition';
    }
    return 'exposition';
  }

  function _getRecallProbability() {
    var phase = _getSessionPhase();
    return RECALL_PROBABILITY[phase] || 0.10;
  }

  // ── Public API ──

  return {

    // Archive a completed phrase if it's notable enough.
    // Called from post-phrase evaluation in assistant-shared.js.
    capture: function(voiceName, phraseData) {
      if (!phraseData || !phraseData.sd || !Array.isArray(phraseData.sd)) return false;
      if (phraseData.sd.length < MIN_PHRASE_LENGTH) return false;

      // Cooldown per voice
      var now = Date.now();
      if (_lastCaptureTime[voiceName] && (now - _lastCaptureTime[voiceName]) < CAPTURE_COOLDOWN_MS) {
        return false;
      }

      // Truncate long phrases
      var sd = phraseData.sd.length > MAX_PHRASE_LENGTH
        ? phraseData.sd.slice(0, MAX_PHRASE_LENGTH)
        : phraseData.sd.slice();
      var ioi = phraseData.ioi_ratios
        ? (phraseData.ioi_ratios.length > MAX_PHRASE_LENGTH - 1
            ? phraseData.ioi_ratios.slice(0, MAX_PHRASE_LENGTH - 1)
            : phraseData.ioi_ratios.slice())
        : null;

      // Notability gate — only memorable phrases
      var notability = _computeNotability(sd, ioi);
      if (notability < NOTABILITY_THRESHOLD) return false;

      // Check for near-duplicate in archive (contour similarity > 0.85)
      for (var i = 0; i < _archive.length; i++) {
        if (_contourSimilarity(sd, _archive[i].sd) > 0.85) return false;
      }

      var sessionPhase = _getSessionPhase();
      var sectionState = null;
      if (typeof SectionTracker !== 'undefined') {
        sectionState = SectionTracker.getState().state;
      }

      _archive.push({
        id: 'tm_' + (++_idCounter),
        sd: sd,
        ioi_ratios: ioi,
        contour: _parsonsCode(sd),
        intervals: _intervals(sd),
        sourceVoice: voiceName,
        sessionPhase: sessionPhase,
        sectionState: sectionState,
        notability: notability,
        timestamp: now,
        recallCount: 0
      });

      _lastCaptureTime[voiceName] = now;
      _pruneArchive();

      if (typeof EventBus !== 'undefined') {
        EventBus.emit('themeArchived', {
          id: 'tm_' + _idCounter,
          voice: voiceName,
          phase: sessionPhase,
          notability: +notability.toFixed(3),
          archiveSize: _archive.length
        });
      }

      return true;
    },

    // Score a candidate phrase against the thematic archive.
    // Returns a bonus (0 to THEME_SCORE_BONUS_MAX) that rewards phrases
    // with moderate similarity to archived themes (0.35-0.80 contour match).
    //
    // Near-copies (>0.80) get REDUCED bonus — we want transformation, not repetition.
    // This implements Margulis 2014: repetition creates meaning, but
    // exact repetition without variation becomes boring.
    //
    // Session phase modulates the bonus:
    //   Exposition: bonus × 0.15 (mostly ignore archive, create new)
    //   Development: bonus × 0.50 (moderate thematic callback)
    //   Recapitulation: bonus × 1.0 (full thematic recall)
    getThematicBonus: function(candidateSDs, voiceName) {
      if (!candidateSDs || candidateSDs.length < 3 || _archive.length === 0) return 0;

      // Session phase modulation
      var phase = _getSessionPhase();
      var phaseMultiplier;
      if (phase === 'exposition') phaseMultiplier = 0.15;
      else if (phase === 'development') phaseMultiplier = 0.50;
      else phaseMultiplier = 1.0; // recapitulation

      // Find best matching archived theme
      var bestBonus = 0;
      var bestTheme = null;

      for (var i = 0; i < _archive.length; i++) {
        var theme = _archive[i];

        // Cross-voice bonus: recalling another voice's theme is more interesting
        var crossVoiceMult = (theme.sourceVoice !== voiceName) ? 1.2 : 1.0;

        // Cross-phase bonus: recalling from earlier phase is more meaningful
        var crossPhaseMult = 1.0;
        if (phase === 'recapitulation' && theme.sessionPhase === 'exposition') {
          crossPhaseMult = 1.3; // exposition → recapitulation callback = most powerful
        } else if (phase === 'development' && theme.sessionPhase === 'exposition') {
          crossPhaseMult = 1.15;
        }

        var sim = _contourSimilarity(candidateSDs, theme.sd);

        // Scoring curve:
        //   < 0.30: no bonus (unrelated)
        //   0.30-0.65: rising bonus (recognizable variation)
        //   0.65-0.80: peak bonus (clear callback with transformation)
        //   > 0.80: reduced bonus (too close to copying)
        var rawBonus = 0;
        if (sim >= 0.30 && sim <= 0.80) {
          // Peak at 0.65
          if (sim <= 0.65) {
            rawBonus = THEME_SCORE_BONUS_MAX * ((sim - 0.30) / 0.35);
          } else {
            rawBonus = THEME_SCORE_BONUS_MAX * (1.0 - (sim - 0.65) / 0.30);
          }
        } else if (sim > 0.80) {
          rawBonus = THEME_SCORE_BONUS_MAX * 0.25; // near-copy penalty
        }

        var bonus = rawBonus * crossVoiceMult * crossPhaseMult * phaseMultiplier;
        if (bonus > bestBonus) {
          bestBonus = bonus;
          bestTheme = theme;
        }
      }

      return Math.min(THEME_SCORE_BONUS_MAX, bestBonus);
    },

    // Check whether a voice should attempt thematic recall this tick.
    // Returns true with probability based on session phase.
    // Used as a stochastic gate before calling selectAndRecall().
    shouldRecall: function(voiceName) {
      if (_archive.length === 0) return false;
      return Math.random() < _getRecallProbability();
    },

    // Select a theme from archive and return a developed version.
    // Uses MotifDeveloper for transformation (transpose, invert, etc.)
    // Returns null if no suitable theme found or MotifDeveloper unavailable.
    selectAndRecall: function(voiceName, chordTones) {
      if (_archive.length === 0) return null;
      if (typeof MotifDeveloper === 'undefined') return null;

      // Filter: don't recall themes this voice recently recalled
      var recentIds = _recallLog[voiceName] || [];
      var candidates = [];
      for (var i = 0; i < _archive.length; i++) {
        if (recentIds.indexOf(_archive[i].id) < 0) {
          candidates.push(_archive[i]);
        }
      }
      if (candidates.length === 0) return null;

      // Weight selection toward cross-voice, cross-phase themes
      var phase = _getSessionPhase();
      var weights = [];
      var totalW = 0;
      for (var j = 0; j < candidates.length; j++) {
        var w = candidates[j].notability;
        if (candidates[j].sourceVoice !== voiceName) w *= 1.3;
        if (phase === 'recapitulation' && candidates[j].sessionPhase === 'exposition') w *= 1.5;
        weights.push(w);
        totalW += w;
      }

      // Weighted random selection
      var roll = Math.random() * totalW;
      var selected = candidates[0];
      var accum = 0;
      for (var k = 0; k < candidates.length; k++) {
        accum += weights[k];
        if (roll <= accum) { selected = candidates[k]; break; }
      }

      // Feed to MotifDeveloper for transformation
      var sectionState = 'STABLE';
      if (typeof SectionTracker !== 'undefined') {
        sectionState = SectionTracker.getState().state;
      }
      MotifDeveloper.captureSeed(selected.sd, selected.ioi_ratios, voiceName);
      var developed = MotifDeveloper.develop(voiceName, sectionState, chordTones || []);

      if (developed && developed.sd && developed.sd.length >= 3) {
        // Log recall for dedup
        if (!_recallLog[voiceName]) _recallLog[voiceName] = [];
        _recallLog[voiceName].push(selected.id);
        if (_recallLog[voiceName].length > 4) _recallLog[voiceName].shift();

        // Track recall count
        selected.recallCount++;

        if (typeof EventBus !== 'undefined') {
          EventBus.emit('themeRecalled', {
            themeId: selected.id,
            originalVoice: selected.sourceVoice,
            recallingVoice: voiceName,
            originalPhase: selected.sessionPhase,
            currentPhase: phase,
            recallCount: selected.recallCount
          });
        }

        return developed;
      }

      return null;
    },

    // Get archive state for diagnostics
    getArchive: function() {
      return _archive.map(function(t) {
        return {
          id: t.id,
          voice: t.sourceVoice,
          phase: t.sessionPhase,
          notability: +t.notability.toFixed(3),
          recallCount: t.recallCount,
          length: t.sd.length,
          age: Math.round((Date.now() - t.timestamp) / 1000) + 's'
        };
      });
    },

    getArchiveSize: function() { return _archive.length; },

    reset: function() {
      _archive = [];
      _idCounter = 0;
      _recallLog = {};
      _lastCaptureTime = {};
    }
  };

})();

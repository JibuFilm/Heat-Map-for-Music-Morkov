// ═══════════════════════════════════════════════════════════════
// SharedPhraseMemory — Stigmergic Cross-Voice Phrase Pool
// ═══════════════════════════════════════════════════════════════
// Maintains a shared pool of notable phrases published by any voice,
// readable by all. Enables motivic conversation: echo, inversion,
// fragmentation, call-and-response across the ensemble.
//
// Architecture: stigmergic (Pressing 1999) — information left in
// shared space, consumed voluntarily. No voice tells another what
// to play. Each voice independently decides whether to reference
// shared material based on its role.
//
// Quality-gated: only phrases scoring above NOTABILITY_THRESHOLD
// enter the pool. Prevents clutter from routine patterns.
//
// Research: Narmour 1990 (contour), Lerdahl 2001 (tension),
// Pressing 1999 (stigmergic coordination), Witek 2014 (rhythmic
// interest), Sawyer 2003 (anti-groupthink), Frieler 2016 (cross-
// reference rates in jazz solos ~25%).
// ═══════════════════════════════════════════════════════════════

'use strict';

var SharedPhraseMemory = (function() {

  // ── Pool Storage ──
  var _pool = [];         // SharedPhrase objects
  var _idCounter = 0;
  var _lastPublishTime = {};  // per-voice cooldown tracking
  var _recentRefs = {};   // per-voice dedup ring buffer (last 3 referenced IDs)

  // ── Constants (read from constants.js if available) ──
  function _c(name, fallback) {
    return (typeof window !== 'undefined' && typeof window[name] !== 'undefined')
      ? window[name] : fallback;
  }

  // ── Notability Scoring ──

  // Parsons contour code: sequence of +1 (up), -1 (down), 0 (same)
  function _parsonsCode(sdArr) {
    var code = [];
    for (var i = 1; i < sdArr.length; i++) {
      var diff = sdArr[i] - sdArr[i - 1];
      code.push(diff > 0 ? 1 : (diff < 0 ? -1 : 0));
    }
    return code;
  }

  // Contour similarity: normalized dot product of Parsons codes
  function _contourSimilarity(a, b) {
    var codeA = _parsonsCode(a);
    var codeB = _parsonsCode(b);
    var len = Math.min(codeA.length, codeB.length);
    if (len === 0) return 0;
    var matches = 0;
    for (var i = 0; i < len; i++) {
      if (codeA[i] === codeB[i]) matches++;
    }
    return matches / len;
  }

  // Contour novelty: how different is this from existing pool entries
  // Narmour 1990: contour is the primary melodic feature for recognition
  function _contourNovelty(sdArr) {
    if (_pool.length === 0) return 1.0;
    var maxSim = 0;
    for (var i = 0; i < _pool.length; i++) {
      var sim = _contourSimilarity(sdArr, _pool[i].sd);
      if (sim > maxSim) maxSim = sim;
    }
    return 1.0 - maxSim;
  }

  // Harmonic interest: ratio of non-chord-tones with resolution bonus
  // Lerdahl 2001: tension from non-chord tones drives musical interest
  function _harmonicInterest(sdArr, chordTones) {
    if (!chordTones || chordTones.length === 0 || sdArr.length === 0) return 0.5;
    var nonChord = 0;
    var resolves = false;
    for (var i = 0; i < sdArr.length; i++) {
      var isChord = false;
      for (var j = 0; j < chordTones.length; j++) {
        if ((sdArr[i] % 12) === (chordTones[j] % 12)) { isChord = true; break; }
      }
      if (!isChord) nonChord++;
    }
    // Resolution bonus: phrase ends on chord tone
    var lastSD = sdArr[sdArr.length - 1] % 12;
    for (var k = 0; k < chordTones.length; k++) {
      if (lastSD === (chordTones[k] % 12)) { resolves = true; break; }
    }
    var ratio = nonChord / sdArr.length;
    // Sweet spot: ~30-50% non-chord tones (Lerdahl 2001)
    var score = Math.min(1.0, ratio * 2.0);
    if (resolves && nonChord > 0) score = Math.min(1.0, score + 0.15);
    return score;
  }

  // Peer surprise: was this phrase played during a notable moment?
  // Pressing 1999: notable moments in ensemble performance
  function _peerSurprise(voiceName) {
    if (typeof PeerModel === 'undefined' || !PeerModel.getFeatureSurpriseMagnitudes) return 0.5;
    try {
      var mags = PeerModel.getFeatureSurpriseMagnitudes(voiceName);
      if (!mags) return 0.5;
      var sum = 0, count = 0;
      for (var k in mags) {
        if (typeof mags[k] === 'number') { sum += mags[k]; count++; }
      }
      return count > 0 ? Math.min(1.0, sum / count) : 0.5;
    } catch (e) { return 0.5; }
  }

  // Rhythmic interest: IOI variation (coefficient of variation)
  // Witek 2014: moderate syncopation drives groove and interest
  function _rhythmicInterest(ioiRatios) {
    if (!ioiRatios || ioiRatios.length < 2) return 0.3;
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
    // Scale: CV > 0.1 starts scoring, CV > 0.5 = max
    return Math.min(1.0, Math.max(0, (cv - 0.1) / 0.4));
  }

  // Combined notability score
  function _computeNotability(sdArr, ioiRatios, voiceName, chordTones) {
    var wContour = _c('SHARED_PHRASE_CONTOUR_NOVELTY_W', 0.30);
    var wHarmonic = _c('SHARED_PHRASE_HARMONIC_INTEREST_W', 0.25);
    var wSurprise = _c('SHARED_PHRASE_PEER_SURPRISE_W', 0.25);
    var wRhythm = _c('SHARED_PHRASE_RHYTHMIC_INTEREST_W', 0.20);

    var cn = _contourNovelty(sdArr);
    var hi = _harmonicInterest(sdArr, chordTones);
    var ps = _peerSurprise(voiceName);
    var ri = _rhythmicInterest(ioiRatios);

    return cn * wContour + hi * wHarmonic + ps * wSurprise + ri * wRhythm;
  }

  // ── Pool Management ──

  function _prune() {
    var now = Date.now();
    var ttl = _c('SHARED_PHRASE_TTL_MS', 120000);
    var maxSize = _c('SHARED_PHRASE_POOL_MAX', 8);
    // Remove expired
    for (var i = _pool.length - 1; i >= 0; i--) {
      if (now - _pool[i].timestamp > ttl) _pool.splice(i, 1);
    }
    // Enforce size cap (remove lowest notability)
    while (_pool.length > maxSize) {
      var minIdx = 0, minScore = _pool[0].notabilityScore;
      for (var j = 1; j < _pool.length; j++) {
        if (_pool[j].notabilityScore < minScore) {
          minScore = _pool[j].notabilityScore;
          minIdx = j;
        }
      }
      _pool.splice(minIdx, 1);
    }
  }

  // ── Signed intervals for contour matching ──
  function _intervals(sdArr) {
    var iv = [];
    for (var i = 1; i < sdArr.length; i++) {
      iv.push(sdArr[i] - sdArr[i - 1]);
    }
    return iv;
  }

  // ── Public API ──

  return {

    // Publish a completed phrase to the shared pool (if notable)
    publish: function(voiceName, phraseData) {
      if (!phraseData || !phraseData.sd || !Array.isArray(phraseData.sd)) return false;

      var minLen = _c('SHARED_PHRASE_MIN_LENGTH', 3);
      var maxLen = _c('SHARED_PHRASE_MAX_LENGTH', 12);
      var cooldown = _c('SHARED_PHRASE_VOICE_COOLDOWN_MS', 5000);
      var threshold = _c('SHARED_PHRASE_NOTABILITY_THRESHOLD', 0.45);

      // Length filter
      if (phraseData.sd.length < minLen) return false;

      // Cooldown: same voice can't flood pool
      var now = Date.now();
      if (_lastPublishTime[voiceName] && (now - _lastPublishTime[voiceName]) < cooldown) {
        return false;
      }

      // Trim to max length
      var sd = phraseData.sd.length > maxLen ? phraseData.sd.slice(0, maxLen) : phraseData.sd.slice();
      var ioi = phraseData.ioi_ratios
        ? (phraseData.ioi_ratios.length > maxLen - 1 ? phraseData.ioi_ratios.slice(0, maxLen - 1) : phraseData.ioi_ratios.slice())
        : null;

      // Get current chord context for harmonic interest scoring
      var chordTones = null;
      try {
        if (typeof HarmonicPlanner !== 'undefined' && HarmonicPlanner.getCurrentChordTones) {
          chordTones = HarmonicPlanner.getCurrentChordTones();
        }
      } catch (e) { /* ok */ }

      // Score notability
      var score = _computeNotability(sd, ioi, voiceName, chordTones);
      if (score < threshold) return false;

      // Duplicate detection: reject if contour similarity > 0.85 with same-voice entry
      for (var i = 0; i < _pool.length; i++) {
        if (_pool[i].sourceVoice === voiceName) {
          if (_contourSimilarity(sd, _pool[i].sd) > 0.85) return false;
        }
      }

      // Get section state
      var section = 'STABLE';
      try {
        if (typeof SectionTracker !== 'undefined') {
          section = SectionTracker.getState().state;
        }
      } catch (e) { /* ok */ }

      // Create shared phrase entry
      var entry = {
        sd: sd,
        ioi_ratios: ioi,
        contour: _parsonsCode(sd),
        intervalProfile: _intervals(sd),
        sourceVoice: voiceName,
        timestamp: now,
        notabilityScore: score,
        section: section,
        harmonicContext: chordTones || [],
        length: sd.length,
        id: 'sp_' + (++_idCounter)
      };

      _pool.push(entry);
      _lastPublishTime[voiceName] = now;
      _prune();

      // Emit event for diagnostics
      if (typeof EventBus !== 'undefined') {
        EventBus.emit('sharedPhrasePublished', {
          voice: voiceName,
          id: entry.id,
          notabilityScore: score,
          poolSize: _pool.length
        });
      }

      return true;
    },

    // Select a shared phrase and adapt it for a specific role
    // Returns { sd, ioi_ratios, sourceVoice, operation } or null
    selectAndAdapt: function(role, sectionState, chordTones) {
      _prune();
      if (_pool.length === 0) return null;

      // Role development preferences
      var ROLE_PREFS = {
        bass:    { ops: ['fragment', 'reharmonize', 'augment'], weights: [0.45, 0.35, 0.20], maxNotes: 4, peerPref: ['soloist', 'lead'] },
        rhythm:  { ops: ['diminish', 'fragment', 'transpose'], weights: [0.40, 0.35, 0.25], maxNotes: 6, peerPref: ['percussion', 'bass'] },
        soloist: { ops: ['invert', 'sequence', 'embellish', 'retrograde'], weights: [0.30, 0.25, 0.25, 0.20], maxNotes: 10, peerPref: ['lead', 'bass'] },
        lead:    { ops: ['sequence', 'transpose', 'invert', 'embellish'], weights: [0.30, 0.25, 0.25, 0.20], maxNotes: 8, peerPref: ['soloist', 'rhythm'] }
      };

      var prefs = ROLE_PREFS[role];
      if (!prefs) return null;

      // Roll against reference probability
      var refProbs = _c('SHARED_PHRASE_REF_PROB', { bass: 0.15, rhythm: 0.20, soloist: 0.25, lead: 0.25 });
      var refProb = refProbs[role] || 0.20;
      if (Math.random() > refProb) return null;

      // Filter: exclude own voice, exclude recently referenced
      var recentRefIds = _recentRefs[role] || [];
      var candidates = [];
      for (var i = 0; i < _pool.length; i++) {
        var p = _pool[i];
        if (p.sourceVoice === role) continue;  // self-voice filter
        if (recentRefIds.indexOf(p.id) >= 0) continue;  // dedup
        candidates.push(p);
      }
      if (candidates.length === 0) return null;

      // Score candidates for this role
      var scored = [];
      for (var j = 0; j < candidates.length; j++) {
        var c = candidates[j];
        var s = c.notabilityScore;
        // Prefer peer preference voices (+0.15 bonus)
        if (prefs.peerPref.indexOf(c.sourceVoice) >= 0) s += 0.15;
        // Prefer cross-section material (+0.10 bonus)
        if (c.section !== sectionState) s += 0.10;
        scored.push({ entry: c, score: s });
      }

      // Weighted random from top 3
      scored.sort(function(a, b) { return b.score - a.score; });
      var top = scored.slice(0, 3);
      var totalW = 0;
      for (var k = 0; k < top.length; k++) totalW += top[k].score;
      var r = Math.random() * totalW;
      var selected = top[0].entry;
      var acc = 0;
      for (var m = 0; m < top.length; m++) {
        acc += top[m].score;
        if (r < acc) { selected = top[m].entry; break; }
      }

      // Track reference for dedup
      if (!_recentRefs[role]) _recentRefs[role] = [];
      _recentRefs[role].push(selected.id);
      if (_recentRefs[role].length > 3) _recentRefs[role].shift();

      // Apply role-appropriate development via MotifDeveloper
      if (typeof MotifDeveloper !== 'undefined') {
        // Feed the selected phrase as a temporary seed
        MotifDeveloper.captureSeed(selected.sd, selected.ioi_ratios, role);

        // Choose operation from role preferences (weighted random)
        var opR = Math.random();
        var opAcc = 0;
        var chosenOp = prefs.ops[0];
        for (var n = 0; n < prefs.ops.length; n++) {
          opAcc += prefs.weights[n];
          if (opR < opAcc) { chosenOp = prefs.ops[n]; break; }
        }

        // Develop the motif
        var developed = MotifDeveloper.develop(role, sectionState, chordTones);
        if (developed && developed.sd && developed.sd.length > 0) {
          // Trim to maxNotes
          if (developed.sd.length > prefs.maxNotes) {
            developed.sd = developed.sd.slice(0, prefs.maxNotes);
            if (developed.ioi_ratios) {
              developed.ioi_ratios = developed.ioi_ratios.slice(0, prefs.maxNotes - 1);
            }
          }
          return {
            sd: developed.sd,
            ioi_ratios: developed.ioi_ratios,
            sourceVoice: selected.sourceVoice,
            operation: chosenOp,
            sourceId: selected.id
          };
        }
      }

      // Fallback: return raw phrase (trimmed) if MotifDeveloper unavailable
      var fallbackSD = selected.sd.slice(0, prefs.maxNotes);
      var fallbackIOI = selected.ioi_ratios
        ? selected.ioi_ratios.slice(0, prefs.maxNotes - 1) : null;
      return {
        sd: fallbackSD,
        ioi_ratios: fallbackIOI,
        sourceVoice: selected.sourceVoice,
        operation: 'raw',
        sourceId: selected.id
      };
    },

    // Get motivic bonus for a candidate phrase (for scoreLexiconEntry)
    // Returns 0 to SHARED_PHRASE_SCORE_BONUS_MAX based on contour similarity
    getMotivicBonus: function(candidateSDs) {
      if (!candidateSDs || candidateSDs.length < 3 || _pool.length === 0) return 0;
      var maxBonus = _c('SHARED_PHRASE_SCORE_BONUS_MAX', 0.08);
      var maxSim = 0;
      for (var i = 0; i < _pool.length; i++) {
        var sim = _contourSimilarity(candidateSDs, _pool[i].sd);
        if (sim > maxSim) maxSim = sim;
      }
      // Only reward moderate similarity (0.4-0.8), not exact copies
      // Sawyer 2003: creative groups balance imitation and innovation
      if (maxSim < 0.4) return 0;
      if (maxSim > 0.85) return maxBonus * 0.3;  // penalize near-copies
      return maxBonus * ((maxSim - 0.4) / 0.45);
    },

    // Get current pool (diagnostics)
    getPool: function() {
      _prune();
      return _pool.slice();
    },

    // Get pool size (quick check)
    getPoolSize: function() {
      return _pool.length;
    },

    // Reset
    reset: function() {
      _pool = [];
      _idCounter = 0;
      _lastPublishTime = {};
      _recentRefs = {};
    }
  };

})();

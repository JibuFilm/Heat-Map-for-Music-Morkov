'use strict';
// ═══ CHORD VOICING MODULE ═══
//
// Produces multi-note voicings from a chord symbol + context.
// Output is pitch classes (0-11) — OctavePlacement handles register.
//
// Voicing styles:
//   shell  — 2 notes (root + guide tone). Sparse, for STABLE/RELEASE.
//   close  — 3-4 notes in close position. Default for BUILD.
//   drop2  — 4 notes with 2nd-from-top dropped conceptually. Rich, for PEAK.
//   open   — 3 notes spread wide (root + 5th + 10th). Spacious.
//
// Voice-leading: minimizes total PC-distance from previous chord.
//
// Depends on: nothing (standalone)
// Load order: after constants.js, before rhythm-assistant.js

var ChordVoicing = (function() {

  // ═══════════════════════════════════════
  // CHORD INTERVAL TABLES
  // ═══════════════════════════════════════

  var INTERVALS = {
    major:  [0, 4, 7],
    minor:  [0, 3, 7],
    dom7:   [0, 4, 7, 10],
    min7:   [0, 3, 7, 10],
    maj7:   [0, 4, 7, 11],
    dim:    [0, 3, 6],
    aug:    [0, 4, 8],
    sus4:   [0, 5, 7],
    sus2:   [0, 2, 7]
  };

  // Guide tones per chord type (for shell voicings)
  // Shell = root + most characteristic interval
  var GUIDE_TONES = {
    major: 4,   // major 3rd defines quality
    minor: 3,   // minor 3rd
    dom7:  10,  // b7 is the dominant sound
    min7:  3,   // minor 3rd
    maj7:  11,  // major 7th
    dim:   6,   // tritone
    aug:   8,   // augmented 5th
    sus4:  5,   // perfect 4th
    sus2:  2    // major 2nd
  };

  // ═══════════════════════════════════════
  // VOICE-LEADING STATE
  // ═══════════════════════════════════════

  var _prevChordPCs = null;

  // ═══════════════════════════════════════
  // VOICING GENERATORS
  // ═══════════════════════════════════════

  function _shell(rootPC, chordType) {
    var guide = GUIDE_TONES[chordType] || 4;
    return [rootPC, (rootPC + guide) % 12];
  }

  function _close(rootPC, chordType) {
    var ivs = INTERVALS[chordType] || INTERVALS.major;
    var pcs = [];
    for (var i = 0; i < ivs.length; i++) {
      pcs.push((rootPC + ivs[i]) % 12);
    }
    return pcs;
  }

  function _drop2(rootPC, chordType) {
    // Drop-2: start with close position, conceptually drop the 2nd-from-top
    // Since we output PCs (not MIDI), we include all tones and let
    // OctavePlacement handle the register spread. The ordering hint
    // (lowest tone first) guides placement.
    var ivs = INTERVALS[chordType] || INTERVALS.major;
    // Ensure we have 4 notes for drop-2 (add 7th if triad)
    if (ivs.length < 4) {
      // Add a 7th: minor 7th for minor/dom7-family, major 7th for major
      var seventh = (chordType === 'major' || chordType === 'maj7') ? 11 : 10;
      ivs = ivs.concat([seventh]);
    }
    var pcs = [];
    for (var i = 0; i < ivs.length; i++) {
      pcs.push((rootPC + ivs[i]) % 12);
    }
    // Reorder: put the 2nd-from-top at the bottom (drop-2 voicing hint)
    if (pcs.length >= 4) {
      var dropped = pcs.splice(pcs.length - 2, 1)[0];
      pcs.unshift(dropped);
    }
    return pcs;
  }

  function _open(rootPC, chordType) {
    // Open voicing: root + 5th + 10th (3rd up an octave)
    // As PCs these are the same as close, but we order them
    // to hint OctavePlacement toward spread
    var fifth = (rootPC + 7) % 12;
    var third = (rootPC + (chordType === 'minor' || chordType === 'min7' ? 3 : 4)) % 12;
    return [rootPC, fifth, third];
  }

  // ═══════════════════════════════════════
  // VOICE-LEADING OPTIMIZATION
  // ═══════════════════════════════════════

  // Minimize total pitch-class distance from previous chord
  function _voiceLead(pcs) {
    if (!_prevChordPCs || _prevChordPCs.length === 0) return pcs;

    // Simple greedy assignment: for each slot in the new chord,
    // find the arrangement that minimizes sum of distances to prev chord.
    // With 2-4 notes, brute-force permutation is fine.
    var best = pcs;
    var bestCost = _totalDistance(pcs, _prevChordPCs);

    var perms = _permutations(pcs);
    for (var i = 0; i < perms.length; i++) {
      var cost = _totalDistance(perms[i], _prevChordPCs);
      if (cost < bestCost) {
        bestCost = cost;
        best = perms[i];
      }
    }

    return best;
  }

  function _totalDistance(a, b) {
    var cost = 0;
    var len = Math.min(a.length, b.length);
    for (var i = 0; i < len; i++) {
      var d = Math.abs(a[i] - b[i]);
      if (d > 6) d = 12 - d;  // shortest path on pitch-class circle
      cost += d;
    }
    // Penalty for extra notes (new chord has more tones than prev)
    cost += Math.abs(a.length - b.length) * 3;
    return cost;
  }

  function _permutations(arr) {
    if (arr.length <= 1) return [arr];
    if (arr.length === 2) return [arr, [arr[1], arr[0]]];
    // For 3-4 elements, generate all permutations
    var result = [];
    for (var i = 0; i < arr.length; i++) {
      var rest = arr.slice(0, i).concat(arr.slice(i + 1));
      var subPerms = _permutations(rest);
      for (var j = 0; j < subPerms.length; j++) {
        result.push([arr[i]].concat(subPerms[j]));
      }
    }
    return result;
  }

  // ═══════════════════════════════════════
  // STYLE SELECTION BY SECTION STATE
  // ═══════════════════════════════════════

  function _pickStyle(sectionState) {
    switch (sectionState) {
      case 'PEAK':       return 'drop2';
      case 'BUILD':      return 'close';
      case 'RELEASE':    return 'shell';
      case 'TRANSITION': return 'shell';
      default:           return 'close';  // STABLE
    }
  }

  // ═══════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════

  function voiceChord(rootPC, chordType, style, context) {
    if (rootPC === null || rootPC === undefined) return null;
    chordType = chordType || 'major';
    context = context || {};

    // Auto-select style from section state if not specified
    if (!style) {
      var secState = 'STABLE';
      try {
        if (typeof SectionTracker !== 'undefined') {
          secState = SectionTracker.getState().state;
        }
      } catch (e) {}
      style = _pickStyle(secState);
    }

    // Generate raw voicing
    var pcs;
    switch (style) {
      case 'shell': pcs = _shell(rootPC, chordType); break;
      case 'drop2': pcs = _drop2(rootPC, chordType); break;
      case 'open':  pcs = _open(rootPC, chordType); break;
      default:      pcs = _close(rootPC, chordType); break;
    }

    // Apply voice-leading
    pcs = _voiceLead(pcs);

    // Rootless voicing: omit root PC when bass is providing it
    // Plomp & Levelt 1965: two voices sounding same PC in adjacent registers create roughness
    if (context.omitRoot && pcs.length > 2) {
      var rootMod = rootPC % 12;
      pcs = pcs.filter(function(pc) { return (pc % 12) !== rootMod; });
      // Ensure at least 2 notes remain
      if (pcs.length < 2) pcs = _voiceLead(_close(rootPC, chordType)).slice(1);
    }

    // Store for next voice-leading pass
    _prevChordPCs = pcs.slice();

    return pcs;
  }

  function reset() {
    _prevChordPCs = null;
  }

  return {
    voiceChord: voiceChord,
    INTERVALS:  INTERVALS,
    reset:      reset
  };

})();

console.log('%cChordVoicing loaded (shell/close/drop2/open)', 'color:#8cf;font-family:monospace');

'use strict';
// ═══ MOTIF DEVELOPER (Phase B — Hierarchical Prediction) ═══
//
// Transforms seed motifs using classical development techniques.
// Provides coherent variety — material sounds related but not identical.
//
// Seeds come from: recent assistant output, human input, or lexicon phrases.
// Operations: transpose, invert, retrograde, augment, diminish, fragment,
//             sequence, embellish, reharmonize.
//
// Selection is always weighted-random by section state, never argmax.
//
// Depends on: constants.js (SCALES, getScale), prediction-engine.js (SharedState)
// Load order: after constants.js + prediction-engine.js, before assistant files.

var MotifDeveloper = (function() {

  // ── Seed storage: up to MOTIF_SEED_MAX per role ──
  var seeds = { bass: [], rhythm: [], soloist: [], lead: [] };

  var SEED_MAX = (typeof MOTIF_SEED_MAX !== 'undefined') ? MOTIF_SEED_MAX : 3;
  var SEED_EXPIRY = (typeof MOTIF_SEED_EXPIRY_MS !== 'undefined') ? MOTIF_SEED_EXPIRY_MS : 30000;
  var SEED_LEN_MIN = (typeof DEVELOPMENT_SEED_LENGTH !== 'undefined') ? DEVELOPMENT_SEED_LENGTH[0] : 3;
  var SEED_LEN_MAX = (typeof DEVELOPMENT_SEED_LENGTH !== 'undefined') ? DEVELOPMENT_SEED_LENGTH[1] : 6;

  // ══════════════════════════════════════
  // SEED MANAGEMENT
  // ══════════════════════════════════════

  function captureSeed(sd, ioiRatios, role) {
    if (!sd || sd.length < SEED_LEN_MIN) return;
    if (!seeds[role]) return;

    // Trim to max seed length
    var trimmedSd = sd.slice(0, SEED_LEN_MAX);
    var trimmedIoi = ioiRatios ? ioiRatios.slice(0, Math.max(trimmedSd.length - 1, 1)) : _defaultIoi(trimmedSd.length);

    seeds[role].unshift({
      sd: trimmedSd,
      ioi_ratios: trimmedIoi,
      role: role,
      timestamp: Date.now()
    });

    // Cap stored seeds
    if (seeds[role].length > SEED_MAX) {
      seeds[role].length = SEED_MAX;
    }
  }

  // v2.4: Cross-role motif sharing (~25% reference rate from Weimar Jazz Database)
  var CROSS_ROLE_PROBABILITY = 0.25;

  // Contour filter: average interval magnitude thresholds per role
  var ROLE_MAX_AVG_INTERVAL = { bass: 4, rhythm: 5, soloist: 7 };

  function _avgIntervalMagnitude(sdArr) {
    if (!sdArr || sdArr.length < 2) return 0;
    var sum = 0;
    for (var i = 1; i < sdArr.length; i++) {
      var diff = Math.abs(sdArr[i] - sdArr[i - 1]);
      if (diff > 6) diff = 12 - diff;  // shortest path around pitch class circle
      sum += diff;
    }
    return sum / (sdArr.length - 1);
  }

  function _getFreshestSeed(role) {
    var now = Date.now();
    var arr = seeds[role];
    if (!arr) return null;

    // Prune expired
    for (var i = arr.length - 1; i >= 0; i--) {
      if (now - arr[i].timestamp > SEED_EXPIRY) arr.splice(i, 1);
    }

    // v8.8.0: Cross-voice borrowing via SharedPhraseMemory (replaces random 25% borrowing)
    // Quality-gated, role-appropriate, stigmergic (Pressing 1999)
    if (arr.length === 0 || Math.random() < CROSS_ROLE_PROBABILITY) {
      if (typeof SharedPhraseMemory !== 'undefined') {
        var section = 'STABLE';
        try { if (typeof SectionTracker !== 'undefined') section = SectionTracker.getState().state; } catch(e) {}
        var chordTones = null;
        try { if (typeof HarmonicPlanner !== 'undefined' && HarmonicPlanner.getCurrentChordTones) chordTones = HarmonicPlanner.getCurrentChordTones(); } catch(e) {}
        var shared = SharedPhraseMemory.selectAndAdapt(role, section, chordTones);
        if (shared && shared.sd && shared.sd.length >= 2) {
          return {
            sd: shared.sd,
            ioi_ratios: shared.ioi_ratios || _defaultIoi(shared.sd.length),
            role: role,
            timestamp: Date.now(),
            _borrowedFrom: shared.sourceVoice,
            _sharedOp: shared.operation
          };
        }
      }

      // Fallback: legacy cross-role borrowing if SharedPhraseMemory unavailable
      var otherRoles = Object.keys(seeds).filter(function(r) { return r !== role && seeds[r].length > 0; });
      for (var oi = 0; oi < otherRoles.length; oi++) {
        var otherArr = seeds[otherRoles[oi]];
        for (var oj = otherArr.length - 1; oj >= 0; oj--) {
          if (now - otherArr[oj].timestamp > SEED_EXPIRY) otherArr.splice(oj, 1);
        }
      }
      otherRoles = otherRoles.filter(function(r) { return seeds[r].length > 0; });
      if (otherRoles.length > 0) {
        var borrowRole = otherRoles[Math.floor(Math.random() * otherRoles.length)];
        var candidate = seeds[borrowRole][0];
        var avgInt = _avgIntervalMagnitude(candidate.sd);
        var maxAvg = ROLE_MAX_AVG_INTERVAL[role] || 7;
        if (avgInt <= maxAvg) {
          var borrowed = JSON.parse(JSON.stringify(candidate));
          borrowed._borrowedFrom = borrowRole;
          return borrowed;
        }
      }
    }

    return arr.length > 0 ? arr[0] : null;
  }

  function _defaultIoi(len) {
    var r = [];
    for (var i = 0; i < Math.max(len - 1, 1); i++) r.push(1.0);
    return r;
  }

  // ══════════════════════════════════════
  // DEVELOPMENT OPERATIONS
  // ══════════════════════════════════════

  function transpose(seed, interval) {
    var sd = [];
    for (var i = 0; i < seed.sd.length; i++) {
      sd.push(((seed.sd[i] + interval) % 12 + 12) % 12);
    }
    return { sd: sd, ioi_ratios: seed.ioi_ratios.slice() };
  }

  function invert(seed, axis) {
    var sd = [seed.sd[0]];
    for (var i = 1; i < seed.sd.length; i++) {
      var interval = seed.sd[i] - seed.sd[i - 1];
      var inverted = -interval;
      var prev = sd[sd.length - 1];
      sd.push(((prev + inverted) % 12 + 12) % 12);
    }
    // Transpose so first note aligns with axis
    var offset = ((axis - sd[0]) % 12 + 12) % 12;
    for (var j = 0; j < sd.length; j++) {
      sd[j] = (sd[j] + offset) % 12;
    }
    return { sd: sd, ioi_ratios: seed.ioi_ratios.slice() };
  }

  function retrograde(seed) {
    var sd = seed.sd.slice().reverse();
    return { sd: sd, ioi_ratios: seed.ioi_ratios.slice() };
  }

  function augment(seed, factor) {
    var f = factor || 1.5;
    var ioi = [];
    for (var i = 0; i < seed.ioi_ratios.length; i++) {
      ioi.push(seed.ioi_ratios[i] * f);
    }
    return { sd: seed.sd.slice(), ioi_ratios: ioi };
  }

  function diminish(seed, factor) {
    var f = factor || 0.5;
    var ioi = [];
    for (var i = 0; i < seed.ioi_ratios.length; i++) {
      ioi.push(seed.ioi_ratios[i] * f);
    }
    return { sd: seed.sd.slice(), ioi_ratios: ioi };
  }

  function fragment(seed, n) {
    var count = n || Math.floor(Math.random() * 3) + 2; // 2-4
    count = Math.min(count, seed.sd.length);
    return {
      sd: seed.sd.slice(0, count),
      ioi_ratios: seed.ioi_ratios.slice(0, Math.max(count - 1, 1))
    };
  }

  function sequence(seed, steps, direction) {
    var dir = direction || 1; // +1 ascending, -1 descending
    var numSteps = steps || 2;
    var sd = [];
    var ioi = [];

    // Diatonic step size — use 2 semitones (whole step) as default
    var stepSize = 2 * dir;

    for (var s = 0; s <= numSteps; s++) {
      var offset = stepSize * s;
      for (var i = 0; i < seed.sd.length; i++) {
        sd.push(((seed.sd[i] + offset) % 12 + 12) % 12);
      }
      // IOI between repetitions: use the seed's IOIs, plus a gap ratio of 1.0 between repeats
      for (var j = 0; j < seed.ioi_ratios.length; j++) {
        ioi.push(seed.ioi_ratios[j]);
      }
      if (s < numSteps) {
        ioi.push(1.0); // gap between sequence repetitions
      }
    }

    return { sd: sd, ioi_ratios: ioi };
  }

  function embellish(seed) {
    var sd = [seed.sd[0]];
    var ioi = [];
    var scale = getScale(SharedState.keyC, SharedState.mode);
    var scaleSet = {};
    for (var s = 0; s < scale.length; s++) scaleSet[scale[s]] = true;

    for (var i = 1; i < seed.sd.length; i++) {
      var interval = ((seed.sd[i] - seed.sd[i - 1]) + 12) % 12;
      if (interval > 6) interval = interval - 12; // signed
      var absInt = Math.abs(interval);
      var origIoi = seed.ioi_ratios[i - 1] || 1.0;

      // 50% chance to insert passing tone if interval > 2 semitones
      if (absInt > 2 && Math.random() < 0.5) {
        // Find a scale degree between the two notes
        var midSd = ((seed.sd[i - 1] + seed.sd[i]) / 2 + 12) % 12;
        midSd = Math.round(midSd) % 12;
        // Snap to scale
        if (!scaleSet[midSd]) {
          for (var off = 1; off <= 3; off++) {
            if (scaleSet[(midSd + off) % 12]) { midSd = (midSd + off) % 12; break; }
            if (scaleSet[((midSd - off) + 12) % 12]) { midSd = ((midSd - off) + 12) % 12; break; }
          }
        }
        sd.push(midSd);
        sd.push(seed.sd[i]);
        // Split IOI proportionally
        ioi.push(origIoi * 0.5);
        ioi.push(origIoi * 0.5);
      } else {
        sd.push(seed.sd[i]);
        ioi.push(origIoi);
      }
    }

    return { sd: sd, ioi_ratios: ioi };
  }

  function reharmonize(seed, targetChordTones) {
    if (!targetChordTones || targetChordTones.length === 0) {
      return { sd: seed.sd.slice(), ioi_ratios: seed.ioi_ratios.slice() };
    }
    var sd = [];
    for (var i = 0; i < seed.sd.length; i++) {
      var note = seed.sd[i];
      // Check if already a chord tone
      var isChordTone = false;
      for (var c = 0; c < targetChordTones.length; c++) {
        if (note === targetChordTones[c]) { isChordTone = true; break; }
      }
      if (isChordTone) {
        sd.push(note);
      } else {
        // Snap to nearest chord tone
        var best = targetChordTones[0];
        var bestDist = 12;
        for (var d = 0; d < targetChordTones.length; d++) {
          var dist = Math.min(
            Math.abs(note - targetChordTones[d]),
            12 - Math.abs(note - targetChordTones[d])
          );
          if (dist < bestDist) { bestDist = dist; best = targetChordTones[d]; }
        }
        sd.push(best);
      }
    }
    return { sd: sd, ioi_ratios: seed.ioi_ratios.slice() };
  }

  // ══════════════════════════════════════
  // OPERATION SELECTION (weighted random by section state)
  // ══════════════════════════════════════

  var operationWeights = {
    STABLE:     { fragment: 3, transpose: 2, augment: 1 },
    BUILD:      { sequence: 4, transpose: 3, diminish: 2, embellish: 1 },
    PEAK:       { invert: 3, embellish: 3, retrograde: 2, sequence: 1 },
    RELEASE:    { augment: 3, fragment: 2, retrograde: 1, reharmonize: 2 },
    TRANSITION: { fragment: 2, transpose: 1 }
  };

  var operationFns = {
    transpose:   function(seed, ctx) {
      // Choose interval from chord tones or random scale interval
      var intervals = ctx.targetChordTones && ctx.targetChordTones.length > 0
        ? ctx.targetChordTones
        : [2, 3, 4, 5, 7];
      var interval = intervals[Math.floor(Math.random() * intervals.length)];
      return transpose(seed, interval);
    },
    invert:      function(seed, ctx) {
      var axis = seed.sd[0]; // invert around first note
      return invert(seed, axis);
    },
    retrograde:  function(seed) { return retrograde(seed); },
    augment:     function(seed) { return augment(seed, Math.random() < 0.5 ? 1.5 : 2.0); },
    diminish:    function(seed) { return diminish(seed, Math.random() < 0.5 ? 0.5 : 0.75); },
    fragment:    function(seed) { return fragment(seed); },
    sequence:    function(seed, ctx) {
      var dir = (ctx.sectionState === 'BUILD') ? 1 : (Math.random() < 0.5 ? 1 : -1);
      var steps = Math.random() < 0.6 ? 2 : 3;
      return sequence(seed, steps, dir);
    },
    embellish:   function(seed) { return embellish(seed); },
    reharmonize: function(seed, ctx) {
      return reharmonize(seed, ctx.targetChordTones || [0, 4, 7]);
    }
  };

  function _weightedRandom(weights) {
    var keys = Object.keys(weights);
    var total = 0;
    for (var i = 0; i < keys.length; i++) total += weights[keys[i]];
    if (total === 0) return keys[0];

    var r = Math.random() * total;
    var cum = 0;
    for (var j = 0; j < keys.length; j++) {
      cum += weights[keys[j]];
      if (r < cum) return keys[j];
    }
    return keys[keys.length - 1];
  }

  // ══════════════════════════════════════
  // SCALE SNAP (local — uses getScale from constants.js)
  // ══════════════════════════════════════

  function _scaleSnapAll(sdArr) {
    var scale = getScale(SharedState.keyC, SharedState.mode);
    var scaleSet = {};
    for (var s = 0; s < scale.length; s++) scaleSet[scale[s]] = true;

    var result = [];
    for (var i = 0; i < sdArr.length; i++) {
      var pc = sdArr[i] % 12;
      if (scaleSet[pc]) {
        result.push(pc);
      } else {
        // Snap to nearest scale tone
        for (var off = 1; off <= 6; off++) {
          if (scaleSet[(pc + off) % 12]) { result.push((pc + off) % 12); break; }
          if (scaleSet[((pc - off) + 12) % 12]) { result.push(((pc - off) + 12) % 12); break; }
        }
      }
    }
    return result;
  }

  // ══════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════

  function develop(role, sectionState, targetChordTones) {
    var seed = _getFreshestSeed(role);
    if (!seed) return null;

    var state = sectionState || 'STABLE';
    var weights = operationWeights[state] || operationWeights.STABLE;

    var ctx = {
      sectionState: state,
      targetChordTones: targetChordTones || []
    };

    var result;

    // v2.4: Always transpose borrowed motifs first to fit borrowing role's register
    if (seed._borrowedFrom) {
      result = operationFns.transpose(seed, ctx);
    } else {
      var opName = _weightedRandom(weights);
      var opFn = operationFns[opName];
      if (!opFn) return null;
      result = opFn(seed, ctx);
    }
    if (!result || !result.sd || result.sd.length === 0) return null;

    // Scale-snap all resulting SDs
    result.sd = _scaleSnapAll(result.sd);

    // Ensure IOI ratios match note count
    while (result.ioi_ratios.length < result.sd.length - 1) {
      result.ioi_ratios.push(1.0);
    }
    result.ioi_ratios = result.ioi_ratios.slice(0, Math.max(result.sd.length - 1, 1));

    return result;
  }

  function hasSeed(role) {
    var seed = _getFreshestSeed(role);
    return seed !== null;
  }

  function reset() {
    seeds.bass = [];
    seeds.rhythm = [];
    seeds.soloist = [];
  }

  return {
    captureSeed: captureSeed,
    develop: develop,
    hasSeed: hasSeed,
    reset: reset
  };

})();

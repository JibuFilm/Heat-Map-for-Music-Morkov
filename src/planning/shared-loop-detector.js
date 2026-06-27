'use strict';
// STATUS: Research infrastructure — retained but not actively consumed by tier cascade (v2.4)
// Loop detection output is available via SharedLoopDetector API but tier1_liveLoop
// is commented out in all assistants.
// ═══ SHARED LOOP DETECTOR (Phase 5B) ═══
//
// Detects repeating patterns that span multiple registers.
// A walking bass + chord vamp is invisible to per-assistant detection
// because each assistant only sees its own register. This module
// observes ALL human notes in a single interleaved buffer and finds
// patterns in the combined (register, pc) stream.
//
// When a cross-register pattern is detected, it decomposes into
// per-register sequences. Each assistant queries getLoop(register)
// and gets back a PC sequence + confidence. Assistants use this
// as a higher-priority loop source: if shared confidence > own
// confidence, use the shared pattern.
//
// Only fires for genuinely cross-register patterns (notes from 2+
// registers). Single-register patterns are left to per-assistant
// detection which has role-specific persistence tuning.
//
// Wiring (app.js onNoteInput):
//   SharedLoopDetector.observeNote(pc, register, time)
//
// Script load order: after event-bus, before context-integrator.

var SharedLoopDetector = (function() {

  // ── Combined buffer ──
  // Interleaved human notes from all registers.
  // Encoded as register*12 + pc for autocorrelation (ensures bass:C ≠ rhythm:C).
  var buffer = [];       // [{pc, register, encoded, time}]
  var BUFFER_MAX = 48;   // longer than per-assistant (32) — needs more data for cross-register

  // ── Detected loops per register ──
  var loops = {
    bass:   null,  // {pcs: [...], confidence: N} or null
    rhythm: null,
    soloist: null
  };
  var combinedConfidence = 0;  // confidence of the combined pattern
  var combinedLength = 0;      // length of the detected combined loop
  var registerCount = 0;       // how many registers are in the detected pattern

  // Register encoding/decoding
  var REG_MAP = { bass: 0, rhythm: 1, soloist: 2 };
  function encode(pc, register) {
    return (REG_MAP[register] || 0) * 12 + pc;
  }

  // ── Observe a human note ──
  function observeNote(pc, register, time) {
    time = time || Date.now();
    buffer.push({
      pc: pc,
      register: register,
      encoded: encode(pc, register),
      time: time
    });
    if (buffer.length > BUFFER_MAX) buffer.shift();

    // Run detection after enough data accumulates
    if (buffer.length >= 8) detectLoop();
  }

  // ── Autocorrelation on encoded (register, pc) tuples ──
  function detectLoop() {
    var n = buffer.length;
    var encoded = [];
    for (var i = 0; i < n; i++) encoded.push(buffer[i].encoded);

    var bestLag = 0, bestCorr = 0;

    // Search for repeating patterns of length 3–20
    for (var lag = 3; lag <= Math.min(20, Math.floor(n / 2)); lag++) {
      var matches = 0, total = 0;
      for (var i = 0; i < n - lag; i++) {
        if (encoded[i] === encoded[i + lag]) matches++;
        total++;
      }
      var corr = total > 0 ? matches / total : 0;
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }

    // Higher threshold than per-assistant (0.65) — cross-register patterns
    // need stronger evidence because the interleaved stream is noisier.
    if (bestCorr > 0.65 && bestLag >= 3) {
      var pattern = buffer.slice(-bestLag);

      // Check: is this actually cross-register?
      var regs = {};
      for (var i = 0; i < pattern.length; i++) {
        regs[pattern[i].register] = true;
      }
      var regNames = Object.keys(regs);

      if (regNames.length < 2) {
        // Single-register pattern — leave to per-assistant detection
        decayLoops();
        return;
      }

      // Decompose into per-register sequences
      combinedConfidence = bestCorr;
      combinedLength = bestLag;
      registerCount = regNames.length;

      for (var r = 0; r < regNames.length; r++) {
        var reg = regNames[r];
        var pcs = [];
        for (var i = 0; i < pattern.length; i++) {
          if (pattern[i].register === reg) pcs.push(pattern[i].pc);
        }
        if (pcs.length > 0) {
          loops[reg] = { pcs: pcs, confidence: bestCorr };
        }
      }

      // Clear loops for registers not in the pattern
      var allRegs = ['bass', 'rhythm', 'soloist'];
      for (var i = 0; i < allRegs.length; i++) {
        if (!regs[allRegs[i]]) loops[allRegs[i]] = null;
      }
    } else {
      decayLoops();
    }
  }

  // ── Confidence decay ──
  function decayLoops() {
    combinedConfidence *= 0.95;
    if (combinedConfidence < 0.2) {
      loops.bass = null;
      loops.rhythm = null;
      loops.soloist = null;
      combinedConfidence = 0;
      combinedLength = 0;
      registerCount = 0;
    } else {
      // Decay per-register confidence in sync
      for (var reg in loops) {
        if (loops[reg]) {
          loops[reg].confidence = combinedConfidence;
        }
      }
    }
  }

  // ── Public: get loop for a register ──
  // Returns {pcs: [...], confidence: N} or null.
  // Assistants compare this with their own loopConfidence:
  //   if (shared.confidence > ownConfidence) use shared
  function getLoop(register) {
    return loops[register] || null;
  }

  function getCombinedConfidence() {
    return combinedConfidence;
  }

  function getCombinedLength() {
    return combinedLength;
  }

  function getRegisterCount() {
    return registerCount;
  }

  function reset() {
    buffer = [];
    loops = { bass: null, rhythm: null, soloist: null };
    combinedConfidence = 0;
    combinedLength = 0;
    registerCount = 0;
  }

  return {
    observeNote:            observeNote,
    getLoop:                getLoop,
    getCombinedConfidence:  getCombinedConfidence,
    getCombinedLength:      getCombinedLength,
    getRegisterCount:       getRegisterCount,
    reset:                  reset
  };

})();

'use strict';
// ═══ TENSION LAYER (zero-style-bias build) ═══════════════════════════════════
// Functional harmony only FEELS harmonic through tension ↔ resolution. With the
// lexicon stripped, the corpus's implicit dissonance (dominant tritones,
// suspensions, passing tones) disappeared, leaving inert consonant agreement —
// "harmonic on paper, dead in the ear." This layer makes tension EXPLICIT and
// belief-driven: the section's adventurousness raises tension; resolutionUrgency
// (an approaching cadence) forces a clean landing. It transforms the pitch-class
// a voice is about to play, just before octave placement.
//
//   Tension.apply(pc, voiceName) -> pc'
//
// Tunable live:  window.TENSION = { on:true, dom:1.0, susp:0.6 }
//   dom  — strength of the dominant lean (V sounds its leading-tone 3rd + b7 = tritone)
//   susp — frequency of 4–3 suspensions on inner voices (whole/half-step appoggiatura)
var Tension = (function () {
  var pend = {};      // per-voice pending resolution pc (suspension → release next emit)
  var counter = {};   // per-voice emit counter (deterministic suspension cadence)

  function cfg() { return window.TENSION || (window.TENSION = { on: true, dom: 1.0, susp: 0.6 }); }

  function apply(pc, voiceName) {
    var T = cfg();
    // bass holds the functional root (the anchor tension resolves against); human is never altered
    if (!T.on || voiceName === 'bass' || voiceName === 'human') return pc;

    var cc = (typeof SharedState !== 'undefined') ? SharedState.currentChord : null;
    if (!cc || cc.rootPC == null) return pc;

    var root = cc.rootPC, minor = (cc.type === 'minor');
    var keyC = (typeof SharedState !== 'undefined' && SharedState.keyC != null) ? SharedState.keyC : 0;
    var third  = (root + (minor ? 3 : 4)) % 12;
    var b7     = (root + 10) % 12;
    var fourth = (root + 5) % 12;

    var adv = 0, resUrg = 0;
    try {
      if (typeof SectionTracker !== 'undefined') {
        var s = SectionTracker.getState();
        adv = s.adventurousness || 0; resUrg = s.resolutionUrgency || 0;
      }
    } catch (e) {}
    var cadence = resUrg > 0.6;   // near a cadence → keep the landing consonant

    // (0) RELEASE — resolve any pending suspension for this voice first.
    if (pend[voiceName] != null) { var r = pend[voiceName]; pend[voiceName] = null; return r; }

    // (1) DOMINANT TRITONE — when the chord sits on scale-degree 5 (a fifth above
    //     the key), make it FUNCTION as a dominant regardless of how the grammar
    //     labelled it: sound the MAJOR third (= the key's leading tone, raised in
    //     minor) and the b7. That tritone is what actually PULLS toward I.
    var isV = (((root - keyC + 12) % 12) === 7);
    if (isV && T.dom > 0 && !cadence) {
      var leadingThird = (root + 4) % 12;   // major 3rd of V = key's leading tone
      return (voiceName === 'soloist' || voiceName === 'lead') ? leadingThird : b7;
    }

    // (2) SUSPENSION (4–3) — an inner voice sounds the 4th (dissonant against the
    //     chord) and resolves DOWN to the 3rd on its next emission. Density rises
    //     with adventurousness; suppressed at cadence so resolutions stay clean.
    if ((voiceName === 'rhythm' || voiceName === 'lead') && T.susp > 0 && !cadence) {
      counter[voiceName] = (counter[voiceName] || 0) + 1;
      var every = Math.max(2, Math.round(4 - 2 * Math.min(1, adv) * T.susp));
      if (counter[voiceName] % every === 0) {
        pend[voiceName] = third;   // schedule the resolution (the release)
        return fourth;             // play the suspension now (the tension)
      }
    }
    return pc;
  }

  return { apply: apply };
})();

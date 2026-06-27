'use strict';
// ═══ PHRASE GENERATOR (Gen3 Phase 4.5) ═══
// Generative phrase layer — constructs novel, mode-invariant phrases from
// statistical distributions learned from the lexicon.
//
// Sits between lexicon retrieval (Tier 2) and PPM fallback (Tier 3).
// When the lexicon can't provide a well-fitting phrase for the current
// scale/mode, the generator constructs one that is in-scale by design.
//
// Output format matches lexicon entries — callers (assistants, Scheduler)
// don't need to know whether a phrase was retrieved or generated.
//
// Depends on: constants.js (SCALES, getScale, getGenreConfig)
// Load order: after constants.js, before assistant files.

var PhraseGenerator = (function() {

  // v9.2.0: Inlined from harmonic-function.js (module deleted — only this function was used).
  // Voice-leading cost: evaluates melodic cost of moving between PCs per voice role.
  // Lower = better. Based on common-practice voice-leading principles.
  function _voiceLeadingCost(fromPC, toPC, voiceRole) {
    if (fromPC < 0 || toPC < 0) return 0;
    var interval = ((toPC - fromPC) % 12 + 12) % 12;
    var cost = 0;
    if (voiceRole === 'bass' && interval !== 0 && interval !== 5 && interval !== 7) {
      if (interval === 6) cost += 0.08;
      else if (interval === 1 || interval === 11) cost -= 0.04;
      else if (interval === 2 || interval === 10) cost -= 0.02;
    }
    if (interval === 1 || interval === 11) cost -= 0.06;
    return cost;
  }

  // ══════════════════════════════════════
  // V7 Phase 8C: Harmonic Direction
  // ══════════════════════════════════════
  // Maps predicted chord arrivals to note positions in a phrase.
  // Returns a sparse array: harmonicTargets[notePosition] = {chordTones, confidence}
  // or null if no predictions available.
  function computeHarmonicTargets(nextChords, phraseLen, bpm) {
    if (!nextChords || nextChords.length === 0 || phraseLen < 3) return null;

    var targets = {};
    var msPerBeat = 60000 / Math.max(30, bpm || 120);

    for (var ci = 0; ci < nextChords.length; ci++) {
      var chord = nextChords[ci];
      if (!chord || chord.confidence < 0.08) continue;  // ignore very low confidence

      // Map beatsAway to a note position in the phrase
      // Assume roughly even note spacing across the phrase
      var targetPos = Math.round(chord.beatsAway * phraseLen / 8);  // 8 beats ≈ 2 bars typical
      targetPos = Math.max(1, Math.min(phraseLen - 1, targetPos));

      // Chord tones for this prediction
      var root = chord.rootPC;
      var third = (root + (chord.type === 'minor' ? 3 : 4)) % 12;
      var fifth = (root + 7) % 12;

      targets[targetPos] = {
        chordTones: [root, third, fifth],
        confidence: chord.confidence
      };

      // Approach zone: 1-2 positions before target
      if (targetPos > 1 && !targets[targetPos - 1]) {
        targets[targetPos - 1] = {
          approachTones: [(root + 11) % 12, (root + 1) % 12],  // semitone below and above root
          confidence: chord.confidence
        };
      }
    }

    return Object.keys(targets).length > 0 ? targets : null;
  }

  // ══════════════════════════════════════
  // LEARNED MODELS (per role)
  // ══════════════════════════════════════

  var models = {
    bass:   null,
    rhythm: null,
    soloist: null,
    lead:   null
  };

  // ── Model structure (v9.3.0: Markov chains removed, PPM-backed generation) ──
  // {
  //   startDegree:     [count × 12]  — chromatic SD start distribution
  //   intervalDist:    [count × 13]  — interval magnitudes 0..12 (absolute)
  //   lengthDist:      [count × 20]  — phrase lengths 2..20
  //   ioiTemplates:    [{ ratios: [...], weight: N, len: N }, ...]
  //   totalPhrases:    N
  //   avgInterval:     N  — mean absolute interval in corpus (for Schellenberg proximity)
  // }

  // ══════════════════════════════════════
  // LEARN FROM LEXICON
  // ══════════════════════════════════════

  function learnFromLexicon(entries, role) {
    if (!entries || entries.length === 0) {
      models[role] = null;
      return;
    }

    // v9.3.0: Markov chains removed — PPM (SharedState.predict) handles note-sequence
    // prediction. Only statistical distributions needed for phrase structure.
    var startDegree = new Array(12).fill(0);
    var intervalDist = new Array(13).fill(0);  // magnitudes 0-12
    var lengthDist = new Array(21).fill(0);    // lengths 0-20
    var ioiRaw = [];         // collect all IOI ratio sequences for clustering
    var totalPhrases = 0;
    var totalIntervals = 0;
    var sumAbsInterval = 0;  // for computing mean interval (Schellenberg proximity)

    for (var e = 0; e < entries.length; e++) {
      var entry = entries[e];
      if (!entry.sd || entry.sd.length < 2) continue;
      totalPhrases++;

      var sd = entry.sd;
      var len = Math.min(sd.length, 20);

      // Length distribution
      lengthDist[len]++;

      // Start degree
      var startSD = ((sd[0] % 12) + 12) % 12;
      startDegree[startSD]++;

      // Interval statistics (for avgInterval — used by scoreCandidate)
      for (var i = 1; i < sd.length; i++) {
        var absMag = Math.min(Math.abs(sd[i] - sd[i - 1]), 12);
        intervalDist[absMag]++;
        sumAbsInterval += absMag;
        totalIntervals++;
      }

      // Collect IOI ratios for template clustering
      if (entry.ioi_ratios && entry.ioi_ratios.length > 0) {
        ioiRaw.push({
          ratios: entry.ioi_ratios.slice(),
          len: entry.ioi_ratios.length
        });
      }
    }

    // ── Cluster IOI patterns into templates ──
    var ioiTemplates = clusterIOITemplates(ioiRaw);

    models[role] = {
      startDegree: startDegree,
      intervalDist: intervalDist,
      lengthDist: lengthDist,
      ioiTemplates: ioiTemplates,
      totalPhrases: totalPhrases,
      avgInterval: totalIntervals > 0 ? sumAbsInterval / totalIntervals : 2.5
    };

    console.log('PhraseGenerator: learned ' + role + ' from ' + totalPhrases +
      ' phrases (' + ioiTemplates.length + ' IOI templates)');
  }

  // ── IOI template clustering ──
  // Groups IOI ratio sequences by similarity into archetypes.
  // Uses a simple approach: normalize each sequence to unit length,
  // compute variance from 1.0 (evenness), and bucket into categories.
  function clusterIOITemplates(ioiRaw) {
    if (ioiRaw.length === 0) {
      // Default templates when no IOI data in lexicon
      return [
        { ratios: [1.0], weight: 1.0, label: 'even' },
        { ratios: [1.5, 0.5], weight: 0.3, label: 'dotted' },
        { ratios: [0.67, 0.67, 0.67], weight: 0.2, label: 'triplet' },
        { ratios: [1.2, 0.8], weight: 0.3, label: 'rubato' }
      ];
    }

    // Categorize by variance from even (1.0)
    var even = [];      // CV < 0.05
    var slight = [];    // CV 0.05-0.15
    var grooved = [];   // CV 0.15-0.40
    var syncopated = []; // CV > 0.40

    for (var i = 0; i < ioiRaw.length; i++) {
      var r = ioiRaw[i].ratios;
      var mean = r.reduce(function(a, b) { return a + b; }, 0) / r.length;
      var variance = r.reduce(function(a, b) { return a + (b - mean) * (b - mean); }, 0) / r.length;
      var cv = mean > 0 ? Math.sqrt(variance) / mean : 0;

      if (cv < 0.05) even.push(r);
      else if (cv < 0.15) slight.push(r);
      else if (cv < 0.40) grooved.push(r);
      else syncopated.push(r);
    }

    var templates = [];

    // Pick representative from each category (median by length)
    function addTemplate(bucket, label, minWeight) {
      if (bucket.length === 0) return;
      // Sort by length, pick middle
      bucket.sort(function(a, b) { return a.length - b.length; });
      var rep = bucket[Math.floor(bucket.length / 2)];
      templates.push({
        ratios: rep,
        weight: bucket.length / ioiRaw.length + minWeight,
        label: label
      });
      // If we have enough, add a second representative at different length
      if (bucket.length >= 6) {
        var rep2 = bucket[Math.floor(bucket.length / 4)];
        if (rep2.length !== rep.length) {
          templates.push({
            ratios: rep2,
            weight: (bucket.length / ioiRaw.length) * 0.5,
            label: label + '_alt'
          });
        }
      }
    }

    addTemplate(even, 'even', 0.1);
    addTemplate(slight, 'slight', 0.1);
    addTemplate(grooved, 'grooved', 0.15);
    addTemplate(syncopated, 'syncopated', 0.05);

    // Always ensure at least one fallback
    if (templates.length === 0) {
      templates.push({ ratios: [1.0], weight: 1.0, label: 'even_default' });
    }

    return templates;
  }

  // ══════════════════════════════════════
  // GENERATE A PHRASE
  // ══════════════════════════════════════

  // context: { key, scale, mode, bassRoot, chord, saturatedPCs,
  //            recentNotes, humanAdv, bpm }
  // role: 'bass' | 'rhythm' | 'soloist'
  //
  // ══════════════════════════════════════
  // MODE-AWARE PARAMETER MODULATION
  // ══════════════════════════════════════
  // Each behavior mode biases generation parameters without
  // changing the core algorithm. Dot-product weights in
  // BehaviorModes select the mode; here we shape the output.

  var MODE_PARAM_TABLE = {
    // { lengthScale, ioiPrefer (array of boosted labels), intervalBias (added to mag) }
    // Legacy behavior modes (from BehaviorModes v1.x)
    rhythmic:       { lengthScale: 0.6,  ioiPrefer: ['grooved', 'syncopated'], intervalBias: 0 },
    textural:       { lengthScale: 0.8,  ioiPrefer: ['rubato', 'slight'],      intervalBias: 0.15 },
    developmental:  { lengthScale: 1.4,  ioiPrefer: null,                      intervalBias: 0.1 },
    conversational: { lengthScale: 0.5,  ioiPrefer: null,                      intervalBias: 0 },
    // v3 Phase 2: L2 melodic intent entries (set via context.behaviorMode = intent name)
    continuation:   { lengthScale: 1.5,  ioiPrefer: null,                      intervalBias: -0.05 },
    punctuation:    { lengthScale: 0.3,  ioiPrefer: ['slight'],                intervalBias: 0 },
    consonance:     { lengthScale: 0.8,  ioiPrefer: ['even'],                  intervalBias: -0.1 },
    contrast:       { lengthScale: 1.2,  ioiPrefer: ['rubato', 'syncopated'],  intervalBias: 0.2 }
    // bassline, arpeggio, melodic — use defaults (1.0 / null / 0)
  };

  var _defaultModeParams = { lengthScale: 1.0, ioiPrefer: null, intervalBias: 0 };

  // ── Pre-allocated scratch buffers to reduce GC pressure in generate() hot path ──
  var _startProbs = new Array(12).fill(1);  // reused by sampleStartDegree (max 12 scale degrees)
  var _uniqueDegSet = new Uint8Array(12);   // reused for interest calculation in generate()
  var _candScores = new Float64Array(12);   // reused for PPM+scoreCandidate combination

  function _getModeParams(modeName) {
    if (!modeName) return _defaultModeParams;
    return MODE_PARAM_TABLE[modeName] || _defaultModeParams;
  }

  // Returns: { sd: [functional degrees], ioi_ratios: [...],
  //            interest: N, loopable: false, generated: true }
  //          or null if models not ready

  function generate(context, role) {
    var m = models[role];
    if (!m || m.totalPhrases === 0) return null;

    var scale = context.scale;       // array of PCs in current scale
    var scaleLen = scale.length;
    if (scaleLen === 0) return null;

    var gc = getGenreConfig(SharedState.genre);

    // ── Mode-aware parameter modulation ──
    var modeParams = _getModeParams(context.behaviorMode);

    // ── 1. Sample phrase length ──
    var lenScale = modeParams.lengthScale;
    // Transition smoothing: shorten first phrase after rest/silence
    if (typeof BehaviorModes !== 'undefined' && BehaviorModes.wasResting(role)) {
      lenScale *= 0.6;
    }
    var targetLen = Math.max(2, Math.round(sampleLength(m, gc, role) * lenScale));

    // ── 2. Pick start degree ──
    var startDeg = sampleStartDegree(m, context, scaleLen);

    // ── 3. Generate note-by-note using PPM + scoreCandidate (v9.3.0) ──
    // PPM (5-viewpoint prediction) replaces order-2 Markov chains.
    // Product-of-experts: PPM provides statistical prior from note history,
    // scoreCandidate provides contextual evaluation (Schellenberg I-R + ensemble).
    var degrees = [startDeg];
    var currentDeg = startDeg;

    for (var i = 1; i < targetLen; i++) {
      var lastPC = scale[((currentDeg % scaleLen) + scaleLen) % scaleLen];

      // Get PPM 5-viewpoint prediction (12-dim chromatic distribution)
      var ppmDist = context.predict ? context.predict(lastPC) : null;

      // Score each scale degree: PPM probability × contextual score
      var totalScore = 0;
      for (var d = 0; d < scaleLen; d++) {
        var candidatePC = scale[d];
        var ppmProb = ppmDist ? (ppmDist[candidatePC] || 0.001) : (1.0 / scaleLen);
        var contextScore = scoreCandidate(candidatePC, d, context, degrees, i, targetLen,
          scaleLen, m.avgInterval, role);
        _candScores[d] = Math.max(0.001, ppmProb * contextScore);
        totalScore += _candScores[d];
      }

      // Weighted random sample from combined distribution
      var r = Math.random() * totalScore;
      var acc = 0;
      var picked = 0;
      for (var d = 0; d < scaleLen; d++) {
        acc += _candScores[d];
        if (acc >= r) { picked = d; break; }
      }

      degrees.push(picked);
      currentDeg = picked;
    }

    // ── 4. Post-hoc repair pass (Pachet-inspired constraint satisfaction) ──
    // Check global constraints that greedy left-to-right generation can't satisfy,
    // and repair individual notes if needed. Cheaper than full CSP but captures
    // the key benefits: ending resolution, range control, repetition limits.
    degrees = repairPhrase(degrees, scaleLen, context);

    // ── 5. Select IOI: trie-driven generation or template fallback ──
    // v8.6.0: When MelodicExpectancy IOI prediction is available, generate IOI
    // autoregressively from the trie (Cont 2008 HSMM, Nakamura 2015).
    // Falls back to template selection when IOI prediction unavailable.
    var ioiRatios;
    // v8.13.0: IOI trie generation with entropy safeguard.
    // Three-tier logic:
    //   1. High entropy (diverse trie) → use autoregressive trie generation
    //   2. Low entropy (concentrated trie) → 50/50 trie vs template (prevent monotony)
    //   3. No data / flag off → template fallback (original behavior)
    var _ioiGenEnabled = (typeof IOI_GENERATION_ENABLED !== 'undefined') ? IOI_GENERATION_ENABLED : false;
    if (_ioiGenEnabled && typeof MelodicExpectancy !== 'undefined' && MelodicExpectancy.predictIOI) {
      var _ioiProbe = MelodicExpectancy.predictIOI(role);
      var _entropyThresh = (typeof IOI_ENTROPY_THRESHOLD !== 'undefined') ? IOI_ENTROPY_THRESHOLD : 1.8;
      if (_ioiProbe && _ioiProbe.confidence > 0.30 && _ioiProbe.entropy >= _entropyThresh) {
        // Tier 1: diverse trie — use autoregressive generation
        ioiRatios = generateIOISequence(role, degrees.length, modeParams);
      } else if (_ioiProbe && _ioiProbe.confidence > 0.30 && Math.random() < 0.5) {
        // Tier 2: concentrated trie — 50% chance trie, 50% template
        ioiRatios = generateIOISequence(role, degrees.length, modeParams);
      } else {
        // Tier 3: no data or coin flip chose template
        ioiRatios = selectIOITemplate(m, degrees.length, gc, modeParams, role);
      }
    } else {
      ioiRatios = selectIOITemplate(m, degrees.length, gc, modeParams, role);
    }

    // ── 6. Compute interest score (reuse pre-allocated Uint8Array to avoid object alloc) ──
    for (var ui = 0; ui < 12; ui++) _uniqueDegSet[ui] = 0;
    var uniqueCount = 0;
    for (var i = 0; i < degrees.length; i++) {
      var deg = degrees[i];
      if (deg >= 0 && deg < 12 && !_uniqueDegSet[deg]) { _uniqueDegSet[deg] = 1; uniqueCount++; }
    }
    var interest = Math.min(1.0, uniqueCount / Math.max(scaleLen, 4) * 0.7 + 0.3);

    return {
      sd: degrees,           // functional scale degrees (NOT chromatic)
      ioi_ratios: ioiRatios,
      interest: interest,
      frequency: 0,
      loopable: false,       // generated phrases are single-use
      generated: true,       // flag for diagnostics + source tracking
      functional: true       // flag: these are functional degrees, not chromatic
    };
  }

  // ── Sample phrase length ──
  function sampleLength(m, gc, role) {
    // Base from genre config, adjusted per role
    var roleScale = role === 'bass' ? 0.6 : role === 'rhythm' ? 0.9 : role === 'lead' ? 1.1 : 1.3;
    var basePhraseLen = Math.max(2, Math.round(gc.phraseLen * roleScale));

    // If we have learned distribution, blend with genre config
    var totalLen = 0;
    for (var i = 2; i < m.lengthDist.length; i++) totalLen += m.lengthDist[i];

    if (totalLen > 5) {
      // Sample from distribution with some noise
      var r = Math.random() * totalLen;
      var acc = 0;
      for (var i = 2; i < m.lengthDist.length; i++) {
        acc += m.lengthDist[i];
        if (acc >= r) {
          // Blend sampled length with genre target
          return Math.max(2, Math.min(16, Math.round(i * 0.6 + basePhraseLen * 0.4)));
        }
      }
    }

    // Fallback: genre config + small random variation
    return Math.max(2, Math.min(12, basePhraseLen + Math.floor(Math.random() * 3) - 1));
  }

  // ── Sample start degree ──
  function sampleStartDegree(m, context, scaleLen) {
    // Build probability over scale degrees (not chromatic)
    // Map chromatic start distribution to functional degrees
    // Reuse pre-allocated buffer (zeroed to uniform prior 1)
    var probs = _startProbs;
    for (var si = 0; si < scaleLen; si++) probs[si] = 1;
    for (var si = scaleLen; si < probs.length; si++) probs[si] = 0;  // zero unused slots

    // Boost degrees that align with learned start preferences
    if (m.startDegree) {
      // For each chromatic SD that has counts, find closest functional degree
      for (var chromSD = 0; chromSD < 12; chromSD++) {
        if (m.startDegree[chromSD] === 0) continue;
        // Find which functional degree this maps to (approximately)
        var funcDeg = chromToFunctional(chromSD, context.scale, context.key);
        if (funcDeg >= 0 && funcDeg < scaleLen) {
          probs[funcDeg] += m.startDegree[chromSD];
        }
      }
    }

    // Boost chord tones
    if (context.chord) {
      var chordRoot = context.chord.rootPC;
      var chordThird = (chordRoot + (context.chord.type === 'minor' ? 3 : 4)) % 12;
      var chordFifth = (chordRoot + 7) % 12;
      boostPC(probs, context.scale, chordRoot, 2.0);
      boostPC(probs, context.scale, chordFifth, 1.5);
      boostPC(probs, context.scale, chordThird, 1.3);
    }

    // v8.8.0: chordHint — explicit chord-tone bias from lead supportive cascade
    // Stronger than default chord boost: lead supportive mode SHOULD anchor to harmony
    if (context.chordHint && context.chordHint.length > 0) {
      for (var chi = 0; chi < context.chordHint.length; chi++) {
        boostPC(probs, context.scale, context.chordHint[chi], 2.5);
      }
    }

    // Boost bass root consonance
    if (context.bassRoot !== null && context.bassRoot !== undefined) {
      boostPC(probs, context.scale, context.bassRoot, 1.5);
      boostPC(probs, context.scale, (context.bassRoot + 7) % 12, 1.2);
    }

    // Penalize saturated PCs
    if (context.saturatedPCs) {
      for (var i = 0; i < context.saturatedPCs.length; i++) {
        penalizePC(probs, context.scale, context.saturatedPCs[i], 0.5);
      }
    }

    // Weighted sample
    return weightedSample(probs);
  }

  // ── Post-hoc repair pass (lightweight constraint satisfaction) ──
  // Checks global constraints and repairs individual notes. Based on
  // Pachet & Roy (2009) Markov Constraints, simplified for real-time use.
  function repairPhrase(degrees, scaleLen, context) {
    if (degrees.length < 3) return degrees;

    var tonicDeg = 0;
    var fifthDeg = scaleLen >= 5 ? 4 : Math.floor(scaleLen / 2);

    // Constraint 1: Ending resolution — last note should be tonic or fifth
    var lastDeg = degrees[degrees.length - 1];
    if (lastDeg !== tonicDeg && lastDeg !== fifthDeg) {
      // Approach: step toward nearest resolution target
      var distToTonic = Math.abs(lastDeg - tonicDeg);
      var distToFifth = Math.abs(lastDeg - fifthDeg);
      if (distToTonic > scaleLen / 2) distToTonic = scaleLen - distToTonic;
      if (distToFifth > scaleLen / 2) distToFifth = scaleLen - distToFifth;
      degrees[degrees.length - 1] = distToTonic <= distToFifth ? tonicDeg : fifthDeg;
      // Also nudge penultimate toward a step away from resolution (creates approach)
      if (degrees.length >= 3) {
        var target = degrees[degrees.length - 1];
        var approach = ((target + 1) % scaleLen);  // one degree above resolution
        var current = degrees[degrees.length - 2];
        // Only nudge if current penultimate is far from the approach
        if (Math.abs(current - approach) > 2) {
          degrees[degrees.length - 2] = approach;
        }
      }
    }

    // Constraint 2: Range — total range should stay within an octave (scaleLen degrees)
    var minDeg = degrees[0], maxDeg = degrees[0];
    for (var i = 1; i < degrees.length; i++) {
      if (degrees[i] < minDeg) minDeg = degrees[i];
      if (degrees[i] > maxDeg) maxDeg = degrees[i];
    }
    var range = maxDeg - minDeg;
    if (range > scaleLen) {
      // Pull outliers toward center
      var center = Math.floor((minDeg + maxDeg) / 2);
      for (var i = 1; i < degrees.length - 1; i++) {  // don't touch first/last
        if (degrees[i] - center > Math.floor(scaleLen / 2)) {
          degrees[i] = ((degrees[i] - scaleLen) % scaleLen + scaleLen) % scaleLen;
        } else if (center - degrees[i] > Math.floor(scaleLen / 2)) {
          degrees[i] = ((degrees[i] + scaleLen) % scaleLen + scaleLen) % scaleLen;
        }
      }
    }

    // Constraint 3: No three consecutive identical degrees
    for (var i = 2; i < degrees.length; i++) {
      if (degrees[i] === degrees[i - 1] && degrees[i] === degrees[i - 2]) {
        // Replace middle note with a neighbor
        degrees[i - 1] = (degrees[i - 1] + 1) % scaleLen;
      }
    }

    // Constraint 4: Contour should have at least one direction change (not monotonic)
    if (degrees.length >= 4) {
      var allUp = true, allDown = true;
      for (var i = 1; i < degrees.length; i++) {
        if (degrees[i] < degrees[i - 1]) allUp = false;
        if (degrees[i] > degrees[i - 1]) allDown = false;
      }
      if (allUp || allDown) {
        // Force a direction change near the middle
        var mid = Math.floor(degrees.length / 2);
        var prev = degrees[mid - 1];
        var dir = allUp ? -1 : 1;
        degrees[mid] = ((prev + dir * 2) % scaleLen + scaleLen) % scaleLen;
      }
    }

    return degrees;
  }

  // v9.3.0: sampleContour() and magToScaleDegreeStep() removed.
  // PPM 5-viewpoint prediction (SharedState.predict) replaces the order-2
  // Markov chains (contour, interval, SD bigram). See generate() step 3.

  // ── Score a candidate note (Schellenberg 1997 two-factor model + context) ──
  // Based on empirically validated melodic expectancy research:
  //   Factor 1: Pitch Proximity (sr² = 0.364) — listeners expect small intervals
  //   Factor 2: Pitch Reversal (sr² = 0.144) — after large leaps, expect direction change
  // Plus contextual modifiers from the live ensemble state.
  function scoreCandidate(candidatePC, candidateDeg, context, degrees, position, totalLen, scaleLen, avgInterval, role) {
    var score = 0.0;

    // Per-role I-R weights (Schellenberg two-factor, research-parameterized)
    var irw = (typeof I_R_WEIGHTS !== 'undefined' && I_R_WEIGHTS[role])
      ? I_R_WEIGHTS[role]
      : { proximity: 0.72, reversal: 0.28, ascendBias: 0 };

    // ── Factor 1: Pitch Proximity (Schellenberg weight: 0.72) ──
    // v8.13.0: Role-differentiated proximity curves.
    // Bass/rhythm: linear falloff (structural grounding — prefer steps).
    // Soloist/lead: bimodal (Huron 2006 — steps AND leaps expected, valley at 3).
    if (degrees.length >= 1) {
      var lastDeg = degrees[degrees.length - 1];
      var degDistance = Math.abs(candidateDeg - lastDeg);
      // Wrap: if distance > half the scale, go the other way
      if (degDistance > scaleLen / 2) degDistance = scaleLen - degDistance;

      var proxScore;
      var _useBimodal = (role === 'soloist');  // v9.2.0: inlined (was BIMODAL_PROXIMITY_ROLES lookup)
      if (_useBimodal && typeof BIMODAL_PROXIMITY !== 'undefined') {
        // Bimodal lookup: clamp to table length (distance 6+ gets last value)
        var _biIdx = Math.min(degDistance, BIMODAL_PROXIMITY.length - 1);
        proxScore = BIMODAL_PROXIMITY[_biIdx];
      } else {
        // Linear falloff: step (dist 1) is peak, unison penalized
        // v9.1.0: Changed from 1.0-at-zero to step-peak model.
        // Old model made unison (dist 0) the highest-scoring interval,
        // causing 31-45% unison rates. Huron (2006): step motion is the
        // most common melodic interval, not repetition.
        if (degDistance === 0) {
          proxScore = (role === 'bass' || role === 'rhythm') ? 0.7 : 0.4;
        } else {
          // dist 1 = 1.0 (peak), falls off from there
          proxScore = Math.max(0, 1.0 - (degDistance - 1) / 4.0);
        }
      }
      score += proxScore * irw.proximity;  // per-role proximity weight

      // v8.14.0: Bass stale-pedal penalty (Terhardt 1974, Parncutt 1989)
      // When bass repeats the same note (unison) but the chord root has changed,
      // the bass is no longer grounding the harmony. Apply penalty to break the
      // 70% unison rate. Only fires for bass, only when chord root ≠ current note.
      // Penalty 0.15 exceeds the unison proximity advantage over step (0.70 vs 0.56 = 0.14),
      // making the step to chord root the preferred choice after a chord change.
      if (role === 'bass' && degDistance === 0 && context.chord && context.scale) {
        // Convert degree to PC via scale lookup (degree 3 in minor = PC 5, not 3)
        var _lastPC = (context.scale[((lastDeg % scaleLen) + scaleLen) % scaleLen] + (context.key || 0)) % 12;
        if (context.chord.rootPC !== _lastPC) {
          score -= 0.15;
        }
      }
    } else {
      score += irw.proximity * 0.5;  // neutral if no history
    }

    // ── Factor 2: Pitch Reversal (Schellenberg weight: 0.28) ──
    // After a large interval (≥ 3 scale degrees), expect direction change.
    // After a small interval (< 3), expect continuation in same direction.
    if (degrees.length >= 2) {
      var prev2 = degrees[degrees.length - 2];
      var prev1 = degrees[degrees.length - 1];
      var implInterval = prev1 - prev2;  // signed implicative interval
      var realInterval = candidateDeg - prev1;  // signed realized interval

      var absImpl = Math.abs(implInterval);
      var reversal = 0;

      if (absImpl >= 3) {
        // Large interval: expect reversal or lateral (Narmour gap-fill)
        // v2.4: Magnitude-scaled — ideal fill is 0.3-0.6 of leap size
        if ((implInterval > 0 && realInterval <= 0) || (implInterval < 0 && realInterval >= 0)) {
          var absReal = Math.abs(realInterval);
          var fillRatio = absReal / absImpl;  // 0 = no movement, 1 = exact mirror
          // Sweet spot: fill 0.3-0.6 of leap size
          if (fillRatio < 0.3) reversal = 0.7;      // too static
          else if (fillRatio <= 0.6) reversal = 1.0;  // ideal gap-fill
          else reversal = 0.6;                        // overshoot
        }
        else reversal = 0.2;  // continuation after large = unexpected
      } else if (absImpl > 0) {
        // Small interval: expect continuation in same direction
        if ((implInterval > 0 && realInterval > 0) || (implInterval < 0 && realInterval < 0)) {
          reversal = 0.8;  // continuation = expected
        } else if (realInterval === 0) {
          reversal = 0.5;  // lateral = neutral
        } else {
          reversal = 0.3;  // reversal after small = somewhat unexpected
        }
      } else {
        reversal = 0.5;  // unison: no directional expectancy
      }
      score += reversal * irw.reversal;  // per-role reversal weight
    } else {
      score += irw.reversal * 0.5;  // neutral
    }

    // ── Ascending bias (lead energy driver) ──
    if (irw.ascendBias > 0 && degrees.length >= 1) {
      var lastDegAsc = degrees[degrees.length - 1];
      if (candidateDeg > lastDegAsc) score += irw.ascendBias;
      else if (candidateDeg < lastDegAsc) score -= irw.ascendBias * 0.3;
    }

    // ── v6 Phase 7A: Enhanced I-R factors (Huron 2006) ──
    var _enh = (typeof I_R_ENHANCED !== 'undefined' && I_R_ENHANCED[role]) ? I_R_ENHANCED[role] : null;
    if (_enh) {
      // (a) Key-aware proximity: scale tones more expected (Temperley 2007)
      if (context.scale) {
        var _isScale = context.scale.indexOf(candidatePC) >= 0;
        score += _isScale ? _enh.stabilityBonus : _enh.stabilityPenalty;
      }
      // (b) Range regression (Von Hippel & Huron 2000): bias toward tessitura center
      if (degrees.length >= 3) {
        var _center = Math.floor(scaleLen / 2);
        var _dFromCenter = Math.abs(candidateDeg - _center) / (scaleLen / 2 || 1);
        if (_dFromCenter > 0.7) score -= _enh.regressionStr * (_dFromCenter - 0.7);
      }
      // (c) Phrase-position arch (Huron 2006): rise first half, fall second half
      if (degrees.length >= 1) {
        var _archPos = position / Math.max(1, totalLen - 1);
        var _archDir = _archPos < 0.5 ? _enh.archBias : -_enh.archBias;
        if (candidateDeg > degrees[degrees.length - 1]) score += _archDir;
        else if (candidateDeg < degrees[degrees.length - 1]) score -= _archDir * 0.3;
      }
    }

    // ── v9 Feature A: Precision-weighted expectation scoring (Active Inference) ──
    // Expectancy influence scales with prediction precision (inverse entropy).
    // Stance-driven intent mapping replaces hand-tuned weights (Vuust et al. 2022).
    if (context.expectancy && context.expectancy.dist) {
      var eDist = context.expectancy.dist;
      var ePrecision = context.expectancy.precision || 0.5;
      var intent = context.behaviorMode;

      // Look up base weight and stance multiplier
      var _baseW = (typeof EXPECTANCY_BASE_WEIGHTS !== 'undefined') ? EXPECTANCY_BASE_WEIGHTS : null;
      var _stMap = (typeof STANCE_EXPECTANCY_MAP !== 'undefined') ? STANCE_EXPECTANCY_MAP : null;
      var _stance = context.voiceStance || 'support';
      var _stMul = (_stMap && _stMap[_stance]) ? _stMap[_stance] : { continuation: 1.0, contrast: 1.0, consonance: 1.0 };

      var eWeight = 0;
      if (intent === 'continuation' && _baseW)
        eWeight = _baseW.continuation * ePrecision * _stMul.continuation;
      else if (intent === 'contrast' && _baseW)
        eWeight = _baseW.contrast * ePrecision * _stMul.contrast;
      else if (intent === 'consonance' && _baseW)
        eWeight = _baseW.consonance * ePrecision * _stMul.consonance;
      else if (intent === 'continuation')
        eWeight = 0.25 * ePrecision;
      else if (intent === 'contrast')
        eWeight = 0.15 * ePrecision;
      else if (intent === 'consonance')
        eWeight = 0.18 * ePrecision;
      // punctuation: no modification (timing, not pitch)

      if (eWeight > 0) {
        if (intent === 'contrast') {
          score += (1.0 - (eDist[candidatePC] || 0)) * eWeight;
        } else {
          score += (eDist[candidatePC] || 0) * eWeight;
        }

        // v8.2 Fix #3: I-R reduction scaled by precision.
        // High precision = trust expectancy, reduce I-R proportionally.
        // Factor raised from 0.5 to 0.7 so expectancy genuinely replaces I-R
        // rather than just adding on top. At precision 0.5: 35% I-R reduction.
        var irReduction = irw.proximity * 0.5 + irw.reversal * 0.5;
        score -= irReduction * 0.7 * ePrecision;
        if (_enh) {
          score -= (_enh.stabilityBonus > 0 ? _enh.stabilityBonus : -_enh.stabilityPenalty) * 0.5 * ePrecision;
          if (degrees.length >= 1) {
            var _archPos2 = position / Math.max(1, totalLen - 1);
            var _archDir2 = _archPos2 < 0.5 ? _enh.archBias : -_enh.archBias;
            if (candidateDeg > degrees[degrees.length - 1]) score -= _archDir2 * ePrecision;
            else if (candidateDeg < degrees[degrees.length - 1]) score += _archDir2 * 0.3 * ePrecision;
          }
        }
      }
    }

    // ── Contextual modifiers (ensemble-aware, not part of Schellenberg) ──
    // These are additive bonuses/penalties scaled to be secondary to the
    // two-factor core. Total contextual range: -0.15 to +0.20

    // Chord tone bonus — role-scaled (Terhardt 1974, Parncutt 1989: bass root 3-5x more salient)
    // v8.14.0: Role-differentiated chord-tone pull:
    //   Bass: highest (harmonic anchor, root 0.20, fifth 0.12)
    //   Lead: authority-scaled (HARMONIC_AUTHORITY_WEIGHT 0.95 now applied to scoring,
    //         not just consensus voting — root 0.19, fifth 0.13, third 0.09)
    //   Soloist: exploratory (root 0.15, fifth 0.10, third 0.07 — intentionally lower)
    //   Rhythm: structural (root 0.12, fifth 0.08)
    // Phrase-start anchoring (Lerdahl & Jackendoff 1983): melodic voices get 1.5× at pos 0-1
    if (context.chord) {
      var chRoot = context.chord.rootPC;
      var chFifth = (chRoot + 7) % 12;
      var _chordBonus = 0;
      var _isBass = (role === 'bass');
      var _isLead = (role === 'lead');
      var _isSoloist = (role === 'soloist');
      var _isMelodic = (_isSoloist || _isLead);
      var _phraseStartBoost = (_isMelodic && position <= 1) ? 1.5 : 1.0;
      // v8.14.0: Lead gets authority-scaled bonus. HARMONIC_AUTHORITY_WEIGHT (0.95) was
      // unused in scoring — now applied as multiplier on a higher base (0.20 × 0.95 = 0.19).
      // This bridges the gap between proximity (0.48 for lead linear) and chord pull.
      var _authMult = (_isLead && typeof HARMONIC_AUTHORITY_WEIGHT !== 'undefined')
        ? (HARMONIC_AUTHORITY_WEIGHT.lead || 0.95) : 1.0;
      if (candidatePC === chRoot) {
        _chordBonus = _isBass ? 0.20 : (_isLead ? 0.20 * _authMult : (_isSoloist ? 0.15 : 0.12));
      } else if (candidatePC === chFifth) {
        _chordBonus = _isBass ? 0.12 : (_isLead ? 0.14 * _authMult : (_isSoloist ? 0.10 : 0.08));
      }
      _chordBonus *= _phraseStartBoost;
      // Melodic voices get third bonus — full triad awareness helps track distant chords.
      // Bass omits third (Terhardt 1974: bass register masks thirds).
      if (_isMelodic && !_chordBonus) {
        var chThird = (chRoot + (context.chord.type === 'minor' ? 3 : 4)) % 12;
        if (candidatePC === chThird) _chordBonus = (_isLead ? 0.09 * _authMult : 0.07) * _phraseStartBoost;
      }

      // v4 Phase 3: Always-on continuous harmonic blending
      if (context.voiceKeyBelief) {
        var _div = context.keyDivergence || 0;
        var _hbo = (typeof HARMONY_BLEND_ONSET !== 'undefined') ? HARMONY_BLEND_ONSET : 0.05;
        var _hbr = (typeof HARMONY_BLEND_RANGE !== 'undefined') ? HARMONY_BLEND_RANGE : 0.6;
        var _hbm = (typeof HARMONY_BLEND_MAX !== 'undefined') ? HARMONY_BLEND_MAX : 0.5;
        var _bw = Math.min(Math.max((_div - _hbo) / _hbr, 0), 1.0) * _hbm;
        if (_bw > 0.001) {
          var _vkb = context.voiceKeyBelief;
          if (_vkb.topKey !== undefined) {
            var _vRoot = _vkb.topKey;
            var _vFifth = (_vRoot + 7) % 12;
            var _voiceBonus = 0;
            if (candidatePC === _vRoot) _voiceBonus = 0.12;
            else if (candidatePC === _vFifth) _voiceBonus = 0.08;
            _chordBonus = _chordBonus * (1 - _bw) + _voiceBonus * _bw;
          }
        }
      }
      score += _chordBonus;
    }

    // v8.8.0: chordHint bonus — lead supportive mode should stay on chord tones
    if (context.chordHint && context.chordHint.length > 0) {
      var _isHinted = false;
      for (var _chi = 0; _chi < context.chordHint.length; _chi++) {
        if (candidatePC === context.chordHint[_chi] % 12) { _isHinted = true; break; }
      }
      score += _isHinted ? 0.15 : -0.05;  // strong bias toward hinted chord tones
    }

    // Saturation penalty
    if (context.saturatedPCs && context.saturatedPCs.indexOf(candidatePC) >= 0) {
      score -= 0.10;
    }

    // Within-phrase repetition penalty (consecutive same degree)
    // v9.1.0: Increased from -0.06 to role-dependent values.
    // Old -0.06 was dominated by proximity bonus (unison = 0.60 for lead),
    // making repeated notes the highest-scoring option. Now:
    // - Bass: -0.06 (pedal tones are idiomatic)
    // - Rhythm: -0.06 (chord stabs repeat naturally)
    // - Soloist/Lead: -0.25 (melodic voices must move)
    if (degrees.length >= 1 && candidateDeg === degrees[degrees.length - 1]) {
      var _repPenalty = (role === 'bass' || role === 'rhythm') ? 0.06 : 0.25;
      score -= _repPenalty;
    }

    // Phrase arc: tension curve (Lerdahl & Jackendoff inspired)
    var arcPos = position / totalLen;
    if (arcPos > 0.75) {
      // Ending zone: slight tonic/fifth pull
      if (candidateDeg === 0) score += 0.08;
      else if (candidateDeg === (scaleLen >= 5 ? 4 : Math.floor(scaleLen / 2))) score += 0.05;
    } else if (arcPos > 0.3 && arcPos < 0.7) {
      // Tension zone: slight penalty for tonic
      if (candidateDeg === 0) score -= 0.03;
    }

    // ── v2.4: Beat-phase bias (structural beat preference) ──
    // Research: beat 1 = chord tone, beat 4 = approach zone
    var BEAT_PHASE_WEIGHT = 0.06;  // secondary to Schellenberg (1.0)
    if (context && context.barPhase !== undefined && context.barConfidence > 0.2) {
      var noteBarPhase = (context.barPhase + (position / totalLen)) % 1.0;
      var beatPos = noteBarPhase * (context.beatsPerBar || 4);
      var beatNum = Math.floor(beatPos);

      if (beatNum === 0 && context.chord) {
        // Beat 1: favor chord tones (root, fifth)
        var r = context.chord.rootPC;
        if (candidatePC === r) score += BEAT_PHASE_WEIGHT;
        else if (candidatePC === (r + 7) % 12) score += BEAT_PHASE_WEIGHT * 0.7;
      } else if (beatNum === 3 && context.chord) {
        // Beat 4: approach zone — favor notes a step from next root
        var r = context.chord.rootPC;
        var above = (r + 1) % 12;
        var below = (r + 11) % 12;
        if (candidatePC === above || candidatePC === below) score += BEAT_PHASE_WEIGHT;
      }
    }

    // ── v7 Phase 8C: Harmonic direction — pull toward predicted chords ──
    if (context.harmonicTargets) {
      var ht = context.harmonicTargets[position];
      if (ht) {
        if (ht.chordTones) {
          // At target position: chord tones of upcoming chord get bonus
          for (var hti = 0; hti < ht.chordTones.length; hti++) {
            if (candidatePC === ht.chordTones[hti]) {
              score += 0.15 * ht.confidence;
              break;
            }
          }
        }
        if (ht.approachTones) {
          // Approach zone: semitone below/above root get smaller bonus
          for (var ati = 0; ati < ht.approachTones.length; ati++) {
            if (candidatePC === ht.approachTones[ati]) {
              score += 0.10 * ht.confidence;
              break;
            }
          }
        }
      }
    }

    // ── v8 Feature G: Harmonic consensus bonus (stigmergic coordination) ──
    // When peer voices agree on an upcoming harmonic target, bias toward its chord tones.
    // This is PEER consensus, distinct from v7 8C's per-voice harmonic targets.
    if (context.harmonicConsensus) {
      var hc = context.harmonicConsensus;
      var hcBonus = (role === 'bass' && typeof HARMONIC_CONSENSUS_BONUS_BASS !== 'undefined')
        ? HARMONIC_CONSENSUS_BONUS_BASS
        : (typeof HARMONIC_CONSENSUS_BONUS !== 'undefined') ? HARMONIC_CONSENSUS_BONUS : 0.10;
      var hcRoot = hc.targetPC;
      var hcThird = (hcRoot + (hc.targetType === 'minor' ? 3 : 4)) % 12;
      var hcFifth = (hcRoot + 7) % 12;
      if (candidatePC === hcRoot) score += hcBonus * hc.confidence;
      else if (candidatePC === hcFifth) score += hcBonus * hc.confidence * 0.7;
      else if (candidatePC === hcThird) score += hcBonus * hc.confidence * 0.5;
    }

    // ── v9 Feature B: Functional harmony — cadential expectation + voice-leading ──
    // Rohrmeier 2020: chord function (T/S/D) drives resolution expectations.
    // After dominant: pull toward tonic root. After tonic: allow departure.
    if (typeof HarmonicFunction !== 'undefined' && HarmonicFunction.getCadentialExpectation) {
      var _cad = HarmonicFunction.getCadentialExpectation();
      if (_cad.strength > 0.1) {
        if (_cad.expecting === 'resolution' && context.chord) {
          // Pull toward tonic — keyC is the tonic PC
          var _tonicPC = context.key;
          var _tonicFifth = (_tonicPC + 7) % 12;
          if (candidatePC === _tonicPC) score += 0.12 * _cad.strength;
          else if (candidatePC === _tonicFifth) score += 0.06 * _cad.strength;
        } else if (_cad.expecting === 'departure' && context.chord) {
          // Favor non-tonic tones — encourage movement
          var _depTonicPC = context.key;
          if (candidatePC !== _depTonicPC) score += 0.04 * _cad.strength;
        }
      }
      // Voice-leading cost: penalize poor motion from last note
      if (degrees.length >= 1 && context.chord) {
        var _prevPC = ((degrees[degrees.length - 1] % (context.scale ? context.scale.length : 7)) +
          context.key) % 12;
        var _vlCost = _voiceLeadingCost(_prevPC, candidatePC, role);
        score -= _vlCost;  // cost is positive = penalty, negative = bonus
      }
    }

    return Math.max(0.01, Math.min(1, score));
  }

  // ── Select IOI template ──
  // v8.6.0: Autoregressive IOI generation from PPM trie (Cont 2008, Nakamura 2015)
  // Generates IOI ratios one at a time using the IOI prediction distribution.
  // Falls back to selectIOITemplate if prediction is unavailable.
  function generateIOISequence(role, phraseLen, modeParams) {
    var needed = phraseLen - 1;
    if (needed <= 0) return [];

    var result = [];
    var _jitter = (role === 'bass' || role === 'rhythm') ? 0.01 : 0.05;

    for (var i = 0; i < needed; i++) {
      var pred = MelodicExpectancy.predictIOI(role);
      if (!pred || !pred.dist) {
        // Fallback: even quarter notes
        result.push(1.0 + (Math.random() * 2 - 1) * _jitter);
        continue;
      }

      // Copy distribution and apply mode bias
      var dist = new Float64Array(16);
      for (var b = 0; b < 16; b++) dist[b] = pred.dist[b];

      // Mode-dependent IOI shaping
      if (modeParams && modeParams.ioiPrefer) {
        for (var pi = 0; pi < modeParams.ioiPrefer.length; pi++) {
          var pref = modeParams.ioiPrefer[pi];
          if (pref === 'even' || pref === 'slight') {
            // Boost bins 5-7 (ratios 0.7-1.4 = even quarter-note range)
            for (var eb = 5; eb <= 7; eb++) dist[eb] *= 1.5;
          } else if (pref === 'syncopated' || pref === 'grooved') {
            // Boost short + long, suppress even (off-grid patterns)
            for (var sb = 2; sb <= 4; sb++) dist[sb] *= 1.3;
            for (var lb = 8; lb <= 10; lb++) dist[lb] *= 1.3;
            for (var mb = 5; mb <= 7; mb++) dist[mb] *= 0.7;
          }
        }
      }

      // Normalize
      var total = 0;
      for (var b = 0; b < 16; b++) total += dist[b];
      if (total > 0) {
        for (var b = 0; b < 16; b++) dist[b] /= total;
      }

      // Weighted random sample
      var r = Math.random();
      var acc = 0;
      var sampledBin = 6; // fallback: quarter note
      for (var b = 0; b < 16; b++) {
        acc += dist[b];
        if (acc >= r) { sampledBin = b; break; }
      }

      // Convert to ratio with humanization jitter
      var ratio = MelodicExpectancy.dequantizeIOI(sampledBin);
      ratio *= (1 - _jitter) + Math.random() * (_jitter * 2);
      ratio = Math.max(0.125, Math.min(4.0, ratio)); // clamp to musical range
      result.push(ratio);

      // Feed back into STM for autoregressive generation
      MelodicExpectancy.observeIOI(role, ratio);
    }

    return result;
  }

  function selectIOITemplate(m, phraseLen, gc, modeParams, role) {
    var templates = m.ioiTemplates;
    if (!templates || templates.length === 0) {
      // All even
      var even = [];
      for (var i = 0; i < phraseLen - 1; i++) even.push(1.0);
      return even;
    }

    // Weight templates: prefer ones close to needed length
    var candidates = [];
    for (var i = 0; i < templates.length; i++) {
      var t = templates[i];
      var w = t.weight;

      // Length compatibility: how well does the template length
      // divide into the phrase length?
      var tLen = t.ratios.length;
      var needed = phraseLen - 1;
      if (tLen === 0) continue;

      // Perfect multiple is best; close lengths are okay
      var remainder = needed % tLen;
      var lenFit = remainder === 0 ? 1.0 : 1.0 - (remainder / tLen) * 0.3;
      w *= lenFit;

      // Genre bias: sequencer genres prefer even/slight; jazz prefers grooved
      if (gc.antiOsc > 0.7) {
        if (t.label === 'even' || t.label === 'slight') w *= 1.3;
      } else {
        if (t.label === 'grooved' || t.label === 'syncopated') w *= 1.3;
      }
      // Groove roles always prefer even timing (Pressing 1999: rhythm section
      // provides metronomic reference; melodic roles deviate expressively)
      if ((role === 'bass' || role === 'rhythm') && (t.label === 'even' || t.label === 'slight')) {
        w *= 1.5;
      }

      // v8.13.0: Role-specific template preference (melodic voices prefer rhythmic variety)
      var _rolePref = (typeof IOI_ROLE_TEMPLATE_PREFERENCE !== 'undefined') ? IOI_ROLE_TEMPLATE_PREFERENCE[role] : null;
      if (_rolePref && t.label) {
        for (var rpi = 0; rpi < _rolePref.length; rpi++) {
          if (t.label === _rolePref[rpi]) { w *= 1.4; break; }
        }
      }

      // Behavior mode IOI preference boost
      if (modeParams && modeParams.ioiPrefer && t.label) {
        for (var pi = 0; pi < modeParams.ioiPrefer.length; pi++) {
          if (t.label === modeParams.ioiPrefer[pi]) { w *= 1.5; break; }
        }
      }

      candidates.push({ template: t, weight: w });
    }

    if (candidates.length === 0) {
      var even = [];
      for (var i = 0; i < phraseLen - 1; i++) even.push(1.0);
      return even;
    }

    // Weighted sample
    var totalW = candidates.reduce(function(a, b) { return a + b.weight; }, 0);
    var r = Math.random() * totalW;
    var acc = 0;
    var picked = candidates[0].template;
    for (var i = 0; i < candidates.length; i++) {
      acc += candidates[i].weight;
      if (acc >= r) { picked = candidates[i].template; break; }
    }

    // Stretch/tile the template to fit phrase length
    var needed = phraseLen - 1;
    var result = [];
    var srcIdx = 0;
    for (var i = 0; i < needed; i++) {
      var ratio = picked.ratios[srcIdx % picked.ratios.length];
      // Humanization: groove roles (bass/rhythm) get ±1% for locked feel,
      // melodic roles get ±5% for expressive timing (Pressing 1999)
      var _jitter = (role === 'bass' || role === 'rhythm') ? 0.01 : 0.05;
      ratio *= (1 - _jitter) + Math.random() * (_jitter * 2);
      result.push(ratio);
      srcIdx++;
    }

    return result;
  }

  // ══════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════

  // Map a chromatic SD (0-11) to the nearest functional degree in a scale
  function chromToFunctional(chromSD, scale, key) {
    // chromSD is a semitone offset; scale is array of PCs
    var targetPC = (chromSD + key) % 12;
    var bestDeg = 0;
    var bestDist = 99;
    for (var d = 0; d < scale.length; d++) {
      var dist = Math.min(Math.abs(scale[d] - targetPC), 12 - Math.abs(scale[d] - targetPC));
      if (dist < bestDist) {
        bestDist = dist;
        bestDeg = d;
      }
    }
    return bestDeg;
  }

  // Boost probability for scale degrees whose PC matches target
  function boostPC(probs, scale, targetPC, factor) {
    for (var d = 0; d < scale.length; d++) {
      if (scale[d] === targetPC) probs[d] *= factor;
    }
  }

  // Penalize probability for scale degrees whose PC matches target
  function penalizePC(probs, scale, targetPC, factor) {
    for (var d = 0; d < scale.length; d++) {
      if (scale[d] === targetPC) probs[d] *= factor;
    }
  }

  // Weighted random sample from probability array, returns index
  function weightedSample(probs) {
    var total = 0;
    for (var i = 0; i < probs.length; i++) total += probs[i];
    if (total <= 0) return 0;
    var r = Math.random() * total;
    var acc = 0;
    for (var i = 0; i < probs.length; i++) {
      acc += probs[i];
      if (acc >= r) return i;
    }
    return 0;
  }

  // ══════════════════════════════════════
  // PUBLIC INTERFACE
  // ══════════════════════════════════════

  function isReady(role) {
    return models[role] !== null && models[role].totalPhrases > 0;
  }

  function reset() {
    models.bass = null;
    models.rhythm = null;
    models.soloist = null;
    models.lead = null;
  }

  // Diagnostic: dump model stats
  function getModelStats(role) {
    var m = models[role];
    if (!m) return null;
    return {
      totalPhrases: m.totalPhrases,
      avgInterval: m.avgInterval.toFixed(2),
      ioiTemplates: m.ioiTemplates.length,
      ioiLabels: m.ioiTemplates.map(function(t) { return t.label; })
    };
  }

  return {
    learnFromLexicon: learnFromLexicon,
    generate: generate,
    computeHarmonicTargets: computeHarmonicTargets,
    isReady: isReady,
    reset: reset,
    getModelStats: getModelStats
  };
})();

console.log('%cPhraseGenerator loaded', 'color:#d4b040;font-family:monospace');

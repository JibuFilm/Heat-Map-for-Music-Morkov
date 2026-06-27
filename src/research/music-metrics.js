'use strict';
// ═══ MUSIC METRICS — Quantitative Musical Quality Assessment ═══
//
// Computes research-grounded metrics for generated music output.
// Two tiers:
//   Real-time (per-note): IC distribution, nPVI, register compliance,
//     metric adherence, onset synchrony, consonance, tension arc, engagement
//   Post-session (on demand): LZ complexity, interval fit, contour analysis,
//     harmonic surprise, developmental continuity, form clarity
//
// Citations:
//   IDyOM / IC:       Pearce 2012 — information dynamics of music perception
//   nPVI:             Patel & Daniele 2003 — rhythmic variability index
//   Consonance:       Plomp & Levelt 1965 — critical bandwidth roughness
//   Tension arc:      Herremans & Chew 2016 (MorpheuS) — tonal tension
//   Engagement:       Berlyne 1971 — inverted-U complexity/aesthetics
//   LZ complexity:    Lempel-Ziv 1976 — algorithmic complexity
//   Voice independence: Shannon mutual information
//   Onset synchrony:  Rasch 1979 — ensemble asynchrony
//
// Subscribes to EventBus 'noteProduced'. Read-only observer.
// Load order: after research-state.js, melodic-expectancy.js, mood-state.js

var MusicMetrics = (function() {

  var VOICES = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];
  var PITCHED_VOICES = ['bass', 'rhythm', 'soloist', 'lead'];
  var VOICE_PAIRS = [];
  for (var _i = 0; _i < PITCHED_VOICES.length; _i++) {
    for (var _j = _i + 1; _j < PITCHED_VOICES.length; _j++) {
      VOICE_PAIRS.push([PITCHED_VOICES[_i], PITCHED_VOICES[_j]]);
    }
  }

  // ── Per-role ideal tessitura (MIDI ranges) ──
  var TESSITURA = {
    bass:    { min: 28, max: 55 },
    rhythm:  { min: 48, max: 72 },
    soloist: { min: 60, max: 84 },
    lead:    { min: 65, max: 90 }
  };

  // ── Per-role nPVI targets (Patel & Daniele 2003) ──
  var NPVI_TARGETS = {
    bass:    { min: 10, max: 30 },   // groove stability
    rhythm:  { min: 10, max: 30 },
    soloist: { min: 25, max: 60 },   // expressive freedom
    lead:    { min: 20, max: 50 }
  };

  // ── Rolling buffer size ──
  var WINDOW_SIZE = 60;        // notes per voice for rolling metrics
  var TENSION_WINDOW_MS = 5000; // 5s windows for tension curve
  var ENGAGEMENT_WINDOW_MS = 2000; // 2s windows for IC engagement

  // ══════════════════════════════════════
  // PER-VOICE STATE
  // ══════════════════════════════════════

  var _voice = {};
  function _initVoice(v) {
    return {
      notes: [],          // [{pc, midi, ts, ic, volMult}] rolling window
      iois: [],           // inter-onset intervals (ms), rolling
      pcs: [],            // pitch class sequence for MI / LZ
      midiSum: 0,         // for running mean
      midiCount: 0,
      inRange: 0,         // notes within tessitura
      totalNotes: 0,
      icSum: 0,           // for rolling IC mean
      icSqSum: 0,         // for IC variance
      icHist: [0, 0, 0, 0, 0], // [0-1, 1-2, 2-3, 3-4, 4+] bits
      // Metric adherence: accumulate importance × weight pairs for correlation
      metricPairs: [],    // [{importance, weight}] rolling
      lastNoteTime: 0
    };
  }

  for (var vi = 0; vi < VOICES.length; vi++) {
    _voice[VOICES[vi]] = _initVoice(VOICES[vi]);
  }

  // ══════════════════════════════════════
  // ENSEMBLE STATE
  // ══════════════════════════════════════

  var _tensionSamples = [];     // [{t, tension}] for arc analysis
  var _lastTensionSample = 0;
  var _icSamples = [];          // [{t, meanIC}] for engagement
  var _lastICSample = 0;
  var _phraseStarts = {};       // {voice: lastPhraseStartMs} for onset synchrony
  var _onsetAsyncSDs = [];      // collected SDs of phrase-start asynchronies

  // ══════════════════════════════════════
  // NOTE EVENT HANDLER
  // ══════════════════════════════════════

  function _onNote(data) {
    var voice = data.voiceName || data.voice;
    var v = _voice[voice];
    if (!v) return;

    var now = Date.now();
    var pc = data.pc;
    var midi = data.midi || (pc + 60);
    var volMult = data.volMult || 1.0;

    // IC from MelodicExpectancy (if available)
    var ic = 0;
    if (typeof MelodicExpectancy !== 'undefined' && MelodicExpectancy.getIC) {
      ic = MelodicExpectancy.getIC(voice) || 0;
    }

    // ── Per-voice updates ──

    // IOI
    if (v.lastNoteTime > 0) {
      var ioi = now - v.lastNoteTime;
      if (ioi > 10 && ioi < 10000) { // sanity: 10ms to 10s
        v.iois.push(ioi);
        if (v.iois.length > WINDOW_SIZE) v.iois.shift();
      }
    }
    v.lastNoteTime = now;

    // Note buffer
    v.notes.push({ pc: pc, midi: midi, ts: now, ic: ic, volMult: volMult });
    if (v.notes.length > WINDOW_SIZE) v.notes.shift();

    // PC sequence (for MI, LZ — keep longer)
    v.pcs.push(pc);
    if (v.pcs.length > 500) v.pcs = v.pcs.slice(-300);

    // Register
    v.midiSum += midi;
    v.midiCount++;
    v.totalNotes++;
    var tess = TESSITURA[voice];
    if (tess && midi >= tess.min && midi <= tess.max) v.inRange++;

    // IC tracking
    v.icSum += ic;
    v.icSqSum += ic * ic;
    var icBin = Math.min(4, Math.floor(ic));
    if (icBin >= 0 && icBin < 5) v.icHist[icBin]++;

    // Metric adherence
    if (typeof BarTracker !== 'undefined' && BarTracker.getBarPhase) {
      var barPhase = BarTracker.getBarPhase();
      var beatPos = barPhase * 4; // 4 beats per bar
      var beatNum = Math.floor(beatPos);
      var weight = beatNum === 0 ? 1.0 : beatNum === 2 ? 0.6 : 0.3;
      var importance = volMult; // velocity as proxy for importance
      v.metricPairs.push({ importance: importance, weight: weight });
      if (v.metricPairs.length > WINDOW_SIZE) v.metricPairs.shift();
    }

    // ── Phrase start tracking (for onset synchrony) ──
    // Heuristic: if IOI > 500ms (gap), this is a new phrase start
    if (v.iois.length > 0 && v.iois[v.iois.length - 1] > 500) {
      _phraseStarts[voice] = now;
      _checkOnsetSynchrony(now);
    }

    // ── Ensemble tension sampling (every 5s) ──
    if (now - _lastTensionSample > TENSION_WINDOW_MS) {
      _sampleTension(now);
      _lastTensionSample = now;
    }

    // ── Engagement IC sampling (every 2s) ──
    if (now - _lastICSample > ENGAGEMENT_WINDOW_MS) {
      _sampleEngagement(now);
      _lastICSample = now;
    }
  }

  // ══════════════════════════════════════
  // REAL-TIME METRIC COMPUTATIONS
  // ══════════════════════════════════════

  // ── nPVI (Patel & Daniele 2003) ──
  function _computeNPVI(iois) {
    if (iois.length < 2) return 0;
    var sum = 0;
    for (var i = 0; i < iois.length - 1; i++) {
      var d1 = iois[i], d2 = iois[i + 1];
      var denom = (d1 + d2) / 2;
      if (denom > 0) sum += Math.abs(d1 - d2) / denom;
    }
    return 100 * sum / (iois.length - 1);
  }

  // ── Pearson correlation for metric adherence ──
  function _pearsonR(pairs) {
    if (pairs.length < 5) return 0;
    var n = pairs.length;
    var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (var i = 0; i < n; i++) {
      var x = pairs[i].importance, y = pairs[i].weight;
      sumX += x; sumY += y; sumXY += x * y;
      sumX2 += x * x; sumY2 += y * y;
    }
    var denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return denom > 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  }

  // ── Plomp & Levelt consonance (1965) ──
  function _midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
  function _criticalBandwidth(f) { return f < 500 ? 100 : f * 0.2; }
  function _plompLevelt(midi1, midi2) {
    var f1 = _midiToFreq(midi1), f2 = _midiToFreq(midi2);
    if (f1 > f2) { var tmp = f1; f1 = f2; f2 = tmp; }
    var df = f2 - f1;
    var B = _criticalBandwidth((f1 + f2) / 2);
    if (B <= 0) return 1;
    var s = df / B;
    // Dissonance curve: peaks at s ≈ 0.25, zero at s = 0 and s > 1.2
    var d = Math.exp(-3.5 * s) - Math.exp(-5.75 * s);
    return Math.max(0, 1 - Math.max(0, d) * 4.6); // normalize to 0-1 consonance
  }

  function _computeConsonance() {
    if (typeof VoiceManager === 'undefined') return 1;
    var allMidis = [];
    for (var pi = 0; pi < PITCHED_VOICES.length; pi++) {
      var vn = PITCHED_VOICES[pi];
      var v = _voice[vn];
      if (v.notes.length > 0) {
        var last = v.notes[v.notes.length - 1];
        if (Date.now() - last.ts < 2000) allMidis.push(last.midi);
      }
    }
    if (allMidis.length < 2) return 1;
    var sum = 0, count = 0;
    for (var i = 0; i < allMidis.length; i++) {
      for (var j = i + 1; j < allMidis.length; j++) {
        sum += _plompLevelt(allMidis[i], allMidis[j]);
        count++;
      }
    }
    return count > 0 ? sum / count : 1;
  }

  // ── Onset synchrony (Rasch 1979) ──
  function _checkOnsetSynchrony(now) {
    var recent = [];
    for (var v in _phraseStarts) {
      if (now - _phraseStarts[v] < 200) recent.push(_phraseStarts[v]);
    }
    if (recent.length < 2) return;
    var mean = 0;
    for (var i = 0; i < recent.length; i++) mean += recent[i];
    mean /= recent.length;
    var variance = 0;
    for (var i = 0; i < recent.length; i++) variance += Math.pow(recent[i] - mean, 2);
    var sd = Math.sqrt(variance / recent.length);
    _onsetAsyncSDs.push(sd);
    if (_onsetAsyncSDs.length > 50) _onsetAsyncSDs.shift();
  }

  // ── Tension curve (Herremans & Chew 2016 simplified) ──
  function _sampleTension(now) {
    var tension = 0;
    // Harmonic tension from MoodState
    if (typeof MoodState !== 'undefined' && MoodState.getCombinedTension) {
      var tSum = 0, tCount = 0;
      for (var i = 0; i < PITCHED_VOICES.length; i++) {
        tSum += MoodState.getCombinedTension(PITCHED_VOICES[i]) || 0;
        tCount++;
      }
      tension = tCount > 0 ? tSum / tCount : 0;
    }
    // Density component (note count in last 5s)
    var noteCount = 0;
    for (var vi = 0; vi < VOICES.length; vi++) {
      var v = _voice[VOICES[vi]];
      for (var ni = v.notes.length - 1; ni >= 0; ni--) {
        if (now - v.notes[ni].ts > TENSION_WINDOW_MS) break;
        noteCount++;
      }
    }
    var densityNorm = Math.min(1, noteCount / 30); // 30 notes/5s = full
    // Velocity component
    var velSum = 0, velCount = 0;
    for (var vi2 = 0; vi2 < VOICES.length; vi2++) {
      var v2 = _voice[VOICES[vi2]];
      for (var ni2 = v2.notes.length - 1; ni2 >= 0; ni2--) {
        if (now - v2.notes[ni2].ts > TENSION_WINDOW_MS) break;
        velSum += v2.notes[ni2].volMult;
        velCount++;
      }
    }
    var velNorm = velCount > 0 ? Math.min(1, velSum / velCount) : 0;
    // MorpheuS-style combined tension
    var combined = 0.4 * tension + 0.3 * densityNorm + 0.3 * velNorm;
    // Record section target energy for arc correlation (unsmoothed for clearer signal)
    // Maps section state to expected tension level (Lerdahl & Jackendoff 1983)
    var SECTION_TARGET = { STABLE: 0.3, BUILD: 0.6, PEAK: 0.9, RELEASE: 0.2, TRANSITION: 0.4 };
    var sectionEnergy = 0.5;
    if (typeof SectionTracker !== 'undefined' && SectionTracker.getState) {
      var secState = SectionTracker.getState().state || 'STABLE';
      sectionEnergy = SECTION_TARGET[secState] || 0.5;
    }
    _tensionSamples.push({ t: now, tension: combined, sectionEnergy: sectionEnergy, section: secState });
    if (_tensionSamples.length > 200) _tensionSamples.shift();
  }

  // ── Engagement proxy (Berlyne inverted-U) ──
  function _sampleEngagement(now) {
    var icTotal = 0, icCount = 0;
    for (var vi = 0; vi < PITCHED_VOICES.length; vi++) {
      var ic = 0;
      if (typeof MelodicExpectancy !== 'undefined' && MelodicExpectancy.getIC) {
        ic = MelodicExpectancy.getIC(PITCHED_VOICES[vi]) || 0;
      }
      icTotal += ic;
      icCount++;
    }
    var meanIC = icCount > 0 ? icTotal / icCount : 0;
    _icSamples.push({ t: now, ic: meanIC });
    if (_icSamples.length > 200) _icSamples.shift();
  }

  // ── Mutual information between two PC sequences ──
  function _computeMI(pcsA, pcsB) {
    var len = Math.min(pcsA.length, pcsB.length);
    if (len < 10) return 0;
    // Use last `len` elements
    var a = pcsA.slice(-len), b = pcsB.slice(-len);
    // Joint and marginal distributions
    var joint = {}, margA = new Float64Array(12), margB = new Float64Array(12);
    for (var i = 0; i < len; i++) {
      var key = a[i] * 12 + b[i];
      joint[key] = (joint[key] || 0) + 1;
      margA[a[i]]++;
      margB[b[i]]++;
    }
    var mi = 0;
    for (var k in joint) {
      var pxy = joint[k] / len;
      var ai = Math.floor(k / 12), bi = k % 12;
      var px = margA[ai] / len, py = margB[bi] / len;
      if (px > 0 && py > 0 && pxy > 0) {
        mi += pxy * Math.log2(pxy / (px * py));
      }
    }
    return Math.max(0, mi);
  }

  // ══════════════════════════════════════
  // POST-SESSION METRICS
  // ══════════════════════════════════════

  // ── Lempel-Ziv complexity (normalized) ──
  function _lzComplexity(seq) {
    if (seq.length < 5) return 0;
    var n = seq.length;
    var dict = {};
    var w = '' + seq[0];
    var count = 1;
    for (var i = 1; i < n; i++) {
      var c = '' + seq[i];
      var wc = w + ',' + c;
      if (dict[wc]) {
        w = wc;
      } else {
        dict[wc] = true;
        count++;
        w = c;
      }
    }
    // Normalize: theoretical max for random sequence is n / log2(n)
    var maxC = n / Math.max(1, Math.log2(n));
    return count / maxC;
  }

  // ── Interval distribution power-law fit (R²) ──
  function _intervalFit(pcs) {
    if (pcs.length < 10) return 0;
    var hist = new Array(13).fill(0); // intervals 0-12
    for (var i = 1; i < pcs.length; i++) {
      var interval = Math.abs(pcs[i] - pcs[i - 1]);
      if (interval > 6) interval = 12 - interval;
      hist[interval]++;
    }
    // Rank-frequency: sort by count descending
    var ranked = [];
    for (var j = 0; j <= 12; j++) {
      if (hist[j] > 0) ranked.push(hist[j]);
    }
    ranked.sort(function(a, b) { return b - a; });
    if (ranked.length < 3) return 0;
    // Log-log linear regression
    var logR = [], logF = [];
    for (var k = 0; k < ranked.length; k++) {
      logR.push(Math.log(k + 1));
      logF.push(Math.log(ranked[k]));
    }
    // R² of log-log fit
    var n = logR.length;
    var sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
    for (var m = 0; m < n; m++) {
      sx += logR[m]; sy += logF[m]; sxy += logR[m] * logF[m];
      sx2 += logR[m] * logR[m]; sy2 += logF[m] * logF[m];
    }
    var num = n * sxy - sx * sy;
    var den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
    var r = den > 0 ? num / den : 0;
    return r * r; // R²
  }

  // ── Contour analysis (Parsons code trigram KL divergence) ──
  function _contourKL(pcs) {
    if (pcs.length < 5) return 0;
    // Build Parsons code: U=0, D=1, R=2
    var contour = [];
    for (var i = 1; i < pcs.length; i++) {
      contour.push(pcs[i] > pcs[i - 1] ? 0 : pcs[i] < pcs[i - 1] ? 1 : 2);
    }
    // Trigram distribution
    var trigrams = {};
    var total = 0;
    for (var j = 0; j < contour.length - 2; j++) {
      var key = contour[j] * 9 + contour[j + 1] * 3 + contour[j + 2];
      trigrams[key] = (trigrams[key] || 0) + 1;
      total++;
    }
    if (total < 5) return 0;
    // Reference: uniform distribution (1/27 per trigram)
    var kl = 0;
    var uniform = 1 / 27;
    for (var k in trigrams) {
      var p = trigrams[k] / total;
      kl += p * Math.log2(p / uniform);
    }
    return Math.max(0, kl);
  }

  // ── Cyclic tension quality (replaces formClarity + tensionArc) ──
  // Measures dramatic arc quality via three complementary signals:
  // 1. Tension Range (Farbood 2012): max-min across all samples
  // 2. Cycle Quality (Lerdahl & Jackendoff 1983): complete tension-relaxation cycles
  // 3. Local Section Tracking (Herremans & Chew 2016): per-section directional compliance
  function _cyclicTensionQuality() {
    if (_tensionSamples.length < 10) return { score: 0, range: 0, cycleCount: 0, avgAmplitude: 0, localSectionR: 0 };
    var vals = _tensionSamples.map(function(s) { return s.tension; });
    var n = vals.length;

    // 1. Tension Range — simple max-min, scored 0-1 (range 0.3+ = full score)
    var tMin = Infinity, tMax = -Infinity;
    for (var i = 0; i < n; i++) {
      if (vals[i] < tMin) tMin = vals[i];
      if (vals[i] > tMax) tMax = vals[i];
    }
    var range = tMax - tMin;
    var rangeScore = Math.min(1.0, range / 0.3); // 0.3 range = full score

    // 2. Cycle Quality — detect local min/max, count complete cycles, measure amplitude
    // Smooth with 3-sample window to avoid noise-triggered cycles
    var smoothed = [];
    for (var i = 0; i < n; i++) {
      var lo = Math.max(0, i - 1), hi = Math.min(n - 1, i + 1);
      smoothed.push((vals[lo] + vals[i] + vals[hi]) / (hi - lo + 1));
    }
    // Find local extrema (minima and maxima)
    var extrema = []; // {idx, val, type: 'min'|'max'}
    for (var i = 1; i < smoothed.length - 1; i++) {
      if (smoothed[i] < smoothed[i - 1] && smoothed[i] <= smoothed[i + 1]) {
        extrema.push({ idx: i, val: smoothed[i], type: 'min' });
      } else if (smoothed[i] > smoothed[i - 1] && smoothed[i] >= smoothed[i + 1]) {
        extrema.push({ idx: i, val: smoothed[i], type: 'max' });
      }
    }
    // Collapse consecutive same-type extrema (keep most extreme)
    var filtered = [];
    for (var i = 0; i < extrema.length; i++) {
      if (filtered.length === 0 || filtered[filtered.length - 1].type !== extrema[i].type) {
        filtered.push(extrema[i]);
      } else {
        var prev = filtered[filtered.length - 1];
        if (extrema[i].type === 'max' && extrema[i].val > prev.val) filtered[filtered.length - 1] = extrema[i];
        if (extrema[i].type === 'min' && extrema[i].val < prev.val) filtered[filtered.length - 1] = extrema[i];
      }
    }
    // Count complete cycles (min→max→min) and measure amplitude
    var cycleCount = 0;
    var amplitudeSum = 0;
    for (var i = 0; i + 2 < filtered.length; i++) {
      if (filtered[i].type === 'min' && filtered[i + 1].type === 'max' && filtered[i + 2].type === 'min') {
        var amp = filtered[i + 1].val - (filtered[i].val + filtered[i + 2].val) / 2;
        if (amp > 0.05) { // minimum 0.05 amplitude to count as meaningful cycle
          cycleCount++;
          amplitudeSum += amp;
        }
      }
    }
    var avgAmplitude = cycleCount > 0 ? amplitudeSum / cycleCount : 0;
    // Score: reward both cycle count AND amplitude (3 cycles at 0.15 amp = good)
    var cycleScore = Math.min(1.0, (cycleCount / 3) * Math.min(1.0, avgAmplitude / 0.12));

    // 3. Local Section Tracking — per-section Pearson R (within BUILD: is tension rising?)
    // Groups samples by section, computes directional compliance within each span
    var sectionSpans = {}; // {section: [{idx, tension}]}
    for (var i = 0; i < _tensionSamples.length; i++) {
      var sec = _tensionSamples[i].section || 'STABLE';
      if (!sectionSpans[sec]) sectionSpans[sec] = [];
      sectionSpans[sec].push({ idx: i, tension: _tensionSamples[i].tension });
    }
    var EXPECTED_DIR = { BUILD: 1, PEAK: 0, RELEASE: -1, STABLE: 0, TRANSITION: 0 };
    var localSum = 0, localCount = 0;
    for (var sec in sectionSpans) {
      var span = sectionSpans[sec];
      if (span.length < 3) continue;
      var expectedDir = EXPECTED_DIR[sec] || 0;
      if (expectedDir === 0) continue; // skip sections with no expected direction
      // Compute trend direction via linear regression slope sign
      var sn = span.length, sx = 0, sy = 0, sxy = 0, sx2 = 0;
      for (var j = 0; j < sn; j++) {
        sx += j; sy += span[j].tension; sxy += j * span[j].tension; sx2 += j * j;
      }
      var slope = (sn * sxy - sx * sy) / (sn * sx2 - sx * sx || 1);
      // Score: +1 if slope matches expected direction, -1 if opposite, scaled by magnitude
      var compliance = (slope > 0 ? 1 : -1) === expectedDir ? 1 : 0;
      localSum += compliance;
      localCount++;
    }
    var localSectionR = localCount > 0 ? localSum / localCount : 0.5;

    // Composite: range(40%) + cycles(35%) + local tracking(25%)
    var composite = 0.40 * rangeScore + 0.35 * cycleScore + 0.25 * localSectionR;
    return {
      score: Math.max(0, Math.min(1, composite)),
      range: +range.toFixed(3),
      cycleCount: cycleCount,
      avgAmplitude: +avgAmplitude.toFixed(3),
      localSectionR: +localSectionR.toFixed(3)
    };
  }

  // ── Developmental continuity (LZ trend over segments) ──
  function _developmentalR2() {
    // Split all notes into 10s segments, compute LZ per segment
    var allNotes = [];
    for (var vi = 0; vi < PITCHED_VOICES.length; vi++) {
      allNotes = allNotes.concat(_voice[PITCHED_VOICES[vi]].pcs);
    }
    if (allNotes.length < 30) return 0;
    var segSize = Math.max(10, Math.floor(allNotes.length / 8));
    var segments = [];
    for (var i = 0; i + segSize <= allNotes.length; i += segSize) {
      segments.push(_lzComplexity(allNotes.slice(i, i + segSize)));
    }
    if (segments.length < 3) return 0;
    // Linear regression R²
    var n = segments.length;
    var sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
    for (var j = 0; j < n; j++) {
      sx += j; sy += segments[j]; sxy += j * segments[j];
      sx2 += j * j; sy2 += segments[j] * segments[j];
    }
    var num = n * sxy - sx * sy;
    var den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
    var r = den > 0 ? num / den : 0;
    return r * r;
  }

  // ══════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════

  function getPerVoiceReport(voice) {
    var v = _voice[voice];
    if (!v || v.totalNotes === 0) return null;
    var n = v.totalNotes;
    var icMean = n > 0 ? v.icSum / n : 0;
    var icVar = n > 1 ? (v.icSqSum / n - icMean * icMean) : 0;
    return {
      noteCount: n,
      icMean: +icMean.toFixed(3),
      icVariance: +Math.max(0, icVar).toFixed(3),
      icDistribution: v.icHist.slice(),
      nPVI: +_computeNPVI(v.iois).toFixed(1),
      registerCompliance: n > 0 ? +(v.inRange / n).toFixed(3) : 0,
      registerMean: v.midiCount > 0 ? +(v.midiSum / v.midiCount).toFixed(1) : 0,
      metricAdherence: +_pearsonR(v.metricPairs).toFixed(3)
    };
  }

  function getReport() {
    var perVoice = {};
    for (var vi = 0; vi < VOICES.length; vi++) {
      var r = getPerVoiceReport(VOICES[vi]);
      if (r) perVoice[VOICES[vi]] = r;
    }

    // Ensemble metrics
    var onsetSD = 0;
    if (_onsetAsyncSDs.length > 0) {
      var sum = 0;
      for (var i = 0; i < _onsetAsyncSDs.length; i++) sum += _onsetAsyncSDs[i];
      onsetSD = sum / _onsetAsyncSDs.length;
    }

    // Register spread
    var means = [];
    for (var vi2 = 0; vi2 < PITCHED_VOICES.length; vi2++) {
      var vv = _voice[PITCHED_VOICES[vi2]];
      if (vv.midiCount > 0) means.push(vv.midiSum / vv.midiCount);
    }
    var minSpread = Infinity;
    for (var i2 = 0; i2 < means.length; i2++) {
      for (var j2 = i2 + 1; j2 < means.length; j2++) {
        var d = Math.abs(means[i2] - means[j2]);
        if (d < minSpread) minSpread = d;
      }
    }
    if (!isFinite(minSpread)) minSpread = 0;

    // Voice independence (MI)
    var voiceIndependence = {};
    for (var pi = 0; pi < VOICE_PAIRS.length; pi++) {
      var pair = VOICE_PAIRS[pi];
      var mi = _computeMI(_voice[pair[0]].pcs, _voice[pair[1]].pcs);
      voiceIndependence[pair[0] + '-' + pair[1]] = +mi.toFixed(3);
    }

    // Engagement score (% time IC in sweet spot 1.0-2.5 bits)
    var engagementInSpot = 0;
    for (var ei = 0; ei < _icSamples.length; ei++) {
      if (_icSamples[ei].ic >= 1.0 && _icSamples[ei].ic <= 2.5) engagementInSpot++;
    }
    var engagementScore = _icSamples.length > 0 ? engagementInSpot / _icSamples.length : 0;

    // Tension arc: cyclic tension quality (v8.16.0 — replaces linear Pearson R)
    // Composite of tension range, cycle quality, and local section tracking.
    // Cyclic tension (build→resolve→build) now scores well instead of ~0.
    var _tensionQuality = _cyclicTensionQuality();
    var tensionArcCorr = _tensionQuality.score;

    return {
      perVoice: perVoice,
      ensemble: {
        onsetSynchronySD: +onsetSD.toFixed(1),
        registerSpread: +minSpread.toFixed(1),
        consonanceScore: +_computeConsonance().toFixed(3),
        tensionArcCorrelation: +tensionArcCorr.toFixed(3),
        engagementScore: +engagementScore.toFixed(3),
        voiceIndependence: voiceIndependence
      }
    };
  }

  function getFullAnalysis() {
    var report = getReport();
    var postSession = {
      intervalFit: {},
      lzComplexity: {},
      contourKL: {},
      developmentalR2: +_developmentalR2().toFixed(3),
      tensionArcDetail: _cyclicTensionQuality()
    };
    for (var vi = 0; vi < PITCHED_VOICES.length; vi++) {
      var vn = PITCHED_VOICES[vi];
      var pcs = _voice[vn].pcs;
      postSession.intervalFit[vn] = +_intervalFit(pcs).toFixed(3);
      postSession.lzComplexity[vn] = +_lzComplexity(pcs).toFixed(3);
      postSession.contourKL[vn] = +_contourKL(pcs).toFixed(3);
    }
    report.postSession = postSession;
    return report;
  }

  function reset() {
    for (var vi = 0; vi < VOICES.length; vi++) {
      _voice[VOICES[vi]] = _initVoice(VOICES[vi]);
    }
    _tensionSamples = [];
    _icSamples = [];
    _phraseStarts = {};
    _onsetAsyncSDs = [];
    _lastTensionSample = 0;
    _lastICSample = 0;
  }

  // ══════════════════════════════════════
  // COMPOSITE MUSICALITY INDEX (MI)
  // ══════════════════════════════════════
  // Single 0-100 score aggregating all metrics.
  // Each metric scored via trapezoidal membership against its target range.
  // Weights reflect psychoacoustic importance (Berlyne 1971, Farbood 2012, Pearce 2005).
  // Per-metric breakdown preserved for debugging.

  // Trapezoidal scorer: 100 inside [lo, hi], linear falloff over margin, 0 beyond
  function _scoreMetric(value, lo, hi, margin) {
    if (value >= lo && value <= hi) return 100;
    if (value < lo) {
      var dist = lo - value;
      return Math.max(0, 100 * (1 - dist / margin));
    }
    // value > hi
    var dist2 = value - hi;
    return Math.max(0, 100 * (1 - dist2 / margin));
  }

  var _METRIC_DEFS = [
    // IC per voice — Berlyne sweet spot 1.0-2.5 bits
    { key: 'bassIC',        w: 0.08, lo: 1.0, hi: 2.5, margin: 1.0,
      extract: function(r) { return r.perVoice.bass ? r.perVoice.bass.icMean : null; } },
    { key: 'rhythmIC',      w: 0.08, lo: 1.0, hi: 2.5, margin: 1.0,
      extract: function(r) { return r.perVoice.rhythm ? r.perVoice.rhythm.icMean : null; } },
    { key: 'soloistIC',     w: 0.08, lo: 1.0, hi: 2.5, margin: 1.0,
      extract: function(r) { return r.perVoice.soloist ? r.perVoice.soloist.icMean : null; } },
    { key: 'leadIC',        w: 0.08, lo: 0, hi: 2.5, margin: 1.5,
      extract: function(r) { return r.perVoice.lead ? r.perVoice.lead.icMean : null; } },
    // Engagement — master metric (Berlyne inverted-U)
    { key: 'engagement',    w: 0.15, lo: 0.4, hi: 1.0, margin: 0.3,
      extract: function(r) { return r.ensemble.engagementScore; } },
    // Tension arc — cyclic dramatic quality (v8.16.0: range + cycles + local section tracking)
    { key: 'tensionArc',    w: 0.12, lo: 0.3, hi: 1.0, margin: 0.3,
      extract: function(r) { return r.ensemble.tensionArcCorrelation; } },
    // Voice independence — mutual information (lower = more independent)
    { key: 'rhythmSoloMI',  w: 0.06, lo: 0, hi: 0.4, margin: 0.4,
      extract: function(r) { return r.ensemble.voiceIndependence['rhythm-soloist']; } },
    { key: 'bassRhythmMI',  w: 0.06, lo: 0, hi: 0.4, margin: 0.4,
      extract: function(r) { return r.ensemble.voiceIndependence['bass-rhythm']; } },
    // Register spread — voice separation (ST)
    { key: 'registerSpread', w: 0.06, lo: 8, hi: 30, margin: 4,
      extract: function(r) { return r.ensemble.registerSpread; } },
    // Consonance — harmonic coherence (Plomp & Levelt 1965)
    { key: 'consonance',    w: 0.06, lo: 0.6, hi: 1.0, margin: 0.3,
      extract: function(r) { return r.ensemble.consonanceScore; } },
    // Developmental continuity — LZ trend coherence
    { key: 'devContinuity', w: 0.06, lo: 0.3, hi: 1.0, margin: 0.3,
      extract: function(r) { return r.postSession ? r.postSession.developmentalR2 : null; } },
    // Onset synchrony — ensemble timing (Rasch 1979, lower SD = better)
    { key: 'onsetSync',     w: 0.05, lo: 0, hi: 50, margin: 30,
      extract: function(r) { return r.ensemble.onsetSynchronySD; } }
  ];

  function getMI() {
    var report = getFullAnalysis();
    var weightedSum = 0;
    var totalWeight = 0;
    var breakdown = {};
    var passCount = 0;
    var failCount = 0;
    var activeCount = 0;

    for (var i = 0; i < _METRIC_DEFS.length; i++) {
      var def = _METRIC_DEFS[i];
      var value = null;
      try { value = def.extract(report); } catch (e) {}
      if (value === null || value === undefined || isNaN(value)) {
        breakdown[def.key] = { value: null, score: null, weight: def.w, target: [def.lo, def.hi], skipped: true };
        continue;
      }
      var score = _scoreMetric(value, def.lo, def.hi, def.margin);
      var pass = (value >= def.lo && value <= def.hi);
      breakdown[def.key] = {
        value: +value.toFixed(3),
        score: Math.round(score),
        weight: def.w,
        target: [def.lo, def.hi],
        pass: pass
      };
      weightedSum += score * def.w;
      totalWeight += def.w;
      activeCount++;
      if (pass) passCount++; else failCount++;
    }

    var composite = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    var grade = composite >= 80 ? 'A' : composite >= 60 ? 'B' : composite >= 40 ? 'C' : composite >= 20 ? 'D' : 'F';

    return {
      score: composite,
      grade: grade,
      breakdown: breakdown,
      passCount: passCount,
      failCount: failCount,
      totalMetrics: activeCount
    };
  }

  // ── Subscribe to noteProduced ──
  if (typeof EventBus !== 'undefined') {
    EventBus.on('noteProduced', function(data) {
      _onNote(data);
    });
  }

  return {
    getReport:          getReport,
    getPerVoiceReport:  getPerVoiceReport,
    getFullAnalysis:    getFullAnalysis,
    getMI:              getMI,
    reset:              reset
  };

})();

console.log('%cMusicMetrics loaded (16 quality metrics: 10 real-time + 6 post-session)', 'color:#a8e;font-family:monospace');

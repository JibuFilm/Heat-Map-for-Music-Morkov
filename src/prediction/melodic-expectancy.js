'use strict';
// ═══ MELODIC EXPECTANCY — IDyOM-inspired expectation engine (v6 Phase 7B) ═══
//
// Per-voice expectation model combining:
//   - LTM (Long-Term Model): pre-trained n-gram tries from lexicon corpus
//   - STM (Short-Term Model): session-built tries from observed notes
//   - I-R prior: Schellenberg/Huron melodic expectancy (existing)
//
// Viewpoints (Pearce & Wiggins 2006):
//   - Pitch interval (signed, mapped to 0-24)
//   - Scale degree (0-11)
//   - Contour (up=1, down=0, same=2)
//
// Combination: Entropy-weighted geometric mean (Conklin & Witten 1995)
//   - Within viewpoints: LTM × STM combined by entropy weight
//   - Across viewpoints: geometric mean weighted by inverse entropy
//
// Outputs:
//   - P(next|context): 12-element probability distribution
//   - IC (Information Content): -log2(P(actual|context)) — surprisal
//   - Entropy: Shannon entropy of prediction distribution — uncertainty
//
// Depends on: ppm-trie.js, event-bus.js, key-belief.js (for scale degree)
// Load order: after ppm-trie.js, before belief-state.js

var MelodicExpectancy = (function() {

  var VOICES = ['bass', 'rhythm', 'soloist', 'lead', 'percussion', 'human'];
  var PITCHED_VOICES = ['bass', 'rhythm', 'soloist', 'lead', 'human'];
  var VP_NAMES = ['interval', 'sd', 'contour'];
  // v8.6.0: IOI viewpoint tracked separately (not mixed into pitch prediction)
  var IOI_VP = 'ioi';

  // Alphabet sizes for each viewpoint
  var ALPHABET = { interval: 25, sd: 12, contour: 3, ioi: 16 };

  // PPMTrie max depths (per viewpoint)
  var MAX_DEPTH = { interval: 5, sd: 5, contour: 6, ioi: 4 };

  // v8.6.0: IOI quantization (Fraisse 1982: logarithmic duration perception)
  // 16-bin logarithmic, range 0.125 to 8.0. Bin 6 = ratio 1.0 (quarter note reference).
  var IOI_BINS = 16, IOI_LOG_SCALE = 2, IOI_OFFSET = 6;
  function _quantizeIOI(r) {
    return Math.max(0, Math.min(IOI_BINS - 1,
      Math.floor(Math.log2(Math.max(0.125, Math.min(8.0, r))) * IOI_LOG_SCALE + IOI_OFFSET)));
  }
  function _dequantizeIOI(bin) { return Math.pow(2, (bin - IOI_OFFSET) / IOI_LOG_SCALE); }

  // LTM weight balance vs STM (when both available)
  // Both use entropy-weighted combination — this is the default prior
  var LTM_BASE_WEIGHT = 0.6;  // slight LTM preference (enculturation)

  // ── Pre-allocated scratch buffers (reused across calls to avoid GC pressure) ──
  var _scratchCombined = new Float64Array(12);        // reused by _combineViewpoints
  var _scratchLTMSTM = {                              // reused by _combineLTMSTM
    interval: new Float64Array(ALPHABET.interval),
    sd:       new Float64Array(ALPHABET.sd),
    contour:  new Float64Array(ALPHABET.contour),
    ioi:      new Float64Array(ALPHABET.ioi)
  };
  // Pre-allocated uniform fallback distributions (read-only, never modified)
  var _uniformInterval = new Float64Array(ALPHABET.interval);
  var _uniformSD       = new Float64Array(ALPHABET.sd);
  var _uniformContour  = new Float64Array(ALPHABET.contour);
  var _uniformIOI      = new Float64Array(ALPHABET.ioi);
  // v8.6.0: IOI prediction scratch buffer (separate from pitch distribution)
  var _scratchIOI      = new Float64Array(ALPHABET.ioi);
  (function() {
    for (var i = 0; i < ALPHABET.interval; i++) _uniformInterval[i] = 1.0 / ALPHABET.interval;
    for (var i = 0; i < ALPHABET.sd; i++)       _uniformSD[i]       = 1.0 / ALPHABET.sd;
    for (var i = 0; i < ALPHABET.contour; i++)   _uniformContour[i] = 1.0 / ALPHABET.contour;
    for (var i = 0; i < ALPHABET.ioi; i++)       _uniformIOI[i]     = 1.0 / ALPHABET.ioi;
  })();

  // ── Per-voice state ──
  var _state = {};  // _state[voice] = { stm: {vp: PPMTrie}, ltm: {vp: PPMTrie}, prev: {pc, interval, sd, contour}, lastIC, lastEntropy, lastDist }

  function _initVoice(voice) {
    return {
      stm: {
        interval: new PPMTrie(MAX_DEPTH.interval),
        sd:       new PPMTrie(MAX_DEPTH.sd),
        contour:  new PPMTrie(MAX_DEPTH.contour),
        ioi:      new PPMTrie(MAX_DEPTH.ioi)
      },
      ltm: {
        interval: null,  // loaded from JSON
        sd:       null,
        contour:  null,
        ioi:      null
      },
      prev: { pc: null, midi: null, lastNoteTime: null },
      lastIC: 0,
      lastEntropy: 2.0,  // high entropy = maximum uncertainty
      lastDist: new Float64Array(12),
      // v8.6.0: IOI prediction state (separate from pitch)
      lastIOIDist: new Float64Array(ALPHABET.ioi),
      lastIOIEntropy: 4.0  // log2(16) = maximum uncertainty
    };
  }

  function _init() {
    for (var i = 0; i < VOICES.length; i++) {
      _state[VOICES[i]] = _initVoice(VOICES[i]);
    }
  }

  // ── Shannon entropy of a distribution ──
  function _entropy(dist) {
    var h = 0;
    for (var i = 0; i < dist.length; i++) {
      if (dist[i] > 1e-10) h -= dist[i] * Math.log2(dist[i]);
    }
    return h;
  }

  // ── Normalize distribution in-place ──
  function _normalize(dist) {
    var sum = 0;
    for (var i = 0; i < dist.length; i++) sum += dist[i];
    if (sum < 1e-10) {
      // Uniform fallback
      var u = 1.0 / dist.length;
      for (var i = 0; i < dist.length; i++) dist[i] = u;
      return;
    }
    for (var i = 0; i < dist.length; i++) dist[i] /= sum;
  }

  // ── Combine viewpoint distributions via entropy-weighted geometric mean ──
  // Maps from viewpoint-specific alphabets to 12-PC space, then combines.
  // Writes into pre-allocated _scratchCombined, then copies to caller's lastDist.
  function _combineViewpoints(intervalDist, sdDist, contourDist, keyC, prevPC) {
    var combined = _scratchCombined;
    for (var ci = 0; ci < 12; ci++) combined[ci] = 0;

    // Entropy weights: lower entropy → higher confidence → more weight
    var hI = _entropy(intervalDist);
    var hS = _entropy(sdDist);
    var hC = _entropy(contourDist);
    var wI = 1.0 / (hI + 1.0);
    var wS = 1.0 / (hS + 1.0);
    var wC = 1.0 / (hC + 1.0);
    var wSum = wI + wS + wC;
    if (wSum < 1e-10) wSum = 1;

    for (var pc = 0; pc < 12; pc++) {
      // Map PC to each viewpoint's index
      var interval = prevPC !== null ? ((pc - prevPC) % 12 + 12) % 12 : 0;
      if (interval > 6) interval -= 12;
      var iIdx = interval + 12;  // 0-24
      var sdIdx = ((pc - keyC) % 12 + 12) % 12;
      var cIdx = prevPC !== null ? (pc > prevPC ? 1 : pc < prevPC ? 0 : 2) : 1;

      // Geometric mean weighted by inverse entropy
      var pI = Math.max(1e-10, intervalDist[iIdx] || 1e-10);
      var pS = Math.max(1e-10, sdDist[sdIdx] || 1e-10);
      var pC = Math.max(1e-10, contourDist[cIdx] || 1e-10);

      combined[pc] = Math.pow(pI, wI / wSum) * Math.pow(pS, wS / wSum) * Math.pow(pC, wC / wSum);
    }

    _normalize(combined);
    return combined;
  }

  // ── Combine LTM and STM for a single viewpoint ──
  // Uses pre-allocated scratch buffer keyed by viewpoint name to avoid allocation.
  function _combineLTMSTM(ltmDist, stmDist, vpName) {
    if (!ltmDist && !stmDist) return null;
    if (!ltmDist) return stmDist;
    if (!stmDist) return ltmDist;

    var hLTM = _entropy(ltmDist);
    var hSTM = _entropy(stmDist);
    var wLTM = 1.0 / (hLTM + 1.0);
    var wSTM = 1.0 / (hSTM + 1.0);
    var wT = wLTM + wSTM;
    if (wT < 1e-10) wT = 1;

    var result = _scratchLTMSTM[vpName];
    for (var i = 0; i < result.length; i++) {
      var pL = Math.max(1e-10, ltmDist[i]);
      var pS = Math.max(1e-10, stmDist[i]);
      result[i] = Math.pow(pL, wLTM / wT) * Math.pow(pS, wSTM / wT);
    }
    _normalize(result);
    return result;
  }

  // ── Observe a note for a voice (updates STM, computes IC) ──
  function _observe(voice, pc, midi) {
    var s = _state[voice];
    if (!s) return;

    var keyC = (typeof SharedState !== 'undefined') ? SharedState.keyC : 0;

    if (s.prev.pc !== null) {
      var interval = ((pc - s.prev.pc) % 12 + 12) % 12;
      if (interval > 6) interval -= 12;
      var sd = ((pc - keyC) % 12 + 12) % 12;
      var contour = pc > s.prev.pc ? 1 : pc < s.prev.pc ? 0 : 2;

      // Update STM tries
      s.stm.interval.observe(interval + 12);
      s.stm.sd.observe(sd);
      s.stm.contour.observe(contour);

      // Compute IC from the prediction that was active before this note
      if (s.lastDist && s.lastDist[pc] > 1e-10) {
        s.lastIC = -Math.log2(s.lastDist[pc]);
      } else {
        s.lastIC = -Math.log2(1.0 / 12);  // uniform surprise
      }
    }

    s.prev.pc = pc;
    s.prev.midi = midi || pc + 60;

    // Recompute prediction distribution for next note
    _updatePrediction(voice);
  }

  // ── Recompute prediction distribution for a voice ──
  function _updatePrediction(voice) {
    var s = _state[voice];
    if (!s) return;

    var keyC = (typeof SharedState !== 'undefined') ? SharedState.keyC : 0;

    // Get predictions from each viewpoint (LTM+STM combined)
    var intervalDist = _getViewpointDist(s, 'interval');
    var sdDist = _getViewpointDist(s, 'sd');
    var contourDist = _getViewpointDist(s, 'contour');

    if (!intervalDist && !sdDist && !contourDist) {
      // No data yet — uniform
      for (var i = 0; i < 12; i++) s.lastDist[i] = 1.0 / 12;
      s.lastEntropy = Math.log2(12);
      return;
    }

    // Fallback to pre-allocated uniform distributions (read-only)
    if (!intervalDist) intervalDist = _uniformInterval;
    if (!sdDist)       sdDist       = _uniformSD;
    if (!contourDist)  contourDist  = _uniformContour;

    // Combine viewpoints into 12-PC distribution (writes into _scratchCombined)
    var combined = _combineViewpoints(intervalDist, sdDist, contourDist, keyC, s.prev.pc);
    // Copy result into per-voice lastDist (avoids sharing the scratch buffer across voices)
    for (var ci = 0; ci < 12; ci++) s.lastDist[ci] = combined[ci];
    s.lastEntropy = _entropy(s.lastDist);
  }

  // ── Get combined LTM+STM distribution for a viewpoint ──
  function _getViewpointDist(state, vp) {
    var alphaSize = ALPHABET[vp];
    var stmDist = state.stm[vp] ? state.stm[vp].predict(alphaSize) : null;
    var ltmDist = null;
    if (state.ltm[vp]) {
      // LTM trie: clone context from STM to align, then predict
      ltmDist = state.ltm[vp].predict(alphaSize);
    }
    return _combineLTMSTM(ltmDist, stmDist, vp);
  }

  // ── Load LTM tries from JSON data (per role) ──
  // data: { interval: {trie JSON}, sd: {trie JSON}, contour: {trie JSON} }
  function loadLTM(voice, data) {
    var s = _state[voice];
    if (!s || !data) return;

    for (var i = 0; i < VP_NAMES.length; i++) {
      var vp = VP_NAMES[i];
      if (data[vp]) {
        s.ltm[vp] = new PPMTrie(MAX_DEPTH[vp]);
        s.ltm[vp].loadFromJSON(data[vp]);
      }
    }
    // v8.6.0: Load IOI viewpoint LTM (separate from pitch viewpoints)
    if (data[IOI_VP]) {
      s.ltm[IOI_VP] = new PPMTrie(MAX_DEPTH[IOI_VP]);
      s.ltm[IOI_VP].loadFromJSON(data[IOI_VP]);
    }
  }

  // ── Public API ──

  // Get prediction distribution for next note
  function predict(voice) {
    var s = _state[voice];
    if (!s) return { dist: new Float64Array(12), entropy: Math.log2(12), topPC: 0 };

    var topPC = 0, topP = 0;
    for (var i = 0; i < 12; i++) {
      if (s.lastDist[i] > topP) { topP = s.lastDist[i]; topPC = i; }
    }

    return {
      dist: s.lastDist,
      entropy: s.lastEntropy,
      topPC: topPC,
      confidence: 1.0 / (s.lastEntropy + 1.0)  // inverse entropy as confidence
    };
  }

  // Feed actual note, returns IC (surprisal)
  function observe(voice, pc, midi) {
    _observe(voice, pc, midi);
    var s = _state[voice];
    return s ? s.lastIC : 0;
  }

  // Get current prediction uncertainty
  function getEntropy(voice) {
    var s = _state[voice];
    return s ? s.lastEntropy : Math.log2(12);
  }

  // Get last observation's surprisal
  function getIC(voice) {
    var s = _state[voice];
    return s ? s.lastIC : 0;
  }

  // Check if LTM is loaded for a voice
  function isReady(voice) {
    var s = _state[voice];
    if (!s) return false;
    return s.ltm.interval !== null || s.ltm.sd !== null || s.ltm.contour !== null;
  }

  // v8.6.0: IOI viewpoint — observe and predict duration patterns
  // Separate from pitch prediction (combined at scoring layer via product scoring).

  // Observe an IOI ratio (feed into STM trie for learning)
  function observeIOI(voice, ioiRatio) {
    var s = _state[voice];
    if (!s || !ioiRatio || ioiRatio <= 0) return;
    var bin = _quantizeIOI(ioiRatio);
    s.stm.ioi.observe(bin);
  }

  // Predict next IOI distribution (returns 16-bin distribution)
  function predictIOI(voice) {
    var s = _state[voice];
    if (!s) return { dist: _uniformIOI, entropy: Math.log2(IOI_BINS), topBin: 6, topRatio: 1.0 };

    // Get LTM+STM combined IOI distribution
    var dist = _getViewpointDist(s, IOI_VP);
    if (!dist) dist = _uniformIOI;

    // Copy to per-voice buffer to avoid scratch sharing
    for (var i = 0; i < IOI_BINS; i++) s.lastIOIDist[i] = dist[i];

    // Compute entropy and top bin
    var topBin = 6, topP = 0, H = 0;
    for (var i = 0; i < IOI_BINS; i++) {
      if (s.lastIOIDist[i] > topP) { topP = s.lastIOIDist[i]; topBin = i; }
      if (s.lastIOIDist[i] > 1e-10) H -= s.lastIOIDist[i] * Math.log2(s.lastIOIDist[i]);
    }
    s.lastIOIEntropy = H;

    return {
      dist: s.lastIOIDist,
      entropy: H,
      topBin: topBin,
      topRatio: _dequantizeIOI(topBin),
      confidence: 1.0 / (H + 1.0)
    };
  }

  // Expose quantization functions for external use (phrase-generator, scoring)
  function quantizeIOI(r) { return _quantizeIOI(r); }
  function dequantizeIOI(bin) { return _dequantizeIOI(bin); }

  // Check if STM has enough data to be meaningful
  function hasSTMData(voice) {
    var s = _state[voice];
    if (!s) return false;
    return s.prev.pc !== null;
  }

  // ── Seed STM from lexicon phrases (pre-warm for lower IC at session start) ──
  // Feed scale-degree sequences through the STM tries so the model has context
  // from note 1. The seed dilutes naturally as real observations accumulate.
  // phrases: array of { sd: [0,2,4,5,7,...] } lexicon entries
  function seedSTM(voice, phrases, keyC) {
    if (!phrases || phrases.length === 0) return;
    var s = _state[voice];
    if (!s) return;
    var k = keyC || 0;
    // Feed a sample of phrases to build initial context.
    // 50 phrases (~250 notes) is the sweet spot — enough for structure,
    // not so many that the trie becomes diffuse (120 tested, caused MI regression).
    var maxPhrases = Math.min(50, phrases.length);
    for (var pi = 0; pi < maxPhrases; pi++) {
      var sd = phrases[pi].sd;
      if (!sd || sd.length < 2) continue;
      for (var ni = 0; ni < sd.length; ni++) {
        var pc = (sd[ni] + k) % 12;
        if (pc < 0) pc += 12;
        _observe(voice, pc, pc + 60);
      }
      // v8.6.0: Feed IOI ratios from phrase into IOI STM
      var ioi = phrases[pi].ioi_ratios;
      if (ioi && ioi.length > 0) {
        for (var ii = 0; ii < ioi.length; ii++) {
          if (ioi[ii] > 0) s.stm.ioi.observe(_quantizeIOI(ioi[ii]));
        }
      }
      // Reset prev between phrases (they're not contiguous)
      s.prev.pc = null;
      s.prev.midi = null;
      s.prev.lastNoteTime = null;
    }
    // Clear IC/entropy so first real note isn't measured against seed
    // Set entropy to 1.5 (below uniform 3.58) — STM has learned something
    s.lastIC = 0;
    s.lastEntropy = 1.5;
    s.lastIOIEntropy = 2.5;  // IOI seeded but less confident than pitch
  }

  function reset() {
    _init();
  }

  // ── Bootstrap ──
  _init();

  // ── Subscribe to noteProduced events ──
  if (typeof EventBus !== 'undefined') {
    EventBus.on('noteProduced', function(data) {
      var voice = data.voiceName || data.voice;
      var pc = data.pc;
      if (voice !== undefined && pc !== undefined && _state[voice]) {
        _observe(voice, pc, data.midi);
        // v8.6.0: IOI observation from timestamps
        var s = _state[voice];
        if (s && s.prev.lastNoteTime !== null) {
          var now = data.time || Date.now();
          var deltaMs = now - s.prev.lastNoteTime;
          if (deltaMs > 10 && deltaMs < 10000) { // sanity: 10ms to 10s
            // Normalize to beat-relative IOI ratio
            var bpm = (typeof PhaseCoupling !== 'undefined' && PhaseCoupling.getConsensusBPM)
              ? PhaseCoupling.getConsensusBPM() : 120;
            var beatMs = 60000 / Math.max(30, bpm);
            var ioiRatio = deltaMs / beatMs;
            s.stm.ioi.observe(_quantizeIOI(ioiRatio));
          }
        }
        if (s) s.prev.lastNoteTime = data.time || Date.now();
      }
    });
  }

  // ── Load LTM tries from role ngram files ──
  // Attempts to fetch {role}_ngrams.json for each pitched voice.
  // Falls back silently — STM-only mode if LTM not available.
  var _currentLTMGenre = '';  // track loaded genre to avoid redundant reloads

  // Genre family map — weak roles fall back to merged family ngrams before root
  var GENRE_FAMILY = { bach: 'classical', mozart: 'classical', beethoven: 'classical' };

  function _loadLTMFromFiles(genre) {
    var roles = ['bass', 'rhythm', 'soloist', 'lead'];
    var tag = genre || '';
    var family = GENRE_FAMILY[tag] || '';
    for (var i = 0; i < roles.length; i++) {
      (function(role) {
        // Try genre-specific → family → root
        var genreUrl  = tag    ? 'data/Lexicon/roles/' + tag    + '/' + role + '_ngrams.json' : '';
        var familyUrl = family ? 'data/Lexicon/roles/' + family + '/' + role + '_ngrams.json' : '';
        var rootUrl   = 'data/Lexicon/roles/' + role + '_ngrams.json';
        var urls = genreUrl
          ? (familyUrl ? [genreUrl, familyUrl, rootUrl] : [genreUrl, rootUrl])
          : [rootUrl];

        function tryLoad(idx) {
          if (idx >= urls.length) return;
          try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', urls[idx], true);
            xhr.onload = function() {
              if (xhr.status === 200) {
                try {
                  var data = JSON.parse(xhr.responseText);
                  // Reject empty files — must have at least one viewpoint trie
                  var hasData = data && ['interval','sd','contour'].some(function(vp){return data[vp] && Object.keys(data[vp]).length > 0;});
                  if (!hasData) { tryLoad(idx + 1); return; }
                  loadLTM(role, data);
                  if (idx === 0 && genreUrl) {
                    console.log('%cMelodicExpectancy: ' + role + ' LTM loaded (genre: ' + tag + ')',
                      'color:#9ca;font-family:monospace');
                  }
                } catch (e) { tryLoad(idx + 1); }
              } else {
                tryLoad(idx + 1);  // genre file not found — try root
              }
            };
            xhr.onerror = function() { tryLoad(idx + 1); };
            xhr.send();
          } catch (e) { tryLoad(idx + 1); }
        }
        tryLoad(0);
      })(roles[i]);
    }
    _currentLTMGenre = tag;
  }

  // v9 Feature D: Genre-aware LTM loading — hot-swap on genre change
  function loadGenreLTM(genre) {
    if (genre === _currentLTMGenre) return;  // already loaded
    console.log('%cMelodicExpectancy: switching LTM to genre "' + genre + '"',
      'color:#9ca;font-family:monospace');
    _loadLTMFromFiles(genre);
  }

  // Subscribe to genre change events
  if (typeof EventBus !== 'undefined' && EventBus.on) {
    EventBus.on('genreChanged', function(data) {
      var genre = (typeof data === 'string') ? data : (data && data.genre) || '';
      if (genre) loadGenreLTM(genre);
    });
  }

  // Attempt LTM load after a short delay (ensure server/IPC ready)
  setTimeout(function() { _loadLTMFromFiles(''); }, 500);

  return {
    predict:        predict,
    observe:        observe,
    getEntropy:     getEntropy,
    getIC:          getIC,
    isReady:        isReady,
    hasSTMData:     hasSTMData,
    loadLTM:        loadLTM,
    loadGenreLTM:   loadGenreLTM,
    seedSTM:        seedSTM,
    reset:          reset,
    // v8.6.0: IOI viewpoint (duration-aware prediction)
    predictIOI:     predictIOI,
    observeIOI:     observeIOI,
    quantizeIOI:    quantizeIOI,
    dequantizeIOI:  dequantizeIOI
  };

})();

console.log('%cMelodicExpectancy loaded (IDyOM-inspired expectation engine)', 'color:#9ca;font-family:monospace');

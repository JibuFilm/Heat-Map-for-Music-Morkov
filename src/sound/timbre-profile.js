'use strict';
// ═══ TIMBRE PROFILE (v5.1.0) ═══
//
// Classifies every instrument into a timbre profile that determines which
// expressive techniques are acoustically valid. Three categories:
//
//   sustained  — pitch modulation sounds natural (synth, organ, strings, brass,
//                wind, pads, all built-in oscillators). Supports: vibrato,
//                portamento, bend, swell, grace, ghost, mute.
//
//   plucked   — short sustain, pitch modulation sounds like tape speed (piano,
//                guitar, harp, marimba). Supports: grace, ghost, mute.
//
//   percussive — no pitch, only velocity/timing expression (drums).
//                Supports: ghost, mute.
//
// Profile assignment:
//   1. User override (setProfile)
//   2. Built-in oscillator lookup (always 'sustained')
//   3. ToneJS instrument lookup
//   4. GM name prefix matching
//   5. Auto-detection from AudioBuffer decay analysis
//   6. Default: 'sustained' (~65% of GM instruments sustain)
//
// Auto-detection: measures RMS energy decay of sample buffers. If energy
// drops >18dB within 500ms of the attack peak → 'plucked'. Otherwise 'sustained'.
// Uses majority vote across up to 3 representative samples (low/mid/high).
//
// References:
//   Peeters et al. 2011 — timbre descriptors for instrument classification
//   Giordano & McAdams 2010 — auditory perception of sustained vs impulsive sounds
//
// Public API:
//   getProfile(instName)         → { vibrato, portamento, bend, swell, grace, ghost, mute }
//   getProfileId(instName)       → 'sustained' | 'plucked' | 'percussive'
//   setProfile(instName, id)     — user override
//   canDo(instName, expression)  → bool
//   detectFromBuffers(name, buf) — auto-detect from decoded AudioBuffers
//   getProfileIds()              → ['sustained','plucked','percussive']
//   reset()                      — clear overrides
//
// Load order: after sound-engine.js, before expression-engine.js.

var TimbreProfile = (function() {

  // ── Profile capability definitions ──
  var PROFILES = {
    sustained: {
      vibrato: true, portamento: true, bend: true, swell: true,
      grace: true, ghost: true, mute: true
    },
    plucked: {
      vibrato: false, portamento: false, bend: false, swell: false,
      grace: true, ghost: true, mute: true
    },
    percussive: {
      vibrato: false, portamento: false, bend: false, swell: false,
      grace: false, ghost: true, mute: true
    }
  };

  // ── Overrides + auto-detected profiles ──
  var _profiles = {};

  // ── Built-in oscillator instruments ──
  // Classified by intended TIMBRAL CHARACTER, not synthesis method.
  // Even though all are OscillatorNode-based (detune works natively),
  // vibrato on a piano-like decay sounds wrong regardless of synthesis.
  var BUILTIN = {
    piano: 'plucked', eguitar: 'plucked', aguitar: 'plucked',
    synth: 'sustained', sine: 'sustained', pad: 'sustained',
    choir: 'sustained', strings: 'sustained', organ: 'sustained'
  };

  // ── ToneJS instruments ──
  var TONEJS = {
    'bass-electric':   'plucked',
    'guitar-acoustic': 'plucked',
    'guitar-electric': 'plucked',
    'saxophone':       'sustained',
    'violin':          'sustained',
    'harp':            'plucked',
    'harmonium':       'sustained',
    'contrabass':      'plucked',
    'french-horn':     'sustained',
    'trombone':        'sustained'
  };

  // ── GM soundfont name prefixes that are plucked/percussive ──
  // Everything not in this list defaults to 'sustained' (majority of GM).
  var GM_PLUCKED = [
    // Piano family (GM 0-7): hammered strings
    'acoustic_grand', 'bright_acoustic', 'electric_grand', 'honkytonk',
    'electric_piano', 'harpsichord', 'clavinet',
    // Chromatic percussion (GM 8-15)
    'celesta', 'glockenspiel', 'music_box', 'vibraphone', 'marimba',
    'xylophone', 'tubular_bells', 'dulcimer',
    // Guitar (GM 24-31)
    'acoustic_guitar', 'electric_guitar', 'overdriven_guitar',
    'distortion_guitar', 'guitar_harmonics',
    // Acoustic/electric bass (GM 32-35) — synth_bass is sustained
    'acoustic_bass', 'electric_bass', 'slap_bass', 'fretless_bass',
    // Plucked orchestral
    'pizzicato_strings', 'orchestral_harp', 'timpani',
    'orchestra_hit',
    // Ethnic plucked
    'sitar', 'banjo', 'shamisen', 'koto', 'kalimba',
    // Percussive synth
    'steel_drums', 'woodblock', 'taiko_drum',
    'melodic_tom', 'synth_drum', 'reverse_cymbal',
    // GM Piano aliases used by our SampleLoader
    'gm_piano', 'gm_grand_epiano', 'gm_epiano'
  ];


  // ── Lookup helpers ──

  function _isGMPlucked(name) {
    var lower = name.toLowerCase();
    for (var i = 0; i < GM_PLUCKED.length; i++) {
      if (lower.indexOf(GM_PLUCKED[i]) === 0) return true;
    }
    return false;
  }

  function getProfileId(instName) {
    // 1. User override / auto-detected
    if (_profiles[instName]) return _profiles[instName];

    // 2. Built-in oscillator
    if (BUILTIN[instName]) return BUILTIN[instName];

    // 3. ToneJS
    if (TONEJS[instName]) return TONEJS[instName];

    // 4. Strip gm_ alias prefix and re-check
    var baseName = instName.replace(/^gm_/, '');
    if (baseName !== instName) {
      if (BUILTIN[baseName]) return BUILTIN[baseName];
      if (TONEJS[baseName]) return TONEJS[baseName];
    }

    // 5. GM prefix match (plucked list)
    if (_isGMPlucked(instName)) return 'plucked';
    if (baseName !== instName && _isGMPlucked(baseName)) return 'plucked';

    // 6. User-uploaded instruments starting with 'user_' — defer to auto-detect
    // If auto-detect hasn't run yet, default sustained (safe for most samples)

    // 7. Default: sustained
    return 'sustained';
  }

  function getProfile(instName) {
    var id = getProfileId(instName);
    return PROFILES[id] || PROFILES.sustained;
  }

  function setProfile(instName, profileId) {
    if (PROFILES[profileId]) {
      _profiles[instName] = profileId;
      console.log('TimbreProfile: ' + instName + ' set to ' + profileId);
    }
  }

  function canDo(instName, expression) {
    var profile = getProfile(instName);
    return !!profile[expression];
  }


  // ═══ AUTO-DETECTION FROM AUDIO BUFFERS ═══
  //
  // Called by SampleLoader.finishLoad after decoding sample buffers.
  // Analyzes energy decay: if the sample loses >18dB within 500ms of its
  // attack peak, it's classified as 'plucked'. Otherwise 'sustained'.
  //
  // For multi-sample instruments, tests up to 3 samples (low/mid/high register)
  // and uses majority vote — prevents one anomalous sample from misclassifying.

  function detectFromBuffers(instName, buffers) {
    // Don't override known instruments, user overrides, or GM-classified instruments
    if (BUILTIN[instName] || TONEJS[instName]) return;
    if (_profiles[instName]) return;
    if (_isGMPlucked(instName)) return;  // GM prefix match is authoritative

    var keys = [];
    for (var k in buffers) keys.push(Number(k));
    if (keys.length === 0) return;

    keys.sort(function(a, b) { return a - b; });

    // Pick up to 3 representative samples
    var sampleKeys;
    if (keys.length <= 3) {
      sampleKeys = keys;
    } else {
      sampleKeys = [
        keys[0],
        keys[Math.floor(keys.length / 2)],
        keys[keys.length - 1]
      ];
    }

    var sustainedVotes = 0;
    for (var i = 0; i < sampleKeys.length; i++) {
      var buf = buffers[sampleKeys[i]];
      if (!buf || !buf.numberOfChannels || buf.numberOfChannels < 1) continue;
      try {
        if (_isSustainedBuffer(buf)) sustainedVotes++;
      } catch(e) {
        // Buffer analysis failed — skip this sample
      }
    }

    var detected = (sustainedVotes > sampleKeys.length / 2) ? 'sustained' : 'plucked';
    _profiles[instName] = detected;
    console.log('TimbreProfile: ' + instName + ' auto-detected as ' + detected +
                ' (' + sustainedVotes + '/' + sampleKeys.length + ' sustained)');
  }

  function _isSustainedBuffer(audioBuffer) {
    var data = audioBuffer.getChannelData(0);
    var sr = audioBuffer.sampleRate;
    var len = data.length;

    // Buffer shorter than 400ms → plucked (one-shots)
    if (len < sr * 0.4) return false;

    var windowSamples = Math.floor(sr * 0.05); // 50ms windows
    if (windowSamples < 1) return false;

    // Peak RMS in first 150ms (attack transient)
    var earlyEnd = Math.min(Math.floor(sr * 0.15), len);
    var earlyPeak = 0;
    for (var i = 0; i < earlyEnd; i += windowSamples) {
      var sum = 0;
      var end = Math.min(i + windowSamples, earlyEnd);
      var count = end - i;
      for (var j = i; j < end; j++) sum += data[j] * data[j];
      var rms = Math.sqrt(sum / count);
      if (rms > earlyPeak) earlyPeak = rms;
    }

    if (earlyPeak < 0.001) return false; // silence

    // RMS at 500ms mark
    var checkStart = Math.floor(sr * 0.5);
    if (checkStart + windowSamples > len) return false;

    var sum500 = 0;
    var end500 = Math.min(checkStart + windowSamples, len);
    for (var k = checkStart; k < end500; k++) sum500 += data[k] * data[k];
    var rms500 = Math.sqrt(sum500 / (end500 - checkStart));

    // If energy drop < 18dB → sustained
    // 18dB ≈ amplitude ratio of ~8:1 — generous threshold to catch
    // reverberant plucked instruments while allowing naturally decaying bowed sounds
    var dropDB = 20 * Math.log10(earlyPeak / Math.max(rms500, 0.000001));
    return dropDB < 18;
  }


  // ── Reset ──
  function reset() {
    _profiles = {};
  }

  function getProfileIds() {
    return ['sustained', 'plucked', 'percussive'];
  }


  // ── PUBLIC ──
  return {
    getProfile: getProfile,
    getProfileId: getProfileId,
    setProfile: setProfile,
    canDo: canDo,
    detectFromBuffers: detectFromBuffers,
    reset: reset,
    getProfileIds: getProfileIds
  };
})();

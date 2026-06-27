'use strict';
// ═══ SOUND ENGINE v2.1 (Phase 7) ═══
//
// Phase 6 base: noteOn/noteOff managed lifecycle, per-voice channel strips,
// instrument library with configurable ADSR.
//
// Phase 7 change: POLYPHONIC per voice.
//   - activeNotes[voiceName] is now an ARRAY of note objects (was single object).
//   - noteOn() adds to the array and returns a noteId (incrementing integer).
//   - noteOff(voiceName, noteId) releases a specific note by ID.
//   - releaseVoice(voiceName) releases ALL notes for a voice (mono shortcut).
//   - getActiveNotes(voiceName) returns [{noteId, midi, startTime}].
//   - getActivePoly(voiceName) returns count of currently sounding notes.
//
// Polyphony POLICY (how many notes ring, when to steal) is NOT here.
// That belongs in VoiceManager. SoundEngine produces sound when told to.
//
// NO perceptual gate — timing separation handled upstream by Scheduler.crossVoiceSnap.
// NO timing delays — FC returns pitch decisions only.

var SoundEngine = (function() {

  // ═══ AUDIO CONTEXT + MASTER BUS ═══

  var ctx = null;
  var reverbNode = null, dryGain = null, wetGain = null, masterGain = null;
  var compressor = null;
  var _limiter = null;  // Phase 15: stored for recording tap
  var reverbAmount = 0.3, globalSustain = 0.5, globalInstrument = 'piano';
  var sustainPedal = false;

  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();

      // Master bus: dry/wet → compressor → masterGain → destination
      // Compressor prevents polyphonic buildup spikes and normalizes loudness.
      // Master gain is POST-compressor so user volume control can safely boost.
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;   // higher threshold — less aggressive, more dynamic range
      compressor.knee.value = 16;         // wider knee — smoother onset, fewer audible artifacts
      compressor.ratio.value = 4;         // gentler ratio — controls buildup without squashing
      compressor.attack.value = 0.005;    // 5ms — catches transients but preserves attack
      compressor.release.value = 0.20;    // 200ms — musical, no pumping

      masterGain = ctx.createGain();
      masterGain.gain.value = 0.85;       // lower than old 1.4 — headroom for polyphonic peaks
      dryGain = ctx.createGain();
      wetGain = ctx.createGain();
      dryGain.gain.value = 1 - reverbAmount;
      wetGain.gain.value = reverbAmount;
      dryGain.connect(compressor);
      wetGain.connect(compressor);
      compressor.connect(masterGain);

      // Brick-wall safety limiter — catches any residual peaks that
      // escape the musical compressor. Transparent unless signal clips.
      var limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1;     // just below 0dBFS
      limiter.knee.value = 0;           // hard knee — brick wall
      limiter.ratio.value = 20;         // near-infinite ratio
      limiter.attack.value = 0.001;     // instant catch
      limiter.release.value = 0.05;     // fast release — inaudible on transients

      masterGain.connect(limiter);
      limiter.connect(ctx.destination);
      _limiter = limiter;  // Phase 15: store for recording tap
      buildReverb();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function buildReverb() {
    var sr = ctx.sampleRate, len = sr * 2;
    var buf = ctx.createBuffer(2, len, sr);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
    reverbNode = ctx.createConvolver();
    reverbNode.buffer = buf;
    reverbNode.connect(wetGain);
  }


  // ═══ PER-VOICE CHANNEL STRIPS ═══

  var strips = {};

  var STRIP_DEFAULTS = {
    bass:   { gain: 0.5, pan: -0.2, filterType: 'lowpass',  filterFreq: 800, filterQ: 0.7 },
    rhythm: { gain: 0.5, pan:  0.0, filterType: null },
    soloist: { gain: 0.5, pan:  0.2, filterType: 'highpass', filterFreq: 250, filterQ: 0.5 },
    human:  { gain: 0.5, pan:  0.0, filterType: null },
    lead:   { gain: 0.5, pan:  0.1, filterType: null },
    drone:  { gain: 0.5, pan:  0.0, filterType: null },
    percussion: { gain: 0.4, pan: 0.0, filterType: null }
  };

  // ═══ UNIFIED STRIP ARCHITECTURE ═══
  //
  // Signal chain per channel (including drone):
  //   voiceGain → fxBus.dry → fxBus.mix → channelGain → analyser → panner → filter → dryGain + reverbNode
  //
  // voiceGain:   pre-FX level — controls how hard signal drives effects
  // fxBus:       per-channel FX routing (starts as passthrough, FX added via addChannelFX)
  // channelGain: post-FX fader — the user-facing strip fader
  // analyser:    waveform visualization tap (post-FX, pre-panner)
  //
  // Legacy compat: s.gainNode aliases s.channelGain for callers that haven't updated.

  function getStrip(voiceName) {
    if (!voiceName) return null;
    if (strips[voiceName]) return strips[voiceName];
    if (!ctx) return null;

    var def = STRIP_DEFAULTS[voiceName] || STRIP_DEFAULTS.human;
    var s = {};

    // Pre-FX gain (drives FX send level)
    s.voiceGain = ctx.createGain();
    s.voiceGain.gain.value = 1.0;

    // Per-channel FX bus (passthrough by default)
    s.fxBus = {
      dry: ctx.createGain(),
      sends: [],
      mix: ctx.createGain()
    };
    s.fxBus.dry.gain.value = 1.0;
    s.fxBus.mix.gain.value = 1.0;
    s.voiceGain.connect(s.fxBus.dry);
    s.fxBus.dry.connect(s.fxBus.mix);

    // Post-FX fader (user-facing channel gain)
    s.channelGain = ctx.createGain();
    s.channelGain.gain.value = def.gain;
    s.fxBus.mix.connect(s.channelGain);

    // Legacy alias
    s.gainNode = s.channelGain;

    // Per-channel analyser (waveform visualization tap)
    s.analyser = ctx.createAnalyser();
    s.analyser.fftSize = 1024;
    s.analyser.smoothingTimeConstant = 0.72;
    s.channelGain.connect(s.analyser);

    // Panner
    if (typeof StereoPannerNode !== 'undefined') {
      s.panner = ctx.createStereoPanner();
      s.panner.pan.value = def.pan || 0;
      s.analyser.connect(s.panner);
    } else {
      s.panner = s.analyser;
    }

    // Optional filter (bass lowpass, soloist highpass)
    if (def.filterType) {
      s.filter = ctx.createBiquadFilter();
      s.filter.type = def.filterType;
      s.filter.frequency.value = def.filterFreq || 1000;
      s.filter.Q.value = def.filterQ || 0.7;
      s.panner.connect(s.filter);
      s.output = s.filter;
    } else {
      s.output = s.panner;
    }

    // Connect to master bus
    s.output.connect(dryGain);
    if (reverbNode) s.output.connect(reverbNode);

    strips[voiceName] = s;
    return s;
  }

  function connectToOutput(node, voiceName) {
    var strip = getStrip(voiceName);
    if (strip) {
      node.connect(strip.voiceGain);
    } else {
      node.connect(dryGain);
      if (reverbNode) node.connect(reverbNode);
    }
  }


  // ═══ ADSR ENVELOPE ═══

  var VOICE_ENVELOPES = {
    bass:    { a: 0.008, d: 0.10, s: 0.5, r: 0.25 },
    rhythm:  { a: 0.005, d: 0.08, s: 0.4, r: 0.20 },
    soloist: { a: 0.005, d: 0.08, s: 0.4, r: 0.30 },
    lead:    { a: 0.006, d: 0.10, s: 0.45, r: 0.35 },  // sustained melodic themes
    human:   { a: 0.005, d: 0.08, s: 0.4, r: 0.30 }
  };

  var voiceInstruments = { bass: null, rhythm: null, soloist: null, lead: null };

  function getEnvelope(voiceName) {
    return VOICE_ENVELOPES[voiceName] || VOICE_ENVELOPES.human;
  }

  function createADSR(c, vol, env, startTime) {
    var g = c.createGain();
    var sustainVol = vol * env.s;
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(vol, startTime + env.a);
    g.gain.linearRampToValueAtTime(sustainVol, startTime + env.a + env.d);
    return g;
  }

  function triggerRelease(adsrNode, env, releaseTime) {
    if (!adsrNode) return;
    adsrNode.gain.cancelScheduledValues(releaseTime);
    adsrNode.gain.setValueAtTime(adsrNode.gain.value, releaseTime);
    adsrNode.gain.linearRampToValueAtTime(0, releaseTime + env.r);
  }


  // ═══ ACTIVE NOTE TRACKING (Phase 7: polyphonic) ═══
  //
  // activeNotes[voiceName] = [ { noteId, midi, adsr, nodes, env, startTime, output, releasing } ]
  // Each noteOn appends. releaseNote sets releasing=true and schedules cleanup.
  // releaseVoice releases all notes for a voice.

  var activeNotes = {};
  var nextNoteId = 1;

  function getVoiceNotes(voiceName) {
    if (!activeNotes[voiceName]) activeNotes[voiceName] = [];
    return activeNotes[voiceName];
  }

  // Release a single note by noteId. Returns true if found.
  function releaseNote(voiceName, noteId) {
    var notes = getVoiceNotes(voiceName);
    for (var i = 0; i < notes.length; i++) {
      if (notes[i].noteId === noteId && !notes[i].releasing) {
        doRelease(voiceName, i);
        return true;
      }
    }
    return false;
  }

  // Release ALL notes for a voice (mono mode, or full clear).
  function releaseVoice(voiceName) {
    var notes = getVoiceNotes(voiceName);
    for (var i = notes.length - 1; i >= 0; i--) {
      if (!notes[i].releasing) {
        doRelease(voiceName, i);
      }
    }
  }

  // HARD KILL a voice — immediately stop all oscillators, no ADSR fade.
  // Use on auto stop to prevent any lingering sound.
  function killVoice(voiceName) {
    var notes = getVoiceNotes(voiceName);
    for (var i = 0; i < notes.length; i++) {
      var active = notes[i];
      // Immediately zero the gain
      if (active.adsr) {
        try {
          active.adsr.gain.cancelScheduledValues(ctx.currentTime);
          active.adsr.gain.setValueAtTime(0, ctx.currentTime);
        } catch(e) {}
      }
      // Immediately stop all oscillator/source nodes
      for (var j = 0; j < active.nodes.length; j++) {
        try { active.nodes[j].stop(0); } catch(e) {}
        try { active.nodes[j].disconnect(); } catch(e) {}
      }
      // Disconnect output
      try { if (active.output) active.output.disconnect(); } catch(e) {}
      try { if (active.adsr) active.adsr.disconnect(); } catch(e) {}
    }
    activeNotes[voiceName] = [];
  }

  // HARD KILL everything — all voices, all notes, instant silence.
  function killAll() {
    for (var voiceName in activeNotes) {
      killVoice(voiceName);
    }
  }

  // Internal: trigger ADSR release on a note and schedule node cleanup.
  function doRelease(voiceName, idx) {
    var notes = getVoiceNotes(voiceName);
    var active = notes[idx];
    if (!active || active.releasing) return;

    active.releasing = true;

    var env = active.env;
    var now = ctx.currentTime;
    triggerRelease(active.adsr, env, now);

    var noteNodes = active.nodes;
    var noteId = active.noteId;
    var cleanupMs = (env.r + 0.15) * 1000;

    setTimeout(function() {
      // Stop and disconnect oscillators/sources
      for (var i = 0; i < noteNodes.length; i++) {
        try { noteNodes[i].stop(); } catch(e) {}
        try { noteNodes[i].disconnect(); } catch(e) {}
      }
      // Remove from active array
      var arr = getVoiceNotes(voiceName);
      for (var j = arr.length - 1; j >= 0; j--) {
        if (arr[j].noteId === noteId) {
          arr.splice(j, 1);
          break;
        }
      }
    }, cleanupMs);
  }


  // ═══ INSTRUMENT LIBRARY ═══

  var instrumentLib = {};

  instrumentLib.piano = function(c, freq) {
    var mod = c.createOscillator();
    var mg = c.createGain();
    var car = c.createOscillator();
    var mix = c.createGain();

    mod.type = 'sine'; mod.frequency.value = freq * 2.01;
    mg.gain.value = freq * 0.6;
    car.type = 'sine'; car.frequency.value = freq;
    mod.connect(mg); mg.connect(car.frequency);
    car.connect(mix); mix.gain.value = 1.0;

    return { output: mix, nodes: [mod, car] };
  };

  // Pre-computed waveshaper curve for eguitar (avoids Float32Array alloc per note)
  var _eguitarCurve = (function() {
    var curve = new Float32Array(256);
    for (var i = 0; i < 256; i++) curve[i] = Math.tanh((i / 128 - 1) * 2.5);
    return curve;
  })();

  instrumentLib.eguitar = function(c, freq) {
    var o1 = c.createOscillator(), o2 = c.createOscillator();
    var mix = c.createGain(), sh = c.createWaveShaper();

    o1.type = 'sawtooth'; o1.frequency.value = freq;
    o2.type = 'square'; o2.frequency.value = freq * 1.002;
    mix.gain.value = 0.5;

    sh.curve = _eguitarCurve; sh.oversample = '2x';

    o1.connect(mix); o2.connect(mix); mix.connect(sh);
    return { output: sh, nodes: [o1, o2] };
  };

  instrumentLib.aguitar = function(c, freq) {
    var sr = c.sampleRate, per = Math.round(sr / freq);
    var bufLen = Math.round(sr * 3);
    var buf = c.createBuffer(1, bufLen, sr), d = buf.getChannelData(0);

    for (var i = 0; i < per; i++) d[i] = (Math.random() * 2 - 1) * 0.8;
    var damp = 0.994 + globalSustain * 0.004;
    for (var i = per; i < bufLen; i++) d[i] = (d[i - per] + d[i - per + 1]) * 0.5 * damp;

    var src = c.createBufferSource(); src.buffer = buf;
    return { output: src, nodes: [src] };
  };

  instrumentLib.synth = function(c, freq) {
    var mix = c.createGain(); mix.gain.value = 0.33;
    var oscs = [];
    var detunes = [-4, 0, 4];
    for (var di = 0; di < detunes.length; di++) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle'; o.frequency.value = freq; o.detune.value = detunes[di];
      g.gain.value = 0.33; o.connect(g); g.connect(mix); oscs.push(o);
    }
    return { output: mix, nodes: oscs };
  };

  instrumentLib.sine = function(c, freq) {
    var o = c.createOscillator();
    o.type = 'sine'; o.frequency.value = freq;
    return { output: o, nodes: [o] };
  };

  instrumentLib.pad = function(c, freq) {
    var mix = c.createGain(); mix.gain.value = 0.2;
    var oscs = [];
    var detunes = [-12, -5, 0, 5, 12];
    for (var di = 0; di < detunes.length; di++) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = detunes[di];
      g.gain.value = 0.2; o.connect(g); g.connect(mix); oscs.push(o);
    }
    return { output: mix, nodes: oscs };
  };

  instrumentLib.choir = function(c, freq) {
    var mix = c.createGain(); mix.gain.value = 0.25;
    var oscs = [];

    var saw = c.createOscillator();
    saw.type = 'sawtooth'; saw.frequency.value = freq;

    var lfo = c.createOscillator(), lfoG = c.createGain();
    lfo.type = 'sine'; lfo.frequency.value = 5.2;
    lfoG.gain.value = freq * 0.008;
    lfo.connect(lfoG); lfoG.connect(saw.frequency);

    var formants = [
      { freq: 800, q: 5, gain: 1.0 },
      { freq: 1200, q: 8, gain: 0.7 },
      { freq: 2500, q: 10, gain: 0.3 }
    ];
    for (var i = 0; i < formants.length; i++) {
      var bp = c.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = formants[i].freq; bp.Q.value = formants[i].q;
      var fg = c.createGain(); fg.gain.value = formants[i].gain;
      saw.connect(bp); bp.connect(fg); fg.connect(mix);
    }
    oscs.push(saw, lfo);
    return { output: mix, nodes: oscs };
  };

  instrumentLib.strings = function(c, freq) {
    var mix = c.createGain(); mix.gain.value = 0.2;
    var oscs = [];
    var detunes = [-8, -3, 0, 3, 8, 12];
    for (var i = 0; i < detunes.length; i++) {
      var o = c.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq;
      o.detune.value = detunes[i] + (Math.random() * 4 - 2);

      var vib = c.createOscillator(), vibG = c.createGain();
      vib.type = 'sine'; vib.frequency.value = 4.5 + Math.random() * 1.5;
      vibG.gain.value = freq * 0.005;
      vib.connect(vibG); vibG.connect(o.frequency);

      var g = c.createGain(); g.gain.value = 1.0 / detunes.length;
      o.connect(g); g.connect(mix);
      oscs.push(o, vib);
    }
    return { output: mix, nodes: oscs };
  };

  instrumentLib.organ = function(c, freq) {
    var mix = c.createGain(); mix.gain.value = 0.3;
    var oscs = [];
    var harmonics = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8];
    var levels = [0.7, 1.0, 0.5, 0.8, 0.3, 0.5, 0.2, 0.3, 0.2];
    for (var i = 0; i < harmonics.length; i++) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = freq * harmonics[i];
      g.gain.value = levels[i] / harmonics.length;
      o.connect(g); g.connect(mix); oscs.push(o);
    }
    return { output: mix, nodes: oscs };
  };

  var INSTRUMENT_ENVELOPES = {
    piano: null, eguitar: null, aguitar: null, synth: null, sine: null,
    pad:     { a: 0.4,  d: 0.3, s: 0.7, r: 1.0 },
    choir:   { a: 0.3,  d: 0.2, s: 0.8, r: 0.8 },
    strings: { a: 0.15, d: 0.2, s: 0.7, r: 0.5 },
    organ:   { a: 0.01, d: 0.01, s: 1.0, r: 0.05 }
  };

  // ═══ INSTRUMENT NORMALIZATION (Phase 13) ═══
  //
  // Compensates for raw output level differences across instruments.
  // Calibrated for the Phase 13 volume pipeline:
  //   fader(0–1) × normGain × stripGain(0.5) × masterGain(0.85) → compressor
  // At 50% fader, each voice should be at comfortable solo level.
  // The master bus compressor handles polyphonic buildup.
  var INSTRUMENT_NORM = {
    piano:   0.24,    // raw 1.0 — loudest raw, needs cut
    eguitar: 0.34,    // raw ~0.7 (waveshaper adds harmonics)
    aguitar: 0.46,    // raw ~0.5 (Karplus-Strong, natural decay)
    synth:   0.80,    // raw ~0.22, quiet
    sine:    0.20,    // raw 1.0, pure tone perceived louder
    pad:     1.30,    // raw ~0.12 — very quiet, needs boost
    choir:   1.20,    // raw ~0.12 — formant filtering removes energy
    strings: 1.45,    // raw ~0.10 — quietest raw output
    organ:   0.92     // raw ~0.15, sustains at full peak
  };

  function getNormGain(instName) {
    return INSTRUMENT_NORM[instName] || 1.0;
  }


  // ═══ noteOn (Phase 7: polyphonic) ═══
  //
  // Adds a note to the voice's active array. Does NOT auto-release previous.
  // Polyphony policy (when to release old notes) is VoiceManager's job.
  //
  // scheduleAheadSec: optional offset in seconds from ctx.currentTime.
  //   Used by VoiceManager onset snap to push a note to the separation
  //   boundary when another voice recently fired in the uncanny zone.
  //   Default 0 (fire now). Must be >= 0.
  //
  // Returns { noteId: int, onsetTime: float (ctx seconds) }.

  function noteOn(midi, volMult, voiceName, scheduleAheadSec, expression) {
    var c = ensureCtx();
    var freq = 440 * Math.pow(2, (midi - 69) / 12);
    var ahead = (scheduleAheadSec && scheduleAheadSec > 0) ? scheduleAheadSec : 0;
    var t = c.currentTime + ahead;

    var instName = voiceInstruments[voiceName] || globalInstrument;
    var instFn = instrumentLib[instName] || instrumentLib.piano;
    var env = INSTRUMENT_ENVELOPES[instName] || getEnvelope(voiceName);

    if (sustainPedal) {
      env = { a: env.a, d: env.d, s: 1.0, r: env.r * 2 };
    }

    var expr = expression || {};

    // Expression: ghost note — quiet + shorter envelope
    if (expr.ghost) {
      env = { a: env.a, d: env.d * 0.5, s: env.s * 0.5, r: env.r * 0.5 };
    }
    // Expression: mute — ultra-short percussive envelope
    if (expr.mute) {
      env = { a: 0.002, d: 0.015, s: 0, r: 0.05 };
    }
    // Expression: swell — slow attack (overrides normal attack)
    if (expr.swell) {
      var swellSec = (expr.swell.durationSec || 0.15);
      env = { a: swellSec, d: env.d, s: env.s, r: env.r };
    }

    // Phase 13: flat base vol — no register-based scaling.
    var vol = (volMult !== undefined ? volMult : 1);
    if (expr.ghost) vol *= 0.25;
    vol *= getNormGain(instName);

    var inst = instFn(c, freq, vol);
    var adsr = createADSR(c, vol, env, t);

    inst.output.connect(adsr);
    connectToOutput(adsr, voiceName);

    // ── Expression: pitch modulation via detune AudioParam ──
    // Both OscillatorNode and AudioBufferSourceNode expose .detune (cents).
    // LFO connects additively — composes correctly with detune ramps.
    var extraNodes = [];

    // Vibrato: LFO → detune. Onset delayed to preserve attack clarity.
    if (expr.vibrato) {
      var lfo = c.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = expr.vibrato.rateHz || 5.5;
      var lfoGain = c.createGain();
      var vibOnset = t + (expr.vibrato.onsetDelaySec || 0.15);
      // Start silent, ramp to target depth after onset delay
      lfoGain.gain.setValueAtTime(0, t);
      lfoGain.gain.linearRampToValueAtTime(expr.vibrato.depthCents || 15, vibOnset);
      lfo.connect(lfoGain);
      // Connect to detune of all pitch-bearing nodes
      for (var vi = 0; vi < inst.nodes.length; vi++) {
        if (inst.nodes[vi].detune) {
          lfoGain.connect(inst.nodes[vi].detune);
        }
      }
      lfo.start(t);
      extraNodes.push(lfo);
    }

    // Bend: approach target pitch from below (or above). Detune ramp to 0.
    if (expr.bend) {
      var bendCents = expr.bend.cents || -100;
      var bendDur = expr.bend.durationSec || 0.06;
      for (var bi = 0; bi < inst.nodes.length; bi++) {
        if (inst.nodes[bi].detune) {
          inst.nodes[bi].detune.setValueAtTime(bendCents, t);
          inst.nodes[bi].detune.linearRampToValueAtTime(0, t + bendDur);
        }
      }
    }

    // Portamento: glide from previous note's pitch. Detune ramp to 0.
    if (expr.portamento) {
      var glideCents = expr.portamento.fromCents || 0;
      var glideDur = expr.portamento.durationSec || 0.08;
      for (var pi = 0; pi < inst.nodes.length; pi++) {
        if (inst.nodes[pi].detune) {
          inst.nodes[pi].detune.setValueAtTime(glideCents, t);
          inst.nodes[pi].detune.linearRampToValueAtTime(0, t + glideDur);
        }
      }
    }

    for (var i = 0; i < inst.nodes.length; i++) {
      try { inst.nodes[i].start(t); } catch(e) {}
    }

    var id = nextNoteId++;
    var allNodes = inst.nodes;
    // Include expression LFO nodes for cleanup on release
    if (extraNodes.length > 0) {
      allNodes = inst.nodes.concat(extraNodes);
    }
    var notes = getVoiceNotes(voiceName);
    notes.push({
      noteId: id,
      midi: midi,
      adsr: adsr,
      nodes: allNodes,
      env: env,
      startTime: t,
      output: inst.output,
      releasing: false
    });

    return { noteId: id, onsetTime: t };
  }


  // ═══ playGrace — fire-and-forget grace note ═══
  //
  // Short decorative pre-note routed through the same voice strip.
  // Not tracked in activeNotes — self-releases via baked envelope.
  // Called by VoiceManager before the main noteOn for grace note expressions.

  function playGrace(midi, volMult, voiceName, durationSec) {
    var c = ensureCtx();
    var t = c.currentTime;
    var freq = 440 * Math.pow(2, (midi - 69) / 12);
    var instName = voiceInstruments[voiceName] || globalInstrument;
    var instFn = instrumentLib[instName] || instrumentLib.piano;
    var graceVol = (volMult !== undefined ? volMult : 0.3) * getNormGain(instName);
    var dur = durationSec || 0.04;

    var inst = instFn(c, freq, graceVol);

    // Baked envelope: fast attack, immediate decay, no sustain
    var env = c.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(graceVol, t + 0.003);
    env.gain.linearRampToValueAtTime(graceVol * 0.2, t + dur * 0.6);
    env.gain.linearRampToValueAtTime(0.001, t + dur);

    inst.output.connect(env);
    connectToOutput(env, voiceName);

    for (var gi = 0; gi < inst.nodes.length; gi++) {
      try {
        inst.nodes[gi].start(t);
        inst.nodes[gi].stop(t + dur + 0.1);
      } catch(e) {}
    }
  }


  // ═══ noteOff ═══
  //
  // Two signatures:
  //   noteOff(voiceName)          — release ALL notes for voice (backward compat)
  //   noteOff(voiceName, noteId)  — release specific note by ID

  function noteOff(voiceName, noteId) {
    if (noteId !== undefined) {
      releaseNote(voiceName, noteId);
    } else {
      releaseVoice(voiceName);
    }
  }


  // ═══ Query API (Phase 7) ═══

  // Returns array of { noteId, midi, startTime } for currently sounding notes.
  // Excludes notes that are in their release phase.
  // Reuses a pooled result array to avoid allocations on every call.
  var _activeNotesResult = [];
  function getActiveNotes(voiceName) {
    var notes = getVoiceNotes(voiceName);
    _activeNotesResult.length = 0;
    for (var i = 0; i < notes.length; i++) {
      if (!notes[i].releasing) {
        _activeNotesResult.push({
          noteId: notes[i].noteId,
          midi: notes[i].midi,
          startTime: notes[i].startTime
        });
      }
    }
    return _activeNotesResult;
  }

  // Returns count of currently sounding (non-releasing) notes.
  function getActivePoly(voiceName) {
    var notes = getVoiceNotes(voiceName);
    var count = 0;
    for (var i = 0; i < notes.length; i++) {
      if (!notes[i].releasing) count++;
    }
    return count;
  }


  // ═══ playNote (backward compat — fire-and-forget for human notes) ═══
  function playNote(midi, volMult, delayMs) {
    var c = ensureCtx();
    var freq = 440 * Math.pow(2, (midi - 69) / 12);
    var t = c.currentTime + (delayMs ? delayMs / 1000 : 0);

    var effSustain = sustainPedal ? 1.0 : globalSustain;
    var dur = 0.15 + effSustain * 1.2;
    var instName = globalInstrument;
    var vol = (volMult !== undefined ? volMult : 1);
    vol *= getNormGain(instName);
    var instFn = instrumentLib[instName] || instrumentLib.piano;
    var inst = instFn(c, freq, vol);

    var env = c.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vol, t + 0.005);
    env.gain.exponentialRampToValueAtTime(vol * 0.4, t + 0.08);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.3);

    inst.output.connect(env);
    connectToOutput(env, 'human');

    for (var i = 0; i < inst.nodes.length; i++) {
      try { inst.nodes[i].start(t); inst.nodes[i].stop(t + dur + 0.5); } catch(e) {}
    }
  }


  // ═══ CLICK ═══
  function playClick(accent) {
    var c = ensureCtx(), t = c.currentTime;
    var o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = accent ? 1000 : 700;
    g.gain.setValueAtTime(accent ? 0.08 : 0.04, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    o.connect(g); g.connect(dryGain); o.start(t); o.stop(t + 0.05);
  }


  // ═══ DRUM SYNTHESIS (Phase E — percussion voice) ═══
  //
  // 808-style synthesized drums for the percussion assistant.
  // Each drum is a self-contained fire-and-forget sound routed through
  // the 'percussion' strip. No ADSR management needed — envelopes are
  // baked into each synthesis function.

  // ── Drum timbre presets ──
  // Each preset defines synthesis parameters for kick, snare, hat.
  // '808' = punchy electronic (original). 'acoustic' = softer kit. 'jazz' = brushes.
  var DRUM_TIMBRES = {
    '808': {
      kick:  { freq: 55, sweepFrom: 150, sweepTime: 0.05, gain: 1.0, decay: 0.30, bodyFreq: 0, bodyGain: 0 },
      snare: { noiseGain: 0.7, noiseDecay: 0.15, noiseBP: 1000, noiseQ: 0.8, bodyGain: 0.5, bodyDecay: 0.08, bodyFreq: 200, bodyType: 'triangle' },
      hat:   { filterType: 'highpass', filterFreq: 8000, gain: 0.3, decay: 0.05, bufDur: 0.05 }
    },
    'acoustic': {
      kick:  { freq: 65, sweepFrom: 100, sweepTime: 0.08, gain: 0.6, decay: 0.20, bodyFreq: 100, bodyGain: 0.15 },
      snare: { noiseGain: 0.5, noiseDecay: 0.15, noiseBP: 1200, noiseQ: 0.6, bodyGain: 0.25, bodyDecay: 0.10, bodyFreq: 180, bodyType: 'triangle' },
      hat:   { filterType: 'highpass', filterFreq: 6000, gain: 0.25, decay: 0.08, bufDur: 0.08 }
    },
    'jazz': {
      kick:  { freq: 70, sweepFrom: 75, sweepTime: 0.12, gain: 0.35, decay: 0.10, bodyFreq: 0, bodyGain: 0 },
      snare: { noiseGain: 0.3, noiseDecay: 0.25, noiseBP: 4000, noiseQ: 1.5, bodyGain: 0, bodyDecay: 0, bodyFreq: 0, bodyType: 'triangle' },
      hat:   { filterType: 'bandpass', filterFreq: 6000, filterQ: 1.2, gain: 0.15, decay: 0.12, bufDur: 0.12 }
    },
    // v2.6.1: Drummer characters — acoustic kick synthesis (beater + shell, no pitch sweep)
    'jazz_brushes': {
      kick:  { acoustic: true, bodyFreq: 72, bodyDecay: 0.12, beaterFreq: 3000, beaterDecay: 0.010, gain: 0.20 },
      snare: { noiseGain: 0.25, noiseDecay: 0.30, noiseBP: 3500, noiseQ: 1.8, bodyGain: 0, bodyDecay: 0, bodyFreq: 0, bodyType: 'triangle' },
      hat:   { filterType: 'bandpass', filterFreq: 5500, filterQ: 1.0, gain: 0.12, decay: 0.15, bufDur: 0.15 },
      ride:  { filterType: 'bandpass', filterFreq: 4000, filterQ: 0.8, gain: 0.18, decay: 0.25, bufDur: 0.25 },
      rimshot: { filterType: 'highpass', filterFreq: 3000, gain: 0.20, decay: 0.04, bufDur: 0.04 }
    },
    'latin_perc': {
      kick:  { acoustic: true, bodyFreq: 78, bodyDecay: 0.15, beaterFreq: 3500, beaterDecay: 0.012, gain: 0.30 },
      snare: { noiseGain: 0.35, noiseDecay: 0.10, noiseBP: 2000, noiseQ: 0.5, bodyGain: 0.3, bodyDecay: 0.06, bodyFreq: 220, bodyType: 'triangle' },
      hat:   { filterType: 'highpass', filterFreq: 7000, gain: 0.20, decay: 0.04, bufDur: 0.04 },
      ride:  { filterType: 'bandpass', filterFreq: 3500, filterQ: 0.6, gain: 0.22, decay: 0.20, bufDur: 0.20 },
      rimshot: { filterType: 'highpass', filterFreq: 2500, gain: 0.30, decay: 0.03, bufDur: 0.03 },
      cowbell: { filterType: 'bandpass', filterFreq: 800, filterQ: 5.0, gain: 0.25, decay: 0.15, bufDur: 0.15 }
    },
    'soul_pocket': {
      kick:  { acoustic: true, bodyFreq: 65, bodyDecay: 0.20, beaterFreq: 2800, beaterDecay: 0.015, gain: 0.45 },
      snare: { noiseGain: 0.55, noiseDecay: 0.12, noiseBP: 1400, noiseQ: 0.7, bodyGain: 0.35, bodyDecay: 0.08, bodyFreq: 190, bodyType: 'triangle' },
      hat:   { filterType: 'highpass', filterFreq: 7500, gain: 0.22, decay: 0.06, bufDur: 0.06 },
      ride:  { filterType: 'bandpass', filterFreq: 4500, filterQ: 0.7, gain: 0.20, decay: 0.22, bufDur: 0.22 }
    },
    'timpani': {
      kick:  { freq: 80, sweepFrom: 85, sweepTime: 0.20, gain: 0.70, decay: 0.60, bodyFreq: 40, bodyGain: 0.25 },
      crash: { filterType: 'bandpass', filterFreq: 2000, filterQ: 0.3, gain: 0.30, decay: 0.40, bufDur: 0.40 }
    },
    'maracas': {
      shaker: { filterType: 'highpass', filterFreq: 5000, gain: 0.15, decay: 0.03, bufDur: 0.03 }
    }
  };

  // ── Pre-allocated noise buffers for drum synthesis ──
  // Avoids creating + filling a new AudioBuffer on every drum hit.
  // Keyed by sample count (rounded to nearest 1024 for reuse across similar durations).
  // Each buffer is filled with white noise once and reused for all hits.
  var _noiseBufferCache = {};
  function _getNoiseBuffer(c, sampleCount) {
    // Round up to nearest 1024 to maximize cache hits
    var rounded = Math.max(1024, Math.ceil(sampleCount / 1024) * 1024);
    if (_noiseBufferCache[rounded]) return _noiseBufferCache[rounded];
    var buf = c.createBuffer(1, rounded, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < rounded; i++) d[i] = Math.random() * 2 - 1;
    _noiseBufferCache[rounded] = buf;
    return buf;
  }

  function playDrum(drumName, velocity, timbre, options) {
    var c = ensureCtx();
    var t = c.currentTime;
    var vel = (velocity !== undefined) ? velocity : 0.8;
    var tb = timbre || '808';
    if (!DRUM_TIMBRES[tb]) tb = '808';
    var preset = DRUM_TIMBRES[tb];
    var opts = options || {};

    // v3.15.0: Continuous timbral parameters (textural percussion)
    var decayMult = opts.decayMult || 1.0;      // multiply all decay times
    var brightness = opts.brightness || 1.0;      // filter cutoff multiplier (0.3-1.2)
    var attackShape = opts.attackShape || 0;       // 0=sharp, 1=soft (max 20ms ramp)

    if (drumName === 'kick' && preset.kick && preset.kick.acoustic) {
      // v2.6.1: Acoustic kick — beater transient (noise) + shell resonance (sine), no pitch sweep
      var akp = preset.kick;
      // Beater transient: short bandpass-filtered noise burst
      var beaterLen = Math.round(c.sampleRate * (akp.beaterDecay + 0.01));
      var beaterSrc = c.createBufferSource();
      beaterSrc.buffer = _getNoiseBuffer(c, beaterLen);
      var beaterBP = c.createBiquadFilter();
      beaterBP.type = 'bandpass';
      beaterBP.frequency.value = akp.beaterFreq;
      beaterBP.Q.value = 1.5;
      var beaterGain = c.createGain();
      beaterGain.gain.setValueAtTime(vel * akp.gain * 0.6, t);
      beaterGain.gain.exponentialRampToValueAtTime(0.001, t + akp.beaterDecay);
      beaterSrc.connect(beaterBP);
      beaterBP.connect(beaterGain);
      // Shell resonance: gentle sine at body frequency
      var shellOsc = c.createOscillator();
      shellOsc.type = 'sine';
      shellOsc.frequency.value = akp.bodyFreq;
      var shellGain = c.createGain();
      shellGain.gain.setValueAtTime(vel * akp.gain, t);
      shellGain.gain.exponentialRampToValueAtTime(0.001, t + akp.bodyDecay);
      shellOsc.connect(shellGain);
      // Mix beater + shell
      var kickMix = c.createGain();
      kickMix.gain.value = 1.0;
      beaterGain.connect(kickMix);
      shellGain.connect(kickMix);
      connectToOutput(kickMix, 'percussion');
      beaterSrc.start(t);
      beaterSrc.stop(t + akp.beaterDecay + 0.01);
      shellOsc.start(t);
      shellOsc.stop(t + akp.bodyDecay + 0.05);

    } else if (drumName === 'kick') {
      // Electronic kick: sine oscillator with configurable pitch sweep + optional body undertone
      var kp = preset.kick;
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(kp.sweepFrom, t);
      osc.frequency.exponentialRampToValueAtTime(kp.freq, t + kp.sweepTime);
      var kickDecay = kp.decay * decayMult;
      var kickOnset = attackShape > 0 ? Math.min(attackShape * 0.02, 0.02) : 0;
      if (kickOnset > 0) { g.gain.setValueAtTime(0.001, t); g.gain.linearRampToValueAtTime(vel * kp.gain, t + kickOnset); }
      else { g.gain.setValueAtTime(vel * kp.gain, t); }
      g.gain.exponentialRampToValueAtTime(0.001, t + kickOnset + kickDecay);
      osc.connect(g);

      if (kp.bodyFreq > 0 && kp.bodyGain > 0) {
        // Body undertone (acoustic warmth)
        var bodyOsc = c.createOscillator();
        var bodyG = c.createGain();
        bodyOsc.type = 'sine';
        bodyOsc.frequency.value = kp.bodyFreq;
        bodyG.gain.setValueAtTime(vel * kp.bodyGain, t);
        bodyG.gain.exponentialRampToValueAtTime(0.001, t + kickDecay * 1.5);
        bodyOsc.connect(bodyG);
        var kickMix = c.createGain();
        kickMix.gain.value = 1.0;
        g.connect(kickMix);
        bodyG.connect(kickMix);
        connectToOutput(kickMix, 'percussion');
        osc.start(t);
        osc.stop(t + kickDecay + 0.05);
        bodyOsc.start(t);
        bodyOsc.stop(t + kickDecay * 1.5 + 0.05);
      } else {
        connectToOutput(g, 'percussion');
        osc.start(t);
        osc.stop(t + kickDecay + 0.05);
      }

    } else if (drumName === 'snare') {
      // Snare: noise layer + optional body oscillator (body omitted in jazz = pure brush)
      var sp = preset.snare;
      var snareNoiseDecay = sp.noiseDecay * decayMult;
      var snareBodyDecay = (sp.bodyDecay || 0) * decayMult;
      var snareDecayLen = Math.max(snareNoiseDecay, snareBodyDecay);
      var bufLen = Math.round(c.sampleRate * (snareDecayLen + 0.05));
      var noise = c.createBufferSource();
      noise.buffer = _getNoiseBuffer(c, bufLen);
      var nf = c.createBiquadFilter();
      nf.type = 'bandpass';
      nf.frequency.value = sp.noiseBP * brightness; // brightness shifts filter
      nf.Q.value = sp.noiseQ;
      var ng = c.createGain();
      var snareOnset = attackShape > 0 ? Math.min(attackShape * 0.015, 0.015) : 0;
      if (snareOnset > 0) { ng.gain.setValueAtTime(0.001, t); ng.gain.linearRampToValueAtTime(vel * sp.noiseGain, t + snareOnset); }
      else { ng.gain.setValueAtTime(vel * sp.noiseGain, t); }
      ng.gain.exponentialRampToValueAtTime(0.001, t + snareOnset + snareNoiseDecay);
      noise.connect(nf);
      nf.connect(ng);

      var mix = c.createGain();
      mix.gain.value = 1.0;
      ng.connect(mix);

      if (sp.bodyGain > 0 && sp.bodyFreq > 0) {
        var body = c.createOscillator();
        var bg = c.createGain();
        body.type = sp.bodyType || 'triangle';
        body.frequency.value = sp.bodyFreq;
        bg.gain.setValueAtTime(vel * sp.bodyGain, t);
        bg.gain.exponentialRampToValueAtTime(0.001, t + snareBodyDecay);
        body.connect(bg);
        bg.connect(mix);
        body.start(t);
        body.stop(t + snareBodyDecay + 0.05);
      }

      connectToOutput(mix, 'percussion');
      noise.start(t);

    } else if (drumName === 'hat') {
      // Hat: filtered noise with configurable filter type, frequency, decay
      // v2.6.1: hat openness modulates filter freq (lower=open) and decay (longer=open)
      // v3.15.0: brightness and decayMult for textural expression
      var hp = preset.hat;
      var openness = (opts.hatOpenness !== undefined) ? opts.hatOpenness : 0;
      var hatFreq = (hp.filterFreq - openness * 3000) * brightness; // brightness shifts timbre
      var hatDecay = (hp.decay + openness * 0.20) * decayMult;
      var hatBufDur = (hp.bufDur + openness * 0.20) * decayMult;
      var bufLen = Math.round(c.sampleRate * hatBufDur);
      var noise = c.createBufferSource();
      noise.buffer = _getNoiseBuffer(c, bufLen);
      var hf = c.createBiquadFilter();
      hf.type = hp.filterType || 'highpass';
      hf.frequency.value = hatFreq;
      if (hp.filterQ) hf.Q.value = hp.filterQ;
      var hg = c.createGain();
      var hatOnset = attackShape > 0 ? Math.min(attackShape * 0.01, 0.01) : 0;
      if (hatOnset > 0) { hg.gain.setValueAtTime(0.001, t); hg.gain.linearRampToValueAtTime(vel * hp.gain, t + hatOnset); }
      else { hg.gain.setValueAtTime(vel * hp.gain, t); }
      hg.gain.exponentialRampToValueAtTime(0.001, t + hatOnset + hatDecay);
      noise.connect(hf);
      hf.connect(hg);
      connectToOutput(hg, 'percussion');
      noise.start(t);

    } else if (drumName === 'tom_low' || drumName === 'tom_mid' || drumName === 'tom_high') {
      // Toms: sine body with pitch sweep + bandpass noise layer
      // Pitched membrane: low=80Hz, mid=140Hz, high=220Hz
      var tomFreq = drumName === 'tom_low' ? 80 : drumName === 'tom_mid' ? 140 : 220;
      var tomDecay = drumName === 'tom_low' ? 0.35 : drumName === 'tom_mid' ? 0.25 : 0.18;

      // Sine body with pitch drop
      var tomOsc = c.createOscillator();
      var tomOscGain = c.createGain();
      tomOsc.type = 'sine';
      tomOsc.frequency.setValueAtTime(tomFreq * 1.5, t);
      tomOsc.frequency.exponentialRampToValueAtTime(tomFreq, t + 0.04);
      tomOscGain.gain.setValueAtTime(vel * 0.7, t);
      tomOscGain.gain.exponentialRampToValueAtTime(0.001, t + tomDecay);
      tomOsc.connect(tomOscGain);

      // Noise layer — bandpass around the fundamental for body
      var tomNoiseBufLen = Math.round(c.sampleRate * tomDecay);
      var tomNoise = c.createBufferSource();
      tomNoise.buffer = _getNoiseBuffer(c, tomNoiseBufLen);
      var tomBP = c.createBiquadFilter();
      tomBP.type = 'bandpass';
      tomBP.frequency.value = tomFreq * 2;
      tomBP.Q.value = 1.2;
      var tomNoiseGain = c.createGain();
      tomNoiseGain.gain.setValueAtTime(vel * 0.2, t);
      tomNoiseGain.gain.exponentialRampToValueAtTime(0.001, t + tomDecay * 0.6);
      tomNoise.connect(tomBP);
      tomBP.connect(tomNoiseGain);

      var tomMix = c.createGain();
      tomMix.gain.value = 1.0;
      tomOscGain.connect(tomMix);
      tomNoiseGain.connect(tomMix);
      connectToOutput(tomMix, 'percussion');
      tomOsc.start(t);
      tomOsc.stop(t + tomDecay + 0.05);
      tomNoise.start(t);

    } else if (drumName === 'clap') {
      // 808 clap: layered noise bursts with short delays (3 micro-hits + tail)
      var clapMix = c.createGain();
      clapMix.gain.value = 1.0;
      connectToOutput(clapMix, 'percussion');

      // Three rapid noise micro-bursts at 0ms, 10ms, 20ms
      for (var ci = 0; ci < 3; ci++) {
        var clapBurstLen = Math.round(c.sampleRate * 0.01);
        var clapBurst = c.createBufferSource();
        clapBurst.buffer = _getNoiseBuffer(c, clapBurstLen);
        var clapBurstFilter = c.createBiquadFilter();
        clapBurstFilter.type = 'bandpass';
        clapBurstFilter.frequency.value = 1200;
        clapBurstFilter.Q.value = 0.5;
        var clapBurstGain = c.createGain();
        var burstTime = t + ci * 0.01;
        clapBurstGain.gain.setValueAtTime(vel * 0.5, burstTime);
        clapBurstGain.gain.exponentialRampToValueAtTime(0.001, burstTime + 0.012);
        clapBurst.connect(clapBurstFilter);
        clapBurstFilter.connect(clapBurstGain);
        clapBurstGain.connect(clapMix);
        clapBurst.start(burstTime);
      }

      // Noise tail — longer decay, bandpass filtered
      var clapTailLen = Math.round(c.sampleRate * 0.15);
      var clapTail = c.createBufferSource();
      clapTail.buffer = _getNoiseBuffer(c, clapTailLen);
      var clapTailFilter = c.createBiquadFilter();
      clapTailFilter.type = 'bandpass';
      clapTailFilter.frequency.value = 1000;
      clapTailFilter.Q.value = 0.7;
      var clapTailGain = c.createGain();
      clapTailGain.gain.setValueAtTime(vel * 0.6, t + 0.02);
      clapTailGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      clapTail.connect(clapTailFilter);
      clapTailFilter.connect(clapTailGain);
      clapTailGain.connect(clapMix);
      clapTail.start(t + 0.02);

    } else if (drumName === 'rimshot') {
      // Rimshot: short click (triangle osc) + high-pass filtered noise
      var rimOsc = c.createOscillator();
      var rimOscGain = c.createGain();
      rimOsc.type = 'triangle';
      rimOsc.frequency.value = 1700;
      rimOscGain.gain.setValueAtTime(vel * 0.6, t);
      rimOscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
      rimOsc.connect(rimOscGain);

      var rimNoiseBufLen = Math.round(c.sampleRate * 0.03);
      var rimNoise = c.createBufferSource();
      rimNoise.buffer = _getNoiseBuffer(c, rimNoiseBufLen);
      var rimHP = c.createBiquadFilter();
      rimHP.type = 'highpass';
      rimHP.frequency.value = 4000;
      var rimNoiseGain = c.createGain();
      rimNoiseGain.gain.setValueAtTime(vel * 0.4, t);
      rimNoiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
      rimNoise.connect(rimHP);
      rimHP.connect(rimNoiseGain);

      var rimMix = c.createGain();
      rimMix.gain.value = 1.0;
      rimOscGain.connect(rimMix);
      rimNoiseGain.connect(rimMix);
      connectToOutput(rimMix, 'percussion');
      rimOsc.start(t);
      rimOsc.stop(t + 0.02);
      rimNoise.start(t);

    } else if (drumName === 'cowbell') {
      // 808 cowbell: two detuned square waves through bandpass filter
      var cowOsc1 = c.createOscillator();
      var cowOsc2 = c.createOscillator();
      cowOsc1.type = 'square';
      cowOsc2.type = 'square';
      cowOsc1.frequency.value = 545;   // slightly detuned pair
      cowOsc2.frequency.value = 815;

      var cowBP = c.createBiquadFilter();
      cowBP.type = 'bandpass';
      cowBP.frequency.value = 680;
      cowBP.Q.value = 3.0;

      var cowGain = c.createGain();
      cowGain.gain.setValueAtTime(vel * 0.35, t);
      cowGain.gain.exponentialRampToValueAtTime(vel * 0.15, t + 0.01);  // sharp initial transient
      cowGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

      cowOsc1.connect(cowBP);
      cowOsc2.connect(cowBP);
      cowBP.connect(cowGain);
      connectToOutput(cowGain, 'percussion');
      cowOsc1.start(t);
      cowOsc2.start(t);
      cowOsc1.stop(t + 0.15);
      cowOsc2.stop(t + 0.15);

    } else if (drumName === 'ride' || drumName === 'crash' || drumName === 'splash') {
      // v2.6.0: Cymbal synthesis — filtered noise with longer decay
      // Use preset if available, else generic cymbal
      var cymbPreset = preset[drumName] || preset.hat ||
        { filterType: 'bandpass', filterFreq: 4000, filterQ: 0.5, gain: 0.20, decay: 0.30, bufDur: 0.30 };
      var cymbDecay = drumName === 'crash' ? 0.40 : drumName === 'ride' ? 0.25 : 0.15;
      if (cymbPreset.decay) cymbDecay = cymbPreset.decay;
      var cymbBufLen = Math.round(c.sampleRate * (cymbPreset.bufDur || cymbDecay));
      var cymbNoise = c.createBufferSource();
      cymbNoise.buffer = _getNoiseBuffer(c, cymbBufLen);
      var cymbFilt = c.createBiquadFilter();
      cymbFilt.type = cymbPreset.filterType || 'bandpass';
      cymbFilt.frequency.value = cymbPreset.filterFreq || 4000;
      if (cymbPreset.filterQ) cymbFilt.Q.value = cymbPreset.filterQ;
      var cymbGain = c.createGain();
      cymbGain.gain.setValueAtTime(vel * (cymbPreset.gain || 0.20), t);
      cymbGain.gain.exponentialRampToValueAtTime(0.001, t + cymbDecay);
      cymbNoise.connect(cymbFilt);
      cymbFilt.connect(cymbGain);
      connectToOutput(cymbGain, 'percussion');
      cymbNoise.start(t);

    } else if (drumName === 'shaker' || drumName === 'maracas' || drumName === 'cabasa' ||
               drumName === 'tambourine') {
      // v2.6.0: Shaker/auxiliary synthesis — very short filtered noise burst
      var shPreset = preset[drumName] || preset.shaker ||
        { filterType: 'highpass', filterFreq: 5000, gain: 0.15, decay: 0.03, bufDur: 0.03 };
      var shBufLen = Math.round(c.sampleRate * (shPreset.bufDur || 0.03));
      var shNoise = c.createBufferSource();
      shNoise.buffer = _getNoiseBuffer(c, shBufLen);
      var shFilt = c.createBiquadFilter();
      shFilt.type = shPreset.filterType || 'highpass';
      shFilt.frequency.value = shPreset.filterFreq || 5000;
      var shGain = c.createGain();
      shGain.gain.setValueAtTime(vel * (shPreset.gain || 0.15), t);
      shGain.gain.exponentialRampToValueAtTime(0.001, t + (shPreset.decay || 0.03));
      shNoise.connect(shFilt);
      shFilt.connect(shGain);
      connectToOutput(shGain, 'percussion');
      shNoise.start(t);
    }
  }


  // ═══ DRONE ═══
  //
  // Supports both oscillator (default) and instrument-based drones.
  // _droneInstrument: null = oscillator, string = instrumentLib key.
  // Instrument drones create 3 voices (root, +fifth, +octave) through the
  // instrument library, bypassing ADSR for continuous sustain.
  // BufferSource nodes are set to loop so sample instruments sustain.

  var droneOscs = null, droneGain = null, droneRoot = 0, droneVol = 0.03;
  var _droneInstrument = null;
  var _droneActive = false;

  // Phase 15b: Drone playback mode per instrument.
  // 'harmonic' (default): 3 voices — root, +fifth, +octave. Good for tonal instruments.
  // 'raw': single voice at original pitch, looped. Good for speech, clips, textures.
  // Set via SoundEngine.setDroneMode(instName, 'raw') or auto-detected on register.
  var _droneModes = {};

  function setDroneMode(instName, mode) {
    _droneModes[instName] = mode || 'harmonic';
  }
  function getDroneMode(instName) {
    return _droneModes[instName] || 'harmonic';
  }

  function setDroneVol(v) {
    droneVol = v;
    // Drone now uses its own strip — setVoiceGain targets the channelGain (post-FX fader)
    var s = strips['drone'];
    if (s && s.channelGain && ctx) {
      s.channelGain.gain.linearRampToValueAtTime(v, ctx.currentTime + 0.1);
    }
  }

  function startDrone(rootPC) {
    // v2.3: Drone harmonic sustain disabled — drone strip now used by lead voice
    // The continuous looped sustain conflicts with lead's note-by-note ADSR output.
    // To re-enable drone: remove this guard and add a separate 'drone' strip.
    console.log('startDrone(): disabled — drone strip reserved for lead voice');
    return;
    var c = ensureCtx(); droneRoot = rootPC;

    // Ensure drone strip exists (unified strip architecture)
    var strip = getStrip('drone');

    // Create a per-drone-instance gain node for crossfade control
    var newGain = c.createGain();
    newGain.gain.setValueAtTime(0, c.currentTime);
    newGain.gain.linearRampToValueAtTime(1.0, c.currentTime + 2);  // fade to unity — strip channelGain controls volume
    newGain.connect(strip.voiceGain);  // route into the strip's pre-FX input

    var baseMidi = rootPC + 48;
    var offsets = [0, 7, 12];
    var newNodes = [];
    var instName = _droneInstrument;
    var instFn = instName ? (instrumentLib[instName] || null) : null;

    if (instFn) {
      var mode = getDroneMode(instName);
      var normVal = getNormGain(instName);
      var droneNormGain = c.createGain();

      if (mode === 'raw') {
        // ── Raw clip drone ──
        // Single voice — normGain at full value
        droneNormGain.gain.value = normVal;
        droneNormGain.connect(newGain);

        var freq = 440 * Math.pow(2, (60 - 69) / 12); // C4
        var inst = instFn(c, freq);
        inst.output.connect(droneNormGain);
        for (var rni = 0; rni < inst.nodes.length; rni++) {
          var rNode = inst.nodes[rni];
          if (rNode.buffer !== undefined && rNode.loop !== undefined) {
            rNode.loop = true;
          }
          try { rNode.start(); } catch(e) {}
          newNodes.push(rNode);
        }
      } else {
        // ── Harmonic drone ──
        // 3 voices sum into droneNormGain — divide by voice count to normalize amplitude
        droneNormGain.gain.value = normVal / offsets.length;
        droneNormGain.connect(newGain);

        for (var oi = 0; oi < offsets.length; oi++) {
          var midi = baseMidi + offsets[oi];
          var freq = 440 * Math.pow(2, (midi - 69) / 12);
          var inst = instFn(c, freq);
          inst.output.connect(droneNormGain);
          for (var ni = 0; ni < inst.nodes.length; ni++) {
            var node = inst.nodes[ni];
            if (node.buffer !== undefined && node.loop !== undefined) {
              node.loop = true;
            }
            try { node.start(); } catch(e) {}
            newNodes.push(node);
          }
        }
      }
    } else {
      // ── Oscillator drone (original behavior) ──
      // 3 oscillators sum — divide by voice count to match instrument drone levels
      var oscNormGain = c.createGain();
      oscNormGain.gain.value = 1.0 / offsets.length;
      oscNormGain.connect(newGain);
      var freq = 440 * Math.pow(2, (baseMidi - 69) / 12);
      for (var oi2 = 0; oi2 < offsets.length; oi2++) {
        var o = c.createOscillator(); o.type = 'sine';
        o.frequency.value = freq * Math.pow(2, offsets[oi2] / 12);
        o.connect(oscNormGain); o.start(); newNodes.push(o);
      }
    }

    // Crossfade from old drone if active
    if (droneOscs && droneGain) {
      var oldG = droneGain, oldO = droneOscs;
      oldG.gain.linearRampToValueAtTime(0, c.currentTime + 1.5);
      setTimeout(function() {
        for (var k = 0; k < oldO.length; k++) { try { oldO[k].stop(); } catch(e) {} }
        try { oldG.disconnect(); } catch(e) {}
      }, 1800);
    }
    droneOscs = newNodes; droneGain = newGain;
    _droneActive = true;

    // Set drone strip gain to match current droneVol
    strip.channelGain.gain.setValueAtTime(droneVol, c.currentTime);
  }

  function stopDrone() {
    if (droneGain) { var c = ensureCtx(); droneGain.gain.linearRampToValueAtTime(0, c.currentTime + 1.5); }
    if (droneOscs) {
      var os = droneOscs, og = droneGain;
      setTimeout(function() {
        for (var k = 0; k < os.length; k++) { try { os[k].stop(); } catch(e) {} }
        try { if (og) og.disconnect(); } catch(e) {}
      }, 1800);
      droneOscs = null;
    }
    _droneActive = false;
  }

  function setDroneKey(rootPC) { if (!droneOscs || rootPC === droneRoot) return; startDrone(rootPC); }
  function getDroneRoot() { return droneRoot; }

  function setDroneInstrument(instName) {
    _droneInstrument = instName || null;
    if (_droneActive) {
      // Restart drone with the new instrument (crossfade handled by startDrone)
      startDrone(droneRoot);
    }
  }

  function getDroneInstrument() { return _droneInstrument; }

  // Drone analyser: now built into the drone strip. Legacy compat kept.
  var _droneAnalyserNode = null;
  function connectDroneAnalyser(analyserNode) {
    // Legacy compat — callers should use getAnalyser('drone') instead.
    _droneAnalyserNode = analyserNode;
  }


  // ═══ SETTERS ═══

  function setReverb(v) {
    reverbAmount = v;
    if (dryGain) dryGain.gain.value = 1 - v;
    if (wetGain) wetGain.gain.value = v;
  }
  function setSustain(v) { globalSustain = v; }
  function setSustainPedal(on) { sustainPedal = on; }
  function setInstrument(v) { globalInstrument = v; }

  function setVoiceGain(voiceName, value) {
    var s = getStrip(voiceName);
    if (s && s.channelGain) s.channelGain.gain.linearRampToValueAtTime(value, ctx.currentTime + 0.05);
  }

  // Pre-FX send level — controls how hard signal drives the FX bus
  function setVoiceSendLevel(voiceName, value) {
    var s = getStrip(voiceName);
    if (s && s.voiceGain) s.voiceGain.gain.linearRampToValueAtTime(value, ctx.currentTime + 0.05);
  }

  // ═══ PER-CHANNEL FX ═══
  //
  // addChannelFX(voiceName, fxNode): connects an AudioNode as a parallel send in the channel's FX bus.
  //   fxNode must have both input and output (e.g., ConvolverNode, DelayNode, BiquadFilterNode).
  //   Returns an index for later removal.
  //
  // removeChannelFX(voiceName, index): disconnects and removes a send.
  //
  // setChannelFXMix(voiceName, wetAmount): adjusts dry/wet balance (0 = fully dry, 1 = fully wet).

  function addChannelFX(voiceName, fxNode) {
    var s = getStrip(voiceName);
    if (!s || !s.fxBus || !ctx) return -1;

    var sendGain = ctx.createGain();
    sendGain.gain.value = 1.0;
    var returnGain = ctx.createGain();
    returnGain.gain.value = 1.0;

    s.voiceGain.connect(sendGain);
    sendGain.connect(fxNode);
    fxNode.connect(returnGain);
    returnGain.connect(s.fxBus.mix);

    var entry = { sendGain: sendGain, processor: fxNode, returnGain: returnGain };
    s.fxBus.sends.push(entry);
    return s.fxBus.sends.length - 1;
  }

  function removeChannelFX(voiceName, index) {
    var s = getStrip(voiceName);
    if (!s || !s.fxBus || index < 0 || index >= s.fxBus.sends.length) return;

    var entry = s.fxBus.sends[index];
    try { s.voiceGain.disconnect(entry.sendGain); } catch(e) {}
    try { entry.sendGain.disconnect(entry.processor); } catch(e) {}
    try { entry.processor.disconnect(entry.returnGain); } catch(e) {}
    try { entry.returnGain.disconnect(s.fxBus.mix); } catch(e) {}
    s.fxBus.sends.splice(index, 1);
  }

  function setChannelFXMix(voiceName, wetAmount) {
    var s = getStrip(voiceName);
    if (!s || !s.fxBus || !ctx) return;
    var t = ctx.currentTime + 0.05;
    // dry path goes down as wet goes up
    s.fxBus.dry.gain.linearRampToValueAtTime(1 - wetAmount, t);
    // Scale all send returns by wet amount
    for (var i = 0; i < s.fxBus.sends.length; i++) {
      s.fxBus.sends[i].returnGain.gain.linearRampToValueAtTime(wetAmount, t);
    }
  }
  function setVoicePan(voiceName, value) {
    var s = getStrip(voiceName);
    if (s && s.panner && s.panner.pan) s.panner.pan.linearRampToValueAtTime(value, ctx.currentTime + 0.05);
  }
  function setVoiceInstrument(voiceName, inst) { voiceInstruments[voiceName] = inst; }
  function getVoiceInstrument(voiceName) { return voiceInstruments[voiceName] || globalInstrument; }
  function setVoiceEnvelope(voiceName, adsr) { if (adsr) VOICE_ENVELOPES[voiceName] = adsr; }
  function setVoiceFilter(voiceName, type, freq, q) {
    var s = getStrip(voiceName);
    if (!s) return;
    if (!type) {
      if (s.filter) {
        s.panner.disconnect(s.filter);
        s.filter.disconnect();
        s.panner.connect(dryGain);
        if (reverbNode) s.panner.connect(reverbNode);
        s.output = s.panner; s.filter = null;
      }
      return;
    }
    if (!s.filter) {
      s.filter = ctx.createBiquadFilter();
      // Disconnect panner from bus, insert filter
      s.panner.disconnect();
      s.panner.connect(s.filter);
      s.filter.connect(dryGain);
      if (reverbNode) s.filter.connect(reverbNode);
      s.output = s.filter;
    }
    s.filter.type = type;
    s.filter.frequency.value = freq || 1000;
    s.filter.Q.value = q || 0.7;
  }

  function registerInstrument(name, fn, envelope, normGain, opts) {
    instrumentLib[name] = fn;
    if (envelope) INSTRUMENT_ENVELOPES[name] = envelope;
    if (normGain !== undefined) INSTRUMENT_NORM[name] = normGain;
    // Phase 15b: auto-set drone mode for single-sample instruments (speech, clips)
    if (opts && opts.droneMode) {
      _droneModes[name] = opts.droneMode;
    }
  }

  function setMasterVolume(v) {
    if (masterGain) {
      var c = ensureCtx();
      masterGain.gain.linearRampToValueAtTime(Math.max(0, Math.min(2, v)), c.currentTime + 0.05);
    }
  }

  function getMasterVolume() {
    return masterGain ? masterGain.gain.value : 0.85;
  }

  function setNormGain(instName, value) {
    INSTRUMENT_NORM[instName] = value;
  }

  function getNormGains() {
    var result = {};
    for (var k in INSTRUMENT_NORM) result[k] = INSTRUMENT_NORM[k];
    return result;
  }

  function getCtx() {
    return ensureCtx();
  }

  function getInstrumentNames() {
    var names = [];
    for (var k in instrumentLib) names.push(k);
    return names;
  }


  // ═══ PER-VOICE ANALYSER TAPS ═══
  //
  // Analysers are now built into each strip (created in getStrip).
  // Tap point: post-channelGain, pre-panner — shows the actual signal
  // the channel contributes to the mix (including FX), at full level.
  //
  // connectAnalyser is kept for backward compat but uses the built-in analyser.
  // getAnalyser is the preferred API.

  function connectAnalyser(voiceName, analyserNode) {
    // Legacy compat — callers that still create their own AnalyserNode.
    // We ignore the external node and return the built-in one instead.
    // The caller should use getAnalyser() to read data.
  }

  function getAnalyser(voiceName) {
    var s = getStrip(voiceName);
    return s ? s.analyser : null;
  }

  // Legacy alias
  function getVoiceAnalyser(voiceName) {
    return getAnalyser(voiceName);
  }


  // ═══ RECORDING STREAM (Phase 15) ═══
  //
  // Returns a MediaStreamDestination connected to the limiter output
  // (same final signal sent to speakers). Caller wraps it in MediaRecorder.
  // Creates only one destination — subsequent calls return the same node.

  var _recordDest = null;

  function getRecordingStream() {
    var c = ensureCtx();
    if (_recordDest) return _recordDest;
    if (!_limiter) return null;
    _recordDest = c.createMediaStreamDestination();
    _limiter.connect(_recordDest);
    return _recordDest;
  }


  // ═══ PUBLIC ═══

  return {
    noteOn: noteOn,
    noteOff: noteOff,
    releaseNote: releaseNote,
    releaseVoice: releaseVoice,
    killVoice: killVoice,
    killAll: killAll,
    getActiveNotes: getActiveNotes,
    getActivePoly: getActivePoly,
    playNote: playNote,
    playGrace: playGrace,
    playClick: playClick,
    playDrum: playDrum,
    setReverb: setReverb,
    setSustain: setSustain,
    getSustain: function() { return globalSustain; },
    setSustainPedal: setSustainPedal,
    setInstrument: setInstrument,
    ensureCtx: ensureCtx,
    setVoiceGain: setVoiceGain,
    setVoiceSendLevel: setVoiceSendLevel,
    addChannelFX: addChannelFX,
    removeChannelFX: removeChannelFX,
    setChannelFXMix: setChannelFXMix,
    setVoicePan: setVoicePan,
    setVoiceInstrument: setVoiceInstrument,
    getVoiceInstrument: getVoiceInstrument,
    setVoiceEnvelope: setVoiceEnvelope,
    setVoiceFilter: setVoiceFilter,
    registerInstrument: registerInstrument,
    setMasterVolume: setMasterVolume,
    getMasterVolume: getMasterVolume,
    setNormGain: setNormGain,
    getNormGains: getNormGains,
    getCtx: getCtx,
    getInstrumentNames: getInstrumentNames,
    getCompressorReduction: function() { return compressor ? compressor.reduction : 0; },
    isVoiceSounding: function(v) {
      var notes = getVoiceNotes(v);
      for (var i = 0; i < notes.length; i++) {
        if (!notes[i].releasing) return true;
      }
      return false;
    },
    startDrone: startDrone,
    stopDrone: stopDrone,
    setDroneKey: setDroneKey,
    getDroneRoot: getDroneRoot,
    setDroneVol: setDroneVol,
    setDroneInstrument: setDroneInstrument,
    getDroneInstrument: getDroneInstrument,
    connectDroneAnalyser: connectDroneAnalyser,
    connectAnalyser: connectAnalyser,
    getAnalyser: getAnalyser,
    getVoiceAnalyser: getVoiceAnalyser,
    getRecordingStream: getRecordingStream,
    setDroneMode: setDroneMode,
    getDroneMode: getDroneMode
  };
})();

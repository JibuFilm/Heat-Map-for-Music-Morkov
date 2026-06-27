'use strict';
// ═══ SAMPLE LOADER (Phase 7) ═══
//
// Three ways to load sample instruments:
//
// 1. CDN:   SampleLoader.loadFromCDN('acoustic_grand_piano', {}, cb)
//           Fetches from gleitz GitHub Pages. 128 GM instruments available.
//
// 2. URL:   SampleLoader.load('mySound', 'https://example.com/sound-mp3.js', cb)
//           Fetches any gleitz-format soundfont JS file from a URL.
//
// 3. LOCAL: SampleLoader.loadFromFile('mySound', file, cb)
//           Accepts a File object from <input type="file"> or drag-drop.
//           Supports: gleitz-format .js, single audio file (.wav/.mp3/.ogg),
//           or a folder of audio files named by note (C4.wav, Db3.mp3, etc.)
//
// 4. PICK:  SampleLoader.pickFile('mySound', cb)
//           Opens a file picker dialog. Accepts .js soundfont or audio files.
//
// 5. BATCH: SampleLoader.loadDefaults(callback)
//           Loads a curated set of instruments for immediate use.
//
// All paths end at the same place: decoded AudioBuffers registered into
// SoundEngine via registerInstrument(). Sample instruments plug into the
// same ADSR → channel strip → master bus pipeline as oscillator instruments.
//
// Load order: after sound-engine.js.

var SampleLoader = (function() {

  // ── CDN config ──
  var cdnBase = 'https://gleitz.github.io/midi-js-soundfonts';
  var defaultSoundfont = 'FluidR3_GM';
  var defaultFormat = 'mp3';

  // ── Loaded sample buffers ──
  var loaded = {};
  var loading = {};

  // ── Note name → MIDI number mapping ──
  function noteNameToMidi(name) {
    // Support both standard (C#4, Db4) and ToneJS (Cs4, Ds4) sharp notation
    var match = name.match(/^([A-Ga-g][b#s]?)(\d+)$/);
    if (!match) return -1;
    var note = match[1];
    var octave = parseInt(match[2], 10);
    var noteMap = {
      'C': 0, 'C#': 1, 'Cs': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Ds': 3, 'Eb': 3,
      'E': 4, 'F': 5, 'F#': 6, 'Fs': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Gs': 8, 'Ab': 8,
      'A': 9, 'A#': 10, 'As': 10, 'Bb': 10, 'B': 11
    };
    var pc = noteMap[note];
    if (pc === undefined) return -1;
    return (octave + 1) * 12 + pc;
  }


  // ── Parse gleitz-format soundfont JS ──
  // Uses regex extraction (no eval/new Function — compatible with Electron CSP)
  function parseSoundfontJS(text) {
    var noteMap = {};
    var regex = /"([A-Ga-g][b#]?\d+)"\s*:\s*"(data:audio[^"]+)"/g;
    var m;
    while ((m = regex.exec(text)) !== null) {
      var midi = noteNameToMidi(m[1]);
      if (midi >= 0) noteMap[midi] = m[2];
    }
    return noteMap;
  }


  // ── Decode base64 data URIs into AudioBuffers ──
  function decodeNoteMap(noteMap, callback) {
    var ctx = SoundEngine.getCtx();
    var buffers = {};
    var keys = [];
    for (var k in noteMap) keys.push(k);
    if (keys.length === 0) { callback(buffers); return; }

    var done = 0, total = keys.length;
    for (var i = 0; i < keys.length; i++) {
      (function(midi) {
        var dataUri = noteMap[midi];
        var base64 = dataUri.replace(/^data:audio\/[^;]+;base64,/, '');
        var binary = atob(base64);
        var len = binary.length;
        var bytes = new Uint8Array(len);
        for (var j = 0; j < len; j++) bytes[j] = binary.charCodeAt(j);

        ctx.decodeAudioData(bytes.buffer, function(audioBuffer) {
          buffers[midi] = audioBuffer;
          done++;
          if (done === total) callback(buffers);
        }, function() {
          done++;
          if (done === total) callback(buffers);
        });
      })(keys[i]);
    }
  }


  // ── Decode raw ArrayBuffer (audio file) into AudioBuffer ──
  function decodeAudioArrayBuffer(arrayBuffer, callback) {
    var ctx = SoundEngine.getCtx();
    function doDecode() {
      ctx.decodeAudioData(arrayBuffer, function(buf) {
        callback(buf);
      }, function(err) {
        console.error('SampleLoader: decodeAudioData failed:', err);
        callback(null);
      });
    }
    if (ctx.state === 'suspended') {
      ctx.resume().then(doDecode).catch(function(err) {
        console.error('SampleLoader: AudioContext.resume() failed:', err);
        callback(null);
      });
    } else {
      doDecode();
    }
  }


  // ── Create instrument function from decoded buffers ──
  // vol parameter is now applied via a GainNode (was previously discarded).
  function createSampleInstrument(buffers) {
    return function(c, freq, vol) {
      var targetMidi = Math.round(69 + 12 * Math.log(freq / 440) / Math.LN2);
      var bestMidi = -1, bestDist = 999;
      for (var m in buffers) {
        var dist = Math.abs(parseInt(m, 10) - targetMidi);
        if (dist < bestDist) { bestDist = dist; bestMidi = parseInt(m, 10); }
      }
      if (bestMidi < 0 || !buffers[bestMidi]) {
        var g = c.createGain(); g.gain.value = 0;
        return { output: g, nodes: [] };
      }
      var src = c.createBufferSource();
      src.buffer = buffers[bestMidi];
      if (bestMidi !== targetMidi) {
        src.playbackRate.value = Math.pow(2, (targetMidi - bestMidi) / 12);
      }
      // Pass-through at unity — normGain is applied by the ADSR envelope in SoundEngine.noteOn()
      // (Previously applied vol here too, causing double normGain application)
      var mix = c.createGain();
      mix.gain.value = 1.0;
      src.connect(mix);
      return { output: mix, nodes: [src] };
    };
  }


  // ── Measure peak amplitude across all buffers ──
  function measurePeakAmplitude(buffers) {
    var peak = 0;
    for (var m in buffers) {
      var buf = buffers[m];
      for (var ch = 0; ch < buf.numberOfChannels; ch++) {
        var data = buf.getChannelData(ch);
        for (var i = 0; i < data.length; i++) {
          var abs = Math.abs(data[i]);
          if (abs > peak) peak = abs;
        }
      }
    }
    return peak;
  }

  // ── Shared: finish loading — register instrument ──
  function finishLoad(instName, buffers) {
    var bufCount = 0;
    for (var k in buffers) bufCount++;
    if (bufCount === 0) {
      console.error('SampleLoader: no samples decoded for ' + instName);
      resolveCallback(instName, false);
      return;
    }
    console.log('SampleLoader: ' + instName + ' ready (' + bufCount + ' samples)');

    loaded[instName] = buffers;
    var instFn = createSampleInstrument(buffers);
    var sampleEnv = { a: 0.005, d: 0.1, s: 0.8, r: 0.3 };

    // Runtime peak measurement for normalization.
    // Target ~0.85 peak output — near-unity normalization.
    // normGain is applied once via the ADSR envelope (SoundEngine.noteOn)
    // or the droneNormGain node. NOT inside createSampleInstrument().
    var peak = measurePeakAmplitude(buffers);
    var normGain = (peak > 0.01) ? (0.85 / peak) : 1.0;
    // Clamp to reasonable range (0.2 to 4.0) — don't over-amplify silence or clip loud samples
    normGain = Math.max(0.2, Math.min(4.0, normGain));

    // Phase 15b: single-sample instruments (speech, clips) get 'raw' drone mode.
    // Multi-sample soundfonts (GM instruments) get default 'harmonic' mode.
    var opts = (bufCount <= 2) ? { droneMode: 'raw' } : {};
    SoundEngine.registerInstrument(instName, instFn, sampleEnv, normGain, opts);
    console.log('SampleLoader: ' + instName + ' normGain=' + normGain.toFixed(3) + ' (peak=' + peak.toFixed(3) + ')');
    // v5.1.0: Auto-detect timbre profile for expression engine
    // Guarded: must not throw or finishLoad callback is lost
    try {
      if (typeof TimbreProfile !== 'undefined' && TimbreProfile.detectFromBuffers) {
        TimbreProfile.detectFromBuffers(instName, buffers);
      }
    } catch(e) {
      console.warn('TimbreProfile auto-detect failed for ' + instName + ':', e.message);
    }
  }

  function resolveCallback(instName, success) {
    var cb = loading[instName];
    delete loading[instName];
    if (cb) cb(success);
  }


  // ═══ LOAD FROM URL ═══

  function load(instName, url, callback) {
    if (loaded[instName]) { if (callback) callback(true); return; }
    if (loading[instName]) {
      if (callback) {
        var prev = loading[instName];
        loading[instName] = function(ok) { prev(ok); callback(ok); };
      }
      return;
    }
    loading[instName] = callback || function() {};
    console.log('SampleLoader: fetching ' + instName);

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function() {
      // file:// protocol returns status 0 on success; accept both 0 and 200
      if (xhr.status !== 200 && xhr.status !== 0) {
        console.error('SampleLoader: HTTP ' + xhr.status + ' for ' + instName);
        resolveCallback(instName, false);
        return;
      }
      if (!xhr.responseText || xhr.responseText.length < 100) {
        console.error('SampleLoader: empty response for ' + instName);
        resolveCallback(instName, false);
        return;
      }
      var noteMap = parseSoundfontJS(xhr.responseText);
      decodeNoteMap(noteMap, function(buffers) {
        try {
          finishLoad(instName, buffers);
          resolveCallback(instName, true);
        } catch(e) {
          console.error('SampleLoader: finishLoad failed for ' + instName + ':', e);
          resolveCallback(instName, false);
        }
      });
    };
    xhr.onerror = function() {
      console.error('SampleLoader: network error for ' + instName);
      resolveCallback(instName, false);
    };
    xhr.send();
  }


  // ═══ IPC PROXY LOADER (Electron only) ═══
  // Fetches soundfont JS text via main process IPC, bypassing CSP restrictions
  function _loadViaIPC(instName, cdnUrl, callback) {
    if (!window.gen3 || !window.gen3.sound || !window.gen3.sound.fetchCDN) {
      console.error('SampleLoader: IPC proxy unavailable for ' + instName);
      resolveCallback(instName, false);
      return;
    }
    if (loaded[instName]) { resolveCallback(instName, true); return; }
    if (loading[instName]) {
      var prev = loading[instName];
      loading[instName] = function(ok) { prev(ok); if (callback) callback(ok); };
      return;
    }
    loading[instName] = callback || function() {};
    console.log('SampleLoader: IPC fetch ' + instName + ' from CDN');

    window.gen3.sound.fetchCDN(cdnUrl).then(function(text) {
      if (!text || text.length < 100) {
        console.error('SampleLoader: IPC empty response for ' + instName);
        resolveCallback(instName, false);
        return;
      }
      var noteMap = parseSoundfontJS(text);
      decodeNoteMap(noteMap, function(buffers) {
        try {
          finishLoad(instName, buffers);
          resolveCallback(instName, true);
        } catch(e) {
          console.error('SampleLoader: finishLoad failed for ' + instName + ':', e);
          resolveCallback(instName, false);
        }
      });
    }).catch(function(err) {
      console.error('SampleLoader: IPC error for ' + instName + ':', err);
      resolveCallback(instName, false);
    });
  }

  // ═══ LOAD FROM CDN ═══

  function loadFromCDN(instName, opts, callback) {
    opts = opts || {};
    var sf = opts.soundfont || defaultSoundfont;
    var fmt = opts.format || defaultFormat;
    var base = opts.cdnBase || cdnBase;

    // Electron: try bundled local samples first, then IPC-proxied CDN fetch
    // (XHR from file:// origin is blocked by CSP; IPC goes through main process)
    if (window.gen3) {
      var cdnUrl = base + '/' + sf + '/' + instName + '-' + fmt + '.js';
      var localUrl = 'data/samples/' + instName + '-' + fmt + '.js';
      var testXhr = new XMLHttpRequest();
      testXhr.open('GET', localUrl, true);
      testXhr.onload = function() {
        if ((testXhr.status === 200 || testXhr.status === 0) &&
            testXhr.responseText && testXhr.responseText.length > 100) {
          console.log('SampleLoader: loading ' + instName + ' from local bundle');
          load(instName, localUrl, callback);
        } else {
          // Local not found — use IPC proxy to fetch from CDN via main process
          _loadViaIPC(instName, cdnUrl, callback);
        }
      };
      testXhr.onerror = function() {
        _loadViaIPC(instName, cdnUrl, callback);
      };
      testXhr.send();
      return;
    }

    var url = base + '/' + sf + '/' + instName + '-' + fmt + '.js';
    load(instName, url, callback);
  }


  // ═══ LOAD FROM TONEJS-INSTRUMENTS ═══
  //
  // Loads multi-sample instruments from the tonejs-instruments format.
  // Each instrument is a folder of MP3 files named by note (e.g., A2.mp3, C4.mp3).
  // These are higher-fidelity recordings than the Gleitz GM soundfonts.

  // Known tonejs instruments and their available sample notes
  var TONEJS_INSTRUMENTS = {
    'bass-electric':   ['E1','G1','E2','G2','E3','G3','E4','G4','As1','As2','As3','As4','Cs1','Cs2','Cs3','Cs4'],
    'guitar-acoustic': ['A2','C3','E2','G2','A3','C4','E3','G3','A4','C5','E4','G4'],
    'guitar-electric': ['A2','C3','E2','A3','C4','A4','C5','A5','C6'],
    'saxophone':       ['D3','E3','G3','A4','C4','D4','E4','G4','A5','C5','D5','E5','G5','Ds3','Fs3','As3','Cs4','Ds4','Fs4','As4','Cs5','Ds5','Fs5'],
    'violin':          ['G3','A3','C4','E4','G4','A4','C5','E5','A5','C6','E6','A6','G5','G6','C7'],
    'harp':            ['E1','G1','B1','A2','D2','C3','E3','G3','B3','A4','D4','C5','E5','G5','B5','A6','D6'],
    'harmonium':       ['C2','E2','G2','A2','C3','E3','G3','A3','C4','E4','G4','A4','C5'],
    'contrabass':      ['G1','A2','C2','D2','E2','E3','B3'],
    'french-horn':     ['A1','C2','G2','A3','D3','F3','C4','D5','F5'],
    'trombone':        ['F2','C3','D3','F3','C4','D4','F4']
  };

  function loadFromToneJS(instName, callback) {
    if (loaded[instName]) { if (callback) callback(true); return; }
    var notes = TONEJS_INSTRUMENTS[instName];
    if (!notes) { if (callback) callback(false); return; }

    loading[instName] = callback || function() {};
    console.log('SampleLoader: loading tonejs ' + instName + ' (' + notes.length + ' samples)');

    var ctx = SoundEngine.getCtx();
    var buffers = {};
    var done = 0, total = notes.length;

    for (var i = 0; i < notes.length; i++) {
      (function(noteName) {
        var midi = noteNameToMidi(noteName);
        var url = 'data/samples/tonejs/' + instName + '/' + noteName + '.mp3';
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function() {
          if ((xhr.status === 200 || xhr.status === 0) && xhr.response) {
            ctx.decodeAudioData(xhr.response, function(audioBuffer) {
              buffers[midi] = audioBuffer;
              done++;
              if (done === total) {
                try { finishLoad(instName, buffers); } catch(e) { console.error('SampleLoader: finishLoad failed for ' + instName, e); }
                resolveCallback(instName, true);
              }
            }, function() {
              done++;
              if (done === total) { try { finishLoad(instName, buffers); } catch(e) { console.error('SampleLoader: finishLoad failed for ' + instName, e); } resolveCallback(instName, true); }
            });
          } else {
            done++;
            if (done === total) {
              if (Object.keys(buffers).length > 0) { try { finishLoad(instName, buffers); } catch(e) { console.error('SampleLoader: finishLoad failed for ' + instName, e); } resolveCallback(instName, true); }
              else resolveCallback(instName, false);
            }
          }
        };
        xhr.onerror = function() {
          done++;
          if (done === total) {
            if (Object.keys(buffers).length > 0) { try { finishLoad(instName, buffers); } catch(e) { console.error('SampleLoader: finishLoad failed for ' + instName, e); } resolveCallback(instName, true); }
            else resolveCallback(instName, false);
          }
        };
        xhr.send();
      })(notes[i]);
    }
  }


  // ═══ LOAD FROM LOCAL FILE ═══
  //
  // Accepts a File object. Two modes:
  //
  // A) Gleitz-format .js soundfont:
  //    Contains all notes as base64 data URIs. Same parsing as CDN.
  //
  // B) Single audio file (.wav, .mp3, .ogg, .flac):
  //    Loaded as a single-sample instrument. All notes pitch-shift from
  //    a reference note. Default reference: C4 (midi 60). Override with
  //    opts.referenceMidi.
  //
  // Detect mode by file extension.

  function loadFromFile(instName, file, callback, opts) {
    if (loaded[instName]) { if (callback) callback(true); return; }
    opts = opts || {};
    loading[instName] = callback || function() {};

    var ext = (file.name || '').split('.').pop().toLowerCase();

    if (ext === 'js') {
      // Gleitz-format soundfont
      var reader = new FileReader();
      reader.onload = function(e) {
        var noteMap = parseSoundfontJS(e.target.result);
        decodeNoteMap(noteMap, function(buffers) {
          try {
            finishLoad(instName, buffers);
            resolveCallback(instName, true);
          } catch(err) {
            console.error('SampleLoader: finishLoad failed for ' + instName + ':', err);
            resolveCallback(instName, false);
          }
        });
      };
      reader.onerror = function() {
        console.error('SampleLoader: file read error for ' + instName);
        resolveCallback(instName, false);
      };
      reader.readAsText(file);
    } else if (ext === 'wav' || ext === 'mp3' || ext === 'ogg' || ext === 'flac' ||
               ext === 'webm' || ext === 'm4a' || ext === 'aac') {
      // Single audio file → single-sample instrument
      var refMidi = opts.referenceMidi || 60;
      var reader = new FileReader();
      reader.onload = function(e) {
        decodeAudioArrayBuffer(e.target.result, function(audioBuffer) {
          if (!audioBuffer) {
            console.error('SampleLoader: decode failed for ' + instName);
            resolveCallback(instName, false);
            return;
          }
          var buffers = {};
          buffers[refMidi] = audioBuffer;
          finishLoad(instName, buffers);
          resolveCallback(instName, true);
        });
      };
      reader.onerror = function() {
        console.error('SampleLoader: file read error for ' + instName);
        resolveCallback(instName, false);
      };
      reader.readAsArrayBuffer(file);
    } else {
      console.error('SampleLoader: unsupported file type ".' + ext + '" for ' + instName);
      resolveCallback(instName, false);
    }
  }


  // ═══ LOAD MULTIPLE AUDIO FILES (multi-sample) ═══
  //
  // files: array of { file: File, midi: int } or { file: File, note: 'C4' }
  // Each file is one sample mapped to a specific note.

  function loadFromFiles(instName, files, callback) {
    if (loaded[instName]) { if (callback) callback(true); return; }
    loading[instName] = callback || function() {};

    var buffers = {};
    var done = 0, total = files.length;

    if (total === 0) {
      resolveCallback(instName, false);
      return;
    }

    for (var i = 0; i < files.length; i++) {
      (function(entry) {
        var midi = entry.midi;
        if (midi === undefined && entry.note) midi = noteNameToMidi(entry.note);
        if (midi === undefined || midi < 0) {
          done++;
          if (done === total) { finishLoad(instName, buffers); resolveCallback(instName, true); }
          return;
        }

        var reader = new FileReader();
        reader.onload = function(e) {
          decodeAudioArrayBuffer(e.target.result, function(audioBuffer) {
            if (audioBuffer) buffers[midi] = audioBuffer;
            done++;
            if (done === total) { finishLoad(instName, buffers); resolveCallback(instName, true); }
          });
        };
        reader.onerror = function() {
          done++;
          if (done === total) { finishLoad(instName, buffers); resolveCallback(instName, true); }
        };
        reader.readAsArrayBuffer(entry.file);
      })(files[i]);
    }
  }


  // ═══ FILE PICKER ═══
  //
  // Opens a browser file picker. User selects one or more files.
  // Single .js → gleitz soundfont. Single audio → single-sample.
  // Multiple audio → multi-sample (note names inferred from filenames).

  function pickFile(instName, callback, opts) {
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.js,.wav,.mp3,.ogg,.flac,.webm,.m4a,.aac';

    input.onchange = function() {
      var files = input.files;
      if (!files || files.length === 0) {
        if (callback) callback(false);
        return;
      }

      if (files.length === 1) {
        // Single file
        loadFromFile(instName, files[0], callback, opts);
      } else {
        // Multiple files — try to infer note names from filenames
        var entries = [];
        for (var i = 0; i < files.length; i++) {
          var name = files[i].name.replace(/\.[^.]+$/, ''); // strip extension
          var midi = noteNameToMidi(name);
          if (midi >= 0) {
            entries.push({ file: files[i], midi: midi });
          } else {
            // Try parsing as just a number (midi number as filename)
            var num = parseInt(name, 10);
            if (!isNaN(num) && num >= 0 && num <= 127) {
              entries.push({ file: files[i], midi: num });
            }
          }
        }
        if (entries.length > 0) {
          loadFromFiles(instName, entries, callback);
        } else {
          console.warn('SampleLoader: could not infer note names from filenames');
          // Load first file as single-sample fallback
          loadFromFile(instName, files[0], callback, opts);
        }
      }
    };

    input.click();
  }


  // ═══ DRAG & DROP SUPPORT ═══
  //
  // Call SampleLoader.enableDragDrop(elementId) to enable drag-drop loading
  // on a DOM element. Dropped files are loaded as a new instrument.

  function enableDragDrop(elementId, onLoadCallback) {
    var el = document.getElementById(elementId);
    if (!el) return;

    el.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopPropagation();
      el.style.outline = '2px dashed #d4b040';
    });

    el.addEventListener('dragleave', function(e) {
      e.preventDefault();
      el.style.outline = '';
    });

    el.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      el.style.outline = '';

      var files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      // Derive instrument name from first filename
      var firstName = files[0].name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_');
      var instName = 'custom_' + firstName;

      if (files.length === 1) {
        loadFromFile(instName, files[0], function(ok) {
          if (onLoadCallback) onLoadCallback(instName, ok);
        });
      } else {
        var entries = [];
        for (var i = 0; i < files.length; i++) {
          var name = files[i].name.replace(/\.[^.]+$/, '');
          var midi = noteNameToMidi(name);
          if (midi >= 0) entries.push({ file: files[i], midi: midi });
        }
        if (entries.length > 0) {
          loadFromFiles(instName, entries, function(ok) {
            if (onLoadCallback) onLoadCallback(instName, ok);
          });
        } else {
          loadFromFile(instName, files[0], function(ok) {
            if (onLoadCallback) onLoadCallback(instName, ok);
          });
        }
      }
    });
  }


  // ═══ DEFAULT INSTRUMENTS ═══
  //
  // Curated set loaded on startup for immediate use.
  // These map to classic Gen3 use cases:
  //   organ       → drawbar_organ (classic Berlin school, Tangerine Dream)
  //   berlin_lead → lead_2_sawtooth (classic analog sawtooth lead)
  //   reed        → oboe (warm, expressive reed)
  //   ensemble    → string_ensemble_1 (lush orchestral strings)
  //   epiano      → electric_piano_1 (Rhodes-style electric piano)

  var DEFAULT_INSTRUMENTS = [
    // Classic Gen3 — Berlin school / electronic
    { name: 'drawbar_organ',        alias: 'gm_organ' },
    { name: 'lead_2_sawtooth',      alias: 'gm_saw_lead' },
    { name: 'oboe',                 alias: 'gm_oboe' },
    { name: 'string_ensemble_1',    alias: 'gm_strings' },
    { name: 'electric_piano_1',     alias: 'gm_epiano' },
    // Synths & pads
    { name: 'pad_2_warm',           alias: 'gm_warm_pad' },
    { name: 'synth_brass_1',        alias: 'gm_synth_brass' },
    { name: 'lead_1_square',        alias: 'gm_square_lead' },
    // Acoustic
    { name: 'cello',                alias: 'gm_cello' },
    { name: 'flute',                alias: 'gm_flute' },
    { name: 'trumpet',              alias: 'gm_trumpet' },
    { name: 'choir_aahs',           alias: 'gm_choir' },
    // Keys
    { name: 'acoustic_grand_piano', alias: 'gm_piano' },
    { name: 'electric_grand_piano', alias: 'gm_grand_epiano' }
  ];

  var defaultsLoaded = false;

  // ToneJS instruments to load locally (higher fidelity, no CDN dependency).
  // These are loaded FIRST, then CDN instruments fill in the rest.
  var TONEJS_DEFAULTS = [
    { name: 'bass-electric',   alias: 'tj_bass' },
    { name: 'guitar-acoustic', alias: 'tj_acoustic_guitar' },
    { name: 'guitar-electric', alias: 'tj_electric_guitar' },
    { name: 'saxophone',       alias: 'tj_sax' },
    { name: 'violin',          alias: 'tj_violin' },
    { name: 'harp',            alias: 'tj_harp' },
    { name: 'harmonium',       alias: 'tj_harmonium' },
    { name: 'contrabass',      alias: 'tj_contrabass' },
    { name: 'french-horn',     alias: 'tj_french_horn' },
    { name: 'trombone',        alias: 'tj_trombone' }
  ];

  function _registerAlias(parentName, alias) {
    var buffers = loaded[parentName];
    if (!buffers) return;
    loaded[alias] = buffers;
    var instFn = createSampleInstrument(buffers);
    var sampleEnv = { a: 0.005, d: 0.1, s: 0.8, r: 0.3 };
    var parentNorm = SoundEngine.getNormGains()[parentName] || 1.0;
    SoundEngine.registerInstrument(alias, instFn, sampleEnv, parentNorm);
  }

  function loadDefaults(callback, onProgress) {
    if (defaultsLoaded) { if (callback) callback(true); return; }

    var allJobs = [];

    // Phase 1: Local ToneJS instruments (no network required)
    for (var t = 0; t < TONEJS_DEFAULTS.length; t++) {
      allJobs.push({ type: 'tonejs', name: TONEJS_DEFAULTS[t].name, alias: TONEJS_DEFAULTS[t].alias });
    }

    // Phase 2: CDN GM instruments (network required, fallback if offline)
    for (var c = 0; c < DEFAULT_INSTRUMENTS.length; c++) {
      allJobs.push({ type: 'cdn', name: DEFAULT_INSTRUMENTS[c].name, alias: DEFAULT_INSTRUMENTS[c].alias });
    }

    var total = allJobs.length;
    var remaining = total;
    var loadedCount = 0;
    var allOk = true;

    console.log('SampleLoader: loading ' + total + ' default instruments (' +
                TONEJS_DEFAULTS.length + ' local + ' + DEFAULT_INSTRUMENTS.length + ' CDN)...');

    function onJobDone(job, ok) {
      if (!ok) {
        console.warn('SampleLoader: failed to load ' + job.type + ' ' + job.name);
        allOk = false;
      } else if (job.alias) {
        _registerAlias(job.name, job.alias);
      }
      loadedCount++;
      remaining--;
      if (onProgress) onProgress(loadedCount, total, job.alias || job.name);
      if (remaining <= 0) {
        defaultsLoaded = true;
        console.log('SampleLoader: defaults loaded (' + (allOk ? 'all ok' : 'some failed') + ')');
        if (typeof populateInstSelects === 'function') populateInstSelects();
        if (callback) callback(allOk);
      }
    }

    for (var i = 0; i < allJobs.length; i++) {
      (function(job) {
        if (job.type === 'tonejs') {
          loadFromToneJS(job.name, function(ok) { onJobDone(job, ok); });
        } else {
          loadFromCDN(job.name, {}, function(ok) { onJobDone(job, ok); });
        }
      })(allJobs[i]);
    }
  }


  // ── Queries ──

  function isLoaded(instName) { return !!loaded[instName]; }

  function getLoadedNames() {
    var names = [];
    for (var k in loaded) names.push(k);
    return names;
  }

  function setDefaultCDN(url) { cdnBase = url; }
  function setDefaultSoundfont(name) { defaultSoundfont = name; }
  function setDefaultFormat(fmt) { defaultFormat = fmt; }


  // ═══ USER SAMPLE FOLDER SCANNING (Electron only) ═══
  //
  // Scans data/samples/user/ for audio files and auto-loads them as instruments.
  // Each file becomes an instrument named "user_<filename>".
  // Subdirectories containing note-named files (C4.mp3, etc.) become multi-sample instruments.
  //
  // Supported formats: .mp3, .wav, .ogg, .flac, .js (gleitz soundfont)
  //
  // Called on startup after loadDefaults(). Uses IPC to scan the directory.

  function loadUserSamples(callback) {
    if (!window.gen3 || !window.gen3.userSamples) {
      // Not in Electron or IPC not available — try XHR fallback for browser
      if (callback) callback([]);
      return;
    }

    window.gen3.userSamples.scan().then(function(entries) {
      if (!entries || entries.length === 0) {
        console.log('SampleLoader: no user samples found');
        if (callback) callback([]);
        return;
      }

      console.log('SampleLoader: found ' + entries.length + ' user sample(s)');
      var remaining = entries.length;
      var loadedNames = [];

      for (var i = 0; i < entries.length; i++) {
        (function(entry) {
          var instName = 'user_' + entry.name;
          if (loaded[instName]) {
            remaining--;
            loadedNames.push(instName);
            if (remaining <= 0) { _finishUserLoad(loadedNames, callback); }
            return;
          }

          if (entry.type === 'single') {
            // Single file: load via IPC
            window.gen3.sound.loadFile(entry.path).then(function(data) {
              if (!data || !data.buffer) { remaining--; if (remaining <= 0) _finishUserLoad(loadedNames, callback); return; }
              var binary;
              try { binary = atob(data.buffer); } catch (e) {
                console.error('SampleLoader: base64 decode failed for user sample ' + entry.name + ':', e.message);
                remaining--; if (remaining <= 0) _finishUserLoad(loadedNames, callback); return;
              }
              var bytes = new Uint8Array(binary.length);
              for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
              decodeAudioArrayBuffer(bytes.buffer, function(audioBuffer) {
                if (!audioBuffer) {
                  console.warn('SampleLoader: failed to decode user sample ' + entry.name);
                  remaining--;
                  if (remaining <= 0) _finishUserLoad(loadedNames, callback);
                  return;
                }
                var buffers = {};
                buffers[60] = audioBuffer;  // Map to C4
                finishLoad(instName, buffers);
                loadedNames.push(instName);
                remaining--;
                if (remaining <= 0) _finishUserLoad(loadedNames, callback);
              });
            }).catch(function(err) {
              console.error('SampleLoader: IPC error loading user sample ' + entry.name + ':', err);
              remaining--;
              if (remaining <= 0) _finishUserLoad(loadedNames, callback);
            });
          } else if (entry.type === 'multi') {
            // Multi-sample directory: load all note files
            var noteFiles = entry.notes;
            var buffers = {};
            var noteDone = 0, noteTotal = noteFiles.length;
            for (var ni = 0; ni < noteFiles.length; ni++) {
              (function(nf) {
                var midi = noteNameToMidi(nf.note);
                if (midi < 0) { noteDone++; if (noteDone === noteTotal) _finishMulti(); return; }
                window.gen3.sound.loadFile(nf.path).then(function(data) {
                  if (!data || !data.buffer) { noteDone++; if (noteDone === noteTotal) _finishMulti(); return; }
                  var binary;
                  try { binary = atob(data.buffer); } catch (e) {
                    console.error('SampleLoader: base64 decode failed for ' + nf.note + ':', e.message);
                    noteDone++; if (noteDone === noteTotal) _finishMulti(); return;
                  }
                  var bytes = new Uint8Array(binary.length);
                  for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
                  decodeAudioArrayBuffer(bytes.buffer, function(audioBuffer) {
                    if (audioBuffer) buffers[midi] = audioBuffer;
                    noteDone++;
                    if (noteDone === noteTotal) _finishMulti();
                  });
                }).catch(function(err) {
                  console.error('SampleLoader: IPC error loading note ' + nf.note + ':', err);
                  noteDone++; if (noteDone === noteTotal) _finishMulti();
                });
              })(noteFiles[ni]);
            }
            function _finishMulti() {
              if (Object.keys(buffers).length > 0) {
                try {
                  finishLoad(instName, buffers);
                  loadedNames.push(instName);
                } catch(err) {
                  console.error('SampleLoader: finishLoad failed for ' + instName + ':', err);
                }
              }
              remaining--;
              if (remaining <= 0) _finishUserLoad(loadedNames, callback);
            }
          } else if (entry.type === 'soundfont') {
            // .js soundfont file
            window.gen3.fs.readExternal(entry.path).then(function(text) {
              if (!text) { remaining--; if (remaining <= 0) _finishUserLoad(loadedNames, callback); return; }
              var noteMap = parseSoundfontJS(text);
              decodeNoteMap(noteMap, function(buffers) {
                try {
                  finishLoad(instName, buffers);
                  loadedNames.push(instName);
                } catch(err) {
                  console.error('SampleLoader: finishLoad failed for ' + instName + ':', err);
                }
                remaining--;
                if (remaining <= 0) _finishUserLoad(loadedNames, callback);
              });
            }).catch(function() {
              remaining--;
              if (remaining <= 0) _finishUserLoad(loadedNames, callback);
            });
          } else {
            remaining--;
            if (remaining <= 0) _finishUserLoad(loadedNames, callback);
          }
        })(entries[i]);
      }
    }).catch(function(err) {
      console.error('SampleLoader: user samples scan error:', err);
      if (callback) callback([]);
    });
  }

  function _finishUserLoad(loadedNames, callback) {
    console.log('SampleLoader: user samples loaded: ' + loadedNames.join(', '));
    if (typeof populateInstSelects === 'function') populateInstSelects();
    if (callback) callback(loadedNames);
  }


  // ── PUBLIC ──

  return {
    load: load,
    loadFromCDN: loadFromCDN,
    loadFromToneJS: loadFromToneJS,
    getToneJSInstruments: function() { return TONEJS_INSTRUMENTS; },
    loadFromFile: loadFromFile,
    loadFromFiles: loadFromFiles,
    pickFile: pickFile,
    enableDragDrop: enableDragDrop,
    loadDefaults: loadDefaults,
    loadUserSamples: loadUserSamples,
    isLoaded: isLoaded,
    getLoadedNames: getLoadedNames,
    setDefaultCDN: setDefaultCDN,
    setDefaultSoundfont: setDefaultSoundfont,
    setDefaultFormat: setDefaultFormat,
    noteNameToMidi: noteNameToMidi
  };
})();

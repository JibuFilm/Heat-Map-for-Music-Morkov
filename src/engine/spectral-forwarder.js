'use strict';
// ═══ SPECTRAL FORWARDER (Layer 0 Pipeline) ═══
//
// Reads per-voice FFT magnitude data from SoundEngine's AnalyserNodes
// and forwards it to the native sidecar at ~10Hz for psychoacoustic analysis.
//
// Data flow:
//   SoundEngine.getAnalyser(voice) → getFloatFrequencyData → JSON
//   → SidecarBridge.send() → IPC → Unix socket → Swift vDSP
//
// Only runs when sidecar is connected. No-op otherwise.
// Pre-allocates Float32Arrays to avoid GC pressure.
//
// Depends on: sound-engine.js, sidecar-bridge.js
// Load order: after sidecar-bridge.js, before app.js tick wiring

var SpectralForwarder = (function() {

  var VOICES = ['bass', 'rhythm', 'soloist', 'lead', 'percussion'];

  // Pre-allocated FFT read buffers per voice (avoid alloc per tick)
  var _buffers = {};
  var _initialized = false;

  function _init() {
    if (_initialized) return;
    if (typeof SoundEngine === 'undefined' || !SoundEngine.getAnalyser) return;

    for (var i = 0; i < VOICES.length; i++) {
      var analyser = SoundEngine.getAnalyser(VOICES[i]);
      if (analyser) {
        _buffers[VOICES[i]] = {
          analyser: analyser,
          data: new Float32Array(analyser.frequencyBinCount)
        };
      }
    }
    _initialized = true;
  }

  // Called at ~10Hz from app.js tick loop
  function tick() {
    // Guard: only forward when sidecar is connected
    if (typeof SidecarBridge === 'undefined' || !SidecarBridge.isConnected()) return;

    if (!_initialized) _init();

    var voices = {};
    var hasData = false;

    for (var i = 0; i < VOICES.length; i++) {
      var name = VOICES[i];
      var buf = _buffers[name];
      if (!buf || !buf.analyser) continue;

      // Read current FFT magnitude spectrum (dB scale, 512 bins for 1024-pt FFT)
      buf.analyser.getFloatFrequencyData(buf.data);

      // Convert Float32Array to regular array for JSON serialization
      // Only include if there's actual signal (avoid sending silence)
      var hasSignal = false;
      var arr = new Array(buf.data.length);
      for (var j = 0; j < buf.data.length; j++) {
        arr[j] = buf.data[j];
        if (buf.data[j] > -90) hasSignal = true;  // above noise floor
      }

      if (hasSignal) {
        voices[name] = arr;
        hasData = true;
      }
    }

    if (hasData) {
      SidecarBridge.send({ type: 'audio_frame', voices: voices });
    }
  }

  // Reset buffers (e.g. on instrument change)
  function reset() {
    _buffers = {};
    _initialized = false;
  }

  return {
    tick: tick,
    reset: reset
  };

})();

console.log('%cSpectralForwarder loaded (Layer 0 FFT pipeline)', 'color:#8cf;font-family:monospace');

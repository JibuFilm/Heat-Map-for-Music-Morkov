'use strict';
// ═══ SIDECAR BRIDGE (v9.5.0) ═══
//
// Renderer-side bridge to the native sidecar process. Caches the latest
// results from each sidecar capability and provides typed getters.
// Publishes results to EventBus for decoupled consumption.
//
// CRITICAL DESIGN: Every consumer MUST check SidecarBridge.isReady() or
// use a fallback. The sidecar is optional — the ensemble works without it.
//
// Usage pattern in consumers:
//   var chord = SidecarBridge.isReady() ? SidecarBridge.getChord() : _legacyChordInference();
//
// Depends on: EventBus (optional — publishes if available)
// Load order: after timbral-evolution.js, before input-handler.js
//
// See: info/PROPOSAL_neural_engine_sidecar.md

var SidecarBridge = (function() {

  var _ready = false;
  var _connected = false;

  // ── Latest results cache (one per capability) ──
  var _latestChord = null;          // Capability 2: neural chord detection
  var _latestQuality = null;        // Capability 1: harmonic quality feedback
  var _latestGesture = null;        // Capability 3: gesture recognition
  var _latestExpectancy = {};       // Capability 4: per-voice melodic expectancy
  var _latestSpectral = null;       // Raw spectral analysis (vDSP, no ML)

  // ── Timestamps for staleness detection ──
  var _timestamps = {
    chord: 0, quality: 0, gesture: 0, spectral: 0
  };

  // Staleness threshold — results older than this are considered stale (ms)
  var STALE_MS = 500;

  // ── Initialize listener ──
  function _init() {
    if (typeof window === 'undefined' || !window.gen3 || !window.gen3.on) {
      return; // Not in Electron — silent skip
    }

    window.gen3.on('sidecar:result', function(data) {
      if (!data || !data.type) return;

      _connected = true;
      var now = Date.now();

      switch (data.type) {
        case 'chord':
          _latestChord = data;
          _timestamps.chord = now;
          break;

        case 'harmonic_quality':
          _latestQuality = data;
          _timestamps.quality = now;
          break;

        case 'gesture':
          _latestGesture = data;
          _timestamps.gesture = now;
          break;

        case 'expectancy':
          if (data.voice) {
            _latestExpectancy[data.voice] = data;
          }
          break;

        case 'spectral':
          _latestSpectral = data;
          _timestamps.spectral = now;
          break;

        case 'ready':
          _ready = true;
          console.log('[SidecarBridge] Sidecar ready — neural engine active');
          break;

        case 'echo':
          // Test echo response from dummy server
          console.log('[SidecarBridge] Echo received:', data);
          break;
      }

      // Publish to EventBus for decoupled consumption
      if (typeof EventBus !== 'undefined') {
        EventBus.emit('sidecar:' + data.type, data);
      }
    });

    // Check sidecar status on init
    if (window.gen3.sidecar && window.gen3.sidecar.isReady) {
      window.gen3.sidecar.isReady().then(function(ready) {
        _ready = ready;
        if (ready) {
          console.log('[SidecarBridge] Sidecar connected on init');
        }
      });
    }
  }

  // ── Auto-initialize ──
  _init();

  // ── Public API ──

  return {

    // Status
    isReady: function() { return _ready && _connected; },
    isConnected: function() { return _connected; },

    // Capability 1: Harmonic quality feedback (spectral roughness, masking)
    getHarmonicQuality: function() {
      if (!_latestQuality) return null;
      if (Date.now() - _timestamps.quality > STALE_MS) return null;
      return _latestQuality;
    },

    // Capability 2: Neural chord detection
    getChord: function() {
      if (!_latestChord) return null;
      if (Date.now() - _timestamps.chord > STALE_MS) return null;
      return _latestChord;
    },

    // Capability 3: Gesture recognition
    getGesture: function() {
      if (!_latestGesture) return null;
      if (Date.now() - _timestamps.gesture > STALE_MS) return null;
      return _latestGesture;
    },

    // Capability 4: Deep melodic expectancy (per-voice)
    getExpectancy: function(voice) {
      return _latestExpectancy[voice] || null;
    },

    // Raw spectral analysis (vDSP, no ML)
    getSpectral: function() {
      if (!_latestSpectral) return null;
      if (Date.now() - _timestamps.spectral > STALE_MS) return null;
      return _latestSpectral;
    },

    // Send a message to the sidecar (for streaming audio/MIDI data)
    send: function(msg) {
      if (typeof window !== 'undefined' && window.gen3 && window.gen3.sidecar) {
        return window.gen3.sidecar.send(msg);
      }
      return false;
    },

    // Diagnostics
    getDiagnostics: function() {
      return {
        ready: _ready,
        connected: _connected,
        latestChord: _latestChord,
        latestQuality: _latestQuality,
        latestGesture: _latestGesture,
        expectancyVoices: Object.keys(_latestExpectancy),
        timestamps: Object.assign({}, _timestamps)
      };
    },

    // Reset (for session restart)
    reset: function() {
      _latestChord = null;
      _latestQuality = null;
      _latestGesture = null;
      _latestExpectancy = {};
      _latestSpectral = null;
      _timestamps = { chord: 0, quality: 0, gesture: 0, spectral: 0 };
    }
  };

})();

'use strict';
// ═══ DRUM PATTERNS — Data-Driven Beat Vocabulary ═══
//
// Expandable pattern library for PercussionAssistant.
// Each pattern defines per-hit position, velocity, and micro-timing offset.
//
// Pattern format:
//   { name, density, feel, hits: { kick: [{pos,vel,offset}], snare: [...], hat: [...] } }
//
//   pos:    bar-phase position 0-1 (0.0=beat1, 0.25=beat2, 0.5=beat3, 0.75=beat4)
//   vel:    relative velocity 0-1
//   offset: micro-timing displacement in ms (-15 to +15). Negative=ahead, positive=behind.
//   prob:   hit probability 0-1 (default 1.0). Structural hits=1.0, ornamental=lower.
//           Modulated at runtime by internal energy curve + phrase position.
//   ghost:  true if ghost note (very quiet, ornamental)
//
// Density levels: 'sparse', 'basic', 'driving', 'fill'
// Feel types: 'straight', 'shuffle', 'swing', 'motorik', 'halftime', 'breakbeat'
//
// Drum names must match SoundEngine.playDrum() voices:
//   kick, snare, hat, tom_low, tom_mid, tom_high, clap, rimshot, cowbell
//
// Depends on: nothing (pure data module)
// Load order: before percussion-assistant.js

var DrumPatterns = (function() {

  // ═══════════════════════════════════════
  // PATTERN LIBRARY
  // ═══════════════════════════════════════

  var LIBRARY = [

    // ── SPARSE patterns ──

    { name: 'sparse_straight', density: 'sparse', feel: 'straight', genre: 'electronic',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}],
        snare: [{pos:0.5, vel:0.85, offset:0, prob:0.95}],
        hat:   [{pos:0.0, vel:0.55, offset:0, prob:0.9}, {pos:0.25, vel:0.38, offset:-2, prob:0.7},
                {pos:0.5, vel:0.50, offset:0, prob:0.9}, {pos:0.75, vel:0.35, offset:2, prob:0.6}]
      }
    },

    { name: 'sparse_shuffle', density: 'sparse', feel: 'shuffle', genre: 'blues',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}],
        snare: [{pos:0.5, vel:0.85, offset:0, prob:0.95}],
        hat:   [{pos:0.0, vel:0.55, offset:0, prob:0.9}, {pos:0.25, vel:0.35, offset:10, prob:0.6},
                {pos:0.5, vel:0.50, offset:0, prob:0.9}, {pos:0.75, vel:0.35, offset:10, prob:0.6}]
      }
    },

    { name: 'sparse_swing', density: 'sparse', feel: 'swing', genre: 'jazz',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}],
        snare: [{pos:0.5, vel:0.8, offset:0, prob:0.95}],
        hat:   [{pos:0.0, vel:0.55, offset:0, prob:0.9}, {pos:0.167, vel:0.25, offset:0, ghost:true, prob:0.4},
                {pos:0.25, vel:0.38, offset:12, prob:0.7}, {pos:0.5, vel:0.50, offset:0, prob:0.9},
                {pos:0.667, vel:0.25, offset:0, ghost:true, prob:0.4}, {pos:0.75, vel:0.38, offset:12, prob:0.7}]
      }
    },

    { name: 'sparse_ballad', density: 'sparse', feel: 'straight', genre: 'melodic',
      hits: {
        kick:  [{pos:0.0, vel:0.7, offset:0, prob:1.0}],
        snare: [{pos:0.5, vel:0.45, offset:0, prob:0.85}],
        hat:   [{pos:0.0, vel:0.35, offset:0, prob:0.9}, {pos:0.5, vel:0.30, offset:0, prob:0.7}]
      }
    },

    { name: 'sparse_jazz_ride', density: 'sparse', feel: 'swing', genre: 'jazz',
      hits: {
        kick:  [{pos:0.0, vel:0.5, offset:0, ghost:true, prob:0.5}],
        snare: [],
        hat:   [{pos:0.0, vel:0.55, offset:0, prob:0.9}, {pos:0.167, vel:0.30, offset:5, ghost:true, prob:0.4},
                {pos:0.5, vel:0.50, offset:0, prob:0.9}, {pos:0.667, vel:0.30, offset:5, ghost:true, prob:0.4}]
      }
    },

    { name: 'sparse_brushes', density: 'sparse', feel: 'swing', genre: 'melodic',
      hits: {
        kick:  [{pos:0.0, vel:0.45, offset:0, ghost:true, prob:0.5}, {pos:0.5, vel:0.35, offset:0, ghost:true, prob:0.4}],
        snare: [{pos:0.25, vel:0.35, offset:8, prob:0.8}, {pos:0.75, vel:0.30, offset:8, prob:0.7}],
        hat:   [{pos:0.0, vel:0.40, offset:0, prob:0.9}, {pos:0.25, vel:0.25, offset:10, ghost:true, prob:0.4},
                {pos:0.5, vel:0.38, offset:0, prob:0.9}, {pos:0.75, vel:0.25, offset:10, ghost:true, prob:0.4}]
      }
    },

    // Sparse with rimshot — minimal latin feel
    { name: 'sparse_rimshot', density: 'sparse', feel: 'straight', genre: 'melodic',
      hits: {
        kick:    [{pos:0.0, vel:0.75, offset:0, prob:1.0}],
        rimshot: [{pos:0.25, vel:0.6, offset:0, prob:0.85}, {pos:0.75, vel:0.55, offset:0, prob:0.7}],
        hat:     [{pos:0.0, vel:0.4, offset:0, prob:0.9}, {pos:0.5, vel:0.35, offset:0, prob:0.8}]
      }
    },

    // ── BASIC patterns ──

    { name: 'basic_straight', density: 'basic', feel: 'straight', genre: 'electronic',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.5, vel:0.9, offset:0, prob:0.85}],
        snare: [{pos:0.25, vel:0.85, offset:0, prob:0.95}, {pos:0.75, vel:0.85, offset:0, prob:0.95}],
        hat:   [{pos:0.0, vel:0.5, offset:0, prob:0.9}, {pos:0.125, vel:0.35, offset:0, prob:0.6},
                {pos:0.25, vel:0.45, offset:0, prob:0.9}, {pos:0.375, vel:0.35, offset:0, prob:0.6},
                {pos:0.5, vel:0.5, offset:0, prob:0.9}, {pos:0.625, vel:0.35, offset:0, prob:0.6},
                {pos:0.75, vel:0.45, offset:0, prob:0.9}, {pos:0.875, vel:0.35, offset:0, prob:0.6}]
      }
    },

    { name: 'basic_ballad', density: 'basic', feel: 'straight', genre: 'melodic',
      hits: {
        kick:  [{pos:0.0, vel:0.75, offset:0, prob:1.0}, {pos:0.5, vel:0.6, offset:0, prob:0.75}],
        snare: [{pos:0.25, vel:0.5, offset:0, prob:0.9}, {pos:0.75, vel:0.45, offset:0, prob:0.85}],
        hat:   [{pos:0.0, vel:0.4, offset:0, prob:0.9}, {pos:0.25, vel:0.30, offset:0, prob:0.65},
                {pos:0.5, vel:0.38, offset:0, prob:0.85}, {pos:0.75, vel:0.30, offset:0, prob:0.6}]
      }
    },

    { name: 'basic_jazz_ride', density: 'basic', feel: 'swing', genre: 'jazz',
      hits: {
        kick:  [{pos:0.0, vel:0.5, offset:0, ghost:true, prob:0.5}, {pos:0.25, vel:0.35, offset:0, ghost:true, prob:0.3},
                {pos:0.5, vel:0.45, offset:0, ghost:true, prob:0.45}, {pos:0.75, vel:0.35, offset:0, ghost:true, prob:0.3}],
        snare: [{pos:0.25, vel:0.55, offset:5, prob:0.85}, {pos:0.625, vel:0.25, offset:0, ghost:true, prob:0.35},
                {pos:0.75, vel:0.50, offset:5, prob:0.8}],
        hat:   [{pos:0.0, vel:0.55, offset:0, prob:0.95}, {pos:0.167, vel:0.30, offset:5, ghost:true, prob:0.4},
                {pos:0.25, vel:0.40, offset:12, prob:0.8}, {pos:0.417, vel:0.25, offset:5, ghost:true, prob:0.35},
                {pos:0.5, vel:0.50, offset:0, prob:0.95}, {pos:0.667, vel:0.30, offset:5, ghost:true, prob:0.4},
                {pos:0.75, vel:0.40, offset:12, prob:0.8}, {pos:0.917, vel:0.25, offset:5, ghost:true, prob:0.35}]
      }
    },

    { name: 'basic_blues_shuffle', density: 'basic', feel: 'shuffle', genre: 'blues',
      hits: {
        kick:  [{pos:0.0, vel:0.85, offset:0, prob:1.0}, {pos:0.5, vel:0.7, offset:0, prob:0.8}],
        snare: [{pos:0.25, vel:0.7, offset:0, prob:0.95}, {pos:0.375, vel:0.25, offset:8, ghost:true, prob:0.4},
                {pos:0.75, vel:0.65, offset:0, prob:0.95}, {pos:0.875, vel:0.25, offset:8, ghost:true, prob:0.4}],
        hat:   [{pos:0.0, vel:0.5, offset:0, prob:0.9}, {pos:0.167, vel:0.30, offset:10, ghost:true, prob:0.4},
                {pos:0.25, vel:0.40, offset:8, prob:0.8}, {pos:0.417, vel:0.25, offset:10, ghost:true, prob:0.35},
                {pos:0.5, vel:0.48, offset:0, prob:0.9}, {pos:0.667, vel:0.30, offset:10, ghost:true, prob:0.4},
                {pos:0.75, vel:0.40, offset:8, prob:0.8}, {pos:0.917, vel:0.25, offset:10, ghost:true, prob:0.35}]
      }
    },

    { name: 'basic_soft_rock', density: 'basic', feel: 'straight', genre: 'melodic',
      hits: {
        kick:  [{pos:0.0, vel:0.8, offset:0, prob:1.0}, {pos:0.5, vel:0.65, offset:0, prob:0.8}],
        snare: [{pos:0.25, vel:0.6, offset:0, prob:0.95}, {pos:0.75, vel:0.55, offset:0, prob:0.9}],
        hat:   [{pos:0.0, vel:0.4, offset:0, prob:0.9}, {pos:0.125, vel:0.25, offset:0, prob:0.55},
                {pos:0.25, vel:0.35, offset:0, prob:0.85}, {pos:0.375, vel:0.25, offset:0, prob:0.5},
                {pos:0.5, vel:0.4, offset:0, prob:0.9}, {pos:0.625, vel:0.25, offset:0, prob:0.55},
                {pos:0.75, vel:0.35, offset:0, prob:0.85}, {pos:0.875, vel:0.25, offset:0, prob:0.5}]
      }
    },

    { name: 'basic_motorik', density: 'basic', feel: 'motorik', genre: 'electronic',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.25, vel:0.95, offset:0, prob:1.0},
                {pos:0.5, vel:1.0, offset:0, prob:1.0}, {pos:0.75, vel:0.95, offset:0, prob:1.0}],
        snare: [{pos:0.25, vel:0.7, offset:0, prob:1.0}, {pos:0.75, vel:0.7, offset:0, prob:1.0}],
        hat:   [{pos:0.0, vel:0.5, offset:0, prob:1.0}, {pos:0.125, vel:0.35, offset:0, prob:1.0},
                {pos:0.25, vel:0.45, offset:0, prob:1.0}, {pos:0.375, vel:0.35, offset:0, prob:1.0},
                {pos:0.5, vel:0.5, offset:0, prob:1.0}, {pos:0.625, vel:0.35, offset:0, prob:1.0},
                {pos:0.75, vel:0.45, offset:0, prob:1.0}, {pos:0.875, vel:0.35, offset:0, prob:1.0}]
      }
    },

    { name: 'basic_shuffle', density: 'basic', feel: 'shuffle', genre: 'blues',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.5, vel:0.9, offset:0, prob:0.85}],
        snare: [{pos:0.25, vel:0.85, offset:0, prob:0.95}, {pos:0.75, vel:0.85, offset:0, prob:0.95}],
        hat:   [{pos:0.0, vel:0.55, offset:0, prob:0.9}, {pos:0.125, vel:0.28, offset:10, ghost:true, prob:0.4},
                {pos:0.25, vel:0.40, offset:8, prob:0.8}, {pos:0.375, vel:0.28, offset:10, ghost:true, prob:0.4},
                {pos:0.5, vel:0.50, offset:0, prob:0.9}, {pos:0.625, vel:0.28, offset:10, ghost:true, prob:0.4},
                {pos:0.75, vel:0.40, offset:8, prob:0.8}, {pos:0.875, vel:0.28, offset:10, ghost:true, prob:0.4}]
      }
    },

    { name: 'basic_half_time', density: 'basic', feel: 'halftime', genre: 'melodic',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}],
        snare: [{pos:0.5, vel:0.9, offset:0, prob:0.95}],
        hat:   [{pos:0.0, vel:0.5, offset:0, prob:0.9}, {pos:0.125, vel:0.35, offset:0, prob:0.55},
                {pos:0.25, vel:0.45, offset:0, prob:0.85}, {pos:0.375, vel:0.35, offset:0, prob:0.55},
                {pos:0.5, vel:0.5, offset:0, prob:0.9}, {pos:0.625, vel:0.35, offset:0, prob:0.55},
                {pos:0.75, vel:0.45, offset:0, prob:0.85}, {pos:0.875, vel:0.35, offset:0, prob:0.55}]
      }
    },

    { name: 'basic_swing', density: 'basic', feel: 'swing', genre: 'jazz',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.5, vel:0.85, offset:0, prob:0.8}],
        snare: [{pos:0.25, vel:0.8, offset:0, prob:0.95}, {pos:0.75, vel:0.8, offset:0, prob:0.9}],
        hat:   [{pos:0.0, vel:0.55, offset:0, prob:0.95}, {pos:0.167, vel:0.22, offset:0, ghost:true, prob:0.4},
                {pos:0.25, vel:0.38, offset:12, prob:0.8}, {pos:0.417, vel:0.22, offset:0, ghost:true, prob:0.35},
                {pos:0.5, vel:0.50, offset:0, prob:0.95}, {pos:0.667, vel:0.22, offset:0, ghost:true, prob:0.4},
                {pos:0.75, vel:0.38, offset:12, prob:0.8}, {pos:0.917, vel:0.22, offset:0, ghost:true, prob:0.35}]
      }
    },

    // ── BASIC — new extended patterns ──

    // Shuffle with clap on backbeat instead of snare
    { name: 'basic_shuffle_clap', density: 'basic', feel: 'shuffle', genre: 'electronic',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.5, vel:0.9, offset:0, prob:0.85}],
        clap:  [{pos:0.25, vel:0.8, offset:0, prob:0.95}, {pos:0.75, vel:0.8, offset:0, prob:0.95}],
        hat:   [{pos:0.0, vel:0.55, offset:0, prob:0.9}, {pos:0.125, vel:0.28, offset:10, ghost:true, prob:0.4},
                {pos:0.25, vel:0.40, offset:8, prob:0.8}, {pos:0.375, vel:0.28, offset:10, ghost:true, prob:0.4},
                {pos:0.5, vel:0.50, offset:0, prob:0.9}, {pos:0.625, vel:0.28, offset:10, ghost:true, prob:0.4},
                {pos:0.75, vel:0.40, offset:8, prob:0.8}, {pos:0.875, vel:0.28, offset:10, ghost:true, prob:0.4}]
      }
    },

    // Halftime with cowbell — dub/reggae influence
    { name: 'basic_halftime_cowbell', density: 'basic', feel: 'halftime', genre: 'electronic',
      hits: {
        kick:    [{pos:0.0, vel:1.0, offset:0, prob:1.0}],
        snare:   [{pos:0.5, vel:0.85, offset:0, prob:0.95}],
        cowbell: [{pos:0.0, vel:0.4, offset:0, prob:0.7}, {pos:0.25, vel:0.5, offset:0, prob:0.85},
                  {pos:0.5, vel:0.4, offset:0, prob:0.7}, {pos:0.75, vel:0.5, offset:0, prob:0.85}],
        hat:     [{pos:0.0, vel:0.4, offset:0, prob:0.9}, {pos:0.25, vel:0.35, offset:0, prob:0.8},
                  {pos:0.5, vel:0.4, offset:0, prob:0.9}, {pos:0.75, vel:0.35, offset:0, prob:0.8}]
      }
    },

    // Breakbeat — syncopated kick, open hat on offbeats
    { name: 'basic_breakbeat', density: 'basic', feel: 'breakbeat', genre: 'electronic',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.375, vel:0.8, offset:0, prob:0.85},
                {pos:0.625, vel:0.75, offset:0, prob:0.7}],
        snare: [{pos:0.25, vel:0.85, offset:0, prob:0.95}, {pos:0.75, vel:0.85, offset:0, prob:0.95}],
        hat:   [{pos:0.0, vel:0.5, offset:0, prob:0.9}, {pos:0.125, vel:0.45, offset:0, prob:0.85},
                {pos:0.25, vel:0.4, offset:0, prob:0.8}, {pos:0.375, vel:0.5, offset:0, prob:0.9},
                {pos:0.5, vel:0.45, offset:0, prob:0.85}, {pos:0.625, vel:0.5, offset:0, prob:0.9},
                {pos:0.75, vel:0.4, offset:0, prob:0.8}, {pos:0.875, vel:0.45, offset:0, prob:0.85}]
      }
    },

    // Motorik with cowbell — classic Kraftwerk
    { name: 'basic_motorik_cowbell', density: 'basic', feel: 'motorik', genre: 'electronic',
      hits: {
        kick:    [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.25, vel:0.95, offset:0, prob:1.0},
                  {pos:0.5, vel:1.0, offset:0, prob:1.0}, {pos:0.75, vel:0.95, offset:0, prob:1.0}],
        snare:   [{pos:0.25, vel:0.7, offset:0, prob:1.0}, {pos:0.75, vel:0.7, offset:0, prob:1.0}],
        cowbell: [{pos:0.0, vel:0.45, offset:0, prob:0.8}, {pos:0.125, vel:0.3, offset:0, prob:0.5},
                  {pos:0.25, vel:0.4, offset:0, prob:0.75}, {pos:0.375, vel:0.3, offset:0, prob:0.5},
                  {pos:0.5, vel:0.45, offset:0, prob:0.8}, {pos:0.625, vel:0.3, offset:0, prob:0.5},
                  {pos:0.75, vel:0.4, offset:0, prob:0.75}, {pos:0.875, vel:0.3, offset:0, prob:0.5}],
        hat:     [{pos:0.0, vel:0.5, offset:0, prob:1.0}, {pos:0.125, vel:0.35, offset:0, prob:1.0},
                  {pos:0.25, vel:0.45, offset:0, prob:1.0}, {pos:0.375, vel:0.35, offset:0, prob:1.0},
                  {pos:0.5, vel:0.5, offset:0, prob:1.0}, {pos:0.625, vel:0.35, offset:0, prob:1.0},
                  {pos:0.75, vel:0.45, offset:0, prob:1.0}, {pos:0.875, vel:0.35, offset:0, prob:1.0}]
      }
    },

    // Rimshot-driven pattern — latin/bossa influence
    { name: 'basic_rimshot_bossa', density: 'basic', feel: 'straight', genre: 'melodic',
      hits: {
        kick:    [{pos:0.0, vel:0.7, offset:0, prob:1.0}, {pos:0.375, vel:0.55, offset:0, prob:0.7},
                  {pos:0.5, vel:0.65, offset:0, prob:0.85}],
        rimshot: [{pos:0.25, vel:0.6, offset:0, prob:0.9}, {pos:0.5, vel:0.5, offset:0, prob:0.7},
                  {pos:0.75, vel:0.6, offset:0, prob:0.9}],
        hat:     [{pos:0.0, vel:0.4, offset:0, prob:0.9}, {pos:0.125, vel:0.3, offset:0, prob:0.6},
                  {pos:0.25, vel:0.35, offset:0, prob:0.85}, {pos:0.375, vel:0.3, offset:0, prob:0.6},
                  {pos:0.5, vel:0.4, offset:0, prob:0.9}, {pos:0.625, vel:0.3, offset:0, prob:0.6},
                  {pos:0.75, vel:0.35, offset:0, prob:0.85}, {pos:0.875, vel:0.3, offset:0, prob:0.6}]
      }
    },

    // ── DRIVING patterns ──

    { name: 'driving_straight', density: 'driving', feel: 'straight', genre: 'electronic',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.25, vel:0.9, offset:0, prob:0.8},
                {pos:0.5, vel:1.0, offset:0, prob:1.0}, {pos:0.75, vel:0.9, offset:0, prob:0.8}],
        snare: [{pos:0.25, vel:0.85, offset:0, prob:0.95}, {pos:0.75, vel:0.85, offset:0, prob:0.95}],
        hat:   [{pos:0.0, vel:0.5, offset:0, prob:0.95}, {pos:0.0625, vel:0.25, offset:0, ghost:true, prob:0.45},
                {pos:0.125, vel:0.4, offset:0, prob:0.8}, {pos:0.1875, vel:0.25, offset:0, ghost:true, prob:0.45},
                {pos:0.25, vel:0.45, offset:0, prob:0.9}, {pos:0.3125, vel:0.25, offset:0, ghost:true, prob:0.45},
                {pos:0.375, vel:0.4, offset:0, prob:0.8}, {pos:0.4375, vel:0.25, offset:0, ghost:true, prob:0.45},
                {pos:0.5, vel:0.5, offset:0, prob:0.95}, {pos:0.5625, vel:0.25, offset:0, ghost:true, prob:0.45},
                {pos:0.625, vel:0.4, offset:0, prob:0.8}, {pos:0.6875, vel:0.25, offset:0, ghost:true, prob:0.45},
                {pos:0.75, vel:0.45, offset:0, prob:0.9}, {pos:0.8125, vel:0.25, offset:0, ghost:true, prob:0.45},
                {pos:0.875, vel:0.4, offset:0, prob:0.8}, {pos:0.9375, vel:0.25, offset:0, ghost:true, prob:0.45}]
      }
    },

    { name: 'driving_motorik', density: 'driving', feel: 'motorik', genre: 'electronic',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.25, vel:0.95, offset:0, prob:1.0},
                {pos:0.5, vel:1.0, offset:0, prob:1.0}, {pos:0.75, vel:0.95, offset:0, prob:1.0}],
        snare: [{pos:0.25, vel:0.75, offset:0, prob:1.0}, {pos:0.75, vel:0.75, offset:0, prob:1.0}],
        hat:   [{pos:0.0, vel:0.5, offset:0, prob:1.0}, {pos:0.0625, vel:0.3, offset:0, prob:1.0},
                {pos:0.125, vel:0.4, offset:0, prob:1.0}, {pos:0.1875, vel:0.3, offset:0, prob:1.0},
                {pos:0.25, vel:0.45, offset:0, prob:1.0}, {pos:0.3125, vel:0.3, offset:0, prob:1.0},
                {pos:0.375, vel:0.4, offset:0, prob:1.0}, {pos:0.4375, vel:0.3, offset:0, prob:1.0},
                {pos:0.5, vel:0.5, offset:0, prob:1.0}, {pos:0.5625, vel:0.3, offset:0, prob:1.0},
                {pos:0.625, vel:0.4, offset:0, prob:1.0}, {pos:0.6875, vel:0.3, offset:0, prob:1.0},
                {pos:0.75, vel:0.45, offset:0, prob:1.0}, {pos:0.8125, vel:0.3, offset:0, prob:1.0},
                {pos:0.875, vel:0.4, offset:0, prob:1.0}, {pos:0.9375, vel:0.3, offset:0, prob:1.0}]
      }
    },

    { name: 'driving_broken', density: 'driving', feel: 'straight', genre: 'electronic',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.1875, vel:0.7, offset:0, prob:0.7},
                {pos:0.5, vel:0.95, offset:0, prob:0.95}, {pos:0.75, vel:0.8, offset:0, prob:0.75}],
        snare: [{pos:0.25, vel:0.85, offset:0, prob:0.95}, {pos:0.625, vel:0.3, offset:0, ghost:true, prob:0.4},
                {pos:0.75, vel:0.85, offset:0, prob:0.95}],
        hat:   [{pos:0.0, vel:0.5, offset:0, prob:0.9}, {pos:0.125, vel:0.4, offset:0, prob:0.7},
                {pos:0.25, vel:0.45, offset:0, prob:0.9}, {pos:0.375, vel:0.35, offset:0, prob:0.6},
                {pos:0.5, vel:0.5, offset:0, prob:0.9}, {pos:0.625, vel:0.4, offset:0, prob:0.7},
                {pos:0.75, vel:0.45, offset:0, prob:0.9}, {pos:0.875, vel:0.35, offset:0, prob:0.6}]
      }
    },

    { name: 'driving_melodic', density: 'driving', feel: 'straight', genre: 'melodic',
      hits: {
        kick:  [{pos:0.0, vel:0.85, offset:0, prob:1.0}, {pos:0.375, vel:0.5, offset:0, ghost:true, prob:0.4},
                {pos:0.5, vel:0.75, offset:0, prob:0.85}],
        snare: [{pos:0.25, vel:0.7, offset:0, prob:0.95}, {pos:0.75, vel:0.65, offset:0, prob:0.9}],
        hat:   [{pos:0.0, vel:0.45, offset:0, prob:0.9}, {pos:0.125, vel:0.30, offset:0, prob:0.6},
                {pos:0.25, vel:0.40, offset:0, prob:0.85}, {pos:0.375, vel:0.30, offset:0, prob:0.55},
                {pos:0.5, vel:0.45, offset:0, prob:0.9}, {pos:0.625, vel:0.30, offset:0, prob:0.6},
                {pos:0.75, vel:0.40, offset:0, prob:0.85}, {pos:0.875, vel:0.30, offset:0, prob:0.55}]
      }
    },

    { name: 'driving_jazz', density: 'driving', feel: 'swing', genre: 'jazz',
      hits: {
        kick:  [{pos:0.0, vel:0.6, offset:0, prob:0.9}, {pos:0.25, vel:0.4, offset:0, ghost:true, prob:0.4},
                {pos:0.5, vel:0.55, offset:0, prob:0.85}, {pos:0.75, vel:0.4, offset:0, ghost:true, prob:0.4}],
        snare: [{pos:0.125, vel:0.3, offset:0, ghost:true, prob:0.35}, {pos:0.25, vel:0.65, offset:5, prob:0.9},
                {pos:0.5, vel:0.3, offset:0, ghost:true, prob:0.3}, {pos:0.625, vel:0.3, offset:0, ghost:true, prob:0.35},
                {pos:0.75, vel:0.60, offset:5, prob:0.9}],
        hat:   [{pos:0.0, vel:0.55, offset:0, prob:0.95}, {pos:0.167, vel:0.35, offset:5, ghost:true, prob:0.45},
                {pos:0.25, vel:0.45, offset:12, prob:0.85}, {pos:0.417, vel:0.30, offset:5, ghost:true, prob:0.4},
                {pos:0.5, vel:0.55, offset:0, prob:0.95}, {pos:0.667, vel:0.35, offset:5, ghost:true, prob:0.45},
                {pos:0.75, vel:0.45, offset:12, prob:0.85}, {pos:0.917, vel:0.30, offset:5, ghost:true, prob:0.4}]
      }
    },

    { name: 'driving_minimal', density: 'driving', feel: 'straight', genre: 'electronic',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.25, vel:0.95, offset:0, prob:0.85},
                {pos:0.5, vel:1.0, offset:0, prob:1.0}, {pos:0.75, vel:0.95, offset:0, prob:0.85}],
        snare: [],
        hat:   [{pos:0.0, vel:0.4, offset:0, prob:0.9}, {pos:0.125, vel:0.3, offset:0, prob:0.6},
                {pos:0.25, vel:0.35, offset:0, prob:0.85}, {pos:0.375, vel:0.3, offset:0, prob:0.55},
                {pos:0.5, vel:0.4, offset:0, prob:0.9}, {pos:0.625, vel:0.3, offset:0, prob:0.6},
                {pos:0.75, vel:0.35, offset:0, prob:0.85}, {pos:0.875, vel:0.3, offset:0, prob:0.55}]
      }
    },

    // ── DRIVING — new extended patterns ──

    // Breakbeat driving — heavy syncopation, clap accents
    { name: 'driving_breakbeat', density: 'driving', feel: 'breakbeat', genre: 'electronic',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.1875, vel:0.75, offset:0, prob:0.75},
                {pos:0.375, vel:0.85, offset:0, prob:0.85}, {pos:0.5, vel:0.9, offset:0, prob:0.9},
                {pos:0.75, vel:0.8, offset:0, prob:0.7}],
        snare: [{pos:0.25, vel:0.85, offset:0, prob:0.95}, {pos:0.625, vel:0.4, offset:0, ghost:true, prob:0.45},
                {pos:0.75, vel:0.85, offset:0, prob:0.95}],
        clap:  [{pos:0.25, vel:0.6, offset:5, prob:0.7}, {pos:0.75, vel:0.6, offset:5, prob:0.7}],
        hat:   [{pos:0.0, vel:0.5, offset:0, prob:0.9}, {pos:0.0625, vel:0.3, offset:0, ghost:true, prob:0.5},
                {pos:0.125, vel:0.45, offset:0, prob:0.85}, {pos:0.1875, vel:0.3, offset:0, ghost:true, prob:0.5},
                {pos:0.25, vel:0.5, offset:0, prob:0.9}, {pos:0.3125, vel:0.3, offset:0, ghost:true, prob:0.5},
                {pos:0.375, vel:0.45, offset:0, prob:0.85}, {pos:0.4375, vel:0.3, offset:0, ghost:true, prob:0.5},
                {pos:0.5, vel:0.5, offset:0, prob:0.9}, {pos:0.5625, vel:0.3, offset:0, ghost:true, prob:0.5},
                {pos:0.625, vel:0.45, offset:0, prob:0.85}, {pos:0.6875, vel:0.3, offset:0, ghost:true, prob:0.5},
                {pos:0.75, vel:0.5, offset:0, prob:0.9}, {pos:0.8125, vel:0.3, offset:0, ghost:true, prob:0.5},
                {pos:0.875, vel:0.45, offset:0, prob:0.85}, {pos:0.9375, vel:0.3, offset:0, ghost:true, prob:0.5}]
      }
    },

    // Driving shuffle — high-energy swung feel with claps
    { name: 'driving_shuffle', density: 'driving', feel: 'shuffle', genre: 'electronic',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.375, vel:0.7, offset:8, prob:0.65},
                {pos:0.5, vel:0.95, offset:0, prob:0.95}, {pos:0.875, vel:0.7, offset:8, prob:0.65}],
        clap:  [{pos:0.25, vel:0.85, offset:0, prob:0.95}, {pos:0.75, vel:0.85, offset:0, prob:0.95}],
        hat:   [{pos:0.0, vel:0.55, offset:0, prob:0.95}, {pos:0.125, vel:0.3, offset:10, ghost:true, prob:0.5},
                {pos:0.25, vel:0.45, offset:8, prob:0.85}, {pos:0.375, vel:0.3, offset:10, ghost:true, prob:0.5},
                {pos:0.5, vel:0.55, offset:0, prob:0.95}, {pos:0.625, vel:0.3, offset:10, ghost:true, prob:0.5},
                {pos:0.75, vel:0.45, offset:8, prob:0.85}, {pos:0.875, vel:0.3, offset:10, ghost:true, prob:0.5}]
      }
    },

    // Driving motorik with cowbell — Trans-Europe Express
    { name: 'driving_motorik_cowbell', density: 'driving', feel: 'motorik', genre: 'electronic',
      hits: {
        kick:    [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.25, vel:0.95, offset:0, prob:1.0},
                  {pos:0.5, vel:1.0, offset:0, prob:1.0}, {pos:0.75, vel:0.95, offset:0, prob:1.0}],
        snare:   [{pos:0.25, vel:0.75, offset:0, prob:1.0}, {pos:0.75, vel:0.75, offset:0, prob:1.0}],
        cowbell: [{pos:0.0, vel:0.5, offset:0, prob:0.9}, {pos:0.0625, vel:0.3, offset:0, prob:0.7},
                  {pos:0.125, vel:0.4, offset:0, prob:0.85}, {pos:0.1875, vel:0.3, offset:0, prob:0.7},
                  {pos:0.25, vel:0.45, offset:0, prob:0.9}, {pos:0.3125, vel:0.3, offset:0, prob:0.7},
                  {pos:0.375, vel:0.4, offset:0, prob:0.85}, {pos:0.4375, vel:0.3, offset:0, prob:0.7},
                  {pos:0.5, vel:0.5, offset:0, prob:0.9}, {pos:0.5625, vel:0.3, offset:0, prob:0.7},
                  {pos:0.625, vel:0.4, offset:0, prob:0.85}, {pos:0.6875, vel:0.3, offset:0, prob:0.7},
                  {pos:0.75, vel:0.45, offset:0, prob:0.9}, {pos:0.8125, vel:0.3, offset:0, prob:0.7},
                  {pos:0.875, vel:0.4, offset:0, prob:0.85}, {pos:0.9375, vel:0.3, offset:0, prob:0.7}],
        hat:     [{pos:0.0, vel:0.5, offset:0, prob:1.0}, {pos:0.0625, vel:0.3, offset:0, prob:1.0},
                  {pos:0.125, vel:0.4, offset:0, prob:1.0}, {pos:0.1875, vel:0.3, offset:0, prob:1.0},
                  {pos:0.25, vel:0.45, offset:0, prob:1.0}, {pos:0.3125, vel:0.3, offset:0, prob:1.0},
                  {pos:0.375, vel:0.4, offset:0, prob:1.0}, {pos:0.4375, vel:0.3, offset:0, prob:1.0},
                  {pos:0.5, vel:0.5, offset:0, prob:1.0}, {pos:0.5625, vel:0.3, offset:0, prob:1.0},
                  {pos:0.625, vel:0.4, offset:0, prob:1.0}, {pos:0.6875, vel:0.3, offset:0, prob:1.0},
                  {pos:0.75, vel:0.45, offset:0, prob:1.0}, {pos:0.8125, vel:0.3, offset:0, prob:1.0},
                  {pos:0.875, vel:0.4, offset:0, prob:1.0}, {pos:0.9375, vel:0.3, offset:0, prob:1.0}]
      }
    },

    // ── FILL patterns (all prob:1.0 — fills are deliberate) ──

    { name: 'fill_standard', density: 'fill', feel: 'straight',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.25, vel:0.9, offset:0, prob:1.0},
                {pos:0.5, vel:0.95, offset:0, prob:1.0}, {pos:0.75, vel:0.9, offset:0, prob:1.0}],
        snare: [{pos:0.125, vel:0.7, offset:0, prob:1.0}, {pos:0.25, vel:0.8, offset:0, prob:1.0},
                {pos:0.375, vel:0.75, offset:0, prob:1.0}, {pos:0.5, vel:0.85, offset:0, prob:1.0},
                {pos:0.625, vel:0.8, offset:0, prob:1.0}, {pos:0.75, vel:0.9, offset:0, prob:1.0},
                {pos:0.875, vel:0.95, offset:0, prob:1.0}],
        hat:   [{pos:0.0, vel:0.4, offset:0, prob:1.0}, {pos:0.125, vel:0.35, offset:0, prob:1.0},
                {pos:0.25, vel:0.4, offset:0, prob:1.0}, {pos:0.375, vel:0.35, offset:0, prob:1.0},
                {pos:0.5, vel:0.4, offset:0, prob:1.0}, {pos:0.625, vel:0.35, offset:0, prob:1.0},
                {pos:0.75, vel:0.4, offset:0, prob:1.0}, {pos:0.875, vel:0.35, offset:0, prob:1.0}]
      }
    },

    { name: 'fill_snare_roll', density: 'fill', feel: 'straight',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.5, vel:0.9, offset:0, prob:1.0}],
        snare: [{pos:0.0, vel:0.5, offset:0, prob:1.0}, {pos:0.0625, vel:0.55, offset:0, prob:1.0},
                {pos:0.125, vel:0.6, offset:0, prob:1.0}, {pos:0.1875, vel:0.65, offset:0, prob:1.0},
                {pos:0.25, vel:0.7, offset:0, prob:1.0}, {pos:0.3125, vel:0.75, offset:0, prob:1.0},
                {pos:0.375, vel:0.8, offset:0, prob:1.0}, {pos:0.4375, vel:0.85, offset:0, prob:1.0},
                {pos:0.5, vel:0.9, offset:0, prob:1.0}, {pos:0.5625, vel:0.9, offset:0, prob:1.0},
                {pos:0.625, vel:0.95, offset:0, prob:1.0}, {pos:0.6875, vel:0.95, offset:0, prob:1.0},
                {pos:0.75, vel:1.0, offset:0, prob:1.0}, {pos:0.8125, vel:1.0, offset:0, prob:1.0},
                {pos:0.875, vel:1.0, offset:0, prob:1.0}, {pos:0.9375, vel:1.0, offset:0, prob:1.0}],
        hat:   []
      }
    },

    // Fill with tom cascade — descending pitch across the bar
    { name: 'fill_tom_cascade', density: 'fill', feel: 'straight',
      hits: {
        kick:     [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.75, vel:0.95, offset:0, prob:1.0}],
        snare:    [{pos:0.875, vel:1.0, offset:0, prob:1.0}],
        tom_high: [{pos:0.125, vel:0.85, offset:0, prob:1.0}, {pos:0.1875, vel:0.7, offset:0, prob:1.0}],
        tom_mid:  [{pos:0.25, vel:0.85, offset:0, prob:1.0}, {pos:0.3125, vel:0.7, offset:0, prob:1.0},
                   {pos:0.375, vel:0.85, offset:0, prob:1.0}],
        tom_low:  [{pos:0.4375, vel:0.8, offset:0, prob:1.0}, {pos:0.5, vel:0.9, offset:0, prob:1.0},
                   {pos:0.5625, vel:0.8, offset:0, prob:1.0}, {pos:0.625, vel:0.9, offset:0, prob:1.0}],
        hat:      []
      }
    },

    // Fill with clap build — layered claps accelerating toward beat 4
    { name: 'fill_clap_build', density: 'fill', feel: 'straight',
      hits: {
        kick:  [{pos:0.0, vel:1.0, offset:0, prob:1.0}],
        clap:  [{pos:0.25, vel:0.5, offset:0, prob:1.0}, {pos:0.375, vel:0.55, offset:0, prob:1.0},
                {pos:0.5, vel:0.65, offset:0, prob:1.0}, {pos:0.5625, vel:0.7, offset:0, prob:1.0},
                {pos:0.625, vel:0.75, offset:0, prob:1.0}, {pos:0.6875, vel:0.8, offset:0, prob:1.0},
                {pos:0.75, vel:0.85, offset:0, prob:1.0}, {pos:0.8125, vel:0.9, offset:0, prob:1.0},
                {pos:0.875, vel:0.95, offset:0, prob:1.0}, {pos:0.9375, vel:1.0, offset:0, prob:1.0}],
        snare: [{pos:0.75, vel:0.9, offset:0, prob:1.0}],
        hat:   []
      }
    },

    // Fill with mixed toms and rimshot — syncopated, musical
    { name: 'fill_syncopated', density: 'fill', feel: 'straight',
      hits: {
        kick:     [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.5, vel:0.9, offset:0, prob:1.0}],
        rimshot:  [{pos:0.125, vel:0.7, offset:0, prob:1.0}, {pos:0.375, vel:0.65, offset:0, prob:1.0},
                   {pos:0.625, vel:0.7, offset:0, prob:1.0}],
        tom_high: [{pos:0.25, vel:0.8, offset:0, prob:1.0}],
        tom_mid:  [{pos:0.4375, vel:0.75, offset:0, prob:1.0}],
        tom_low:  [{pos:0.75, vel:0.85, offset:0, prob:1.0}],
        snare:    [{pos:0.875, vel:1.0, offset:0, prob:1.0}],
        hat:      []
      }
    },

    // Fill — cowbell-driven (latin breakdown)
    { name: 'fill_cowbell', density: 'fill', feel: 'straight',
      hits: {
        kick:    [{pos:0.0, vel:1.0, offset:0, prob:1.0}, {pos:0.5, vel:0.9, offset:0, prob:1.0}],
        cowbell: [{pos:0.0, vel:0.6, offset:0, prob:1.0}, {pos:0.125, vel:0.5, offset:0, prob:1.0},
                  {pos:0.25, vel:0.65, offset:0, prob:1.0}, {pos:0.375, vel:0.5, offset:0, prob:1.0},
                  {pos:0.5, vel:0.6, offset:0, prob:1.0}, {pos:0.625, vel:0.55, offset:0, prob:1.0},
                  {pos:0.75, vel:0.7, offset:0, prob:1.0}, {pos:0.875, vel:0.55, offset:0, prob:1.0}],
        snare:   [{pos:0.75, vel:0.95, offset:0, prob:1.0}],
        hat:     []
      }
    }
  ];

  // ═══════════════════════════════════════
  // GENRE → FEEL MAPPING
  // ═══════════════════════════════════════

  var GENRE_FEEL = {
    motorik:  'motorik',
    standard: 'straight',
    sparse:   'straight',
    reactive: 'straight'
  };

  // Genre name → pattern genre affinity.
  // 'melodic' patterns are softer/sparser — preferred at slow tempos and non-electronic genres.
  // 'electronic' patterns are grid-locked and punchy — preferred at faster tempos and electronic genres.
  var GENRE_AFFINITY = {
    pop: 'melodic', blues: 'melodic', rock: 'melodic', jazz: 'jazz', classical: 'melodic',
    electronic_td: 'electronic', electronic_kw: 'electronic', electronic_jmj: 'electronic',
    electronic_mg: 'electronic', electronic_no: 'electronic', electronic: 'electronic',
    berlin_school: 'electronic'
  };

  // ═══════════════════════════════════════
  // ALL DRUM NAMES in the library
  // ═══════════════════════════════════════
  // Computed once: every drum name referenced by any pattern.
  // Used by vary() and toLegacy() so they handle extended drums.

  var ALL_DRUMS = (function() {
    var set = {};
    for (var i = 0; i < LIBRARY.length; i++) {
      var h = LIBRARY[i].hits;
      for (var k in h) {
        if (h.hasOwnProperty(k)) set[k] = true;
      }
    }
    var arr = [];
    for (var k in set) { if (set.hasOwnProperty(k)) arr.push(k); }
    return arr;
  })();

  // ═══════════════════════════════════════
  // SELECTION (genre + tempo aware)
  // ═══════════════════════════════════════

  function select(densityLevel, feel, genreConfig) {
    // Determine target feel from genre config if not explicit
    if (!feel && genreConfig && genreConfig.percStyle) {
      feel = GENRE_FEEL[genreConfig.percStyle] || 'straight';
    }
    if (genreConfig && genreConfig.percGrooveFeel) {
      feel = genreConfig.percGrooveFeel;
    }
    feel = feel || 'straight';

    // Determine genre affinity — what kind of patterns suit this context
    var genreName = (typeof SharedState !== 'undefined') ? SharedState.genre : '';
    var affinity = GENRE_AFFINITY[genreName] || 'melodic';

    // Tempo awareness: slow tempos (<100 BPM) prefer melodic patterns even in electronic genres
    var bpm = (typeof TempoEngine !== 'undefined') ? TempoEngine.getEffectiveBPM() : 120;
    var slowTempo = bpm < 100;
    if (slowTempo && affinity === 'electronic') affinity = 'melodic';

    // Score candidates: density match required, feel+genre preferred
    var candidates = [];
    for (var i = 0; i < LIBRARY.length; i++) {
      if (LIBRARY[i].density !== densityLevel) continue;

      var score = 0;
      // Feel match
      if (LIBRARY[i].feel === feel) score += 2;

      // Genre match: exact affinity match > no genre tag > wrong affinity
      var pGenre = LIBRARY[i].genre || 'any';
      if (pGenre === affinity) {
        score += 3;
      } else if (pGenre === 'melodic' && affinity === 'jazz') {
        score += 2;  // melodic works for jazz
      } else if (pGenre === 'melodic' && affinity === 'blues') {
        score += 2;  // melodic works for blues
      } else if (pGenre === 'any') {
        score += 1;
      } else if (pGenre === 'electronic' && affinity !== 'electronic') {
        score -= 1;  // penalize electronic patterns in melodic contexts
      }

      candidates.push({ pattern: LIBRARY[i], score: score });
    }

    if (candidates.length === 0) return LIBRARY[0];  // ultimate fallback

    // Sort by score descending
    candidates.sort(function(a, b) { return b.score - a.score; });

    // Pick from top tier (all candidates with max score)
    var topScore = candidates[0].score;
    var topCandidates = [];
    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j].score >= topScore) topCandidates.push(candidates[j]);
      else break;
    }

    return topCandidates[Math.floor(Math.random() * topCandidates.length)].pattern;
  }

  // ═══════════════════════════════════════
  // VARIATION ENGINE
  // ═══════════════════════════════════════
  // Returns a shallow-modified copy with micro-timing jitter and
  // probabilistic ghost note add/remove. amount: 0 (exact) to 1 (heavy).

  function vary(pattern, amount) {
    if (!pattern || !amount || amount <= 0) return pattern;
    amount = Math.min(amount, 1.0);

    var result = { name: pattern.name, density: pattern.density, feel: pattern.feel, hits: {} };

    for (var di = 0; di < ALL_DRUMS.length; di++) {
      var drumName = ALL_DRUMS[di];
      var srcHits = pattern.hits[drumName];
      if (!srcHits || srcHits.length === 0) {
        // Only include if source pattern had this drum
        if (pattern.hits.hasOwnProperty(drumName)) {
          result.hits[drumName] = srcHits || [];
        }
        continue;
      }

      var newHits = [];
      for (var hi = 0; hi < srcHits.length; hi++) {
        var hit = srcHits[hi];

        // Probabilistic ghost note removal (higher amount = more removals)
        if (hit.ghost && Math.random() < amount * 0.3) continue;

        // Copy hit with jittered offset
        var jitter = (Math.random() - 0.5) * 2 * amount * 8;  // +/-8ms max at amount=1
        var copy = {
          pos: hit.pos,
          vel: hit.vel,
          offset: (hit.offset || 0) + jitter,
          ghost: hit.ghost || false
        };
        if (hit.prob !== undefined) copy.prob = hit.prob;
        newHits.push(copy);
      }

      // Probabilistic ghost note addition (only for hat and cowbell)
      if ((drumName === 'hat' || drumName === 'cowbell') && Math.random() < amount * 0.2) {
        var addPos = Math.random();
        // Don't add too close to existing hits
        var tooClose = false;
        for (var ci = 0; ci < newHits.length; ci++) {
          if (Math.abs(newHits[ci].pos - addPos) < 0.05) { tooClose = true; break; }
        }
        if (!tooClose) {
          newHits.push({ pos: addPos, vel: 0.2, offset: 0, ghost: true });
          // Sort by position
          newHits.sort(function(a, b) { return a.pos - b.pos; });
        }
      }

      result.hits[drumName] = newHits;
    }

    return result;
  }

  // ═══════════════════════════════════════
  // CONVERSION — Legacy pattern format
  // ═══════════════════════════════════════
  // Converts a DrumPatterns pattern to the legacy {kick:[pos], snare:[pos], hat:[pos]}
  // format for backward compatibility.

  function toLegacy(pattern) {
    var legacy = {};
    for (var di = 0; di < ALL_DRUMS.length; di++) {
      var drumName = ALL_DRUMS[di];
      var hits = pattern.hits[drumName] || [];
      if (hits.length > 0 || drumName === 'kick' || drumName === 'snare' || drumName === 'hat') {
        legacy[drumName] = [];
        for (var hi = 0; hi < hits.length; hi++) {
          legacy[drumName].push(hits[hi].pos);
        }
      }
    }
    return legacy;
  }

  // ═══════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════

  return {
    LIBRARY:   LIBRARY,
    ALL_DRUMS: ALL_DRUMS,
    select:    select,
    vary:      vary,
    toLegacy:  toLegacy
  };

})();

console.log('%cDrumPatterns loaded (' + DrumPatterns.LIBRARY.length + ' patterns)', 'color:#fa0;font-family:monospace');

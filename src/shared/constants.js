// ═══ CONSTANTS ═══
'use strict';

var N = ["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"];

var SCALES = {
  major:[0,2,4,5,7,9,11], minor:[0,2,3,5,7,8,10], dorian:[0,2,3,5,7,9,10],
  phrygian:[0,1,3,5,7,8,10], lydian:[0,2,4,6,7,9,11],
  mixolydian:[0,2,4,5,7,9,10], locrian:[0,1,3,5,6,8,10],
  blues:[0,3,5,6,7,10], pent_minor:[0,3,5,7,10],
  pent_major:[0,2,4,7,9], harmonic_minor:[0,2,3,5,7,8,11],
  // Modal aliases
  ionian:[0,2,4,5,7,9,11], aeolian:[0,2,3,5,7,8,10]
};

// ── 7 Diatonic Modes — ordered by brightness (Lydian → Locrian) ──
// Index used by KeyBelief 84-key distribution: ki = root * 7 + modeIndex
var MODE_NAMES = ['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian'];

// Perceptual brightness valence per mode [-1, +1]
// Ranking follows circle-of-fifths position when all modes built on same root.
// Lydian (brightest, ♯4) → Locrian (darkest, ♭2♭5). Huron 2006, Temperley 2007.
var MODE_VALENCE = {
  lydian:      1.0,    // brightest — major with ♯4
  ionian:      0.67,   // standard major
  mixolydian:  0.33,   // major with ♭7 — slightly darkened
  dorian:      0.0,    // neutral — minor with ♮6 (bright minor)
  aeolian:    -0.33,   // standard minor
  phrygian:   -0.67,   // minor with ♭2 — dark
  locrian:    -1.0     // darkest — diminished ♭2♭5
};

// Legacy preset keys (electronic_td, electronic_kw, etc.) are retained for backward
// compatibility with GENRE_CONFIG behavioral parameters and lexicon fallback paths.
// These are NOT genre-specific identities — the system is psychoacoustic-universal.
// The keys map to distinct behavioral parameter profiles (PPM weights, phrase lengths,
// percussion styles, etc.) that were originally derived from artist analysis but now
// serve as reusable behavioral templates.
var GENRE_DEFAULTS = {
  pop:'major', blues:'blues', rock:'pent_minor', jazz:'dorian', classical:'major',
  electronic_td:'minor', electronic_kw:'major', electronic_jmj:'dorian',
  electronic_mg:'minor', electronic_no:'minor', electronic:'minor', radiohead:'minor',
  pinkfloyd:'minor', thecure:'minor', direstraits:'major', kingc:'minor',
  bach:'major', mozart:'major', beethoven:'minor',
  electronic_td_curated:'minor', electronic_kw_curated:'major',
  electronic_jmj_curated:'dorian', electronic_curated:'minor',
  berlin_school:'minor', debug:'minor'
};

// Behavioral preset templates — each defines PPM weights, phrase lengths, percussion
// styles, tempo coupling, and loop gaps. Keys are legacy artist-derived names retained
// for backward compatibility. The parameter VALUES are psychoacoustic-universal:
// they encode behavioral archetypes (sequencer-tight, breathing-room, motorik, etc.)
// not genre identities. See percussion-role-research.md for parameter rationale.
//
// loopGap: beats of silence before rhythm re-schedules a loopable phrase.
//   Tighter for sequencer-style (seamless loops), looser for breathing-room styles.
//
// percMuteResist: 0 (mutes freely) to 1 (never muted by breathing).
//   High = percussion as structural backbone. Low = silence as language.
//
// percStyle: pattern selection mode.
//   'motorik' — locked pattern, no fills, hypnotic repetition.
//   'standard' — section-driven: sparse→basic→driving follows SectionTracker.
//   'sparse' — minimal form-marking, only escalates at PEAK.
//   'reactive' — follows ensemble energy.
//
// percDefaultPattern: initial pattern ('basic'/'driving'/'sparse'/null=auto).
//
// ── Psychoacoustic default — genre-neutral universal fallback ──
// Every parameter traced to published research. No genre assumptions.
//
// ── Parameter sources: [E]=empirical, [D]=design choice (psychoacoustically informed) ──
//
// [E] uniR 0.12: PPM escape probability. Pearce 2005: 0.10-0.15 yields best
//     cross-entropy on tonal melodic corpora.
// [E] stepB 0.65: Stepwise motion bias. Huron 2006: ~60% of melodic intervals
//     are steps (±2 ST). Schellenberg 1997: proximity sr²=0.364 (dominant factor).
// [E] leapPen 0.4: Post-skip reversal. Von Hippel & Huron 2000: gap-fill is
//     statistical tendency. 0.4 = moderate (preserves arch contour without forcing).
// [D] antiOsc 0.5: Anti-oscillation. Informed by Schellenberg 1997 (proximity >
//     reversal) but value is a midpoint design choice, not empirically calibrated.
// [E] tempoCouplePhase 0.25: Kuramoto phase coupling. Large & Jones 1999:
//     moderate attentional entrainment strength.
// [E] tempoCouplePeriod 0.20: Period adaptation. Repp 2005: ensemble tempo
//     correction ~20% of period difference per cycle.
// [E] phraseLen 5: Notes per phrase. Temperley 2001: 4-8 note phrases typical.
//     Geometric mean √(4×8) ≈ 5.7 → 5. Berlyne 1971: moderate complexity.
// [D] replanThresh 0.5: When to abandon current phrase plan. Midpoint design
//     choice — no published research specifies this parameter.
// [E] loopGap 1.0: Beats between phrase repeats. Pressing 1999: ensemble
//     re-entry anticipation ~500-1000ms (= 1-2 beats at 120 BPM).
// [E] percMuteResist 0.5: Percussion silence resistance. London 2012: metric
//     regularity aids entrainment. 0.5 = balanced presence/breathing.
// [D] percStyle 'standard': Section-driven (tracks SectionTracker form).
// [D] percDefaultPattern null: Auto-select based on section energy.
var _PSYCHOACOUSTIC_DEFAULT = {
  uniR: 0.12, stepB: 0.65, leapPen: 0.4, antiOsc: 0.5,
  tempoCouplePhase: 0.25, tempoCouplePeriod: 0.20,
  phraseLen: 5, replanThresh: 0.5, loopGap: 1.0,
  percMuteResist: 0.5, percStyle: 'standard', percDefaultPattern: null
};

var GENRE_CONFIG = {
  _default:       _PSYCHOACOUSTIC_DEFAULT,
  pop:            {uniR:.18,stepB:.70,leapPen:.5,antiOsc:.4,tempoCouplePhase:.25,tempoCouplePeriod:.20,phraseLen:5,replanThresh:.5,loopGap:1.0,  percMuteResist:.3, percStyle:'standard',percDefaultPattern:null},
  blues:          {uniR:.20,stepB:.60,leapPen:.4,antiOsc:.5,tempoCouplePhase:.30,tempoCouplePeriod:.25,phraseLen:4,replanThresh:.4,loopGap:2.0,  percMuteResist:.4, percStyle:'reactive',percDefaultPattern:'sparse'},
  rock:           {uniR:.15,stepB:.55,leapPen:.5,antiOsc:.45,tempoCouplePhase:.25,tempoCouplePeriod:.20,phraseLen:5,replanThresh:.5,loopGap:1.0,  percMuteResist:.7, percStyle:'standard',percDefaultPattern:'basic'},
  jazz:           {uniR:.08,stepB:.50,leapPen:.3,antiOsc:.5,tempoCouplePhase:.40,tempoCouplePeriod:.35,phraseLen:4,replanThresh:.3,loopGap:2.0,  percMuteResist:.2, percStyle:'reactive',percDefaultPattern:'sparse'},
  classical:      {uniR:.10,stepB:.75,leapPen:.4,antiOsc:.4,tempoCouplePhase:.50,tempoCouplePeriod:.40,phraseLen:6,replanThresh:.4,loopGap:1.5,  percMuteResist:.1, percStyle:'sparse',  percDefaultPattern:'sparse'},
  electronic_td:  {uniR:.05,stepB:.80,leapPen:.3,antiOsc:.85,tempoCouplePhase:.15,tempoCouplePeriod:.10,phraseLen:8,replanThresh:.8,loopGap:0.75, percMuteResist:.8, percStyle:'motorik', percDefaultPattern:'basic'},
  electronic_kw:  {uniR:.20,stepB:.60,leapPen:.5,antiOsc:.90,tempoCouplePhase:.10,tempoCouplePeriod:.05,phraseLen:4,replanThresh:.95,loopGap:0.5, percMuteResist:.9, percStyle:'motorik', percDefaultPattern:'basic'},
  electronic_jmj: {uniR:.08,stepB:.50,leapPen:.2,antiOsc:.80,tempoCouplePhase:.20,tempoCouplePeriod:.15,phraseLen:7,replanThresh:.6,loopGap:0.75, percMuteResist:.5, percStyle:'sparse',  percDefaultPattern:null},
  electronic_mg:  {uniR:.03,stepB:.90,leapPen:.4,antiOsc:.90,tempoCouplePhase:.05,tempoCouplePeriod:.03,phraseLen:8,replanThresh:.9,loopGap:0.5, percMuteResist:.95,percStyle:'motorik', percDefaultPattern:'driving'},
  electronic_no:  {uniR:.12,stepB:.65,leapPen:.4,antiOsc:.70,tempoCouplePhase:.20,tempoCouplePeriod:.15,phraseLen:5,replanThresh:.6,loopGap:0.75, percMuteResist:.8, percStyle:'standard',percDefaultPattern:'basic'},
  berlin_school:  {uniR:.08,stepB:.75,leapPen:.3,antiOsc:.85,tempoCouplePhase:.15,tempoCouplePeriod:.10,phraseLen:6,replanThresh:.7,loopGap:0.75, percMuteResist:.85,percStyle:'motorik', percDefaultPattern:'basic'},
  electronic:     {uniR:.10,stepB:.70,leapPen:.35,antiOsc:.80,tempoCouplePhase:.15,tempoCouplePeriod:.10,phraseLen:6,replanThresh:.7,loopGap:0.75, percMuteResist:.7, percStyle:'standard',percDefaultPattern:null},
  radiohead:      {uniR:.12,stepB:.65,leapPen:.35,antiOsc:.60,tempoCouplePhase:.30,tempoCouplePeriod:.25,phraseLen:6,replanThresh:.5,loopGap:1.0,  percMuteResist:.5, percStyle:'reactive', percDefaultPattern:null},
  // v8.6.0: New artist presets
  pinkfloyd:      {uniR:.08,stepB:.55,leapPen:.3,antiOsc:.50,tempoCouplePhase:.35,tempoCouplePeriod:.30,phraseLen:7,replanThresh:.4,loopGap:1.5,  percMuteResist:.4, percStyle:'reactive', percDefaultPattern:null},
  thecure:        {uniR:.10,stepB:.70,leapPen:.4,antiOsc:.65,tempoCouplePhase:.25,tempoCouplePeriod:.20,phraseLen:5,replanThresh:.5,loopGap:1.0,  percMuteResist:.6, percStyle:'standard', percDefaultPattern:'basic'},
  direstraits:    {uniR:.15,stepB:.60,leapPen:.35,antiOsc:.45,tempoCouplePhase:.30,tempoCouplePeriod:.25,phraseLen:6,replanThresh:.4,loopGap:1.5,  percMuteResist:.5, percStyle:'reactive', percDefaultPattern:null},
  kingc:          {uniR:.12,stepB:.50,leapPen:.25,antiOsc:.35,tempoCouplePhase:.30,tempoCouplePeriod:.25,phraseLen:8,replanThresh:.3,loopGap:2.0,  percMuteResist:.4, percStyle:'reactive', percDefaultPattern:null},
  // v8.9.0: Classical composers
  bach:           {uniR:.08,stepB:.70,leapPen:.40,antiOsc:.55,tempoCouplePhase:.35,tempoCouplePeriod:.30,phraseLen:10,replanThresh:.25,loopGap:2.5, percMuteResist:.6, percStyle:'sparse',   percDefaultPattern:'sparse'},
  mozart:         {uniR:.10,stepB:.60,leapPen:.35,antiOsc:.45,tempoCouplePhase:.30,tempoCouplePeriod:.25,phraseLen:8, replanThresh:.30,loopGap:2.0, percMuteResist:.5, percStyle:'sparse',   percDefaultPattern:'sparse'},
  beethoven:      {uniR:.12,stepB:.50,leapPen:.25,antiOsc:.35,tempoCouplePhase:.35,tempoCouplePeriod:.30,phraseLen:12,replanThresh:.25,loopGap:3.0, percMuteResist:.4, percStyle:'reactive', percDefaultPattern:null}
};

function getGenreConfig(g) { return GENRE_CONFIG[g] || GENRE_CONFIG[g.replace(/_curated$/,'')] || GENRE_CONFIG._default; }
function getScale(key, m) { return (SCALES[m] || SCALES.major).map(function(n) { return (n + key) % 12; }); }

// ── Perceptual note-separation thresholds ──
// Two zones derived from onset-asynchrony research:
//
// Zone 1 — Fusion (0 to FUSION ms): notes fuse into a single percept (dyad/chord).
//   Rasch 1978: synchronous onsets fully fuse across frequency.
//   RMR studies: < 10ms → complete perceptual fusion.
//
// Zone 2 — Uncanny (FUSION to SEPARATION ms): too offset to fuse, too close to
//   hear as intentional. Sounds like a timing mistake. RMR: 10-20ms = partial
//   fusion, perceptually ambiguous. The 21ms bug from Phase 4.5 lives here.
//
// Zone 3 — Expressive (≥ SEPARATION ms): clearly two events. Rasch 1979:
//   ensemble asynchrony 30-50ms perceived as normal. Goebl/Palmer/Repp:
//   piano melody lead ~20-30ms is expressive, not erroneous.
//
// Scheduler snap logic: gap < FUSION → collapse to 0 (let them fuse),
//   gap FUSION..SEPARATION → push to SEPARATION (clear the uncanny zone),
//   gap ≥ SEPARATION → leave alone.
// Phase 5+: ornament/trill paths may bypass via a schedule-level flag.
var NOTE_FUSION_THRESHOLD_MS = 5;
var NOTE_SEPARATION_MIN_MS = 35;

// ── Tempo damping ──
// Maximum fractional change in currentPeriod per onHumanNote() update.
// Prevents fast arpeggios (IOI ~100ms) from spiking inferred BPM.
// At 0.08, a player at 120 BPM (500ms period) can shift tempo by at most
// ±40ms per note. 6 fast arpeggio notes → ~182 BPM (not 320 undamped).
// Without damping, a single 250ms arpeggio IOI can halve the period instantly.
var TEMPO_DAMPING_MAX = 0.08;

// ── Cross-voice coordination thresholds (Phase 5A) ──
// When two voices fire notes within the uncanny zone across ticks,
// FinalCoordinator can detect the timing conflict and either:
//   (a) resolve the pitch clash (cross-tick m2), or
//   (b) delay the lower-priority note's audio onset past the zone boundary.
//
// CROSS_VOICE_UNCANNY_MS: timing window for cross-tick clash detection.
//   Same as NOTE_SEPARATION_MIN_MS by default — notes from different voices
//   within this window that form a minor 2nd are resolved.
//
// CROSS_VOICE_DELAY_MS: audio delay applied to push a note out of the
//   uncanny zone. Set to NOTE_SEPARATION_MIN_MS so the delayed note's
//   onset lands at the zone boundary (expressive, not ambiguous).
var CROSS_VOICE_UNCANNY_MS = 35;
var CROSS_VOICE_DELAY_MS = 35;

// ── Role Bias Helper ──
// Applies role-specific probability boosts that self-correct based on recent note history.
// As a note saturates the recent window, its boost decays toward neutral (1.0).
// This prevents role personality from overriding predict()'s own recency system.
//
// biases:      [{pc, boost}] — boost > 1.0 encourages, < 1.0 discourages
// recentNotes: stm.recent from the calling assistant (up to 12 notes)
// windowSize:  how many recent notes to consider (default 8)
//
// Phase 3: add getBassRoot()-derived entries to biases array (no logic change needed)
// Phase 5: expose boost values as per-assistant sliders (no logic change needed)
function applyRoleBias(probs, biases, recentNotes, windowSize) {
  var wSize = Math.min(windowSize || 8, recentNotes.length);
  var window = recentNotes.slice(-wSize);
  for (var i = 0; i < biases.length; i++) {
    var pc = biases[i].pc;
    var baseBoost = biases[i].boost;
    if (wSize === 0) {
      // No history yet — apply base boost directly, no saturation possible
      probs[pc] *= baseBoost;
      continue;
    }
    var count = 0;
    for (var j = 0; j < window.length; j++) { if (window[j] === pc) count++; }
    var saturation = count / wSize;
    // Full boost at saturation=0, neutral at saturation=1, linear decay between
    probs[pc] *= (1 + (baseBoost - 1) * (1 - saturation));
  }
  return probs;
}

// ═══ CONSTANTS — Per-Role Configuration (formerly constants-additions.js) ═══

// ── Per-role loop detection config ──
// Used by AssistantShared.detectLoopInBuffer() via each assistant's config.
var LOOP_CONFIG = {
  bass:   { threshold: 0.6, decay: 0.95, minConfidence: 0.5, minBufferLen: 6, maxLag: 16 },
  rhythm: { threshold: 0.6, decay: 0.98, minConfidence: 0.4, minBufferLen: 6, maxLag: 16 },
  soloist: { threshold: 0.7, decay: 0.90, minConfidence: 0.6, minBufferLen: 6, maxLag: 16 }
};

// ── Bass State Machine (v8.12.0) ──
// Research: Hove 2014, London 2012, Madison 2006, Pressing 2002, Danielsen 2006.
// Bass needs deterministic pattern-based output — you can't entrain to a random process.
// Three states: GROOVE (loop/phrase), SEARCHING (beat-locked pedal), ANCHORING (root on beat 1).
var BASS_STATE_MACHINE = {
  // ANCHORING triggers: ensemble density + voice count + needs_space
  // London 2012: metric regularity degrades above perceptual saturation
  anchoringDensityThresh: 8.0,
  anchoringVoiceCount: 5,
  anchoringNeedsSpace: 0.6,

  // SEARCHING limits
  // Hove 2014: bass predictability enables entrainment — max 1 bar unpatterned
  // v8.12.0: reduced from 2→1. Bass is the harmonic ground — 2 bars without a
  // groove pattern causes KeyBelief drift across all voices. Get back to GROOVE fast.
  maxSearchBars: 1,

  // Same-PC cooldown
  // Plomp & Levelt 1965: repeated tones at close intervals increase roughness in bass register
  samePCCooldownBeats: 1.0,

  // Silence budget
  // Madison 2006: bass absence >2 bars disrupts groove perception
  maxSilenceBars: 2,

  // Beat-locked note positions (bar phase ranges)
  // Beat 1: downbeat window. Beat 3: mid-bar window (wider for tempo variation)
  beat1Lo: 0.0,   beat1Hi: 0.06,
  beat3Lo: 0.46,  beat3Hi: 0.56,

  // Forced pedal: root quarter notes when SEARCHING exhausts maxSearchBars
  forcedPedalNotes: 4,
  forcedPedalIOI: 1.0
};

// ── Race condition guard ──
// Minimum ms since last human note before assistant fires in that register.
var ASSISTANT_RACE_GUARD_MS = 100;

// ── Motif response config (solo only) ──
var MOTIF_CAPTURE_MIN_NOTES = 3;
var MOTIF_CAPTURE_WINDOW_MS = 2000;
var MOTIF_RESPONSE_SILENCE_MS = 500;

// ── Phrase selection ──
var LEXICON_SCAN_LIMIT = 100;
var RECENT_PHRASE_MEMORY = 5;
var RECENT_PHRASE_MEMORY_SOLO = 8;

// ── Pattern buffer ──
var PATTERN_BUFFER_MAX = 32;

// ── Section Tracker (Phase A — Hierarchical Prediction) ──
var SECTION_STABLE_THRESHOLD = 8;
var SECTION_BUILD_MIN = 4;
var SECTION_PEAK_DURATION = [3, 16]; // v8.13.0: min 3 bars, max 16 bars (energy-sustained, not time-capped)
var SECTION_JITTER = 0.15;

// ── Surprise Thermostat (Phase A) ──
var SURPRISE_TARGET = 0.45;
var SURPRISE_WINDOW = 20;
var SURPRISE_GAIN = 0.3;

// ── Motif Developer (Phase B — Hierarchical Prediction) ──
var MOTIF_SEED_MAX = 3;
var MOTIF_SEED_EXPIRY_MS = 30000;
var DEVELOPMENT_SEED_LENGTH = [3, 6];

// ── Shared Phrase Memory (cross-voice motivic conversation) ──
// Pool: stigmergic shared space (Pressing 1999). Quality-gated entry.
var SHARED_PHRASE_POOL_MAX = 8;
var SHARED_PHRASE_TTL_MS = 120000;           // 2 min (Farbood 2012: section-scale memory)
var SHARED_PHRASE_NOTABILITY_THRESHOLD = 0.45;
var SHARED_PHRASE_VOICE_COOLDOWN_MS = 5000;
var SHARED_PHRASE_MIN_LENGTH = 3;
var SHARED_PHRASE_MAX_LENGTH = 12;
// Notability scoring weights (sum = 1.0)
var SHARED_PHRASE_CONTOUR_NOVELTY_W = 0.30;  // Narmour 1990: contour as primary feature
var SHARED_PHRASE_HARMONIC_INTEREST_W = 0.25; // Lerdahl 2001: non-chord-tone tension
var SHARED_PHRASE_PEER_SURPRISE_W = 0.25;     // Pressing 1999: notable ensemble moments
var SHARED_PHRASE_RHYTHMIC_INTEREST_W = 0.20; // Witek 2014: rhythmic complexity
// Cross-voice reference probabilities (Frieler 2016: ~25% cap for melodic voices)
var SHARED_PHRASE_REF_PROB = { bass: 0.15, rhythm: 0.20, soloist: 0.25, lead: 0.25 };
// Score bonus for motivic relationship (Sawyer 2003: anti-groupthink cap)
var SHARED_PHRASE_SCORE_BONUS_MAX = 0.08;

// ── Harmonic Planner (Phase C — Hierarchical Prediction) ──
var HARMONIC_PPM_ORDER = 3;
var HARMONIC_MAX_HISTORY = 64;

// ── Dialogue Engine (Phase D — Hierarchical Prediction) ──
var DIALOGUE_SMOOTH_RATE = 0.08;
var DIALOGUE_DENSITY_WINDOW_MS = 4000;
var DIALOGUE_SILENCE_LEAD_BEATS = 4;

// ── Bar-aligned scheduling defaults per role ──
var BAR_ALIGN_CONFIG = {
  bass: {
    enabled: true,
    confThreshold: 0.7,
    minDelay: 0.3,
    maxDelay: 2.0,
    useStrongBeat: false
  },
  rhythm: {
    enabled: true,
    confThreshold: 0.7,
    minDelay: 0.3,
    maxDelay: 1.5,
    useStrongBeat: true
  },
  soloist: {
    enabled: false
  }
};

// ── Phrase scoring weights per role ──
// v3 Phase 3: All extraScorers are ensemble-aware (4th arg = ensembleContext).
// Each role's extraScorer encodes its musical personality.
var PHRASE_SCORE_WEIGHTS = {
  bass: {
    freq: 0.2, interest: 0.3, contextFit: 0.35, // v8.16.0: 0.30→0.35 (Parncutt 1989: bass sets perceived root)
    loopBonus: 0.15, randomSpread: 0.15,
    metricStartW: 0.7, metricEndW: 0.3, metricScale: 0.2,
    bassRootIntervals: [7],
    bassRootBoost: 0.1,
    // v3 Phase 3: Bass anchors own key, avoids rhythm's PCs
    extraScorer: function(entry, key, score, ens) {
      if (!ens) return 0;
      var bonus = 0;
      // 1. Anchor own key root/fifth
      if (ens.voiceKeyBelief && ens.voiceKeyBelief.topKey !== undefined) {
        var myKey = ens.voiceKeyBelief.topKey;
        var startPC = (entry.sd[0] + key) % 12;
        if (startPC === myKey) bonus += 0.10;
        else if (startPC === (myKey + 7) % 12) bonus += 0.06;
      }
      // 2. Avoid rhythm's recent PCs (reduce low-end muddiness)
      if (ens.peerRecentPCs && ens.peerRecentPCs.rhythm) {
        var rPCs = ens.peerRecentPCs.rhythm;
        var overlap = 0;
        for (var i = 0; i < Math.min(entry.sd.length, 4); i++) {
          var pc = (entry.sd[i] + key) % 12;
          if (rPCs.indexOf(pc) >= 0) overlap++;
        }
        bonus -= overlap * 0.08;  // was 0.03 — stronger separation for voice independence
      }
      // 3. Low velocity → prefer shorter phrases
      if (ens.peerVelocity < 0.5 && entry.sd.length > 6) bonus -= 0.05;
      // 4. v3.17.0: Critical bandwidth penalty (Plomp & Levelt 1965, Helmholtz 1863)
      // In bass register (octave 2-3, ~65-130Hz), critical bandwidth is ~3-4 semitones.
      // Consecutive notes with intervals ≤3 semitones create audible roughness/beating.
      // Intervals of 4 semitones (major third) are borderline. ≥5 (perfect fourth) clear.
      // Convert scale degrees to semitones via current scale, then penalize narrow intervals.
      if (entry.sd.length >= 2) {
        var _sc = SCALES[SharedState.mode] || SCALES.minor;
        var _scLen = _sc.length;
        var narrowCount = 0;
        for (var ci = 1; ci < entry.sd.length; ci++) {
          var sd0 = entry.sd[ci - 1], sd1 = entry.sd[ci];
          // Convert SD to semitones (handling octave wrapping)
          var semi0 = _sc[((sd0 % _scLen) + _scLen) % _scLen] + Math.floor(sd0 / _scLen) * 12;
          var semi1 = _sc[((sd1 % _scLen) + _scLen) % _scLen] + Math.floor(sd1 / _scLen) * 12;
          var interval = Math.abs(semi1 - semi0);
          if (interval > 6) interval = 12 - interval;  // use shorter path
          if (interval > 0 && interval <= 3) narrowCount++;  // roughness zone
        }
        // Penalty: -0.04 per narrow interval (up to -0.16 for 4+ narrow intervals)
        bonus -= Math.min(narrowCount, 4) * 0.04;
      }
      return bonus;
    }
  },
  rhythm: {
    freq: 0.15, interest: 0.25, contextFit: 0.25,
    loopBonus: 0.25, randomSpread: 0.1,
    metricStartW: 0.4, metricEndW: 0.4, metricScale: 0.15,
    bassRootIntervals: [4, 7],
    bassRootBoost: 0.07,
    // v3 Phase 3: Preserves evenTiming + adds ensemble awareness
    extraScorer: function(entry, key, score, ens) {
      // Preserve existing evenTiming bonus (genre-gated)
      var evenTiming = 0;
      if (entry.ioi_ratios && entry.ioi_ratios.length > 0) {
        var gc = getGenreConfig(SharedState.genre);
        var variance = 0;
        for (var j = 0; j < entry.ioi_ratios.length; j++) {
          variance += Math.pow(entry.ioi_ratios[j] - 1.0, 2);
        }
        variance /= entry.ioi_ratios.length;
        evenTiming = Math.max(0, 0.15 - variance * 0.5) * gc.antiOsc;
      }
      if (!ens) return evenTiming;
      var bonus = evenTiming;
      // 1. Complement bass: reward thirds/sixths, penalize critical bandwidth roughness
      if (ens.peerRecentPCs && ens.peerRecentPCs.bass && ens.peerRecentPCs.bass.length > 0) {
        var bassPC = ens.peerRecentPCs.bass[ens.peerRecentPCs.bass.length - 1];
        var startPC = (entry.sd[0] + key) % 12;
        var interval = ((startPC - bassPC) % 12 + 12) % 12;
        if (interval === 3 || interval === 4) bonus += 0.06;       // thirds: clear
        else if (interval === 8 || interval === 9) bonus += 0.05;  // sixths: clear
        // v3.17.0: Critical bandwidth penalty against bass (Plomp & Levelt 1965)
        // Rhythm phrases starting on semitone/tone from bass root create roughness
        // in lower registers. Minor 2nd (1) worst, major 2nd (2) bad, minor 3rd (3) borderline.
        else if (interval === 1 || interval === 11) bonus -= 0.08;  // semitone: maximum roughness
        else if (interval === 2 || interval === 10) bonus -= 0.05;  // whole tone: significant roughness
      }
      // 2. Density counterbalance: dense ensemble → prefer shorter phrases
      if (ens.snapshot && ens.snapshot.totalDensity > 6) {
        bonus -= entry.sd.length * 0.01;
      }
      // 3. Avoid soloist's recent PCs (reduce voice correlation / MI)
      if (ens.peerRecentPCs && ens.peerRecentPCs.soloist) {
        var sPCs = ens.peerRecentPCs.soloist;
        var sOverlap = 0;
        for (var si = 0; si < Math.min(entry.sd.length, 4); si++) {
          var spc = (entry.sd[si] + key) % 12;
          if (sPCs.indexOf(spc) >= 0) sOverlap++;
        }
        bonus -= sOverlap * 0.06;
      }
      return bonus;
    }
  },
  soloist: {
    freq: 0.1, interest: 0.35, contextFit: 0.20, // v9.0.0: 0.15→0.20 (restore chord grounding — 0.15 dropped consonance 0.96→0.77)
    loopBonus: 0.0, randomSpread: 0.12, // v9.0.0: 0.15→0.12 (less noise → more consistent pool scoring)
    metricStartW: 0.2, metricEndW: 0.5, metricScale: 0.12,
    bassRootIntervals: [2, 5, 9],
    bassRootBoost: 0.06,
    // v3 Phase 3: Preserves interest/length + adds novelty/contrast
    extraScorer: function(entry, key, score, ens) {
      // Preserve existing static bonuses
      var interestBonus = (entry.interest || 0.5) * 0.15;
      var lengthBonus = Math.min(entry.sd.length / 12, 0.15);
      var noLoopBonus = entry.loopable ? 0 : 0.1;
      var base = interestBonus + lengthBonus + noLoopBonus;
      if (!ens) return base;
      var bonus = base;
      // 1. Novelty: reward PCs nobody else plays
      if (ens.peerRecentPCs) {
        var allPeer = {};
        var peers = ['bass', 'rhythm', 'lead'];
        for (var p = 0; p < peers.length; p++) {
          var pcs = ens.peerRecentPCs[peers[p]] || [];
          for (var j = 0; j < pcs.length; j++) allPeer[pcs[j]] = true;
        }
        var novel = 0;
        for (var i = 0; i < Math.min(entry.sd.length, 4); i++) {
          var pc = (entry.sd[i] + key) % 12;
          if (!allPeer[pc]) novel++;
        }
        bonus += novel * 0.08;  // was 0.04 — stronger novelty reward for voice independence
      }
      // 2. Contrast opportunity: boost interesting phrases when room exists
      if (ens.contrastOpportunity > 0.6) {
        bonus += (entry.interest || 0.5) * 0.08;
      }
      // 3. Dialogue initiative: prefer longer phrases when leading
      if (ens.dialogueStance && ens.dialogueStance.initiative > 0.7) {
        bonus += Math.min(entry.sd.length / 16, 0.06);
      }
      return bonus;
    }
  },
  // v3 Phase 3: Lead gets extraScorer for the first time
  lead: {
    freq: 0.1, interest: 0.4, contextFit: 0.3,
    loopBonus: 0.05, randomSpread: 0.15,
    metricStartW: 0.6, metricEndW: 0.4, metricScale: 0.15,
    extraScorer: function(entry, key, score, ens) {
      if (!ens) return 0;
      var bonus = 0;
      // 1. Contour preference — section-dependent (Huron 2006: arch 28.6% > ascending 22.4%)
      //    STABLE/RELEASE: arch contour. BUILD: ascending. PEAK: arch or descending. RELEASE: descending.
      if (entry.sd.length >= 4) {
        var half = Math.floor(entry.sd.length / 2);
        var ascFirst = 0, ascSecond = 0;
        for (var i = 1; i < entry.sd.length; i++) {
          if (entry.sd[i] > entry.sd[i - 1]) {
            if (i <= half) ascFirst++; else ascSecond++;
          }
        }
        var firstHalfAsc = ascFirst / Math.max(1, half);
        var secondHalfAsc = ascSecond / Math.max(1, entry.sd.length - 1 - half);
        // Detect contour shapes
        var isArch = firstHalfAsc > 0.5 && secondHalfAsc < 0.5;       // rise then fall
        var isAscending = firstHalfAsc > 0.5 && secondHalfAsc > 0.5;   // rising throughout
        var isDescending = firstHalfAsc < 0.5 && secondHalfAsc < 0.5;  // falling throughout
        // Section-dependent preference
        // v9.0.1: Doubled contour bonuses — lead melody needs strong directional commitment.
        // Without this, phrases wander (no resolution, no arc). Huron 2006: arch = 28.6% of melodies.
        var sec = ens.sectionState || 'STABLE';
        if (sec === 'BUILD') {
          if (isAscending) bonus += 0.14;
          else if (isArch) bonus += 0.08;
        } else if (sec === 'PEAK') {
          if (isArch) bonus += 0.12;
          else if (isDescending) bonus += 0.08;
        } else if (sec === 'RELEASE') {
          if (isDescending) bonus += 0.14;
          else if (isArch) bonus += 0.06;
        } else {  // STABLE, TRANSITION
          if (isArch) bonus += 0.14;  // arch is the natural melodic contour
          else if (isAscending) bonus += 0.04;
        }
      }
      // 2. Avoid soloist's register (reduce masking)
      if (ens.peerRecentPCs && ens.peerRecentPCs.soloist && ens.peerRecentPCs.soloist.length > 0) {
        var soloPC = ens.peerRecentPCs.soloist[ens.peerRecentPCs.soloist.length - 1];
        var startPC = (entry.sd[0] + key) % 12;
        var interval = ((startPC - soloPC) % 12 + 12) % 12;
        if (interval === 0) bonus -= 0.12;  // was 0.08 — stronger unison avoidance
        else if (interval === 1 || interval === 11) bonus -= 0.08;  // was 0.05
        else if (interval === 3 || interval === 4 || interval === 7) bonus += 0.04;
      }
      // 3. Order parameter: coherent ensemble → lead escalates
      if (ens.orderParameter > 0.6) bonus += 0.05;
      // 4. Key divergence: anchor own key during harmonic disagreement
      if (ens.keyDivergence > 0.4 && ens.voiceKeyBelief && ens.voiceKeyBelief.topKey !== undefined) {
        var myKey = ens.voiceKeyBelief.topKey;
        var startPC = (entry.sd[0] + key) % 12;
        if (startPC === myKey || startPC === (myKey + 7) % 12) bonus += 0.06;
      }
      // 5. v8.9.0: Contrary motion vs soloist (Huron 1989: maximum independence)
      // When soloist ascends, lead should descend (or sustain). Contrary motion is
      // the strongest cue for perceptual stream segregation after frequency separation.
      if (typeof ContextIntegrator !== 'undefined' && ContextIntegrator.getVoiceContour) {
        var _soloContour = ContextIntegrator.getVoiceContour('soloist');
        if (_soloContour !== 0 && entry.sd.length >= 3) {
          var _leadContour = entry.sd[entry.sd.length - 1] > entry.sd[0] ? 1 : (entry.sd[entry.sd.length - 1] < entry.sd[0] ? -1 : 0);
          if (_leadContour !== 0 && _leadContour !== _soloContour) bonus += 0.05;  // contrary
          else if (_leadContour === 0) bonus += 0.02;                              // oblique
          else if (_leadContour === _soloContour) bonus -= 0.03;                   // parallel
        }
      }
      // 6. v8.9.0: Sustained note preference (Huron 2001: onset asynchrony promotes segregation)
      // Lead = countermelody with longer notes. Soloist = burst-silence-burst.
      // Lead density should be 40-60% of soloist (Hodson 2007: complementary rhythm).
      if (entry.ioi_ratios && entry.ioi_ratios.length > 0) {
        var _avgIOI = 0;
        for (var _si = 0; _si < entry.ioi_ratios.length; _si++) _avgIOI += entry.ioi_ratios[_si];
        _avgIOI /= entry.ioi_ratios.length;
        if (_avgIOI > 1.3) bonus += 0.04;       // sustained (half-note territory)
        else if (_avgIOI < 0.6) bonus -= 0.03;  // fast runs (soloist territory)
      }
      return bonus;
    }
  }
};

// v3 Phase 3: Ensemble context cache TTL for pitch voice scoring (ms).
// Pitch voices rebuild ensembleContext when stale. ~1 beat at 120 BPM.
var ENSEMBLE_CACHE_TTL = 250;

// ── v8.3 FGSR: Asymmetric Peer Attention Matrix ──
// Defines which voice listens to which features from which peers.
// Values 0-1: attention weight per feature per peer.
// Derived from selective-listening-research.md Section 7.1.
// Hardcoded (not learnable) as structural anti-groupthink safeguard.
//
// Research grounding:
//   Washburn et al. 2019: Selective auditory attention in ensembles
//   Clayton 2012: Multi-timescale entrainment
//   Malian drum ensemble study: Asymmetric coupling outperforms democratic
//   Peter Hook (Joy Division): Anti-collision listening — register avoidance
//   Radiohead: Three-guitar register partitioning, negative-space listening
//
// Features: energy (L0), register (L0), contour (L2), tension (L0)
// Percussion never attends to register/contour (no pitched output)
// Bass→Percussion energy is tightest dyad (all genres)
// Human gets elevated attention (system exists to accompany)
var PEER_ATTENTION = {
  bass: {
    percussion: { energy: 0.8, register: 0.1, contour: 0.1, tension: 0.2 },
    rhythm:     { energy: 0.3, register: 0.4, contour: 0.3, tension: 0.2 },
    lead:       { energy: 0.2, register: 0.1, contour: 0.1, tension: 0.1 },
    soloist:    { energy: 0.2, register: 0.1, contour: 0.0, tension: 0.1 },
    human:      { energy: 0.4, register: 0.2, contour: 0.2, tension: 0.3 }
  },
  rhythm: {
    percussion: { energy: 0.6, register: 0.0, contour: 0.0, tension: 0.1 },
    bass:       { energy: 0.3, register: 0.3, contour: 0.3, tension: 0.2 },
    lead:       { energy: 0.3, register: 0.2, contour: 0.1, tension: 0.1 },
    soloist:    { energy: 0.3, register: 0.2, contour: 0.1, tension: 0.1 },
    human:      { energy: 0.4, register: 0.2, contour: 0.2, tension: 0.3 }
  },
  soloist: {
    percussion: { energy: 0.3, register: 0.0, contour: 0.0, tension: 0.1 },
    bass:       { energy: 0.2, register: 0.2, contour: 0.2, tension: 0.2 },
    rhythm:     { energy: 0.2, register: 0.2, contour: 0.1, tension: 0.1 },
    lead:       { energy: 0.3, register: 0.3, contour: 0.3, tension: 0.2 },
    human:      { energy: 0.5, register: 0.3, contour: 0.3, tension: 0.4 }
  },
  lead: {
    percussion: { energy: 0.2, register: 0.0, contour: 0.0, tension: 0.1 },
    bass:       { energy: 0.2, register: 0.2, contour: 0.2, tension: 0.2 },
    rhythm:     { energy: 0.3, register: 0.2, contour: 0.2, tension: 0.1 },
    soloist:    { energy: 0.3, register: 0.3, contour: 0.35, tension: 0.2 },  // dialogic pair — tighter contour coupling
    human:      { energy: 0.5, register: 0.3, contour: 0.3, tension: 0.4 }
  },
  percussion: {
    bass:       { energy: 0.5, register: 0.0, contour: 0.0, tension: 0.2 },
    rhythm:     { energy: 0.3, register: 0.0, contour: 0.0, tension: 0.1 },
    lead:       { energy: 0.2, register: 0.0, contour: 0.0, tension: 0.1 },
    soloist:    { energy: 0.2, register: 0.0, contour: 0.0, tension: 0.1 },
    human:      { energy: 0.6, register: 0.0, contour: 0.0, tension: 0.3 }
  }
};

// v4 Phase 3: Always-on continuous harmonic blending constants.
// Replaces discrete divergence > 0.3 gate with smooth onset.
// At divergence 0.05: blend weight ~4% (barely noticeable).
// At divergence 0.65: blend weight 50% (max — shared chord always ≥50% influence).
var HARMONY_BLEND_ONSET = 0.05;   // divergence below this → no blend
var HARMONY_BLEND_RANGE = 0.6;    // ramp from onset to full over this range
var HARMONY_BLEND_MAX   = 0.5;    // max voice interpretation weight (shared ≥50%)

// ── Per-role I-R (Implication-Realization) melodic expectancy weights ──
// Schellenberg (1997) two-factor model: proximity + reversal.
// Research-grounded per-role asymmetry:
//   bass:    high proximity (root-fifth stability), low reversal (stepwise continuation)
//   rhythm:  moderate — groove patterns, close to Schellenberg baseline
//   soloist: high reversal (gap-fill after leaps, direction changes — Narmour core)
//   lead:    lower proximity (wider intervals ok), ascending bias during BUILD
var I_R_WEIGHTS = {
  bass:    { proximity: 0.70, reversal: 0.15, ascendBias: 0 },   // v8.14.0: 0.85→0.70 — 67% unison rate was pathological (Huron 2006: bass motion is stepwise + 4th/5th)
  rhythm:  { proximity: 0.75, reversal: 0.25, ascendBias: 0 },
  soloist: { proximity: 0.65, reversal: 0.35, ascendBias: 0 },
  lead:    { proximity: 0.60, reversal: 0.25, ascendBias: 0.10 }
};

// v8.13.0: Bimodal proximity curve for melodic voices (Huron 2006, Schellenberg 1997)
// Melodic expectation is bimodal: steps (1 degree) AND leaps (4-7 degrees) both expected.
// The "neither zone" at 2-3 degrees is least expected. Index = degree distance, value = score.
// Bass/rhythm keep linear falloff (structural grounding). Soloist/lead use bimodal.
var BIMODAL_PROXIMITY = [
  0.5,   // distance 0: unison — melodic voices should move, not repeat
  1.0,   // distance 1: step — highest preference (Huron 2006 proximity peak)
  0.6,   // distance 2: skip — moderate (kept at 0.6; raising to 0.7 increased off-chord skips)
  0.4,   // distance 3: "neither zone" — least preferred
  0.5,   // distance 4: leap begins (v8.14.0: 0.6→0.5 — Huron 2006 second peak ~30-40% of step rate)
  0.5,   // distance 5: established leap (v8.14.0: 0.7→0.5 — old value caused off-chord leaps)
  0.35   // distance 6+: wide leap (v8.14.0: 0.5→0.35 — rare leaps, needs harmonic justification)
];
// v9.2.0: BIMODAL_PROXIMITY_ROLES removed — inlined as `role === 'soloist'` in phrase-generator.js.
// Only soloist uses bimodal (exploratory role). Lead uses linear (supportive, HARMONIC_AUTHORITY 0.95).

// ── v6 Phase 7A: Enhanced I-R factors (Huron 2006, Von Hippel & Huron 2000) ──
// Key-aware stability: scale tones get bonus, chromatic tones get penalty.
// Range regression: bias toward tessitura center when near range boundary.
//   Per-role: bass regresses strongly (stay near root), soloist less (wider leaps ok).
// Phrase arch: first-half upward bias, second-half downward (Huron 2006 contour universal).
//   Per-role: lead stronger arch (melodic prominence), bass weaker (root anchoring).
// v8.14.0: stabilityBonus raised for all, stabilityPenalty raised for bass/rhythm only.
// Soloist/lead keep original penalty — they must follow distant chord changes which have
// chromatic roots/thirds (e.g., Dm chord in F# minor key). Heavy chromatic penalty
// conflicts with chord-tone tracking. (Temperley 2007 key profiles apply to overall
// distribution, not individual note selection where chord context overrides key context.)
var I_R_ENHANCED = {
  bass:    { stabilityBonus: 0.14, stabilityPenalty: -0.06, regressionStr: 0.08, archBias: 0.02 },
  rhythm:  { stabilityBonus: 0.12, stabilityPenalty: -0.06, regressionStr: 0.06, archBias: 0.03 },
  soloist: { stabilityBonus: 0.08, stabilityPenalty: -0.05, regressionStr: 0.04, archBias: 0.05 },
  lead:    { stabilityBonus: 0.08, stabilityPenalty: -0.05, regressionStr: 0.04, archBias: 0.06 }
};

// v8.6.0: IOI duration-aware prediction (Cont 2008 HSMM, Nakamura 2015)
// Controls whether trie-driven IOI generation and scoring are active.
// Requires diverse LTM corpus — electronic-only data biases toward uniform rhythms.
var IOI_GENERATION_ENABLED = true;   // v8.13.0: enabled — corpus now 42-63% non-quarter across roles

// v8.13.0: IOI generation entropy safeguard (Fraisse 1982 duration perception)
// When trie prediction entropy < threshold, distribution is too concentrated
// (likely dominated by quarter notes). Mix in template selection at 50%.
// Max entropy for 16 bins = log2(16) = 4.0. Threshold 1.8 catches distributions
// where >60% mass is in 1-2 bins. Corpus entropies: bass 2.18, rhythm 2.60,
// soloist 2.56, lead 2.66 — all above threshold at root level. Deeper trie
// contexts (after runs of quarter notes) will drop below, triggering mix-in.
var IOI_ENTROPY_THRESHOLD = 1.8;

// Per-role template preference when falling back to templates
// Bass/rhythm: structural voices prefer even/slight (metronomic grounding)
// Soloist/lead: melodic voices prefer grooved/syncopated (rhythmic interest)
var IOI_ROLE_TEMPLATE_PREFERENCE = {
  bass:    ['even', 'slight'],
  rhythm:  ['even', 'slight'],
  soloist: ['grooved', 'syncopated'],
  lead:    ['grooved', 'syncopated']
};

// v8.6.0: Rhythm loop variation (Huron 2006 ITPRA, Margulis 2014 "On Repeat")
// Progressive variation prevents staleness while preserving groove recognition.
// Loops 0-1: exact repetition (establish). Loops 2-3: subtle. Loops 4+: moderate.
var LOOP_VARIATION = {
  ESTABLISH_LOOPS: 2,     // loops before variation begins (Margulis: 2 reps for recognition)
  SUBTLE_PROB: 0.25,      // per-note variation probability, loops 2-3
  FULL_PROB: 0.50,        // per-note variation probability, loops 4+
  MAX_VARS_PER_LOOP: 2,   // cap on variations per single loop iteration
  IOI_MICRO_RANGE: 0.10   // ±10% IOI scaling (Pressing 1999 micro-timing)
};

// v8.6.0: Rhythm articulation — metric accents + phrase arc
// Lerdahl & Jackendoff 1983: metrical well-formedness (beat 1 > 3 > 2,4 > off-beats)
// Sundberg 1991: performance arch (crescendo to midpoint, diminuendo)
// Palmer 1997: timing, dynamics, articulation in performance
var RHYTHM_ARTICULATION = {
  BEAT1_ACCENT: 1.15,     // strongest metrical position
  BEAT3_ACCENT: 1.08,     // secondary strong beat
  BEAT24_ACCENT: 0.92,    // weak beats
  OFFBEAT_ACCENT: 0.85,   // off-beat positions
  PHASE_TOLERANCE: 0.04,  // bar-phase proximity for beat detection
  PHRASE_ARC_BOOST: 1.10, // velocity at phrase midpoint
  PHRASE_ARC_DIM: 0.90,   // velocity at phrase edges
  SECTION_INTENSITY: {     // how strongly articulation applies per section
    STABLE: 0.6,          // gentle accents
    BUILD: 0.8,
    PEAK: 1.0,            // full accent intensity
    RELEASE: 0.5          // minimal accents
  }
};

// v2.6.1: Percussion density targets per section (research: universal §15)
// Used by percussion-assistant to select patterns with appropriate density
var PERC_DENSITY_TARGETS = {
  STABLE: 0.35,      // 4-6 notes/bar — sparse, conversational
  BUILD: 0.50,       // 6-8 notes/bar — moderate
  PEAK: 0.70,        // 8-10 notes/bar — dense
  RELEASE: 0.25,     // 3-4 notes/bar — very sparse
  TRANSITION: 0.30   // sparse, clearing space
};

// v3 Phase 1: Key as Probability Distribution
// When key confidence drops below threshold, scale-fit gate softens and
// softScaleFit() in assistant-shared.js ranks phrases by weighted fit
// across the full 24-key Bayesian distribution.
var KEY_BELIEF_CONFIG = {
  CONFIDENCE_THRESHOLD: 0.6,  // below this, use soft scale-fit
  SOFT_SCALE_FIT_MIN: 0.4,    // scaleFitMin when confidence is low (normally 0.7)
  UPDATE_INTERVAL_MS: 500     // update at ~beat rate, not every tick
};

// ── v3 Phase 2: L2 Melodic Intent ──
// Maps L1 POMDP beliefs (5 needs) → 4 melodic intents via dot product + softmax.
// Intent persists for a commitment window (bars), creating multi-bar phrase arcs.
// See info/L2_MELODIC_INTENT_PLAN.md for full design.

// L1→L2 mapping matrix: rows = intents, columns = [stability, energy, space, surprise, resolution]
var L1_TO_L2_MATRIX = {
  continuation: [0.25, 0.35, 0.00, 0.10, 0.15],  // sustain momentum
  punctuation:  [0.10, 0.00, 0.45, 0.10, 0.30],  // statement + silence
  consonance:   [0.40, 0.10, 0.15, 0.00, 0.30],  // stable ground
  contrast:     [0.05, 0.30, 0.05, 0.50, 0.05]   // explore / surprise
};

// Per-role bias added BEFORE softmax normalization.
// Bass anchors (continuation/consonance), soloist explores (contrast).
// v9.2.0: Removed zero-valued entries (no effect in softmax normalization)
var INTENT_ROLE_BIAS = {
  bass:       { continuation: 0.15, consonance: 0.10 },
  rhythm:     { continuation: 0.10, consonance: 0.05 },
  soloist:    { continuation: 0.05, punctuation: -0.10, contrast: 0.20 },
  lead:       { continuation: 0.10, consonance: 0.12, contrast: 0.05 },
  percussion: { continuation: 0.15, punctuation: 0.05, consonance: 0.10, contrast: -0.05 }
};

// Commitment window in bars — how long intent is held before re-evaluation.
// Section-dependent: STABLE/RELEASE use shorter windows, BUILD/PEAK use longer.
var INTENT_COMMITMENT_BARS = {
  // v8.6.0 QW3: Bass holds patterns longer in STABLE (Pressing 1999 — groove from repetition)
  bass:       { STABLE: 6, BUILD: 4, PEAK: 4, RELEASE: 4, TRANSITION: 2, default: 4 },
  rhythm:     { STABLE: 4, BUILD: 4, PEAK: 4, RELEASE: 4, TRANSITION: 2, default: 4 },
  soloist:    { STABLE: 4, BUILD: 6, PEAK: 8, RELEASE: 4, TRANSITION: 2, default: 4 },
  lead:       { STABLE: 4, BUILD: 8, PEAK: 8, RELEASE: 4, TRANSITION: 2, default: 4 },
  // Percussion commits longer — textural character changes slowly
  percussion: { STABLE: 8, BUILD: 6, PEAK: 4, RELEASE: 8, TRANSITION: 4, default: 6 }
};

// ── v8 Feature G: Harmonic Trajectory Signaling (stigmergic coordination) ──
// Per-role authority weight for harmonic consensus voting.
// Grounded in psychoacoustic bass dominance (Terhardt 1974 virtual pitch,
// Parncutt 1989 pitch salience: bass contributes 3-5× more to perceived
// harmonic identity). Soloist weighted low — exploratory role with fast
// KeyBelief decay; its harmonic opinions are provisional.
// Pressing (1999): shared referent is naturally bass-weighted.
var HARMONIC_AUTHORITY_WEIGHT = {
  bass: 1.0, rhythm: 0.85, soloist: 0.45, lead: 0.95, percussion: 0.0, human: 0.50
};
// Bharucha (1987) harmonic priming: expected harmonies ~15-20% more fluent.
// Bigand (1999): terminal progressions show 25-35% RT advantage, non-terminal 10-15%.
// 0.15 = midpoint of non-terminal priming effect.
var HARMONIC_CONSENSUS_BONUS = 0.15;
// v8.14.0: Bass-specific consensus bonus — Terhardt 1974, Parncutt 1989: bass is primary
// determinant of perceived harmonic identity. Higher pull ensures bass tracks chord changes.
var HARMONIC_CONSENSUS_BONUS_BASS = 0.22;
// Krumhansl (1990): tonal establishment needs 2-4s minimum.
// Huron (2006): musical present ~5s. Farbood (2012): mood integration ~22s.
// 3000ms base = midpoint of Krumhansl establishment window.
// Dynamic decay implemented in ChordBelief.getConsensus (resets on section/cadence).
var HARMONIC_CONSENSUS_TTL = 3000;

// ── v9.3.0: Aesthetic Dimensions (Neural Interface) ──
// 4-dimensional aesthetic space for phrase scoring. Each dimension captures a
// cluster of related scoring factors. All weights 1.0 = behavioral equivalence
// with the pre-S2 monolithic scorer. When neural models replace a dimension,
// its weight controls blending between rule-based and neural output.
// Dimensions: harmonic (chord fit), groove (rhythmic continuity),
//             interest (novelty/engagement), expectancy (pattern prediction)
var AESTHETIC_DIMENSIONS = {
  bass:    { harmonic: 1.0, groove: 1.0, interest: 1.0, expectancy: 1.0 },
  rhythm:  { harmonic: 1.0, groove: 1.0, interest: 1.0, expectancy: 1.0 },
  soloist: { harmonic: 1.0, groove: 1.0, interest: 1.0, expectancy: 1.0 },
  lead:    { harmonic: 1.0, groove: 1.0, interest: 1.0, expectancy: 1.0 }
};

// ── v9 Feature A: Precision-Weighted Expectancy (Vuust et al. 2022, Active Inference) ──
// Expectancy influence scales with prediction precision (inverse entropy).
// Stance-driven intent mapping replaces hand-tuned constants.
var PRECISION_FLOOR = 0.02;  // v8.2: lowered from 0.05 to let more predictions through
// Per-stance multipliers for expectancy intent weights.
// Maps dialogue stance → scaling factor per intent type.
// Vuust et al. 2022: precision = confidence in prediction; stance modulates what to predict.
var STANCE_EXPECTANCY_MAP = {
  agree:      { continuation: 1.3, contrast: 0.5, consonance: 1.1 },
  support:    { continuation: 1.2, contrast: 0.6, consonance: 1.0 },
  extend:     { continuation: 0.8, contrast: 1.0, consonance: 1.2 },
  question:   { continuation: 0.6, contrast: 1.4, consonance: 0.8 },
  lead:       { continuation: 1.0, contrast: 1.2, consonance: 0.9 },
  contradict: { continuation: 0.4, contrast: 1.5, consonance: 0.6 }
};
// v8.2 Fix #3: Raised base weights so expectancy competes with I-R (~0.85).
// Previous values (0.25/0.15/0.18) produced eWeight ~0.06-0.12 at typical precision,
// making expectancy a negligible tiebreaker. New values produce eWeight ~0.20-0.40,
// bringing IC toward the Berlyne 1.0-2.5 sweet spot (Pearce 2005, Gold et al. 2019).
var EXPECTANCY_BASE_WEIGHTS = {
  continuation: 0.55, contrast: 0.35, consonance: 0.45
};


# Markov Music Heatmap

**A real-time musical pattern mirror and performable probability surface for improvising musicians.**

Inspired by:
https://www.math.utah.edu/~gustafso/s2016/2270/published-projects-2016/zhang-bopanna/zhangJie-bopannaPrathusha-MarkovChainMusicComposition.pdf

---

## What Is This?

Markov Heatmap Music Mirror is a tool that **listens to you play**, builds a live probabilistic model of your musical tendencies, and displays them as an interactive heatmap.It shows you *where you've been* and *where you tend to go next*, so you can play more intentionally.# Markov Music Heatmap — Design & Architecture Document v2

## 1. Concept Summary

**What it is:** A native desktop application that listens to an electric guitarist play in real time, builds a live probabilistic model of their musical patterns, and displays those patterns as an interactive heat-overlay on a Tonnetz (tone network) surface. It shows you *where you've been* and *where you're likely to go next*, so you can play more intentionally.

**What it is not:** It is not a music generator, auto-accompanist, or AI composer. It does not make decisions for the musician. The musician remains the performer. The system provides visibility and structure.

**Who it's for:** Intermediate-to-advanced electric guitar players who improvise, jam, or compose on-the-fly and want to understand their playing habits, break out of ruts, and expand their vocabulary.

**Core metaphor:** A cycling power meter for improvisation — making invisible patterns visible so the musician can make better decisions.

---

## 2. Two-Mode Workflow

The system has two modes, designed around how guitarists actually practice. Critically, these modes are NOT independent — chord context from Mode 1 directly conditions the predictions in Mode 2.

### Mode 1: Chord Mode
- The musician strums through a chord progression
- The system detects chords via chromagram template matching
- A chord-to-chord transition heatmap builds on the Tonnetz (chords appear as geometric shapes — major triads as downward triangles, minor triads as upward triangles)
- When satisfied, the musician hits "loop" and the progression plays back through the audio engine

### Mode 2: Single-Note Mode (Chord-Conditioned)
- The chord loop plays in headphones (so it doesn't interfere with detection)
- The musician solos over the progression
- The system uses monophonic pitch detection to track individual notes
- Note predictions are **conditioned on the current chord** — the heatmap shifts as the underlying chord changes in the loop

### Why Chord Conditioning Matters
The same note has different musical meaning depending on the chord underneath. E over C major is a consonant chord tone (major 3rd). E over F major is a tension note (major 7th). A non-conditioned model would blur these two very different musical situations together. The chord-conditioned model maintains separate transition patterns per chord context, producing more musically meaningful predictions.

**Implementation:** Instead of one 12×12 transition matrix, the system maintains one matrix per chord encountered. When the chord loop plays Am, the Am-conditioned matrix drives the heatmap. When it changes to F, the F-conditioned matrix takes over. The theory prior fills each chord-specific matrix with musically sensible defaults (chord tones weighted higher, approach tones weighted, avoid notes weighted lower).

---

## 3. Visualization System

### Primary: Tonnetz (Tone Network) Heat Surface

The Tonnetz is a 2D hexagonal lattice where each node is one of the 12 pitch classes. Nodes are connected by musically meaningful intervals:
- Horizontal axis: perfect fifths
- One diagonal: major thirds
- Other diagonal: minor thirds

**Why Tonnetz over a flat heatmap grid:**
- A transition matrix is 2D data (from note X → to note Y). The Tonnetz is a 2D surface, so heat/color naturally overlays onto it.
- The *shape* of the heat pattern is musically interpretable: horizontal spread = movement in fifths, diagonal spread = movement in thirds, tight cluster = stepwise motion, scatter = large leaps.
- Chords form visible geometric shapes: major triads are downward triangles, minor triads are upward triangles. Chord transitions become spatial movement of shapes.
- Transposition doesn't change the shape — a C major pattern and an F major pattern look identical, just shifted on the grid. This makes pattern recognition across keys intuitive.

**Why not Circle of Fifths as primary:**
- The Circle of Fifths is 1D (a ring). It has no second axis for the "from/to" relationship that transition data requires.
- Showing transitions on a circle requires arcs/arrows between nodes, which becomes a tangle with 12 possible targets at different probabilities. It doesn't scale.
- The Circle of Fifths is better suited as a **secondary orientation widget** — showing current key center and diatonic context.

**Heatmap behavior on Tonnetz:**
1. Musician plays note A → node A lights up as "current position"
2. Prediction engine calculates probability vector for all 12 possible next notes
3. All Tonnetz nodes glow with color intensity proportional to their predicted probability
4. Musician plays note B → node B lights up, node A dims, heat redistributes from B's perspective
5. The trail of previously visited nodes can persist with fading intensity, showing the melodic path

### Secondary Views (Same Data, Different Projection)

**Fretboard overlay:** Maps the same probability vector onto a guitar fretboard diagram. Most intuitive for real-time playing — the guitarist sees their actual instrument with positions glowing. Best for performance mode where cognitive load must be minimal.

**Circle of Fifths widget:** Compact orientation display showing current key center, diatonic chord territory, and how far the player is drifting from the tonal center. Informational, not the primary interaction surface.

**Analytical heatmap (traditional):** A 12×12 grid (rows = "from note", columns = "to note") for post-session deep analysis. Less intuitive during playing, but shows the raw matrix with exact probability values. Useful for studying patterns after a session.

All views are driven by the same prediction engine output — compute once, render in multiple projections.

---

## 4. Blended Prediction Engine

### The Core Insight: Separate Prediction from Visualization

The Tonnetz heatmap is the *display layer*. The probability values populating it can come from multiple prediction sources blended together. Both engines output the same thing — a 12-element probability vector over possible next notes. They blend:

```
final_prob = (w1 × markov_prediction) + (w2 × neural_prediction) + (w3 × theory_prior)
```

where w1 + w2 + w3 = 1.

### Layer 1: Markov Engine (Real-Time Learning, Your Patterns)
- Chord-conditioned transition matrices built from the musician's live playing
- Adaptive phrase-aware context (see Section 5)
- Updates instantly with each new note
- Perfectly interpretable — the probabilities literally are your observed frequencies
- Lightweight, runs anywhere

### Layer 2: Neural Engine (Pre-Trained Musical Intelligence)
- Small LSTM or lightweight Transformer model, pre-trained on a corpus of guitar solos/melodies
- Takes last N notes + current chord as input, outputs 12-element probability vector
- Captures longer-range patterns the Markov chain can't see (e.g., "ascending thirds over a ii-V-I typically resolve to the 3rd of the I chord")
- Runs via ONNX Runtime or CoreML in the native app
- v2 feature — not required for initial release

### Layer 3: Theory Prior (Music Theory Knowledge)
- Krumhansl-Kessler key profiles for pitch class distribution
- Scale degree tendency tones (7→1, 4→3, 2→1)
- Chord-tone weighting (chord tones high, approach tones medium, avoid notes low)
- Pentatonic/blues bias for guitar contexts
- Interval distribution (stepwise > leaps, diatonic > chromatic)

### User-Facing Controls

**Blend slider:** Ranges from "My Patterns" (pure Markov) ↔ "Musical Intelligence" (neural-weighted). At center, both contribute equally.

**Theory prior toggle:** On/Off/Hybrid. In Hybrid, the prior weight decays as the session accumulates data.

**Phrase sensitivity knob:** Controls automatic phrase boundary detection aggressiveness.

---

## 5. Adaptive Phrase-Aware Memory

### The Problem
In real improvisation, relevant context is never a fixed window. A fast pentatonic run has 6-8 notes of phrase context. A long sustained bend resets everything. A call-and-response reaches back 12 notes. Fixed n-gram lookback forces a rigid frame onto something fluid.

### The Solution: Automatic Phrase Segmentation

The system detects phrase boundaries using acoustic cues:

| Signal | Detection Method |
|--------|-----------------|
| Silence gap (≥200ms) | Amplitude threshold |
| Large pitch interval (>7 semitones) | Difference between consecutive detected pitches |
| Dynamic shift (loud↔soft) | RMS energy change between frames |
| Rhythmic change (fast→slow) | Note onset interval duration change |

**Within a phrase:** All notes count as context (variable-length Markov chain). Predictions sharpen as context grows.

**At a phrase boundary:** Context resets. Predictions open up — more Tonnetz nodes light up because the system is less certain where a new phrase will go.

**The Tonnetz shows this naturally:** Mid-phrase, the heat concentrates tightly. At boundaries, it diffuses. The musician sees the difference between being inside a musical thought and being between thoughts.

### Phrase Sensitivity Control
- **High:** Aggressive boundary detection (short phrases, frequent resets)
- **Low:** Continuous stream (everything is context for everything)
- **Manual override:** Footswitch or keyboard shortcut to mark boundaries

---

## 6. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SESSION SETUP                            │
│  [Key] [Scale] [Mode: Chord/Note] [Prior: Mirror/Guided/Hybrid]│
│  [Phrase Sensitivity] [Blend Weight]                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                      INPUT LAYER                                │
│  Native Audio I/O (PortAudio/RTAudio) + MIDI Input              │
│  ┌──────────────┐         ┌──────────────────┐                  │
│  │ Note Mode:   │         │ Chord Mode:      │                  │
│  │ McLeod Pitch │         │ Chromagram +     │                  │
│  │ Monophonic   │         │ Template Match   │                  │
│  │ → pitch + hz │         │ → chord label    │                  │
│  └──────┬───────┘         └────────┬─────────┘                  │
│         │      ┌──────────┐       │                             │
│         │      │ MIDI In  │       │                             │
│         │      │ (bypass  │       │                             │
│         │      │ detection)│      │                             │
│         │      └────┬─────┘       │                             │
└─────────┼───────────┼─────────────┼─────────────────────────────┘
          └───────────┼─────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│                    PHRASE DETECTOR                               │
│  Monitors: silence gaps, pitch jumps, dynamic shifts,           │
│  rhythmic changes. Outputs: phrase boundary events              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│               BLENDED PREDICTION ENGINE                         │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   Markov    │  │   Neural    │  │   Theory    │             │
│  │   Engine    │  │   Engine    │  │   Prior     │             │
│  │ (live learn)│  │ (pre-train) │  │ (static)    │             │
│  │ chord-cond. │  │ chord-cond. │  │ chord-cond. │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │    w1          │    w2          │    w3               │
│         └────────────────┼────────────────┘                     │
│                          ▼                                      │
│              [Blended 12-element probability vector]             │
│              [conditioned on current chord context]              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┬─────────────────┐
          ▼                ▼                ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────────┐
│ TONNETZ VIEW │  │ FRETBOARD    │  │ ANALYTICAL │  │ SESSION LOG  │
│ (primary)    │  │ VIEW         │  │ HEATMAP    │  │              │
│ Hex grid     │  │ Guitar neck  │  │ 12×12 grid │  │ JSON/MIDI    │
│ Heat overlay │  │ Glow overlay │  │ Post-sess. │  │ Note list    │
│ Chord shapes │  │ Real-time    │  │ Deep study │  │ Timestamps   │
│ Path trace   │  │ performance  │  │            │  │ Phrases      │
└──────┬───────┘  └──────────────┘  └────────────┘  └──────────────┘
       │
       ▼
┌──────────────┐
│ INSTRUMENT   │
│ MODE         │
│ Click Tonnetz│
│ nodes to play│
│ through prob.│
│ space        │
└──────────────┘
```

### Platform & Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| App framework | Tauri (Rust + web frontend) or JUCE (C++) | Native audio I/O, low latency, potential VST/AU plugin |
| Audio input | PortAudio / RTAudio / CoreAudio | ~1.5-3ms latency at 64-128 sample buffer |
| MIDI input | RtMidi or platform MIDI API | Bypasses pitch detection entirely for MIDI guitars |
| Pitch detection | McLeod Pitch Method (pitchy port or native impl) | Fast, accurate for monophonic guitar |
| Chord detection | Chromagram + template matching (Stark algorithm) | Established MIR approach |
| Markov engine | Custom implementation (transition matrices) | Simple, lightweight, interpretable |
| Neural engine (v2) | ONNX Runtime / CoreML / TFLite | Local GPU inference for pre-trained LSTM/Transformer |
| Visualization | Canvas/WebGL (Tauri) or OpenGL (JUCE) | Real-time Tonnetz + fretboard rendering |
| Sound output | Audio engine for chord loop playback | Internal synth or sampler |
| Session export | JSON + optional MIDI encoding | Structured data for analysis and replay |

### Why Native Over Web

| Concern | Web (Browser) | Native (Desktop) |
|---------|--------------|-------------------|
| Audio latency | ~20-50ms (Web Audio API buffers) | ~1.5-3ms (direct hardware access) |
| MIDI input | Web MIDI API (limited browser support) | Full MIDI stack, any device |
| GPU for neural | WebGL/WebGPU (immature for ML) | ONNX/CoreML/CUDA (mature) |
| DAW integration | Impossible | VST/AU plugin possible |
| Audio routing | Complex (browser permissions) | Direct hardware selection |
| Distribution | No install, instant access | Requires download/install |

---

## 7. Critical Assessment & Open Questions

### Technical Risks

**Detection accuracy on electric guitar.** Distortion, palm muting, string noise, bends, hammer-ons, and slides produce audio that challenges pitch detection. Mitigation: confidence threshold (reject ambiguous detections), MIDI input option bypasses detection entirely. Needs early testing with actual guitar+amp setups.

**Chord detection with distortion.** Heavy gain smears the harmonic spectrum. Clean to lightly overdriven guitar works best for chord mode. Mitigation: recommend clean tone for chord mode, or allow manual chord entry.

**Chord-conditioned matrix sparsity.** With one matrix per chord and 12 pitch classes, each matrix needs independent training data. A session with 6 chords splits the data 6 ways. The theory prior fills the gap early, but the Markov engine needs more playing time before chord-specific predictions become truly personal.

**Phrase detection imperfection.** Automatic segmentation will sometimes misfire. The sensitivity knob and manual override mitigate this but don't eliminate it.

### UX Risks

**Tonnetz readability.** Musicians unfamiliar with the Tonnetz need onboarding. The hex grid is less immediately obvious than a fretboard. Mitigation: optional fretboard view, and Tonnetz tutorial/overlay showing interval relationships.

**Cognitive load during performance.** Even the Tonnetz is a divided attention task. Session replay (scrubbing through your session with the heat evolving) may be more valuable than the real-time view for detailed analysis. The fretboard view is the lowest cognitive load option for real-time use.

**Cold start.** In pure Markov mode, the first 30-60 seconds produce weak predictions. Hybrid mode (theory prior + live learning) solves this.

### Design Improvements to Consider

**Session comparison.** Save sessions and compare Tonnetz heat patterns across days/weeks. Longitudinal pattern tracking.

**Chord-note interval overlay.** Show which scale degrees you tend to play over each chord. "Over Dm you always land on the root. Over G7 you gravitate to the b7." This falls naturally out of the chord-conditioned data.

**Velocity/dynamics layer.** Track dynamics patterns. "When you play E loud, you tend to go to G; when you play E soft, you tend to resolve down to D."

**Rhythm integration.** Add note duration and inter-onset interval to the state space. Captures rhythmic habits beyond just pitch transitions.

**Instrument mode.** Click Tonnetz nodes to play through the probability space — perform *on* the visualization itself. Hear what the model predicts as you navigate tonal space manually.

---

## 8. Prediction Model Assessment

### Why Markov Chains Remain the Core

Despite neural models outperforming Markov chains on raw prediction accuracy (LSTM with attention: 0.85 accuracy vs. Markov: 0.23 for chord prediction in one study), Markov chains are the right core for this project because:

1. **Interpretability IS the product.** The musician must see and understand their patterns. A transition matrix maps directly to a readable visualization.
2. **Real-time learning from scratch.** No pre-training. Each note updates the model instantly.
3. **Lightweight.** A few hundred bytes of state. Runs anywhere.
4. **Phrase-aware context mitigates the memory limitation.** Dynamic context windows capture phrase-level structure without exploding the state space.
5. **Theory prior compensates for sparse data.** Musically sensible predictions from note one.

### The Blended Approach (Best of Both Worlds)

The architecture decouples prediction from visualization. Multiple engines output the same 12-element probability vector. They blend by weighted average. The Tonnetz heatmap doesn't care where the numbers came from.

This means:
- v1 ships with pure Markov + theory prior (already valuable, zero ML dependency)
- v2 adds a pre-trained neural layer (LSTM or small Transformer) for richer predictions
- The musician can dial the blend between "my patterns" and "musical intelligence"
- Neural predictions get better accuracy; Markov visualization maintains interpretability

---

## 9. Related Research & References

### Pitch Detection
- McLeod & Wyvill, "A Smarter Way to Find Pitch" — algorithm behind pitchy
- cwilso/PitchDetect — reference autocorrelation implementation
- peterkhayes/pitchfinder — multi-algorithm JS pitch detection

### Chord Detection
- Adam Stark, "Chord Detection and Chromagram Estimation" — C++ with JS wrapper
- Oudre et al., "Chord recognition by fitting rescaled chroma vectors"
- Krumhansl & Kessler key profiles — pitch class distribution

### Markov Chains & Music
- Zhang & Bopanna, "Using Markov Chain to Compose Music Pieces" (Utah, 2016) — project inspiration
- Simonton, "Melodic Structure and Note Transition Probabilities: 15,618 Classical Themes"
- Kaliakatsos-Papakostas et al., "Weighted Markov Chain Model for Musical Composer Identification"
- Linskens, "Music Improvisation using Markov Chains" (Maastricht)

### Neural Music Models
- Huang et al., "Music Transformer: Generating Music with Long-Term Structure" (ICLR 2019)
- Music Informer (2025) — efficiency improvements over Music Transformer
- Choi et al., "Chord Conditioned Melody Generation with Transformer Based Decoders"
- MelodyDiffusion — chord-conditioned melody generation via diffusion + transformers
- Kosta et al., "Striking a New Chord: Neural Networks in Music Information Dynamics" — direct Markov vs. neural comparison

### Tonnetz & Music Visualization
- Euler (1739) — original Tonnetz conception
- TonnetzViz (cifkao) — real-time MIDI visualization on Tonnetz with Web MIDI API
- Isochords — Tonnetz-based chord progression visualization
- Harmonic Navigator (Manaris et al.) — Tonnetz navigation with prediction for composition
- Lerdahl, "Tonal Pitch Space" — theoretical foundation for spatial pitch representations

### Music Theory & Tendency Tones
- Temperley, "Information Flow and Repetition in Music" (Journal of Music Theory, 2014)
- Krumhansl, "Cognitive Foundations of Musical Pitch"
- Open Music Theory, "Tendency Tones and Functional Harmonic Dissonances"

### Visualization Research
- Clickstream Explorer (Stanford) — Markov chain heatmap design, finding that static plots outperform animated networks
- "The Tonnetz at First Sight" — cognitive study on human interaction with pitch spaces
- musicolors (2025) — bridging sound and visuals for creative musical experience

It's built for musicians who improvise, jam, compose on-the-fly, or just want to understand their own playing better.

### Core Ideas

- **Pattern Recognition?** — See your habitual note transitions as they emerge in real time
- **Contextual Suggestions** — Given what you just played, the heatmap lights up your most likely next moves
- **Memory & Path Tracing** — Your session is recorded as a navigable trajectory, not just audio
- **Instrument Mode** — Click cells on the heatmap to perform *through* the probability space
- **Session Export** — Save structured data (JSON/MIDI) for later analysis, composition, or replay

### What It Is *Not*

This is NOT an music generator. It does not auto-compose, auto-accompany, or MAKE DECISION FOR YOU. You remain the performer. The system provides visibility and structure.

---

## Architecture Overview

The system is a pipeline with strict separation of concerns:

```
┌──────────────┐     ┌─────────────────-─┐    ┌──────────────────┐
│  Input Layer  │───▶│ Recognition Layer │───▶│ Modeling Layer   │
│ (Audio/MIDI)  │    │ (Pitch/Note/Chord)│    │ (Markov Engine)  │
└──────────────┘     └─────────────────-─┘    └────────┬─────────┘
                                                       │
                              ┌───────────────────────-┤
                              ▼                        ▼
                    ┌──────────────────┐     ┌──────────────────┐
                    │ Visualization    │     │ Session Logger   │
                    │ (Heatmap + Path) │     │ (JSON/MIDI/CSV)  │
                    └────────┬─────────┘     └──────────────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Output Layer    │
                    │ (Instrument Mode)│
                    └──────────────────┘


```

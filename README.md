# Markov Music Heatmap

**A real-time musical pattern mirror and performable probability surface for improvising musicians.**

Inspired by:
https://www.math.utah.edu/~gustafso/s2016/2270/published-projects-2016/zhang-bopanna/zhangJie-bopannaPrathusha-MarkovChainMusicComposition.pdf

---

## What Is This?

Markov Heatmap Music Mirror is a tool that **listens to you play**, builds a live probabilistic model of your musical tendencies, and displays them as an interactive heatmap.It shows you *where you've been* and *where you tend to go next*, so you can play more intentionally.

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

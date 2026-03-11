# Gen3 — Concept Summary

Three assistants (Bass, Rhythm, Solo) accompany a player. Each has its own personality, phrase vocabulary, and awareness of whether the player is present or has left. The player also controls a Drone layer directly. The machine never competes — it only fills roles the player has vacated.

Knowledge shifts from note-level (Gen2 PPM: "after C→E, play G") to phrase-level (Gen3 lexicon: "root-fifth alternation is a bass pattern"). PPM tries stay as a scoring tool, not a generator.

Loop detection via autocorrelation on scale degrees lets the system recognize and hold repeating patterns. Ownership gating (ACTIVE / TRANSITIONING / CONTESTED / LEFT) controls when each assistant speaks.

---

## Node Tree

```
Player Input
├── PerceptionCore ──→ MusicalContext
├── TempoEngine ──→ TempoContext
├── LoopRecognition ──→ LoopHypotheses
├── BehaviorAccumulator ──→ BehaviorProfile
└── SharedPredictor ──→ PredictorField
        │
        ▼
OwnershipDetector (per role: Active / Transitioning / Contested / Left)
        │
        ▼
ContextIntegrator (merge all, loop weight capped at 0.35)
        │
        ▼
ChannelOrchestrator (dispatch role-filtered slices)
├── Bass Assistant ──→ RankedCandidates
├── Rhythm Assistant ──→ RankedCandidates
└── Solo Assistant ──→ RankedCandidates
        │
        ▼
FinalCoordinator (priority → collision → density)
        │
        ▼
Scheduler (temporal placement via TempoContext live)
        │
        ▼
OutputEngine (SoundEngine + visuals)
        │
        ▼
SelfObservation ──→ feedback to Loop / Behavior / Lexicon
```

Each assistant internally:
```
Ownership Gate
  └── if LEFT → PatternBuffer → LoopState
        └── LocalEnumeration
              ├── Tier 1: Live loop (continue/vary)
              ├── Tier 2: RoleLexicon (phrase templates)
              └── Tier 3: PPM forward sample (fallback)
                    └── NumericalEvaluator → RankedCandidates
```

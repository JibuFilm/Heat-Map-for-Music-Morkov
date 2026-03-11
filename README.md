
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

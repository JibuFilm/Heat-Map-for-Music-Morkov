# Veles — Build Roadmap

*Concrete steps from [FRAMEWORK.md](FRAMEWORK.md) to a shipped, algorithmic, lexicon‑free Veles.*

Status: v0.1 · Companion to FRAMEWORK v0.3.

---

## Ship target (definition of done)

A self‑contained, **lexicon‑free** Veles that runs in a plain browser, whose harmony **emerges from the tension world** (field + drives + walk), playing autonomously and responding to the keyboard — deployed on **jibujin.com** as a bonus instrument, fully self‑hosted (no CDN), passing the site's strict CSP.

---

## Decisions locked to start building

Defaults for the three open threads, so nothing blocks Phase 1. All tunable later.

| Thread | Locked default | Why |
|---|---|---|
| Quantify `τ` | **Symbolic** (weighted tendency ledger) | Web‑portable; the spectral sidecar is desktop‑only. |
| `Δτ` weights | `w_d = 1.0`, `w_h = 0.5` | Vertical (dissonance) leads; horizontal (distance‑from‑home) supports. |
| `β` contour | **Reactive**: `β = β₀(gravity) + k · resolution_need` | One less lane to compose in v1; a separate `β` contour is post‑ship. |
| Character | **Global pad only** (`gravity`, `volatility`) | Per‑voice offsets are a v1.1 refinement. |

Globals exposed from the start: `window.VELES = { gravity, volatility, restlessness, density }`.

---

## Part A — Engine (framework → code)

New code lives under **`src/world/`** to keep the new layer separate from legacy. Each phase has a **build / interface / done‑when**.

### Phase 1 — `TensionField` (the ledger) · *foundation*
- **Build:** `src/world/tension-field.js`. Tendency objects `{source,target,pull,urgency,type,depositor,bornAt}`; the `stickiness` table; `deposit(t)`, `discharge(pc)`, `tick(dt)` (urgency decays at `(1 − gravity·stickiness)`), `tau()`, `delta(chordA, chordB)`, `tendencies()`.
- **Interface:** `TensionField.deposit | discharge | tau | delta | tick | tendencies`.
- **Done when:** deposit a leading tone → `tau()` rises; play its target → it clears; `delta(V→i)` is negative, `delta(i→V)` positive. Driven from the console, no audio needed.

### Phase 2 — Drives + dials
- **Build:** `src/world/drives.js`. `novelty_need = ∫(τ_rest − τ)dt` at rest; `resolution_need = Σ(urgencyᵢ·ageᵢ)` over demand‑weighted tendencies. Read `window.VELES` for the dials; map `gravity` → decay/β₀/drive‑gain/tonic‑pull, `volatility` → swerve prob.
- **Done when:** held tension drives `resolution_need` up; long rest drives `novelty_need` up; turning `gravity` visibly changes decay rate.

### Phase 3 — The walk
- **Build:** `src/world/walk.js`. `P(j|i) ∝ w_map(i→j)·exp[β·Δτ(i→j)·(novelty_need − resolution_need)]`. Reuse the existing `MAJOR/MINOR_GRAMMAR` as `w_map`; `Δτ` from `TensionField.delta`; sample the next consensus chord; `β` per the locked contour; `volatility` injects the swerve (low‑prob edge → **transform** a tendency).
- **Done when:** low tension → walk explores outward; high → returns home; arcs form unprompted; `β` tightens approaching a cadence.

### Phase 4 — First cell (lead + bass) · *the proof*
- **Wire:** `LeadAssistant` deposits its Narmour implications into the field; `BassAssistant` discharges the deepest debt (root V→i) under `resolution_need`. **Remove the harmonic‑rhythm gate** for these two voices.
- **Verify:** capture via the `?render` virtual‑clock harness → soundfont render → listen.
- **Done when:** a single **create → settle** cycle is audible and breathes, with no gate and no `tension.js` overrides.

### Phase 5 — Grow the ensemble
- **Rhythm:** voice the *live tendencies* (feed `ChordVoicing` from consensus + ledger); **restore full chord voicing** (cluster passthrough — un‑break what the gate broke); settle suspensions as `resolution_need` rises.
- **Soloist:** re‑feed its candidate pool from the **field**, not a corpus — respond to the lead's deposits (intensify or discharge); keep its `leadActive` wiring.
- **Percussion:** thicken at accrual, open at discharge.
- **Done when:** four+ voices each play their re‑grounded role; a render sounds like an ensemble, not a chorale of one.

### Phase 6 — Retire the conductor
- **Delete** the blanket `playVoiceNote` gate and the `tension.js` pitch overrides; confirm their function is fully absorbed by the field + drives + per‑agent rate sense.
- **Done when:** no output‑stage overrides remain; behavior holds or improves.

### Phase 7 — Tune
- Set a default `gravity/volatility` preset by ear (A/B via render); confirm `restlessness/density` defaults; lock the presets.
- **Done when:** the autonomous default sounds intentional start‑to‑finish.

---

## Part B — Ship (deploy to jibujin.com)

- **Font:** self‑host Share Tech Mono as `woff2`, local `@font-face`; drop the Google Fonts `<link>` (satisfies CSP `font-src 'self'`).
- **Sound:** reuse the portfolio's existing soundfont/instrument path — no `gleitz` CDN, no re‑bundled samples.
- **Route + surfacing:** **DECIDE** (carried over) — hidden easter‑egg link vs. visible vs. standalone URL; pick the path (e.g. `jibujin.com/veles`).
- **Build:** extend `deploy/build.sh` to copy `veles/` → `dist/<route>/`; exclude `*.md` and dev‑only files. `render-harness.js` is a no‑op without `?render` — keep (tiny) or strip.
- **CSP:** verify `script/connect/media/font/img` all resolve to `'self'` (or the few already allowed); no new exceptions needed if self‑hosted.
- **Verify:** local `deploy/build.sh` → load the route → start + auto → confirm sound, zero console errors, clean CSP. Then push → Cloudflare Pages auto‑builds.

---

## Verification loop (throughout)

The **virtual‑clock render harness** (`render-harness.js`, `?render`) is already built: it drives the real engine deterministically, captures the true note schedule free of headless throttling, and renders it through the soundfont for listening. Use it as the test rig at every phase.

---

## The ship line

**Minimum shippable = through Phase 5** — the world is live, the walk drives it, and the re‑grounded ensemble sounds good. Phases 6–7 (cleanup + tuning) can land in the same push or immediately after.

At ship, the dials are **console knobs** (`window.VELES.gravity = …`); a visible **character pad** UI is a post‑ship enhancement.

A leaner fallback exists if we want to ship sooner: the *current* build (grammar‑primary + `tension.js`) already renders coherent functional harmony and could go out as a v0 while the tension world is built behind it — but it ships the patches the framework says to retire, so it is a stopgap, not the destination.

---

## Sequence at a glance

```
Phase 1 TensionField ─┐
Phase 2 Drives+dials  ├─ engine core (console-testable)
Phase 3 Walk ─────────┘
Phase 4 First cell (lead+bass) ── first sound, gate off
Phase 5 Grow ensemble ────────── SHIP LINE
Phase 6 Retire conductor
Phase 7 Tune
Part B  Font · sound · route · build · CSP · verify · push
```

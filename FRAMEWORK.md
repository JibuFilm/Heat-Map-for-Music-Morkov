# Veles — The Tension World

*A framework for emergent harmony in a decentralized ensemble (zero‑style‑bias build).*

Status: design draft, v0.3 · Scope: the autonomous, lexicon‑free Veles built from `gen3`/v9.

---

## 0. The turn

Veles began as imitation. The lexicons carried real music; the agents' job was to *find the phrase that fits.* Style — and, hidden inside it, tension — was inherited from a corpus.

We have removed the corpus. That decision is not a subtraction of intelligence; it is a change of **physics**. Without a corpus to imitate, the music can no longer be *retrieved* — it has to *arise*. And for it to arise, the theory we are putting in its place cannot sit above the ensemble as a conductor, dictating chords. It has to become **the world the agents live in**.

This document defines that world and re‑derives the agents as inhabitants of it.

Two commitments frame everything below:

- **Zero style bias.** No corpus, no genre. The only knowledge in the system is general harmonic *force* — tendency and resolution — not particular harmonic *vocabulary*.
- **Emergence over imposition.** Harmony is not chosen for the ensemble. It is the running trace of agents navigating a shared landscape under opposing pressures. No conductor.

A consequence we must take seriously: **agent and world co‑constitute each other.** The intents already written into the players (bass anchors, rhythm voices chords, lead carries melody, soloist responds to the lead) were fitted to the *old* world — corpus material and a generic tonal backdrop. They cannot simply be dropped into the new physics. The roles survive; their **grounding** must be rebuilt. The good news is that the old world was *underdetermined* — the intents had to stay vague ("fit the harmony") and lean on the lexicon for specifics. The new world is **more** determined. The agents can therefore be made *sharper*, not vaguer.

---

## 1. Where theory lives

In an imposed system, theory is a selector that picks the next chord. In an emergent system, theory lives in three places, none of them above the agents:

1. **The field** — the shared medium every agent perceives. Theory here is *what the world feels like*: how far the current sonority is from rest, what is owed a resolution, which way the harmony is leaning.
2. **The drives** — gradients that move the agents. Theory here is *appetite*: rest breeds the pressure to disturb; disturbance breeds the pressure to resolve.
3. **The agents' local sense** — each voice's bias when it acts. Theory here is *taste*: the lead's melodic implication, the bass's functional pull, the rhythm's voicing instinct.

If theory only ever lives in (1)–(3), the ensemble cannot be *conducted*, only *inhabited*. That is the whole design.

---

## 2. The shared world (the field)

The field is the state every agent reads each tick. It is the new medium of coordination. Its primitives:

- **Consensus chord** `{root, quality}` — the harmony the ensemble currently agrees it is in. Not imposed by a planner; the running result of the intentional layer (see §8). *(v9 organ: `ChordBelief`.)*
- **Key & mode** `{tonic, mode}` — the tonal frame. Determines where "home" is and which tendencies are diatonic vs chromatic.
- **Tension scalar** `τ ∈ [0,1]` — the single felt quantity. `0` = rest (the sonority is fully resolved over the consensus chord, near the tonic); `1` = maximal instability. `τ` is *not* set by a rule; it is **read off the ledger of outstanding tendencies** (§4).
- **Outstanding tendencies** — the core new primitive. A live set of **owed resolutions**, each `{pitch, target, urgency, depositor}`. A leading tone deposits `B → C`; a sounding seventh deposits `F → E`; a suspension deposits `4 → 3`; a chromatic approach deposits its half‑step pull. Tendencies are *deposited* when sounded and *discharged* when resolved. They are the debts of the world.
- **Trajectory** `{dτ/dt, tonicDistance}` — whether the ensemble is currently *accruing* tension or *settling* it, and how far it is from home. This, not the static chord, is what the ensemble must agree on.
- **Tonic gravity** — a standing pull toward home that grows the longer the tonic is absent. *(v9 organ: the Krumhansl tonic‑reinforcement bias already in `harmonic-planner`.)*
- **Phase & meter** — where we are in the bar and how locked the pulse is. *(v9 organ: `PhaseCoupling` / Kuramoto.)*
- **Energy & density** — how active the ensemble is. An *output* of the drives, not an input timer.
- **Published intents** — each agent's posted "where I am heading," readable by the others. *(v9 organ: `ChordBelief.publishIntent` / `getConsensus`.)*

The field is deliberately small. Everything else — melody, voicing, groove — is what the agents *do* with it.

---

## 3. The drives

Two opposing gradients, computed from the field, felt by every agent:

- **`novelty_need`** rises while `τ` stays low — the longer the world sits at rest, the stronger the pressure to deposit a tendency (introduce motion).
- **`resolution_need`** rises with `τ × time‑held` — the longer and higher the tension, the stronger the pressure to discharge.

Their opposition *is* the phrase. Rest accrues novelty‑pressure until some agent disturbs it; the disturbance accrues resolution‑pressure until the ensemble settles it; settling returns to rest. **Nobody schedules the cadence — the field demands it.** The energy arc we kept reaching for is not a `SectionTracker` clock; it is this oscillation made audible.

*(v9 organs: the belief needs already include `surprise` and `resolution`. We are giving them a **slope** and a **shared cause**, instead of letting them drift.)*

---

## 4. The tendency economy

This is the mechanism that makes voice‑leading **emergent rather than ruled**.

- **Deposit.** When a voice sounds a pitch with a tendency — a leading tone, a chord seventh, a suspension, a chromatic approach — it writes that debt into the field. The sonority now *owes* a resolution.
- **Discharge.** Any agent can settle a debt by playing its target (leading tone → tonic, `7 → 3`, `4 → 3`). The debt clears.
- **`τ` is the balance of the ledger** — outstanding debts, weighted by urgency. Tension is literally unsettled accounts.

Three things fall out of this for free:
- **Voice‑leading is no longer a rule we enforce** — it is the natural settling of debts by whichever voice is positioned to settle them.
- **Tension is relational.** It is highest when the lead has deposited a pull the bass has not yet honored — *the disagreement is the tension* — and it falls as the ensemble converges to discharge it.
- **Dominants matter again.** A functional V is just a large, urgent deposit (leading tone + seventh = the tritone). The pull to I is the field demanding discharge. (This is what the temporary `tension.js` layer was faking by overriding pitches; in the new world it is intrinsic.)

---

## 5. The walk — and the three scales

The map is the space of harmonic moves; the music is a **walk** across it. But the walk must be neither a uniform random walk (the aimless drift of the raw graph) nor a fixed functional sequence (a script with no suspense). It is a **probabilistic walk biased by the drives** — alive enough to differ every traversal, directed enough to build and release.

The system runs on **three scales**, each with its own clock and mechanism, which is why they never fight:

- **Macro — the walk.** *Which harmonic region next.* Slow (a move per bar/phrase). The trajectory across the map; the drives shape its probabilities.
- **Meso — the tendency economy (§4) and the agents (§7).** *How the current node is inhabited* — voiced, its debts deposited and discharged, lead and soloist conversing. Medium (per note/phrase).
- **Micro — Kuramoto.** *Exactly when each note lands* — the breathing of the pulse, the desync/resync texture. Fast (sub‑beat). *(v9 organ: `PhaseCoupling`.)*

Kuramoto is the micro‑texture and **only** the micro‑texture; it never touches harmony. The walk is the macro‑harmony and never touches timing. The agents live in between — realizing the node the walk has reached, in the time Kuramoto grants them. Three rates, one organism.

**The walk's law.** At each macro step, the next node `j` is sampled from the current node `i`'s neighbours on the map:

```
P(j | i)  ∝  w_map(i→j) · exp[ β · Δτ(i→j) · (novelty_need − resolution_need) ]
```

- `w_map(i→j)` — the functional grammar weight: the prior, the map's own pull.
- `Δτ(i→j)` — how much the move would *raise or lower* tension (deposit tendencies / leave home, vs discharge / return).
- `(novelty_need − resolution_need)` — the drive balance (§3). When novelty dominates, tension‑*raising* edges gain probability (the walk leans outward, off rest); when resolution dominates, tension‑*lowering* edges gain probability (the walk is drawn home).
- `β` — the **temperature** of the walk: how sharply the drives load the dice.

The trajectory is therefore *sampled, not chosen*, and the sampling weather changes with the tension state. The walk wanders out under novelty‑pressure and is pulled home under resolution‑pressure — and because those pressures oscillate (§3), the path forms arcs **on its own**. That is the music walking onto the map.

**Why "probabilistic" is itself tension.** There are two tensions, not one:

- **Vertical** — the dissonance ledger (§4): the *sound* is unresolved.
- **Horizontal** — the *uncertainty of the next step*: we cannot know where the walk will go. (Huron's ITPRA, which Veles already cites, locates much of felt musical tension exactly here — in prediction and its violation.)

A deterministic progression has no horizontal tension: you know it resolves, so the resolution means little. A probabilistic walk keeps the next move genuinely uncertain, and *that uncertainty is felt as tension*, discharged when the move finally lands. So `β` is a **second tension knob**: **low `β` approaching a peak** — loose dice, anything could happen, maximal suspense; **high `β` into a cadence** — the landing becomes near‑obligatory, suspense collapses into arrival. Modulating `β` *is* shaping the horizontal tension of the phrase.

**The walk is not above the agents.** It would be a conductor if it dictated; it does not. The agents write to the same field the walk reads: when the lead deposits a strong tendency (implies a secondary dominant), it raises `Δτ` on the edges leading that way and biases the walk toward them. The ensemble **nudges its own trajectory from below.** The walk is just the slow consensus of where the agents are collectively leaning, sampled — macro and meso are one negotiation read at two rates.

---

## 6. The dials — the control surface

Everything above is physics; this is how you **steer** it. The whole world reduces to **two master dials** plus a shape table — read off the field, performable in real time, automatable over the form. They are where the music's *character* lives, which is why they belong in the world (the field), not buried in each agent.

### The shape: tendency stickiness

The decay‑vs‑demand question is not a fork to settle — it is a **table to weight.** Each tendency type carries a `stickiness ∈ [0,1]`: its intrinsic resistance to fading.

```
leadingTone .95   seventh .85   suspension .80   appoggiatura .60   chromatic .40   passing .20   neighbor .20
```

This is the *shape* — the relative insistence of the harmonic vocabulary. It is fixed (it is just what these tendencies are); the dials set the *level*.

### Dial 1 — `gravity`  (floating ↔ functional)

How hard the world insists on resolution. A tendency's urgency decays at a rate proportional to `(1 − gravity · stickiness_type)`:

- `gravity → 1`: even a passing tone starts to insist; the leading tone effectively **demands** (no decay). Tonic pull strong, `β` tight (resolutions near‑obligatory), drives sharp. Goal‑directed, cadential.
- `gravity → 0`: even the leading tone melts before it resolves. Tonic pull weak, `β` loose, drives soft. Tendencies *dissolve* rather than resolve — floating, impressionistic.

One number slides the whole field between *insisting* and *letting go*, with the vocabulary's shape preserved at every position. `gravity` also scales tonic‑gravity strength, the base `β`, and the drive gain.

### Dial 2 — `volatility`  (predictable ↔ surprising)

How often the walk **swerves** — takes the low‑probability edge, choosing the **transform** fate (re‑point a tendency at a new target) over discharge. Drives the swerve probability and loosens `β`.

`volatility` is *orthogonal* to `gravity` on purpose: there is a region one dial cannot reach — **insistent *and* surprising** (a deceptive cadence is fully functional *and* a shock). Two axes are the minimum that covers it.

### The 2‑D character pad

```
                     volatility →
          ┌──────────────────────────────┐
  gravity │  functional & shocking       │   insists, then swerves    (Romantic / deceptive)
    ↑     │  functional & plain          │   resolves, predictable    (chorale)
          ├──────────────────────────────┤
          │  floating & still            │   drifts, stable           (modal / drone)
          │  floating & free             │   dissolves, unpredictable (impressionist)
          └──────────────────────────────┘
```

The corners land on recognizable harmonic *worlds* without imitating any of them — it is just where the physics settles. And because the pad is two numbers on the field, it is **performable**: a player or an automation lane can move it *over the form* — float in the intro, slide toward high `gravity` for the climax, one swerve at the turn. Character becomes a gesture, not a setting.

### Deeper panel (optional, under the masters)

Two more knobs refine *rate* without changing the pad's character; the masters can preset them:

- `restlessness` — how long the world tolerates rest before `novelty_need` forces a deposit (patient ↔ urgent). Sets the *period* of the drive oscillation — the breath length.
- `density` — how many tendencies the agents deposit per unit time (still ↔ busy). Sets the *thickness* of the texture independent of its tension.

A single `gravity, volatility` pair is enough to play; the deeper panel is there when a passage wants its breath or thickness shaped against the grain of its character.

---

## 7. The agents, re‑grounded

Each agent is redefined as **a way of perceiving and acting on the field.** The role topology is unchanged — the *grounding* moves from corpus to field. For each: what it reads, what it wants, how it acts.

### Bass — *the ground*
- **Reads:** consensus chord, tonic gravity, `resolution_need`, phase.
- **Intent:** be the reference against which all tension is measured; hold the tonal floor.
- **Acts:** sustains the root/fifth of the consensus; rarely deposits; discharges the **deepest** debt (root motion V→i) when `resolution_need` peaks. It is the voice that *grounds* a resolution, the last word of a cadence.
- *(v9 organ: `BassAssistant` 3‑state machine — re‑point GROOVE from "loop a lexicon phrase" to "pedal the consensus root, anchored to phase.")*

### Rhythm — *the body of the tension*
- **Reads:** consensus chord, outstanding tendencies, `τ`, density.
- **Intent:** make the field's current tension **audible** — voice not a generic chord but the chord *with its live debts*.
- **Acts:** voices the consensus including whatever tendencies the field is holding (the seventh, the suspended fourth, the leading tone); settles suspensions as `resolution_need` rises. Its richness is the field's tension made into sound.
- *(v9 organ: `RhythmAssistant` v9.1.0 is already a chord‑voicing voice — feed `ChordVoicing` from the consensus + active tendencies instead of rhythm archetypes alone. **And stop gating its chord into a single note** — the blanket output gate must go, see §9.)*

### Lead — *the engine of motion*
- **Reads:** consensus chord, key, `novelty_need`, its own melodic line.
- **Intent:** create forward motion — propose where the harmony could go next.
- **Acts:** the primary **depositor.** Its melodic implication (Narmour: a played interval implies an unplayed continuation) is, formally, a deposited debt — it sounds a tendency that pulls toward a new chord. When `novelty_need` is high, it leans harder, implying secondary dominants, chromatic approaches, modal shifts.
- *(v9 organ: `LeadAssistant` "Deliberative Melodist" + `melodic-expectancy` (Narmour I‑R). The Narmour model *is* a tendency generator; wire its implications into the field as deposits.)*

### Soloist — *the respondent*
- **Reads:** the lead's deposits, `τ`, peer activity (it already watches `leadActive`).
- **Intent:** answer — converse with the lead over the shared debts.
- **Acts:** reads what the lead has deposited and either **intensifies** (adds a complementary tendency, raising `τ`) or **discharges** (resolves the lead's implication, releasing it). Call‑and‑response becomes the trading of debts. With no human, the lead is its partner; the field is what it listens to.
- *(v9 organ: `SoloAssistant` "Prediction‑Reaction Soloist." Its candidate pool was corpus‑fed and starves without it — re‑feed the pool from the field: motif responses to the lead + Narmour lines over the live tendencies, not lexicon phrases.)*

### Percussion — *the pulse* (secondary)
- **Reads:** phase, energy, trajectory.
- **Intent:** carry meter; mark the swings of the drive oscillation.
- **Acts:** thickens at accrual, opens at discharge — articulating the arc without touching the harmony.

### The player — *the sixth voice* (when present)
- A human note is a deposit like any other. The ensemble reads the player's tendencies and responds in the same economy — no special path, no authority. The decentralization is preserved.

---

## 8. Coordination

The old consensus was over a **state** ("what chord are we on"). The new consensus is over a **trajectory** ("are we accruing or settling, and toward where").

The mechanism already exists: `ChordBelief`'s intentional layer lets each voice publish where it is heading and read the weighted consensus of its peers. We re‑purpose it from voting on a chord to voting on a *direction*. Tension then has a precise definition at the coordination level: **the spread of intents.** When the lead intends a new chord and the bass intends home, the intents disagree — that spread *is* `τ` at the social level — and it falls as the agents converge. Consensus is not unison; consensus is the *resolution* of a spread the agents themselves opened.

This is why there is no conductor and why the result can still cohere: the agents are not following a score, but they are all reading and writing the same ledger.

---

## 9. Mapping to the current build

**Reuse (the organs are already there):**
- `ChordBelief` (evidential + intentional layers) → the field's consensus + the trajectory medium.
- Belief needs `surprise` / `resolution` → the two drives (give them slope + shared cause).
- `melodic-expectancy` (Narmour I‑R) → the lead's deposit generator.
- `PhaseCoupling` (Kuramoto) → phase/meter.
- `chord-voicing` (shell/close/drop2/open) → the rhythm's realization of consensus+tendencies.
- Tonic‑gravity bias in `harmonic-planner` → the field's tonic pull.

**Build new:**
- `TensionField` — the ledger of outstanding tendencies, `τ`, and trajectory. The single shared object every agent reads/writes.
- The two **drive gradients** wired into the belief state.
- Re‑grounded **agent perceptions** (read the field, not the corpus).

**Retire (the conductor):**
- The blanket **harmonic‑rhythm gate** in `playVoiceNote` — it homogenizes the voices and collapses the rhythm's chords into single notes. Its *function* (don't machine‑gun) is absorbed by the drives + each agent's own rate sense.
- The **pitch overrides** in `tension.js` — faking tension by forcing notes. In the new world tension is intrinsic to the ledger; the agents deposit it themselves.

**Keep, but as a knob, not a crutch:** the functional `MINOR_GRAMMAR`. In the new world the grammar is each agent's *bias* over candidate moves, not a global selector. The dominant's pull comes from the tendency it deposits, not from the grammar boosting a chord id.

---

## 10. Open questions

*Resolved in v0.3 (§6): decay‑vs‑demand is no longer a fork — it is the stickiness shape scaled by `gravity`. "Where character lives" is answered — in the field, as the two dials, with each agent keeping only local taste. New questions §6 raises: the exact `Δτ` weights (`w_d`, `w_h`); `β`'s contour (purely reactive to `resolution_need`, or an independently composed shape); whether per‑voice character offsets layer over the global pad.*

The decisions still genuinely open:

1. **Quantifying `τ`.** Purely symbolic (count + weight outstanding tendencies) or also perceptual (the Swift spectral‑roughness sidecar already computes real dissonance)? Symbolic is portable to the web; the sidecar is richer but desktop‑only.
2. **Tendency dynamics.** Do debts **decay** if unsettled (tension that fades) or **demand** until paid (tension that must resolve)? Probably a mix, by type — a leading tone insists; a passing dissonance fades.
3. **Global vs per‑agent drives.** One shared `novelty/resolution` pressure, or each agent with its own threshold (the bass patient, the lead restless)? Per‑agent thresholds are where *character* lives.
4. **The dissonance vocabulary.** Which tendencies count — strictly functional (leading tone, 7th, susp), or extended (9ths, modal color, planing)? This is the one place "taste" enters; keeping it functional preserves zero‑style‑bias most strictly.
5. **How much taste in the agent vs the field.** The cleaner the field, the more the *character* must live in the agents. Where do we want the personality — in the world's physics, or in how each voice plays it?
6. **The player's leverage.** A human deposit is equal to an agent's — but should it be *weighted* (the ensemble leans toward the human) without becoming a master? Decentralization says equal; playability may want a thumb on the scale.

---

## 11. First cell (when we move to build)

To test the world before populating it: implement `TensionField` (ledger + `τ` + trajectory) and the two drives; re‑point only the **lead** (deposit via Narmour implication) and the **bass** (discharge the deepest debt under `resolution_need`); remove the gate; and listen for a single **create → settle** cycle that breathes on its own. If one cell lives, grow it voice by voice — rhythm, then soloist, then percussion.

---

*The aim is not a system that plays correct harmony. It is a world whose physics is harmonic tension, populated by voices whose only knowledge is how to lean and how to let go — and music as the trace of them doing it together.*

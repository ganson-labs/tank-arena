# Чемпион-реплика — dev notes

Sparring replica of the champion described in CONCEPT.md → «Кто соперник». Own code, independent of `tank/`.
Published snapshot: `lab/sparring/champ/` (bot.js + physics.js + body.svg + turret.svg). Dev copy: this folder.
Past snapshots for regression matches: `v1/`, `v2/`, `v3/`, `v4/` (runnable bot folders; `v4` = currently published).

Stats: armor 0, engine 0, gun 5, reload 5 (HP 100, speed 110, bullet 700, damage 43, reload 0.5 s).

## What is implemented (vs the description)

| Champion trait | Replica |
|---|---|
| Exact engine physics inside | `physics.js`: tank step with walls and the double wall-resolve (speed x0.6 per bumping call), bullets with substeps, one ricochet, lifetime (ages tracked per bullet id), clashes at end of tick (<12 px), muzzle spawn/blocked muzzle. `verify.mjs`: 0 mismatches on 355k tank steps, 364k bullet-ticks (9k ricochets, 145 clashes, 531 tank hits), 5000 shots. |
| Several hundred manoeuvres ~1.2 s ahead, every tick | 9 first actions (throttle -1/0/1 x turn -1/0/1) x 8 switch times {1,2,4,6,9,13,18,24} x 8 second actions + 9 "hold" plans + the previous plan shifted = 586 plans x 36 ticks (1.2 s). Shared prefixes; budget 12 ms with a check every 8 plans; the previous plan's branch is evaluated first. |
| Cost: every flying bullet incl. ricochets and own bounced bullets | All bullets simulated exactly for 36 ticks (walls, bounce, lifetime, clashes between existing bullets); exact per-substep hit test against each plan; own bullets count only after they bounced. Hit cost grows for early hits, extra for a lethal hit. |
| Zone, kits, distance in the cost | Zone damage per tick outside + depth, end-of-plan zone penalty, edge-hugging penalty during the shrink; kit pickup bonus (heal value + denial of a wounded enemy); distance: hard-ish penalty inside the enemy zone, soft (capped) term toward the desired distance. Navigation: Dijkstra field (20 px cells) to the goal point, counted at mid and end of plan. |
| Pre-emptive dodge by the enemy reload timer | Enemy ready tick computed exactly from `enemy.reloadLeft`. At that tick and at 3 later ticks while it holds fire: (a) readiness = lateral width of the set of points reachable during the bullet flight (sideways factor x forward/backward reach from the current speed, clipped by room to walls), wanted >= 88 px; (b) an imaginary LINEAR-LEAD bullet fired at that tick (quadratic lead with muzzle offset), counted as a hit at the real 29 px radius (a +12 px margin made it unavoidable at 300-400 px and therefore useless; v4 with ~0 margin beat v3 42-16-6); (c) hard ban inside the radius where even perfect jinking loses to linear lead (34 + v_b*sqrt(2*29/420) + 20). All only when the enemy has line of sight. |
| Two physics distances; stay outside the enemy's zone; kill race; close only when enemy more wounded | `noDodge(v_b, v_max)`: target at rest sideways must clear 29+13.3 px with accel 420, 1 tick reaction, muzzle 34 px: 700 vs 110 -> 416, 700 vs 220 -> 370, 550 vs 110 -> 336. Hold: want = Ze + 40 (between the zones if Zm is larger), min = Ze + 10. Close mode when my time-to-kill + one reload < its time-to-kill AND its HP fraction is lower: want = min(Ze, Zm) - 20. |
| End phase: behind -> close in, ahead -> hide | Last 22 s: behind on HP fraction -> chase (want 160); ahead -> goal search picks points WITHOUT line of sight inside the circle. |
| Shrinking zone, distance fitted to the circle | want/min capped so that both tanks fit well inside the circle 3 s ahead; goal candidates only inside the future circle. |
| Aim: ~10 hypotheses, most weighted coverage | 10 hypotheses: "continue as it goes" (throttle/turn estimated from the last tick) + 9 constant throttle x turn, simulated with exact physics for 60 ticks. Candidate angles (intercepts, weighted mean, sweep, bank angles) are scored by an exact bullet flight against all hypotheses; weighted coverage. |
| Weights learn from misses, persist between rounds | At the arrival tick of every shot each hypothesis is checked: would it have been hit (within 29 px of reality)? Score EMA 0.93/0.07, module-level (survives rounds, per module instance). vs dummy "continue" rises to ~0.75, the rest fall. |
| Low fire threshold, ~2 shots/s | Fires when the best angle reachable this tick covers >= 10% of the hypothesis weight (and is not much worse than the global best). About 1.7 shots/s while the enemy is coverable. |
| Bank shots via every wall face and the border | Enemy future position mirrored in each face (walls + border, offset by bullet radius), reflection point must lie on the face, verified by the exact bullet sim. vs hunter ~30% of hits are ricochets (champion: ~20%). |
| Interception | If the chosen plan is still hit by a bullet: scan the angles reachable this tick, exact flight of my bullet vs the threat's tick-end positions (clash < 12 px at end of tick before the hit); while reloading, the turret is pre-rotated to the interception solution. |
| Self-protection: no shot whose ricochet can come back | Every shot is simulated for its full 4 s life; if after the bounce it passes within 29+22 px of my planned position (corridor widens up to +60 px beyond the plan) the shot is not fired. |
| Kits: when worth it and to deny | Goal = kit if my deficit >= 30 and I arrive first, or the enemy's deficit >= 40 and I arrive not later; kit must be inside the future circle. |

Extra (not in the description, needed to make it work in these maps): approach point when the enemy
closes in without line of sight (goal against the point it will emerge from, turret pre-aimed there);
bonus for line of sight at my own ready ticks (otherwise the exposure costs make both copies hide).

## Known gaps / simplifications
- The imaginary shot is only linear lead (as described); no "centre of reachable set" imaginary shot.
- Tank-tank pushing is not modelled in the planner (only matters at < 60 px).
- Hypotheses ignore that the enemy starts reacting after seeing my bullet.
- Bank shots are generated for 3 representative hypotheses (continue, best-weight, stop), then scored against all 10.
- ~20% of hits taken in mirror play were not foreseen when the bullet first appeared: almost all are long ricochet flights that start beyond the 36-tick horizon (not planner traps); the rest were unavoidable when fired.
- No randomisation among near-equal plans (the champion description does not mention it); runs differ only through learning and time-budget cut-offs.
- A rare self-hit remains (about 1 per 100 rounds vs its own versions): a ricochet returning after ~3 s when the real position has left the planned corridor.

Also in the code but OFF by default: an analytic "can I get 29+12 px away from the linear-lead aim point" readiness term (`LIN_W`, `TUNE.linW`) — it improved the dodge vs an exact lead shooter at 400-450 px (9% -> 3%) but made the bot easier to hit for the champion-style aim (24-33 vs v3); the plain imaginary shot with 0 margin gives 3.5% there anyway.

## Dev-only switches
`globalThis.__CHAMP_TUNE = {...}` before loading (e.g. `node --import "data:text/javascript,globalThis.__CHAMP_TUNE={noFire:true}" ...`):
`noFire` (dodge-only tests), `virtM`, `linW`, `readyW`, `needM`, `hardW`, `hardM`, `dMinW`, `shotW`, `close`. Tournament/CLI runs never set it.
`testbots/lead/` — exact linear-lead shooter (champion stats, `globalThis.__LEAD_DIST` band) for dodge tests.

## Version history
- v1: first publish — planner, aim, bank, intercept, self-protection, distance policy. 16-0 vs hunter, but hunter 5-8%, stuck behind walls in the mirror (nav-field leak through walls fixed before publish).
- v2: approach point vs enemies coming round corners (hunter 5.5% -> 1-1.4%), LOS bonus at own ready ticks, readiness only with LOS, no procrastination (capped soft distance term, mid-plan progress).
- v3: zone: distance capped so both fit well inside the circle, edge-hugging cost (zone deaths gone); self-protection over the bullet's life; budget checks every 8 plans; fewer allocations.
- v4: imaginary linear-lead shot graded/at the real hit radius; analytic linear term off. 42-16-6 vs v3 (their accuracy on it 1.48% vs 2.07%).

## Test results (v4 unless noted; Node 26, Apple M5 Max)
- `node arena/cli.mjs lab/sparring/champ --vs hunter --rounds 16`: 16-0, damage taken 0, own accuracy 37%, tick avg 2.6 ms, max 16.7 ms.
- `--vs dummy --rounds 8`: 8-0, damage taken 0, accuracy 32%, tick avg 2.4 ms, max 14.4 ms.
- Hunter, jittered starts: v3 128/128 wins, hunter accuracy 1.66-1.76% (all its hits from < 300 px); v4 16/16 with hunter 0/47.
- Hunter shot forensics (v2+): every hit taken was already unavoidable when fired (planner model exact, 0 surprises); hits only from < 350 px.
- Exact linear-lead shooter, replica not firing (v4 config): shots fired from 450+ px hit 1/389; 400-450 px 3.5%; inside ~400 px (the champion's own no-dodge zone vs 700 px/s, 416 px) up to 20-60% — physics limit, the champion stays outside it.
- Mirror / own versions (64 rounds, jittered): v4 vs v3 42W 16L 6D; accuracy both ways 1.5-2.1% ("zero to a couple of percent"). Rare self-hit (~1 per 100 rounds). Zone deaths: none after v3.
- Timing: alone in mirror play avg 2.6 ms, p99 4 ms, max 12.9 ms; under heavy parallel CPU load spikes up to 30-50 ms were seen (planner budget 10 ms, aim budget 20 ms bound the work, not GC/scheduler pauses).
- `verify.mjs`: 0 mismatches (tanks, bullets incl. ricochets/clashes/lifetime/tank hits, firing).

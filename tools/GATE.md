# tools/gate.mjs: bot regression gate

`tools/smoke.mjs` answers "does the page load with 0 errors". `tools/gate.mjs` answers "does the game still play as
well as before, and can a phone reach its buttons". It exists because on 9 Nov an unreviewed commit made arrows do
0 damage to armoured enemies: the bot fell from wave 15 to wave 8 and smoke stayed green.

## What it checks

1. **sim**: loads the build in headless Chromium with `?auto&debug`, holds `requestAnimationFrame` so wall-clock
   frames cannot advance the game, calls the game's own fast-forward hook (`hisarSim(1260)`) and reads the metrics.
   With `GAME.sim.seeds` set, every build runs once per seed (`&<seedParam>=N` appended to the query) and the
   metrics are summed over the seeds (numbers added, booleans ANDed, strings joined with `/`). The candidate's first
   seed runs twice; different numbers mean the sim is not deterministic and the gate fails (a comparison would be
   meaningless). The base runs once per seed (skipped when it is byte-identical to the candidate). Each summed metric
   is compared with its tolerance (`abs` units or `rel` fraction it may drop, `max` ceiling, `info` not gated).
   `GAME.sim.noNewZero` then checks every seed unit by unit (one character of a per-unit string such as `perShift`):
   a unit that is zero, or was never reached, on the candidate fails when the base had it above zero. A sum can absorb
   one stalled level; this check cannot. Without `seeds` the gate makes one run per build, as before.
2. **layout**: at 390×844, 360×740 and 412×915 with `isMobile` + `hasTouch`, every visible element matching
   `GAME.layout.selectors` must be inside the viewport and be what `elementFromPoint` returns at its centre.
3. **console**: every run (sim and layout) must have 0 page errors, 0 console errors and 0 failed requests.
   Analytics and Google Fonts are answered with an empty 200, as in smoke.

Output: `ok` / `FAIL` / `KNOWN` / `note` lines, then `RESULT OK|FAIL`, exit 1 on FAIL. `GATE_JSON=<file>` also writes
a JSON report.

## Running

```sh
node tools/gate.mjs                       # base = origin/main:index.html, candidate = working tree
node tools/gate.mjs --base <ref>          # any git ref
node tools/gate.mjs --baseline            # base = tools/gate-baseline.json (no git base needed)
node tools/gate.mjs --record              # write tools/gate-baseline.json from the working tree (main, or a baseline change)
node tools/gate.mjs --rebaseline          # CI for a PR that changes tools/gate-baseline.json (see "Baseline changes")
node tools/gate.mjs --candidate x.html    # test a scratch build without touching index.html
node tools/gate.mjs --only sim|layout
node tools/gate.mjs --strict-layout       # KNOWN layout offenders fail too
SMOKE_CDN_DIR=<npm package dir> ...       # serve three.js from a local copy (no CDN access)
```

Assets (models, images) always come from the working tree; only the entry HTML differs between base and candidate.
Runtime here (4 cores, shared, load average 25-35): 40-80 s per sim run; a full gate is about 4.5 min when the base is
identical (2 sim runs) and up to 9 min with a different base (3 sim runs); `--baseline --only sim` about 3 min.
Timeouts are generous and print as `infra: … timed out` (still a FAIL, never a pass); a whole-run watchdog stops at
15 min. CI runs it as the `gate` job in `.github/workflows/smoke.yml` (PR: base = `HEAD^1`, the base
branch; a PR that changes `tools/gate-baseline.json`: `--rebaseline`; manual run: `--baseline`).

## Baseline changes

Sometimes a PR makes the old numbers incomparable on purpose, e.g. a fix that changes which random numbers every later
part of a run receives. The base branch's build would then "fail" on noise that the PR removes. Such a PR re-records
`tools/gate-baseline.json` (`--record` on the PR branch, after merging its base) and commits it. CI sees the changed
file and runs `--rebaseline` instead of `--base HEAD^1`:

- the base branch's build is not played; a `::warning` annotation and a `BASELINE CHANGE` note say so;
- the committed baseline must have been recorded from this very build (`entrySha` = the candidate's entry file), or
  the gate fails;
- the candidate must reproduce the recorded per-seed numbers exactly, or the gate fails (this also re-checks
  determinism on the CI machine).

The gate cannot judge such a PR; the reviewer does. The PR body must show the old and new per-seed numbers and the
reason. Never re-record to turn a red gate green: a baseline change goes in its own PR with no gameplay change.

## This game (bogaz-vapuru)

Ported from kale-savunmasi's `tools/gate.mjs` (only the `GAME` block differs). The timing paragraph above is
kale's; here one sim run takes 30-60 s, so a PR gate (5 base + 6 candidate runs + layout) takes about 10 min and
`--baseline` about 5 min. The CI job allows 30 min, the script's watchdog 25.

- **sim**: `?auto&cal&noaudio`. `?auto` starts the captain bot and the campaign at boot; `?cal` plays all 8 shifts
  once in order (no retries), so every shift's result counts. `window.vapurSim(16000)` steps `botTick` + `stepSim`
  at 1/30 s and stops at `G.done`; gameplay RNG is `mulberry(SEED + shift*97 + retries)` (`?seed`, default 11),
  reseeded at every shift start, the world RNG is `mulberry(2024)`, the cosmetic RNG (gull sound timer) is
  `mulberry(SEED + 7)`. `Math.random` is used only in audio. The budget was 8000 s until 12 Nov; after the
  shift-independence fix three campaigns ran out of game time inside shift 8 (seed 1 at t=1146 s, seed 2 at 831 s,
  seed 3 at 1415 s) and the gate counted those shifts as lost although they were still being played.
- **shift independence** (12 Nov): every shift's result depends only on the build, the seed and the shift number.
  Before, the gull sound timer drew from the gameplay RNG and was never reset, and the autopilot carried its state
  over; so how one shift ended shifted every random draw of the next, and any change to one shift re-rolled all
  later shifts of that seed (a change with no effect on play moved main from 108★ to 96★ with 5 new 0★ shifts).
  Check: started directly with `?shift=k`, each shift gives the same stars and score as inside the full campaign
  (seeds 11/1/2/3/4, k = 2..8, all equal); on 07fb6d6 every seed differed. A PR that changes one shift now changes
  that shift's numbers only, so noNewZero points at the shift the PR really broke.
- **seeds** (12 Nov): `[11, 1, 2, 3, 4]`. With one seed the gate measured noise: on PR #14 a single commit moved
  seed 11 from 23★ to 21★ while seeds 1-4 went up, and the reverse happens too; a stall on seed 4 (0 shifts
  finished) was invisible because only seed 11 ran. Seed 11 stays first and is the one replayed for determinism.
- **metrics** (sums over the 5 seeds): `shifts` (may not drop; 5 × 8 = 40 when every campaign ends), `stars` (may drop 10 %), `score` (may drop
  10 %), `perShift` (stars per shift per seed, info), `gameErrors` (max 0). **noNewZero** on `perShift`: on any seed,
  a shift at 0★ (or not reached) on the candidate fails unless it is 0★ (or not reached) on the base too. Shifts
  that the base already loses do not block a PR; a newly lost one does, even when the sums pass.
  **Baseline since 12 Nov** (shift independence, budget 16000 s), seeds 11/1/2/3/4: stars 21/21/20/18/20 = 100,
  score 18637/17060/17110/13174/16288 = 82269, perShift 33333033/33333033/33333131/33333030/33333032, 40 shifts.
  Lost on the base (do not block): seed 11, 1, 3, 4 shift 6 and seed 3 shift 8.
  Before (07fb6d6, shifts chained, budget 8000 s): stars 23/19/22/24/20 = 108, score
  19665/16409/18428/18658/17313 = 90473, perShift 33333332/33333031/33333232/33333333/33333032. Same rules, same
  bot; the 108 was one roll of chained shifts, the 100 is the sum of independent ones (gate run old vs new:
  stars −7.4 %, score −9.1 %, noNewZero FAIL on seed 3 shifts 6 and 8 and seed 11 shift 6).
  Why the star rule moved from "may drop 1" to "may drop 10 % of the sum": single shifts swing by 1-3★ per seed with
  no regression behind them (PR #14 variant C: 107★ against main's 108, yet −2★ on seed 11 and +2★ on seed 1).
  The per-seed zero check is what keeps a real stall from passing.
  Before 12 Nov (seed 11 only, stars may drop 1, score 10 %):
  Main 1416fd4: shifts 8 · stars 23 · score 20120 · perShift 33333233. README says "3 stars on every shift
  (retries on shifts 5 and 8)"; that is the retry mode at real-time steps. Under `?cal` at 1/30 s, shift 6 gets 2★.
  Both numbers are the bot's; the gate compares like with like.
- **Proof it fails**: `SCORE_K.pax` 10 → 0 (delivered passengers worth nothing) gives stars 23 → 19 and
  score 20120 → 4460: `RESULT FAIL` on both (old single-seed gate). With 5 seeds: stars 108 → 79,
  score 90473 → 17793, new 0★ shifts on every seed: `RESULT FAIL` on three rules.
  PR #14 at 046b75a (seed 11 only: 23 → 21★, −14.3 % score; seed 4 stalls in shift 1): shifts 40 → 32, stars
  108 → 82, score 90473 → 69150, new 0★ shifts on seeds 3, 4 and 11: `RESULT FAIL` on all four rules.
  Against the 12 Nov baseline (`--baseline --only sim`): `SCORE_K.pax` 10 → 0 gives stars 100 → 80, score
  82269 → 11204, new 0★ shifts on seeds 1, 2 and 4: `RESULT FAIL` on three rules. PR #14 at 046b75a: shifts 40 → 39
  (seed 4 stalls in shift 1 and never reaches shift 8), new 0★ shifts on seed 4 (1, 2, 8) and seed 11 (8):
  `RESULT FAIL`. PR #14 with the shift-independence change applied (what its CI would play after a merge): new 0★
  shifts on seed 4 (1, 2) and seed 11 (8): `RESULT FAIL`.
- **layout**: `?auto&noaudio` at the three phone sizes; `#topbar button`, the touch wheel and throttle
  (`#touch [role=slider]`) and the horn/camera buttons (`#touch .tb`): 9 elements, all inside and on top on main.
  No known offenders.

## Porting to another game

Copy `tools/gate.mjs` and edit only the `GAME` block at the top:

- `entry`, `cdn.match` / `cdn.pkg` (import-map CDN URL and the part before the path inside the npm package),
  `ignored` (requests answered empty).
- `sim.query`: URL flags that start the bot and expose the hook (`?auto&debug`, `?auto&sim`, …).
- `sim.ready` / `sim.run` / `sim.metrics`: in-page functions. `run` must be synchronous (or return a promise) and
  deterministic: fixed time step, seeded RNG, bot on. If the game only has a `?sim=N` URL flag that runs before the
  first frame, put it in `query` and make `run` a no-op. If the core runs in Node, a Node runner is cheaper, but keep
  the same output format.
- `sim.tolerance`: which metrics gate and how much they may drop. Prefer the bot's progress measure (wave, level,
  stars, day), a volume measure (kills, score) and an economy measure (gold, cash). Add the game's own error count
  with `max: 0`.
- `sim.seeds` / `sim.seedParam` (optional): the seeds to play and the URL parameter that sets the game's seed. Use
  several when one shift or wave can flip on noise; tolerances then apply to the sums. `sim.noNewZero`
  (`{ metric, zero }`, optional): a per-unit string metric (one character per level/shift) checked per seed.
  A recorded `gate-baseline.json` is tied to its seed list; changing the seeds means `--record` again on main.
- `sim.holdFrames`: keep `true` unless the hook needs the render loop.
- `layout.query` / `layout.selectors`: a URL that shows the in-game HUD with no overlay, and the HUD's buttons.
- `layout.known`: only real, already-reported offenders, with the commit and the reason. Never add one to make a
  run green.

Checklist per game:

1. Find the hook (`grep -n "Sim\b\|?sim\|?auto\|selftest" index.html`) and check in the code that it uses a fixed step
   and a seeded RNG (no `Math.random`/`Date.now` in the update path).
2. Run `--only sim` twice on main: the determinism line must say `identical`.
3. Check the numbers against the game's README/report claims; if they differ, write down which is right.
4. `--record` on main and commit `tools/gate-baseline.json`.
5. Prove it fails: a scratch `--candidate` with a known regression (e.g. a revert of a bad relay commit, or damage × 0)
   must give `RESULT FAIL` on a sim metric. Keep the scratch file out of git.
6. Run the layout part; list existing offenders in `layout.known` with their source commit, or fix them first.
7. Add the `gate` job to the game's workflow (chromium only, `timeout-minutes`, `permissions: contents: read`,
   the already pinned `actions/checkout` and `actions/setup-node` SHAs, `fetch-depth: 2`).

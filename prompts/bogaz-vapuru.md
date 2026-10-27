# Arena round 4, game 1: Boğaz Vapuru (Bosphorus ferry captain) — built by Claude Fable 5.1

```text
Build a single-file browser game (one index.html with inline CSS and JS) using Three.js r170 loaded as an ES
module from https://cdn.jsdelivr.net/npm/three@0.170.0/ (import map; addons from examples/jsm/).
A 3D ferry-captain game called "Boğaz Vapuru" (Bosphorus ferry). Do not ask questions, build it end to end.

WORLD: a stylised low-poly Bosphorus at the end of the afternoon: the strait winding between the European and
Asian shores, hills with layered wooden yalı mansions, mosques with domes and minarets, the Galata and Maiden's
towers, a suspension bridge, fishing boats, gulls. Water with gentle animated waves, a visible current that is
stronger in the middle of the strait. Clean toy-like look, flat shading, soft shadows, one accent colour
(#0E7490 Bosphorus teal) for selection and UI. Day turns to dusk and night: the ferry, piers and bridge light up.

THE FERRY: a classic white-and-black city ferry with a yellow funnel, smoke puffs, wake foam. Physics: throttle
(forward / astern), rudder, inertia, drift from the current and wind; it takes skill to stop next to a pier.
Docking: come alongside a pier slowly enough and close enough, the ropes are thrown, passengers walk off and on
(little instanced people with colours), a bell rings.

GAME RULES: a route between 6 piers (Eminönü, Karaköy, Üsküdar, Beşiktaş, Kadıköy, Kanlıca) with a timetable.
Each shift is a list of stops with departure times; passengers wait at piers and grow impatient; dock gently
(hard bumps damage the hull and upset passengers), avoid tankers crossing the strait, fishing boats and other
ferries (AI traffic that follows rules). Score = passengers delivered, punctuality, comfort; star rating per
shift. A campaign of 8 shifts that adds fog, night, strong current, a storm and a tanker convoy; an endless shift
afterwards. Timetables, piers and difficulty are data in one table in the code; balanced so a careful player
gets 3 stars and a reckless one fails.

INTERACTION: keyboard W/S throttle, A/D rudder, Space horn, C camera (chase / bridge / top); on phones an on-screen
throttle lever and rudder wheel; mouse drag orbits the chase camera. A docking guide (distance and speed gauge)
appears near a pier. Minimap with the route and the next pier.

HUD: top bar (logo, shift, clock vs timetable, passengers, comfort, stars, pause, sound, language), next stop card,
toasts, title, shift result, campaign map, game over.

EXTRAS: engine thrum that follows throttle, horn, pier bell, gulls, waves, a calm saz-and-strings music loop,
all synthesised (CC0 one-shots from asset-forge allowed).
```

The shared rules in `_sablonlar/arena-round4-common.md` are appended to this prompt.

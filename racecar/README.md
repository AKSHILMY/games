# Pocket Racers

Lightweight multiplayer car racing in the browser. There is no login and no game server. One player creates a race, shares the invite link, and friends join directly over WebRTC.

- Low-poly 3D with Three.js: a CC0 race car model (Kenney Car Kit, about 27 KB) with steering and spinning wheels, body lean and brake lights; the track and scenery are generated in code
- Shadows that follow the player, a gradient sky, tone mapping, and procedural asphalt and grass textures. Quality drops automatically if the frame rate stays below 45 fps
- Peer-to-peer networking with PeerJS. The host relays positions to everyone else (star topology, up to 8 players)
- Keyboard (WASD / arrow keys) and on-screen touch controls
- About 225 KB gzipped in total, including the car model

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (open a second tab to test multiplayer)
npm test           # rankings, race simulation, host lobby/results logic, network smoothing
npm run build      # static site in dist/
npm run preview    # serve the built site
```

## How it works

| File | Role |
|---|---|
| `src/net/peer.ts` | PeerJS wrapper. Each guest opens a reliable `ctl` channel and an unordered `st` channel to the host |
| `src/net/room.ts` | `HostSession` (roster, colours, start, finish order, relaying) and `GuestSession` |
| `src/net/protocol.ts` | Message types |
| `src/game/track.ts` | Spline track, meshes, barriers, scenery, `LapCounter` (a lap counts only after passing all 4 quarters) |
| `src/game/car.ts` | Arcade car physics (grip, drift, off-road, walls, car-to-car bumps) |
| `src/game/carModel.ts` | Car model loading, per-player paint, wheel/body animation, brake light |
| `src/game/remotePose.ts` | Smooth playback of other players' cars. Updates are timed by the sender's clock, so network jitter doesn't cause stutter, and gaps are covered by dead reckoning |
| `src/game/race.ts` | Race loop: fixed 60 Hz physics (drawn between steps, so it stays smooth on 120 Hz screens) and 20 Hz state sends |
| `src/game/standings.ts` | Race order: finishers by time, then by distance covered |

Each client simulates its own car and reports its position. The host decides the roster, the start and the finishing order. This suits casual games between friends, but there is no anti-cheat.

## Deploy

Live at **https://akshilmy.com/games/racecar/**.

This folder lives in the `AKSHILMY/games` repo. Every push to `main` runs `.github/workflows/deploy-pages.yml` at the repo root. It tests and builds the game, then publishes it to GitHub Pages under `/racecar/`, with a small landing page at `/games/`. The custom domain comes from the `akshilmy.github.io` user site, so this repo needs no CNAME file.

### Players who can't connect

Peer-to-peer connections fail on some strict networks (corporate or some mobile carriers). For those, add a TURN server (for example Cloudflare Calls TURN or the Metered free tier) at build time:

```bash
VITE_TURN_URL=turn:your.turn.host:3478 VITE_TURN_USER=... VITE_TURN_PASS=... npm run build
```

On GitHub, set them as repository secrets `TURN_URL`, `TURN_USER` and `TURN_PASS`, and the deploy workflow will pick them up.

## Known limitations

- The race ends if the host closes their tab.
- Finish times come from each player's own clock, measured from the moment their countdown ended. Results can be off by a few tens of milliseconds, which only matters in a photo finish.
- Room signalling uses the free public PeerJS broker (`0.peerjs.com`).

## Credits

The race car model is from the [Car Kit by Kenney](https://kenney.nl/assets/car-kit) (CC0). The license is in `public/models/LICENSE-kenney.txt`.

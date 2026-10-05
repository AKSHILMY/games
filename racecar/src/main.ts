import './ui/style.css';
import { Stage, disposeTree } from './game/scene';
import { CIRCUITS, Track } from './game/track';
import { Race, type Standing } from './game/race';
import { loadCarModel } from './game/carModel';
import { buildScenery } from './game/scenery';
import { isTouch, setupTouch } from './input/controls';
import { Net } from './net/peer';
import { GuestSession, HostSession, type Session } from './net/room';
import type { PlayerInfo, RaceConfig, ResultRow } from './net/protocol';
import { $, Hud, confetti, renderPlayers, renderResults, show, toast } from './ui/screens';
import { sound } from './audio/sound';

const stage = new Stage($<HTMLCanvasElement>('gl'));
let track = new Track();
let scenery = buildScenery(track);
stage.scene.add(track.group, scenery);
const hud = new Hud(track);
const carModelReady = loadCarModel();
stage.onQualityChange = (q) => race?.setShadows(q === 'high');

if (isTouch) document.body.classList.add('touch');
setupTouch($('touch'));

let session: Session | null = null;
let race: Race | null = null;
let results: ResultRow[] = [];
let standings: Standing[] = [];
let localFinished = false;
let closesAt = 0; // when the race closes for cars still running (0 = nobody has finished yet)
const FINISH_WINDOW = 30000; // like real racing: once the winner is home, the rest get 30 s to finish

// ---------- name persistence ----------
const NAME_KEY = 'pocketracers.name';
const savedName = (() => {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
})();
$<HTMLInputElement>('name').value = savedName;
$<HTMLInputElement>('joinName').value = savedName;
function takeName(id: string): string {
  const name = $<HTMLInputElement>(id).value.trim() || 'Driver';
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode */
  }
  return name;
}

/** Switch to the host's circuit and weather (rebuilds the track only when the circuit changed). */
function applyConfig(cfg: RaceConfig) {
  if (cfg.track !== track.circuit && CIRCUITS[cfg.track]) {
    stage.scene.remove(track.group, scenery);
    disposeTree(track.group);
    disposeTree(scenery);
    track = new Track(cfg.track);
    scenery = buildScenery(track);
    stage.scene.add(track.group, scenery);
    hud.setTrack(track);
  }
  track.setWet(cfg.wet);
  stage.setWeather(cfg.wet);
  const c = CIRCUITS[track.circuit];
  // The host sees the choices in the dropdowns, so only describe the circuit; guests get everything
  $('raceInfo').textContent = session?.isHost
    ? c.blurb
    : `${c.name} · ${c.blurb} · ${cfg.wet ? 'Wet' : 'Dry'} · ${cfg.laps} ${cfg.laps === 1 ? 'lap' : 'laps'}`;
}

// ---------- menu ----------
function inviteLink(code: string) {
  return `${location.origin}${location.pathname}#join=${code}`;
}

function goHome(msg?: string) {
  race?.dispose();
  race = null;
  session?.leave();
  session = null;
  history.replaceState(null, '', location.pathname);
  show('menu');
  if (msg) toast(msg, 5000);
}

document.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', () => goHome()));

// Browsers only allow audio after a user gesture
addEventListener('pointerdown', () => sound.unlock());
addEventListener('keydown', () => sound.unlock());
const muteBtn = $('mute');
const syncMute = () => (muteBtn.textContent = sound.muted ? '🔇' : '🔊');
syncMute();
muteBtn.addEventListener('click', () => {
  sound.setMuted(!sound.muted);
  syncMute();
});
addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && (e.target as HTMLElement)?.tagName !== 'INPUT') {
    sound.setMuted(!sound.muted);
    syncMute();
  }
});

$('create').addEventListener('click', async () => {
  const name = takeName('name');
  show('loading');
  $('loadingMsg').textContent = 'Creating race…';
  try {
    const net = await Net.host();
    attach(new HostSession(net, name));
  } catch (err) {
    console.error(err);
    goHome('Could not create a race: ' + (err as Error).message);
  }
});

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $<HTMLInputElement>('code').value.trim().toLowerCase();
  if (!/^[a-z0-9]{6}$/.test(code)) return toast('Room codes are 6 letters/numbers.');
  join(code, takeName('name'));
});

$('joinGo').addEventListener('click', () => {
  join($('joinCode').textContent!, takeName('joinName'));
});

async function join(code: string, name: string) {
  show('loading');
  $('loadingMsg').textContent = `Joining race ${code}…`;
  try {
    const net = await Net.join(code);
    attach(new GuestSession(net, name));
  } catch (err) {
    console.error(err);
    goHome((err as Error).message);
  }
}

// ---------- lobby ----------
$('copy').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('link');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  toast('Invite link copied');
});
$('share').addEventListener('click', () => {
  navigator.share?.({ title: 'Pocket Racers', text: 'Race me!', url: $<HTMLInputElement>('link').value }).catch(() => {});
});
if (!('share' in navigator)) $('share').style.display = 'none';

$<HTMLSelectElement>('circuit').innerHTML = CIRCUITS.map((c, i) => `<option value="${i}">${c.name}</option>`).join('');
$<HTMLSelectElement>('circuit').addEventListener('change', (e) => session?.configure({ track: +(e.target as HTMLSelectElement).value }));
$<HTMLSelectElement>('weather').addEventListener('change', (e) =>
  session?.configure({ wet: (e.target as HTMLSelectElement).value === 'wet' }),
);
$<HTMLSelectElement>('laps').addEventListener('change', (e) => session?.configure({ laps: +(e.target as HTMLSelectElement).value }));
$('start').addEventListener('click', () => session?.startRace());
$('again').addEventListener('click', () => session?.backToLobby());
$('endRace').addEventListener('click', () => session?.backToLobby());

function attach(s: Session) {
  session = s;
  $<HTMLInputElement>('link').value = inviteLink(s.code);
  $('roomCode').textContent = s.code;
  $('hostCtl').style.display = s.isHost ? '' : 'none';
  $('inviteBox').style.display = '';
  $('again').style.display = s.isHost ? '' : 'none';
  $('resultsWait').style.display = s.isHost ? 'none' : '';
  $('endRace').style.display = s.isHost ? 'inline-block' : 'none';

  s.onLobby = (players, cfg, racing) => {
    renderPlayers(players, s.myId);
    $<HTMLSelectElement>('laps').value = String(cfg.laps);
    $<HTMLSelectElement>('circuit').value = String(cfg.track);
    $<HTMLSelectElement>('weather').value = cfg.wet ? 'wet' : 'dry';
    if (!race) applyConfig(cfg); // never swap the track under a race in progress
    $('waitMsg').textContent = s.isHost
      ? players.length > 1
        ? ''
        : 'Waiting for friends… or start a solo practice race.'
      : racing && !race
        ? 'A race is in progress. You will join the next one.'
        : 'Waiting for the host to start…';
    if (race && !racing) endRace();
    if (race) {
      // Drop cars of players who left mid-race
      const ids = new Set(players.map((p) => p.id));
      for (const st of standings) if (!ids.has(st.id)) race.removePlayer(st.id);
    }
    if (!race) show('lobby');
  };

  s.onStart = (players, cfg) => startRace(players, cfg);
  s.onSnap = (states) => race?.receive(states);
  s.onResults = (rows) => {
    results = rows;
    // Start the finish window when the first result arrives, even if this tab isn't drawing frames
    if (race && !closesAt && rows.length) closesAt = performance.now() + FINISH_WINDOW;
    if (localFinished) refreshResults(!!race?.finished);
  };
  s.onEnd = (reason) => goHome(reason);

  if (s.isHost) s.configure({}); // publishes the initial lobby
}

// ---------- race ----------
async function startRace(players: PlayerInfo[], cfg: RaceConfig) {
  if (!session) return;
  await carModelReady;
  race?.dispose();
  race = null;
  applyConfig(cfg);
  results = [];
  localFinished = false;
  closesAt = 0;
  const s = session;
  race = new Race(stage, track, s.myId, players, cfg, {
    sendState: (st) => s.sendState(st),
    sendFinish: (t) => s.sendFinish(t),
    hud: (info) => {
      standings = info.standings;
      const now = performance.now();
      if (!closesAt && (info.finished || results.length || info.standings.some((x) => x.fin))) closesAt = now + FINISH_WINDOW;
      const closed = closesAt > 0 && now >= closesAt;
      if (closesAt && !closed && !info.finished && !info.banner) {
        info.banner = `FINISH IN ${Math.ceil((closesAt - now) / 1000)}s`;
      }
      hud.update(info, s.myId);
      if (!info.finished && !closed) return;
      // Keep the results live: other players keep finishing after us
      const first = !localFinished;
      localFinished = true;
      if (first && !info.finished) race?.retire();
      const place = refreshResults(info.finished);
      if (first) {
        if (info.finished && place === 1 && info.total > 1) confetti();
        show('hud', 'results');
      }
    },
  });
  show('hud');
  (document.activeElement as HTMLElement | null)?.blur();
  if (import.meta.env.DEV) (window as unknown as { __race: Race }).__race = race; // for debugging in devtools
}

const ORDINAL = ['1st', '2nd', '3rd'];

/** Redraw the results panel from the latest standings and host results; returns our place. */
function refreshResults(finished: boolean): number {
  if (!session) return 0;
  const left = closesAt ? Math.ceil((closesAt - performance.now()) / 1000) : 0;
  const closed = closesAt > 0 && left <= 0;
  const { place, racing } = renderResults(results, standings, session.myId, closed);
  $('resultsTitle').textContent = !finished
    ? 'Race over: did not finish'
    : standings.length < 2
      ? 'Finished!'
      : place === 1
        ? 'You win! 🏆'
        : `You finished ${ORDINAL[place - 1] ?? place + 'th'}`;
  // Going back to the lobby ends the race for everyone, so the host waits until the others
  // are home or the finish window has closed
  const waiting = racing > 0 && !closed;
  const again = $<HTMLButtonElement>('again');
  again.disabled = waiting;
  again.textContent = waiting ? `${racing} still racing · race closes in ${left}s` : 'Back to lobby';
  $('resultsWait').textContent = waiting ? `${racing} still racing · race closes in ${left}s` : 'Waiting for the host…';
  return place;
}

function endRace() {
  race?.dispose();
  race = null;
  show('lobby');
}

// ---------- main loop ----------
let last = performance.now();
let orbit = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (race) {
    race.update(dt);
    stage.watch(dt);
  } else {
    // Slow fly-over of the track behind the menus
    orbit += dt * 0.04;
    stage.camera.position.set(Math.sin(orbit) * 260, 140, Math.cos(orbit) * 260 + 30);
    stage.camera.lookAt(0, 0, 30);
  }
  stage.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- deep link ----------
const m = location.hash.match(/join=([a-z0-9]{6})/);
if (m) {
  $('joinCode').textContent = m[1];
  show('joining');
} else {
  show('menu');
}

// Clean disconnect when closing the tab
addEventListener('pagehide', () => session?.leave());

import './ui/style.css';
import { Stage } from './game/scene';
import { Track } from './game/track';
import { Race, type Standing } from './game/race';
import { loadCarModel } from './game/carModel';
import { buildScenery } from './game/scenery';
import { isTouch, setupTouch } from './input/controls';
import { Net } from './net/peer';
import { GuestSession, HostSession, type Session } from './net/room';
import type { PlayerInfo, ResultRow } from './net/protocol';
import { $, Hud, confetti, renderPlayers, renderResults, show, toast } from './ui/screens';
import { sound } from './audio/sound';

const stage = new Stage($<HTMLCanvasElement>('gl'));
const track = new Track();
stage.scene.add(track.group, buildScenery(track));
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

$<HTMLSelectElement>('laps').addEventListener('change', (e) => session?.setLaps(+(e.target as HTMLSelectElement).value));
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

  s.onLobby = (players, laps, racing) => {
    renderPlayers(players, s.myId);
    $<HTMLSelectElement>('laps').value = String(laps);
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

  s.onStart = (players, laps) => startRace(players, laps);
  s.onSnap = (states) => race?.receive(states);
  s.onResults = (rows) => {
    results = rows;
    if (localFinished) renderResults(results, standings, s.myId);
  };
  s.onEnd = (reason) => goHome(reason);

  if (s.isHost) s.setLaps(3); // publishes the initial lobby
}

// ---------- race ----------
async function startRace(players: PlayerInfo[], laps: number) {
  if (!session) return;
  await carModelReady;
  race?.dispose();
  results = [];
  localFinished = false;
  const s = session;
  race = new Race(stage, track, s.myId, players, laps, {
    sendState: (st) => s.sendState(st),
    sendFinish: (t) => s.sendFinish(t),
    hud: (info) => {
      standings = info.standings;
      hud.update(info, s.myId);
      if (info.finished && !localFinished) {
        localFinished = true;
        const place = info.standings.findIndex((x) => x.id === s.myId) + 1;
        $('resultsTitle').textContent = place === 1 && info.total > 1 ? 'You win! 🏆' : 'Finished!';
        if (place === 1) confetti();
        renderResults(results, standings, s.myId);
        show('hud', 'results');
      }
    },
  });
  show('hud');
  (document.activeElement as HTMLElement | null)?.blur();
  if (import.meta.env.DEV) (window as unknown as { __race: Race }).__race = race; // for debugging in devtools
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

import type { HudInfo, Standing } from '../game/race';
import { rankStandings } from '../game/standings';
import type { Track } from '../game/track';
import type { PlayerInfo, ResultRow } from '../net/protocol';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SCREENS = ['menu', 'joining', 'loading', 'lobby', 'hud', 'results'] as const;
export type ScreenName = (typeof SCREENS)[number];

/** Show the given screens and hide the rest. */
export function show(...names: ScreenName[]) {
  for (const s of SCREENS) $(s).classList.toggle('on', names.includes(s));
}

let toastTimer = 0;
export function toast(msg: string, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('on'), ms);
}

export const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function dot(color: number) {
  return `<span class="dot" style="background:${hex(color)}"></span>`;
}

export function renderPlayers(players: PlayerInfo[], myId: string) {
  $('players').innerHTML = players
    .map(
      (p, i) =>
        `<li class="${p.id === myId ? 'me' : ''}">${dot(p.color)}<span>${esc(p.name)}</span>` +
        `<span class="tagline">${i === 0 ? 'host' : ''}${p.id === myId ? (i === 0 ? ' · you' : 'you') : ''}</span></li>`,
    )
    .join('');
}

export function fmtTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

const shownHtml = new Map<string, string>();
/** Set innerHTML only when it changed (results are refreshed every frame while they are open). */
function setHtml(id: string, html: string) {
  if (shownHtml.get(id) === html) return;
  shownHtml.set(id, html);
  $(id).innerHTML = html;
}

/**
 * Live results: podium for the top 3 finishers, then everyone by finish time, then by distance.
 * Uses the host's finish times when known, otherwise the time each car reported itself, so a
 * finisher shows up straight away. Returns `place` (1-based) and how many are still racing.
 */
export function renderResults(
  rows: ResultRow[],
  standings: Standing[],
  myId: string,
  closed = false, // race closed: anyone without a time did not finish
): { place: number; racing: number } {
  const done = new Map(rows.map((r) => [r.id, r.time]));
  const ordered = rankStandings(standings.map((s) => ({ ...s, fin: done.get(s.id) ?? s.fin })));
  // Podium order on screen: 2nd, 1st, 3rd
  const finishers = ordered.filter((s) => s.fin).slice(0, 3);
  setHtml(
    'podium',
    finishers.length > 1
      ? [1, 0, 2]
          .filter((i) => finishers[i])
          .map((i) => {
            const s = finishers[i];
            return (
              `<div class="step p${i + 1}"><div class="who">${dot(s.color)}<b>${esc(s.name)}</b>` +
              `<small>${fmtTime(s.fin)}</small></div><div class="block">${i + 1}</div></div>`
            );
          })
          .join('')
      : '',
  );
  setHtml(
    'resultList',
    ordered
      .map(
        (s, i) =>
          `<li class="${s.id === myId ? 'me' : ''}"><span class="rank">${i + 1}</span>${dot(s.color)}` +
          `<span>${esc(s.name)}</span><span class="tagline">${s.fin ? fmtTime(s.fin) : closed ? 'DNF' : 'racing…'}</span></li>`,
      )
      .join(''),
  );
  return { place: ordered.findIndex((s) => s.id === myId) + 1, racing: ordered.filter((s) => !s.fin).length };
}

/** Burst of CSS confetti (cleans itself up). */
export function confetti() {
  const box = $('confetti');
  const colors = ['#ffb703', '#e63946', '#1d8cf8', '#2ec27e', '#f15bb5', '#ffffff'];
  for (let i = 0; i < 90; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--dx', (Math.random() - 0.5) * 200 + 'px');
    p.style.setProperty('--rot', Math.random() * 1080 + 'deg');
    p.style.animationDuration = 2.2 + Math.random() * 1.8 + 's';
    p.style.animationDelay = Math.random() * 0.6 + 's';
    box.appendChild(p);
  }
  setTimeout(() => (box.innerHTML = ''), 5000);
}

/** Analogue speedometer: 0–300 km/h dial with needle and digital readout. */
class Speedo {
  private c: CanvasRenderingContext2D;
  private face: HTMLCanvasElement;
  private static MAX = 300;
  private static A0 = Math.PI * 0.75; // start angle (bottom-left)
  private static SWEEP = Math.PI * 1.5;

  constructor(private cv: HTMLCanvasElement) {
    this.c = cv.getContext('2d')!;
    this.face = document.createElement('canvas');
    this.face.width = cv.width;
    this.face.height = cv.height;
    const f = this.face.getContext('2d')!;
    const { width: w } = cv;
    const cx = w / 2;
    const r = w / 2 - 8;
    f.fillStyle = 'rgba(13,27,42,0.55)';
    f.beginPath();
    f.arc(cx, cx, r + 4, 0, Math.PI * 2);
    f.fill();
    // red zone
    f.strokeStyle = 'rgba(230,57,70,0.85)';
    f.lineWidth = 8;
    f.beginPath();
    f.arc(cx, cx, r - 6, this.angle(250), this.angle(300)); // above normal top speed: nitro / slipstream
    f.stroke();
    f.fillStyle = '#f1f5f9';
    f.strokeStyle = '#f1f5f9';
    f.font = 'bold 15px system-ui, sans-serif';
    f.textAlign = 'center';
    f.textBaseline = 'middle';
    for (let v = 0; v <= Speedo.MAX; v += 10) {
      const a = this.angle(v);
      const major = v % 50 === 0;
      f.lineWidth = major ? 3 : 1.5;
      f.beginPath();
      f.moveTo(cx + Math.cos(a) * (r - (major ? 14 : 8)), cx + Math.sin(a) * (r - (major ? 14 : 8)));
      f.lineTo(cx + Math.cos(a) * r, cx + Math.sin(a) * r);
      f.stroke();
      if (major) f.fillText(String(v), cx + Math.cos(a) * (r - 30), cx + Math.sin(a) * (r - 30));
    }
  }

  private angle(kmh: number) {
    return Speedo.A0 + (Math.min(kmh, Speedo.MAX) / Speedo.MAX) * Speedo.SWEEP;
  }

  draw(kmh: number) {
    const { c, cv } = this;
    const cx = cv.width / 2;
    c.clearRect(0, 0, cv.width, cv.height);
    c.drawImage(this.face, 0, 0);
    const a = this.angle(kmh);
    c.strokeStyle = '#ffb703';
    c.lineWidth = 5;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(cx - Math.cos(a) * 12, cx - Math.sin(a) * 12);
    c.lineTo(cx + Math.cos(a) * (cx - 26), cx + Math.sin(a) * (cx - 26));
    c.stroke();
    c.fillStyle = '#ffb703';
    c.beginPath();
    c.arc(cx, cx, 7, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#fff';
    c.font = 'italic 900 34px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText(String(kmh), cx, cx + 46);
    c.font = 'bold 12px system-ui, sans-serif';
    c.fillStyle = '#9fb3c8';
    c.fillText('km/h', cx, cx + 68);
  }
}

/** Cheap HUD: only touches the DOM when a value actually changes. */
export class Hud {
  private last: Record<string, string> = {};
  private map: CanvasRenderingContext2D;
  private base = document.createElement('canvas');
  private toMap: (x: number, z: number) => [number, number] = () => [0, 0];
  private lastMap = 0;
  private lastKmh = -1;
  private lastNitro = -1;
  private nitroState = '';
  private isTouch = document.body.classList.contains('touch');
  private speedo = new Speedo($<HTMLCanvasElement>('speedo'));

  constructor(track: Track) {
    this.map = $<HTMLCanvasElement>('minimap').getContext('2d')!;
    this.setTrack(track);
  }

  /** Redraw the minimap's track outline (on start-up and when the circuit changes). */
  setTrack(track: Track) {
    const cv = this.map.canvas;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const s of track.samples) {
      minX = Math.min(minX, s.x);
      maxX = Math.max(maxX, s.x);
      minZ = Math.min(minZ, s.z);
      maxZ = Math.max(maxZ, s.z);
    }
    const pad = 12;
    const scale = (cv.width - pad * 2) / Math.max(maxX - minX, maxZ - minZ);
    const ox = (cv.width - (maxX - minX) * scale) / 2;
    const oz = (cv.height - (maxZ - minZ) * scale) / 2;
    // Top-down view of the track (viewed from above, rotated 180° so the start straight runs left→right)
    this.toMap = (x, z) => [cv.width - (ox + (x - minX) * scale), cv.height - (oz + (z - minZ) * scale)];

    this.base.width = cv.width;
    this.base.height = cv.height;
    const b = this.base.getContext('2d')!;
    b.lineWidth = 6;
    b.lineJoin = 'round';
    b.strokeStyle = 'rgba(255,255,255,0.75)';
    b.beginPath();
    track.samples.forEach((s, i) => {
      const [x, y] = this.toMap(s.x, s.z);
      if (i) b.lineTo(x, y);
      else b.moveTo(x, y);
    });
    b.closePath();
    b.stroke();
    const [sx, sy] = this.toMap(track.samples[0].x, track.samples[0].z);
    b.fillStyle = '#e63946';
    b.fillRect(sx - 4, sy - 4, 8, 8);
  }

  private toggleClass(id: string, cls: string, on: boolean) {
    const key = `class:${id}.${cls}`;
    const v = on ? '1' : '';
    if (this.last[key] === v) return;
    this.last[key] = v;
    $(id).classList.toggle(cls, on);
  }

  private toggle(id: string, on: boolean) {
    const key = 'class:' + id;
    const v = on ? '1' : '';
    if (this.last[key] === v) return;
    this.last[key] = v;
    $(id).classList.toggle('on', on);
  }

  private set(id: string, v: string, html = false) {
    if (this.last[id] === v) return;
    this.last[id] = v;
    if (html) $(id).innerHTML = v;
    else $(id).textContent = v;
  }

  update(h: HudInfo, myId: string) {
    this.set('pos', String(h.pos));
    this.set('posTotal', '/' + h.total);
    this.set('lap', String(h.lap));
    this.set('laps2', String(h.laps));
    this.set('timer', fmtTime(h.time));
    this.set('lapTime', fmtTime(h.lapTime));
    this.set('lastLap', h.lastLap ? fmtTime(h.lastLap) : '–');
    this.set('bestLap', h.bestLap ? fmtTime(h.bestLap) : '–');
    this.set('countdown', h.countdown ?? '');
    this.set('banner', h.banner ?? '');
    this.toggleClass('banner', 'warn', h.banner === 'WRONG WAY');
    this.toggleClass('banner', 'nitro', h.banner === 'NITRO READY');
    // Nitro bar: transform-only updates (no layout), and only when it visibly changes
    if (Math.abs(h.nitro - this.lastNitro) > 0.003) {
      this.lastNitro = h.nitro;
      $('nitroFill').style.transform = `scaleX(${h.nitro.toFixed(3)})`;
    }
    const state = h.boosting ? 'boost' : h.nitroReady ? 'ready' : '';
    if (state !== this.nitroState) {
      this.nitroState = state;
      const box = $('nitro');
      box.classList.toggle('ready', state === 'ready');
      box.classList.toggle('boost', state === 'boost');
      $('nitroText').textContent = state === 'boost' ? 'BOOST!' : state === 'ready' ? 'NITRO READY' : 'NITRO';
      $('nitroKey').textContent = this.isTouch ? '⚡' : 'SHIFT';
      $('nitroBtn').classList.toggle('ready', state === 'ready');
      $('boostFx').classList.toggle('on', state === 'boost');
    }
    this.toggle('draft', h.draft > 0.15 && !h.boosting);

    if (h.kmh !== this.lastKmh) {
      this.lastKmh = h.kmh;
      this.speedo.draw(h.kmh);
    }
    this.set(
      'standings',
      h.total > 1
        ? h.standings
            .map((s) => `<li class="${s.id === myId ? 'me' : ''}">${dot(s.color)}${esc(s.name)}</li>`)
            .join('')
        : '',
      true,
    );

    const now = performance.now();
    if (now - this.lastMap < 50) return;
    this.lastMap = now;
    const m = this.map;
    m.clearRect(0, 0, m.canvas.width, m.canvas.height);
    m.drawImage(this.base, 0, 0);
    for (const d of h.dots) {
      const [x, y] = this.toMap(d.x, d.z);
      m.beginPath();
      m.arc(x, y, d.me ? 6 : 4.5, 0, Math.PI * 2);
      m.fillStyle = hex(d.color);
      m.fill();
      m.lineWidth = 2;
      m.strokeStyle = d.me ? '#fff' : '#0d1b2a';
      m.stroke();
    }
  }
}

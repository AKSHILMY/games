import { beforeEach, describe, expect, it } from 'vitest';
import { HostSession } from '../src/net/room';
import type { Net } from '../src/net/peer';
import type { Msg, ResultRow } from '../src/net/protocol';

// Fake network: records what the host sends and lets tests inject guest messages.
class FakeNet {
  myId = 'host';
  code = 'abc123';
  sent: { to: string; msg: Msg }[] = [];
  guests = new Set<string>();
  kicked: string[] = [];
  onMessage: (from: string, msg: Msg) => void = () => {};
  onLeave: (id: string) => void = () => {};
  send(to: string, msg: Msg) {
    this.sent.push({ to, msg });
  }
  broadcast(msg: Msg, except?: string) {
    for (const g of this.guests) if (g !== except) this.send(g, msg);
  }
  kick(id: string) {
    this.kicked.push(id);
    this.guests.delete(id);
  }
  destroy() {}
  // test helpers
  join(id: string, name = id) {
    this.guests.add(id);
    this.onMessage(id, { t: 'hello', name });
  }
  leave(id: string) {
    this.guests.delete(id);
    this.onLeave(id);
  }
  last(to: string, t: Msg['t']) {
    return [...this.sent].reverse().find((s) => s.to === to && s.msg.t === t)?.msg;
  }
}

let net: FakeNet;
let host: HostSession;
let results: ResultRow[];

beforeEach(() => {
  net = new FakeNet();
  host = new HostSession(net as unknown as Net, 'Hosty');
  results = [];
  host.onResults = (rows) => (results = rows);
});

describe('host lobby', () => {
  it('adds players with unique colours and tells everyone', () => {
    net.join('g1', 'Ann');
    net.join('g2', 'Bob');
    const lobby = net.last('g1', 'lobby') as Extract<Msg, { t: 'lobby' }>;
    expect(lobby.players.map((p) => p.name)).toEqual(['Hosty', 'Ann', 'Bob']);
    expect(new Set(lobby.players.map((p) => p.color)).size).toBe(3);
  });

  it('rejects the 9th player', () => {
    for (let i = 1; i <= 7; i++) net.join('g' + i);
    net.join('g8');
    expect(net.last('g8', 'full')).toBeTruthy();
    expect(net.kicked).toEqual(['g8']);
  });

  it('sanitises names', () => {
    net.join('g1', '   A   very   long   name   indeed  ');
    const lobby = net.last('g1', 'lobby') as Extract<Msg, { t: 'lobby' }>;
    expect(lobby.players[1].name).toBe('A very long na');
  });

  it('validates race settings and sends them with the lobby and the start', () => {
    net.join('g1');
    host.configure({ track: 2, wet: true, laps: 99 });
    const lobby = net.last('g1', 'lobby') as Extract<Msg, { t: 'lobby' }>;
    expect(lobby.cfg).toEqual({ laps: 10, track: 2, wet: true });
    host.configure({ track: 42 });
    expect((net.last('g1', 'lobby') as Extract<Msg, { t: 'lobby' }>).cfg.track).toBe(2); // last circuit
    host.configure({ laps: 2 });
    host.startRace();
    const start = net.last('g1', 'start') as Extract<Msg, { t: 'start' }>;
    expect(start.cfg).toEqual({ laps: 2, track: 2, wet: true });
  });

  it('removes a player who leaves', () => {
    net.join('g1');
    net.join('g2');
    net.leave('g1');
    const lobby = net.last('g2', 'lobby') as Extract<Msg, { t: 'lobby' }>;
    expect(lobby.players.map((p) => p.id)).toEqual(['host', 'g2']);
  });
});

describe('host race results', () => {
  beforeEach(() => {
    net.join('g1', 'Ann');
    net.join('g2', 'Bob');
    host.startRace();
  });

  it('orders finishers by time, not by arrival order', () => {
    net.onMessage('g2', { t: 'finish', time: 65000 });
    host.sendFinish(61000);
    net.onMessage('g1', { t: 'finish', time: 63000 });
    expect(results.map((r) => r.id)).toEqual(['host', 'g1', 'g2']);
    const sent = net.last('g1', 'results') as Extract<Msg, { t: 'results' }>;
    expect(sent.rows.map((r) => r.id)).toEqual(['host', 'g1', 'g2']);
  });

  it('ignores duplicate finishes', () => {
    net.onMessage('g1', { t: 'finish', time: 63000 });
    net.onMessage('g1', { t: 'finish', time: 50000 });
    expect(results).toEqual([{ id: 'g1', time: 63000 }]);
  });

  it('ignores finishes and states from players who joined after the start', () => {
    net.join('late');
    net.onMessage('late', { t: 'finish', time: 1000 });
    expect(results).toEqual([]);
    const before = net.sent.length;
    net.onMessage('late', { t: 'state', s: { id: 'late', n: 0, x: 0, z: 0, h: 0, vx: 0, vz: 0, lap: 0, prog: 0, fin: 0, t: 0, br: 0, nb: 0 } });
    expect(net.sent.length).toBe(before);
  });

  it('relays a guest state to the other guests only, with the id forced to the sender', () => {
    net.onMessage('g1', { t: 'state', s: { id: 'spoofed', n: 1, x: 1, z: 2, h: 0, vx: 0, vz: 0, lap: 0, prog: 0.1, fin: 0, t: 0, br: 0, nb: 0 } });
    const toG2 = net.last('g2', 'snap') as Extract<Msg, { t: 'snap' }>;
    expect(toG2.s[0].id).toBe('g1');
    expect(net.last('g1', 'snap')).toBeUndefined();
  });

  it('a new race clears the previous results', () => {
    host.sendFinish(61000);
    host.backToLobby();
    host.startRace();
    net.onMessage('g1', { t: 'finish', time: 70000 });
    expect(results.map((r) => r.id)).toEqual(['g1']);
  });
});

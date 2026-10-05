import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import { isStateMsg, type Msg } from './protocol';

// Every guest opens two data channels to the host:
//  - "ctl": reliable + ordered, for lobby/start/finish/results
//  - "st":  unordered, for 20 Hz car state (no head-of-line blocking)
interface Link {
  ctl?: DataConnection;
  st?: DataConnection;
}

const ID_PREFIX = 'rcx-race-';

// Optional TURN server for strict NATs, set at build time:
//   VITE_TURN_URL=turn:host:3478 VITE_TURN_USER=... VITE_TURN_PASS=...
function peerOptions(): PeerOptions {
  const iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const env = import.meta.env;
  if (env.VITE_TURN_URL) {
    iceServers.push({ urls: env.VITE_TURN_URL, username: env.VITE_TURN_USER, credential: env.VITE_TURN_PASS });
  }
  return { config: { iceServers }, debug: 1 };
}

function randomCode(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function openPeer(id: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = new Peer(id, peerOptions());
    peer.once('open', () => resolve(peer));
    peer.once('error', (err) => {
      peer.destroy();
      reject(err);
    });
  });
}

export class Net {
  /** Called with every message received, tagged with the sender's peer id. */
  onMessage: (from: string, msg: Msg) => void = () => {};
  /** Host: a guest disconnected. Guest: the host disconnected (id = host id). */
  onLeave: (id: string) => void = () => {};
  /** Host: a guest's control channel is open. */
  onJoin: (id: string) => void = () => {};

  private links = new Map<string, Link>();

  private constructor(
    private peer: Peer,
    readonly isHost: boolean,
    readonly code: string,
  ) {}

  get myId(): string {
    return this.peer.id;
  }

  get hostId(): string {
    return ID_PREFIX + this.code;
  }

  static async host(): Promise<Net> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = randomCode();
      try {
        const peer = await openPeer(ID_PREFIX + code);
        const net = new Net(peer, true, code);
        peer.on('connection', (c) => net.accept(c));
        peer.on('disconnected', () => peer.reconnect());
        return net;
      } catch (err) {
        if ((err as { type?: string }).type !== 'unavailable-id') throw err;
      }
    }
    throw new Error('Could not reserve a room code, please retry.');
  }

  static async join(code: string, timeoutMs = 12000): Promise<Net> {
    const peer = await openPeer(ID_PREFIX + 'g-' + randomCode() + randomCode());
    const net = new Net(peer, false, code);
    const hostId = net.hostId;
    const opts = { serialization: 'json' };
    const ctl = peer.connect(hostId, { ...opts, label: 'ctl', reliable: true });
    const st = peer.connect(hostId, { ...opts, label: 'st', reliable: false });
    net.links.set(hostId, { ctl, st });
    net.wire(hostId, ctl);
    net.wire(hostId, st);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Could not reach the host. Check the link, or the host may have left.')), timeoutMs);
      peer.once('error', (err) => {
        clearTimeout(timer);
        reject((err as { type?: string }).type === 'peer-unavailable' ? new Error('Room not found. The host may have left.') : err);
      });
      let opened = 0;
      const ready = () => {
        if (++opened === 2) {
          clearTimeout(timer);
          resolve();
        }
      };
      ctl.once('open', ready);
      st.once('open', ready);
    }).catch((err) => {
      peer.destroy();
      throw err;
    });
    return net;
  }

  private accept(conn: DataConnection) {
    const link = this.links.get(conn.peer) ?? {};
    if (conn.label === 'ctl') link.ctl = conn;
    else link.st = conn;
    this.links.set(conn.peer, link);
    conn.once('open', () => {
      this.wire(conn.peer, conn);
      if (conn.label === 'ctl') this.onJoin(conn.peer);
    });
  }

  private wire(id: string, conn: DataConnection) {
    conn.on('data', (data) => this.onMessage(id, data as Msg));
    const drop = () => {
      if (!this.links.has(id)) return;
      const link = this.links.get(id)!;
      this.links.delete(id);
      link.ctl?.close();
      link.st?.close();
      this.onLeave(id);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  send(to: string, msg: Msg) {
    const link = this.links.get(to);
    const conn = isStateMsg(msg) ? link?.st : link?.ctl;
    if (conn?.open) conn.send(msg);
  }

  /** Host only: send to every guest, optionally skipping one. */
  broadcast(msg: Msg, except?: string) {
    for (const id of this.links.keys()) if (id !== except) this.send(id, msg);
  }

  /** Guest only: send to the host. */
  toHost(msg: Msg) {
    this.send(this.hostId, msg);
  }

  kick(id: string) {
    const link = this.links.get(id);
    this.links.delete(id);
    // give the "full" message a moment to flush
    setTimeout(() => {
      link?.ctl?.close();
      link?.st?.close();
    }, 300);
  }

  destroy() {
    this.links.clear();
    this.peer.destroy();
  }
}

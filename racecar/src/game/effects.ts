import * as THREE from 'three';
import { ROAD_HALF, type Track } from './track';
import type { CarVisual } from './carModel';

const MAX_PUFFS = 260;
const MAX_MARKS = 700; // skid mark segments (ring buffer)
const MARK_WIDTH = 0.38;
// Rear wheel contact points in car space (metres), left and right
const REAR_WHEELS: [number, number][] = [
  [0.85, -1.5],
  [-0.85, -1.5],
];

export interface EffectCar {
  id: string;
  visual: CarVisual;
  x: number;
  z: number;
  h: number;
}

interface Puff {
  life: number; // seconds left, 0 = free
  max: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  grow: number;
  alpha: number; // peak opacity
}

type PuffKind = 'smoke' | 'dust' | 'spray';
// colour, peak opacity, start size, growth per second, base lifetime (s)
const KINDS: Record<PuffKind, { rgb: [number, number, number]; alpha: number; size: number; grow: number; life: number }> = {
  smoke: { rgb: [0.92, 0.92, 0.94], alpha: 0.5, size: 1.0, grow: 3.2, life: 1.1 },
  dust: { rgb: [0.62, 0.5, 0.34], alpha: 0.55, size: 1.2, grow: 2.2, life: 0.9 },
  spray: { rgb: [0.8, 0.84, 0.88], alpha: 0.32, size: 1.3, grow: 4, life: 0.5 },
};

/**
 * Tyre smoke, grass dust, rain spray and skid marks for every car. Everything is drawn from fixed pools
 * (one Points object, one skid-mark mesh) so effects cost two draw calls and no garbage.
 */
export class Effects {
  readonly group = new THREE.Group();
  private puffs: Puff[] = [];
  private nextPuff = 0;
  private live = 0; // puffs alive after the last step; 0 means the buffers already hold nothing to draw
  private points: THREE.Points;
  private pPos: Float32Array;
  private pSize: Float32Array;
  private pAlpha: Float32Array;
  private pColor: Float32Array;

  private marks: THREE.Mesh;
  private mPos: Float32Array;
  private nextMark = 0;
  private lastContact = new Map<string, ([number, number] | null)[]>();
  private hints = new Map<string, number>();
  private emitAcc = new Map<string, number>();

  /** `wet`: tyres throw up spray at speed and leave no skid marks. */
  constructor(
    private track: Track,
    private wet = false,
  ) {
    for (let i = 0; i < MAX_PUFFS; i++)
      this.puffs.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 1, grow: 1, alpha: 0 });

    const g = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PUFFS * 3);
    this.pSize = new Float32Array(MAX_PUFFS);
    this.pAlpha = new Float32Array(MAX_PUFFS);
    this.pColor = new Float32Array(MAX_PUFFS * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.pAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.pColor, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(g, puffMaterial());
    this.points.frustumCulled = false;
    this.group.add(this.points);

    const mg = new THREE.BufferGeometry();
    this.mPos = new Float32Array(MAX_MARKS * 4 * 3);
    const idx: number[] = [];
    for (let i = 0; i < MAX_MARKS; i++) {
      const a = i * 4;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    mg.setAttribute('position', new THREE.BufferAttribute(this.mPos, 3).setUsage(THREE.DynamicDrawUsage));
    mg.setIndex(idx);
    this.marks = new THREE.Mesh(
      mg,
      new THREE.MeshBasicMaterial({
        color: 0x111111,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    this.marks.frustumCulled = false;
    this.marks.renderOrder = 1;
    this.group.add(this.marks);
  }

  /** `pointScale` = screen pixels per metre at 1 m distance, so puffs keep their size on any screen. */
  update(dt: number, cars: EffectCar[], pointScale: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = pointScale;
    for (const c of cars) this.emitFor(c, dt);
    this.stepPuffs(dt);
  }

  private emitFor(c: EffectCar, dt: number) {
    const v = c.visual;
    const speed = Math.abs(v.speed);
    // Ignore implausible values (e.g. a remote car's first update snapping it into place)
    if (speed > 90 || Math.abs(v.slide) > 40) return;

    const hint = this.hints.get(c.id) ?? -1;
    const p = this.track.project(c.x, c.z, hint);
    this.hints.set(c.id, p.idx);
    const offroad = Math.abs(p.offset) > ROAD_HALF + 1.2;

    const sliding = Math.abs(v.slide) > 3.5 && speed > 6;
    const hardBrake = v.accel < -20 && speed > 8;
    const skid = !offroad && (sliding || hardBrake);
    const dust = offroad && speed > 4;
    const spray = this.wet && !offroad && speed > 15;
    const marks = skid && !this.wet; // standing water leaves no rubber on the road

    const sin = Math.sin(c.h);
    const cos = Math.cos(c.h);
    const contacts = REAR_WHEELS.map(([lx, lz]) => [c.x + lx * cos + lz * sin, c.z - lx * sin + lz * cos] as [number, number]);

    // Skid marks: join each rear wheel's last contact point to the current one
    const last = this.lastContact.get(c.id) ?? [null, null];
    contacts.forEach((pt, i) => {
      const prev = last[i];
      if (marks && prev) {
        const d = Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
        if (d > 0.4 && d < 6) {
          this.addMark(prev, pt);
          last[i] = pt;
        }
      } else last[i] = marks ? pt : null;
    });
    this.lastContact.set(c.id, last);

    // Dust off-road; spray in the wet; otherwise smoke, with a rate that grows with how hard the car is sliding
    if (!skid && !dust && !spray) return;
    const kind: PuffKind = dust ? 'dust' : spray ? 'spray' : 'smoke';
    const intensity =
      kind === 'dust'
        ? Math.min(1, speed / 25)
        : kind === 'spray'
          ? Math.min(1, speed / 45)
          : Math.min(1, (Math.abs(v.slide) + Math.max(0, -v.accel - 20) * 0.3) / 12);
    const rate = (kind === 'smoke' ? 45 : 30) * intensity; // puffs per second per wheel
    let acc = (this.emitAcc.get(c.id) ?? 0) + rate * dt;
    while (acc >= 1) {
      acc -= 1;
      for (const pt of contacts) this.spawn(pt[0], pt[1], kind, c.h, speed);
    }
    this.emitAcc.set(c.id, acc);
  }

  private spawn(x: number, z: number, kind: PuffKind, h: number, speed: number) {
    const k = KINDS[kind];
    const i = this.nextPuff;
    const p = this.puffs[i];
    this.nextPuff = (i + 1) % MAX_PUFFS;
    this.live++;
    // Colour only changes here, so it is uploaded on spawn rather than every frame
    this.pColor.set(k.rgb, i * 3);
    this.points.geometry.attributes.color.needsUpdate = true;
    const back = Math.min(8, speed * 0.15);
    p.life = p.max = k.life * (1 + Math.random() * 0.6);
    p.x = x + (Math.random() - 0.5) * 0.4;
    p.y = 0.35;
    p.z = z + (Math.random() - 0.5) * 0.4;
    p.vx = -Math.sin(h) * back + (Math.random() - 0.5) * 1.5;
    p.vz = -Math.cos(h) * back + (Math.random() - 0.5) * 1.5;
    p.vy = 0.6 + Math.random() * 0.8;
    p.size = k.size;
    p.grow = k.grow;
    p.alpha = k.alpha;
  }

  private stepPuffs(dt: number) {
    if (!this.live) return; // nothing alive, and the buffers were already cleared
    let live = 0;
    const drag = Math.exp(-2.5 * dt);
    for (let i = 0; i < MAX_PUFFS; i++) {
      const p = this.puffs[i];
      if (p.life > 0) {
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.vx *= drag;
        p.vz *= drag;
        p.size += p.grow * dt;
      }
      const alive = p.life > 0;
      if (alive) live++;
      const t = alive ? p.life / p.max : 0; // 1 → 0
      this.pPos[i * 3] = p.x;
      this.pPos[i * 3 + 1] = p.y;
      this.pPos[i * 3 + 2] = p.z;
      this.pSize[i] = alive ? p.size : 0;
      this.pAlpha[i] = alive ? p.alpha * t * Math.min(1, (1 - t) * 8) : 0;
    }
    this.live = live;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
  }

  private addMark(a: [number, number], b: [number, number]) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz);
    const nx = (-dz / l) * MARK_WIDTH * 0.5;
    const nz = (dx / l) * MARK_WIDTH * 0.5;
    const y = 0.045;
    this.mPos.set(
      [a[0] + nx, y, a[1] + nz, a[0] - nx, y, a[1] - nz, b[0] + nx, y, b[1] + nz, b[0] - nx, y, b[1] - nz],
      this.nextMark * 12,
    );
    // Upload just this segment, not the whole 700-segment buffer
    const attr = this.marks.geometry.attributes.position as THREE.BufferAttribute;
    attr.addUpdateRange(this.nextMark * 12, 12);
    attr.needsUpdate = true;
    this.nextMark = (this.nextMark + 1) % MAX_MARKS;
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    this.points.geometry.dispose();
    this.marks.geometry.dispose();
  }
}

function puffMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    uniforms: { scale: { value: 420 } },
    vertexShader: /* glsl */ `
      attribute float size; attribute float alpha;
      varying float vAlpha; varying vec3 vColor;
      uniform float scale;
      void main() {
        vAlpha = alpha; vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * scale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha; varying vec3 vColor;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d) * 4.0;
        if (r > 1.0) discard;
        gl_FragColor = vec4(vColor, vAlpha * (1.0 - r));
      }`,
  });
}

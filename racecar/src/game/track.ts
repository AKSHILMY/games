import * as THREE from 'three';

export const ROAD_HALF = 8; // half road width (m)
export const WALL = 13; // lateral distance of the barrier from the centre line
const SAMPLES = 480;

// Closed loop control points (x, z), metres. Hand-shaped for a mix of fast sweepers and a hairpin.
const CONTROL: [number, number][] = [
  [0, -160], [120, -170], [210, -120], [230, -30], [180, 30], [110, 40], [80, 90],
  [120, 150], [100, 210], [10, 230], [-70, 190], [-90, 120], [-170, 100], [-220, 30],
  [-200, -60], [-130, -110], [-70, -150],
];

export interface Sample {
  x: number;
  z: number;
  tx: number; // unit tangent
  tz: number;
  nx: number; // unit normal pointing to the left of travel
  nz: number;
}

/** Result of projecting a point onto the track. */
export interface Projection {
  idx: number;
  offset: number; // signed lateral distance (+ = left)
}

export class Track {
  readonly samples: Sample[] = [];
  readonly length: number;
  readonly group = new THREE.Group();

  constructor() {
    const curve = new THREE.CatmullRomCurve3(
      CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      'centripetal',
    );
    this.length = curve.getLength();
    const pts = curve.getSpacedPoints(SAMPLES).slice(0, SAMPLES);
    for (let i = 0; i < SAMPLES; i++) {
      const a = pts[(i - 1 + SAMPLES) % SAMPLES];
      const b = pts[(i + 1) % SAMPLES];
      let tx = b.x - a.x;
      let tz = b.z - a.z;
      const l = Math.hypot(tx, tz);
      tx /= l;
      tz /= l;
      // Three uses a right-handed system with Y up; heading h has forward (sin h, cos h) and
      // its left side is (cos h, -sin h). For tangent (tx, tz) = (sin h, cos h) that is (tz, -tx).
      this.samples.push({ x: pts[i].x, z: pts[i].z, tx, tz, nx: tz, nz: -tx });
    }
    this.buildMeshes();
  }

  get count(): number {
    return SAMPLES;
  }

  /** Metres between consecutive samples. */
  get step(): number {
    return this.length / SAMPLES;
  }

  /** Project (x, z) onto the track, searching near `hint` (or everywhere when hint < 0). */
  project(x: number, z: number, hint = -1): Projection {
    let best = 0;
    let bestD = Infinity;
    const scan = (i: number) => {
      const s = this.samples[i];
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    };
    if (hint < 0) {
      for (let i = 0; i < SAMPLES; i++) scan(i);
    } else {
      for (let k = -25; k <= 25; k++) scan((hint + k + SAMPLES) % SAMPLES);
    }
    const s = this.samples[best];
    return { idx: best, offset: (x - s.x) * s.nx + (z - s.z) * s.nz };
  }

  /** Starting grid slot: two columns, staggered, just past the start line. */
  gridSlot(slot: number): { x: number; z: number; h: number } {
    const row = Math.floor(slot / 2);
    const col = slot % 2 === 0 ? 1 : -1;
    const idx = Math.round((32 - row * 7) / this.step + SAMPLES) % SAMPLES;
    const s = this.samples[idx];
    const lat = col * 3.2;
    return { x: s.x + s.nx * lat, z: s.z + s.nz * lat, h: Math.atan2(s.tx, s.tz) };
  }

  private buildMeshes() {
    const n = SAMPLES;
    const S = this.samples;

    // Ribbon helper: a strip between two lateral offsets at heights y0/y1, vertex coloured.
    const ribbon = (
      off0: number,
      off1: number,
      y0: number,
      y1: number,
      color: (i: number) => THREE.Color,
    ): THREE.BufferGeometry => {
      const pos = new Float32Array((n + 1) * 2 * 3);
      const col = new Float32Array((n + 1) * 2 * 3);
      const uv = new Float32Array((n + 1) * 2 * 2);
      const idx: number[] = [];
      for (let i = 0; i <= n; i++) {
        const s = S[i % n];
        const c = color(i % n);
        pos.set([s.x + s.nx * off0, y0, s.z + s.nz * off0, s.x + s.nx * off1, y1, s.z + s.nz * off1], i * 6);
        col.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
        // u across the strip (0..1), v along it in units of 8 m
        const v = (i * this.step) / 8;
        uv.set([0, v, 1, v], i * 4);
        if (i < n) {
          const a = i * 2;
          idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    };

    const white = new THREE.Color(0xf1f1f1);
    // Kerbs and barriers use striped textures (vertex colours would blend between stripes)
    const kerbMat = new THREE.MeshLambertMaterial({ map: stripeTexture('#d62828', '#f1f1f1', 8 / 6) });
    const wallMat = new THREE.MeshLambertMaterial({ map: stripeTexture('#1d6fd8', '#eef1f4', 8 / 24), side: THREE.DoubleSide });
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

    const add = (g: THREE.BufferGeometry, m: THREE.Material = mat) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    // Road surface (ribbon from right edge to left edge, so normals point up)
    const roadTex = noiseTexture(256, [58, 61, 66], 16, 0.04);
    roadTex.repeat.set(2, 1);
    add(ribbon(-ROAD_HALF, ROAD_HALF, 0.02, 0.02, () => white), new THREE.MeshLambertMaterial({ map: roadTex }));
    // Solid white edge lines
    add(ribbon(ROAD_HALF - 0.7, ROAD_HALF - 0.4, 0.03, 0.03, () => white));
    add(ribbon(-ROAD_HALF + 0.4, -ROAD_HALF + 0.7, 0.03, 0.03, () => white));
    add(ribbon(ROAD_HALF, ROAD_HALF + 1.2, 0.04, 0.04, () => white), kerbMat);
    add(ribbon(-ROAD_HALF - 1.2, -ROAD_HALF, 0.04, 0.04, () => white), kerbMat);
    // Barriers: vertical ribbons
    add(ribbon(WALL + 0.4, WALL + 0.4, 0, 1.1, () => white), wallMat).castShadow = true;
    add(ribbon(-WALL - 0.4, -WALL - 0.4, 0, 1.1, () => white), wallMat).castShadow = true;

    // Centre dashes
    const dash = ribbon(-0.25, 0.25, 0.03, 0.03, () => white);
    const keep: number[] = [];
    const ix = dash.index!.array;
    for (let i = 0; i < n; i++) if (i % 4 < 2) for (let k = 0; k < 6; k++) keep.push(ix[i * 6 + k]);
    dash.setIndex(keep);
    add(dash);

    // Start/finish line: checkered strip
    const cv = document.createElement('canvas');
    cv.width = 16;
    cv.height = 2;
    const cx = cv.getContext('2d')!;
    for (let i = 0; i < 16; i++)
      for (let j = 0; j < 2; j++) {
        cx.fillStyle = (i + j) % 2 ? '#111' : '#fff';
        cx.fillRect(i, j, 1, 1);
      }
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_HALF * 2, 2.5),
      new THREE.MeshBasicMaterial({ map: tex }),
    );
    const s0 = S[0];
    const h0 = Math.atan2(s0.tx, s0.tz);
    line.rotation.set(-Math.PI / 2, 0, h0, 'YXZ');
    line.position.set(s0.x, 0.05, s0.z);
    this.group.add(line);

    // Start gantry
    const gantryMat = new THREE.MeshLambertMaterial({ color: 0x22252a });
    const post = new THREE.BoxGeometry(0.6, 7, 0.6);
    const beam = new THREE.BoxGeometry(WALL * 2 + 1.2, 1.4, 0.8);
    const gantry = new THREE.Group();
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(post, gantryMat);
      p.position.set(side * (WALL + 0.6), 3.5, 0);
      gantry.add(p);
    }
    const b = new THREE.Mesh(beam, new THREE.MeshLambertMaterial({ color: 0xd62828 }));
    b.position.y = 7;
    gantry.add(b);
    gantry.position.set(s0.x, 0, s0.z);
    gantry.rotation.y = h0;
    this.group.add(gantry);

    this.addScenery();
  }

  private addScenery() {
    // Deterministic RNG so every player sees the same scenery.
    let seed = 1337;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

    const spots: THREE.Vector3[] = [];
    let tries = 0;
    while (spots.length < 260 && tries++ < 6000) {
      const x = (rnd() - 0.5) * 700;
      const z = (rnd() - 0.5) * 640 + 30;
      const { offset, idx } = this.project(x, z);
      if (Math.abs(offset) < WALL + 5) continue;
      // keep the start area clear for the grandstand and pit building
      const nearStart = idx > SAMPLES * 0.93 || idx < SAMPLES * 0.04;
      if (nearStart && Math.abs(offset) < WALL + 30) continue;
      spots.push(new THREE.Vector3(x, 0, z));
    }

    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.45, 2, 5);
    const leafGeo = new THREE.ConeGeometry(2.4, 6, 6);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x6b4423 }), spots.length);
    const leaves = new THREE.InstancedMesh(
      leafGeo,
      new THREE.MeshLambertMaterial({ color: 0x2d6a4f, flatShading: true }),
      spots.length,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    spots.forEach((p, i) => {
      const k = 0.7 + rnd() * 0.8;
      sc.set(k, k, k);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * Math.PI);
      m.compose(new THREE.Vector3(p.x, 1 * k, p.z), q, sc);
      trunks.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(p.x, 5 * k, p.z), q, sc);
      leaves.setMatrixAt(i, m);
    });
    trunks.castShadow = leaves.castShadow = true;
    this.group.add(trunks, leaves);

    // Ground: tiled grass noise
    const grass = noiseTexture(256, [96, 150, 72], 26, 0.08);
    grass.repeat.set(180, 180);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), new THREE.MeshLambertMaterial({ map: grass }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.group.add(ground);
  }
}

/**
 * Lap tracking for the local car. A lap only counts when the car has passed through
 * every quarter of the track since the last crossing, so cutting back over the line doesn't count.
 */
export class LapCounter {
  lap = 0;
  idx = 0;
  private quarters = 0;

  constructor(private n: number) {}

  reset(idx: number) {
    this.lap = 0;
    this.idx = idx;
    this.quarters = 1;
  }

  update(idx: number) {
    const n = this.n;
    this.quarters |= 1 << Math.floor((idx / n) * 4);
    const prev = this.idx;
    this.idx = idx;
    // crossing the line forwards: from the last 10% to the first 10%
    if (prev > n * 0.9 && idx < n * 0.1 && this.quarters === 0b1111) {
      this.lap++;
      this.quarters = 1;
    }
  }

  /** laps completed + fraction of the current lap */
  get progress(): number {
    return this.lap + this.idx / this.n;
  }
}

/**
 * Small tiling noise texture generated at load time (no image files): a base colour with
 * per-pixel variation plus a few lighter specks.
 */
function noiseTexture(size: number, rgb: [number, number, number], spread: number, specks: number): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const c = cv.getContext('2d')!;
  const img = c.createImageData(size, size);
  let seed = size * 31 + rgb[0];
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < size * size; i++) {
    const d = (rnd() - 0.5) * spread + (rnd() < specks ? spread * 1.2 : 0);
    img.data[i * 4] = rgb[0] + d;
    img.data[i * 4 + 1] = rgb[1] + d;
    img.data[i * 4 + 2] = rgb[2] + d;
    img.data[i * 4 + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Two-colour stripes along a ribbon's v axis; `perUnit` stripe pairs per v unit (8 m). */
function stripeTexture(a: string, b: string, perUnit: number): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 1;
  cv.height = 2;
  const c = cv.getContext('2d')!;
  c.fillStyle = a;
  c.fillRect(0, 0, 1, 1);
  c.fillStyle = b;
  c.fillRect(0, 1, 1, 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.repeat.set(1, perUnit);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

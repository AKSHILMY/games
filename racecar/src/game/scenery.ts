import * as THREE from 'three';
import { WALL, type Track } from './track';

// Trackside dressing: tyre walls on corners, grandstand + crowd, pit building, billboards,
// flags, bushes, rocks and distant hills. Everything repeated is instanced (a handful of draw calls).

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

function place(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, rotY: number, sx = 1, sy = 1, sz = 1) {
  tmpQ.setFromAxisAngle(UP, rotY);
  tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz));
  mesh.setMatrixAt(i, tmpM);
}

/** Heading of the track at sample i. */
const headingAt = (track: Track, i: number) => {
  const s = track.samples[(i + track.count) % track.count];
  return Math.atan2(s.tx, s.tz);
};

export function buildScenery(track: Track): THREE.Group {
  const g = new THREE.Group();
  g.add(tyreWalls(track), grandstand(track), pitBuilding(track), billboards(track), flags(track), bushesAndRocks(track));
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  g.add(hills()); // far away: no shadows
  return g;
}

/** Stacks of tyres in front of the barrier on the outside of tight corners. */
function tyreWalls(track: Track): THREE.Object3D {
  const n = track.count;
  const spots: { x: number; z: number; h: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    // signed curvature: heading change over ±6 samples (≈ 18 m)
    let d = headingAt(track, i + 6) - headingAt(track, i - 6);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) < 0.35) continue;
    // turning left (d > 0) → outside is the right side (negative offset)
    const side = d > 0 ? -1 : 1;
    const s = track.samples[i];
    const off = side * (WALL + 0.1);
    spots.push({ x: s.x + s.nx * off, z: s.z + s.nz * off, h: headingAt(track, i) });
  }
  const layers = 3;
  const geo = new THREE.CylinderGeometry(0.42, 0.42, 0.32, 10);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), spots.length * layers);
  const black = new THREE.Color(0x1d1f22);
  const white = new THREE.Color(0xeeeeee);
  spots.forEach((p, i) =>
    [0, 1, 2].forEach((l) => {
      const k = i * layers + l;
      place(mesh, k, p.x, 0.16 + l * 0.33, p.z, p.h);
      mesh.setColorAt(k, l === 1 && i % 2 === 0 ? white : black);
    }),
  );
  return mesh;
}

/** Covered grandstand with an instanced crowd, beside the start straight. */
function grandstand(track: Track): THREE.Object3D {
  const g = new THREE.Group();
  const idx = Math.round(track.count * 0.97);
  const s = track.samples[idx];
  const h = headingAt(track, idx);
  const side = 1; // left of the start straight
  const base = WALL + 5;
  g.position.set(s.x + s.nx * side * base, 0, s.z + s.nz * side * base);
  g.rotation.y = h;

  const concrete = new THREE.MeshLambertMaterial({ color: 0xb8bcc2 });
  const length = 60;
  const tiers = 6;
  for (let t = 0; t < tiers; t++) {
    const fill = new THREE.Mesh(new THREE.BoxGeometry(2, 0.8 * (t + 1), length), concrete);
    fill.position.set(1 + t * 2, 0.4 * (t + 1), 0);
    g.add(fill);
  }
  // Roof on posts
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xd62828 });
  const roof = new THREE.Mesh(new THREE.BoxGeometry(14, 0.4, length + 4), roofMat);
  roof.position.set(6.5, 9.5, 0);
  roof.rotation.z = -0.08;
  g.add(roof);
  const postGeo = new THREE.BoxGeometry(0.4, 9.5, 0.4);
  for (let z = -length / 2; z <= length / 2; z += 15) {
    const p = new THREE.Mesh(postGeo, new THREE.MeshLambertMaterial({ color: 0x33373d }));
    p.position.set(12.5, 4.75, z);
    g.add(p);
  }

  // Crowd: little seated people as coloured boxes, one instanced mesh
  const rnd = rng(77);
  const perRow = 46;
  const people = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.55, 0.9, 0.5),
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    tiers * perRow,
  );
  const shirts = [0xe63946, 0x1d8cf8, 0xffb703, 0x2ec27e, 0xffffff, 0x9b5de5, 0xf77f00, 0x222222];
  const c = new THREE.Color();
  let k = 0;
  for (let t = 0; t < tiers; t++)
    for (let i = 0; i < perRow; i++) {
      const z = -length / 2 + 1 + (i + rnd() * 0.4) * ((length - 2) / perRow);
      const scale = 0.85 + rnd() * 0.3;
      place(people, k, 0.6 + t * 2, 0.8 * (t + 1) + 0.45 * scale, z, Math.PI / 2 + (rnd() - 0.5) * 0.4, 1, scale, 1);
      people.setColorAt(k++, c.setHex(shirts[Math.floor(rnd() * shirts.length)]));
    }
  g.add(people);
  return g;
}

/** Pit building with garages and a control tower, opposite the grandstand. */
function pitBuilding(track: Track): THREE.Object3D {
  const g = new THREE.Group();
  const idx = Math.round(track.count * 0.985);
  const s = track.samples[idx];
  const h = headingAt(track, idx);
  const base = -(WALL + 6);
  g.position.set(s.x + s.nx * base, 0, s.z + s.nz * base);
  g.rotation.y = h;

  const length = 70;
  const body = new THREE.Mesh(new THREE.BoxGeometry(10, 5, length), new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }));
  body.position.set(-5, 2.5, 0);
  g.add(body);
  // Garage doors: one dark strip with a texture of doors
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 16;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, 128, 16);
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = '#2b2f36';
    ctx.fillRect(i * 16 + 2, 3, 12, 13);
  }
  const doorTex = new THREE.CanvasTexture(cv);
  doorTex.colorSpace = THREE.SRGBColorSpace;
  const doors = new THREE.Mesh(new THREE.PlaneGeometry(length, 4), new THREE.MeshLambertMaterial({ map: doorTex }));
  doors.position.set(0.01, 2, 0);
  doors.rotation.y = Math.PI / 2;
  g.add(doors);
  // Glass strip on top + control tower
  const glass = new THREE.Mesh(new THREE.BoxGeometry(8, 1.6, length - 4), new THREE.MeshStandardMaterial({ color: 0x23435f, roughness: 0.15, metalness: 0.4 }));
  glass.position.set(-5, 5.8, 0);
  g.add(glass);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(6, 14, 6), new THREE.MeshLambertMaterial({ color: 0xe6e6e6 }));
  tower.position.set(-6, 7, length / 2 - 4);
  g.add(tower);
  const towerTop = new THREE.Mesh(new THREE.BoxGeometry(7.5, 2.5, 7.5), new THREE.MeshStandardMaterial({ color: 0x23435f, roughness: 0.15, metalness: 0.4 }));
  towerTop.position.set(-6, 15, length / 2 - 4);
  g.add(towerTop);
  return g;
}

/** Sponsor-style boards along the straights, just behind the barrier. */
function billboards(track: Track): THREE.Object3D {
  const g = new THREE.Group();
  const texts = [
    ['POCKET RACERS', '#ffb703', '#0d1b2a'],
    ['TURBO COLA', '#e63946', '#ffffff'],
    ['GRIP TYRES', '#111111', '#ffb703'],
    ['NITRO FM', '#1d8cf8', '#ffffff'],
  ];
  const mats = texts.map(([t, bg, fg]) => {
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 64;
    const c = cv.getContext('2d')!;
    c.fillStyle = bg;
    c.fillRect(0, 0, 256, 64);
    c.fillStyle = fg;
    c.font = 'italic 900 38px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(t, 128, 34);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return new THREE.MeshLambertMaterial({ map: tex });
  });
  const board = new THREE.PlaneGeometry(10, 2.5);
  const legGeo = new THREE.BoxGeometry(0.2, 2, 0.2);
  const legMat = new THREE.MeshLambertMaterial({ color: 0x555a61 });
  const n = track.count;
  let k = 0;
  for (let i = 30; i < n - 30; i += 45) {
    // only on straight-ish parts
    let d = headingAt(track, i + 6) - headingAt(track, i - 6);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 0.2) continue;
    const side = k % 2 ? 1 : -1;
    const s = track.samples[i];
    const off = side * (WALL + 2.5);
    const b = new THREE.Group();
    b.position.set(s.x + s.nx * off, 0, s.z + s.nz * off);
    // face the road
    b.rotation.y = headingAt(track, i) + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
    const face = new THREE.Mesh(board, mats[k % mats.length]);
    face.position.y = 3.2;
    b.add(face);
    for (const x of [-4, 4]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(x, 1, -0.05);
      b.add(leg);
    }
    g.add(b);
    k++;
  }
  return g;
}

/** Flag poles at the start/finish line. */
function flags(track: Track): THREE.Object3D {
  const g = new THREE.Group();
  const colors = [0xe63946, 0xffb703, 0x1d8cf8, 0x2ec27e, 0xffffff, 0x9b5de5];
  const poleGeo = new THREE.CylinderGeometry(0.08, 0.08, 8, 6);
  const flagGeo = new THREE.PlaneGeometry(2, 1.2);
  flagGeo.translate(1, 0, 0);
  const poleMat = new THREE.MeshLambertMaterial({ color: 0xdddddd });
  for (let j = 0; j < 6; j++) {
    const i = (track.count - 20 + j * 8) % track.count;
    const s = track.samples[i];
    const off = -(WALL + 1.5);
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(s.x + s.nx * off, 4, s.z + s.nz * off);
    g.add(pole);
    const flag = new THREE.Mesh(flagGeo, new THREE.MeshLambertMaterial({ color: colors[j], side: THREE.DoubleSide }));
    flag.position.set(pole.position.x, 7.2, pole.position.z);
    flag.rotation.y = headingAt(track, i) + Math.PI;
    g.add(flag);
  }
  return g;
}

/** Bushes and rocks scattered beyond the barriers. */
function bushesAndRocks(track: Track): THREE.Object3D {
  const rnd = rng(9001);
  const bushSpots: THREE.Vector3[] = [];
  const rockSpots: THREE.Vector3[] = [];
  let tries = 0;
  while ((bushSpots.length < 220 || rockSpots.length < 90) && tries++ < 8000) {
    const x = (rnd() - 0.5) * 760;
    const z = (rnd() - 0.5) * 700 + 30;
    const { offset, idx } = track.project(x, z);
    const nearStart = idx > track.count * 0.93 || idx < track.count * 0.04;
    if (Math.abs(offset) < WALL + 3 || (nearStart && Math.abs(offset) < WALL + 30)) continue;
    if (bushSpots.length < 220 && rnd() < 0.7) bushSpots.push(new THREE.Vector3(x, 0, z));
    else if (rockSpots.length < 90) rockSpots.push(new THREE.Vector3(x, 0, z));
  }
  const bushes = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1.3, 0),
    new THREE.MeshLambertMaterial({ color: 0x3f7d3a, flatShading: true }),
    bushSpots.length,
  );
  const tint = new THREE.Color();
  bushSpots.forEach((p, i) => {
    const s = 0.6 + rnd() * 0.9;
    place(bushes, i, p.x, 0.6 * s, p.z, rnd() * 6, s * (1 + rnd() * 0.5), s * 0.8, s);
    bushes.setColorAt(i, tint.setHSL(0.28 + rnd() * 0.06, 0.45, 0.28 + rnd() * 0.1));
  });
  const rocks = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(1, 0),
    new THREE.MeshLambertMaterial({ color: 0x8d9096, flatShading: true }),
    rockSpots.length,
  );
  rockSpots.forEach((p, i) => {
    const s = 0.4 + rnd() * 1.2;
    place(rocks, i, p.x, 0.25 * s, p.z, rnd() * 6, s * (1 + rnd() * 0.6), s * 0.6, s);
  });
  const g = new THREE.Group();
  g.add(bushes, rocks);
  return g;
}

/** Ring of soft, hazy hills on the horizon. Not fogged, not shadowed. */
function hills(): THREE.Object3D {
  const rnd = rng(4242);
  const count = 26;
  const mesh = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1, 1, 7, 1),
    new THREE.MeshLambertMaterial({ color: 0x7fa88a, flatShading: true, fog: false }),
    count,
  );
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rnd() * 0.15;
    const r = 620 + rnd() * 120;
    const w = 90 + rnd() * 90;
    const h = 40 + rnd() * 70;
    place(mesh, i, Math.sin(a) * r, h / 2 - 2, Math.cos(a) * r + 30, rnd() * 3, w, h, w);
    mesh.setColorAt(i, c.setHSL(0.36 + rnd() * 0.08, 0.18, 0.5 + rnd() * 0.12));
  }
  return mesh;
}

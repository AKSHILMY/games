import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Kenney "Car Kit" race car (CC0), quantized. Faces +Z, ~1.2 m wide in model units.
const MODEL_URL = `${import.meta.env.BASE_URL}models/race.glb`;
const MODEL_SCALE = 1.7;
// Palette cell in the model's colour atlas used for the body paint (x, y, w, h in pixels).
const PAINT_CELL = [384, 128, 64, 128] as const;

interface Template {
  body: THREE.Mesh;
  wheels: THREE.Mesh[]; // front-left, front-right, back-left, back-right
  map: THREE.Texture;
}

let template: Template | null = null;
const paintCache = new Map<number, THREE.MeshStandardMaterial>();

/** Load the car model once. Falls back to simple box cars if it can't be loaded. */
export async function loadCarModel(): Promise<void> {
  try {
    const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
    const find = (name: string) => gltf.scene.getObjectByName(name) as THREE.Mesh;
    const body = find('body');
    template = {
      body,
      wheels: ['wheel-front-left', 'wheel-front-right', 'wheel-back-left', 'wheel-back-right'].map(find),
      map: (body.material as THREE.MeshStandardMaterial).map!,
    };
  } catch (err) {
    console.warn('Car model failed to load, using fallback cars', err);
  }
}

/** Body material with the paint cell of the colour atlas recoloured to `color`. */
function paintMaterial(color: number): THREE.MeshStandardMaterial {
  const cached = paintCache.get(color);
  if (cached) return cached;
  const src = template!.map;
  const img = src.image as CanvasImageSource & { width: number; height: number };
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const c = cv.getContext('2d', { willReadFrequently: true })!;
  c.drawImage(img, 0, 0);

  const [cx, cy, cw, ch] = PAINT_CELL.map((v) => (v * img.width) / 512);
  const data = c.getImageData(cx, cy, cw, ch);
  const px = data.data;
  // Keep the cell's shading gradient: scale the new colour by each pixel's brightness vs the cell average.
  let avg = 0;
  for (let i = 0; i < px.length; i += 4) avg += px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11;
  avg /= px.length / 4;
  const tr = (color >> 16) & 255;
  const tg = (color >> 8) & 255;
  const tb = color & 255;
  for (let i = 0; i < px.length; i += 4) {
    const k = Math.min(1.1, (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / avg);
    px[i] = Math.min(255, tr * k);
    px[i + 1] = Math.min(255, tg * k);
    px[i + 2] = Math.min(255, tb * k);
  }
  c.putImageData(data, cx, cy);

  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = src.flipY;
  tex.colorSpace = src.colorSpace;
  tex.magFilter = src.magFilter;
  tex.minFilter = src.minFilter;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0.1, envMapIntensity: 0.5 });
  paintCache.set(color, mat);
  return mat;
}

const tyreMat = () => template!.wheels[0].material as THREE.Material;
const blobGeo = new THREE.PlaneGeometry(2.3, 4.6).rotateX(-Math.PI / 2);
const blobMat = new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.28, depthWrite: false });
const lightGeo = new THREE.BoxGeometry(0.16, 0.1, 0.04);
// Exhaust flame: a cone pointing backwards (-z) from its base at the origin
const flameGeo = new THREE.ConeGeometry(0.13, 1, 8, 1, true).translate(0, 0.5, 0).rotateX(-Math.PI / 2);
const flameOuter = new THREE.MeshBasicMaterial({
  color: 0xff7a1a,
  transparent: true,
  opacity: 0.85,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
});
const flameInner = new THREE.MeshBasicMaterial({
  color: 0xfff3b0,
  transparent: true,
  opacity: 0.95,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
});

/**
 * A car's look: model, steering/spinning wheels, body lean and brake lights.
 * It works purely from the pose it is given each frame, so local and remote cars animate the same way.
 */
export class CarVisual {
  readonly group = new THREE.Group();
  private body = new THREE.Group();
  private frontPivots: THREE.Group[] = [];
  private wheels: THREE.Object3D[] = [];
  private brakeMat = new THREE.MeshBasicMaterial({ color: 0x300000, toneMapped: false });
  private blob: THREE.Mesh;
  private flames = new THREE.Group();
  private flameLen = 0;
  private last: { x: number; z: number; h: number } | null = null;
  /** Smoothed motion, derived from the pose each frame (works the same for remote cars). */
  speed = 0; // forward speed (m/s)
  slide = 0; // sideways speed (m/s), i.e. how much the car is drifting
  accel = 0; // forward acceleration (m/s²)
  private yawRate = 0;
  private roll = 0;
  private pitch = 0;
  private spin = 0;
  private steer = 0;

  constructor(color: number, label?: string) {
    this.group.add(this.body);
    if (template) this.buildModel(color);
    else this.buildFallback(color);

    this.blob = new THREE.Mesh(blobGeo, blobMat);
    this.blob.position.y = 0.05;
    this.group.add(this.blob);
    if (label) this.group.add(makeLabel(label, color));
  }

  private buildModel(color: number) {
    const t = template!;
    const body = new THREE.Mesh(t.body.geometry, paintMaterial(color));
    body.position.copy(t.body.position);
    body.scale.copy(t.body.scale);
    this.body.add(body);

    // F1-style rear light, glows when braking
    const light = new THREE.Mesh(lightGeo, this.brakeMat);
    light.position.set(0, 0.36, -1.3);
    this.body.add(light);

    // Twin exhaust flames, shown while boosting
    for (const x of [-0.14, 0.14]) {
      const outer = new THREE.Mesh(flameGeo, flameOuter);
      const inner = new THREE.Mesh(flameGeo, flameInner);
      inner.userData.inner = true;
      outer.position.set(x, 0.3, -1.3);
      inner.position.copy(outer.position);
      this.flames.add(outer, inner);
    }
    this.flames.visible = false;
    this.body.add(this.flames);

    t.wheels.forEach((w, i) => {
      const pivot = new THREE.Group();
      pivot.position.copy(w.position);
      // pivot (steering, y) → spinner (rolling, x) → wheel mesh (keeps the model's own orientation)
      const spinner = new THREE.Group();
      const wheel = new THREE.Mesh(w.geometry, tyreMat());
      wheel.scale.copy(w.scale);
      wheel.quaternion.copy(w.quaternion);
      spinner.add(wheel);
      pivot.add(spinner);
      this.group.add(pivot);
      this.wheels.push(spinner);
      if (i < 2) this.frontPivots.push(pivot);
    });
    this.group.scale.setScalar(MODEL_SCALE);
  }

  private buildFallback(color: number) {
    const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 2.5), paint);
    box.position.y = 0.4;
    this.body.add(box);
    this.group.scale.setScalar(MODEL_SCALE);
  }

  setShadows(on: boolean) {
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o !== this.blob) o.castShadow = on;
    });
    this.blob.visible = !on;
  }

  /** Place the car and animate wheels/body from how the pose changed since last frame. */
  update(dt: number, x: number, z: number, h: number, braking: boolean, boosting = false) {
    this.group.position.set(x, 0, z);
    this.group.rotation.y = h;
    if (this.last && dt > 0) {
      const dx = x - this.last.x;
      const dz = z - this.last.z;
      const vf = (dx * Math.sin(h) + dz * Math.cos(h)) / dt;
      const vl = (dx * Math.cos(h) - dz * Math.sin(h)) / dt;
      let dh = h - this.last.h;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const k = 1 - Math.exp(-12 * dt);
      const prev = this.speed;
      this.speed += (vf - this.speed) * k;
      this.yawRate += (dh / dt - this.yawRate) * k;
      this.slide += (vl - this.slide) * k;
      this.accel += ((this.speed - prev) / dt - this.accel) * (1 - Math.exp(-6 * dt));
    }
    this.last = { x, z, h };

    // Wheels: spin with speed, front ones steer towards the turn
    const radius = 0.3 * MODEL_SCALE;
    this.spin += (this.speed / radius) * dt;
    for (const w of this.wheels) w.rotation.x = this.spin;
    const wantSteer = Math.abs(this.speed) > 1 ? THREE.MathUtils.clamp((this.yawRate * 2.6) / this.speed, -0.5, 0.5) : 0;
    this.steer += (wantSteer - this.steer) * (1 - Math.exp(-10 * dt));
    for (const p of this.frontPivots) p.rotation.y = this.steer;

    // Body lean: roll out of corners, pitch under acceleration/braking
    const lat = this.speed * this.yawRate; // centripetal acceleration
    const k = 1 - Math.exp(-8 * dt);
    this.roll += (THREE.MathUtils.clamp(lat * 0.006, -0.07, 0.07) - this.roll) * k;
    this.pitch += (THREE.MathUtils.clamp(-this.accel * 0.004, -0.05, 0.05) - this.pitch) * k;
    this.body.rotation.set(this.pitch, 0, this.roll);

    this.brakeMat.color.setHex(braking ? 0xff1a1a : 0x300000);

    // Flames grow in/out smoothly and flicker
    this.flameLen += ((boosting ? 1 : 0) - this.flameLen) * (1 - Math.exp(-14 * dt));
    this.flames.visible = this.flameLen > 0.03;
    if (this.flames.visible) {
      for (const f of this.flames.children) {
        const inner = f.userData.inner === true;
        const flick = 0.75 + Math.random() * 0.5;
        f.scale.z = this.flameLen * flick * (inner ? 0.6 : 1);
        f.scale.x = f.scale.y = (inner ? 0.55 : 1) * (0.8 + this.flameLen * 0.2);
      }
    }
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    this.brakeMat.dispose();
  }
}

function makeLabel(text: string, color: number): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 64;
  const c = cv.getContext('2d')!;
  c.font = 'bold 34px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineWidth = 6;
  c.strokeStyle = 'rgba(0,0,0,0.7)';
  c.strokeText(text, 128, 32);
  c.fillStyle = '#' + color.toString(16).padStart(6, '0');
  c.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(5 / MODEL_SCALE, 1.25 / MODEL_SCALE, 1);
  s.position.y = 3.2 / MODEL_SCALE;
  s.renderOrder = 10;
  return s;
}

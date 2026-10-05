import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { isTouch } from '../input/controls';

export type Quality = 'high' | 'low';

const SUN_DIR = new THREE.Vector3(-0.55, 0.62, 0.55).normalize();
const SHADOW_RANGE = 40; // metres covered by the shadow map around the player

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.5, 900);
  private sun: THREE.DirectionalLight;
  private sky: THREE.Mesh;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private want = new THREE.Vector3();
  private look = new THREE.Vector3();
  private quality: Quality;
  /** Called when quality changes, so cars can switch between real and blob shadows. */
  onQualityChange: (q: Quality) => void = () => {};

  // frame-time watchdog for automatic quality drop
  private slowFor = 0;
  private shakeAmt = 0;
  private bufSize = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement) {
    this.quality = isTouch ? 'low' : 'high';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !isTouch, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const horizon = new THREE.Color(0xcfe6f2);
    this.scene.fog = new THREE.Fog(horizon, 160, 700);
    this.scene.background = horizon;
    this.sky = makeSky(horizon);
    this.scene.add(this.sky);

    // Soft studio reflections for the car paint only (track materials ignore it)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0xd8ecff, 0x5b7a3c, 1.3));
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
    this.sun.position.copy(SUN_DIR).multiplyScalar(120);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -SHADOW_RANGE;
    sc.right = sc.top = SHADOW_RANGE;
    sc.near = 1;
    sc.far = 300;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);

    this.applyQuality();
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  get shadows(): boolean {
    return this.quality === 'high';
  }

  setQuality(q: Quality) {
    if (q === this.quality) return;
    this.quality = q;
    this.applyQuality();
    this.onQualityChange(q);
  }

  private applyQuality() {
    const high = this.quality === 'high';
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, high ? 1.5 : 1));
    this.renderer.shadowMap.enabled = high;
    this.sun.castShadow = high;
    // materials must recompile when shadow support changes
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
    this.resize();
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Smooth chase camera behind a car at (x, z) with heading h. `snap` jumps straight there. */
  follow(x: number, z: number, h: number, speed: number, dt: number, snap = false, boosting = false) {
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const back = 8.5 + speed * 0.04;
    this.want.set(x - fx * back, 3.4, z - fz * back);
    this.look.set(x + fx * 6, 1.3, z + fz * 6);
    this.camPos.lerp(this.want, snap ? 1 : 1 - Math.exp(-7 * dt));
    this.camLook.lerp(this.look, snap ? 1 : 1 - Math.exp(-12 * dt));
    this.camera.position.copy(this.camPos);
    if (this.shakeAmt > 0.01) {
      const a = this.shakeAmt * 0.35;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
      this.camera.position.z += (Math.random() - 0.5) * a;
      this.shakeAmt *= Math.exp(-6 * dt);
    }
    this.camera.lookAt(this.camLook);
    const fov = 62 + Math.min(14, speed * 0.25) + (boosting ? 9 : 0);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, 4 * dt);
      this.camera.updateProjectionMatrix();
    }
    // Keep the shadow map centred just ahead of the player, snapped to texels to stop shimmering
    const texel = (SHADOW_RANGE * 2) / this.sun.shadow.mapSize.x;
    const cx = Math.round((x + fx * 12) / texel) * texel;
    const cz = Math.round((z + fz * 12) / texel) * texel;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx + SUN_DIR.x * 120, SUN_DIR.y * 120, cz + SUN_DIR.z * 120);
  }

  /** Kick the camera; amount 0..1. */
  shake(amount: number) {
    this.shakeAmt = Math.max(this.shakeAmt, amount);
  }

  /** Screen pixels covered by 1 m at 1 m distance (for sizing point sprites). */
  pointScale(): number {
    this.renderer.getDrawingBufferSize(this.bufSize);
    return this.bufSize.y / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }

  /** Feed frame times; drops to low quality if the game can't hold ~45 fps for 3 s. */
  watch(dt: number) {
    if (this.quality === 'low' || document.hidden) return;
    this.slowFor = dt > 1 / 45 ? this.slowFor + dt : Math.max(0, this.slowFor - dt * 0.5);
    if (this.slowFor > 3) {
      console.info('[racer] low frame rate, switching to low quality');
      this.setQuality('low');
    }
  }

  render() {
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}

/** Big gradient dome with a soft sun glow; cheaper than a real atmosphere shader. */
function makeSky(horizon: THREE.Color): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x3d8fd6) },
      horizon: { value: horizon },
      sunDir: { value: SUN_DIR },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // always at the far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        float h = max(vDir.y, 0.0);
        vec3 col = mix(horizon, top, pow(h, 0.55));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        col += vec3(1.0, 0.9, 0.7) * (pow(s, 600.0) * 2.0 + pow(s, 12.0) * 0.25);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(800, 24, 12), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

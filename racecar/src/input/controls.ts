export interface Input {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1 (left) .. 1 (right)
  nitro?: boolean;
}

const keys = new Set<string>();
const touch = { left: false, right: false, gas: false, brake: false, nitro: false };

addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  keys.add(e.code);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

export const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

/** Wire the on-screen buttons (elements with data-touch="left|right|gas|brake|nitro"). */
export function setupTouch(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-touch]').forEach((el) => {
    const k = el.dataset.touch as keyof typeof touch;
    const on = (e: PointerEvent) => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      touch[k] = true;
      el.classList.add('down');
    };
    const off = () => {
      touch[k] = false;
      el.classList.remove('down');
    };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('lostpointercapture', off);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  });
}

export function readInput(): Input {
  const has = (...c: string[]) => c.some((k) => keys.has(k));
  const left = has('ArrowLeft', 'KeyA') || touch.left;
  const right = has('ArrowRight', 'KeyD') || touch.right;
  return {
    throttle: has('ArrowUp', 'KeyW') || touch.gas ? 1 : 0,
    brake: has('ArrowDown', 'KeyS', 'Space') || touch.brake ? 1 : 0,
    steer: (right ? 1 : 0) - (left ? 1 : 0),
    nitro: has('ShiftLeft', 'ShiftRight', 'KeyN') || touch.nitro,
  };
}

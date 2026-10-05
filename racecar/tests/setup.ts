// Minimal DOM stubs so track/car code (which draws small canvas textures) can run in Node.
const ctx = new Proxy(
  { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) } as Record<string, unknown>,
  { get: (t, k) => (k in t ? t[k as string] : () => {}), set: () => true },
);
(globalThis as any).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
(globalThis as any).matchMedia ??= () => ({ matches: false });

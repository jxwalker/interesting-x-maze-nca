/**
 * Renderer-agnostic pieces: the View interface, the palette and colour ramp, the world layout,
 * and the shared tile animation (springy heights, tumbles, the one-tick frontier edge, the marble)
 * so the WebGL and Canvas2D views move identically. Heights are exactly h0 + s·d of the live field.
 */
import { INF } from "./maze";
import type { Model } from "./model";

export const TEAL = "#1f6f78";
export const SAGE = "#7f9a6e";
export const OCHRE = "#c8962e";
export const AMBERC = "#e07b2a";
export const UNKNOWN = "#d9d4c7";
export const LIME = "#a6e22e";
export const BRASS = "#d4a955";
export const WALNUT = "#3b2a1e";

export interface Layout {
  x: number;
  y: number;
  w: number;
  h: number;
  phone: boolean;
}
export type Anchor = { x: number; y: number; on: boolean };
export type Anchors = Record<string, Anchor | undefined>;
export interface EdgePick {
  i: number;
  dir: number;
}
export interface TilePick {
  i: number;
  /** tile-local position of the hit, −0.5 … 0.5 (x right, y back) */
  lx: number;
  ly: number;
}

export interface View {
  readonly kind: "webgl" | "2d";
  readonly canvas: HTMLCanvasElement;
  resize(w: number, h: number, layout: Layout): void;
  render(dt: number, model: Model): void;
  settle?(dt: number, model: Model): void;
  anchors(): Anchors;
  pick(x: number, y: number, model: Model): TilePick | null;
  hover(e: EdgePick | null): void;
  setShowNumbers(on: boolean): void;
  resetCamera(model?: Model): void;
  cameraPose(): number[];
  setCameraPose(p: number[]): void;
  poke(): void;
  dispose(): void;
}

/** A tap on a tile near one of its edges means that edge (generous: the outer 30% of the tile). */
export function edgeFromHit(h: TilePick, n: number): EdgePick | null {
  const cand = [
    { dir: 0, d: 0.5 - h.ly },
    { dir: 1, d: 0.5 - h.lx },
    { dir: 2, d: h.ly + 0.5 },
    { dir: 3, d: h.lx + 0.5 },
  ].sort((a, b) => a.d - b.d);
  const x = h.i % n, y = (h.i / n) | 0;
  for (const c of cand) {
    if (c.d > 0.3) return null;
    const border = (c.dir === 0 && y === n - 1) || (c.dir === 1 && x === n - 1) || (c.dir === 2 && y === 0) || (c.dir === 3 && x === 0);
    if (!border) return { i: h.i, dir: c.dir };
  }
  return null;
}

// ───────────────────────── world layout ─────────────────────────

/** inner width of the tray (world units); cells are TRAY / n */
export const TRAY = 12;
export const RIM = 0.7;
/** the tallest step of the staircase */
export const HMAX = 2.3;

export const cellSize = (n: number) => TRAY / n;
/** world centre of cell i (x right, z towards the viewer; grid y runs away from the viewer) */
export function cellXZ(i: number, n: number): [number, number] {
  const c = TRAY / n;
  const x = i % n, y = (i / n) | 0;
  return [-TRAY / 2 + (x + 0.5) * c, TRAY / 2 - (y + 0.5) * c];
}
export const baseHeight = (n: number) => Math.max(0.05, 0.16 * cellSize(n));
export const wallRise = (n: number) => Math.max(0.06, 0.24 * cellSize(n));

// ───────────────────────── colour ramp (OKLab, matte) ─────────────────────────

function hex(h: string): [number, number, number] {
  const v = parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const [R, G, B] = [toLin(r), toLin(g), toLin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]: [number, number, number]): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const c = (x: number) => Math.min(1, Math.max(0, toSrgb(Math.min(1, Math.max(0, x)))));
  return [c(R), c(G), c(B)];
}

const RAMP_N = 256;
/** sRGB 0…1 triples, teal (0) → sage → ochre → amber (current maximum) */
export const RAMP = new Float32Array(RAMP_N * 3);
/** the same ramp in linear light (for WebGL instance colours) */
export const RAMP_LIN = new Float32Array(RAMP_N * 3);
{
  const stops = [TEAL, SAGE, OCHRE, AMBERC].map((h) => oklab(hex(h)));
  const at = [0, 0.38, 0.72, 1];
  for (let k = 0; k < RAMP_N; k++) {
    const t = k / (RAMP_N - 1);
    let s = 0;
    while (s < stops.length - 2 && t > at[s + 1]) s++;
    const f = (t - at[s]) / (at[s + 1] - at[s]);
    const L = stops[s].map((v, j) => v + (stops[s + 1][j] - v) * f) as [number, number, number];
    const c = fromOklab(L);
    for (let j = 0; j < 3; j++) {
      RAMP[k * 3 + j] = c[j];
      RAMP_LIN[k * 3 + j] = toLin(c[j]);
    }
  }
}
export const UNKNOWN_RGB = hex(UNKNOWN);
export const UNKNOWN_LIN = UNKNOWN_RGB.map(toLin) as [number, number, number];
export const rampIndex = (d: number, max: number) => Math.min(RAMP_N - 1, Math.max(0, Math.round((d / Math.max(1, max)) * (RAMP_N - 1))));
export function rampCss(d: number, max: number): string {
  if (d === INF) return UNKNOWN;
  const k = rampIndex(d, max) * 3;
  const b = (v: number) => Math.round(v * 255);
  return `rgb(${b(RAMP[k])},${b(RAMP[k + 1])},${b(RAMP[k + 2])})`;
}

// ───────────────────────── shared animation ─────────────────────────

const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Display state both views draw from: per-tile spring heights towards h0 + s·d, a short
 * tumble when a patch is smashed, the lime edge on tiles that changed in the last tick,
 * the trail's fade-in, and the marble's position along the finished trail.
 */
export class Anim {
  n = 0;
  h = new Float32Array(0);
  v = new Float32Array(0);
  glow = new Float32Array(0);
  tumble = new Float32Array(0);
  axis = new Float32Array(0);
  lift = new Float32Array(0);
  /** the height scale (world units per step) */
  s = 0.04;
  /** the number the top of the colour ramp stands for (eases after the field's maximum) */
  colourMax = 1;
  private scaleMax = 1;
  private seenTick = -1;
  private seenSmash = -99;
  private seenEpoch = -1;
  private known = new Uint8Array(0);
  marble = { on: false, x: 0, y: 0, z: 0, rx: 0, rz: 0, appear: 0, roll: 0 };
  private lastMarble = { x: 0, z: 0 };
  reduced = false;
  /** has anything moved this frame (so a still frame can skip work) */
  moving = true;

  private resize(n: number): void {
    const N = n * n;
    this.n = n;
    this.h = new Float32Array(N).fill(baseHeight(n));
    this.v = new Float32Array(N);
    this.glow = new Float32Array(N);
    this.tumble = new Float32Array(N);
    this.axis = new Float32Array(N);
    this.lift = new Float32Array(N);
    this.known = new Uint8Array(N);
    this.seenTick = -1;
  }

  /** the floor-to-top height a tile is heading for */
  target(d: number): number {
    const h0 = baseHeight(this.n);
    return d === INF ? h0 : h0 + this.s * d;
  }

  update(dt: number, m: Model): void {
    if (m.n !== this.n) this.resize(m.n);
    const n = m.n, N = n * n;
    if (m.epoch !== this.seenEpoch) {
      this.seenEpoch = m.epoch;
      this.seenTick = Math.min(this.seenTick, m.ticks);
    }
    // scale: steps stay the same size until the staircase outgrows a 3n-step budget
    const want = Math.max(3 * n, m.fieldMax);
    const ks = 1 - Math.exp(-dt * 3);
    this.scaleMax += (want - this.scaleMax) * (this.reduced ? 1 : ks);
    if (!Number.isFinite(this.scaleMax) || this.scaleMax < 1) this.scaleMax = want;
    this.s = HMAX / this.scaleMax;
    this.colourMax += (Math.max(1, m.fieldMax) - this.colourMax) * (this.reduced ? 1 : 1 - Math.exp(-dt * 6));

    if (m.ev.smash !== this.seenSmash) {
      this.seenSmash = m.ev.smash;
      if (m.smashed || m.smashUndo) {
        let r = (m.smashCount * 2654435761) >>> 0;
        for (const i of m.smashCells) {
          r = (r * 1103515245 + 12345) >>> 0;
          this.tumble[i] = 1;
          this.axis[i] = (r / 4294967296) * Math.PI * 2;
          this.lift[i] = 0.5 + ((r >>> 8) % 100) / 200;
        }
      }
    }

    const fresh = m.ticks !== this.seenTick;
    const kGlow = Math.exp(-dt * Math.max(6, m.tps * 1.4));
    const K = 170, C = this.reduced ? 26 : 13;
    let moving = false;
    for (let i = 0; i < N; i++) {
      const d = m.field[i];
      const tgt = this.target(d);
      if (d !== INF && !this.known[i]) {
        this.known[i] = 1;
        if (!this.reduced) this.v[i] += 1.4 * Math.sqrt(cellSize(n));
      } else if (d === INF) this.known[i] = 0;
      let h = this.h[i], v = this.v[i];
      // semi-implicit spring, sub-stepped for big dt
      const steps = dt > 1 / 50 ? Math.ceil(dt * 60) : 1;
      const sdt = dt / steps;
      for (let k = 0; k < steps; k++) {
        v += (K * (tgt - h) - C * v) * sdt;
        h += v * sdt;
      }
      if (Math.abs(h - tgt) < 1e-4 && Math.abs(v) < 1e-3) {
        h = tgt;
        v = 0;
      } else moving = true;
      if (!Number.isFinite(h)) {
        h = tgt;
        v = 0;
      }
      this.h[i] = h;
      this.v[i] = v;
      let g = this.glow[i] * kGlow;
      if (fresh && m.changeTick[i] > this.seenTick && m.changeTick[i] >= m.ticks - Math.max(1, m.ticksThisFrame) + 1) g = 1;
      if (g < 0.01) g = 0;
      else moving = true;
      this.glow[i] = g;
      if (this.tumble[i] > 0) {
        this.tumble[i] = Math.max(0, this.tumble[i] - dt / (this.reduced ? 0.25 : 0.9));
        moving = true;
      }
    }
    if (fresh) this.seenTick = m.ticks;
    this.updateMarble(dt, m);
    this.moving = moving || this.marble.on;
  }

  /** tumble angle (radians) and lift (world) for tile i */
  tumbleOf(i: number): { a: number; up: number } {
    const t = this.tumble[i];
    if (t <= 0) return { a: 0, up: 0 };
    const p = 1 - t;
    const c = cellSize(this.n);
    const a = Math.sin(p * Math.PI * 2.2) * Math.exp(-p * 3) * 0.75;
    const up = Math.sin(Math.min(1, p * 2.2) * Math.PI) * this.lift[i] * c * 1.2;
    return { a, up };
  }

  /** top surface height of tile i (world) including any lift */
  top(i: number): number {
    return this.h[i] + this.tumbleOf(i).up;
  }

  private updateMarble(dt: number, m: Model): void {
    const mb = this.marble;
    const tr = m.trail;
    if (!m.marbleOn || tr.length < 2) {
      mb.on = false;
      mb.appear = 0;
      return;
    }
    mb.on = true;
    mb.appear = Math.min(1, mb.appear + dt / (this.reduced ? 0.05 : 0.3));
    const n = m.n, c = cellSize(n), r = 0.5 * c;
    const s = Math.min(tr.length - 1, Math.max(0, m.marbleS));
    const k = Math.min(tr.length - 2, Math.floor(s));
    const f = s - k;
    const a = tr[k], b = tr[k + 1];
    const [ax, az] = cellXZ(a, n), [bx, bz] = cellXZ(b, n);
    const ta = this.top(a), tb = this.top(b);
    const e = ease(f);
    mb.x = ax + (bx - ax) * e;
    mb.z = az + (bz - az) * e;
    // roll across the tile, drop off the ledge, a little bounce on landing
    let y: number;
    if (f < 0.5) y = ta;
    else {
      const q = (f - 0.5) / 0.5;
      y = tb + (ta - tb) * Math.max(0, 1 - q * q * 4) + (q > 0.5 ? Math.abs(Math.sin((q - 0.5) * 2 * Math.PI)) * 0.18 * c * (1 - q) * 2 : 0);
    }
    if (m.marbleHome) y = this.top(tr[tr.length - 1]);
    const drop = (1 - ease(mb.appear)) * 2.2;
    mb.y = y + r + drop;
    const dx = mb.x - this.lastMarble.x, dz = mb.z - this.lastMarble.z;
    if (Math.hypot(dx, dz) < c * 2) {
      mb.rz -= dx / r;
      mb.rx += dz / r;
    }
    this.lastMarble = { x: mb.x, z: mb.z };
  }

  finite(): boolean {
    for (let i = 0; i < this.h.length; i++) if (!Number.isFinite(this.h[i]) || !Number.isFinite(this.v[i])) return false;
    return Number.isFinite(this.s) && Number.isFinite(this.marble.y);
  }
}

export const fmt = (x: number) => x.toLocaleString("en-US");

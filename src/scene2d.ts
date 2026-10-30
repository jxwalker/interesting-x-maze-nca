/**
 * Canvas2D fallback: the same tray drawn in a simple oblique view (tiles rise as stacked
 * rectangles, back rows first). Same engine, same animation, same controls.
 */
import { INF, hasWall } from "./maze";
import type { Model } from "./model";
import { Anim, HMAX, LIME, RIM, TRAY, cellSize, cellXZ, rampCss, wallRise, type Anchors, type EdgePick, type Layout, type TilePick, type View } from "./view";

const DEPTH = 0.62;
const RISE = 0.55;

function shade(css: string, f: number): string {
  const m = css.match(/\d+/g);
  if (!m) return css;
  const [r, g, b] = m.map(Number);
  return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
}

export class Scene2D implements View {
  readonly kind = "2d" as const;
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private W = 1;
  private H = 1;
  private dpr = 1;
  private k = 20;
  private cx = 0;
  private cy = 0;
  readonly anim = new Anim();
  private hoverEdge: EdgePick | null = null;
  private showNum = false;
  private anchorMap: Anchors = {};

  constructor(host: HTMLElement) {
    this.canvas = document.createElement("canvas");
    host.appendChild(this.canvas);
    this.g = this.canvas.getContext("2d")!;
    this.anim.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  resize(w: number, h: number, L: Layout): void {
    this.W = w;
    this.H = h;
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    const E = TRAY + 2 * RIM;
    this.k = Math.min((L.w * 0.94) / E, (L.h * 0.92) / (E * DEPTH + HMAX * RISE * 0.8));
    this.cx = L.x + L.w / 2;
    this.cy = L.y + L.h / 2 + (HMAX * RISE * 0.8 * this.k) / 2;
  }

  private sx(x: number): number {
    return this.cx + x * this.k;
  }
  private sy(z: number, y: number): number {
    return this.cy + z * this.k * DEPTH - y * this.k * RISE;
  }

  render(dt: number, m: Model): void {
    this.anim.update(dt, m);
    const g = this.g, k = this.k, a = this.anim, n = m.n, c = cellSize(n);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const bg = g.createLinearGradient(0, 0, 0, this.H);
    bg.addColorStop(0, "#0c1628");
    bg.addColorStop(1, "#0a0b0e");
    g.fillStyle = bg;
    g.fillRect(0, 0, this.W, this.H);

    // tray
    const E = TRAY / 2 + RIM;
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fillRect(this.sx(-E) + 8, this.sy(-E, 0) + 10, 2 * E * k, 2 * E * k * DEPTH);
    g.fillStyle = "#e9dfc8";
    g.fillRect(this.sx(-E), this.sy(-E, 0), 2 * E * k, 2 * E * k * DEPTH);
    g.fillStyle = "#cbbfa5";
    g.fillRect(this.sx(-E), this.sy(E, 0), 2 * E * k, 0.3 * k);
    g.fillStyle = "#2b231c";
    g.fillRect(this.sx(-TRAY / 2), this.sy(-TRAY / 2, 0), TRAY * k, TRAY * k * DEPTH);

    const tw = 0.9 * c * k, td = 0.9 * c * k * DEPTH;
    const wt = Math.max(1.5, 0.12 * c * k);
    const rise = wallRise(n);
    const top = (i: number) => a.top(i);
    const colourMax = a.colourMax;
    const wallC = "#3b2a1e", wallTop = "#7a5638";
    const drawWallX = (x0: number, z: number, h: number) => {
      // a wall running left-right at depth z
      // a ridge: a short dark face under a lit top strip
      const X = this.sx(x0), Y1 = this.sy(z, h), Y0 = this.sy(z, Math.max(0, h - rise * 1.6));
      g.fillStyle = wallC;
      g.fillRect(X, Y1, c * k, Y0 - Y1);
      g.fillStyle = wallTop;
      g.fillRect(X, Y1 - wt * DEPTH * 0.5, c * k, wt * DEPTH);
    };
    const drawWallZ = (x: number, z0: number, h: number) => {
      // a wall running front-back at x, from z0 (back) one cell forward
      const X = this.sx(x) - wt / 2;
      const Yb = this.sy(z0, h), Yf = this.sy(z0 + c, h), Y0 = this.sy(z0 + c, Math.max(0, h - rise * 1.6));
      g.fillStyle = wallC;
      g.fillRect(X, Yf, wt, Y0 - Yf);
      g.fillStyle = wallTop;
      g.fillRect(X, Yb, wt, Yf - Yb);
    };

    for (let y = n - 1; y >= 0; y--) {
      // walls at the back edge of this row stand behind its tiles
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (hasWall(m.maze, i, 0)) {
          const h = Math.max(top(i), y < n - 1 ? top(i + n) : 0) + rise;
          drawWallX(-TRAY / 2 + x * c, TRAY / 2 - (y + 1) * c, h);
        }
      }
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const [wx, wz] = cellXZ(i, n);
        const h = top(i);
        const d = m.field[i];
        const col = rampCss(d, colourMax);
        const X = this.sx(wx) - tw / 2;
        const Yt = this.sy(wz, h) - td / 2;
        const Yf = this.sy(wz + 0.45 * c, h);
        const Yb = this.sy(wz + 0.45 * c, 0);
        g.fillStyle = shade(col, 0.7);
        g.fillRect(X, Yf, tw, Yb - Yf);
        g.fillStyle = col;
        g.fillRect(X, Yt, tw, td);
        if (a.glow[i] > 0.05) {
          g.strokeStyle = `rgba(166,226,46,${a.glow[i]})`;
          g.lineWidth = Math.max(1, tw * 0.08);
          g.strokeRect(X + 0.5, Yt + 0.5, tw - 1, td - 1);
        }
        if (m.showCone && m.inCone(i)) {
          g.strokeStyle = "rgba(226,180,90,0.7)";
          g.lineWidth = 1;
          g.strokeRect(X + 1.5, Yt + 1.5, tw - 3, td - 3);
        }
        if (this.showNum && d !== INF && tw > 15) {
          g.fillStyle = "#241c14";
          g.font = `700 ${Math.round(Math.min(td * 0.8, tw * (d >= 100 ? 0.36 : 0.5)))}px ui-monospace, Menlo, monospace`;
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.fillText(String(d), X + tw / 2, Yt + td / 2 + 1);
        } else if (d === INF && tw > 12) {
          g.fillStyle = "rgba(60,50,40,0.18)";
          g.font = `700 ${Math.round(td * 0.7)}px ui-monospace, Menlo, monospace`;
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.fillText("?", X + tw / 2, Yt + td / 2 + 1);
        }
      }
      // walls between tiles of this row, then the front border
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (x === 0) drawWallZ(-TRAY / 2, TRAY / 2 - (y + 1) * c, top(i) + rise);
        if (hasWall(m.maze, i, 1)) drawWallZ(-TRAY / 2 + (x + 1) * c, TRAY / 2 - (y + 1) * c, Math.max(top(i), x < n - 1 ? top(i + 1) : 0) + rise);
        if (y === 0) drawWallX(-TRAY / 2 + x * c, TRAY / 2, top(i) + rise);
      }
    }

    // trail: down the staircase, glowing lime
    const tr = m.trail;
    if (tr.length) {
      g.save();
      g.strokeStyle = LIME;
      g.lineWidth = Math.max(2, 0.12 * c * k);
      g.lineJoin = "round";
      g.lineCap = "round";
      g.shadowColor = "rgba(166,226,46,0.9)";
      g.shadowBlur = 10;
      g.beginPath();
      for (let s = 0; s < tr.length; s++) {
        const [x, z] = cellXZ(tr[s], n);
        const X = this.sx(x), Y = this.sy(z, top(tr[s]));
        if (s === 0) g.moveTo(X, Y);
        else {
          const [px, pz] = cellXZ(tr[s - 1], n);
          const mx = (px + x) / 2, mz = (pz + z) / 2;
          g.lineTo(this.sx(mx), this.sy(mz, top(tr[s - 1])));
          g.lineTo(this.sx(mx), this.sy(mz, top(tr[s])));
          g.lineTo(X, Y);
        }
      }
      g.stroke();
      g.restore();
    }

    // pin and flag
    const [px, pz] = cellXZ(m.start, n);
    const pinX = this.sx(px), pinY = this.sy(pz, top(m.start));
    const u = Math.max(0.42, c) * k;
    g.fillStyle = "#c79a45";
    g.fillRect(pinX - u * 0.1, pinY - u * 1.2, u * 0.2, u * 1.2);
    g.beginPath();
    g.arc(pinX, pinY - u * 1.3, u * 0.3, 0, Math.PI * 2);
    g.fillStyle = "#e3bd6a";
    g.fill();
    const [fx, fz] = cellXZ(m.goal, n);
    const flX = this.sx(fx), flY = this.sy(fz, top(m.goal));
    g.fillStyle = "#b8653a";
    g.fillRect(flX - u * 0.06, flY - u * 2.6, u * 0.12, u * 2.6);
    g.beginPath();
    g.moveTo(flX, flY - u * 2.6);
    g.lineTo(flX + u * 1.2, flY - u * 2.25);
    g.lineTo(flX, flY - u * 1.9);
    g.closePath();
    g.fillStyle = "#d27a45";
    g.fill();

    // marble
    const mb = a.marble;
    if (mb.on) {
      const X = this.sx(mb.x), Y = this.sy(mb.z, mb.y);
      const r = Math.max(4, 0.34 * c * k);
      const grd = g.createRadialGradient(X - r * 0.3, Y - r * 0.3, r * 0.1, X, Y, r);
      grd.addColorStop(0, "#efffc0");
      grd.addColorStop(0.5, "#a6e22e");
      grd.addColorStop(1, "#4f8a12");
      g.save();
      g.shadowColor = "rgba(166,226,46,0.9)";
      g.shadowBlur = 14;
      g.fillStyle = grd;
      g.beginPath();
      g.arc(X, Y, r, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    // hovered edge
    const e = this.hoverEdge;
    if (e && e.i < m.N) {
      const [x, z] = cellXZ(e.i, n);
      const h = top(e.i) + rise;
      g.strokeStyle = hasWall(m.maze, e.i, e.dir) ? "#c9f07a" : "rgba(220,190,150,0.9)";
      g.lineWidth = 3;
      g.beginPath();
      const half = c / 2;
      if (e.dir === 0 || e.dir === 2) {
        const zz = z + (e.dir === 0 ? -half : half);
        g.moveTo(this.sx(x - half), this.sy(zz, h));
        g.lineTo(this.sx(x + half), this.sy(zz, h));
      } else {
        const xx = x + (e.dir === 1 ? half : -half);
        g.moveTo(this.sx(xx), this.sy(z - half, h));
        g.lineTo(this.sx(xx), this.sy(z + half, h));
      }
      g.stroke();
    }

    // anchors
    const A: Anchors = {};
    A.start = { x: pinX, y: pinY - u * 1.5, on: true };
    A.goal = { x: flX + u * 0.5, y: flY - u * 2.4, on: true };
    const pt = (i: number) => {
      const [x, z] = cellXZ(i, n);
      return { x: this.sx(x), y: this.sy(z, top(i)), on: true };
    };
    if (tr.length > 6) A.rule = pt(tr[Math.floor(tr.length * 0.7)]);
    if (m.smashed && m.smashCells.length) A.smash = pt(m.smashCells[Math.floor(m.smashCells.length / 2)]);
    if (m.playing && !m.fixed) {
      let best = -1, bd = -1;
      for (let i = 0; i < m.N; i++) if (a.glow[i] > 0.6 && m.field[i] !== INF && m.field[i] > bd) (bd = m.field[i]), (best = i);
      if (best >= 0) A.front = pt(best);
    }
    this.anchorMap = A;
  }

  settle(dt: number, m: Model): void {
    this.anim.update(dt, m);
  }

  pick(px: number, py: number, m: Model): TilePick | null {
    const rect = this.canvas.getBoundingClientRect();
    const X = px - rect.left, Y = py - rect.top;
    const n = m.n, c = cellSize(n), k = this.k;
    // front rows are drawn last, so test them first
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const [wx, wz] = cellXZ(i, n);
        const h = this.anim.top(i);
        const L = this.sx(wx) - (c * k) / 2;
        const T = this.sy(wz, h) - (c * k * DEPTH) / 2;
        const Bf = this.sy(wz + 0.45 * c, 0);
        if (X >= L && X <= L + c * k && Y >= T && Y <= Bf) {
          const ly = Y <= T + c * k * DEPTH ? 0.5 - (Y - T) / (c * k * DEPTH) : -0.5;
          return { i, lx: (X - L) / (c * k) - 0.5, ly };
        }
      }
    return null;
  }

  hover(e: EdgePick | null): void {
    this.hoverEdge = e;
  }
  setShowNumbers(on: boolean): void {
    this.showNum = on;
  }
  anchors(): Anchors {
    return this.anchorMap;
  }
  resetCamera(): void {}
  cameraPose(): number[] {
    return [0, 0, 0, 0, 0, 0];
  }
  setCameraPose(): void {}
  poke(): void {}
  dispose(): void {
    this.canvas.remove();
  }
}

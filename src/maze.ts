/**
 * The maths, pure and renderer-free: seeded RNG, maze generation, the one local rule
 * ("my number = 1 + my smallest open neighbour's number") with a wake mask and a double
 * buffer, breadth-first search as a reference, trail extraction, damage, wall toggles, counts.
 *
 * Cells are numbered i = y·n + x. y = 0 is the front row; the start (brass pin) is cell 0
 * (front-left) and the goal (copper flag) is cell n² − 1 (back-right).
 *
 * BFS here is only a referee: the display is driven by the field the local rule produces.
 */

export const INF = Infinity;

/** directions: 0 = back (+y), 1 = right (+x), 2 = front (−y), 3 = left (−x) */
export const DX = [0, 1, 0, -1] as const;
export const DY = [1, 0, -1, 0] as const;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix two integers into a new 32-bit seed (so every action gets its own reproducible stream). */
export function mixSeed(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (b + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Walls on tile edges. wallE[i] = 1: wall between (x, y) and (x + 1, y).
 * wallN[i] = 1: wall between (x, y) and (x, y + 1). The outer border is always closed.
 */
export interface Maze {
  n: number;
  wallE: Uint8Array;
  wallN: Uint8Array;
}

export const startOf = (_n: number) => 0;
export const goalOf = (n: number) => n * n - 1;

export function cloneMaze(m: Maze): Maze {
  return { n: m.n, wallE: m.wallE.slice(), wallN: m.wallN.slice() };
}

export function sameWalls(a: Maze, b: Maze): boolean {
  if (a.n !== b.n) return false;
  for (let i = 0; i < a.n * a.n; i++) if (a.wallE[i] !== b.wallE[i] || a.wallN[i] !== b.wallN[i]) return false;
  return true;
}

/** Is there a wall (or the border) on side `dir` of cell i? */
export function hasWall(m: Maze, i: number, dir: number): boolean {
  const n = m.n, x = i % n, y = (i / n) | 0;
  switch (dir) {
    case 0:
      return y === n - 1 || m.wallN[i] === 1;
    case 1:
      return x === n - 1 || m.wallE[i] === 1;
    case 2:
      return y === 0 || m.wallN[i - n] === 1;
    default:
      return x === 0 || m.wallE[i - 1] === 1;
  }
}

/**
 * A perfect maze (a spanning tree of the grid) by randomized depth-first search, the
 * "growing tree" form: usually carry on from the newest cell (the recursive backtracker),
 * with probability `branch` restart from a random open cell, which gives more side branches
 * and shorter corridors. Deterministic for (n, seed, branch).
 */
export function generateMaze(n: number, seed: number, branch = 0.35): Maze {
  const N = n * n;
  const wallE = new Uint8Array(N).fill(1);
  const wallN = new Uint8Array(N).fill(1);
  const seen = new Uint8Array(N);
  const rnd = mulberry32(seed);
  const active: number[] = [0];
  seen[0] = 1;
  const opts: number[] = [];
  while (active.length) {
    const k = rnd() < branch ? Math.floor(rnd() * active.length) : active.length - 1;
    const c = active[k];
    const x = c % n, y = (c / n) | 0;
    opts.length = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      if (!seen[ny * n + nx]) opts.push(d);
    }
    if (!opts.length) {
      active.splice(k, 1);
      continue;
    }
    const d = opts[Math.floor(rnd() * opts.length)];
    const j = (y + DY[d]) * n + (x + DX[d]);
    setWall({ n, wallE, wallN }, c, d, false);
    seen[j] = 1;
    active.push(j);
  }
  return { n, wallE, wallN };
}

/** Set or clear the wall on side `dir` of cell i (no-op on the border). */
export function setWall(m: Maze, i: number, dir: number, on: boolean): void {
  const n = m.n, x = i % n, y = (i / n) | 0;
  const v = on ? 1 : 0;
  if (dir === 0 && y < n - 1) m.wallN[i] = v;
  else if (dir === 1 && x < n - 1) m.wallE[i] = v;
  else if (dir === 2 && y > 0) m.wallN[i - n] = v;
  else if (dir === 3 && x > 0) m.wallE[i - 1] = v;
}

export function toggleWall(m: Maze, i: number, dir: number): boolean {
  const on = !hasWall(m, i, dir);
  setWall(m, i, dir, on);
  return on;
}

/** An interior edge: the cell on its left/front side and the direction (1 = right, 0 = back). */
export interface Edge {
  i: number;
  dir: 0 | 1;
}

/**
 * Knock out k interior walls (the same seeded order every time, so k + 1 shortcuts keep the
 * first k). Each knocked-out wall makes a loop, so there can be several routes.
 */
export function addShortcuts(base: Maze, k: number, seed: number): Maze {
  const m = cloneMaze(base);
  if (k <= 0) return m;
  const n = m.n;
  const walls: Edge[] = [];
  for (let i = 0; i < n * n; i++) {
    const x = i % n, y = (i / n) | 0;
    if (x < n - 1 && m.wallE[i]) walls.push({ i, dir: 1 });
    if (y < n - 1 && m.wallN[i]) walls.push({ i, dir: 0 });
  }
  const rnd = mulberry32(mixSeed(seed, 0x5c0de));
  for (let a = walls.length - 1; a > 0; a--) {
    const b = Math.floor(rnd() * (a + 1));
    [walls[a], walls[b]] = [walls[b], walls[a]];
  }
  // prefer walls whose removal saves a real detour (both sides far apart along the maze)
  const adj = adjacency(m);
  const d0 = bfs(adj, n, 0);
  const useful = walls.filter((e) => {
    const j = e.dir === 1 ? e.i + 1 : e.i + n;
    return Math.abs(d0[e.i] - d0[j]) >= 12;
  });
  const pool = useful.length >= k ? useful : walls;
  for (let t = 0; t < Math.min(k, pool.length); t++) setWall(m, pool[t].i, pool[t].dir, false);
  return m;
}

/** Open-neighbour table: adj[4i + dir] = neighbour cell or −1 (wall or border). */
export function adjacency(m: Maze): Int32Array {
  const n = m.n, N = n * n;
  const adj = new Int32Array(N * 4).fill(-1);
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < 4; d++) {
      if (hasWall(m, i, d)) continue;
      adj[4 * i + d] = i + DX[d] + DY[d] * n;
    }
  }
  return adj;
}

/** Number of open interior edges. A perfect maze has exactly cells − 1. */
export function openEdges(m: Maze): number {
  const n = m.n;
  let e = 0;
  for (let i = 0; i < n * n; i++) {
    const x = i % n, y = (i / n) | 0;
    if (x < n - 1 && !m.wallE[i]) e++;
    if (y < n - 1 && !m.wallN[i]) e++;
  }
  return e;
}

/** True step distances from `from` by breadth-first search (Infinity where unreachable). Reference only. */
export function bfs(adj: Int32Array, n: number, from: number): Float64Array {
  const N = n * n;
  const d = new Float64Array(N).fill(INF);
  const q = new Int32Array(N);
  let h = 0, t = 0;
  d[from] = 0;
  q[t++] = from;
  while (h < t) {
    const c = q[h++];
    for (let k = 0; k < 4; k++) {
      const j = adj[4 * c + k];
      if (j >= 0 && d[j] === INF) {
        d[j] = d[c] + 1;
        q[t++] = j;
      }
    }
  }
  return d;
}

export function maxFinite(d: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < d.length; i++) if (d[i] !== INF && d[i] > m) m = d[i];
  return m;
}

export function countFinite(d: ArrayLike<number>): number {
  let c = 0;
  for (let i = 0; i < d.length; i++) if (d[i] !== INF) c++;
  return c;
}

/** Tiles whose number differs from the exact distance. */
export function countWrong(d: ArrayLike<number>, truth: ArrayLike<number>): number {
  let c = 0;
  for (let i = 0; i < d.length; i++) if (d[i] !== truth[i]) c++;
  return c;
}

/** The field before anyone knows anything: the start is 0, everyone else "don't know". */
export function freshField(n: number, start = 0): Float64Array {
  const d = new Float64Array(n * n).fill(INF);
  d[start] = 0;
  return d;
}

/**
 * Fill a wake mask: each tile independently wakes with probability p. Returns how many woke.
 * p ≥ 1 wakes everyone (synchronous mode) without touching the RNG.
 */
export function wakeMask(mask: Uint8Array, p: number, rnd: () => number): number {
  let c = 0;
  if (p >= 1) {
    mask.fill(1);
    return mask.length;
  }
  for (let i = 0; i < mask.length; i++) {
    const w = rnd() < p ? 1 : 0;
    mask[i] = w;
    c += w;
  }
  return c;
}

/**
 * One tick of the local rule. Every woken tile (except the start, which is always 0) looks
 * only at its open neighbours in `prev` (the field at the START of the tick) and writes
 *   next = 1 + min(neighbour numbers)
 * into `next`. It never keeps its own old value, so wrong numbers cannot hide; a tile whose
 * neighbours all say "don't know" becomes "don't know" too. A number of n² or more is
 * impossible (no route visits a tile twice), so it is read as "don't know".
 * Sleeping tiles copy their value across. `changed[i]` = 1 where the number changed.
 * Returns the number of tiles that changed.
 */
export function tick(adj: Int32Array, n: number, prev: Float64Array, next: Float64Array, wake: Uint8Array | null, changed: Uint8Array, start = 0): number {
  const N = n * n;
  const cap = N;
  let c = 0;
  for (let i = 0; i < N; i++) {
    let v = prev[i];
    if (i === start) v = 0;
    else if (!wake || wake[i]) {
      let m = INF;
      const b = 4 * i;
      for (let k = 0; k < 4; k++) {
        const j = adj[b + k];
        if (j >= 0) {
          const dj = prev[j];
          if (dj < m) m = dj;
        }
      }
      v = m + 1;
      if (v >= cap) v = INF;
    }
    next[i] = v;
    const ch = v !== prev[i] ? 1 : 0;
    changed[i] = ch;
    c += ch;
  }
  return c;
}

/** Run synchronous ticks until nothing changes (or `limit` ticks). Returns ticks until no change was seen. */
export function settleSync(adj: Int32Array, n: number, field: Float64Array, limit: number, start = 0): { field: Float64Array; ticks: number; settled: boolean } {
  let a: Float64Array = field.slice(), b: Float64Array = new Float64Array(a.length);
  const ch = new Uint8Array(a.length);
  for (let t = 1; t <= limit; t++) {
    const c = tick(adj, n, a, b, null, ch, start);
    [a, b] = [b, a];
    if (c === 0) return { field: a, ticks: t, settled: true };
  }
  return { field: a, ticks: limit, settled: false };
}

// ───────────────────────── the trail: walk downhill, one tile per tick ─────────────────────────

/** Is the move a → b an open step that goes down by exactly 1? */
export function downStep(adj: Int32Array, d: ArrayLike<number>, a: number, b: number): boolean {
  if (d[a] === INF || d[b] !== d[a] - 1) return false;
  for (let k = 0; k < 4; k++) if (adj[4 * a + k] === b) return true;
  return false;
}

/**
 * Advance the trail by one tick. The trail lives on the tiles: it starts at the goal once the
 * goal has a number, every link must still go down by exactly 1 through an open edge (it is
 * cut at the first link that no longer does, e.g. after damage), and the head marks one
 * neighbour exactly one lower (ties broken in a fixed order: back, right, front, left).
 * Returns true if the trail changed.
 */
export function trailStep(adj: Int32Array, d: ArrayLike<number>, trail: number[], goal: number, start: number): boolean {
  const before = trail.length;
  let cut = false;
  if (!trail.length || trail[0] !== goal || d[goal] === INF) {
    cut = trail.length > 0;
    trail.length = 0;
  } else {
    for (let k = 1; k < trail.length; k++) {
      if (!downStep(adj, d, trail[k - 1], trail[k])) {
        trail.length = k;
        cut = true;
        break;
      }
    }
  }
  if (!trail.length) {
    if (d[goal] === INF) return cut;
    trail.push(goal);
    return true;
  }
  const h = trail[trail.length - 1];
  if (h === start) return cut || trail.length !== before;
  for (let k = 0; k < 4; k++) {
    const j = adj[4 * h + k];
    if (j >= 0 && downStep(adj, d, h, j)) {
      trail.push(j);
      return true;
    }
  }
  return cut;
}

/** The whole downhill walk from the goal (what trailStep builds one tick at a time). */
export function extractTrail(adj: Int32Array, d: ArrayLike<number>, goal: number, start: number): number[] {
  const t: number[] = [];
  for (let s = 0; s < d.length + 2; s++) if (!trailStep(adj, d, t, goal, start)) break;
  return t;
}

/** Every link opens onto a neighbour and goes down by exactly 1, ending at the start. */
export function trailValid(adj: Int32Array, d: ArrayLike<number>, t: number[], goal: number, start: number): boolean {
  if (!t.length || t[0] !== goal || t[t.length - 1] !== start) return false;
  for (let k = 1; k < t.length; k++) if (!downStep(adj, d, t[k - 1], t[k])) return false;
  return true;
}

// ───────────────────────── damage ─────────────────────────

/** The k × k block of cells centred (as near as fits) on cell c. */
export function patchAround(n: number, c: number, k = 5): number[] {
  const h = Math.floor(k / 2);
  const kk = Math.min(k, n);
  const x0 = Math.max(0, Math.min(n - kk, (c % n) - h));
  const y0 = Math.max(0, Math.min(n - kk, ((c / n) | 0) - h));
  const out: number[] = [];
  for (let y = y0; y < y0 + kk; y++) for (let x = x0; x < x0 + kk; x++) out.push(y * n + x);
  return out;
}

/**
 * Scramble a patch: every tile in it (except the start, which is fixed at 0) gets a WRONG
 * number: "don't know", too small (the hard case: it looks like a shortcut that isn't there)
 * or too large. Returns the cells that were scrambled.
 */
export function smash(d: Float64Array, cells: number[], rnd: () => number, start = 0): number[] {
  const out: number[] = [];
  for (const i of cells) {
    if (i === start) continue;
    const v = d[i];
    let w: number;
    const r = rnd();
    if (v === INF) w = r < 0.45 ? 1 + Math.floor(rnd() * 12) : r < 0.75 ? 4 + Math.floor(rnd() * 20) : INF;
    else if (r < 0.38) w = INF;
    else if (r < 0.74) w = Math.max(1, v - 2 - Math.floor(rnd() * 9));
    else w = v + 3 + Math.floor(rnd() * 18);
    if (w === v) w = v === INF ? 1 : v + 7;
    d[i] = w;
    out.push(i);
  }
  return out;
}

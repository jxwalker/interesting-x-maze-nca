/** window.__mazeSelfTest(): every check recomputes from maze.ts; nothing is a stored answer. */
import {
  INF,
  addShortcuts,
  adjacency,
  bfs,
  extractTrail,
  freshField,
  generateMaze,
  maxFinite,
  mixSeed,
  mulberry32,
  openEdges,
  patchAround,
  sameWalls,
  settleSync,
  smash,
  tick,
  toggleWall,
  trailValid,
  wakeMask,
  type Maze,
} from "./maze";
import { BRANCH, DEFAULTS, Model } from "./model";
import { Anim } from "./view";

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return a.length === b.length;
};

/** run ticks with wake probability p until the field equals `truth` (or `limit`); returns ticks used or −1 */
function runUntil(adj: Int32Array, n: number, field: Float64Array, truth: Float64Array, p: number, seed: number, limit: number): number {
  let a: Float64Array = field.slice(), b: Float64Array = new Float64Array(a.length);
  const ch = new Uint8Array(a.length), wake = new Uint8Array(a.length);
  const rnd = mulberry32(seed);
  if (same(a, truth)) return 0;
  for (let t = 1; t <= limit; t++) {
    wakeMask(wake, p, rnd);
    tick(adj, n, a, b, wake, ch, 0);
    [a, b] = [b, a];
    if (same(a, truth)) {
      field.set(a);
      return t;
    }
  }
  field.set(a);
  return -1;
}

export function selfTest(extra: () => Check[] = () => []): { pass: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const n = DEFAULTS.size, N = n * n, goal = N - 1;
  const maze = generateMaze(n, DEFAULTS.seed, BRANCH);
  const adj = adjacency(maze);
  const truth = bfs(adj, n, 0);
  const maxD = maxFinite(truth);

  {
    const e = openEdges(maze);
    const reach = truth.every((v) => v !== INF);
    const again = generateMaze(n, DEFAULTS.seed, BRANCH);
    const other = generateMaze(n, DEFAULTS.seed + 1, BRANCH);
    add("default 24 × 24 maze is perfect: connected, open edges = cells − 1", reach && e === N - 1, `${e} open edges for ${N} cells, every tile reachable: ${reach}`);
    add("maze is deterministic for its seed", sameWalls(maze, again) && !sameWalls(maze, other), `seed ${DEFAULTS.seed} regenerates identically; seed ${DEFAULTS.seed + 1} differs`);
    // a perfect maze has exactly one route: removing any edge on it disconnects start and goal
    const route = extractTrail(adj, truth, goal, 0);
    let unique = true;
    for (let k = 1; k < route.length && unique; k++) {
      const m2: Maze = { n, wallE: maze.wallE.slice(), wallN: maze.wallN.slice() };
      const a = route[k - 1], b = route[k];
      const dir = b === a + n ? 0 : b === a + 1 ? 1 : b === a - n ? 2 : 3;
      toggleWall(m2, a, dir);
      if (bfs(adjacency(m2), n, 0)[goal] !== INF) unique = false;
    }
    add("exactly one route from pin to flag in the default maze", unique, `blocking any of its ${route.length - 1} links cuts the flag off`);
  }
  {
    const r = settleSync(adj, n, freshField(n), 4 * N);
    const ok = same(r.field, truth);
    add("everyone-together (p = 1): field = BFS distances on every tile", ok, `settled after ${r.ticks} ticks`);
    add("…and settles in at most maxDistance + 1 ticks", r.ticks <= maxD + 1, `${r.ticks} ticks ≤ ${maxD + 1} (max distance ${maxD})`);
  }
  {
    const f = freshField(n);
    const t = runUntil(adj, n, f, truth, 0.3, 4242, 40 * N);
    add("30% awake per tick (seed 4242): still converges to BFS distances", t > 0, t > 0 ? `${t} ticks (sync needs ${maxD}; ≈ 1/p slower = ${Math.round(maxD / 0.3)})` : "did not converge");
  }
  {
    let a: Float64Array = freshField(n), b: Float64Array = new Float64Array(N);
    const ch = new Uint8Array(N);
    let bad = 0;
    for (let t = 1; t <= maxD + 2; t++) {
      tick(adj, n, a, b, null, ch, 0);
      [a, b] = [b, a];
      for (let i = 0; i < N; i++) if (truth[i] > t && a[i] !== INF) bad++;
      for (let i = 0; i < N; i++) if (truth[i] <= t && a[i] !== truth[i]) bad++;
    }
    add("information speed: after t ticks no tile further than t has a number (and every tile within t is right)", bad === 0, bad ? `${bad} violations` : `checked t = 1 … ${maxD + 2}`);
  }
  {
    const tr = extractTrail(adj, truth, goal, 0);
    const ok = trailValid(adj, truth, tr, goal, 0) && tr.length - 1 === truth[goal];
    add("trail: walks down by exactly 1 through open edges, length = BFS shortest", ok, `${tr.length - 1} steps, BFS says ${truth[goal]}`);
  }
  {
    const m20 = addShortcuts(maze, 20, DEFAULTS.seed);
    const adj20 = adjacency(m20);
    const t20 = bfs(adj20, n, 0);
    const r = settleSync(adj20, n, freshField(n), 4 * N);
    const tr = extractTrail(adj20, r.field, goal, 0);
    const ok = same(r.field, t20) && trailValid(adj20, r.field, tr, goal, 0) && tr.length - 1 === t20[goal];
    add("20 shortcuts (loops): the trail is still a shortest route", ok && openEdges(m20) === N - 1 + 20, `${openEdges(m20) - (N - 1)} loops; trail ${tr.length - 1} steps = BFS ${t20[goal]} (was ${truth[goal]} without shortcuts)`);
  }
  {
    const f = truth.slice();
    const centre = extractTrail(adj, truth, goal, 0)[Math.floor(truth[goal] * 0.45)];
    const cells = patchAround(n, centre, 5);
    const before = f.slice();
    smash(f, cells, mulberry32(mixSeed(DEFAULTS.seed, 0xbad)), 0);
    let small = 0, inf = 0;
    for (const i of cells) {
      if (f[i] !== INF && f[i] < before[i]) small++;
      if (f[i] === INF) inf++;
    }
    const scrambled = cells.filter((i) => f[i] !== before[i]).length;
    const f1 = f.slice();
    const t1 = runUntil(adj, n, f1, truth, 1, 1, N);
    const t5 = runUntil(adj, n, f.slice(), truth, 0.5, 77, N);
    add("smash a 5 × 5 patch (with too-small numbers): heals back to BFS within N² ticks", t1 > 0 && t5 > 0 && small > 0 && scrambled === cells.length, `${scrambled} scrambled (${small} too small, ${inf} don't-know); healed in ${t1} ticks everyone-together, ${t5} ticks at 50% awake (limit ${N})`);
  }
  {
    // remove a wall (makes a loop and new shorter routes) and add one (cuts tiles off)
    const m2: Maze = { n, wallE: maze.wallE.slice(), wallN: maze.wallN.slice() };
    let opened = -1;
    for (let i = 0; i < N && opened < 0; i++) if (i % n < n - 1 && m2.wallE[i] && Math.abs(truth[i] - truth[i + 1]) > 20) opened = i;
    m2.wallE[opened] = 0;
    const adj2 = adjacency(m2), tr2 = bfs(adj2, n, 0);
    const f = truth.slice();
    const tOpen = runUntil(adj2, n, f, tr2, 0.5, 9, N);
    const m3: Maze = { n, wallE: maze.wallE.slice(), wallN: maze.wallN.slice() };
    const route = extractTrail(adj, truth, goal, 0);
    const a = route[route.length - 6], b = route[route.length - 7];
    const dir = b === a + n ? 0 : b === a + 1 ? 1 : b === a - n ? 2 : 3;
    toggleWall(m3, a, dir);
    const adj3 = adjacency(m3), tr3 = bfs(adj3, n, 0);
    const cut = tr3.filter((v) => v === INF).length;
    const g = truth.slice();
    const tCut = runUntil(adj3, n, g, tr3, 1, 3, 2 * N);
    add("toggling a wall re-converges to the new BFS distances", tOpen > 0 && tCut > 0, `opened a wall: ${tOpen} ticks; closed one cutting ${cut} tiles off: ${tCut} ticks (they count up until n² = ${N}, then give up)`);
  }
  {
    const m64 = generateMaze(64, DEFAULTS.seed, BRANCH);
    const a64 = adjacency(m64);
    const t64 = bfs(a64, 64, 0);
    const r = settleSync(a64, 64, freshField(64), 64 * 64);
    add("64 × 64 board converges (same rule, bigger board)", same(r.field, t64) && r.ticks <= maxFinite(t64) + 1, `${r.ticks} ticks, shortest way out ${t64[64 * 64 - 1]} steps`);
  }
  {
    // the live engine and animation stay finite at every setting
    const m = new Model();
    const an = new Anim();
    let bad = "";
    for (const size of [12, 64])
      for (const wake of [0.1, 1])
        for (const sc of [0, 20]) {
          m.reset();
          m.setSize(size);
          m.setWake(wake);
          m.setShortcuts(sc);
          m.togglePlay();
          for (let f = 0; f < 40; f++) {
            m.step(1 / 30);
            an.update(1 / 30, m);
          }
          m.smashAt(m.defaultPatchCentre());
          for (let f = 0; f < 10; f++) {
            m.step(1 / 30);
            an.update(1 / 30, m);
          }
          if (!an.finite() || !m.finite()) bad += `n${size} p${wake} k${sc} `;
        }
    add("no NaN in heights or numbers (board 12–64, wake 10–100%, 0–20 shortcuts)", bad === "", bad || "all finite");
  }
  checks.push(...extra());
  return { pass: checks.every((c) => c.pass), checks };
}

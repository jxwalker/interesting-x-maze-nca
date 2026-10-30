/**
 * App state around the pure maths in maze.ts: the current maze and field, play / step, the
 * tick clock, the trail, the marble, damage and its undo, wall edits, the opening sequence.
 * The field is only ever changed by maze.ts's local rule (tick) or by damage; BFS (`truth`) is
 * kept as a referee for readouts and the "settled" lamp, never to move a tile.
 */
import {
  INF,
  addShortcuts,
  adjacency,
  bfs,
  cloneMaze,
  countFinite,
  freshField,
  generateMaze,
  goalOf,
  maxFinite,
  mixSeed,
  mulberry32,
  patchAround,
  sameWalls,
  smash,
  startOf,
  tick,
  toggleWall,
  trailStep,
  wakeMask,
  type Maze,
} from "./maze";

export const SIZES = [12, 24, 48, 64] as const;
export const BRANCH = 0.35;
export const DEFAULTS = {
  size: 24,
  seed: 1099,
  wake: 0.5,
  sync: false,
  shortcuts: 0,
  showCone: false,
};
export const MAX_SHORTCUTS = 20;
export const PATCH = 5;

/** ticks per second while playing (bigger boards tick faster so a flood still takes seconds) */
export function playRate(n: number): number {
  return 20 * Math.max(1, n / 24);
}

/** the opening: flood at the wave's pace, then let the trail run at the trail's pace */
const WOW_FLOOD_TPS = 17;
const WOW_TRAIL_TPS = 46;
const WOW_HEAL_TPS = 24;

export type WowPhase = "fade" | "flood" | "trail" | "marble" | "smash" | "heal" | "done";

export interface Ev {
  play: number;
  pause: number;
  step: number;
  smash: number;
  smashUndo: number;
  healed: number;
  wall: number;
  wallsBack: number;
  reset: number;
  wake: number;
  newMaze: number;
  mazeBack: number;
  size: number;
  shortcuts: number;
  sync: number;
  goal: number;
  trailDone: number;
  settled: number;
}

const evInit = (): Ev => ({
  play: -99,
  pause: -99,
  step: -99,
  smash: -99,
  smashUndo: -99,
  healed: -99,
  wall: -99,
  wallsBack: -99,
  reset: -99,
  wake: -99,
  newMaze: -99,
  mazeBack: -99,
  size: -99,
  shortcuts: -99,
  sync: -99,
  goal: -99,
  trailDone: -99,
  settled: -99,
});

interface SmashSnap {
  field: Float64Array;
  trail: number[];
  marbleS: number;
  marbleOn: boolean;
  goalTick: number;
}

export class Model {
  n = DEFAULTS.size;
  seed = DEFAULTS.seed;
  shortcuts = DEFAULTS.shortcuts;
  wake = DEFAULTS.wake;
  sync = DEFAULTS.sync;
  showCone = DEFAULTS.showCone;
  newMazeCount = 0;

  /** the generated maze (with shortcuts) and the one on the tray (with the user's wall edits) */
  gen!: Maze;
  maze!: Maze;
  adj!: Int32Array;
  /** reference distances (BFS) for readouts and checks only */
  truth!: Float64Array;
  truthMax = 0;
  /** bumps whenever the walls change, so views rebuild */
  mazeVersion = 0;

  field!: Float64Array;
  private buf!: Float64Array;
  changed!: Uint8Array;
  /** tick at which each tile last changed its number (for the one-tick frontier edge) */
  changeTick!: Float64Array;
  /** tick at which each tile first got a number (for the pop-up) */
  private wakeBuf!: Uint8Array;
  private scratch!: Float64Array;
  private scratchCh!: Uint8Array;
  private rng: () => number = Math.random;
  epoch = 0;

  ticks = 0;
  /** ticks since the field was last cleared (the light cone's radius) */
  floodTicks = 0;
  lastChanges = 0;
  /** ticks since the last user action or fresh flood */
  sinceKick = 0;
  ticksThisFrame = 0;
  playing = false;
  private acc = 0;
  /** no tile would change under a full synchronous pass: the field is a fixed point of the rule */
  fixed = false;
  private quietFor = 0;

  reached = 1;
  wrong = 0;
  fieldMax = 0;
  goalTick = -1;

  trail: number[] = [];
  trailComplete = false;
  marbleOn = false;
  marbleS = 0;
  marbleHome = false;

  smashCells: number[] = [];
  smashed = false;
  smashTick = 0;
  smashWrong = 0;
  private preKnown = new Set<number>();
  smashUndo: SmashSnap | null = null;
  healedInTicks = -1;
  smashCount = 0;

  wallsEdited = false;
  lastWallCell = -1;

  time = 0;
  ev: Ev = evInit();

  wowActive = false;
  wowT = 0;
  wowPhase: WowPhase = "done";
  private wowMark = 0;
  reducedMotion = false;

  constructor() {
    this.buildMaze(true);
  }

  get start(): number {
    return startOf(this.n);
  }
  get goal(): number {
    return goalOf(this.n);
  }
  get N(): number {
    return this.n * this.n;
  }
  /** the probability a tile wakes this tick (the opening runs everyone-together) */
  get p(): number {
    return this.sync || this.wowActive ? 1 : this.wake;
  }
  get tps(): number {
    // the opening: the wave at a watchable pace; once the numbers have stopped changing, the trail runs fast
    if (this.wowActive) return this.smashed ? WOW_HEAL_TPS : this.fixed && this.field[this.goal] !== INF && !this.trailComplete ? WOW_TRAIL_TPS : WOW_FLOOD_TPS;
    return playRate(this.n) * this.speedUp;
  }
  /** the longer the field runs without a nudge, the faster the ticks go (up to 5×) */
  get speedUp(): number {
    return this.wowActive ? 1 : Math.min(5, 1 + Math.max(0, this.sinceKick - 120) / 150);
  }
  /** a user action: back to normal speed so its effect is watchable */
  kick(): void {
    this.sinceKick = 0;
  }
  get isExampleMaze(): boolean {
    return this.seed === DEFAULTS.seed;
  }
  get goalDistance(): number {
    return this.field[this.goal];
  }
  get shortestTrue(): number {
    return this.truth[this.goal];
  }
  get settled(): boolean {
    return this.wrong === 0;
  }

  // ───────────────────────── building ─────────────────────────

  /** Regenerate the maze for (n, seed, shortcuts); optionally clear the field. */
  private buildMaze(clear: boolean): void {
    const base = generateMaze(this.n, this.seed, BRANCH);
    this.gen = addShortcuts(base, this.shortcuts, this.seed);
    this.maze = cloneMaze(this.gen);
    this.wallsEdited = false;
    this.lastWallCell = -1;
    const N = this.N;
    if (clear || !this.field || this.field.length !== N) {
      this.buf = new Float64Array(N);
      this.changed = new Uint8Array(N);
      this.changeTick = new Float64Array(N).fill(-99);
      this.wakeBuf = new Uint8Array(N);
      this.scratch = new Float64Array(N);
      this.scratchCh = new Uint8Array(N);
    }
    this.mazeChanged();
    if (clear || !this.field || this.field.length !== N) this.clearField();
  }

  private mazeChanged(): void {
    this.adj = adjacency(this.maze);
    this.truth = bfs(this.adj, this.n, this.start);
    this.truthMax = maxFinite(this.truth);
    this.wallsEdited = !sameWalls(this.maze, this.gen);
    this.mazeVersion++;
    if (this.field) this.recount();
  }

  /** Everyone back to "don't know" except the start. */
  clearField(): void {
    this.field = freshField(this.n, this.start);
    this.changed.fill(0);
    this.changeTick.fill(-99);
    this.epoch++;
    this.rng = mulberry32(mixSeed(mixSeed(this.seed, this.n), this.epoch));
    this.ticks = 0;
    this.floodTicks = 0;
    this.acc = 0;
    this.goalTick = -1;
    this.trail = [];
    this.trailComplete = false;
    this.marbleOn = false;
    this.marbleS = 0;
    this.marbleHome = false;
    this.smashCells = [];
    this.smashed = false;
    this.smashUndo = null;
    this.healedInTicks = -1;
    this.quietFor = 0;
    this.sinceKick = 0;
    this.recount();
  }

  recount(): void {
    this.reached = countFinite(this.field);
    let w = 0;
    for (let i = 0; i < this.N; i++) if (this.field[i] !== this.truth[i]) w++;
    this.wrong = w;
    this.fieldMax = maxFinite(this.field);
    // one synchronous pass on a scratch copy: would anything change?
    this.fixed = tick(this.adj, this.n, this.field, this.scratch, null, this.scratchCh, this.start) === 0;
    if (this.smashed) {
      let sw = 0;
      for (let i = 0; i < this.N; i++) {
        const v = this.field[i];
        if (v !== INF ? v !== this.truth[i] : this.preKnown.has(i) && this.truth[i] !== INF) sw++;
      }
      this.smashWrong = sw;
    }
  }

  // ───────────────────────── the clock ─────────────────────────

  /** One tick of the local rule for every tile (each woken with probability p), then the trail. */
  doTick(): number {
    wakeMask(this.wakeBuf, this.p, this.rng);
    const c = tick(this.adj, this.n, this.field, this.buf, this.wakeBuf, this.changed, this.start);
    [this.field, this.buf] = [this.buf, this.field];
    this.ticks++;
    this.floodTicks++;
    this.sinceKick++;
    this.lastChanges = c;
    if (c) for (let i = 0; i < this.N; i++) if (this.changed[i]) this.changeTick[i] = this.ticks;
    trailStep(this.adj, this.field, this.trail, this.goal, this.start);
    const complete = this.trail.length > 0 && this.trail[this.trail.length - 1] === this.start;
    if (complete && !this.trailComplete) {
      this.ev.trailDone = this.time;
      this.marbleOn = true;
      this.marbleS = 0;
      this.marbleHome = false;
    }
    if (!complete && this.trailComplete) {
      this.marbleOn = false;
      this.marbleHome = false;
    }
    this.trailComplete = complete;
    if (this.goalTick < 0 && this.field[this.goal] !== INF) {
      this.goalTick = this.floodTicks;
      this.ev.goal = this.time;
    }
    const wasWrong = this.wrong;
    this.recount();
    if (this.smashed && this.smashWrong === 0) {
      this.smashed = false;
      this.healedInTicks = this.ticks - this.smashTick;
      this.ev.healed = this.time;
    }
    if (wasWrong > 0 && this.wrong === 0) this.ev.settled = this.time;
    return c;
  }

  /** marble rolls down the finished trail: about 22 tiles a second, 1.3 to 3.2 s in all */
  get marbleSpeed(): number {
    const L = Math.max(1, this.trail.length - 1);
    if (this.wowActive) return L / 1.2;
    return L / Math.min(3.2, Math.max(1.3, L / 22));
  }

  step(dt: number): void {
    this.time += dt;
    this.ticksThisFrame = 0;
    if (this.wowActive) this.stepWow(dt);
    if (this.playing) {
      this.acc += dt * this.tps;
      let k = 0;
      const maxPerFrame = 12;
      while (this.acc >= 1 && k < maxPerFrame) {
        this.acc -= 1;
        this.doTick();
        k++;
      }
      if (k === maxPerFrame) this.acc = Math.min(this.acc, 1);
      this.ticksThisFrame = k;
    }
    if (this.marbleOn && !this.marbleHome) {
      this.marbleS += dt * this.marbleSpeed;
      if (this.marbleS >= this.trail.length - 1) {
        this.marbleS = this.trail.length - 1;
        this.marbleHome = true;
      }
    }
    // nothing left to do: the field is a fixed point of the rule and the marble is home
    if (this.playing && !this.wowActive) {
      const done = this.fixed && (this.field[this.goal] === INF || (this.trailComplete && this.marbleHome));
      this.quietFor = done ? this.quietFor + dt : 0;
      if (this.quietFor > 0.6) this.playing = false;
    }
  }

  // ───────────────────────── the opening ─────────────────────────

  startWow(): void {
    this.resetState();
    this.wowActive = true;
    this.wowT = 0;
    this.wowPhase = "fade";
    this.playing = false;
  }

  private stepWow(dt: number): void {
    this.wowT += dt;
    const t = this.wowT;
    switch (this.wowPhase) {
      case "fade":
        if (t >= 1.0) {
          this.wowPhase = "flood";
          this.playing = true;
          this.acc = 1;
        }
        break;
      case "flood":
        if (this.field[this.goal] !== INF) this.wowPhase = "trail";
        break;
      case "trail":
        if (this.trailComplete) this.wowPhase = "marble";
        break;
      case "marble":
        if (this.marbleHome) {
          this.wowPhase = "smash";
          this.wowMark = t;
        }
        break;
      case "smash":
        if (t - this.wowMark > 0.45) {
          this.smashAt(this.defaultPatchCentre());
          this.wowPhase = "heal";
          this.wowMark = t;
        }
        break;
      case "heal":
        if (!this.smashed && this.fixed && this.trailComplete && this.marbleHome) {
          if (t - this.wowMark > 0.3) this.endWow();
        } else this.wowMark = t;
        break;
    }
    if (t > 30) this.endWow();
  }

  /** Stop the opening where it is (the user took over, or it finished). */
  endWow(): void {
    if (!this.wowActive) return;
    this.wowActive = false;
    this.wowPhase = "done";
    if (this.fixed && (this.trailComplete || this.field[this.goal] === INF)) this.playing = false;
    this.acc = Math.min(this.acc, 1);
  }

  interrupt(): void {
    if (this.wowActive) this.endWow();
  }

  // ───────────────────────── actions ─────────────────────────

  private resetState(): void {
    const changeMaze = this.n !== DEFAULTS.size || this.seed !== DEFAULTS.seed || this.shortcuts !== DEFAULTS.shortcuts || this.wallsEdited;
    this.n = DEFAULTS.size;
    this.seed = DEFAULTS.seed;
    this.shortcuts = DEFAULTS.shortcuts;
    this.wake = DEFAULTS.wake;
    this.sync = DEFAULTS.sync;
    this.showCone = DEFAULTS.showCone;
    this.newMazeCount = 0;
    if (changeMaze || !this.gen) this.buildMaze(true);
    else this.clearField();
    this.playing = false;
    this.wowActive = false;
    this.wowPhase = "done";
    this.smashCount = 0;
  }

  /** Reset to example: maze, walls, field, wake, sync, size, shortcuts, toggles (camera etc. in main). */
  reset(): void {
    this.resetState();
    this.ev = evInit();
    this.ev.reset = this.time;
  }

  /** Play / pause. Pressing Play on a finished tray floods it again from scratch. */
  togglePlay(): void {
    this.interrupt();
    if (this.playing) {
      this.playing = false;
      this.ev.pause = this.time;
      return;
    }
    if (this.isFinished()) this.clearField();
    this.playing = true;
    this.acc = 1;
    this.quietFor = 0;
    this.kick();
    this.ev.play = this.time;
  }

  /** the field has stopped changing and there is nothing left to show */
  isFinished(): boolean {
    return this.fixed && this.reached > 1 && (this.trailComplete || this.field[this.goal] === INF) && !this.smashed;
  }

  stepOnce(): void {
    this.interrupt();
    this.playing = false;
    if (this.isFinished()) this.clearField();
    this.doTick();
    this.ev.step = this.time;
  }

  setWake(p: number): void {
    this.interrupt();
    const v = Math.min(1, Math.max(0.1, p));
    if (v === this.wake) return;
    this.wake = v;
    this.ev.wake = this.time;
    this.kick();
    // on a finished tray, run the flood again so the new rate shows straight away
    if (!this.playing && this.isFinished()) {
      this.clearField();
      this.playing = true;
      this.acc = 1;
    }
  }

  setSync(on: boolean): void {
    this.interrupt();
    this.sync = on;
    this.ev.sync = this.time;
    if (!this.playing && this.isFinished()) {
      this.clearField();
      this.playing = true;
      this.acc = 1;
    }
  }

  private resume(): void {
    this.kick();
    this.playing = true;
    this.quietFor = 0;
    if (this.acc < 0) this.acc = 0;
  }

  /** where the "Smash a patch" button aims: the middle of the trail, else the middle of the wave */
  defaultPatchCentre(): number {
    if (this.trail.length >= 5) return this.trail[Math.floor(this.trail.length * 0.45)];
    if (this.reached > 1) {
      const want = Math.round(this.fieldMax * 0.6);
      let best = this.start, bd = Infinity;
      for (let i = 0; i < this.N; i++) {
        const v = this.field[i];
        if (v === INF) continue;
        const dd = Math.abs(v - want);
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      }
      return best;
    }
    const h = this.n >> 1;
    return h * this.n + h;
  }

  /** Scramble a 5 × 5 patch to wrong numbers (seeded, so the recording is the same every time). */
  smashAt(centre: number): number {
    if (this.wowActive && this.wowPhase !== "smash") this.interrupt();
    const cells = patchAround(this.n, centre, PATCH);
    this.smashUndo = {
      field: this.field.slice(),
      trail: this.trail.slice(),
      marbleS: this.marbleS,
      marbleOn: this.marbleOn,
      goalTick: this.goalTick,
    };
    this.preKnown = new Set(cells.filter((i) => this.field[i] !== INF));
    this.smashCount++;
    const rnd = mulberry32(mixSeed(mixSeed(this.seed, 0xbad), this.smashCount * 7919 + this.epoch));
    const hit = smash(this.field, cells, rnd, this.start);
    this.smashCells = hit;
    this.smashed = true;
    this.smashTick = this.ticks;
    this.healedInTicks = -1;
    for (const i of hit) this.changeTick[i] = this.ticks;
    this.ev.smash = this.time;
    this.recount();
    this.resume();
    return hit.length;
  }

  undoSmash(): boolean {
    this.interrupt();
    const s = this.smashUndo;
    if (!s) return false;
    this.field = s.field.slice();
    this.trail = s.trail.slice();
    this.trailComplete = this.trail.length > 0 && this.trail[this.trail.length - 1] === this.start;
    this.marbleOn = s.marbleOn && this.trailComplete;
    this.marbleS = s.marbleS;
    this.marbleHome = this.marbleOn && this.marbleS >= this.trail.length - 1;
    this.goalTick = s.goalTick;
    this.smashed = false;
    this.smashUndo = null;
    this.smashCells = [];
    this.ev.smashUndo = this.time;
    this.recount();
    this.resume();
    return true;
  }

  /** Tap a tile edge: add or remove the wall there. The numbers re-flow from where they are. */
  toggleWallAt(i: number, dir: number): boolean {
    this.interrupt();
    const n = this.n, x = i % n, y = (i / n) | 0;
    if ((dir === 0 && y === n - 1) || (dir === 1 && x === n - 1) || (dir === 2 && y === 0) || (dir === 3 && x === 0)) return false;
    toggleWall(this.maze, i, dir);
    this.lastWallCell = i;
    this.mazeChanged();
    this.ev.wall = this.time;
    this.resume();
    return true;
  }

  wallsBack(): void {
    this.interrupt();
    if (!this.wallsEdited) return;
    this.maze = cloneMaze(this.gen);
    this.mazeChanged();
    this.ev.wallsBack = this.time;
    this.resume();
  }

  newMaze(): void {
    this.interrupt();
    this.newMazeCount++;
    this.seed = mixSeed(DEFAULTS.seed, this.newMazeCount) % 1000000;
    if (this.seed === DEFAULTS.seed) this.seed++;
    this.buildMaze(true);
    this.ev.newMaze = this.time;
    this.resume();
    this.acc = 1;
  }

  mazeBack(): void {
    this.interrupt();
    if (this.seed === DEFAULTS.seed && !this.wallsEdited) return;
    this.seed = DEFAULTS.seed;
    this.buildMaze(true);
    this.ev.mazeBack = this.time;
    this.resume();
    this.acc = 1;
  }

  setSize(n: number): void {
    this.interrupt();
    if (!SIZES.includes(n as (typeof SIZES)[number]) || n === this.n) return;
    this.n = n;
    this.buildMaze(true);
    this.ev.size = this.time;
    this.resume();
    this.acc = 1;
  }

  setShortcuts(k: number): void {
    this.interrupt();
    const v = Math.max(0, Math.min(MAX_SHORTCUTS, Math.round(k)));
    if (v === this.shortcuts) return;
    this.shortcuts = v;
    this.gen = addShortcuts(generateMaze(this.n, this.seed, BRANCH), v, this.seed);
    this.maze = cloneMaze(this.gen);
    this.mazeChanged();
    this.ev.shortcuts = this.time;
    this.resume();
  }

  /** Light cone: tiles the news could have reached after floodTicks ticks (maze distance ≤ t). */
  inCone(i: number): boolean {
    return this.truth[i] <= this.floodTicks;
  }

  finite(): boolean {
    for (let i = 0; i < this.N; i++) {
      const v = this.field[i];
      if (Number.isNaN(v) || (v !== INF && !Number.isFinite(v))) return false;
    }
    return Number.isFinite(this.marbleS) && Number.isFinite(this.time);
  }
}

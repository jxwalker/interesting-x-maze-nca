import "./styles.css";
import { INF, extractTrail, hasWall, sameWalls, settleSync } from "./maze";
import { DEFAULTS, Model } from "./model";
import { Scene2D } from "./scene2d";
import { selfTest, type Check } from "./selftest";
import { edgeFromHit, fmt, type Anchors, type EdgePick, type Layout, type View } from "./view";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
const recording = params.get("record") === "1";
if (recording) document.documentElement.classList.add("ix-record");
const og = params.get("og") === "1";
if (og) document.documentElement.classList.add("ix-og");
const force2d = params.get("renderer") === "2d";
const isPhone = () => innerWidth <= 760;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const numbersDefault = () => !isPhone();

const model = new Model();
model.reducedMotion = reducedMotion;
const stage = $("stage");
let view: View;
let frames = 0;
let fps = 60;
let firstWow = true;
let showNumbers = numbersDefault();

// ───────────────────────── renderer selection ─────────────────────────

async function makeWebGL(): Promise<View> {
  const probe = document.createElement("canvas");
  const ctx = probe.getContext("webgl2");
  if (!ctx) throw new Error("WebGL2 unavailable");
  (ctx.getExtension("WEBGL_lose_context") as { loseContext?: () => void } | null)?.loseContext?.();
  const { Scene3D } = await import("./scene3d");
  return new Scene3D(stage, { hq: recording || og, og });
}

function use2D(): void {
  view = new Scene2D(stage);
  $("badge").hidden = false;
  view.setShowNumbers(showNumbers);
  onResize();
}

function switchTo2D(reason: string): void {
  if (view?.kind === "2d") return;
  console.warn(`[maze-nca] using Canvas2D fallback: ${reason}`);
  try {
    view?.dispose();
  } catch {
    /* ignore */
  }
  stage.querySelectorAll("canvas").forEach((c) => c.remove());
  use2D();
}

/** the social card: the solved example, trail complete, marble halfway down */
function setupOg(): void {
  model.reset();
  const r = settleSync(model.adj, model.n, model.field, 4 * model.N);
  model.field = r.field;
  model.ticks = r.ticks;
  model.floodTicks = r.ticks;
  model.trail = extractTrail(model.adj, model.field, model.goal, model.start);
  model.trailComplete = true;
  model.goalTick = model.field[model.goal];
  model.marbleOn = true;
  model.marbleS = (model.trail.length - 1) * 0.5;
  model.recount();
}

async function boot(): Promise<void> {
  if (og) setupOg();
  else model.startWow();
  if (force2d) use2D();
  else {
    try {
      view = await makeWebGL();
      view.canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        switchTo2D("webglcontextlost");
      });
      view.setShowNumbers(showNumbers);
      onResize();
      view.resetCamera(model);
      view.render(0, model);
    } catch (err) {
      switchTo2D(`WebGL init failed: ${(err as Error)?.message ?? err}`);
    }
  }
  readyT = performance.now();
  window.__ixRecord.ready = true;
  requestAnimationFrame(loop);
}

// ───────────────────────── layout ─────────────────────────

const dock = $("dock");
const adv = $("adv");
const intro = $("intro");
const numbers = $("numbers");
const explain = $("explain");
const foot = document.querySelector(".credit-foot") as HTMLElement;

function placeDock(): void {
  if (isPhone()) {
    dock.style.top = "";
    numbers.style.top = `${Math.ceil(intro.getBoundingClientRect().bottom + 6)}px`;
    $("badge").style.top = `${Math.ceil(intro.getBoundingClientRect().bottom + 6)}px`;
    return;
  }
  numbers.style.top = "";
  $("badge").style.top = "";
  dock.style.top = `${Math.ceil(intro.getBoundingClientRect().bottom + 10)}px`;
}

function computeLayout(w: number, h: number): Layout {
  placeDock();
  if (isPhone()) {
    let top = intro.getBoundingClientRect().bottom + 2;
    if (numbers.classList.contains("open")) top = Math.max(top, numbers.getBoundingClientRect().bottom + 2);
    const sheet = adv.hidden ? dock : adv;
    const bottom = Math.min(dock.getBoundingClientRect().top, sheet.getBoundingClientRect().top) - 2;
    return { x: 4, y: top, w: w - 8, h: Math.max(160, bottom - top), phone: true };
  }
  const left = og ? 300 : dock.getBoundingClientRect().right + 6;
  let right = adv.hidden ? w - 8 : adv.getBoundingClientRect().left - 8;
  if (adv.hidden && !og) right = Math.min(right, numbers.getBoundingClientRect().left - 4);
  return { x: left, y: 6, w: Math.max(260, right - left), h: h - 12, phone: false };
}

let layoutKey = "";
const keyOf = (L: Layout) => `${innerWidth}|${innerHeight}|${Math.round(L.x)}|${Math.round(L.y)}|${Math.round(L.w)}|${Math.round(L.h)}`;
function onResize(): void {
  const L = computeLayout(innerWidth, innerHeight);
  layoutKey = keyOf(L);
  view?.resize(innerWidth, innerHeight, L);
}
function checkLayout(): void {
  const L = computeLayout(innerWidth, innerHeight);
  if (keyOf(L) !== layoutKey) onResize();
}
addEventListener("resize", () => onResize());
new ResizeObserver(() => onResize()).observe(intro);

// ───────────────────────── the tray: tap a wall, double-click a tile, hover to read a tile ─────────────────────────

let downAt: { x: number; y: number } | null = null;
let hoverTile = -1;
let inspectTile = -1;
let inspectT = -99;

stage.addEventListener(
  "pointerdown",
  (e) => {
    view?.poke();
    downAt = { x: e.clientX, y: e.clientY };
  },
  true,
);
let lastTap = { i: -1, t: -1e9 };
stage.addEventListener("pointerup", (e) => {
  if (!downAt || !view) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 7) return;
  const hit = view.pick(e.clientX, e.clientY, model);
  if (!hit) return;
  const edge = edgeFromHit(hit, model.n);
  if (edge) {
    model.toggleWallAt(edge.i, edge.dir);
    syncControls();
    lastTap = { i: -1, t: -1e9 };
    return;
  }
  // a second tap on the same tile soon after: smash a patch there
  const now = performance.now();
  if (lastTap.i === hit.i && now - lastTap.t < 420) {
    model.smashAt(hit.i);
    syncControls();
    lastTap = { i: -1, t: -1e9 };
    return;
  }
  lastTap = { i: hit.i, t: now };
  inspectTile = hit.i;
  inspectT = model.time;
});
stage.addEventListener("pointermove", (e) => {
  if (!view || e.pointerType !== "mouse" || e.buttons) return;
  const hit = view.pick(e.clientX, e.clientY, model);
  const edge: EdgePick | null = hit ? edgeFromHit(hit, model.n) : null;
  view.hover(edge);
  hoverTile = hit && !edge ? hit.i : -1;
  stage.classList.toggle("over-edge", !!edge);
});
stage.addEventListener("pointerleave", () => {
  view?.hover(null);
  hoverTile = -1;
});

// ───────────────────────── controls ─────────────────────────

const wakeIn = $<HTMLInputElement>("wake");
const sizeIn = $<HTMLSelectElement>("size");
const scIn = $<HTMLInputElement>("shortcuts");
const chkNum = $<HTMLInputElement>("show-numbers");
const chkCone = $<HTMLInputElement>("show-cone");

const act = (f: () => void) => () => {
  f();
  view?.poke();
  syncControls();
};
$("btn-play").addEventListener("click", act(() => model.togglePlay()));
$("btn-step").addEventListener("click", act(() => model.stepOnce()));
$("btn-smash").addEventListener("click", act(() => model.smashAt(model.defaultPatchCentre())));
$("btn-smash-undo").addEventListener("click", act(() => model.undoSmash()));
$("btn-newmaze").addEventListener("click", act(() => model.newMaze()));
$("btn-maze-back").addEventListener("click", act(() => model.mazeBack()));
$("btn-walls-back").addEventListener("click", act(() => model.wallsBack()));
wakeIn.addEventListener("input", act(() => model.setWake(+wakeIn.value / 100)));
sizeIn.addEventListener("change", act(() => model.setSize(+sizeIn.value)));
scIn.addEventListener("input", act(() => model.setShortcuts(+scIn.value)));
$("btn-sync").addEventListener("click", act(() => model.setSync(!model.sync)));
chkCone.addEventListener("change", act(() => (model.showCone = chkCone.checked)));
chkNum.addEventListener("change", () => setShowNumbers(chkNum.checked));

function setShowNumbers(on: boolean): void {
  showNumbers = on;
  chkNum.checked = on;
  view?.setShowNumbers(on);
}

function resetAll(): void {
  model.reset();
  firstWow = false;
  setAdv(false);
  setNumbers(false);
  setSheet(false);
  setShowNumbers(numbersDefault());
  inspectTile = -1;
  view?.resetCamera(model);
  view?.poke();
  syncControls(true);
}
$("btn-reset").addEventListener("click", resetAll);

const advBtn = $("btn-advanced");
function setAdv(open: boolean): void {
  adv.hidden = !open;
  advBtn.setAttribute("aria-expanded", String(open));
  advBtn.classList.toggle("on", open);
  document.documentElement.classList.toggle("adv-open", open);
  onResize();
}
advBtn.addEventListener("click", () => setAdv(adv.hidden));
$("btn-adv-close").addEventListener("click", () => setAdv(false));

const sheetBtn = $("btn-sheet");
function setSheet(open: boolean): void {
  dock.classList.toggle("collapsed-phone", !open);
  sheetBtn.setAttribute("aria-expanded", String(open));
  setText($("sheet-label"), open ? "Fewer controls" : "More controls");
  onResize();
}
sheetBtn.addEventListener("click", () => setSheet(dock.classList.contains("collapsed-phone")));

const numBtn = $("btn-numbers");
function setNumbers(open: boolean): void {
  numbers.classList.toggle("open", open);
  numBtn.setAttribute("aria-expanded", String(open));
  numBtn.classList.toggle("on", open);
  onResize();
}
numBtn.addEventListener("click", () => setNumbers(!numbers.classList.contains("open")));

const setText = (e: HTMLElement, s: string) => {
  if (e.textContent !== s) e.textContent = s;
};
const pct = (p: number) => `${Math.round(p * 100)}%`;
const every = (p: number) => {
  const k = 1 / p;
  if (k < 1.05) return "1 tile every tick";
  return `1 tile every ${Number.isInteger(Math.round(k * 10) / 10) ? Math.round(k) : (Math.round(k * 10) / 10).toFixed(1)} ticks`;
};

function syncControls(force = false): void {
  const m = model;
  setText($("btn-play"), m.playing ? "Pause" : "Play");
  $("btn-play").classList.toggle("primary", !m.playing);
  if (document.activeElement !== wakeIn || force) {
    const want = String(Math.round(m.wake * 100));
    if (wakeIn.value !== want) wakeIn.value = want;
  }
  setText($("wake-val"), m.sync ? "all" : pct(m.wake));
  setText($("wake-desc"), m.sync ? "Everyone wakes together is on (in More): every tile updates every tick, so the wave moves exactly 1 tile per tick." : `Each tick ${m.wake >= 1 ? "every tile wakes" : `a random ${pct(m.wake)} of tiles wake`} and update; the rest doze. News travels about ${every(m.wake)}.`);
  if (sizeIn.value !== String(m.n)) sizeIn.value = String(m.n);
  setText($("size-val"), `${m.n} × ${m.n}`);
  if (scIn.value !== String(m.shortcuts)) scIn.value = String(m.shortcuts);
  setText($("shortcuts-val"), String(m.shortcuts));
  const sb = $("btn-sync");
  sb.classList.toggle("on", m.sync);
  sb.setAttribute("aria-pressed", String(m.sync));
  setText(sb, m.sync ? "Everyone wakes together: on" : "Everyone wakes together");
  chkCone.checked = m.showCone;
  chkNum.checked = showNumbers;
  $("btn-smash-undo").classList.toggle("dim", !m.smashUndo);
  ($("btn-smash-undo") as HTMLButtonElement).disabled = !m.smashUndo;
  $("btn-maze-back").classList.toggle("dim", m.isExampleMaze);
  ($("btn-maze-back") as HTMLButtonElement).disabled = m.isExampleMaze;
  $("btn-walls-back").hidden = !m.wallsEdited;
}

// ───────────────────────── intro card ─────────────────────────

const helpBtn = $("btn-help");
const INTRO_KEY = "maze-nca:intro-seen";
let introPending = false;

function setExplain(open: boolean, remember = true): void {
  if (explain.hidden === !open) return;
  explain.hidden = !open;
  helpBtn.setAttribute("aria-expanded", String(open));
  if (open) $("btn-explain-ok").focus({ preventScroll: true });
  else if (remember) {
    try {
      localStorage.setItem(INTRO_KEY, "1");
    } catch {
      /* private mode */
    }
  }
}
helpBtn.addEventListener("click", () => setExplain(explain.hidden));
$("btn-explain-x").addEventListener("click", () => setExplain(false));
$("btn-explain-ok").addEventListener("click", () => setExplain(false));
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !explain.hidden) setExplain(false);
});
document.addEventListener(
  "pointerdown",
  (e) => {
    const t = e.target as Node;
    if (introPending && !helpBtn.contains(t)) introPending = false;
    if (!explain.hidden && !explain.contains(t) && !helpBtn.contains(t)) setExplain(false);
  },
  true,
);
{
  let seen = false;
  try {
    seen = localStorage.getItem(INTRO_KEY) === "1";
  } catch {
    /* ignore */
  }
  // the card waits until the opening has played, so it never hides the wow moment
  if (!seen && !recording && !og && params.get("intro") !== "0") introPending = true;
}

// ───────────────────────── labels next to the objects ─────────────────────────

interface LabelDef {
  id: string;
  cls: string;
  dir: [number, number];
  text: () => string | null;
}

const labelDefs: LabelDef[] = [
  { id: "start", cls: "brass", dir: [-0.6, -1], text: () => "Start" },
  { id: "goal", cls: "copper", dir: [0.6, -1], text: () => "Way out" },
  { id: "smash", cls: "red", dir: [1, -0.8], text: () => (model.smashed ? "Smashed here" : null) },
  { id: "front", cls: "lime", dir: [1, -0.6], text: () => (model.smashed ? null : "Wave front") },
  { id: "rule", cls: "", dir: [-1, -0.5], text: () => "Each tile: 1 + smallest neighbour" },
];

const labelsBox = $("labels");
const leaders = document.getElementById("leaders") as unknown as SVGSVGElement;
const labelEls = new Map<string, { el: HTMLElement; html: string; w: number; h: number; line: SVGLineElement; dot: SVGCircleElement }>();
for (const d of labelDefs) {
  const el = document.createElement("div");
  el.className = `lbl3d ${d.cls}`;
  labelsBox.appendChild(el);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("class", d.cls);
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("r", "2.5");
  dot.setAttribute("class", d.cls);
  leaders.append(line, dot);
  labelEls.set(d.id, { el, html: "", w: 0, h: 0, line, dot });
}

function obstacles(): DOMRect[] {
  const r: DOMRect[] = [];
  for (const el of [dock, adv, intro, explain, numbers, $("badge"), foot]) if (!el.hidden && el.offsetParent !== null && getComputedStyle(el).display !== "none") r.push(el.getBoundingClientRect());
  r.push(new DOMRect(0, innerHeight - 64, 160, 64), new DOMRect(innerWidth / 2 - 115, innerHeight - 74, 230, 74));
  return r;
}

function hide(rec: { el: HTMLElement; line: SVGLineElement; dot: SVGCircleElement }): void {
  rec.el.style.display = "none";
  rec.line.style.display = rec.dot.style.display = "none";
}

function layoutLabels(a: Anchors): void {
  const W = innerWidth, H = innerHeight;
  const phone = isPhone();
  const obs = obstacles();
  const free = computeLayout(W, H);
  const top = phone ? free.y : 4;
  type B = { id: string; x: number; y: number; w: number; h: number; ax: number; ay: number };
  const boxes: B[] = [];
  let count = 0;
  const quiet = (model.wowActive && model.wowT < 1.4) || og;
  for (const d of labelDefs) {
    const rec = labelEls.get(d.id)!;
    const an = a[d.id];
    if (quiet || (phone && count >= 3)) {
      hide(rec);
      continue;
    }
    const inside = an && an.on && an.x > 2 && an.x < W - 2 && an.y > top && an.y < H - 2 && !obs.some((r) => an.x > r.left && an.x < r.right && an.y > r.top && an.y < r.bottom);
    const txt = inside ? d.text() : null;
    if (!txt) {
      hide(rec);
      continue;
    }
    count++;
    rec.el.style.display = "";
    if (txt !== rec.html) {
      rec.el.textContent = txt;
      rec.html = txt;
      rec.w = rec.el.offsetWidth;
      rec.h = rec.el.offsetHeight;
    }
    let [dx, dy] = d.dir;
    const n = Math.hypot(dx, dy) || 1;
    dx /= n;
    dy /= n;
    const off = phone ? 16 : 30;
    let x = an!.x + dx * off, y = an!.y + dy * off;
    x -= dx > 0.35 ? 0 : dx < -0.35 ? rec.w : rec.w / 2;
    y -= dy > 0.35 ? 0 : dy < -0.35 ? rec.h : rec.h / 2;
    boxes.push({ id: d.id, x, y, w: rec.w, h: rec.h, ax: an!.x, ay: an!.y });
  }
  const pad = 4;
  for (let it = 0; it < 40; it++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      const p = boxes[i];
      for (let j = i + 1; j < boxes.length; j++) {
        const q = boxes[j];
        const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) + pad;
        const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y) + pad;
        if (ox > 0 && oy > 0) {
          moved = true;
          if (oy < ox) {
            const sg = p.y + p.h / 2 < q.y + q.h / 2 ? -1 : 1;
            p.y += sg * oy * 0.5;
            q.y -= sg * oy * 0.5;
          } else {
            const sg = p.x + p.w / 2 < q.x + q.w / 2 ? -1 : 1;
            p.x += sg * ox * 0.5;
            q.x -= sg * ox * 0.5;
          }
        }
      }
      for (const r of obs) {
        const ox = Math.min(p.x + p.w, r.right) - Math.max(p.x, r.left) + pad;
        const oy = Math.min(p.y + p.h, r.bottom) - Math.max(p.y, r.top) + pad;
        if (ox > 0 && oy > 0) {
          moved = true;
          const opts = [
            { d: r.right + pad - p.x, ax: "x" },
            { d: r.left - pad - (p.x + p.w), ax: "x" },
            { d: r.bottom + pad - p.y, ax: "y" },
            { d: r.top - pad - (p.y + p.h), ax: "y" },
          ].sort((u, v) => Math.abs(u.d) - Math.abs(v.d));
          const fits = (o: { d: number; ax: string }) => (o.ax === "x" ? p.x + o.d >= 4 && p.x + o.d <= W - p.w - 4 : p.y + o.d >= top && p.y + o.d <= H - p.h - 4);
          const o = opts.find(fits) ?? opts[0];
          if (o.ax === "x") p.x += o.d;
          else p.y += o.d;
        }
      }
      p.x = Math.max(4, Math.min(W - p.w - 4, p.x));
      p.y = Math.max(top, Math.min(H - p.h - 4, p.y));
    }
    if (!moved) break;
  }
  const hit = (b: B, x: number, y: number, w: number, h: number) => b.x < x + w - 2 && x < b.x + b.w - 2 && b.y < y + h - 2 && y < b.y + b.h - 2;
  const kept: B[] = [];
  for (const b of boxes) {
    const rec = labelEls.get(b.id)!;
    if (obs.some((r) => hit(b, r.left, r.top, r.width, r.height)) || kept.some((k) => hit(b, k.x, k.y, k.w, k.h))) {
      hide(rec);
      continue;
    }
    kept.push(b);
    rec.el.style.transform = `translate(${Math.round(b.x)}px, ${Math.round(b.y)}px)`;
    const cx = Math.max(b.x, Math.min(b.x + b.w, b.ax)), cy = Math.max(b.y, Math.min(b.y + b.h, b.ay));
    const far = Math.hypot(cx - b.ax, cy - b.ay) > 6;
    rec.line.style.display = far ? "" : "none";
    rec.dot.style.display = "";
    rec.line.setAttribute("x1", b.ax.toFixed(1));
    rec.line.setAttribute("y1", b.ay.toFixed(1));
    rec.line.setAttribute("x2", cx.toFixed(1));
    rec.line.setAttribute("y2", cy.toFixed(1));
    rec.dot.setAttribute("cx", b.ax.toFixed(1));
    rec.dot.setAttribute("cy", b.ay.toFixed(1));
  }
}

// ───────────────────────── caption ─────────────────────────

const captionText = $("caption-text");
const caption = $("caption");
let captionState = "idle";

/** what one tile is doing, in its own words */
function tileLine(i: number): [string, string] {
  const m = model;
  const d = m.field[i];
  if (i === m.start) return ["tile", "The pin's tile is the start: its number is always 0."];
  let lo = INF;
  for (let k = 0; k < 4; k++) {
    const j = m.adj[4 * i + k];
    if (j >= 0 && m.field[j] < lo) lo = m.field[j];
  }
  const nb = lo === INF ? "none of its open neighbours has a number yet" : `its smallest open neighbour says ${lo}`;
  if (d === INF) return ["tile", `This tile doesn't know yet: ${nb}.`];
  if (lo !== INF && d === lo + 1) return ["tile", `This tile says ${d}: one more than its smallest open neighbour (${lo}).`];
  return ["tile", `This tile says ${d}, but ${nb}: next time it wakes it will become ${lo === INF ? "\"don't know\"" : lo + 1}.`];
}

function captionNow(): [string, string] {
  const m = model, t = m.time, ev = m.ev;
  const recent = (x: number, d = 3) => t - x < d;
  const N = m.N;
  const g = m.field[m.goal];
  // a fresh action outranks the tile under the mouse for a few seconds
  const busy = recent(Math.max(ev.wall, ev.smash, ev.smashUndo, ev.wallsBack, ev.healed), 3);
  if (!m.wowActive && !busy) {
    const ti = hoverTile >= 0 ? hoverTile : recent(inspectT, 5) ? inspectTile : -1;
    if (ti >= 0 && ti < N) return tileLine(ti);
  } else if (m.wowPhase === "fade") return ["idle", `${fmt(N)} tiles, each seeing only its neighbours. Watch them work out the way out.`];
  if (m.smashed) return ["smashed", `${m.smashCells.length} tiles scrambled. Watch them fix themselves using their neighbours (${m.smashWrong} still wrong).`];
  if (m.healedInTicks >= 0 && recent(m.ev.healed, 4)) return ["healed", `Healed in ${m.healedInTicks} ticks. Every tile has the right number again.`];
  if (recent(ev.wall, 6) || (ev.wall > -99 && m.wrong > 0 && ev.wall >= Math.max(ev.reset, ev.newMaze, ev.mazeBack, ev.size, ev.smash, ev.wallsBack, ev.shortcuts))) {
    let cut = 0;
    for (let i = 0; i < N; i++) if (m.truth[i] === INF && m.field[i] !== INF) cut++;
    if (cut > 0) return ["cutoff", `Wall moved: ${fmt(cut)} tiles are cut off from the pin. They can't tell, so their numbers count up until they pass ${fmt(N)}, then give up.`];
    let rework = 0;
    for (let i = 0; i < N; i++) if (m.field[i] !== INF && m.field[i] !== m.truth[i]) rework++;
    if (rework > 0) return ["wall", `Wall moved: ${fmt(rework)} tiles are re-working their numbers.`];
    if (recent(ev.wall, 6) && m.wrong === 0) return ["wall", g === INF ? "Wall moved: every tile has re-worked its number. The flag is cut off now: no way out." : `Wall moved: every tile has re-worked its number. Shortest way out now ${g} steps.`];
  }
  if (recent(ev.wallsBack, 3) && m.wrong > 0) return ["wall", `Walls put back: ${fmt(m.wrong)} tiles are re-working their numbers.`];
  if (g !== INF && !m.trailComplete) return ["goal", `Tick ${m.goalTick}: the flag learned it is ${g} steps away. Now the trail just walks downhill.`];
  if (m.trailComplete) {
    if (m.n >= 48) return ["big-board", `Same rule on a ${m.n} x ${m.n} board: ${fmt(N)} cells, shortest way out ${g} steps.`];
    return ["trail-done", `Shortest way out: ${g} steps, found by tiles that only ever looked next door.`];
  }
  if (m.reached <= 1 && !m.playing) return ["idle", `${fmt(N)} tiles, each seeing only its neighbours. Press Play to let them work out the way out.`];
  if (m.playing && !m.sync && !m.wowActive && m.wake <= 0.3) return ["low-wake", `Only ${pct(m.wake)} of cells awake each tick: the wave crawls and goes ragged, but every number still comes out right.`];
  if (m.playing || m.wowActive) return ["flooding", `Tick ${m.floodTicks}: ${fmt(m.reached)} tiles know how far they are from the pin. Nobody can see the whole maze.`];
  if (m.field[m.goal] === INF && m.fixed && m.reached > 1) return ["paused", `Settled, but the flag is walled off: no tile next to it ever hears from the pin. Tap a wall to open a way.`];
  return ["paused", `Paused at tick ${m.floodTicks}: ${fmt(m.reached)} tiles know their distance. Press Play or One tick.`];
}

// ───────────────────────── readouts ─────────────────────────

function updateHud(): void {
  const m = model;
  const p = m.p;
  setText($("n-ticks"), fmt(m.ticks));
  setText($("n-ticks-m"), m.playing && m.speedUp > 1.05 ? `one tick = every awake tile applies its rule once (running ${m.speedUp.toFixed(1)}× faster: nothing new for a while)` : "one tick = every awake tile applies its rule once");
  setText($("n-reached"), `${fmt(m.reached)} of ${fmt(m.N)}`);
  const g = m.field[m.goal];
  setText($("n-route"), g === INF ? "not found yet" : `${g} steps`);
  setText($("n-route-m"), m.goalTick >= 0 && g !== INF ? `the flag needed ${m.goalTick} ticks to hear; at ${pct(p)} awake expect about ${Math.round(g / p)} (route ÷ p)` : "read from the flag's own number, once it has one");
  setText($("n-wrong"), m.wrong === 0 ? "0: every tile now has the right number" : fmt(m.wrong));
  setText($("n-wake"), m.wowActive ? "100% (the opening)" : m.sync ? "100% (everyone wakes together)" : pct(m.wake));
  setText($("n-wake-m"), `so news travels about ${every(p)}`);
  const hr = $("row-heal");
  hr.hidden = !(m.smashed || m.healedInTicks >= 0);
  setText($("n-heal"), m.smashed ? `${m.smashWrong} still wrong, ${m.ticks - m.smashTick} ticks in` : `Healed in ${m.healedInTicks} ticks`);

  const [state, full] = captionNow();
  captionState = state;
  if (captionText.textContent !== full) {
    captionText.textContent = full;
    if (caption.dataset.state !== state) {
      caption.classList.remove("pulse");
      void caption.offsetWidth;
      caption.classList.add("pulse");
    }
  }
  caption.dataset.state = state;

  const fade = $("fade");
  const fo = firstWow && m.wowActive ? Math.max(0, 1 - m.wowT / 0.9) : 0;
  const fs = fo.toFixed(3);
  if (fade.style.opacity !== fs) fade.style.opacity = fs;
}

// ───────────────────────── loop ─────────────────────────

let last = performance.now();
let fpsT = 0, fpsN = 0;
let stepped = false;
let readyT = Infinity;
let wasPlaying = false;

function loop(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  // in record mode the clock waits for the recorder's fixed-dt steps (or starts on its own 3 s after ready)
  if (!stepped) frame(recording && now - readyT < 3000 ? 0 : dt);
  requestAnimationFrame(loop);
}

function frame(dt: number, draw = true): void {
  if (!og) model.step(dt);
  if (introPending && !model.wowActive && !stepped) {
    introPending = false;
    setExplain(true, false);
  }
  if (model.playing !== wasPlaying || frames % 15 === 0) syncControls();
  wasPlaying = model.playing;
  if (draw && view) {
    try {
      view.render(dt, model);
    } catch (err) {
      if (view.kind === "webgl") switchTo2D(`render error: ${(err as Error)?.message ?? err}`);
      else throw err;
    }
    layoutLabels(view.anchors());
  } else if (view) view.settle?.(dt, model);
  updateHud();
  if (frames % 10 === 0) checkLayout();
  frames++;
  const now = performance.now();
  if (!fpsT) fpsT = now;
  fpsN++;
  if (now - fpsT >= 500) {
    fps = (fpsN * 1000) / (now - fpsT);
    fpsT = now;
    fpsN = 0;
  }
}

// ───────────────────────── hooks ─────────────────────────

declare global {
  interface Window {
    __mazeInfo: () => Record<string, unknown>;
    __mazeSelfTest: () => { pass: boolean; checks: Check[] };
    __mazeAdvance: (seconds: number) => Record<string, unknown>;
    __mazeAnchors: () => Anchors;
    __mazeModel: Model;
    __ixRecord: { ready: boolean; setStepped: (on: boolean) => void; stepFrame: (dt: number) => void };
  }
}

const numOrNull = (v: number) => (v === INF ? null : v);
window.__mazeInfo = () => {
  const m = model;
  const anim = (view as unknown as { anim?: { finite(): boolean; moving: boolean } })?.anim;
  return {
    size: m.n,
    seed: m.seed,
    wake: m.wake,
    sync: m.sync,
    ticks: m.ticks,
    reached: m.reached,
    wrongCount: m.wrong,
    goalDistance: numOrNull(m.goalDistance),
    shortestTrue: numOrNull(m.shortestTrue),
    trailLength: Math.max(0, m.trail.length - 1),
    trailComplete: m.trailComplete,
    settled: m.settled,
    smashed: m.smashed,
    healedInTicks: m.healedInTicks >= 0 ? m.healedInTicks : null,
    wallsEdited: m.wallsEdited,
    captionState,
    caption: captionText.textContent ?? "",
    animating: m.wowActive || m.playing || !!anim?.moving,
    playing: m.playing,
    wow: m.wowActive,
    wowPhase: m.wowPhase,
    shortcuts: m.shortcuts,
    showCone: m.showCone,
    showNumbers,
    advanced: !adv.hidden,
    fixed: m.fixed,
    marble: { on: m.marbleOn, s: m.marbleS, home: m.marbleHome },
    smashWrong: m.smashWrong,
    smashUndo: !!m.smashUndo,
    exampleMaze: m.isExampleMaze,
    renderer: view?.kind ?? "webgl",
    camera: view?.cameraPose().map((x) => Math.round(x * 1e4) / 1e4),
    frames,
    fps: Math.round(fps * 10) / 10,
    nan: !m.finite() || (anim ? !anim.finite() : false),
  };
};

/** Reset check: scramble everything, press Reset, compare with the defaults (and the reset camera pose). */
function resetCheck(): Check {
  if (!view) return { name: "Reset restores everything", pass: false, detail: "no view" };
  const bad: string[] = [];
  resetAll();
  const want = view.cameraPose();
  const wantWalls = { n: model.n, wallE: model.maze.wallE.slice(), wallN: model.maze.wallN.slice() };
  model.setSize(48);
  model.newMaze();
  model.setShortcuts(7);
  model.toggleWallAt(50, 1);
  model.setWake(0.2);
  model.setSync(true);
  model.showCone = true;
  for (let k = 0; k < 30; k++) model.doTick();
  model.smashAt(model.defaultPatchCentre());
  setShowNumbers(!numbersDefault());
  setAdv(true);
  setNumbers(true);
  view.setCameraPose(want.map((x, i) => x + (i < 3 ? 1.2 : 0.2)));
  resetAll();
  const got = view.cameraPose();
  const camErr = Math.max(...got.map((x, i) => Math.abs(x - want[i])));
  if (model.n !== DEFAULTS.size) bad.push("size");
  if (model.seed !== DEFAULTS.seed) bad.push("seed");
  if (!sameWalls(model.maze, wantWalls) || model.wallsEdited) bad.push("walls");
  if (model.shortcuts !== DEFAULTS.shortcuts) bad.push("shortcuts");
  if (model.wake !== DEFAULTS.wake || model.sync !== DEFAULTS.sync) bad.push("wake/sync");
  if (model.showCone !== DEFAULTS.showCone || showNumbers !== numbersDefault()) bad.push("toggles");
  if (model.reached !== 1 || model.ticks !== 0 || model.trail.length || model.smashed || model.smashUndo || model.playing) bad.push("field");
  if (!adv.hidden) bad.push("advanced");
  if (camErr > 1e-6) bad.push(`camera ${camErr.toExponential(1)}`);
  if (+wakeIn.value !== 50 || +sizeIn.value !== 24 || +scIn.value !== 0 || chkCone.checked) bad.push("controls");
  return { name: "Reset restores maze, walls, field, wake, sync, size, shortcuts, toggles, Advanced and camera", pass: bad.length === 0, detail: bad.length ? `wrong: ${bad.join(", ")}` : `all restored (camera error ${camErr.toExponential(1)})` };
}

function undoChecks(): Check[] {
  resetAll();
  const out: Check[] = [];
  model.togglePlay();
  for (let k = 0; k < 120; k++) model.doTick();
  const before = model.field.slice();
  model.smashAt(model.defaultPatchCentre());
  const changed = model.field.some((v, i) => v !== before[i]);
  model.undoSmash();
  const back = model.field.every((v, i) => v === before[i]);
  out.push({ name: "Smash a patch, then Undo smash restores every number", pass: changed && back, detail: `smash changed numbers: ${changed}; undo restored all: ${back}` });
  const walls = { n: model.n, wallE: model.maze.wallE.slice(), wallN: model.maze.wallN.slice() };
  model.toggleWallAt(100, 0);
  model.toggleWallAt(200, 1);
  const edited = model.wallsEdited;
  model.wallsBack();
  out.push({ name: "Wall edits, then Put the walls back", pass: edited && sameWalls(model.maze, walls) && !model.wallsEdited, detail: `edited: ${edited}; restored: ${sameWalls(model.maze, walls)}` });
  model.newMaze();
  const differs = !sameWalls(model.maze, walls);
  model.mazeBack();
  out.push({ name: "New maze, then Back to the example maze", pass: differs && sameWalls(model.maze, walls) && model.isExampleMaze, detail: `new maze differs: ${differs}; back to example: ${sameWalls(model.maze, walls)}` });
  // the live field never contradicts BFS on a tile closer than the ticks run (and the start's walls are real)
  out.push({ name: "start and goal sit on tiles with open edges", pass: [0, 1, 2, 3].some((d) => !hasWall(model.maze, model.start, d)) && [0, 1, 2, 3].some((d) => !hasWall(model.maze, model.goal, d)), detail: "pin and flag are both reachable" });
  resetAll();
  return out;
}

window.__mazeSelfTest = () => {
  const wasWow = model.wowActive;
  const r = selfTest(() => [...undoChecks(), resetCheck()]);
  if (wasWow) model.endWow();
  return r;
};
window.__mazeAnchors = () => view?.anchors() ?? {};
window.__mazeModel = model;
window.__mazeAdvance = (seconds: number) => {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 30) frame(1 / 30, false);
  frame(0);
  return window.__mazeInfo();
};
window.__ixRecord = {
  ready: false,
  setStepped(on: boolean) {
    stepped = on;
    if (on) {
      introPending = false;
      setExplain(false, false);
    }
  },
  stepFrame(dt: number) {
    frame(Math.min(0.1, Math.max(1 / 240, dt || 1 / 30)));
  },
};

syncControls(true);
setShowNumbers(showNumbers);
void boot();

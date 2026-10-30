/**
 * WebGL view: a matte cream ceramic tray of square tiles on a walnut bench at dusk. Tiles are one
 * InstancedMesh whose shader lifts each tile's top to its live height (h0 + s·d), engraves its
 * number, inlays the lime trail and lights the one-tick frontier edge. Walls are walnut ridges
 * that always stand a little above the tiles either side. Matte data surfaces, ACES, bloom only on
 * the lime trail, the frontier edge and the marble.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { INF, hasWall } from "./maze";
import type { Model } from "./model";
import {
  Anim,
  HMAX,
  LIME,
  RAMP_LIN,
  RIM,
  TRAY,
  UNKNOWN_LIN,
  cellSize,
  cellXZ,
  rampIndex,
  wallRise,
  type Anchors,
  type EdgePick,
  type Layout,
  type TilePick,
  type View,
} from "./view";

const FOV = 30;

// ───────────────────────── textures ─────────────────────────

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

function rng(seed: number) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

function walnutTex(): THREE.CanvasTexture {
  const t = canvasTex(1024, 512, (g, w, h) => {
    g.fillStyle = "#3b2a1e";
    g.fillRect(0, 0, w, h);
    const rnd = rng(7);
    for (let i = 0; i < 360; i++) {
      const y = rnd() * h;
      const a = 0.05 + rnd() * 0.12;
      g.strokeStyle = rnd() < 0.55 ? `rgba(12,6,2,${a})` : `rgba(120,80,48,${a * 0.8})`;
      g.lineWidth = 0.6 + rnd() * 2.6;
      g.beginPath();
      const amp = 2 + rnd() * 6, f = 0.004 + rnd() * 0.008, ph = rnd() * 6;
      for (let x = 0; x <= w; x += 16) g.lineTo(x, y + Math.sin(x * f + ph) * amp);
      g.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function backdropTex(): THREE.CanvasTexture {
  return canvasTex(16, 512, (g) => {
    const grd = g.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0, "#0c1628");
    grd.addColorStop(0.5, "#121a29");
    grd.addColorStop(1, "#0a0b0e");
    g.fillStyle = grd;
    g.fillRect(0, 0, 16, 512);
  });
}

function speckleTex(): THREE.CanvasTexture {
  const t = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = "#808080";
    g.fillRect(0, 0, w, h);
    const rnd = rng(23);
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${0.04 + rnd() * 0.06})` : `rgba(0,0,0,${0.04 + rnd() * 0.08})`;
      const r = 0.6 + rnd() * 1.6;
      g.fillRect(rnd() * w, rnd() * h, r, r);
    }
  }, false);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function brushedTex(): THREE.CanvasTexture {
  const t = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = "#808080";
    g.fillRect(0, 0, w, h);
    const rnd = rng(11);
    for (let i = 0; i < 700; i++) {
      g.strokeStyle = `rgba(${rnd() < 0.5 ? "255,255,255" : "0,0,0"},${0.03 + rnd() * 0.06})`;
      const y = rnd() * h;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y + rnd() * 2 - 1);
      g.stroke();
    }
  }, false);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 12 glyphs side by side: 0–9, "?", blank. White on transparent; the shader inks them. */
function glyphTex(): THREE.CanvasTexture {
  const W = 64, H = 96;
  const t = canvasTex(W * 12, H, (g) => {
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `700 ${H * 0.86}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    for (let k = 0; k < 11; k++) g.fillText(k < 10 ? String(k) : "?", k * W + W / 2, H * 0.54);
  }, false);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

function textTex(lines: string[], opts: { w: number; h: number; px: number; color: string; bg?: string }): THREE.CanvasTexture {
  return canvasTex(opts.w, opts.h, (g, w, h) => {
    if (opts.bg) {
      g.fillStyle = opts.bg;
      g.fillRect(0, 0, w, h);
    }
    g.fillStyle = opts.color;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `700 ${opts.px}px Inter, system-ui, -apple-system, "Segoe UI", sans-serif`;
    lines.forEach((s, k) => g.fillText(s, w / 2, (h * (k + 0.5)) / lines.length));
  });
}

/** digits round a wheel: u runs round the rim, so each digit is drawn turned a quarter */
function wheelTex(): THREE.CanvasTexture {
  const S = 128;
  const t = canvasTex(S * 10, S, (g) => {
    g.fillStyle = "#f3ead6";
    g.fillRect(0, 0, S * 10, S);
    g.fillStyle = "#1d1912";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `700 ${S * 0.78}px ui-monospace, "SF Mono", Menlo, monospace`;
    for (let k = 0; k < 10; k++) {
      g.save();
      g.translate(k * S + S / 2, S / 2);
      g.rotate(Math.PI / 2);
      g.fillText(String(k), 0, 4);
      g.restore();
    }
  });
  return t;
}

// ───────────────────────── tile shader ─────────────────────────

const TILE_VERT_HEAD = /* glsl */ `
attribute float aH;
attribute vec4 aInfo;
uniform float uHalf;
uniform float uTileW;
varying vec3 vLoc;
varying float vTopF;
varying vec4 vInfo;
`;
const TILE_DEPTH_HEAD = /* glsl */ `
attribute float aH;
uniform float uHalf;
`;
const LIFT = /* glsl */ `
transformed.y = position.y > 0.0 ? aH - uHalf + position.y : position.y + uHalf;
`;

const TILE_FRAG_HEAD = /* glsl */ `
uniform sampler2D uGlyphs;
uniform float uShowNum;
uniform vec3 uLime;
uniform vec3 uBrass;
uniform vec3 uInk;
varying vec3 vLoc;
varying float vTopF;
varying vec4 vInfo;
float glyphA(int g, vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture2D(uGlyphs, vec2((float(g) + clamp(uv.x, 0.02, 0.98)) / 12.0, uv.y)).a;
}
float band(float d, float w) {
  float aa = fwidth(d) * 1.2 + 1e-4;
  return 1.0 - smoothstep(w - aa, w + aa, d);
}
`;

const TILE_COLOR = /* glsl */ `
float lx = vLoc.x, lz = vLoc.z;
float isTop = step(0.7, vTopF);
float num = vInfo.x;
float trailOn = 0.0;
float inlay = 0.0;
float coneLine = 0.0;
if (isTop > 0.5) {
  // engraved number (or a faint "?" while the tile doesn't know)
  if (num < 0.0) {
    float gh = 0.5, gw = gh / 1.5;
    float a = glyphA(10, vec2((lx + 0.5 * gw) / gw, (-lz + 0.5 * gh) / gh));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.72, a * 0.55);
  } else if (uShowNum > 0.5) {
    int nn = int(num + 0.5);
    int k = nn < 10 ? 1 : nn < 100 ? 2 : nn < 1000 ? 3 : 4;
    float gw = k >= 4 ? 0.2 : k == 3 ? 0.25 : k == 2 ? 0.32 : 0.36;
    float gh = gw * 1.5;
    float x0 = -0.5 * float(k) * gw;
    float u = (lx - x0) / gw;
    float vv = (-lz + 0.5 * gh) / gh;
    if (u >= 0.0 && u < float(k)) {
      int idx = int(floor(u));
      int p = k - 1 - idx;
      int pw = p == 0 ? 1 : p == 1 ? 10 : p == 2 ? 100 : 1000;
      int dg = (nn / pw) - ((nn / pw) / 10) * 10;
      float a = glyphA(dg, vec2(fract(u), vv));
      diffuseColor.rgb = mix(diffuseColor.rgb, uInk, a * 0.9);
    }
  }
  // the trail inlay: a centre square and arms towards the linked neighbours
  int tm = int(vInfo.z + 0.5);
  if (tm >= 16) {
    float w = 0.12;
    float ax = abs(lx), az = abs(lz);
    float m = band(max(ax, az), w);
    if ((tm & 1) != 0 && lz <= 0.0) m = max(m, band(ax, w));
    if ((tm & 2) != 0 && lx >= 0.0) m = max(m, band(az, w));
    if ((tm & 4) != 0 && lz >= 0.0) m = max(m, band(ax, w));
    if ((tm & 8) != 0 && lx <= 0.0) m = max(m, band(az, w));
    inlay = m;
    diffuseColor.rgb = mix(diffuseColor.rgb, uLime * 0.55, m);
  }
  // light cone: brass line on the edges that face tiles the news can't have reached yet
  int cm = int(vInfo.w + 0.5);
  if (cm > 0) {
    float w = 0.07;
    if ((cm & 1) != 0) coneLine = max(coneLine, band(lz + 0.5, w));
    if ((cm & 2) != 0) coneLine = max(coneLine, band(0.5 - lx, w));
    if ((cm & 4) != 0) coneLine = max(coneLine, band(0.5 - lz, w));
    if ((cm & 8) != 0) coneLine = max(coneLine, band(lx + 0.5, w));
    diffuseColor.rgb = mix(diffuseColor.rgb, uBrass, coneLine);
  }
} else {
  diffuseColor.rgb *= 0.9;
}
`;

const TILE_EMISSIVE = /* glsl */ `
if (isTop > 0.5) {
  float edge = smoothstep(0.38, 0.46, max(abs(lx), abs(lz)));
  totalEmissiveRadiance += uLime * (edge * vInfo.y * 2.2 + inlay * 0.9);
  totalEmissiveRadiance += uBrass * coneLine * 0.35;
}
`;

// ───────────────────────── the view ─────────────────────────

interface Counter {
  g: THREE.Group;
  wheels: THREE.Object3D[];
  shown: number;
  lamp?: THREE.MeshStandardMaterial;
}

export class Scene3D implements View {
  readonly kind = "webgl" as const;
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private W = 1;
  private H = 1;
  private pr = 1;
  private layout: Layout = { x: 0, y: 0, w: 1, h: 1, phone: false };
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private idle = 0;
  private interacting = false;
  private time = 0;
  private drift = 0;
  private zoomF = 1;
  private camCentre = new THREE.Vector3();
  private camDist = 30;
  private fitKey = "";
  private fitRes = { c: new THREE.Vector3(), d: 30 };
  private og: boolean;

  readonly anim = new Anim();
  private n = 0;
  private mazeVersion = -1;
  private tileGeo: THREE.BufferGeometry | null = null;
  private tiles: THREE.InstancedMesh | null = null;
  private aH!: THREE.InstancedBufferAttribute;
  private aInfo!: THREE.InstancedBufferAttribute;
  private tileMat: THREE.MeshStandardMaterial;
  private tileDepth: THREE.MeshDepthMaterial;
  private tileU = {
    uHalf: { value: 0.04 },
    uTileW: { value: 1 },
    uGlyphs: { value: null as THREE.Texture | null },
    uShowNum: { value: 0 },
    uLime: { value: new THREE.Color(LIME) },
    uBrass: { value: new THREE.Color("#e2b45a") },
    uInk: { value: new THREE.Color("#241c14").convertSRGBToLinear() },
  };
  private tumbling = new Set<number>();

  private walls: THREE.InstancedMesh;
  private posts: THREE.InstancedMesh;
  private wallSegs: { a: number; b: number; x: number; z: number; along: "x" | "z" }[] = [];
  private postList: { x: number; z: number; segs: number[] }[] = [];
  private wallTop = new Float32Array(0);
  private ghost: THREE.Mesh;
  private ghostMat: THREE.MeshStandardMaterial;
  private hoverEdge: EdgePick | null = null;

  private trailCyl: THREE.InstancedMesh;
  private trailBall: THREE.InstancedMesh;
  private pin: THREE.Group;
  private flag: THREE.Group;
  private flagCloth: THREE.Mesh;
  private marble: THREE.Group;
  private marbleCore: THREE.Mesh;
  private halo: THREE.Sprite;
  private ticksCtr: Counter;
  private routeCtr: Counter;
  private benchG = new THREE.Group();
  private trayG = new THREE.Group();
  private grout: THREE.Mesh;
  private anchorPts: Record<string, THREE.Vector3 | null> = {};
  private tmpM = new THREE.Matrix4();
  private tmpV = new THREE.Vector3();
  private qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  private qZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  private qY = new THREE.Quaternion();
  private trailEl = 0;

  constructor(host: HTMLElement, opts: { hq?: boolean; og?: boolean } = {}) {
    this.og = !!opts.og;
    const canvas = document.createElement("canvas");
    host.appendChild(canvas);
    this.canvas = canvas;
    const mobile = Math.min(innerWidth, innerHeight) < 600;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", alpha: false, preserveDrawingBuffer: !!opts.hq });
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.75 : 2));
    this.pr = renderer.getPixelRatio();
    this.anim.reduced = this.reduced;

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = 1.25;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.6;
    this.controls.addEventListener("start", () => {
      this.interacting = true;
      this.poke();
    });
    this.controls.addEventListener("end", () => {
      this.interacting = false;
      const off = this.camera.position.clone().sub(this.controls.target);
      this.zoomF = off.length() / Math.max(1e-3, this.camDist);
      this.drift = 0;
      this.poke();
    });

    const webkitOnly = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Firefox/.test(navigator.userAgent);
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: webkitOnly ? 0 : mobile ? 2 : 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.36, 0.28, 1.15);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const scene = this.scene;
    scene.background = backdropTex();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    scene.environmentIntensity = 0.32;
    room.dispose?.();
    pmrem.dispose();

    const key = new THREE.DirectionalLight("#ffe2bd", 2.1);
    key.position.set(-9, 16, 7);
    key.castShadow = true;
    const sm = opts.hq ? 4096 : mobile ? 1024 : 2048;
    key.shadow.mapSize.set(sm, sm);
    const sc = key.shadow.camera;
    sc.left = -10;
    sc.right = 10;
    sc.top = 10;
    sc.bottom = -10;
    sc.near = 2;
    sc.far = 45;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    key.shadow.intensity = 0.75;
    scene.add(key, key.target);
    const rim = new THREE.DirectionalLight("#5cc8d0", 0.9);
    rim.position.set(6, 9, -12);
    scene.add(rim);
    const fill = new THREE.DirectionalLight("#ffd9a8", 0.35);
    fill.position.set(9, 5, 10);
    scene.add(fill);
    scene.add(new THREE.HemisphereLight("#e4dfd2", "#3a2b1e", 0.85));

    const brushed = brushedTex();
    const brass = new THREE.MeshStandardMaterial({ color: "#d4a955", metalness: 1, roughness: 0.32, roughnessMap: brushed });
    const copper = new THREE.MeshStandardMaterial({ color: "#c46a3c", metalness: 1, roughness: 0.3, roughnessMap: brushed });
    const speck = speckleTex();
    const cream = new THREE.MeshStandardMaterial({ color: "#ebe2cc", roughness: 0.88, roughnessMap: speck, bumpMap: speck, bumpScale: 0.6 });

    // bench
    const wood = walnutTex();
    wood.repeat.set(2, 1.4);
    const bench = new THREE.Mesh(new RoundedBoxGeometry(26, 0.8, 19, 3, 0.08), new THREE.MeshStandardMaterial({ map: wood, color: "#9a7356", roughness: 0.6, envMapIntensity: 0.35 }));
    bench.position.set(0, -0.62, 1.2);
    bench.receiveShadow = true;
    scene.add(bench);

    // the tray: a cream ceramic dish with a dark grout floor under the tiles
    const T = TRAY, R = RIM;
    const base = new THREE.Mesh(new RoundedBoxGeometry(T + 2 * R, 0.24, T + 2 * R, 3, 0.1), cream);
    base.position.y = -0.14;
    base.receiveShadow = base.castShadow = true;
    this.trayG.add(base);
    const rimH = 0.55;
    const rimGeoA = new RoundedBoxGeometry(T + 2 * R, rimH, R, 3, 0.16);
    const rimGeoB = new RoundedBoxGeometry(R, rimH, T + 2 * R, 3, 0.16);
    for (const [g, x, z] of [
      [rimGeoA, 0, -(T + R) / 2],
      [rimGeoA, 0, (T + R) / 2],
      [rimGeoB, -(T + R) / 2, 0],
      [rimGeoB, (T + R) / 2, 0],
    ] as [THREE.BufferGeometry, number, number][]) {
      const m = new THREE.Mesh(g, cream);
      m.position.set(x, rimH / 2 - 0.05, z);
      m.castShadow = m.receiveShadow = true;
      this.trayG.add(m);
    }
    this.grout = new THREE.Mesh(new THREE.PlaneGeometry(T, T), new THREE.MeshStandardMaterial({ color: "#2b231c", roughness: 0.95 }));
    this.grout.rotation.x = -Math.PI / 2;
    this.grout.position.y = 0.002;
    this.grout.receiveShadow = true;
    this.trayG.add(this.grout);
    scene.add(this.trayG);

    // tiles (built per board size)
    this.tileU.uGlyphs.value = glyphTex();
    this.tileMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.86, metalness: 0, roughnessMap: speck });
    this.tileMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.tileU);
      sh.vertexShader = TILE_VERT_HEAD + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\n${LIFT}\nvLoc = vec3(position.x / uTileW, position.y, position.z / uTileW);\nvTopF = objectNormal.y;\nvInfo = aInfo;`);
      sh.fragmentShader = TILE_FRAG_HEAD + sh.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>\n${TILE_COLOR}`).replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${TILE_EMISSIVE}`);
    };
    this.tileDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.tileDepth.onBeforeCompile = (sh) => {
      sh.uniforms.uHalf = this.tileU.uHalf;
      sh.vertexShader = TILE_DEPTH_HEAD + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\n${LIFT}`);
    };

    // walls and corner posts: walnut ridges
    const wallMat = new THREE.MeshStandardMaterial({ color: "#5e4130", roughness: 0.58, envMapIntensity: 0.4 });
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    this.walls = new THREE.InstancedMesh(box, wallMat, 1);
    this.posts = new THREE.InstancedMesh(box, wallMat, 1);
    for (const m of [this.walls, this.posts]) {
      m.castShadow = m.receiveShadow = true;
      m.frustumCulled = false;
      scene.add(m);
    }
    this.ghostMat = new THREE.MeshStandardMaterial({ color: "#7a5a3e", transparent: true, opacity: 0.5, emissive: new THREE.Color(LIME), emissiveIntensity: 0.0, depthWrite: false });
    this.ghost = new THREE.Mesh(box, this.ghostMat);
    this.ghost.visible = false;
    scene.add(this.ghost);

    // the trail: a thin glowing lime tube that steps down the staircase
    const limeMat = new THREE.MeshStandardMaterial({ color: LIME, emissive: new THREE.Color(LIME), emissiveIntensity: 1.05, roughness: 0.4 });
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    this.trailCyl = new THREE.InstancedMesh(cyl, limeMat, 1);
    this.trailBall = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), limeMat, 1);
    for (const m of [this.trailCyl, this.trailBall]) {
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }

    // brass start pin
    this.pin = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.11, 0.62, 24), brass);
    stem.position.y = 0.31;
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.07, 32), brass);
    collar.position.y = 0.035;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.2, 32, 20), brass);
    knob.scale.y = 0.8;
    knob.position.y = 0.72;
    for (const m of [stem, collar, knob]) {
      m.castShadow = true;
      this.pin.add(m);
    }
    scene.add(this.pin);

    // copper goal flag
    this.flag = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 1.55, 16), copper);
    pole.position.y = 0.775;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.08, 28), copper);
    foot.position.y = 0.04;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), copper);
    ball.position.y = 1.58;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(0.78, -0.24);
    shape.lineTo(0, -0.5);
    shape.lineTo(0, 0);
    const clothGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.025, bevelEnabled: false });
    clothGeo.translate(0.03, 1.5, -0.0125);
    this.flagCloth = new THREE.Mesh(clothGeo, new THREE.MeshStandardMaterial({ color: "#c8703f", metalness: 0.85, roughness: 0.38, side: THREE.DoubleSide, roughnessMap: brushed }));
    for (const m of [pole, foot, ball, this.flagCloth]) {
      m.castShadow = true;
      this.flag.add(m);
    }
    scene.add(this.flag);

    // the lime glass marble
    this.marble = new THREE.Group();
    const glass = new THREE.MeshPhysicalMaterial({ color: "#c6f56a", roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, transparent: true, opacity: 0.82, emissive: new THREE.Color("#5c9a12"), emissiveIntensity: 0.2, envMapIntensity: 2.6, specularIntensity: 1 });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), glass);
    shell.castShadow = true;
    this.marbleCore = new THREE.Mesh(new THREE.SphereGeometry(0.62, 24, 16), new THREE.MeshStandardMaterial({ color: LIME, emissive: new THREE.Color(LIME), emissiveIntensity: 0.9 }));
    this.marble.add(this.marbleCore, shell);
    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: canvasTex(64, 64, (g) => {
          const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
          grd.addColorStop(0, "rgba(190,255,90,0.55)");
          grd.addColorStop(1, "rgba(190,255,90,0)");
          g.fillStyle = grd;
          g.fillRect(0, 0, 64, 64);
        }),
        transparent: true,
        depthWrite: false,
      }),
    );
    this.halo.scale.setScalar(4);
    this.marble.add(this.halo);
    this.marble.visible = false;
    scene.add(this.marble);

    // brass counters on the bench
    this.ticksCtr = this.makeCounter(4, "TICKS", brass, true);
    this.ticksCtr.g.position.set(-5.1, 0, TRAY / 2 + RIM + 1.25);
    this.ticksCtr.g.rotation.y = 0.12;
    this.routeCtr = this.makeCounter(3, "SHORTEST WAY OUT", brass, false);
    this.routeCtr.g.position.set(5.1, 0, TRAY / 2 + RIM + 1.25);
    this.routeCtr.g.rotation.y = -0.12;
    this.benchG.add(this.ticksCtr.g, this.routeCtr.g);
    scene.add(this.benchG);
  }

  private makeCounter(digits: number, label: string, brass: THREE.Material, lamp: boolean): Counter {
    const g = new THREE.Group();
    const w = digits * 0.42 + 0.5;
    const housing = new THREE.Mesh(new RoundedBoxGeometry(w, 0.62, 0.9, 3, 0.08), brass);
    housing.position.y = 0.31;
    housing.castShadow = housing.receiveShadow = true;
    g.add(housing);
    const slot = new THREE.Mesh(new THREE.BoxGeometry(digits * 0.42 + 0.06, 0.44, 0.1), new THREE.MeshStandardMaterial({ color: "#16110b", roughness: 0.7 }));
    slot.position.set(0, 0.34, 0.42);
    g.add(slot);
    const tex = wheelTex();
    const wheelMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 });
    const wheels: THREE.Object3D[] = [];
    for (let k = 0; k < digits; k++) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.36, 40, 1, false), [wheelMat, brass, brass]);
      wh.rotation.z = Math.PI / 2;
      const holder = new THREE.Group();
      holder.position.set((k - (digits - 1) / 2) * 0.42, 0.34, 0.24);
      holder.add(wh);
      g.add(holder);
      wheels.push(holder);
    }
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.92, 0.2), new THREE.MeshStandardMaterial({ map: textTex([label], { w: 512, h: 64, px: 34, color: "#2a1d0c" }), transparent: true, roughness: 0.5, metalness: 0.2 }));
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(0, 0.625, 0.18);
    g.add(plate);
    const c: Counter = { g, wheels, shown: 0 };
    if (lamp) {
      const lm = new THREE.MeshStandardMaterial({ color: "#2c3324", emissive: new THREE.Color(LIME), emissiveIntensity: 0, roughness: 0.3 });
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 14), lm);
      l.position.set(w / 2 - 0.2, 0.66, -0.22);
      g.add(l);
      c.lamp = lm;
    }
    return c;
  }

  private setCounter(c: Counter, value: number, dt: number, snap: boolean): void {
    const v = Math.max(0, value);
    c.shown = snap || this.reduced ? v : c.shown + (v - c.shown) * (1 - Math.exp(-dt * 10));
    if (Math.abs(c.shown - v) < 0.002) c.shown = v;
    const D = c.wheels.length;
    for (let k = 0; k < D; k++) {
      const p = 10 ** k;
      const below = c.shown % p;
      const roll = k === 0 ? c.shown % 10 : Math.floor(c.shown / p) % 10 + Math.max(0, below - (p - 1));
      c.wheels[D - 1 - k].rotation.x = -(roll / 10) * Math.PI * 2 + 0.06;
    }
  }

  // ───────────────────────── board building ─────────────────────────

  private buildTiles(n: number): void {
    if (this.tiles) {
      this.scene.remove(this.tiles);
      this.tiles.dispose();
      this.tileGeo?.dispose();
    }
    const N = n * n, c = cellSize(n);
    const half = 0.06 * c;
    const w = 0.92 * c;
    const geo = new RoundedBoxGeometry(w, 2 * half, w, 2, Math.min(0.05 * c, half * 0.9));
    this.tileU.uHalf.value = half;
    this.tileU.uTileW.value = w;
    this.aH = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    this.aInfo = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this.aH.setUsage(THREE.DynamicDrawUsage);
    this.aInfo.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aH", this.aH);
    geo.setAttribute("aInfo", this.aInfo);
    const mesh = new THREE.InstancedMesh(geo, this.tileMat, N);
    mesh.customDepthMaterial = this.tileDepth;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    for (let i = 0; i < N; i++) {
      const [x, z] = cellXZ(i, n);
      this.tmpM.makeTranslation(x, 0, z);
      mesh.setMatrixAt(i, this.tmpM);
      mesh.setColorAt(i, new THREE.Color(1, 1, 1));
    }
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.tileGeo = geo;
    this.tiles = mesh;
    this.tumbling.clear();
    this.scene.add(mesh);
    // the trail can be as long as the board
    for (const [m, k] of [
      [this.trailCyl, 3 * N],
      [this.trailBall, 2 * N + 1],
    ] as [THREE.InstancedMesh, number][]) {
      if (m.instanceMatrix.count < k) {
        const nm = new THREE.InstancedMesh(m.geometry, m.material, k);
        nm.frustumCulled = false;
        nm.count = 0;
        nm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.remove(m);
        m.dispose();
        this.scene.add(nm);
        if (m === this.trailCyl) this.trailCyl = nm;
        else this.trailBall = nm;
      }
    }
    // markers scale with the cell, within reason
    const u = Math.max(0.42, c) / 0.5;
    this.pin.scale.setScalar(u);
    this.flag.scale.setScalar(u * 1.05);
    this.fitKey = "";
  }

  private buildWalls(m: Model): void {
    const n = m.n, c = cellSize(n), mz = m.maze;
    this.wallSegs = [];
    const postIdx = new Map<number, number>();
    this.postList = [];
    const post = (vx: number, vy: number, seg: number) => {
      const key = vy * (n + 1) + vx;
      let k = postIdx.get(key);
      if (k === undefined) {
        k = this.postList.length;
        postIdx.set(key, k);
        this.postList.push({ x: -TRAY / 2 + vx * c, z: TRAY / 2 - vy * c, segs: [] });
      }
      this.postList[k].segs.push(seg);
    };
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        // back edge of this cell (and the front border for row 0)
        if (hasWall(mz, i, 0)) {
          const s = this.wallSegs.length;
          this.wallSegs.push({ a: i, b: y < n - 1 ? i + n : -1, x: -TRAY / 2 + (x + 0.5) * c, z: TRAY / 2 - (y + 1) * c, along: "x" });
          post(x, y + 1, s);
          post(x + 1, y + 1, s);
        }
        if (y === 0) {
          const s = this.wallSegs.length;
          this.wallSegs.push({ a: i, b: -1, x: -TRAY / 2 + (x + 0.5) * c, z: TRAY / 2, along: "x" });
          post(x, 0, s);
          post(x + 1, 0, s);
        }
        if (hasWall(mz, i, 1)) {
          const s = this.wallSegs.length;
          this.wallSegs.push({ a: i, b: x < n - 1 ? i + 1 : -1, x: -TRAY / 2 + (x + 1) * c, z: TRAY / 2 - (y + 0.5) * c, along: "z" });
          post(x + 1, y, s);
          post(x + 1, y + 1, s);
        }
        if (x === 0) {
          const s = this.wallSegs.length;
          this.wallSegs.push({ a: i, b: -1, x: -TRAY / 2, z: TRAY / 2 - (y + 0.5) * c, along: "z" });
          post(0, y, s);
          post(0, y + 1, s);
        }
      }
    const grow = (mesh: THREE.InstancedMesh, k: number): THREE.InstancedMesh => {
      if (mesh.instanceMatrix.count >= k) return mesh;
      const nm = new THREE.InstancedMesh(mesh.geometry, mesh.material, Math.ceil(k * 1.2));
      nm.castShadow = nm.receiveShadow = true;
      nm.frustumCulled = false;
      nm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.remove(mesh);
      mesh.dispose();
      this.scene.add(nm);
      return nm;
    };
    this.walls = grow(this.walls, this.wallSegs.length);
    this.posts = grow(this.posts, this.postList.length);
    this.walls.count = this.wallSegs.length;
    this.posts.count = this.postList.length;
    this.wallTop = new Float32Array(this.wallSegs.length);
  }

  // ───────────────────────── layout and camera ─────────────────────────

  resize(w: number, h: number, layout: Layout): void {
    this.W = w;
    this.H = h;
    const was = this.layout.phone;
    this.layout = layout;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.pr = this.renderer.getPixelRatio();
    this.bloom.resolution.set(Math.max(64, Math.round((w * this.pr) / 2)), Math.max(64, Math.round((h * this.pr) / 2)));
    this.camera.aspect = w / h;
    const cxp = layout.x + layout.w / 2, cyp = layout.y + layout.h / 2;
    this.camera.setViewOffset(w, h, w / 2 - cxp, h / 2 - cyp, w, h);
    this.camera.updateProjectionMatrix();
    this.benchG.visible = !layout.phone;
    this.fitKey = "";
    if (was !== layout.phone) this.resetCamera();
  }

  private baseDir(trailDone: boolean): { az: number; el: number } {
    if (this.og) return { az: -0.2, el: 0.84 };
    if (this.layout.phone) return { az: -0.1, el: trailDone ? 1.0 : 1.08 };
    return { az: -0.24, el: trailDone ? 0.78 : 0.9 };
  }

  private framePts(): THREE.Vector3[] {
    const E = TRAY / 2 + RIM;
    const top = HMAX * 0.75;
    const pts = [
      [-E, 0, -E],
      [E, 0, -E],
      [-E, 0, E],
      [E, 0, E],
      [-E * 0.8, top, -E * 0.8],
      [E * 0.8, top, -E * 0.8],
      [E - 0.6, HMAX * 0.6 + 1.6, -E + 0.6],
    ];
    if (!this.layout.phone) pts.push([-6.5, 0, E + 1.9], [6.5, 0, E + 1.9], [-6.5, 0.7, E + 0.9]);
    return pts.map((p) => new THREE.Vector3(...p));
  }

  private fit(az: number, el: number): { c: THREE.Vector3; d: number } {
    const key = `${az.toFixed(3)}|${el.toFixed(3)}|${this.W}|${this.H}|${this.layout.x}|${this.layout.w}|${this.layout.h}`;
    if (key === this.fitKey) return this.fitRes;
    const pts = this.framePts();
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of pts) {
      lo.min(p);
      hi.max(p);
    }
    const c = lo.add(hi).multiplyScalar(0.5);
    c.y = 0.6;
    const t = Math.tan(((FOV / 2) * Math.PI) / 180);
    const ax = (this.layout.w / this.W) * (this.layout.phone ? 0.9 : 0.95), ay = (this.layout.h / this.H) * 0.93;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const right = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az));
    const upv = new THREE.Vector3().crossVectors(dir, right);
    const box = { x0: 0, x1: 0, y0: 0, y1: 0 };
    const inv = new THREE.Matrix4();
    const ok = (d: number) => {
      const cam = c.clone().addScaledVector(dir, d);
      inv.lookAt(cam, c, new THREE.Vector3(0, 1, 0)).setPosition(cam).invert();
      box.x0 = box.y0 = Infinity;
      box.x1 = box.y1 = -Infinity;
      let good = true;
      for (const p of pts) {
        const v = p.clone().applyMatrix4(inv);
        if (v.z > -0.1) return false;
        const nx = v.x / -v.z / (t * this.camera.aspect), ny = v.y / -v.z / t;
        box.x0 = Math.min(box.x0, nx);
        box.x1 = Math.max(box.x1, nx);
        box.y0 = Math.min(box.y0, ny);
        box.y1 = Math.max(box.y1, ny);
        if (Math.abs(nx) > ax || Math.abs(ny) > ay) good = false;
      }
      return good;
    };
    let b = 160;
    for (let pass = 0; pass < 3; pass++) {
      let a = 2;
      b = 160;
      for (let i = 0; i < 32; i++) {
        const m = (a + b) / 2;
        if (ok(m)) b = m;
        else a = m;
      }
      ok(b);
      const mx = (box.x0 + box.x1) / 2, my = (box.y0 + box.y1) / 2;
      c.addScaledVector(right, mx * b * t * this.camera.aspect).addScaledVector(upv, my * b * t);
    }
    this.fitKey = key;
    this.fitRes = { c, d: b };
    return this.fitRes;
  }

  resetCamera(model?: Model): void {
    const { az, el } = this.baseDir(!!model?.trailComplete && !model?.wowActive);
    this.trailEl = 0;
    this.zoomF = 1;
    const f = this.fit(az, el);
    this.camCentre.copy(f.c);
    this.camDist = f.d;
    this.controls.target.copy(f.c);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    this.camera.position.copy(f.c).addScaledVector(dir, f.d);
    this.controls.minDistance = f.d * 0.45;
    this.controls.maxDistance = f.d * 1.7;
    this.idle = 0;
    this.drift = 0;
    this.controls.update();
  }
  cameraPose(): number[] {
    return [...this.camera.position.toArray(), ...this.controls.target.toArray()];
  }
  setCameraPose(p: number[]): void {
    this.camera.position.fromArray(p, 0);
    this.controls.target.fromArray(p, 3);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }
  poke(): void {
    this.idle = -5;
  }

  private updateCamera(dt: number, m: Model): void {
    // when the trail completes, ease a little lower so the staircase reads as a hill
    const lower = m.trailComplete && !this.og ? 1 : 0;
    const dEl = (this.baseDir(true).el - this.baseDir(false).el) * lower;
    const prev = this.trailEl;
    this.trailEl += (dEl - this.trailEl) * (this.reduced ? 1 : 1 - Math.exp(-dt * 1.2));
    const base = this.baseDir(false);
    // frame for where the camera is heading (quantised so the fit is cached)
    const f = this.fit(base.az, base.el + Math.round(dEl * lower * 20) / 20);
    if (!this.interacting) {
      const k = 1 - Math.exp(-dt * 2.4);
      this.camCentre.lerp(f.c, k);
      this.camDist += (f.d - this.camDist) * k;
      this.controls.target.copy(this.camCentre);
      const off = this.camera.position.clone().sub(this.controls.target);
      const sph = new THREE.Spherical().setFromVector3(off);
      let az = sph.theta, el = Math.PI / 2 - sph.phi;
      el += this.trailEl - prev;
      this.idle += dt;
      if (!this.reduced && this.idle > 0) {
        const nd = 0.07 * Math.sin(this.time * 0.16);
        const dAz = (nd - this.drift) * Math.min(1, this.idle / 3);
        this.drift += dAz;
        az += dAz;
      }
      el = Math.min(1.35, Math.max(0.3, el));
      const dist = this.camDist * this.zoomF;
      const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
      this.controls.minDistance = f.d * 0.45;
      this.controls.maxDistance = f.d * 1.7;
    }
    this.controls.update();
  }

  settle(dt: number, m: Model): void {
    this.time += dt;
    this.anim.update(dt, m);
    this.updateCamera(dt, m);
  }

  // ───────────────────────── per frame ─────────────────────────

  render(dt: number, m: Model): void {
    this.time += dt;
    if (m.n !== this.n) {
      this.n = m.n;
      this.buildTiles(m.n);
      this.mazeVersion = -1;
    }
    if (m.mazeVersion !== this.mazeVersion) {
      this.mazeVersion = m.mazeVersion;
      this.buildWalls(m);
    }
    this.anim.update(dt, m);
    this.updateTiles(m);
    this.updateWalls(m);
    this.updateTrail(m);
    this.updateMarkers(dt, m);
    this.updateHover(m);
    this.updateCamera(dt, m);
    this.composer.render();
  }

  private updateTiles(m: Model): void {
    const mesh = this.tiles!;
    const a = this.anim, n = m.n, N = n * n;
    const H = this.aH.array as Float32Array;
    const I = this.aInfo.array as Float32Array;
    const C = mesh.instanceColor!.array as Float32Array;
    // trail links: bit 1 back, 2 right, 4 front, 8 left, +16 on the trail
    const tmask = new Uint8Array(N);
    const tr = m.trail;
    for (let k = 0; k < tr.length; k++) {
      const i = tr[k];
      tmask[i] |= 16;
      if (k > 0) {
        const j = tr[k - 1];
        const dir = j === i + n ? 1 : j === i + 1 ? 2 : j === i - n ? 4 : 8;
        tmask[i] |= dir;
        tmask[j] |= dir === 1 ? 4 : dir === 2 ? 8 : dir === 4 ? 1 : 2;
      }
    }
    const cone = m.showCone;
    const cm = a.colourMax;
    for (let i = 0; i < N; i++) {
      H[i] = a.h[i];
      const d = m.field[i];
      I[4 * i] = d === INF ? -1 : d;
      I[4 * i + 1] = a.glow[i];
      I[4 * i + 2] = tmask[i];
      let cmask = 0;
      if (cone && m.inCone(i)) {
        for (let dir = 0; dir < 4; dir++) {
          const x = i % n, y = (i / n) | 0;
          const nx = x + [0, 1, 0, -1][dir], ny = y + [1, 0, -1, 0][dir];
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          if (!m.inCone(ny * n + nx)) cmask |= 1 << dir;
        }
      }
      I[4 * i + 3] = cmask;
      if (d === INF) {
        C[3 * i] = UNKNOWN_LIN[0];
        C[3 * i + 1] = UNKNOWN_LIN[1];
        C[3 * i + 2] = UNKNOWN_LIN[2];
      } else {
        const k = rampIndex(d, cm) * 3;
        C[3 * i] = RAMP_LIN[k];
        C[3 * i + 1] = RAMP_LIN[k + 1];
        C[3 * i + 2] = RAMP_LIN[k + 2];
      }
      // tumbling tiles after a smash
      if (a.tumble[i] > 0 || this.tumbling.has(i)) {
        const tb = a.tumbleOf(i);
        const [x, z] = cellXZ(i, n);
        const ang = a.axis[i];
        this.tmpM.makeRotationAxis(this.tmpV.set(Math.cos(ang), 0, Math.sin(ang)), tb.a);
        this.tmpM.setPosition(x, tb.up, z);
        mesh.setMatrixAt(i, this.tmpM);
        if (a.tumble[i] > 0) this.tumbling.add(i);
        else this.tumbling.delete(i);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.aH.needsUpdate = true;
    this.aInfo.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
  }

  private updateWalls(m: Model): void {
    const a = this.anim, c = cellSize(m.n);
    const rise = wallRise(m.n), t = Math.max(0.03, 0.13 * c);
    const W = this.walls.instanceMatrix.array as Float32Array;
    const set = (A: Float32Array, k: number, sx: number, sy: number, sz: number, x: number, z: number) => {
      const o = 16 * k;
      A[o] = sx;
      A[o + 1] = A[o + 2] = A[o + 3] = A[o + 4] = 0;
      A[o + 5] = sy;
      A[o + 6] = A[o + 7] = A[o + 8] = A[o + 9] = 0;
      A[o + 10] = sz;
      A[o + 11] = 0;
      A[o + 12] = x;
      A[o + 13] = 0;
      A[o + 14] = z;
      A[o + 15] = 1;
    };
    for (let k = 0; k < this.wallSegs.length; k++) {
      const s = this.wallSegs[k];
      const top = Math.max(a.h[s.a], s.b >= 0 ? a.h[s.b] : 0) + rise;
      this.wallTop[k] = top;
      if (s.along === "x") set(W, k, c, top, t, s.x, s.z);
      else set(W, k, t, top, c, s.x, s.z);
    }
    const P = this.posts.instanceMatrix.array as Float32Array;
    for (let k = 0; k < this.postList.length; k++) {
      const p = this.postList[k];
      let top = 0;
      for (const s of p.segs) top = Math.max(top, this.wallTop[s]);
      set(P, k, t * 1.08, top + 0.002, t * 1.08, p.x, p.z);
    }
    this.walls.instanceMatrix.needsUpdate = true;
    this.posts.instanceMatrix.needsUpdate = true;
  }

  private updateTrail(m: Model): void {
    const tr = m.trail, n = m.n, c = cellSize(n), a = this.anim;
    const r = Math.max(0.014, 0.045 * c);
    const lift = r * 1.2;
    let kc = 0, kb = 0;
    const cylA = this.trailCyl.instanceMatrix.array as Float32Array;
    const S = new THREE.Vector3();
    const P = new THREE.Vector3();
    const cyl = (x: number, y: number, z: number, len: number, q: THREE.Quaternion) => {
      if (len <= 1e-4) return;
      S.set(r, len, r);
      P.set(x, y, z);
      this.tmpM.compose(P, q, S);
      this.tmpM.toArray(cylA, 16 * kc++);
    };
    const ballA = this.trailBall.instanceMatrix.array as Float32Array;
    const ball = (x: number, y: number, z: number) => {
      this.tmpM.makeScale(r, r, r).setPosition(x, y, z);
      this.tmpM.toArray(ballA, 16 * kb++);
    };
    if (tr.length) {
      const [x0, z0] = cellXZ(tr[0], n);
      ball(x0, a.top(tr[0]) + lift, z0);
    }
    for (let k = 1; k < tr.length; k++) {
      const i = tr[k - 1], j = tr[k];
      const [xi, zi] = cellXZ(i, n), [xj, zj] = cellXZ(j, n);
      const yi = a.top(i) + lift, yj = a.top(j) + lift;
      const mx = (xi + xj) / 2, mz = (zi + zj) / 2;
      const q = Math.abs(xj - xi) > 1e-6 ? this.qX : this.qZ;
      cyl((xi + mx) / 2, yi, (zi + mz) / 2, c / 2, q);
      cyl(mx, (yi + yj) / 2, mz, Math.abs(yi - yj), this.qY);
      cyl((mx + xj) / 2, yj, (mz + zj) / 2, c / 2, q);
      ball(mx, yi, mz);
      ball(mx, yj, mz);
    }
    this.trailCyl.count = kc;
    this.trailBall.count = kb;
    this.trailCyl.instanceMatrix.needsUpdate = true;
    this.trailBall.instanceMatrix.needsUpdate = true;
  }

  private updateMarkers(dt: number, m: Model): void {
    const a = this.anim, n = m.n;
    const [sx, sz] = cellXZ(m.start, n);
    this.pin.position.set(sx, a.top(m.start), sz);
    const [gx, gz] = cellXZ(m.goal, n);
    this.flag.position.set(gx, a.top(m.goal), gz);
    this.flag.rotation.y = -0.5;
    const wave = this.reduced ? 0 : Math.sin(this.time * 2.1) * 0.08;
    this.flagCloth.rotation.y = wave;
    const mb = a.marble;
    this.marble.visible = mb.on;
    if (mb.on) {
      const r = 0.5 * cellSize(n);
      this.marble.position.set(mb.x, mb.y, mb.z);
      this.marble.scale.setScalar(Math.max(0.1, r));
      this.marbleCore.rotation.set(mb.rx, 0, mb.rz);
      this.halo.material.opacity = 0.55;
    }
    // counters on the bench
    this.setCounter(this.ticksCtr, m.ticks % 10000, dt, m.ticks === 0);
    const g = m.field[m.goal];
    this.setCounter(this.routeCtr, g === INF ? 0 : g % 1000, dt, g === INF);
    if (this.ticksCtr.lamp) this.ticksCtr.lamp.emissiveIntensity = m.settled && m.reached > 1 ? 3 : 0;
    // anchors for the HTML labels
    const c = cellSize(n);
    this.anchorPts.start = new THREE.Vector3(sx, a.top(m.start) + 0.9 * this.pin.scale.y, sz);
    this.anchorPts.goal = new THREE.Vector3(gx + 0.3, a.top(m.goal) + 1.5 * this.flag.scale.y, gz);
    const rule = this.ruleTile(m);
    if (rule >= 0) {
      const [x, z] = cellXZ(rule, n);
      this.anchorPts.rule = new THREE.Vector3(x, a.top(rule), z);
    } else this.anchorPts.rule = null;
    const front = this.frontTile(m);
    if (front >= 0) {
      const [x, z] = cellXZ(front, n);
      this.anchorPts.front = new THREE.Vector3(x, a.top(front) + c * 0.1, z);
    } else this.anchorPts.front = null;
    if (m.smashed && m.smashCells.length) {
      const mid = m.smashCells[Math.floor(m.smashCells.length / 2)];
      const [x, z] = cellXZ(mid, n);
      this.anchorPts.smash = new THREE.Vector3(x, a.top(mid) + c * 0.5, z);
    } else this.anchorPts.smash = null;
    if (mb.on) this.anchorPts.marble = new THREE.Vector3(mb.x, mb.y, mb.z);
    else this.anchorPts.marble = null;
  }

  /** a reached tile partway up the staircase (on the trail if there is one) to hang the rule label on */
  private ruleTile(m: Model): number {
    if (m.trail.length > 6) return m.trail[Math.floor(m.trail.length * 0.7)];
    if (m.reached < 6) return -1;
    const want = Math.round(m.fieldMax * 0.45);
    for (let i = 0; i < m.N; i++) if (m.field[i] === want) return i;
    return -1;
  }

  /** a tile on the wave front: the furthest tile that changed in the last tick */
  private frontTile(m: Model): number {
    if (!m.playing || m.fixed) return -1;
    let best = -1, bd = -1;
    for (let i = 0; i < m.N; i++) {
      if (this.anim.glow[i] > 0.6 && m.field[i] !== INF && m.field[i] > bd) {
        bd = m.field[i];
        best = i;
      }
    }
    return best;
  }

  hover(e: EdgePick | null): void {
    this.hoverEdge = e;
  }

  private updateHover(m: Model): void {
    const e = this.hoverEdge;
    if (!e || e.i >= m.N) {
      this.ghost.visible = false;
      return;
    }
    const n = m.n, c = cellSize(n);
    const [x, z] = cellXZ(e.i, n);
    const j = e.i + [n, 1, -n, -1][e.dir];
    const top = Math.max(this.anim.h[e.i], this.anim.h[j] ?? 0) + wallRise(n) + 0.01;
    const t = Math.max(0.05, 0.2 * c);
    const ex = x + [0, c / 2, 0, -c / 2][e.dir], ez = z + [-c / 2, 0, c / 2, 0][e.dir];
    const along = e.dir === 0 || e.dir === 2;
    this.ghost.position.set(ex, 0, ez);
    this.ghost.scale.set(along ? c * 1.02 : t, top, along ? t : c * 1.02);
    const wall = hasWall(m.maze, e.i, e.dir);
    this.ghostMat.color.set(wall ? "#c9f07a" : "#8b6a4c");
    this.ghostMat.emissiveIntensity = wall ? 0.5 : 0.15;
    this.ghostMat.opacity = wall ? 0.55 : 0.5;
    this.ghost.visible = true;
  }

  // ───────────────────────── picking and anchors ─────────────────────────

  pick(px: number, py: number, m: Model): TilePick | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((px - rect.left) / rect.width) * 2 - 1, -((py - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    if (d.y >= 0) return null;
    const n = m.n, c = cellSize(n), half = TRAY / 2;
    // march down the ray through the height field of tile tops (and wall ridges)
    const yTop = HMAX + 1.5;
    let t = Math.max(0, (yTop - o.y) / d.y);
    const tEnd = (0 - o.y) / d.y + 0.01;
    const stepL = c / 6;
    for (; t <= tEnd; t += stepL) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (x < -half || x > half || z < -half || z > half) {
        if (y < 0) break;
        continue;
      }
      const gx = Math.min(n - 1, Math.floor((x + half) / c)), gy = Math.min(n - 1, Math.floor((half - z) / c));
      const i = gy * n + gx;
      if (y <= this.anim.h[i] + 0.002) {
        const lx = (x + half) / c - gx - 0.5, ly = (half - z) / c - gy - 0.5;
        return { i, lx, ly };
      }
    }
    return null;
  }

  anchors(): Anchors {
    const out: Anchors = {};
    const W = this.W, H = this.H;
    for (const [k, p] of Object.entries(this.anchorPts)) {
      if (!p) continue;
      const v = p.clone().project(this.camera);
      out[k] = { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H, on: v.z < 1 && v.z > -1 };
    }
    return out;
  }

  setShowNumbers(on: boolean): void {
    this.tileU.uShowNum.value = on ? 1 : 0;
  }

  dispose(): void {
    this.controls.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

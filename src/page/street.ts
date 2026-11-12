/**
 * The street: a run as a jeepney trip, in 3D. The owner's route is the far road. Each peer on the allowed list has its own road, nearer to the viewer.
 * Each agent is a robot at a waiting shed. The jeepney carries the work from stop to stop, and each step of the trip is one move.
 * It shows only what the trip of the run says. All text goes on a canvas as text, never as HTML.
 * The houses, the trees and the lamps are scenery. The light theme is a late afternoon; the dark theme is a night.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Trip, TripStep } from '../trip-view.ts';

// World: x along the routes, y = depth (far to near), z = height. In three.js: X = x, Y = z, Z = y.
const ROLES = ['trend_scout', 'script', 'reviewer', 'scheduler'];
const NAMES = ['Trend scout', 'Script', 'Reviewer', 'Scheduler'];
const SX = [3.5, 9.5, 15.5, 21.5];
const CROSS = [0.2, 6.5, 12.5, 18.5, 24.8];
const OWN = 1;
const PEER = 7.8;
/** From one road to the next. */
const GAP = PEER - OWN;
/** The jeepney stops a little before a shed, so that it does not hide the robots. */
const PARK = 2.7;
const HOME = { x: 10.1, y: 15.4, z: 27.4 };
const CENTRE = { x: 12.5, y: 0, z: 4 };

type BotState = 'idle' | 'working' | 'done' | 'blocked';
type Bot = { group: THREE.Group; parts: THREE.MeshStandardMaterial[]; tip: THREE.MeshStandardMaterial; badge: THREE.Sprite; done: THREE.Texture; blocked: THREE.Texture; state: BotState };
type Panel = { texture: THREE.CanvasTexture; set(text: string): void; width: number; height: number };

export type Street = {
  /** Shows the trip of a run. A new `key` (a different run) shows its state now; more steps of the same run are played one by one. */
  show(key: string, trip: Trip, names: { owner: string; peers?: string[] }): void;
  /** Plays the trip of the run from its start. */
  replay(): void;
  follow(on: boolean): void;
  resetView(): void;
};

export type StreetOptions = {
  /** The sentence of the step that plays now. */
  say(text: string, tone: string): void;
  /** The presenter selected a shed of the owner's route (demo mode). `x` and `y` are in the page. */
  onShed(role: string, x: number, y: number): void;
  /** The parts of the view that panels cover, in pixels from each side. */
  inset?(): { top: number; right: number; bottom: number; left: number };
};

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--st-${name}`).trim();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Makes the street in `view`. It returns null when the browser cannot draw 3D: the page then shows the list and the result only. */
export function createStreet(view: HTMLElement, options: StreetOptions): Street | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch {
    return null;
  }
  // The light theme is a late afternoon. The dark theme is a night with lamps. A change of theme loads the page again.
  const night = document.documentElement.dataset.theme === 'dark';
  const SKY = night ? ['#060a1a', '#131a38', '#2b3156'] : ['#3f86d4', '#a8c9ea', '#f7c58c']; // top, middle, horizon
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY[2]);
  scene.fog = new THREE.Fog(SKY[2], 60, 240); // far things are paler, as in real air
  const camera = new THREE.PerspectiveCamera(30, 2, 1, 700);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = night ? 1.15 : 1;
  view.append(renderer.domElement);
  // A plain scroll moves the page. A scroll with Ctrl or ⌘ (and a pinch) zooms the street. This goes before the controls, so that they do not get a plain scroll.
  renderer.domElement.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) event.stopImmediatePropagation();
  });
  const controls = new OrbitControls(camera, renderer.domElement);
  Object.assign(controls, { enableDamping: true, maxPolarAngle: 1.45, minDistance: 10, maxDistance: 130 });

  /** A picture made in code: `draw` paints it. No picture files. */
  function painted(width: number, height: number, draw: (g: CanvasRenderingContext2D) => void, tile = true) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    draw(canvas.getContext('2d')!);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    if (tile) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    return texture;
  }
  /** Small light and dark specks, as on asphalt and concrete. */
  function specks(g: CanvasRenderingContext2D, size: number, count: number) {
    for (let n = 0; n < count; n++) {
      g.fillStyle = n % 3 ? `rgb(0 0 0 / ${0.06 + Math.random() * 0.16})` : `rgb(255 255 255 / ${0.04 + Math.random() * 0.1})`;
      g.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
  }
  const soft = painted(128, 128, (g) => {
    const glow = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    glow.addColorStop(0, 'rgb(255 255 255 / 1)');
    glow.addColorStop(0.25, 'rgb(255 255 255 / 0.5)');
    glow.addColorStop(1, 'rgb(255 255 255 / 0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, 128, 128);
  }, false);
  /** A soft light around a lamp or the sun: what a camera and an eye see around a bright point. */
  function halo(parent: THREE.Object3D, x: number, y: number, z: number, size: number, colour: string, opacity = 1) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: soft, color: colour, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }));
    sprite.scale.setScalar(size);
    sprite.position.set(x, z, y);
    parent.add(sprite);
    return sprite;
  }

  // The sky: a dome with the colours of the hour, and stars at night. The metal and the glass reflect it.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(320, 32, 16),
    new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      fog: false,
      toneMapped: false,
      depthWrite: false,
      map: painted(512, 256, (g) => {
        const sky = g.createLinearGradient(0, 0, 0, 256);
        sky.addColorStop(0, SKY[0]!);
        sky.addColorStop(0.36, SKY[1]!);
        sky.addColorStop(0.5, SKY[2]!);
        sky.addColorStop(1, SKY[2]!);
        g.fillStyle = sky;
        g.fillRect(0, 0, 512, 256);
        if (night) for (let n = 0; n < 260; n++) (g.fillStyle = `rgb(255 255 255 / ${0.3 + Math.random() * 0.7})`), g.fillRect(Math.random() * 512, Math.random() * 110, 1, 1);
      }, false),
    }),
  );
  dome.position.set(CENTRE.x, 0, CENTRE.z);
  scene.add(dome);
  const reflected = new THREE.Scene();
  reflected.add(dome.clone());
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(reflected, 0, 1, 700).texture;
  scene.environmentIntensity = night ? 0.7 : 0.85;

  scene.add(new THREE.HemisphereLight(night ? 0x5b6cb0 : 0xcfe0ff, night ? 0x1a1c24 : 0x9a8468, night ? 0.85 : 0.7));
  // By day: a low warm sun from the front left, so the shadows are long. By night: a pale moon.
  const SUN = night ? new THREE.Vector3(8, 22, 10) : new THREE.Vector3(-17, 10.5, 12);
  const sun = new THREE.DirectionalLight(night ? 0x8fa3ff : 0xffc88a, night ? 0.7 : 3.1);
  sun.target.position.set(CENTRE.x, 0, CENTRE.z);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 5;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  if (!night) halo(scene, CENTRE.x + SUN.x * 14, CENTRE.z + SUN.z * 14, SUN.y * 14, 110, '#ffdca0', 0.9);

  // ---- the parts ----
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  // Colours that the page does not have, and how each surface takes the light: rough like asphalt, or smooth like chrome.
  const MORE: Record<string, string> = night
    ? { chrome: '#cfd6de', tyre: '#0c0d10', earth: '#18231d', leaf: '#1f4a33', trunk: '#3a2d22', wall: '#4a4f5c', wall2: '#5a4a44', wall3: '#3f5560', roof: '#7a2a2f', lamp: '#ffe2a0', seat: '#8f1f2a' }
    : { chrome: '#e9eef3', tyre: '#17191d', earth: '#8a9a66', leaf: '#3f8a52', trunk: '#6a4f37', wall: '#f1e3c4', wall2: '#e9b7a0', wall3: '#a9d0d8', roof: '#b3353c', lamp: '#fff3cf', seat: '#c2333d' };
  const LOOK: Record<string, [rough: number, metal: number]> = { steel: [0.32, 0.4], chrome: [0.08, 1], glass: [0.06, 0.5], tyre: [0.9, 0], road: [0.95, 0], sign: [0.45, 0.1], block: [0.4, 0.2], route: [0.45, 0.1], peer: [0.45, 0.1], backup: [0.45, 0.1], white: [0.6, 0], lamp: [0.4, 0] };
  const tint = (name: string) => MORE[name] ?? css(name);
  const material = (name: string) =>
    materials.get(name) ?? materials.set(name, new THREE.MeshStandardMaterial({ color: new THREE.Color(tint(name)), roughness: LOOK[name]?.[0] ?? 0.82, metalness: LOOK[name]?.[1] ?? 0 })).get(name)!;
  // What gives light: lamps, headlights, lit windows.
  Object.assign(material('lamp'), { emissive: new THREE.Color(MORE.lamp), emissiveIntensity: night ? 2.2 : 0.25 });
  /** A surface with a picture on it, repeated so that its grain keeps one size on each box. */
  function surface(texture: THREE.Texture, w: number, d: number, per: number, rough: number) {
    const map = texture.clone();
    map.repeat.set(w / per, d / per);
    map.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ map, roughness: rough });
  }
  const asphalt = painted(256, 256, (g) => {
    g.fillStyle = css('road');
    g.fillRect(0, 0, 256, 256);
    specks(g, 256, 5200);
  });
  const tiles = painted(256, 256, (g) => {
    g.fillStyle = css('ground');
    g.fillRect(0, 0, 256, 256);
    specks(g, 256, 1800);
    g.strokeStyle = 'rgb(0 0 0 / 0.22)';
    g.lineWidth = 2;
    for (let n = 0; n <= 256; n += 64) (g.beginPath(), g.moveTo(n, 0), g.lineTo(n, 256), g.moveTo(0, n), g.lineTo(256, n), g.stroke());
  });
  /** A box from its far-left-bottom corner. `own` gives it its own material, so that its look can change alone. */
  function box(parent: THREE.Object3D, x: number, y: number, z: number, w: number, d: number, h: number, colour: string, own = false) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), own ? material(colour).clone() : material(colour));
    mesh.position.set(x + w / 2, z + h / 2, y + d / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  const panels: { panel: Panel; text: string }[] = [];
  /** A flat picture with one line of text. The text is drawn again when the font is ready. */
  function panel(width: number, height: number, fill: string, ink: string, frame = true): Panel {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = Math.round((1024 * height) / width);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const entry = { panel: null as unknown as Panel, text: '' };
    const set = (text: string) => {
      entry.text = text;
      const g = canvas.getContext('2d')!;
      g.fillStyle = css(fill);
      g.fillRect(0, 0, canvas.width, canvas.height);
      if (frame) {
        g.lineWidth = 14;
        g.strokeStyle = css('ink');
        g.strokeRect(7, 7, canvas.width - 14, canvas.height - 14);
      }
      g.fillStyle = css(ink);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const upper = text.toUpperCase();
      let size = Math.min(canvas.height * 0.62, 200);
      const font = () => (g.font = `800 ${size}px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`);
      font();
      const wide = g.measureText(upper).width;
      if (wide > canvas.width - 70) {
        size *= (canvas.width - 70) / wide;
        font();
      }
      g.fillText(upper, canvas.width / 2, canvas.height / 2 + size * 0.04);
      texture.needsUpdate = true;
    };
    entry.panel = { texture, set, width, height };
    panels.push(entry);
    return entry.panel;
  }
  function board(parent: THREE.Object3D, x: number, y: number, z: number, p: Panel) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.width, p.height), new THREE.MeshBasicMaterial({ map: p.texture, toneMapped: false }));
    mesh.position.set(x, z, y);
    parent.add(mesh);
    return mesh;
  }
  function badgeTexture(colour: string, draw: (g: CanvasRenderingContext2D) => void) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const g = canvas.getContext('2d')!;
    g.fillStyle = css(colour);
    g.beginPath();
    g.arc(64, 64, 56, 0, 7);
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = css('ink');
    g.stroke();
    g.strokeStyle = css('white');
    g.lineWidth = 16;
    g.lineCap = g.lineJoin = 'round';
    g.beginPath();
    draw(g);
    g.stroke();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
  const tick = (colour: string) => badgeTexture(colour, (g) => (g.moveTo(36, 66), g.lineTo(56, 86), g.lineTo(92, 42)));
  const cross = badgeTexture('block', (g) => (g.moveTo(40, 40), g.lineTo(88, 88), g.moveTo(88, 40), g.lineTo(40, 88)));

  const bots = new Map<string, Bot>();
  function bot(id: string, cx: number, cy: number, colour: string, scale = 1) {
    const group = new THREE.Group();
    group.position.set(cx, 0, cy);
    group.scale.setScalar(scale);
    scene.add(group);
    const body = [box(group, -0.3, -0.2, 0, 0.6, 0.4, 0.3, 'ink', true), box(group, -0.4, -0.3, 0.3, 0.8, 0.6, 0.7, colour, true), box(group, -0.5, -0.38, 1, 1, 0.76, 0.7, 'white', true), box(group, -0.05, -0.05, 1.7, 0.1, 0.1, 0.3, 'ink', true)];
    const tip = box(group, -0.12, -0.12, 2, 0.24, 0.24, 0.2, 'ink', true);
    box(group, -0.32, 0.38, 1.25, 0.2, 0.03, 0.25, 'ink');
    box(group, 0.12, 0.38, 1.25, 0.2, 0.03, 0.25, 'ink');
    const badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: cross, depthTest: false }));
    badge.scale.setScalar(0.8);
    badge.position.set(cx, 3.62, cy + 0.85);
    badge.renderOrder = 5;
    scene.add(badge);
    const parts = [...body, tip].map((mesh) => mesh.material as THREE.MeshStandardMaterial);
    bots.set(id, { group, parts, tip: tip.material as THREE.MeshStandardMaterial, badge, done: tick(colour === 'backup' ? 'route' : colour), blocked: cross, state: 'idle' });
    setBot(id, 'idle');
  }
  function setBot(id: string, state: BotState) {
    const b = bots.get(id);
    if (!b) return;
    b.state = state;
    b.group.position.y = 0;
    for (const m of b.parts) Object.assign(m, { transparent: true, opacity: state === 'idle' ? 0.5 : state === 'blocked' ? 0.4 : 1 });
    b.tip.color.set(css(state === 'working' ? 'sign' : 'ink'));
    b.tip.emissive.set(state === 'working' ? css('sign') : '#000');
    b.tip.emissiveIntensity = night ? 1.6 : 0.3;
    b.badge.visible = state === 'done' || state === 'blocked';
    if (b.badge.visible) b.badge.material.map = state === 'done' ? b.done : b.blocked;
  }

  const signs = new Map<string, { group: THREE.Group; set(text: string): void }>();
  const hits: THREE.Mesh[] = [];
  /** A shed of the owner's route (`n` is -1) or of the road of peer `n`. */
  function shed(i: number, n: number) {
    const sx = SX[i]!;
    const own = n < 0;
    const y0 = own ? -2 : 4.9 + n * GAP;
    for (const [x, y] of [[-1.6, 0], [1.5, 0], [-1.6, 1.5], [1.5, 1.5]] as const) box(scene, sx + x, y0 + y, 0, 0.1, 0.1, 2.3, 'ink');
    box(scene, sx - 1.8, y0 - 0.1, 2.3, 3.6, 1.8, 0.18, own ? 'route' : 'peer');
    box(scene, sx - 1.8, y0 + 1.62, 2.48, 3.6, 0.1, 0.7, 'white');
    const name = panel(3.6, 0.7, 'white', 'ink');
    name.set(NAMES[i]!);
    board(scene, sx, y0 + 1.73, 2.83, name);
    if (own) {
      bot(`${i}-own`, sx - 0.65, y0 + 0.9, 'route');
      bot(`${i}-backup`, sx + 0.8, y0 + 0.9, 'backup', 0.74);
      // What a click on the shed hits: one box around it, not drawn.
      const hit = new THREE.Mesh(new THREE.BoxGeometry(3.8, 3.3, 2), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.set(sx, 1.65, y0 + 0.8);
      hit.userData.role = ROLES[i];
      scene.add(hit);
      hits.push(hit);
    } else bot(`${i}-peer${n}`, sx, y0 + 0.9, 'peer');
    const group = new THREE.Group();
    group.visible = false;
    scene.add(group);
    box(group, sx - 0.05, y0 + 1.63, 3.18, 0.1, 0.08, 0.8, 'ink');
    box(group, sx - 3, y0 + 1.6, 3.95, 6, 0.12, 1, 'sign');
    const text = panel(6, 1, 'sign', 'on-sign');
    board(group, sx, y0 + 1.73, 4.45, text);
    signs.set(`${i}-${own ? 'own' : `peer${n}`}`, { group, set: text.set });
  }

  // The ground goes to the horizon. The street is a pavement of concrete tiles on it.
  const earth = new THREE.Mesh(
    new THREE.CircleGeometry(330, 48),
    surface(painted(256, 256, (g) => ((g.fillStyle = MORE.earth!), g.fillRect(0, 0, 256, 256), specks(g, 256, 3000))), 660, 660, 7, 1),
  );
  earth.rotation.x = -Math.PI / 2;
  earth.position.set(CENTRE.x, -0.36, CENTRE.z);
  earth.receiveShadow = true;
  scene.add(earth);
  const pavement = (y: number, d: number) => (box(scene, -1, y, -0.4, 27, d, 0.4, 'ground').material = surface(tiles, 27, d, 6, 0.85));
  pavement(-2.6, 11.8);
  const road = (x0: number, y0: number, x1: number, y1: number) => {
    const mesh = box(scene, x0, y0, 0, x1 - x0, y1 - y0, 0.02, 'road');
    mesh.castShadow = false;
    mesh.material = surface(asphalt, x1 - x0, y1 - y0, 5, 0.95);
  };
  /** A street lamp. At night it gives light. */
  function lamp(x: number, y: number) {
    box(scene, x - 0.06, y - 0.06, 0, 0.12, 0.12, 3.5, 'ink');
    box(scene, x - 0.06, y - 0.06, 3.5, 0.12, 0.8, 0.1, 'ink');
    box(scene, x - 0.14, y + 0.5, 3.36, 0.28, 0.34, 0.14, 'lamp').castShadow = false;
    if (!night) return;
    const light = new THREE.PointLight(0xffd9a0, 46, 15, 1.8);
    light.position.set(x, 3.2, y + 0.66);
    scene.add(light);
    halo(scene, x, y + 0.66, 3.36, 2.6, '#ffd48a', 0.85);
  }
  for (const c of CROSS) lamp(c + 1.25, -0.5);
  // Beside the street: a sari-sari store, some houses and trees. They are scenery; they say nothing about the run.
  function house(x: number, y: number, w: number, d: number, h: number, wall: string) {
    box(scene, x, y, -0.36, w, d, h + 0.36, wall);
    box(scene, x - 0.25, y - 0.25, h, w + 0.5, d + 0.5, 0.22, 'roof');
    for (let wx = x + 0.6; wx < x + w - 1; wx += 1.5) box(scene, wx, y + d - 0.02, h * 0.45, 0.8, 0.06, 0.8, night ? 'lamp' : 'glass').castShadow = false;
  }
  function tree(x: number, y: number, size = 1) {
    box(scene, x - 0.16, y - 0.16, -0.36, 0.32, 0.32, 1.7 * size + 0.36, 'trunk');
    for (const [dx, dz, r] of [[0, 2.2, 1.15], [0.5, 2.9, 0.8], [-0.45, 3.1, 0.7]] as const) {
      const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(r * size, 0), material('leaf'));
      leaves.material.flatShading = true;
      leaves.position.set(x + dx * size, dz * size, y);
      leaves.castShadow = leaves.receiveShadow = true;
      scene.add(leaves);
    }
  }
  house(2.2, -8.6, 5, 3, 2.6, 'wall');
  box(scene, 1.9, -5.7, 2.1, 5.6, 1.3, 0.12, 'sign'); // the awning of the store
  box(scene, 2.8, -5.62, 0.9, 3.8, 0.1, 1, 'glass').castShadow = false;
  box(scene, 2.6, -5.9, 0.7, 4.2, 0.4, 0.14, 'trunk');
  const storeName = panel(4.4, 0.6, 'block', 'white', false);
  storeName.set('Sari-sari store');
  board(scene, 4.7, -5.55, 2.9, storeName);
  house(9.6, -9.4, 4.2, 3.4, 3.6, 'wall2');
  house(15.4, -8.8, 5.4, 3, 2.8, 'wall3');
  house(22, -9.6, 4, 3.6, 4.2, 'wall');
  for (const [x, y, size] of [[-3.4, -5.6, 1.2], [8.4, -6.6, 1], [14.3, -6.2, 0.85], [21, -6.4, 1.1], [27.6, -5.2, 1.3], [-4.6, 1.8, 0.9], [29.8, 2.6, 1]] as const) tree(x, y, size);
  road(-0.6, 0, 25.6, 2);
  const roadLine = (y: number) => {
    for (let x = -0.3; x < 25.2; x += 1.3) box(scene, x, y - 0.04, 0.02, 0.6, 0.08, 0.01, 'roadline').castShadow = false;
  };
  const routeName = (y: number) => {
    const p = panel(4.6, 0.6, 'road', 'roadline', false);
    board(scene, 23, y, 0.04, p).rotation.x = -Math.PI / 2;
    return p;
  };
  roadLine(OWN);
  const ownName = routeName(1.5);
  // One road for each peer. The first road is there from the start; it gets the name of the first peer.
  const roads: { name: string | null; label: Panel }[] = [];
  function addRoad(name: string | null) {
    const n = roads.length;
    const dy = n * GAP;
    if (n) pavement(9.2 + dy - GAP, GAP);
    for (const c of [CROSS[1]!, CROSS[3]!]) lamp(c + 1.25, 6.3 + dy);
    road(-0.6, 6.8 + dy, 25.6, 8.8 + dy);
    for (const c of CROSS) road(c - 0.8, 2 + dy, c + 0.8, 6.8 + dy);
    roadLine(PEER + dy);
    const label = routeName(8.3 + dy);
    label.set(name ? `${name}'s route` : "A peer's route");
    for (const i of [0, 1, 2, 3]) shed(i, n);
    roads.push({ name, label });
    home();
    return n;
  }
  /** The road of the peer with this name. A peer with no road yet gets one. */
  function roadOf(name: string) {
    const n = roads.findIndex((r) => r.name === name);
    if (n >= 0) return n;
    if (roads[0]!.name !== null) return addRoad(name);
    roads[0]!.name = name;
    roads[0]!.label.set(`${name}'s route`);
    return 0;
  }
  const barriers = [0, 1, 2, 3].map((i) => {
    shed(i, -1);
    const group = new THREE.Group();
    group.visible = false;
    scene.add(group);
    box(group, SX[i]! + 2.3, 0.25, 0, 0.12, 0.12, 0.9, 'ink');
    box(group, SX[i]! + 2.3, 1.65, 0, 0.12, 0.12, 0.9, 'ink');
    box(group, SX[i]! + 2.28, 0.2, 0.5, 0.16, 1.62, 0.42, 'block');
    return group;
  });

  // The jeepney, as on a street in Manila: a long steel body with open windows, a flat hood with a chrome grille and a horse on it,
  // a signboard above the windscreen, painted stripes, a roof rack with the work on it, and a step at the open back.
  // The conductor drives it. `body` leans and bounces; the wheels stay on the road.
  const jeep = new THREE.Group();
  const body = new THREE.Group();
  jeep.add(body);
  scene.add(jeep);
  const JEEP: [number, number, number, number, number, number, string][] = [
    [-2, -0.7, 0.3, 4, 1.4, 0.1, 'ink'], // frame
    [-2, -0.76, 0.4, 1.98, 1.52, 0.52, 'steel'], // the long cabin of the passengers, lower part
    [-2, -0.775, 0.5, 1.98, 1.55, 0.09, 'block'], [-2, -0.775, 0.62, 1.98, 1.55, 0.05, 'sign'], [-2, -0.775, 0.7, 1.98, 1.55, 0.07, 'route'], // stripes
    [-2, -0.76, 0.92, 1.98, 0.06, 0.06, 'chrome'], [-2, 0.7, 0.92, 1.98, 0.06, 0.06, 'chrome'], // window rails
    [-1.8, -0.62, 0.92, 1.6, 0.3, 0.06, 'seat'], [-1.8, 0.32, 0.92, 1.6, 0.3, 0.06, 'seat'], // the two long benches
    [-0.02, -0.76, 0.4, 0.84, 0.06, 0.1, 'block'], [-0.02, 0.7, 0.4, 0.84, 0.06, 0.1, 'block'], // the driver's cab has open sides, with a low sill
    [-2.06, -0.84, 1.5, 3.05, 1.68, 0.1, 'white'], [-2.06, -0.84, 1.46, 3.05, 1.68, 0.04, 'block'], // roof
    [-1.9, -0.72, 1.6, 2.5, 0.05, 0.14, 'chrome'], [-1.9, 0.67, 1.6, 2.5, 0.05, 0.14, 'chrome'], [-1.9, -0.72, 1.6, 0.05, 1.44, 0.14, 'chrome'], [0.55, -0.72, 1.6, 0.05, 1.44, 0.14, 'chrome'], // roof rack
    [-1.25, -0.42, 1.6, 0.9, 0.84, 0.46, 'white'], [-1.27, -0.06, 1.6, 0.94, 0.12, 0.48, 'block'], // the work, tied on the rack
    [0.72, -0.72, 1.6, 0.1, 1.44, 0.34, 'sign'], // signboard above the windscreen
    [0.8, -0.76, 0.4, 0.1, 1.52, 0.52, 'steel'], [0.84, -0.7, 0.92, 0.03, 1.4, 0.58, 'windscreen'], // dash and windscreen
    [0.9, -0.62, 0.4, 0.95, 1.24, 0.4, 'steel'], [0.9, -0.2, 0.8, 0.95, 0.4, 0.03, 'block'], // the flat hood
    [0.95, -0.8, 0.3, 0.8, 0.2, 0.34, 'block'], [0.95, 0.6, 0.3, 0.8, 0.2, 0.34, 'block'], // fenders
    [1.85, -0.46, 0.42, 0.05, 0.92, 0.36, 'chrome'], [1.9, -0.84, 0.24, 0.16, 1.68, 0.14, 'chrome'], // grille and bumper
    [1.88, -0.4, 0.48, 0.04, 0.05, 0.26, 'ink'], [1.88, -0.2, 0.48, 0.04, 0.05, 0.26, 'ink'], [1.88, 0, 0.48, 0.04, 0.05, 0.26, 'ink'], [1.88, 0.2, 0.48, 0.04, 0.05, 0.26, 'ink'], [1.88, 0.36, 0.48, 0.04, 0.05, 0.26, 'ink'],
    [1.84, -0.76, 0.5, 0.08, 0.24, 0.24, 'lamp'], [1.84, 0.52, 0.5, 0.08, 0.24, 0.24, 'lamp'], // headlights
    [1.3, -0.05, 0.92, 0.3, 0.1, 0.12, 'chrome'], [1.52, -0.05, 0.98, 0.09, 0.1, 0.2, 'chrome'], [1.58, -0.05, 1.12, 0.14, 0.1, 0.09, 'chrome'], [1.32, -0.05, 0.82, 0.05, 0.1, 0.1, 'chrome'], [1.52, -0.05, 0.82, 0.05, 0.1, 0.1, 'chrome'], // the horse on the hood
    [0.86, -0.98, 1, 0.06, 0.2, 0.26, 'chrome'], [0.86, 0.78, 1, 0.06, 0.2, 0.26, 'chrome'], // mirrors
    [-2.28, -0.4, 0.2, 0.3, 0.8, 0.06, 'chrome'], [-2.04, -0.76, 0.4, 0.06, 0.4, 1.1, 'steel'], [-2.04, 0.36, 0.4, 0.06, 0.4, 1.1, 'steel'], // the step and the open back
    [-1.72, -0.8, 0.06, 0.04, 0.26, 0.3, 'ink'], [-1.72, 0.54, 0.06, 0.04, 0.26, 0.3, 'ink'], // mud flaps
    // The conductor, at the wheel on the left: yellow shirt, white head, yellow cap.
    // It sits low, so that the roof does not hide it from above.
    [0.08, -0.52, 0.4, 0.38, 0.46, 0.24, 'sign'], [0.1, -0.5, 0.64, 0.36, 0.42, 0.34, 'white'], [0.06, -0.53, 0.98, 0.5, 0.48, 0.08, 'sign'], [0.46, -0.44, 0.76, 0.03, 0.09, 0.11, 'ink'], [0.46, -0.24, 0.76, 0.03, 0.09, 0.11, 'ink'],
    [0.6, -0.46, 0.56, 0.05, 0.3, 0.3, 'ink'], // the steering wheel
  ];
  material('windscreen').copy(material('glass'));
  Object.assign(material('windscreen'), { transparent: true, opacity: 0.3 });
  for (const [x, y, z, w, d, h, colour] of JEEP) box(body, x, y, z, w, d, h, colour);
  for (const x of [-2, -1.3, -0.65, -0.08, 0.8]) for (const y of [-0.76, 0.7]) box(body, x, y, x === -0.08 ? 0.4 : 0.92, 0.06, 0.06, x === -0.08 ? 1.08 : 0.56, 'steel'); // posts of the open windows
  const front = panel(1.3, 0.3, 'sign', 'on-sign', false);
  front.set('Tuloy');
  board(body, 0.83, 0, 1.77, front).rotation.y = Math.PI / 2;
  const wheels = [-1.25, 1.3].flatMap((x) =>
    [-0.72, 0.72].map((y) => {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.24, 20), material('tyre'));
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, 0.32, y);
      wheel.castShadow = true;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.26, 6), material('chrome'));
      wheel.add(hub);
      jeep.add(wheel);
      return wheel;
    }),
  );
  if (night) {
    const beam = new THREE.SpotLight(0xfff0c8, 60, 16, 0.5, 0.6, 1.4);
    beam.position.set(1.9, 0.62, 0);
    beam.target.position.set(8, 0, 0);
    jeep.add(beam, beam.target);
    halo(body, 1.96, -0.64, 0.62, 1.3, '#fff0c8');
    halo(body, 1.96, 0.64, 0.62, 1.3, '#fff0c8');
  }
  // Smoke from the exhaust while the jeepney drives.
  const puffs = Array.from({ length: 12 }, () => {
    const puff = new THREE.Sprite(new THREE.SpriteMaterial({ map: soft, color: night ? '#6b7280' : '#8a8f99', transparent: true, opacity: 0, depthWrite: false }));
    puff.userData.born = -1e9;
    scene.add(puff);
    return puff;
  });
  const cargo = panel(2.8, 0.7, 'white', 'ink');
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: cargo.texture, depthTest: false }));
  tag.scale.set(2.8, 0.7, 1);
  tag.position.set(0, 2.9, 0);
  tag.renderOrder = 6;
  jeep.add(tag);
  // How the jeepney moves now: where it points, if it drives, if it speeds up (1) or brakes (-1), and how far it went.
  const drive = { heading: 0, moving: false, pitch: 0, rolled: 0, puffed: 0 };
  const turn = (heading: number) => {
    drive.heading = heading;
    if (fast || reduced) jeep.rotation.y = heading;
  };

  // ---- the state of the trip ----
  let at = { x: CROSS[0]!, y: OWN };
  let fast = false; // true while the street takes the state of a run with no moves
  let generation = 0; // a new run or a replay stops the moves of the old one
  let key = '';
  let steps: TripStep[] = [];
  let played = 0;
  let playing = false;
  let cur = 0; // the road of the peer that has the work now
  let lastBlocked = 1;
  let following = false;
  const trails: THREE.Mesh[] = [];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function clear() {
    generation++;
    for (const id of bots.keys()) setBot(id, 'idle');
    for (const s of signs.values()) s.group.visible = false;
    for (const b of barriers) b.visible = false;
    for (const t of trails.splice(0)) scene.remove(t);
    at = { x: CROSS[0]!, y: OWN };
    jeep.position.set(at.x, 0, at.y);
    jeep.rotation.y = drive.heading = 0;
    cargo.set('Goal');
    played = 0;
    playing = false;
    lastBlocked = 1;
    cur = 0;
  }
  const still = (g: number) => g === generation;
  const pause = (ms: number) => (fast || reduced ? Promise.resolve() : sleep(ms));

  async function leg(x: number, y: number, g: number) {
    const dx = x - at.x;
    const dy = y - at.y;
    const distance = Math.abs(dx) + Math.abs(dy);
    if (!distance || !still(g)) return;
    turn(dx > 0 ? 0 : dx < 0 ? Math.PI : dy > 0 ? -Math.PI / 2 : Math.PI / 2);
    const line = new THREE.Mesh(new THREE.BoxGeometry(1, 0.05, 1), material(y > 2 || at.y > 2 ? 'peer' : 'route'));
    scene.add(line);
    trails.push(line);
    const from = { ...at };
    // It speeds up, drives, and slows down, as a real vehicle does.
    const ms = fast || reduced ? 0 : distance * 115 + 320;
    let before = 0;
    const start = performance.now();
    await new Promise<void>((done) =>
      (function frame(now: number) {
        if (!still(g)) return done();
        const time = ms ? Math.min(1, (now - start) / ms) : 1;
        const t = time < 0.5 ? 2 * time * time : 1 - 2 * (1 - time) * (1 - time);
        drive.moving = time < 1;
        drive.pitch = time >= 1 || distance < 1.5 ? 0 : time < 0.5 ? 1 : -1;
        drive.rolled += (t - before) * distance;
        before = t;
        at = { x: from.x + dx * t, y: from.y + dy * t };
        jeep.position.set(at.x, 0, at.y);
        line.position.set((from.x + at.x) / 2, 0.06, (from.y + at.y) / 2);
        line.scale.set(Math.abs(at.x - from.x) + 0.3, 1, Math.abs(at.y - from.y) + 0.3);
        if (t < 1) requestAnimationFrame(frame);
        else done();
      })(performance.now()),
    );
  }
  /** Drives along the roads: to the nearest cross street when the stop is on the other route. */
  async function goTo(x: number, y: number, g: number) {
    if (at.y !== y) {
      const c = CROSS.reduce((a, b) => (Math.abs(at.x - b) + Math.abs(x - b) < Math.abs(at.x - a) + Math.abs(x - a) ? b : a));
      await leg(c, at.y, g);
      await leg(c, y, g);
    }
    await leg(x, y, g);
    if (still(g) && y === OWN) turn(0);
  }
  function sign(i: number, where: string, text: string) {
    const s = signs.get(`${i}-${where}`);
    if (!s) return;
    s.group.visible = !!text;
    if (text) s.set(text);
  }

  /** One step of the trip as one move of the street. */
  async function act(s: TripStep, g: number) {
    options.say(s.text, s.tone);
    if (s.peer) cur = roadOf(s.peer);
    const peer = roads[cur]!.name ?? 'Peer';
    const py = PEER + cur * GAP;
    const i = s.role ? ROLES.indexOf(s.role) : -1;
    const side = s.lane === 'peer' || s.lane === 'peer_goal' ? `peer${cur}` : 'own';
    const id = `${i}-${s.lane === 'backup' ? 'backup' : side}`;
    if (s.kind === 'work' && s.role === 'goal') await goTo(CROSS[0]!, py, g);
    else if (s.kind === 'work' && i >= 0) {
      sign(i, side, '');
      await goTo(SX[i]! - PARK, side === 'own' ? OWN : py, g);
      if (still(g)) setBot(id, 'working');
      await pause(700);
    } else if (s.kind === 'done' && i >= 0) {
      setBot(id, 'done');
      sign(i, side, '');
    } else if (s.kind === 'failure' && i >= 0) {
      setBot(id, 'blocked');
      sign(i, side, `${s.injected ? 'Demo: ' : ''}${s.sign ?? 'Failed'}`);
      if (side === 'own') lastBlocked = i;
      await pause(600);
    } else if (s.kind === 'retry' && i >= 0) {
      sign(i, side, `Retry ${s.retry ?? ''} of ${s.of ?? ''}`);
      await pause(700);
    } else if (s.kind === 'reroute' && i >= 0) {
      sign(i, 'own', s.lane === 'backup' ? 'Backup model' : `Re-route → ${peer}`);
      if (s.lane === 'peer') barriers[i]!.visible = true;
      await pause(600);
    } else if (s.kind === 'rejection') {
      sign(2, 'own', s.sign ?? 'Rejected');
      if (i >= 0 && s.role !== 'reviewer') setBot(id, 'blocked');
      await pause(600);
    } else if (s.kind === 'pass') {
      sign(2, 'own', '');
      setBot('2-own', 'done');
    } else if (s.kind === 'goal_to_peer') {
      sign(lastBlocked, 'own', `Full goal → ${peer}`);
      barriers[lastBlocked]!.visible = true;
      for (const n of [0, 1, 2, 3]) {
        setBot(`${n}-peer${cur}`, 'idle');
        sign(n, `peer${cur}`, '');
      }
      await goTo(CROSS[0]!, py, g);
    } else if (s.kind === 'peer_progress' && i >= 0) {
      // What the peer's Tuloy says about its own agents. For the full goal the jeepney goes along the peer's route.
      if (s.lane === 'peer_goal') await goTo(SX[i]! - PARK, py, g);
      if (still(g) && s.state) setBot(`${i}-peer${cur}`, s.state);
      if (s.state === 'working') await pause(500);
    } else if (s.kind === 'end') {
      const done = /as done/.test(s.text);
      if (done) sign(3, at.y > 2 ? `peer${cur}` : 'own', 'Done');
      else sign(lastBlocked, 'own', 'Escalated');
    }
    if (still(g)) cargo.set(s.cargo);
    await pause(350);
  }
  async function play() {
    if (playing) return;
    playing = true;
    const g = generation;
    while (still(g) && played < steps.length) {
      await act(steps[played]!, g);
      if (still(g)) played++;
    }
    if (still(g)) playing = false;
  }

  // ---- the view ----
  /** The view that shows all roads. More roads make the street deeper, so the camera goes back. */
  function home() {
    const deep = (roads.length - 1) * GAP;
    const k = 1 + deep / 40;
    controls.target.set(CENTRE.x, CENTRE.y, CENTRE.z + deep / 2);
    camera.position.set(CENTRE.x + (HOME.x - CENTRE.x) * k, HOME.y * k, controls.target.z + (HOME.z - CENTRE.z) * k);
    sun.target.position.z = CENTRE.z + deep / 2;
    sun.position.copy(sun.target.position).add(SUN);
    Object.assign(sun.shadow.camera, { left: -26 - deep / 2, right: 26 + deep / 2, top: 22 + deep / 2, bottom: -22 - deep / 2, near: 1, far: 70 + deep });
    sun.shadow.camera.updateProjectionMatrix();
  }
  addRoad(null);
  function fit() {
    const { clientWidth: w, clientHeight: h } = view;
    if (!w || !h) return;
    // The panels cover a part of the view. The street gets the size that fits the free part, and its centre goes to the centre of that part.
    const m = options.inset?.() ?? { top: 0, right: 0, bottom: 0, left: 0 };
    camera.aspect = w / h;
    camera.zoom = Math.min(1, Math.min((w - m.left - m.right) / 2.4, h - m.top - m.bottom) / h);
    camera.setViewOffset(w, h, (m.right - m.left) / 2, (m.bottom - m.top) / 2, w, h);
    renderer.setSize(w, h, false);
  }
  new ResizeObserver(fit).observe(view);
  fit();
  const spot = new THREE.Vector3();
  renderer.setAnimationLoop((now) => {
    for (const b of bots.values()) if (b.state === 'working' && !reduced) b.group.position.y = Math.abs(Math.sin(now / 140)) * 0.18;
    // The jeepney turns in a curve, lifts its nose when it speeds up, dips when it brakes, and bounces a little on the road.
    const swing = Math.atan2(Math.sin(drive.heading - jeep.rotation.y), Math.cos(drive.heading - jeep.rotation.y));
    jeep.rotation.y += swing * 0.16;
    body.rotation.z += (drive.pitch * 0.035 - body.rotation.z) * 0.12;
    body.position.y = drive.moving ? Math.abs(Math.sin(now / 85)) * 0.022 : 0;
    for (const wheel of wheels) wheel.rotation.y = -drive.rolled / 0.32;
    if (drive.moving && now - drive.puffed > 120) {
      drive.puffed = now;
      const puff = puffs.reduce((a, b) => (a.userData.born < b.userData.born ? a : b));
      puff.userData.born = now;
      puff.position.copy(jeep.localToWorld(spot.set(-2.15, 0.3, 0.5)));
    }
    for (const puff of puffs) {
      const age = (now - puff.userData.born) / 1100;
      puff.material.opacity = age < 1 ? 0.4 * (1 - age) : 0;
      puff.scale.setScalar(0.3 + age * 0.9);
      if (age < 1) puff.position.y += 0.006;
    }
    if (following) {
      // The camera keeps its angle and its distance, and moves with the jeepney.
      spot.set(at.x, 0, at.y).sub(controls.target).multiplyScalar(0.06);
      controls.target.add(spot);
      camera.position.add(spot);
    }
    controls.update();
    renderer.render(scene, camera);
  });
  void document.fonts?.load('800 80px "Barlow Condensed"').then(() => panels.forEach(({ panel: p, text }) => p.set(text)));

  // A click on a shed (not a drag of the camera) is for the presenter in demo mode.
  const ray = new THREE.Raycaster();
  let down: { x: number; y: number } | null = null;
  const shedAt = (event: PointerEvent) => {
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1), camera);
    return ray.intersectObjects(hits)[0]?.object.userData.role as string | undefined;
  };
  renderer.domElement.addEventListener('pointerdown', (event) => (down = { x: event.clientX, y: event.clientY }));
  renderer.domElement.addEventListener('pointerup', (event) => {
    const moved = down ? Math.hypot(event.clientX - down.x, event.clientY - down.y) : 99;
    down = null;
    const role = moved < 5 ? shedAt(event) : undefined;
    if (role) options.onShed(role, event.clientX, event.clientY);
  });
  renderer.domElement.addEventListener('pointermove', (event) => (renderer.domElement.style.cursor = view.dataset.demo && shedAt(event) ? 'pointer' : ''));

  ownName.set('Your route');
  cargo.set('Goal');

  return {
    show(nextKey, trip, names) {
      ownName.set(`${names.owner}'s route`);
      for (const name of names.peers ?? []) roadOf(name);
      const same = nextKey === key && trip.steps.length >= played && trip.steps.slice(0, played).every((s, n) => s.seq === steps[n]?.seq && s.kind === steps[n]?.kind);
      steps = trip.steps;
      if (same) return void play();
      // A different run: take its state now with no moves. The steps that come after this are played.
      key = nextKey;
      clear();
      fast = true;
      void play().then(() => (fast = false));
    },
    replay() {
      clear();
      fast = false;
      void play();
    },
    follow(on) {
      following = on;
    },
    resetView: home,
  };
}

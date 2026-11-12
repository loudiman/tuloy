/**
 * The street: a run as a jeepney trip, in 3D. The owner's route is the far road and the peer's route is the near road.
 * Each agent is a robot at a waiting shed. The jeepney carries the work from stop to stop, and each step of the trip is one move.
 * It shows only what the trip of the run says. All text goes on a canvas as text, never as HTML.
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
/** The jeepney stops a little before a shed, so that it does not hide the robots. */
const PARK = 2.7;
const HOME = { x: 10.1, y: 15.4, z: 27.4 };
const CENTRE = { x: 12.5, y: 0, z: 4 };

type Side = 'own' | 'peer';
type BotState = 'idle' | 'working' | 'done' | 'blocked';
type Bot = { group: THREE.Group; parts: THREE.MeshLambertMaterial[]; tip: THREE.MeshLambertMaterial; badge: THREE.Sprite; done: THREE.Texture; blocked: THREE.Texture; state: BotState };
type Panel = { texture: THREE.CanvasTexture; set(text: string): void; width: number; height: number };

export type Street = {
  /** Shows the trip of a run. A new `key` (a different run) shows its state now; more steps of the same run are played one by one. */
  show(key: string, trip: Trip, names: { owner: string }): void;
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
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(css('panel'));
  const camera = new THREE.PerspectiveCamera(30, 2, 1, 200);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  view.append(renderer.domElement);
  // A plain scroll moves the page. A scroll with Ctrl or ⌘ (and a pinch) zooms the street. This goes before the controls, so that they do not get a plain scroll.
  renderer.domElement.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) event.stopImmediatePropagation();
  });
  const controls = new OrbitControls(camera, renderer.domElement);
  Object.assign(controls, { enableDamping: true, maxPolarAngle: 1.45, minDistance: 10, maxDistance: 70 });

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2.3));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(4, 22, 14);
  sun.target.position.set(CENTRE.x, 0, CENTRE.z);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 16, bottom: -16, near: 1, far: 60 });
  scene.add(sun, sun.target);

  // ---- the parts ----
  const materials = new Map<string, THREE.MeshLambertMaterial>();
  const material = (name: string) => materials.get(name) ?? materials.set(name, new THREE.MeshLambertMaterial({ color: new THREE.Color(css(name)) })).get(name)!;
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
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.width, p.height), new THREE.MeshBasicMaterial({ map: p.texture }));
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
    const parts = [...body, tip].map((mesh) => mesh.material as THREE.MeshLambertMaterial);
    bots.set(id, { group, parts, tip: tip.material as THREE.MeshLambertMaterial, badge, done: tick(colour === 'backup' ? 'route' : colour), blocked: cross, state: 'idle' });
    setBot(id, 'idle');
  }
  function setBot(id: string, state: BotState) {
    const b = bots.get(id);
    if (!b) return;
    b.state = state;
    b.group.position.y = 0;
    for (const m of b.parts) Object.assign(m, { transparent: true, opacity: state === 'idle' ? 0.5 : state === 'blocked' ? 0.4 : 1 });
    b.tip.color.set(css(state === 'working' ? 'sign' : 'ink'));
    b.badge.visible = state === 'done' || state === 'blocked';
    if (b.badge.visible) b.badge.material.map = state === 'done' ? b.done : b.blocked;
  }

  const signs = new Map<string, { group: THREE.Group; set(text: string): void }>();
  const hits: THREE.Mesh[] = [];
  function shed(i: number, side: Side) {
    const sx = SX[i]!;
    const own = side === 'own';
    const y0 = own ? -2 : 4.9;
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
    } else bot(`${i}-peer`, sx, y0 + 0.9, 'peer');
    const group = new THREE.Group();
    group.visible = false;
    scene.add(group);
    box(group, sx - 0.05, y0 + 1.63, 3.18, 0.1, 0.08, 0.8, 'ink');
    box(group, sx - 3, y0 + 1.6, 3.95, 6, 0.12, 1, 'sign');
    const text = panel(6, 1, 'sign', 'on-sign');
    board(group, sx, y0 + 1.73, 4.45, text);
    signs.set(`${i}-${side}`, { group, set: text.set });
  }

  box(scene, -1, -2.6, -0.4, 27, 11.8, 0.4, 'ground');
  const road = (x0: number, y0: number, x1: number, y1: number) => (box(scene, x0, y0, 0, x1 - x0, y1 - y0, 0.02, 'road').castShadow = false);
  road(-0.6, 0, 25.6, 2);
  road(-0.6, 6.8, 25.6, 8.8);
  for (const c of CROSS) road(c - 0.8, 2, c + 0.8, 6.8);
  for (let x = -0.3; x < 25.2; x += 1.3) for (const y of [OWN, PEER]) box(scene, x, y - 0.04, 0.02, 0.6, 0.08, 0.01, 'roadline').castShadow = false;
  const routeNames = [1.5, 8.3].map((y) => {
    const p = panel(4.6, 0.6, 'road', 'roadline', false);
    board(scene, 23, y, 0.04, p).rotation.x = -Math.PI / 2;
    return p;
  });
  const barriers = [0, 1, 2, 3].map((i) => {
    shed(i, 'own');
    shed(i, 'peer');
    const group = new THREE.Group();
    group.visible = false;
    scene.add(group);
    box(group, SX[i]! + 2.3, 0.25, 0, 0.12, 0.12, 0.9, 'ink');
    box(group, SX[i]! + 2.3, 1.65, 0, 0.12, 0.12, 0.9, 'ink');
    box(group, SX[i]! + 2.28, 0.2, 0.5, 0.16, 1.62, 0.42, 'block');
    return group;
  });

  // The jeepney: steel body, red stripe, yellow roof, the conductor on the roof at the back, the work in the box on the roof.
  const jeep = new THREE.Group();
  scene.add(jeep);
  const JEEP: [number, number, number, number, number, number, string][] = [
    [-1.2, -0.8, 0, 0.6, 0.2, 0.5, 'ink'], [-1.2, 0.6, 0, 0.6, 0.2, 0.5, 'ink'], [0.7, -0.8, 0, 0.6, 0.2, 0.5, 'ink'], [0.7, 0.6, 0, 0.6, 0.2, 0.5, 'ink'],
    [-1.6, -0.7, 0.3, 3.2, 1.4, 0.3, 'steel'], [-1.6, -0.72, 0.6, 2.4, 1.44, 0.14, 'block'], [0.8, -0.7, 0.6, 0.8, 1.4, 0.3, 'steel'],
    [-1.6, -0.7, 0.74, 2.4, 1.4, 0.2, 'steel'], [-1.58, -0.68, 0.94, 2.36, 1.36, 0.42, 'glass'], [-1.6, -0.7, 1.36, 2.4, 1.4, 0.1, 'steel'],
    [-1.6, -0.7, 0.94, 0.08, 1.4, 0.42, 'steel'], [-0.82, -0.7, 0.94, 0.08, 1.4, 0.42, 'steel'], [-0.04, -0.7, 0.94, 0.08, 1.4, 0.42, 'steel'], [0.72, -0.7, 0.94, 0.08, 1.4, 0.42, 'steel'],
    [-1.7, -0.8, 1.46, 2.6, 1.6, 0.1, 'sign'], [0.5, -0.6, 1.56, 0.14, 1.2, 0.34, 'block'], [-0.45, -0.4, 1.56, 0.8, 0.8, 0.5, 'white'],
    [-1.45, -0.25, 1.56, 0.5, 0.5, 0.5, 'sign'], [-1.5, -0.3, 2.06, 0.6, 0.6, 0.45, 'white'],
    [1.6, -0.55, 0.62, 0.06, 0.25, 0.2, 'sign'], [1.6, 0.3, 0.62, 0.06, 0.25, 0.2, 'sign'], [1.6, -0.7, 0.3, 0.1, 1.4, 0.14, 'ink'],
  ];
  for (const [x, y, z, w, d, h, colour] of JEEP) box(jeep, x, y, z, w, d, h, colour);
  const cargo = panel(2.8, 0.7, 'white', 'ink');
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: cargo.texture, depthTest: false }));
  tag.scale.set(2.8, 0.7, 1);
  tag.position.set(0, 2.9, 0);
  tag.renderOrder = 6;
  jeep.add(tag);

  // ---- the state of the trip ----
  let at = { x: CROSS[0]!, y: OWN };
  let fast = false; // true while the street takes the state of a run with no moves
  let generation = 0; // a new run or a replay stops the moves of the old one
  let key = '';
  let steps: TripStep[] = [];
  let played = 0;
  let playing = false;
  let peer = 'Peer';
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
    jeep.rotation.y = 0;
    cargo.set('Goal');
    played = 0;
    playing = false;
    lastBlocked = 1;
  }
  const still = (g: number) => g === generation;
  const pause = (ms: number) => (fast || reduced ? Promise.resolve() : sleep(ms));

  async function leg(x: number, y: number, g: number) {
    const dx = x - at.x;
    const dy = y - at.y;
    const distance = Math.abs(dx) + Math.abs(dy);
    if (!distance || !still(g)) return;
    jeep.rotation.y = dx > 0 ? 0 : dx < 0 ? Math.PI : dy > 0 ? -Math.PI / 2 : Math.PI / 2;
    const line = new THREE.Mesh(new THREE.BoxGeometry(1, 0.05, 1), material(y > 2 || at.y > 2 ? 'peer' : 'route'));
    scene.add(line);
    trails.push(line);
    const from = { ...at };
    const ms = fast || reduced ? 0 : distance * 120;
    const start = performance.now();
    await new Promise<void>((done) =>
      (function frame(now: number) {
        if (!still(g)) return done();
        const t = ms ? Math.min(1, (now - start) / ms) : 1;
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
    if (still(g) && y === OWN) jeep.rotation.y = 0;
  }
  function sign(i: number, side: Side, text: string) {
    const s = signs.get(`${i}-${side}`);
    if (!s) return;
    s.group.visible = !!text;
    if (text) s.set(text);
  }

  /** One step of the trip as one move of the street. */
  async function act(s: TripStep, g: number) {
    options.say(s.text, s.tone);
    if (s.peer && s.peer !== peer) routeNames[1]!.set(`${(peer = s.peer)}'s route`);
    const i = s.role ? ROLES.indexOf(s.role) : -1;
    const side: Side = s.lane === 'peer' || s.lane === 'peer_goal' ? 'peer' : 'own';
    const id = `${i}-${s.lane === 'peer_goal' ? 'peer' : s.lane}`;
    if (s.kind === 'work' && s.role === 'goal') await goTo(CROSS[0]!, PEER, g);
    else if (s.kind === 'work' && i >= 0) {
      sign(i, side, '');
      await goTo(SX[i]! - PARK, side === 'own' ? OWN : PEER, g);
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
        setBot(`${n}-peer`, 'idle');
        sign(n, 'peer', '');
      }
      await goTo(CROSS[0]!, PEER, g);
    } else if (s.kind === 'peer_progress' && i >= 0) {
      // What the peer's Tuloy says about its own agents. For the full goal the jeepney goes along the peer's route.
      if (s.lane === 'peer_goal') await goTo(SX[i]! - PARK, PEER, g);
      if (still(g) && s.state) setBot(`${i}-peer`, s.state);
      if (s.state === 'working') await pause(500);
    } else if (s.kind === 'end') {
      const done = /as done/.test(s.text);
      if (done) sign(3, at.y === PEER ? 'peer' : 'own', 'Done');
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
  function home() {
    camera.position.set(HOME.x, HOME.y, HOME.z);
    controls.target.set(CENTRE.x, CENTRE.y, CENTRE.z);
  }
  home();
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

  routeNames[0]!.set('Your route');
  routeNames[1]!.set("A peer's route");
  cargo.set('Goal');

  return {
    show(nextKey, trip, names) {
      routeNames[0]!.set(`${names.owner}'s route`);
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

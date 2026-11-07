// Studio-chrome Newton's cradle, rendered with three.js into an offscreen WebGL canvas and copied into the
// page's 2D canvas, one cradle at a time. The 2D scene (cradle.js) keeps the layout, labels and timing;
// this file only turns "these balls at these angles" into a picture.
//
// Units: ball radius = 1. Pendulum pivots sit on the rail line at y = RAIL_Y; balls hang L below.
import * as THREE from "../../assets/js/vendor/three/three.module.min.js";
import { RoomEnvironment } from "../../assets/js/vendor/three/RoomEnvironment.js";
import { RoundedBoxGeometry } from "../../assets/js/vendor/three/RoundedBoxGeometry.js";

const R = 1, N = 5, L = 6.2, RAIL_Y = L, RAIL_Z = 2.0, POST_X = 8.2, BASE_TOP = -2.1, TUBE = 0.16;
const GHOSTS = 16;

// The picture of one cradle covers this box, in ball radii of the 2D layout, relative to the
// front rail's centre (cx, top): x from -BOX.w/2 to +BOX.w/2, y from -BOX.up to BOX.h - BOX.up.
export const BOX = { w: 24, h: 13.6, up: 2.2 };

let ctx = null;
function setup() {
  const canvas = document.createElement("canvas");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch (e) { return null; }
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.1;
  renderer.setClearColor(0x000000, 0);
  renderer.setScissorTest(true);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;

  const camera = new THREE.PerspectiveCamera(19.5, BOX.w / BOX.h, 1, 200);
  camera.position.set(0, 9, 43); camera.lookAt(0, 1.2, 0);

  const mat = {
    ball: new THREE.MeshPhysicalMaterial({ color: 0xf2f3f5, metalness: 1, roughness: 0.04 }),
    frame: new THREE.MeshPhysicalMaterial({ color: 0xd9dce2, metalness: 1, roughness: 0.18 }),
    base: new THREE.MeshPhysicalMaterial({ color: 0x0a1a9c, roughness: 0.55, clearcoat: 0.5, clearcoatRoughness: 0.15, envMapIntensity: 0.25 }),
    string: new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.6 }),
  };
  const shadowy = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };

  // light, and a floor that only shows shadows
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-5, 24, 18); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.03; key.shadow.radius = 6;
  Object.assign(key.shadow.camera, { left: -14, right: 14, top: 14, bottom: -8, near: 1, far: 60 });
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0xd8cfb8, 0.5));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.18 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = BASE_TOP - 1.3; floor.receiveShadow = true; scene.add(floor);

  const base = shadowy(new THREE.Mesh(new RoundedBoxGeometry(19.5, 1.3, 7.2, 6, 0.45), mat.base));
  base.position.y = BASE_TOP - 0.65; scene.add(base);

  const tube = (path) => shadowy(new THREE.Mesh(new THREE.TubeGeometry(path, 160, TUBE, 16, false), mat.frame));
  const collar = (x, z, parent) => {
    const c = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(TUBE * 2, TUBE * 2.4, 0.18, 20), mat.frame));
    c.position.set(x, BASE_TOP + 0.09, z); parent.add(c);
  };

  // ---- the working cradle ----
  const whole = new THREE.Group(); scene.add(whole);
  for (const z of [-RAIL_Z, RAIL_Z]) {
    whole.add(tube(uPath(z)));
    for (const x of [-POST_X, POST_X]) collar(x, z, whole);
  }
  const strings = [];
  const sphere = new THREE.SphereGeometry(R, 48, 32);
  const stringGeo = new THREE.CylinderGeometry(0.022, 0.022, 1, 6); stringGeo.translate(0, 0.5, 0);
  const hookGeo = new THREE.CylinderGeometry(0.09, 0.12, 0.2, 12);
  function pendulum(x, m = mat) {
    const pivot = new THREE.Group(); pivot.position.set(x, RAIL_Y, 0);
    const ball = shadowy(new THREE.Mesh(sphere, m.ball)); ball.position.y = -L; pivot.add(ball);
    const hook = new THREE.Mesh(hookGeo, m.frame); hook.position.y = -L + R + 0.05; pivot.add(hook);
    for (const z of [-RAIL_Z, RAIL_Z]) pivot.add(stringTo(new THREE.Vector3(0, -L + R + 0.12, 0), new THREE.Vector3(0, 0.25, z), m.string));
    return pivot;
  }
  function stringTo(a, b, m = mat.string) {
    const s = shadowy(new THREE.Mesh(stringGeo, m)); strings.push(s);
    s.position.copy(a); s.scale.y = a.distanceTo(b);
    s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    return s;
  }
  const xs = Array.from({ length: N }, (_, i) => (i - (N - 1) / 2) * 2 * R * 1.002);
  const pend = xs.map((x) => { const p = pendulum(x); whole.add(p); return p; });
  // see-through copies of the two end pendulums, for motion blur
  const ghosts = [0, N - 1].map((i) => Array.from({ length: GHOSTS }, () => {
    const m = { ball: mat.ball.clone(), frame: mat.frame.clone(), string: mat.string.clone() };
    for (const k in m) { m[k].transparent = true; m[k].depthWrite = false; }
    const p = pendulum(xs[i], m); p.visible = false; p.userData.m = m;
    p.traverse((o) => { o.castShadow = false; });
    whole.add(p); return p;
  }));

  return { strings, renderer, canvas, scene, camera, mat, whole, pend, ghosts, pendulum, stringTo, tube, collar, shadowy, broken: new Map() };
}

function uPath(z) {
  const bend = 1.4, top = RAIL_Y + 0.25, p = new THREE.CurvePath(), v = (x, y) => new THREE.Vector3(x, y, z);
  p.add(new THREE.LineCurve3(v(-POST_X, BASE_TOP), v(-POST_X, top - bend)));
  p.add(new THREE.QuadraticBezierCurve3(v(-POST_X, top - bend), v(-POST_X, top), v(-POST_X + bend, top)));
  p.add(new THREE.LineCurve3(v(-POST_X + bend, top), v(POST_X - bend, top)));
  p.add(new THREE.QuadraticBezierCurve3(v(POST_X - bend, top), v(POST_X, top), v(POST_X, top - bend)));
  p.add(new THREE.LineCurve3(v(POST_X, top - bend), v(POST_X, BASE_TOP)));
  return p;
}

// A broken cradle for a company losing money, the same for a given seed (random function).
function buildBroken(c, rand) {
  const g = new THREE.Group();
  // back frame intact
  g.add(c.tube(uPath(-RAIL_Z)));
  for (const x of [-POST_X, POST_X]) { c.collar(x, -RAIL_Z, g); c.collar(x, RAIL_Z, g); }
  // front frame: the rail snapped at breakX; the left side stays, the right post leans out with a stub
  const breakX = -1.5 + rand() * 3.5, top = RAIL_Y + 0.25, bend = 1.4, z = RAIL_Z, v = (x, y) => new THREE.Vector3(x, y, z);
  const left = new THREE.CurvePath();
  left.add(new THREE.LineCurve3(v(-POST_X, BASE_TOP), v(-POST_X, top - bend)));
  left.add(new THREE.QuadraticBezierCurve3(v(-POST_X, top - bend), v(-POST_X, top), v(-POST_X + bend, top)));
  left.add(new THREE.LineCurve3(v(-POST_X + bend, top), v(breakX, top - 0.12)));
  g.add(c.tube(left));
  const right = new THREE.CurvePath(), stub = Math.max(1.6, POST_X - breakX - 2.2) * 0.7;
  right.add(new THREE.LineCurve3(v(0, 0), v(0, top - bend - BASE_TOP)));
  right.add(new THREE.QuadraticBezierCurve3(v(0, top - bend - BASE_TOP), v(0, top - BASE_TOP), v(-bend, top - BASE_TOP)));
  right.add(new THREE.LineCurve3(v(-bend, top - BASE_TOP), v(-bend - stub, top - BASE_TOP - stub * 0.55)));
  const lean = c.tube(right);
  const leanG = new THREE.Group(); leanG.add(lean); leanG.position.set(POST_X, BASE_TOP, 0);
  leanG.rotation.z = -(0.2 + rand() * 0.12); g.add(leanG);

  const xs = Array.from({ length: N }, (_, i) => (i - (N - 1) / 2) * 2 * R * 1.002);
  const fallen = xs.map((x, i) => i).filter((i) => xs[i] > breakX);
  const hanging = xs.map((x, i) => i).filter((i) => xs[i] <= breakX);
  const wound = hanging.length > 1 && rand() < 0.75 ? hanging[Math.floor(rand() * hanging.length)] : -1;
  for (const i of hanging) {
    const p = c.pendulum(xs[i]);
    p.rotation.z = (rand() - 0.5) * 0.06;
    if (i === wound) { // string wound around the bar: the ball hangs much higher
      p.children[0].position.y = -2.6; p.children[1].position.y = -2.6 + R + 0.05;
      p.remove(p.children[3], p.children[2]);
      for (const zz of [-RAIL_Z, RAIL_Z]) p.add(c.stringTo(new THREE.Vector3(0, -2.6 + R + 0.12, 0), new THREE.Vector3(0, 0.25, zz)));
      for (let k = 0; k < 4; k++) {
        const loop = c.shadowy(new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.03, 6, 20), c.mat.string));
        loop.position.set(-0.45 + k * 0.3, 0.25, 0.9 - k * 0.5); loop.rotation.set(0.3, Math.PI / 2, 0.35); p.add(loop);
      }
    }
    g.add(p);
  }
  // fallen balls on the base, spread out; the last one has rolled off onto the floor
  const placed = [];
  fallen.forEach((i, k) => {
    let x, y, zz;
    if (k === fallen.length - 1 && fallen.length > 1) { x = 10.6 + rand() * 0.5; y = BASE_TOP - 1.3 + R; zz = 1.5 + rand() * 1.5; }
    else {
      for (let t = 0; t < 30; t++) {
        x = (rand() * 2 - 1) * 7.6; zz = 1.1 + rand() * 1.7;
        if (placed.every(([px, pz]) => Math.abs(px - x) > 2.4)) break;
      }
      y = BASE_TOP + R;
    }
    placed.push([x, zz]);
    const b = c.shadowy(new THREE.Mesh(new THREE.SphereGeometry(R, 48, 32), c.mat.ball)); b.position.set(x, y, zz); g.add(b);
    // its string tail lying beside it, and the snapped stub still hanging from the back rail
    const ang = rand() * Math.PI * 2, len = 1.4 + rand() * 1.2;
    g.add(c.stringTo(new THREE.Vector3(x, y + 0.02 - (y > BASE_TOP ? 0 : 0) + R * 0.0, zz), new THREE.Vector3(x + Math.cos(ang) * len, y - R + 0.03, zz + Math.sin(ang) * len)));
    const sx = xs[i], sl = 1.5 + rand() * 2.2;
    g.add(c.stringTo(new THREE.Vector3(sx + (rand() - 0.5) * 0.5, RAIL_Y + 0.25 - sl, -RAIL_Z + 0.4), new THREE.Vector3(sx, RAIL_Y + 0.25, -RAIL_Z)));
  });
  g.visible = false;
  return g;
}

// Draw one cradle into the 2D context g. rect = {x, y, w, h} in CSS px; dpr = device pixel ratio.
// sides = [[left samples], [right samples]] where each sample is [angle, opacity]; broken = rng or null.
export function drawCradle3D(g, rect, dpr, sides, alpha, brokenKey, rand) {
  if (!ctx) ctx = setup();
  if (!ctx) return false;
  const c = ctx, W = Math.max(1, Math.round(rect.w * dpr)), H = Math.max(1, Math.round(rect.h * dpr));
  if (c.canvas.width < W || c.canvas.height < H) {
    c.renderer.setSize(Math.max(W, c.canvas.width), Math.max(H, c.canvas.height), false);
  }
  const CH = c.canvas.height;
  c.renderer.setViewport(0, CH - H, W, H); c.renderer.setScissor(0, CH - H, W, H);
  c.renderer.clear();
  for (const b of c.broken.values()) b.visible = false;
  if (brokenKey) {
    if (!c.broken.has(brokenKey)) { const b = buildBroken(c, rand); c.broken.set(brokenKey, b); c.scene.add(b); }
    c.broken.get(brokenKey).visible = true; c.whole.visible = false;
  } else {
    c.whole.visible = true;
    for (const p of c.pend) p.rotation.z = 0;
    [0, 1].forEach((s) => {
      const list = sides[s], real = c.pend[s === 0 ? 0 : N - 1], gh = c.ghosts[s];
      for (const p of gh) p.visible = false;
      if (list.length === 1 && list[0][1] >= 0.99) { real.visible = true; real.rotation.z = list[0][0]; return; }
      real.visible = false;
      list.slice(0, GHOSTS).forEach(([ang, op], k) => {
        const p = gh[k]; p.visible = true; p.rotation.z = ang;
        for (const m of Object.values(p.userData.m)) m.opacity = Math.min(1, op);
      });
    });
  }
  // keep strings at least ~0.8 device pixels wide however small the cradle is drawn
  const k = Math.max(1, 0.8 / (0.044 * H / 16));
  for (const s of c.strings) { s.scale.x = k; s.scale.z = k; }
  c.renderer.render(c.scene, c.camera);
  g.save(); g.globalAlpha = alpha;
  g.drawImage(c.canvas, 0, 0, W, H, rect.x, rect.y, rect.w, rect.h);
  g.restore();
  return true;
}

// Render once into a cached 2D canvas (for cradles whose picture isn't changing).
export function renderToCache(cache, rect, dpr, sides, brokenKey, rand) {
  const W = Math.max(1, Math.round(rect.w * dpr)), H = Math.max(1, Math.round(rect.h * dpr));
  if (cache.width !== W || cache.height !== H) { cache.width = W; cache.height = H; }
  const g = cache.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
  return drawCradle3D(g, { x: 0, y: 0, w: W, h: H }, 1, sides, 1, brokenKey, rand);
}

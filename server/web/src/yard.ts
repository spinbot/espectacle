// The 3D yard: the LiDAR point cloud, every mapped LED as a glowing dot, and a ring at each plant.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface LEDPoint { x: number; y: number; z: number }

export class YardView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
  readonly controls: OrbitControls;
  private area?: THREE.Points;
  private leds?: THREE.Points;
  private halo?: THREE.Points;
  private ledColors?: THREE.BufferAttribute;
  /** How visible the yard scan is (0..1), how bright lit LEDs are drawn (1 = as is), unlit LED level. */
  scanLevel = 0.15;
  glow = 1.6;
  unlitLevel = 0.012;
  private rings = new THREE.Group();
  private framed = false;
  /** The yard's front (degrees, see yardFront): which way the street is. */
  private front = 0;
  private frontMarker = new THREE.Group();
  private ledPos?: Float32Array;
  private arrow?: THREE.Object3D;
  private camMesh?: THREE.Object3D;
  private ghosts?: THREE.Points;
  private markers: THREE.Sprite[] = [];
  /** While set, a plain click on the view (not a drag) is passed here (LED position editing). */
  onClick?: (clientX: number, clientY: number) => void;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x05070d);
    this.camera.position.set(0, 3, 8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1, 0);
    // Navigation: drag rotates; right-drag, shift/cmd/ctrl-drag or two fingers move (pan); the wheel or a
    // pinch zooms towards the pointer; arrow keys move; double-click centres on the LED or spot under it.
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.keyPanSpeed = 20;
    const el = this.renderer.domElement;
    el.tabIndex = 0;
    el.style.outline = 'none';
    el.addEventListener('pointerdown', () => el.focus({ preventScroll: true }));
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('dblclick', e => this.focusAt(e));
    let down: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', e => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
    el.addEventListener('pointerup', e => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.onClick?.(e.clientX, e.clientY);
      down = null;
    });
    this.controls.listenToKeyEvents(el);

    const grid = new THREE.GridHelper(40, 40, 0x1c2538, 0x111827);
    this.scene.add(grid, this.rings);
    // A marker pointing to the street (the yard's front; see setFront).
    const front = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.25, 12), new THREE.MeshBasicMaterial({ color: 0x3b82f6 }));
    front.rotation.x = Math.PI / 2;
    front.position.set(0, 0.02, 2);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.02, 0.3), new THREE.Vector3(0, 0.02, 1.9)]),
      new THREE.LineDashedMaterial({ color: 0x3b82f6, dashSize: 0.1, gapSize: 0.08 }));
    line.computeLineDistances();
    this.frontMarker.add(front, line);
    this.scene.add(this.frontMarker);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setArea(positions: Float32Array, colors: Uint8Array) {
    if (this.area) { this.scene.remove(this.area); this.area.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    // Dimmed so the LEDs stand out against the scan.
    const m = new THREE.PointsMaterial({ size: 0.02, vertexColors: true, color: 0x8a92a0, transparent: true, opacity: this.scanLevel, depthWrite: false });
    this.area = new THREE.Points(g, m);
    this.scene.add(this.area);
    if (!this.framed && positions.length) this.frame(positions);
  }

  /** Replaces the LED dots. Colours start dark; update them with setColors every frame. */
  setLEDs(points: LEDPoint[]) {
    if (this.leds) { this.scene.remove(this.leds); this.leds.geometry.dispose(); }
    if (this.halo) this.scene.remove(this.halo);
    const pos = new Float32Array(points.length * 3);
    points.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z; });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.ledColors = new THREE.BufferAttribute(new Float32Array(points.length * 3), 3);
    this.ledColors.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('color', this.ledColors);
    const m = new THREE.PointsMaterial({
      size: 0.1, map: glowTexture(), vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.leds = new THREE.Points(g, m);
    // A second, larger and fainter copy gives lit LEDs a glow that reads against the dark yard.
    this.halo = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.45, map: glowTexture(), vertexColors: true, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.scene.add(this.halo, this.leds);
    this.ledPos = pos;
    if (!this.framed && points.length) this.frame(pos);
  }

  /** RGB 0..255 per LED, already scaled for brightness. Unlit LEDs stay faintly visible. */
  setColors(rgb: Float32Array) {
    if (!this.ledColors) return;
    const a = this.ledColors.array as Float32Array;
    // Brighten each LED as a whole (LEDs look brighter in real life than on a screen), keeping its
    // colour: boost the brightest channel and scale the others with it, so reds stay red.
    for (let i = 0; i < a.length; i += 3) {
      const r = rgb[i] / 255, g = rgb[i + 1] / 255, b = rgb[i + 2] / 255;
      const m = Math.max(r, g, b);
      const k = m > 0 ? Math.min(1, Math.pow(m, 0.6) * this.glow) / m : 0;
      a[i] = this.unlitLevel + r * k;
      a[i + 1] = this.unlitLevel + g * k;
      a[i + 2] = this.unlitLevel + b * k;
    }
    this.ledColors.needsUpdate = true;
  }

  setScanLevel(v: number) {
    this.scanLevel = v;
    if (this.area) {
      (this.area.material as THREE.PointsMaterial).opacity = v;
      this.area.visible = v > 0.001;
    }
  }

  setPlantRings(rings: { x: number; y: number; z: number; r: number; color: number }[]) {
    this.rings.clear();
    for (const r of rings) {
      const geo = new THREE.RingGeometry(Math.max(r.r, 0.05), Math.max(r.r, 0.05) + 0.02, 48);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: r.color, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(r.x, r.y + 0.005, r.z);
      this.rings.add(mesh);
    }
  }

  private frame(pos: Float32Array) {
    const box = robustBox(pos);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const size = Math.max(s.x, s.y, s.z, 2);
    this.controls.target.copy(c);
    const back = this.toYard([0, 0, 1]);          // stand on the street side
    this.camera.position.set(c.x + back.x * size * 1.4, c.y + size * 0.45, c.z + back.z * size * 1.4);
    this.frontMarker.position.set(c.x, 0, c.z);
    this.framed = true;
  }

  /** Faint dots for drawn or copied plants that aren't wired yet, so they can be placed first. */
  setGhosts(positions: Float32Array) {
    if (this.ghosts) { this.scene.remove(this.ghosts); this.ghosts.geometry.dispose(); this.ghosts = undefined; }
    if (!positions.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.ghosts = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.05, color: 0x64748b, transparent: true, opacity: 0.7, depthWrite: false }));
    this.scene.add(this.ghosts);
  }

  /** Which way the street is (degrees; positive turns it to the right). Turns the marker and the views. */
  setFront(deg: number) {
    this.front = deg;
    this.frontMarker.rotation.y = (deg * Math.PI) / 180;
  }

  /** A direction the controllers use (street = +Z) as a direction in the yard scan. */
  private toYard(v: number[]) {
    const th = (this.front * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
    return new THREE.Vector3(v[0] * cs + v[2] * sn, v[1], -v[0] * sn + v[2] * cs);
  }

  /** Back to the starting view of all the LEDs. */
  resetView() {
    if (this.ledPos?.length) this.frame(this.ledPos);
    else { this.controls.target.set(0, 1, 0); this.camera.position.set(0, 3, 8); }
  }

  /** Moves the orbit centre to the LED (or scan point, or ground) under the pointer, keeping the distance. */
  private focusAt(e: MouseEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    ray.params.Points = { threshold: 0.06 };
    const objs = [this.leds, this.area].filter((o): o is THREE.Points => !!o && o.visible);
    let hit = ray.intersectObjects(objs, false)[0]?.point;
    if (!hit) {
      const p = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) hit = p;
    }
    if (!hit) return;
    const shift = hit.clone().sub(this.controls.target);
    this.controls.target.add(shift);
    this.camera.position.add(shift);
  }

  /** Middle and largest half-size of the LEDs (the box effects are fitted to in "whole yard" mode). */
  private ledBounds() {
    const box = robustBox(this.ledPos!);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    return { c, half: Math.max(s.x, s.y, s.z, 1) / 2 };
  }

  /** The camera's picture axes, as the firmware works them out (see fxPrepare in effects.cpp). */
  private static cameraAxes(look: THREE.Vector3) {
    const helper = Math.abs(look.y) > 3900 / 4096 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const right = look.clone().cross(helper).normalize();
    const up = right.clone().cross(look).normalize();
    return { right, up };
  }

  /**
   * Shows which way a moving effect travels (an arrow through the LEDs) or, with `camera`, where a 2D
   * effect's camera is and the picture it sees. null hides it.
   */
  setDirArrow(v: number[] | null, camera = false) {
    if (this.arrow) {
      this.scene.remove(this.arrow);
      this.arrow.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose(); });
      this.arrow = undefined;
    }
    if (!v || !this.ledPos?.length) return;
    const ctl = new THREE.Vector3(v[0], v[1], v[2]);
    if (ctl.lengthSq() < 1e-6) return;
    ctl.normalize();
    const dir = this.toYard([ctl.x, ctl.y, ctl.z]);
    const { c, half } = this.ledBounds();
    const group = new THREE.Group();
    const noDepth = (m: THREE.Material) => { m.depthTest = false; m.transparent = true; return m; };
    if (!camera) {
      const len = half * 1.2;
      const a = new THREE.ArrowHelper(dir, c.clone().addScaledVector(dir, -len / 2), len, 0xfacc15, len * 0.2, len * 0.09);
      noDepth(a.line.material as THREE.Material); noDepth(a.cone.material as THREE.Material);
      group.add(a);
    } else {
      // The picture: a frame through the middle of the LEDs, facing the camera, with lines to the camera.
      const axes = YardView.cameraAxes(ctl);
      const right = this.toYard([axes.right.x, axes.right.y, axes.right.z]);
      const up = this.toYard([axes.up.x, axes.up.y, axes.up.z]);
      const eye = c.clone().addScaledVector(dir, -this.viewDistance(half));
      const corner = (sx: number, sy: number) => c.clone().addScaledVector(right, sx * half).addScaledVector(up, sy * half);
      const k = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      const pts = [k[0], k[1], k[1], k[2], k[2], k[3], k[3], k[0]];
      const frameMat = noDepth(new THREE.LineBasicMaterial({ color: 0x38bdf8, opacity: 0.9 }));
      group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), frameMat));
      const rays = k.flatMap(p => [eye, p]);
      group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rays),
        noDepth(new THREE.LineBasicMaterial({ color: 0x38bdf8, opacity: 0.35 }))));
      // "Up" tick on the top edge so you can tell which way up the picture is.
      const top = c.clone().addScaledVector(up, half);
      group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([top, top.clone().addScaledVector(up, half * 0.15)]), frameMat));
      // The camera itself: a small box with a lens pointing at the yard.
      const s = half * 0.07;
      const body = new THREE.Mesh(new THREE.BoxGeometry(s * 1.6, s, s), noDepth(new THREE.MeshBasicMaterial({ color: 0x38bdf8 })));
      const lens = new THREE.Mesh(new THREE.ConeGeometry(s * 0.45, s * 0.8, 16), noDepth(new THREE.MeshBasicMaterial({ color: 0x7dd3fc })));
      lens.position.set(0, 0, -s * 0.8);
      lens.rotation.x = -Math.PI / 2;
      const cam = new THREE.Group();
      cam.add(body, lens);
      cam.position.copy(eye);
      cam.matrixAutoUpdate = true;
      cam.lookAt(c);              // Object3D.lookAt points -Z... for non-cameras it points +Z at the target
      cam.rotateY(Math.PI);       // so turn round: the lens (on -Z) faces the yard
      group.add(cam);
      cam.userData.size = s;
      this.camMesh = cam;
    }
    group.renderOrder = 10;
    group.traverse(o => { o.renderOrder = 10; });
    this.arrow = group;
    this.scene.add(group);
  }

  /** Moves the view to look the way `v` points, at the middle of the LEDs (a 2D effect's camera view). */
  lookAlong(v: number[]) {
    if (!this.ledPos?.length) return;
    const dir = this.toYard(v).normalize();
    const { c, half } = this.ledBounds();
    // Straight up/down confuses the orbit controls; lean very slightly so "up" on screen is away from the street.
    if (Math.abs(dir.y) > 0.999) dir.add(this.toYard([0, 0, dir.y > 0 ? 0.002 : -0.002])).normalize();
    const dist = this.viewDistance(half);
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, -dist);
    this.controls.update();
  }

  private flight?: { t0: number; fromPos: THREE.Vector3; fromTarget: THREE.Vector3; toPos: THREE.Vector3; toTarget: THREE.Vector3 };

  /**
   * Flies the view to look at `points` (yard metres) from the horizontal direction `toward` (unit x, z:
   * where the viewer stands, seen from the points), a little from above, close enough that they fill it.
   */
  frameOn(points: number[][], toward: [number, number]) {
    if (!points.length) return;
    points = inliers(points.flat());                         // a stray LED mustn't shrink the prop to a dot
    const box = new THREE.Box3();
    for (const p of points) box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2]));
    const c = box.getCenter(new THREE.Vector3());
    const back = new THREE.Vector3(toward[0], Math.tan(15 * Math.PI / 180), toward[1]).normalize();   // camera side
    const fwd = back.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd);
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360), tanH = tanV * this.camera.aspect;
    // Each point must fit inside the picture: |x| <= (d + depth) tanH and |y| <= (d + depth) tanV.
    let d = 0.3;
    const v = new THREE.Vector3();
    for (const p of points) {
      v.set(p[0], p[1], p[2]).sub(c);
      const depth = v.dot(fwd);
      d = Math.max(d, Math.abs(v.dot(right)) / tanH - depth, Math.abs(v.dot(up)) / tanV - depth);
    }
    d *= 1.12;                                                 // a little margin
    this.flight = { t0: performance.now(), fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(),
      toPos: c.clone().addScaledVector(back, d), toTarget: c };
  }

  /** Index of the point nearest the pointer on screen (within `maxPx`), nearer the camera on ties; -1: none. */
  nearest(points: number[][], clientX: number, clientY: number, maxPx = 16): number {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    let best = -1, bestScore = Infinity;
    points.forEach((p, i) => {
      v.set(p[0], p[1], p[2]).project(this.camera);
      if (v.z > 1) return;                                     // behind the camera
      const sx = r.left + (v.x + 1) / 2 * r.width, sy = r.top + (1 - v.y) / 2 * r.height;
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d > maxPx) return;
      const score = d + v.z * 4;                               // prefer the front one when they overlap
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  /**
   * A ring drawn on top of everything at `p`; null hides it. Slot 0 (yellow): the LED being edited;
   * slot 1 (cyan): the other end of a run being straightened.
   */
  setMarker(p: number[] | null, slot = 0) {
    let mk = this.markers[slot];
    if (!mk) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      g.strokeStyle = slot === 0 ? '#ffd60a' : '#22d3ee';
      g.lineWidth = 6;
      g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.stroke();
      const m = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false, transparent: true });
      mk = this.markers[slot] = new THREE.Sprite(m);
      mk.scale.set(0.045, 0.045, 1);
      mk.renderOrder = 10;
    }
    if (p) { mk.position.set(p[0], p[1], p[2]); if (!mk.parent) this.scene.add(mk); }
    else this.scene.remove(mk);
  }

  /** Horizontal directions as seen in the view: to the right, and towards the viewer (unit x, z). */
  viewAxes(): { right: [number, number]; toward: [number, number] } {
    const d = this.controls.target.clone().sub(this.camera.position);
    let fx = d.x, fz = d.z;
    const len = Math.hypot(fx, fz);
    if (len < 1e-6) {                                          // looking straight down: use the screen's up
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      fx = up.x; fz = up.z;
    }
    const l = Math.hypot(fx, fz) || 1;
    fx /= l; fz /= l;
    return { right: [-fz, fx], toward: [-fx, -fz] };
  }

  private viewDistance(half: number) { return half / Math.tan((this.camera.fov * Math.PI) / 360) * 1.25; }

  render() {
    if (this.flight) {
      const f = this.flight, t = Math.min(1, (performance.now() - f.t0) / 600), k = t * t * (3 - 2 * t);
      this.camera.position.lerpVectors(f.fromPos, f.toPos, k);
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
      if (t >= 1) this.flight = undefined;
    }
    this.controls.update();
    // Hide the little camera when looking through it (or from right next to it).
    if (this.camMesh?.parent) this.camMesh.visible = this.camera.position.distanceTo(this.camMesh.position) > this.camMesh.userData.size * 6;
    this.renderer.render(this.scene, this.camera);
  }
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The points (x, y, z triples) without strays: anything much further from the middle (per-axis median)
 * than the typical point. Big clouds are sampled.
 */
function inliers(pos: ArrayLike<number>): number[][] {
  const n = Math.floor(pos.length / 3);
  const stride = Math.max(1, Math.floor(n / 20000));
  const pts: number[][] = [];
  for (let i = 0; i < n; i += stride) pts.push([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
  if (pts.length < 8) return pts;
  const median = (a: number[]) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const m = [0, 1, 2].map(k => median(pts.map(p => p[k])));
  const dist = pts.map(p => Math.hypot(p[0] - m[0], p[1] - m[1], p[2] - m[2]));
  const limit = Math.max(median(dist) * 4, 1);
  const keep = pts.filter((_, i) => dist[i] <= limit);
  return keep.length >= pts.length * 0.8 ? keep : pts;
}

function robustBox(pos: ArrayLike<number>): THREE.Box3 {
  const box = new THREE.Box3();
  for (const p of inliers(pos)) box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2]));
  return box;
}

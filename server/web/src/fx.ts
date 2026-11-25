// The firmware's effect code, compiled to WebAssembly (see wasm/build.sh), so the preview is
// exactly what the controllers render.
export const FRAME_YARD = 0, FRAME_EACH = 1, FRAME_GROUP = 2;

interface FxExports {
  memory: WebAssembly.Memory;
  fx_init(): void;
  geo_ptr(): number;
  out_ptr(): number;
  zone_frames_ptr(): number;
  group_frame_ptr(): number;
  max_leds(): number;
  geo_size(): number;
  render(n: number, fx: number, pal: number, bri: number, scl: number, rate: number,
         c1: number, c2: number, ms: number, base: number, mode: number,
         hasDir: number, dx: number, dy: number, dz: number): void;
  zone_in_ptr(): number;
  zone_ms_ptr(): number;
  render_zones(n: number, base: number): void;
}

/** What the WebAssembly module imports (maths the firmware's C library would provide). */
export const wasmEnv = () => {
  const lround = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));
  return { env: { sinf: (x: number) => Math.fround(Math.sin(x)), atanf: (x: number) => Math.fround(Math.atan(x)), lroundf: lround } };
};

/** What one zone (plant) shows in a show frame. */
export interface ZoneFrame {
  zone: number; fx: number; pal: number; bri: number; scl: number; rate: number; c1: number; c2: number;
  mode: number; group: number[]; ms: number;
  dir?: number[] | null;   // direction of travel, 4096 == 1 (null: the effect's default)
}

export interface FxParams {
  fx: number; pal: number; bri: number; scl: number; rate: number; c1: number; c2: number;
  dir?: number[] | null;
}

export class Effects {
  private constructor(private e: FxExports) {}

  static async load(url = 'fx.wasm') {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(url), wasmEnv());
    return Effects.fromInstance(instance);
  }

  /** From an already instantiated module (the server loads the file itself). */
  static fromInstance(instance: WebAssembly.Instance) {
    const e = instance.exports as unknown as FxExports;
    e.fx_init();
    return new Effects(e);
  }


  get maxLEDs() { return this.e.max_leds(); }

  /** Plant boxes, seven values per zone (from the layout). */
  setZoneFrames(frames: number[]) {
    new Int16Array(this.e.memory.buffer, this.e.zone_frames_ptr(), frames.length).set(frames);
  }

  setGroupFrame(frame: number[]) {
    new Int16Array(this.e.memory.buffer, this.e.group_frame_ptr(), 7).set(frame);
  }

  /** Packs geometry (8 numbers per LED) into the controller's 16-byte Geo layout. */
  static packGeo(geo: number[][]): Uint8Array {
    const buf = new ArrayBuffer(geo.length * 16);
    const dv = new DataView(buf);
    geo.forEach((g, i) => {
      const o = i * 16;
      dv.setInt16(o, g[0], true); dv.setInt16(o + 2, g[1], true); dv.setInt16(o + 4, g[2], true);
      dv.setUint16(o + 6, g[3], true); dv.setUint16(o + 8, g[4], true); dv.setUint16(o + 10, g[5], true);
      dv.setUint16(o + 12, g[6], true); dv.setUint8(o + 14, g[7]); dv.setUint8(o + 15, 0);
    });
    return new Uint8Array(buf);
  }

  /** Sets what each zone shows for the next renderZones calls (zones not listed are dark). */
  setZones(zones: ZoneFrame[]) {
    const ints = new Int32Array(this.e.memory.buffer, this.e.zone_in_ptr(), 32 * 20);
    const ms = new Float64Array(this.e.memory.buffer, this.e.zone_ms_ptr(), 32);
    ints.fill(0);
    for (const z of zones) {
      if (z.zone < 0 || z.zone >= 32) continue;
      const d = z.dir;
      ints.set([1, z.fx, z.pal, z.bri, z.scl, z.rate, z.c1 | 0, z.c2 | 0, z.mode, ...z.group.slice(0, 7),
                d ? 1 : 0, d ? d[0] : 0, d ? d[1] : 0, d ? d[2] : 0], z.zone * 20);
      ms[z.zone] = z.ms;
    }
  }

  /** Renders one controller's LEDs in show mode: each LED uses its zone's effect. */
  renderZones(packedGeo: Uint8Array, base: number): Uint8Array {
    const n = Math.min(packedGeo.length / 16, this.maxLEDs);
    new Uint8Array(this.e.memory.buffer, this.e.geo_ptr(), n * 16).set(packedGeo.subarray(0, n * 16));
    this.e.render_zones(n, base);
    return new Uint8Array(this.e.memory.buffer, this.e.out_ptr(), n * 3);
  }

  /** Renders one controller's LEDs; returns RGB bytes (a view that the next call overwrites). */
  render(packedGeo: Uint8Array, p: FxParams, ms: number, base: number, mode = FRAME_YARD): Uint8Array {
    const n = Math.min(packedGeo.length / 16, this.maxLEDs);
    new Uint8Array(this.e.memory.buffer, this.e.geo_ptr(), n * 16).set(packedGeo.subarray(0, n * 16));
    this.e.render(n, p.fx, p.pal, p.bri, p.scl, p.rate, p.c1 >>> 0, p.c2 >>> 0, ms, base, mode,
                  p.dir ? 1 : 0, p.dir ? p.dir[0] : 0, p.dir ? p.dir[1] : 0, p.dir ? p.dir[2] : 0);
    return new Uint8Array(this.e.memory.buffer, this.e.out_ptr(), n * 3);
  }
}

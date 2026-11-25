// The project as the iOS app saves it (Swift Codable JSON). Only the parts the server and
// website use are typed; everything else is kept untouched when the project is edited here.

export type UUID = string;

export interface LEDString {
  pin: number;
  count: number;
  order: string;
  plantID?: UUID | null;
}

export interface Controller {
  id: string;
  name: string;
  host: string;
  strings: LEDString[];
  maxMilliamps: number;
}

export interface LightState {
  on: boolean;
  fx: number;
  pal: number;
  bri: number;
  spd: number;
  scl: number;
  c1: number;
  c2: number;
  dirYaw?: number | null;    // direction of travel for moving effects (degrees, see dirVector)
  dirPitch?: number | null;
  text?: string | null;      // online effects: marquee text
  media?: string | null;     //   video file
  target?: number | null;    //   countdown to (wall-clock ms); null = next Christmas
}

/** 0 unknown, 1 interpolated, 2 lidar, 3 triangulated */
export interface MappedLED {
  x: number;
  y: number;
  z: number;
  quality: number;
  rescan?: boolean | null;
}

export interface PlantMap {
  date: number;            // seconds since 2001-01-01 (Swift's default Date encoding)
  height: number;
  radius: number;
  layout: string[];        // the wiring when it was scanned (for information: any wiring with the same LED count works)
  leds: MappedLED[];
  /** A clone or a drawn shape rather than a scan of these LEDs. */
  portable?: boolean | null;
}

/** A range of LEDs on one controller string (lets several plants share a string). */
export interface PlantPart {
  controller: string;      // controller id
  string: number;          // string index on that controller
  start: number;           // first LED on the string, from 0
  count: number;
}

export type ShapeKind = 'grid' | 'cone' | 'polyline' | 'circle' | 'arch' | 'panel';

/**
 * A drawn (not scanned) shape. Sizes in metres; LEDs are spread evenly along it.
 * `start` is where the data comes in: grid 'bottomLeft' | 'bottomRight' | 'topLeft' | 'topRight';
 * cone 'bottom' | 'top'; arch 'left' | 'right' (circle and polyline use startAngle / reverse).
 */
export interface PlantShape {
  kind: ShapeKind;
  count: number;            // LEDs (grid: rows x columns; cone strands: a multiple of the strand count)
  perMetre: number | null;  // when set, count follows from the length (not for grids)
  width: number;            // grid width, arch span, circle diameter, cone bottom diameter
  height: number;           // grid / arch / cone height
  topWidth: number;         // cone top diameter
  rows: number;             // grid rows
  columns: number;          // grid columns, cone strands
  start: string;
  vertical: boolean;        // grid: wired up and down the columns
  zigzag: boolean;          // grid rows / cone strands alternate direction
  spiral: boolean;          // cone: one wire wrapped round instead of strands
  turns: number;            // cone spiral turns
  flat: boolean;            // circle lying flat (else standing up, facing the street)
  startAngle: number;       // circle: degrees; 0 = right, 90 = top (away from the street when flat)
  clockwise: boolean;       // circle: as seen from the street (or from above when flat)
  reverse: boolean;         // polyline: start at the last point
  points: { x: number; y: number; z: number }[];   // polyline corners, metres from the plant's origin
  // panel: LED matrix panels (e.g. 16x16, 8x32) of rows x columns each, tiled tilesX x tilesY,
  // chained from the `start` corner along rows of panels; pitch = LED spacing in metres.
  pitch?: number;
  tilesX?: number;
  tilesY?: number;
}

export interface Plant {
  id: UUID;
  name: string;
  x: number;
  y: number;
  z: number;
  rotation: number;        // degrees
  map?: PlantMap | null;
  /** When set, the plant's LEDs are these ranges (in order) instead of the strings assigned to it. */
  parts?: PlantPart[] | null;
  shape?: PlantShape | null;
}

export interface AreaInfo {
  date: number;
  pointCount: number;
}

import type { ScheduleSettings } from './schedule.js';

/** Yard-wide settings. */
export interface YardSettings {
  /** Degrees the street side is turned from the yard scan's +Z (positive turns it to the right, like a
   *  plant's rotation). Effect directions and camera views are measured from it. */
  front: number;
}

export interface AppData {
  controllers: Controller[];
  state: LightState;
  plants: Plant[];
  area?: AreaInfo | null;
  yard?: YardSettings | null;
  schedule?: ScheduleSettings | null;
  shows: unknown[];
  [key: string]: unknown;
}

export interface ProjectEnvelope {
  revision: number;
  updated: string;         // ISO time of the last change
  data: AppData;
}

export const emptyProject = (): AppData => ({
  controllers: [],
  state: { on: true, fx: 1, pal: 1, bri: 128, spd: 96, scl: 128, c1: 0xff0000, c2: 0x00a000 },
  plants: [],
  shows: [],
});

/** Swift Date (seconds since 2001) -> JS Date */
export const swiftDate = (s: number) => new Date((s + 978307200) * 1000);

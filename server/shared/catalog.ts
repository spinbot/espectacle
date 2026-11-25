// Built-in effects and palettes. Ids must match firmware/src/effects.cpp (and EffectCatalog.swift).
export interface EffectInfo {
  id: number;
  name: string;
  usesPalette: boolean;
  usesColor1: boolean;
  usesColor2: boolean;
  scaleLabel?: string;
  /** Moves in a direction you can choose (yaw/pitch); `dirDefault` describes what it does without one. */
  usesDirection?: boolean;
  dirDefault?: string;
  /** A 2D picture seen from a camera; the direction (dirYaw/dirPitch) is where the camera looks. */
  usesView?: boolean;
  /** Drawn by the server and streamed to the lights (needs the server running; firmware 1.8+). */
  online?: boolean;
  usesText?: boolean;
  usesMedia?: boolean;
  usesTarget?: boolean;    // countdown: a date and time to count down to
}

/** Whether a direction setting applies to this effect (moving effects and camera effects). */
export const hasDirSetting = (fx: number) => !!(fxInfo(fx)?.usesDirection || fxInfo(fx)?.usesView);

const fx = (id: number, name: string, o: Partial<EffectInfo> = {}): EffectInfo =>
  ({ id, name, usesPalette: true, usesColor1: false, usesColor2: false, ...o });

export const EFFECTS: EffectInfo[] = [
  fx(0, 'Solid', { usesPalette: false, usesColor1: true }),
  fx(1, 'Gradient', { scaleLabel: 'Repeats', usesDirection: true, dirDefault: 'Up each prop' }),
  fx(2, 'Spiral', { scaleLabel: 'Twists' }),
  fx(3, 'Stripes', { usesPalette: false, usesColor1: true, usesColor2: true, scaleLabel: 'Twists' }),
  fx(4, 'Sweep', { scaleLabel: 'Thickness', usesDirection: true, dirDefault: 'Random each pass' }),
  fx(5, 'Rings', { scaleLabel: 'Rings', usesDirection: true, dirDefault: 'Up each prop' }),
  fx(6, 'Beam', { scaleLabel: 'Beam width' }),
  fx(7, 'Pulse', { scaleLabel: 'Rings' }),
  fx(8, 'Twinkle', { scaleLabel: 'Density' }),
  fx(9, 'Glitter', { scaleLabel: 'Sparkle' }),
  fx(10, 'Plasma', { scaleLabel: 'Detail', usesDirection: true, dirDefault: 'Swirl in place' }),
  fx(11, 'Fire', { usesPalette: false, scaleLabel: 'Height' }),
  fx(12, 'Snow', { usesPalette: false, usesColor1: true, usesColor2: true, scaleLabel: 'Flake size' }),
  fx(13, 'Chase', { scaleLabel: 'Spacing' }),
  fx(14, 'Flash', { scaleLabel: 'Decay' }),
  fx(15, 'Meteor', { scaleLabel: 'Lane width', usesDirection: true, dirDefault: 'Falling' }),
  fx(16, 'Ripple', { scaleLabel: 'Thickness' }),
  fx(17, 'Spin', { scaleLabel: 'Twists', usesDirection: true, dirDefault: 'Around the vertical' }),
  fx(18, 'Clouds', { scaleLabel: 'Cloud size', usesDirection: true, dirDefault: 'Drift right' }),
  // 2D pictures seen from a camera (firmware 1.7+)
  fx(19, 'Bars', { scaleLabel: 'Bars', usesView: true }),
  fx(20, 'Wave', { scaleLabel: 'Thickness', usesView: true }),
  fx(21, 'Radar', { scaleLabel: 'Trail', usesView: true }),
  fx(22, 'Tunnel', { scaleLabel: 'Rings', usesView: true }),
  fx(23, 'Checker', { usesPalette: false, usesColor1: true, usesColor2: true, scaleLabel: 'Square size', usesView: true }),
];

/** Online effects (ids 200+): drawn by the server (shared/online.ts), streamed to the controllers. */
export const ONLINE_EFFECTS: EffectInfo[] = [
  fx(200, 'Marquee', { scaleLabel: 'Text size', usesView: true, online: true, usesText: true }),
  fx(201, 'Video', { usesPalette: false, scaleLabel: 'Zoom', usesView: true, online: true, usesMedia: true }),
  fx(202, 'Countdown', { scaleLabel: 'Text size', usesView: true, online: true, usesText: true, usesTarget: true }),
];

export const ALL_EFFECTS = [...EFFECTS, ...ONLINE_EFFECTS];
/** Any effect by id (built-in or online). */
export const fxInfo = (id: number): EffectInfo | undefined => (id >= 200 ? ONLINE_EFFECTS.find(e => e.id === id) : EFFECTS[id]);

/**
 * Direction of travel from yaw/pitch in degrees, as the firmware's unit vector (4096 == 1).
 * Yaw 0 = right (+X), 90 = away from the street (-Z), 180 = left, 270 = towards the street (+Z).
 * Pitch +90 = straight up, -90 = straight down.
 */
export function dirVector(yaw: number, pitch: number): number[] {
  const y = (yaw * Math.PI) / 180, p = (pitch * Math.PI) / 180;
  const r = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));   // as Swift .rounded()
  return [Math.cos(p) * Math.cos(y), Math.sin(p), -Math.cos(p) * Math.sin(y)].map((v) => r(v * 4096));
}

/** Camera positions for 2D effects: the direction is where the camera looks. */
export const VIEW_PRESETS: { name: string; yaw: number; pitch: number }[] = [
  { name: 'Street', yaw: 90, pitch: 0 }, { name: 'Behind', yaw: 270, pitch: 0 },
  { name: 'Left side', yaw: 0, pitch: 0 }, { name: 'Right side', yaw: 180, pitch: 0 },
  { name: 'Above', yaw: 90, pitch: -90 }, { name: 'Below', yaw: 90, pitch: 90 },
];

export const DIR_PRESETS: { name: string; yaw: number; pitch: number }[] = [
  { name: 'Up', yaw: 0, pitch: 90 }, { name: 'Down', yaw: 0, pitch: -90 },
  { name: 'Right', yaw: 0, pitch: 0 }, { name: 'Left', yaw: 180, pitch: 0 },
  { name: 'Away', yaw: 90, pitch: 0 }, { name: 'Towards', yaw: 270, pitch: 0 },
];

export const PALETTES: { id: number; name: string; colors: number[] }[] = [
  { id: 0, name: 'Custom', colors: [] },
  { id: 1, name: 'Rainbow', colors: [0xff0000, 0xffd000, 0x00ff00, 0x00e0ff, 0x0000ff, 0xff00c0] },
  { id: 2, name: 'Christmas', colors: [0xe00000, 0x008a00, 0xffffff, 0x008a00] },
  { id: 3, name: 'Ice', colors: [0x001850, 0x0060ff, 0x80e0ff, 0xffffff] },
  { id: 4, name: 'Fire', colors: [0x400000, 0xff2000, 0xffa000, 0xfff080] },
  { id: 5, name: 'Candy cane', colors: [0xff0000, 0xff0000, 0xffffff, 0xffffff] },
  { id: 6, name: 'Warm gold', colors: [0xff8a18, 0xffc850, 0xff5a00] },
  { id: 7, name: 'Aurora', colors: [0x00ff60, 0x00a0ff, 0x7000ff, 0x00ffc0, 0x0040a0] },
];

/** Speed slider (0..255) -> firmware rate, as fxRateFromSpeed() does. */
export const rateFromSpeed = (spd: number) => (spd + 1) * 32;

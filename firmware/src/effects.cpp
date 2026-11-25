#include "effects.h"
#include <math.h>

// ---------- integer helpers ----------
static int16_t sinTab[257];

Frame zoneFrames[MAX_ZONES];
static uint16_t atanTab[257];     // atan(i / 256), 65536 == one turn

void fxInit() {
  for (int i = 0; i <= 256; i++) sinTab[i] = (int16_t)lroundf(sinf(i * 6.2831853f / 256.0f) * 32767.0f);
  for (int i = 0; i <= 256; i++) atanTab[i] = (uint16_t)lroundf(atanf(i / 256.0f) / 6.2831853f * 65536.0f);
  for (int z = 0; z < MAX_ZONES; z++) zoneFrames[z] = {0, 0, 0, 2048, -2048, 4096, 2048};
}

// ---------- refitting a position to a frame (integer only) ----------
static uint32_t isqrt32(uint32_t v) {
  uint32_t r = 0, bit = 1UL << 30;
  while (bit > v) bit >>= 2;
  while (bit) {
    if (v >= r + bit) { v -= r + bit; r = (r >> 1) + bit; } else r >>= 1;
    bit >>= 2;
  }
  return r;
}

// Angle of (x, z) around the vertical axis, 0 == +x, 16384 == +z (same as the app's atan2(z, x)).
static uint16_t iatan2(int32_t z, int32_t x) {
  if (!x && !z) return 0;
  uint32_t ax = x < 0 ? -x : x, az = z < 0 ? -z : z;
  uint16_t a = ax >= az ? atanTab[(az << 8) / ax] : (uint16_t)(16384 - atanTab[(ax << 8) / az]);
  if (x < 0) a = (uint16_t)(32768 - a);
  if (z < 0) a = (uint16_t)(65536U - a);
  return a;
}

static inline int16_t clamp16(int32_t v) { return v > 32767 ? 32767 : v < -32767 ? -32767 : (int16_t)v; }
static inline uint16_t clampU16(int64_t v) { return v > 65535 ? 65535 : v < 0 ? 0 : (uint16_t)v; }

// Rewrites a position as if `f` were the whole yard: centred, largest half-extent == 2048.
static void fitXYZ(Geo &g, const Geo &src, const Frame &f) {
  int32_t half = f.half < 64 ? 64 : f.half;
  int32_t mul = (2048 << 12) / half;
  int32_t lx = clamp16((int32_t)(((int64_t)(src.x - f.cx) * mul) >> 12));
  int32_t ly = clamp16((int32_t)(((int64_t)(src.y - f.cy) * mul) >> 12));
  int32_t lz = clamp16((int32_t)(((int64_t)(src.z - f.cz) * mul) >> 12));
  g.x = lx; g.y = ly; g.z = lz;
  uint32_t len = isqrt32((uint32_t)(lx * lx) + (uint32_t)(ly * ly) + (uint32_t)(lz * lz));
  g.d3 = clampU16((int64_t)len * 65535 / 3547);   // 3547 == distance to a corner of the box
}

// Also treats the frame as one plant: height from its bottom, angle and radius round its centre.
static void fitPlant(Geo &g, const Geo &src, const Frame &f) {
  int32_t dx = src.x - f.cx, dz = src.z - f.cz;
  dx = clamp16(dx);
  dz = clamp16(dz);
  int32_t h = f.height < 16 ? 16 : f.height, r = f.radius < 16 ? 16 : f.radius;
  g.h = clampU16((int64_t)(src.y - f.ymin) * 65535 / h);
  g.ang = iatan2(dz, dx);
  g.rad = clampU16((int64_t)isqrt32((uint32_t)(dx * dx) + (uint32_t)(dz * dz)) * 65535 / r);
}

// sine of a 16-bit angle, result -32767..32767
static inline int16_t isin(uint16_t a) {
  uint8_t i = a >> 8, f = a & 0xFF;
  int32_t s0 = sinTab[i], s1 = sinTab[i + 1];
  return (int16_t)(s0 + (((s1 - s0) * f) >> 8));
}
static inline uint8_t wave8(uint16_t a) { return (uint8_t)((isin(a) + 32768) >> 8); }
// positive half of a sine, squared: a soft pulse 0..255
static inline uint8_t pulse8(uint16_t a) {
  int16_t s = isin(a);
  if (s <= 0) return 0;
  uint16_t b = s >> 7;
  return (uint8_t)((b * b) >> 8);
}
static inline uint32_t hash32(uint32_t x) {
  x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16;
  return x;
}
static inline uint32_t dim(uint32_t c, uint8_t v) {
  uint16_t s = (uint16_t)v + 1;
  uint32_t r = (((c >> 16) & 0xFF) * s) >> 8;
  uint32_t g = (((c >> 8) & 0xFF) * s) >> 8;
  uint32_t b = ((c & 0xFF) * s) >> 8;
  return (r << 16) | (g << 8) | b;
}
static inline uint32_t mix(uint32_t a, uint32_t b, uint8_t t) {
  uint16_t tb = (uint16_t)t + 1, ta = 256 - tb;
  uint32_t r = ((((a >> 16) & 0xFF) * ta) + (((b >> 16) & 0xFF) * tb)) >> 8;
  uint32_t g = ((((a >> 8) & 0xFF) * ta) + (((b >> 8) & 0xFF) * tb)) >> 8;
  uint32_t bl = (((a & 0xFF) * ta) + ((b & 0xFF) * tb)) >> 8;
  return (r << 16) | (g << 8) | bl;
}
static inline uint32_t addc(uint32_t a, uint32_t b) {
  uint32_t r = ((a >> 16) & 0xFF) + ((b >> 16) & 0xFF); if (r > 255) r = 255;
  uint32_t g = ((a >> 8) & 0xFF) + ((b >> 8) & 0xFF);   if (g > 255) g = 255;
  uint32_t bl = (a & 0xFF) + (b & 0xFF);                if (bl > 255) bl = 255;
  return (r << 16) | (g << 8) | bl;
}

// ---------- palettes ----------
static const Pal PALS[PAL_COUNT] = {
  {2, {0, 0}},                                                    // 0 Custom (colour 1 <-> colour 2)
  {6, {0xFF0000, 0xFFD000, 0x00FF00, 0x00E0FF, 0x0000FF, 0xFF00C0}}, // 1 Rainbow
  {4, {0xE00000, 0x008A00, 0xFFFFFF, 0x008A00}},                  // 2 Christmas
  {4, {0x001850, 0x0060FF, 0x80E0FF, 0xFFFFFF}},                  // 3 Ice
  {4, {0x400000, 0xFF2000, 0xFFA000, 0xFFF080}},                  // 4 Fire
  {4, {0xFF0000, 0xFF0000, 0xFFFFFF, 0xFFFFFF}},                  // 5 Candy cane
  {3, {0xFF8A18, 0xFFC850, 0xFF5A00}},                            // 6 Warm gold
  {5, {0x00FF60, 0x00A0FF, 0x7000FF, 0x00FFC0, 0x0040A0}},        // 7 Aurora
};

static inline uint32_t palColor(const Pal &cur, uint8_t idx) {
  uint16_t pos = (uint16_t)idx * cur.n;        // 8.8 fixed
  uint8_t k = pos >> 8, f = pos & 0xFF;
  uint8_t k2 = (k + 1) % cur.n;
  return mix(cur.c[k], cur.c[k2], f);
}

static inline uint32_t heatColor(uint8_t heat) {
  uint32_t r = heat * 3; if (r > 255) r = 255;
  uint32_t g = heat > 85 ? (heat - 85) * 3 : 0; if (g > 255) g = 255;
  uint32_t b = heat > 170 ? (heat - 170) * 3 : 0; if (b > 255) b = 255;
  return (r << 16) | (g << 8) | b;
}

// Unit vectors (Q12) that the "Sweep" plane travels along.
static const int16_t DIRS[][3] = {
  {4096, 0, 0}, {-4096, 0, 0}, {0, 4096, 0}, {0, -4096, 0}, {0, 0, 4096}, {0, 0, -4096},
  {2896, 2896, 0}, {-2896, 2896, 0}, {2896, -2896, 0}, {-2896, -2896, 0},
  {0, 2896, 2896}, {0, -2896, 2896}, {2896, 0, 2896}, {-2896, 0, 2896},
};

void fxPrepare(FxCtx &c, const FxParams &p, uint64_t ms) {
  // 64-bit product so every controller computes the identical phase from the
  // same time, then truncate: every effect is periodic in 2^16 of phase.
  c.ph = (uint32_t)((ms * (uint64_t)p.rate) >> 8);
  c.fx = p.fx; c.scl = p.scl; c.bri = p.bri; c.c1 = p.c1; c.c2 = p.c2;
  c.dark = false;
  c.frameMode = FRAME_YARD;

  uint8_t pi = p.pal < PAL_COUNT ? p.pal : 1;
  c.pal = PALS[pi];
  if (pi == 0) { c.pal.c[0] = p.c1; c.pal.c[1] = p.c2; }

  uint32_t pass = c.ph >> 16;
  const int16_t *d = DIRS[hash32(pass) % (sizeof(DIRS) / sizeof(DIRS[0]))];
  c.swDx = d[0]; c.swDy = d[1]; c.swDz = d[2];
  c.swPos = (int32_t)(((c.ph & 0xFFFF) * 7000U) >> 16) - 3500;
  c.swCol = palColor(c.pal, hash32(pass * 7 + 1) & 0xFF);

  // Direction of travel, or the effect's own default, plus two unit vectors across it.
  c.hasDir = p.hasDir && (p.dx || p.dy || p.dz);
  if (c.hasDir) { c.dx = p.dx; c.dy = p.dy; c.dz = p.dz; }
  else if (p.fx == 15) { c.dx = 0; c.dy = -4096; c.dz = 0; }      // meteors fall
  else if (p.fx == 18) { c.dx = 4096; c.dy = 0; c.dz = 0; }       // clouds drift to the right
  else if (p.fx >= FX_FIRST_VIEW) { c.dx = 0; c.dy = 0; c.dz = -4096; }   // camera: from the street
  else { c.dx = 0; c.dy = 4096; c.dz = 0; }                        // spin round the vertical
  int32_t ax = 0, ay = 4096, az = 0;
  if (c.dy > 3000 || c.dy < -3000) { ax = 4096; ay = 0; }          // nearly vertical: use X as the helper
  int32_t ux = (c.dy * az - c.dz * ay) >> 12, uy = (c.dz * ax - c.dx * az) >> 12, uz = (c.dx * ay - c.dy * ax) >> 12;
  int32_t len = (int32_t)isqrt32((uint32_t)(ux * ux + uy * uy + uz * uz));
  if (len < 1) len = 1;
  c.ux = ux * 4096 / len; c.uy = uy * 4096 / len; c.uz = uz * 4096 / len;
  c.vx = (c.dy * c.uz - c.dz * c.uy) >> 12; c.vy = (c.dz * c.ux - c.dx * c.uz) >> 12; c.vz = (c.dx * c.uy - c.dy * c.ux) >> 12;

  // Camera for 2D effects: looking along d; right = d x up, picture up = right x d. Looking (nearly)
  // straight down or up, "up" in the picture is away from the street.
  {
    int32_t hx = 0, hy = 4096, hz = 0;
    if (c.dy > 3900 || c.dy < -3900) { hy = 0; hz = -4096; }
    int32_t rx = (c.dy * hz - c.dz * hy) >> 12, ry = (c.dz * hx - c.dx * hz) >> 12, rz = (c.dx * hy - c.dy * hx) >> 12;
    int32_t rl = (int32_t)isqrt32((uint32_t)(rx * rx + ry * ry + rz * rz));
    if (rl < 1) rl = 1;
    c.rx = rx * 4096 / rl; c.ry = ry * 4096 / rl; c.rz = rz * 4096 / rl;
    c.qx = (c.ry * c.dz - c.rz * c.dy) >> 12; c.qy = (c.rz * c.dx - c.rx * c.dz) >> 12; c.qz = (c.rx * c.dy - c.ry * c.dx) >> 12;
  }

  // Clouds: drift so far, in 1/256 cell units, wrapped to the 1024-cell lattice.
  uint32_t q = c.ph >> 7;
  c.cfx = (int32_t)(((int64_t)c.dx * q) >> 12) & 0x3FFFF;
  c.cfy = (int32_t)(((int64_t)c.dy * q) >> 12) & 0x3FFFF;
  c.cfz = (int32_t)(((int64_t)c.dz * q) >> 12) & 0x3FFFF;

  // Ripple: a new random centre (and colour) every cycle.
  uint32_t hr = hash32(pass * 2654435761U + 17);
  c.rcx = (int32_t)(hr & 0x7FF) - 1024;
  c.rcy = (int32_t)((hr >> 11) & 0x7FF) - 1024;
  c.rcz = (int32_t)((hr >> 22) & 0x3FF) * 2 - 1024;
  c.rcol = palColor(c.pal, (uint8_t)(hash32(pass + 99) >> 24));

  // Flash: bright at the start of each cycle, then decays; faster decay with higher scale.
  uint32_t v = (65535U - (c.ph & 0xFFFF)) >> 8;
  for (int k = 0; k < 1 + p.scl / 64; k++) v = (v * v) >> 8;
  c.flash = dim(palColor(c.pal, (uint8_t)(pass * 40U)), (uint8_t)v);
}

uint32_t fxPixel(const FxCtx &c, const Geo &src, uint32_t gi) {
  Geo g = src;
  if (c.frameMode == FRAME_EACH) {
    fitXYZ(g, src, zoneFrames[src.zone < MAX_ZONES ? src.zone : 0]);   // height/angle are already per plant
  } else if (c.frameMode == FRAME_GROUP) {
    fitXYZ(g, src, c.group);
    fitPlant(g, src, c.group);
  }
  const uint8_t scl = c.scl;
  const uint32_t ph = c.ph;
  switch (c.fx) {
    default:
    case 0:   // Solid
      return c.c1;

    case 1: { // Gradient: palette scrolling up each plant, or along the chosen direction
      if (c.hasDir) {
        int32_t d = ((g.x * c.dx + g.y * c.dy + g.z * c.dz) >> 12) + 4096;
        return palColor(c.pal, (uint8_t)(((uint32_t)d * (1 + scl / 32) >> 5) - (ph >> 8)));
      }
      uint32_t v = (uint32_t)g.h * (1 + scl / 32);
      return palColor(c.pal, (uint8_t)((v >> 8) - (ph >> 8)));
    }
    case 2: { // Spiral: palette wound around each plant
      uint32_t turns = 1 + scl / 43;
      uint16_t v = (uint16_t)(g.ang + g.h * turns - ph);
      return palColor(c.pal, v >> 8);
    }
    case 3: { // Stripes: barber pole in colour 1 / colour 2
      uint32_t turns = 1 + scl / 43;
      uint16_t v = (uint16_t)(g.ang * 2U + g.h * turns - ph);
      int16_t w = (int16_t)wave8(v) - 96;
      int16_t t = w * 4; if (t < 0) t = 0; if (t > 255) t = 255;
      return mix(c.c2, c.c1, (uint8_t)t);
    }
    case 4: { // Sweep: a plane of light passes through, in the chosen direction or a new one each time
      int32_t d = c.hasDir ? (g.x * c.dx + g.y * c.dy + g.z * c.dz) >> 12
                           : (g.x * c.swDx + g.y * c.swDy + g.z * c.swDz) >> 12;
      int32_t dist = d - c.swPos; if (dist < 0) dist = -dist;
      int32_t w = 150 + scl * 4;
      if (dist >= w) return 0;
      uint32_t b = 255U * (uint32_t)(w - dist) / (uint32_t)w;
      return dim(c.swCol, (uint8_t)((b * b) >> 8));
    }
    case 5: { // Rings: bands rising up each plant, or travelling along the chosen direction
      if (c.hasDir) {
        int32_t d = ((g.x * c.dx + g.y * c.dy + g.z * c.dz) >> 12) + 4096;
        uint16_t v = (uint16_t)((uint32_t)d * 9U * (1 + scl / 32) - ph);
        return dim(palColor(c.pal, (uint8_t)((d >> 5) + (ph >> 10))), pulse8(v));
      }
      uint16_t v = (uint16_t)((uint32_t)g.h * (1 + scl / 32) - ph);
      return dim(palColor(c.pal, (uint8_t)((g.h >> 8) + (ph >> 10))), pulse8(v));
    }
    case 6: { // Beam: lighthouse beam rotating around each plant
      int16_t da = (int16_t)(uint16_t)(g.ang - (uint16_t)ph);
      int32_t a = da < 0 ? -(int32_t)da : da;
      int32_t w = 2000 + scl * 60;
      if (a >= w) return 0;
      uint32_t b = 255U * (uint32_t)(w - a) / (uint32_t)w;
      return dim(palColor(c.pal, g.h >> 8), (uint8_t)b);
    }
    case 7: { // Pulse: colour shells expanding from the centre of the yard
      uint16_t v = (uint16_t)((uint32_t)g.d3 * (1 + scl / 64) - ph);
      return palColor(c.pal, v >> 8);
    }
    case 8: { // Twinkle: independent slow sparkles
      uint32_t r = hash32(gi + 1);
      if ((r >> 24) > scl) return 0;
      uint16_t p = (uint16_t)(ph * (1 + (r & 3)) + (r >> 8));
      return dim(palColor(c.pal, (r >> 16) & 0xFF), pulse8(p));
    }
    case 9: { // Glitter: dim palette wash with white flashes
      uint32_t base = dim(palColor(c.pal, (uint8_t)((g.h >> 8) + (ph >> 10))), 90);
      uint32_t r = hash32((gi + 1) * 2654435761U ^ (ph >> 12));
      if ((r & 0xFF) < (uint32_t)(3 + scl / 10)) return 0xFFFFFF;
      return base;
    }
    case 10: { // Plasma: 3D interference pattern (drifting along the chosen direction)
      int32_t f = 4 + scl / 8;
      if (c.hasDir) {
        int32_t s = (int32_t)((ph & 0x1FFFF) / (uint32_t)f);   // drifts one period per cycle; wraps seamlessly
        int32_t x = g.x - ((c.dx * s) >> 12), y = g.y - ((c.dy * s) >> 12), z = g.z - ((c.dz * s) >> 12);
        int32_t v = isin((uint16_t)(x * f)) + isin((uint16_t)(y * f)) + isin((uint16_t)(z * f))
                  + isin((uint16_t)((x + y + z) * f / 2));
        return palColor(c.pal, (uint8_t)(((v / 4 + 32768) >> 8) + (ph >> 11)));
      }
      int32_t v = isin((uint16_t)(g.x * f + ph))
                + isin((uint16_t)(g.y * f - ph))
                + isin((uint16_t)(g.z * f + (ph >> 1)));
      return palColor(c.pal, (uint8_t)(((v / 3 + 32768) >> 8) + (ph >> 9)));
    }
    case 11: { // Fire: hot at the base, flickering upwards
      int32_t heat = 330 - (int32_t)(g.h >> 8) - (255 - scl) / 2
                   + (isin((uint16_t)(g.ang * 3U + ph * 2U)) >> 9)
                   + (isin((uint16_t)(g.h * 4U - ph * 3U)) >> 9);
      if (heat < 0) heat = 0;
      if (heat > 255) heat = 255;
      return heatColor((uint8_t)heat);
    }
    case 12: { // Snow: flakes of colour 1 falling over a colour 2 background
      uint32_t col = g.ang >> 12;
      uint32_t r = hash32(col * 31 + 7);
      uint16_t fh = (uint16_t)(65535U - (uint16_t)(ph * (2 + (r & 1)) + (r >> 4)));
      int32_t d = (int32_t)g.h - (int32_t)fh; if (d < 0) d = -d;
      int32_t w = 3000 + scl * 20;
      uint32_t bg = dim(c.c2, 40);
      if (d >= w) return bg;
      return addc(bg, dim(c.c1, (uint8_t)(255U * (uint32_t)(w - d) / (uint32_t)w)));
    }
    case 13: { // Chase: comets running along the wire (needs no 3D map)
      uint32_t step = 2 + scl / 16;
      uint8_t p = (uint8_t)((ph >> 7) - gi * step);
      return dim(palColor(c.pal, (uint8_t)(gi + (ph >> 10))), (uint8_t)(((uint16_t)p * p) >> 8));
    }
    case 14:  // Flash: everything flashes at the start of each cycle (each beat in a show) and fades
      return c.flash;

    case 15: { // Meteor: streaks with fading tails flying along the direction, in lanes across it
      int32_t d = (g.x * c.dx + g.y * c.dy + g.z * c.dz) >> 12;
      int32_t pu = ((g.x * c.ux + g.y * c.uy + g.z * c.uz) >> 12) + 8192;
      int32_t pv = ((g.x * c.vx + g.y * c.vy + g.z * c.vz) >> 12) + 8192;
      int32_t cell = 120 + scl * 4;
      uint32_t lane = hash32((uint32_t)(pu / cell) * 73856093U ^ (uint32_t)(pv / cell) * 19349663U);
      int32_t head = (int32_t)((((ph >> 0) + (lane & 0xFFFF)) & 0xFFFF) * 8000U >> 16) - 4000;
      int32_t behind = head - d, tail = 1500;
      if (behind < 0 || behind > tail) return 0;
      uint32_t b = 255U * (uint32_t)(tail - behind) / (uint32_t)tail;
      uint32_t col = palColor(c.pal, (uint8_t)(lane >> 24));
      if (behind < 100) col = mix(col, 0xFFFFFF, 160);          // hot white head
      return dim(col, (uint8_t)((b * b) >> 8));
    }
    case 16: { // Ripple: a shell of light bursts out from a random point each cycle
      int32_t ex = clamp16(g.x - c.rcx), ey = clamp16(g.y - c.rcy), ez = clamp16(g.z - c.rcz);
      int32_t dist = (int32_t)isqrt32((uint32_t)(ex * ex) + (uint32_t)(ey * ey) + (uint32_t)(ez * ez));
      int32_t r = (int32_t)(((ph & 0xFFFF) * 3600U) >> 16);
      int32_t w = 120 + scl * 3, off = dist - r;
      if (off < 0) off = -off;
      if (off >= w) return 0;
      uint32_t b = 255U * (uint32_t)(w - off) / (uint32_t)w;
      uint32_t fade = (65535U - (ph & 0xFFFF)) >> 8;            // fades as it grows
      return dim(c.rcol, (uint8_t)(((b * b) >> 8) * fade >> 8));
    }
    case 17: { // Spin: palette helix turning around the direction (vertical by default)
      int32_t d = ((g.x * c.dx + g.y * c.dy + g.z * c.dz) >> 12) + 4096;
      int32_t pu = (g.x * c.ux + g.y * c.uy + g.z * c.uz) >> 12;
      int32_t pv = (g.x * c.vx + g.y * c.vy + g.z * c.vz) >> 12;
      uint16_t a = iatan2(pv, pu);
      uint32_t twist = (uint32_t)d * (1 + scl / 43) * 9U;
      return palColor(c.pal, (uint8_t)((uint16_t)(a + twist - ph) >> 8));
    }
    case 18: { // Clouds: soft 3D noise drifting along the direction (two cells per cycle)
      int32_t cell = 1700 - scl * 5;
      int32_t X = (g.x + 4096) * 256 / cell - c.cfx + 0x40000;   // 1/256 cell units, lattice wraps at 1024
      int32_t Y = (g.y + 4096) * 256 / cell - c.cfy + 0x40000;
      int32_t Z = (g.z + 4096) * 256 / cell - c.cfz + 0x40000;
      int32_t ix = (X >> 8) & 1023, iy = (Y >> 8) & 1023, iz = (Z >> 8) & 1023;
      int32_t fx = X & 255, fy = Y & 255, fz = Z & 255;
      auto corner = [&](int32_t a, int32_t b2, int32_t c3) -> int32_t {
        return (int32_t)(hash32((uint32_t)(a & 1023) * 73856093U ^ (uint32_t)(b2 & 1023) * 19349663U ^ (uint32_t)(c3 & 1023) * 83492791U) >> 24);
      };
      auto lerp = [](int32_t a, int32_t b2, int32_t t) { return a + (((b2 - a) * t) >> 8); };
      int32_t n = lerp(lerp(lerp(corner(ix, iy, iz), corner(ix + 1, iy, iz), fx),
                            lerp(corner(ix, iy + 1, iz), corner(ix + 1, iy + 1, iz), fx), fy),
                       lerp(lerp(corner(ix, iy, iz + 1), corner(ix + 1, iy, iz + 1), fx),
                            lerp(corner(ix, iy + 1, iz + 1), corner(ix + 1, iy + 1, iz + 1), fx), fy), fz);
      int32_t b = (n - 70) * 2;
      if (b <= 0) return 0;
      if (b > 255) b = 255;
      return dim(palColor(c.pal, (uint8_t)(n + (ph >> 12))), (uint8_t)b);
    }

    // ---- 2D pictures, seen from the camera (a = across, b = up in the picture, about +-2048) ----
    case 19: { // Bars: coloured bars sliding across the picture
      int32_t a = clamp16((g.x * c.rx + g.y * c.ry + g.z * c.rz) >> 12);
      uint32_t n = 1 + scl / 32;                                   // 1..8 bars across
      uint32_t v = (uint32_t)(a + 4096) * n * 16 - ph;
      return dim(palColor(c.pal, (uint8_t)((v >> 16) * 53)), (uint8_t)(48 + (pulse8((uint16_t)v) * 207 >> 8)));
    }
    case 20: { // Wave: a sine wave travelling across the picture
      int32_t a = clamp16((g.x * c.rx + g.y * c.ry + g.z * c.rz) >> 12);
      int32_t b = clamp16((g.x * c.qx + g.y * c.qy + g.z * c.qz) >> 12);
      int32_t y = isin((uint16_t)(a * 24 - ph)) / 24;              // amplitude ~1365
      int32_t w = 120 + scl * 3, off = b - y;
      if (off < 0) off = -off;
      if (off >= w) return 0;
      uint32_t k = 255U * (uint32_t)(w - off) / (uint32_t)w;
      return dim(palColor(c.pal, (uint8_t)((a >> 4) + (ph >> 9))), (uint8_t)((k * k) >> 8));
    }
    case 21: { // Radar: a beam sweeping round the middle of the picture, with a fading trail
      int32_t a = clamp16((g.x * c.rx + g.y * c.ry + g.z * c.rz) >> 12);
      int32_t b = clamp16((g.x * c.qx + g.y * c.qy + g.z * c.qz) >> 12);
      uint16_t ang = iatan2(b, a);
      uint16_t behind = (uint16_t)((uint16_t)ph - ang);
      uint32_t trail = 6000 + scl * 160U;
      if (behind >= trail) return 0;
      uint32_t k = 255U * (trail - behind) / trail;
      int32_t r = (int32_t)isqrt32((uint32_t)(a * a) + (uint32_t)(b * b));
      uint32_t col = palColor(c.pal, (uint8_t)(r >> 4));
      if (behind < 900) col = mix(col, 0xFFFFFF, 120);
      return dim(col, (uint8_t)((k * k) >> 8));
    }
    case 22: { // Tunnel: rings flying out from the middle of the picture
      int32_t a = clamp16((g.x * c.rx + g.y * c.ry + g.z * c.rz) >> 12);
      int32_t b = clamp16((g.x * c.qx + g.y * c.qy + g.z * c.qz) >> 12);
      uint32_t r = isqrt32((uint32_t)(a * a) + (uint32_t)(b * b));
      uint16_t ang = iatan2(b, a);
      uint16_t v = (uint16_t)(r * (1 + scl / 32) * 12 - ph);
      return dim(palColor(c.pal, (uint8_t)((v >> 8) + (ang >> 11))), (uint8_t)(40 + (pulse8(v) * 215 >> 8)));
    }
    case 23: { // Checker: two colours in a checkerboard drifting diagonally
      int32_t a = clamp16((g.x * c.rx + g.y * c.ry + g.z * c.rz) >> 12);
      int32_t b = clamp16((g.x * c.qx + g.y * c.qy + g.z * c.qz) >> 12);
      int32_t size = 150 + scl * 5;
      int32_t off = (int32_t)(((ph & 0xFFFF) * (uint32_t)(2 * size)) >> 16);   // two squares per cycle
      int32_t x = a + 65536 + off, y = b + 65536 + off;
      return ((x / size + y / size) & 1) ? c.c1 : c.c2;
    }
  }
}

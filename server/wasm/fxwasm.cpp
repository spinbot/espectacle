// ESPectacle - the firmware's effects compiled to WebAssembly, so the website previews
// built-in effects exactly as the controllers render them (same source: firmware/src/effects.cpp).
#include "effects.h"

#define WASM_EXPORT(name) extern "C" __attribute__((export_name(#name)))

static const int MAX_PREVIEW_LEDS = 20000;
static Geo     geoBuf[MAX_PREVIEW_LEDS];
static uint8_t outBuf[MAX_PREVIEW_LEDS * 3];
static Frame   groupFrame;

extern "C" void *memset(void *d, int c, size_t n) {
  uint8_t *p = (uint8_t *)d;
  while (n--) *p++ = (uint8_t)c;
  return d;
}
extern "C" void *memcpy(void *d, const void *s, size_t n) {
  uint8_t *p = (uint8_t *)d;
  const uint8_t *q = (const uint8_t *)s;
  while (n--) *p++ = *q++;
  return d;
}

WASM_EXPORT(fx_init) void fx_init() { fxInit(); }
WASM_EXPORT(geo_ptr) Geo *geo_ptr() { return geoBuf; }
WASM_EXPORT(out_ptr) uint8_t *out_ptr() { return outBuf; }
WASM_EXPORT(zone_frames_ptr) Frame *zone_frames_ptr() { return zoneFrames; }
WASM_EXPORT(group_frame_ptr) Frame *group_frame_ptr() { return &groupFrame; }
WASM_EXPORT(max_leds) int max_leds() { return MAX_PREVIEW_LEDS; }
WASM_EXPORT(geo_size) int geo_size() { return (int)sizeof(Geo); }

// Renders `n` LEDs (geometry already in geoBuf) to RGB bytes in outBuf, before the controller's
// gamma correction and master brightness. `ms` is the effect's clock (time since its phase zero),
// `base` the global index of the first LED (used by twinkle/glitter/chase), `mode` a FRAME_* value.
WASM_EXPORT(render)
void render(int n, int fx, int pal, int bri, int scl, int rate, uint32_t c1, uint32_t c2,
            double ms, int base, int mode, int hasDir, int dx, int dy, int dz) {
  if (n > MAX_PREVIEW_LEDS) n = MAX_PREVIEW_LEDS;
  FxParams p = {(uint8_t)fx, (uint8_t)pal, (uint8_t)bri, (uint8_t)scl, (uint16_t)rate, c1, c2,
                (int16_t)dx, (int16_t)dy, (int16_t)dz, (uint8_t)(hasDir ? 1 : 0)};
  FxCtx c;
  fxPrepare(c, p, (uint64_t)ms);
  c.frameMode = (uint8_t)mode;
  c.group = groupFrame;
  uint8_t *o = outBuf;
  for (int i = 0; i < n; i++) {
    uint32_t col = fxPixel(c, geoBuf[i], (uint32_t)(base + i));
    if (c.bri != 255) {   // per-clip brightness, exactly as leds.cpp applies it
      uint16_t s = (uint16_t)c.bri + 1;
      col = ((((col >> 16) & 0xFF) * s >> 8) << 16) | ((((col >> 8) & 0xFF) * s >> 8) << 8) | ((col & 0xFF) * s >> 8);
    }
    *o++ = (col >> 16) & 0xFF; *o++ = (col >> 8) & 0xFF; *o++ = col & 0xFF;
  }
}

// ---------- shows: every zone (plant) gets its own effect, as leds.cpp renderFrame does ----------
// Per zone, 20 ints: active, fx, pal, bri, scl, rate, c1, c2, mode, group frame (7 values), hasDir, dx, dy, dz;
// plus the zone's effect clock in ms (time since its clip's phase zero).
static int32_t zoneIn[MAX_ZONES * 20];
static double  zoneMs[MAX_ZONES];
static FxCtx   zoneCtx[MAX_ZONES];

WASM_EXPORT(zone_in_ptr) int32_t *zone_in_ptr() { return zoneIn; }
WASM_EXPORT(zone_ms_ptr) double *zone_ms_ptr() { return zoneMs; }

// Renders `n` LEDs from geoBuf using each LED's zone. Inactive zones are dark (a gap in the show).
WASM_EXPORT(render_zones)
void render_zones(int n, int base) {
  if (n > MAX_PREVIEW_LEDS) n = MAX_PREVIEW_LEDS;
  for (int z = 0; z < MAX_ZONES; z++) {
    const int32_t *v = &zoneIn[z * 20];
    zoneCtx[z].dark = true;
    if (!v[0]) continue;
    FxParams p = {(uint8_t)v[1], (uint8_t)v[2], (uint8_t)v[3], (uint8_t)v[4], (uint16_t)v[5], (uint32_t)v[6], (uint32_t)v[7],
                  (int16_t)v[17], (int16_t)v[18], (int16_t)v[19], (uint8_t)(v[16] ? 1 : 0)};
    fxPrepare(zoneCtx[z], p, (uint64_t)(zoneMs[z] < 0 ? 0 : zoneMs[z]));
    zoneCtx[z].frameMode = (uint8_t)v[8];
    zoneCtx[z].group = {(int16_t)v[9], (int16_t)v[10], (int16_t)v[11], (int16_t)v[12], (int16_t)v[13], (int16_t)v[14], (int16_t)v[15]};
  }
  uint8_t *o = outBuf;
  for (int i = 0; i < n; i++) {
    const Geo &g = geoBuf[i];
    const FxCtx &c = zoneCtx[g.zone < MAX_ZONES ? g.zone : 0];
    uint32_t col = 0;
    if (!c.dark) {
      col = fxPixel(c, g, (uint32_t)(base + i));
      if (c.bri != 255) {
        uint16_t s = (uint16_t)c.bri + 1;
        col = ((((col >> 16) & 0xFF) * s >> 8) << 16) | ((((col >> 8) & 0xFF) * s >> 8) << 8) | ((col & 0xFF) * s >> 8);
      }
    }
    *o++ = (col >> 16) & 0xFF; *o++ = (col >> 8) & 0xFF; *o++ = col & 0xFF;
  }
}

// Speed slider value (0..255) -> rate, as the controller converts it.
WASM_EXPORT(rate_from_speed) int rate_from_speed(int spd) { return fxRateFromSpeed((uint8_t)spd); }

// ESPectacle - 3D effects. All per-pixel maths is integer only: the ESP32-S2
// has no FPU, so floating point per LED per frame would be far too slow.
#pragma once
#include <Arduino.h>
#include "settings.h"

// Geometry for one LED, computed by the app and uploaded ready to use.
// x/y/z place the LED in the whole installation ("yard"); h/ang/rad are
// relative to the plant the LED is on, so spirals wrap each plant.
struct Geo {
  int16_t  x, y, z;  // yard position, centred; +-2048 == the largest half-extent. Y up.
  uint16_t h;        // height on its plant, 0..65535 (base..top)
  uint16_t ang;      // angle around its plant's axis, 0..65535 == 0..360 deg
  uint16_t rad;      // distance from its plant's axis, 0..65535 == 0..plant radius
  uint16_t d3;       // distance from the yard centre, 0..65535
  uint8_t  zone;     // which plant the LED is on (0..MAX_ZONES-1), for per-plant show tracks
  uint8_t  pad;
};

#define FX_COUNT  24
#define FX_FIRST_VIEW 19   // effects 19.. are 2D pictures seen from a camera (dir = where it looks)
// Online effects (marquee, video...): drawn by the ESPectacle server and streamed with DDP to
// destination 2 (the "online layer"); LEDs whose effect is one of these show that layer.
#define FX_ONLINE_FIRST 200
#define FX_ONLINE_LAST  209
inline bool fxIsOnline(uint8_t fx) { return fx >= FX_ONLINE_FIRST && fx <= FX_ONLINE_LAST; }
inline uint8_t fxClamp(int fx) { return (fx >= FX_ONLINE_FIRST && fx <= FX_ONLINE_LAST) ? fx : (fx < 0 ? 0 : fx >= FX_COUNT ? FX_COUNT - 1 : fx); }
#define PAL_COUNT 8
#define MAX_ZONES 32

struct Pal { uint8_t n; uint32_t c[8]; };

// A box in yard space (Q12 units, the same as Geo x/y/z) that an effect can be fitted to:
// a single plant, or a group of plants treated as one. Sent by the app.
struct Frame {
  int16_t cx, cy, cz;    // centre
  int16_t half;          // half the largest extent
  int16_t ymin, height;  // bottom and height (for "up the plant" effects)
  int16_t radius;        // furthest distance from the vertical axis through the centre
};

// How an effect uses positions:
#define FRAME_YARD     0   // as uploaded: x/y/z across the yard, height/angle per plant (Lights tab)
#define FRAME_EACH     1   // every plant animates on its own, as if it were alone
#define FRAME_GROUP    2   // the plants in the group animate as if they were one big plant

extern Frame zoneFrames[MAX_ZONES];   // one per plant, from the last geometry upload

// What to show: one effect with its settings.
struct FxParams {
  uint8_t  fx, pal, bri, scl;
  uint16_t rate;     // animation speed: one cycle takes 16777216 / rate milliseconds
  uint32_t c1, c2;   // 0xRRGGBB
  int16_t  dx, dy, dz;   // direction of travel (unit vector, 4096 == 1) for moving effects
  uint8_t  hasDir;       // 0: each effect's own default direction
};

// Per-frame working values for one FxParams. Prepared once per frame, used for every LED.
struct FxCtx {
  uint32_t ph;       // animation phase: 65536 == one cycle
  Pal      pal;
  int32_t  swDx, swDy, swDz, swPos;
  uint32_t swCol, flash, c1, c2;
  uint8_t  fx, scl, bri;
  bool     dark;     // nothing to show (e.g. a gap in a show track)
  uint8_t  frameMode;    // FRAME_*
  Frame    group;        // for FRAME_GROUP
  bool     hasDir;
  int32_t  dx, dy, dz;   // direction of travel (Q12 unit vector)
  int32_t  ux, uy, uz;   // two unit vectors across the direction (for meteor lanes, spin angle)
  int32_t  vx, vy, vz;
  int32_t  rcx, rcy, rcz;  // ripple: this cycle's centre
  uint32_t rcol;           // ripple colour of this cycle
  int32_t  cfx, cfy, cfz;  // clouds: drift so far
  int32_t  rx, ry, rz;     // camera (2D effects): the picture's right and up, Q12 unit vectors
  int32_t  qx, qy, qz;
};

inline uint16_t fxRateFromSpeed(uint8_t spd) { return (uint16_t)((spd + 1) * 32); }

void     fxInit();
void     fxPrepare(FxCtx &c, const FxParams &p, uint64_t ms);   // ms: time since the effect's phase zero
uint32_t fxPixel(const FxCtx &c, const Geo &g, uint32_t globalIdx); // returns 0xRRGGBB

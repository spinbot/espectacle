#include "show.h"
#include "settings.h"
#include <esp_heap_caps.h>

static ShowSeg *segs = nullptr;
static uint16_t count = 0, received = 0;
static uint32_t id = 0;
static bool     ready = false;
static bool     playing = false;
static int64_t  startUp = 0;
static uint32_t lengthMs = 0;
static uint16_t zoneFirst[MAX_ZONES], zoneEnd[MAX_ZONES], cursor[MAX_ZONES];
static int64_t  lastT = -1;
static bool     blackout = false;

void showClear() {
  free(segs);
  segs = nullptr;
  count = received = 0;
  id = 0;
  ready = playing = false;
  lengthMs = 0;
}

size_t showMaxSegments() {
  // Keep a healthy margin for WiFi and the web server.
  // Boards with PSRAM keep shows there; otherwise leave a healthy margin for WiFi and the web server.
  size_t spi = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  if (spi > 100000) {
    size_t n = (spi - 50000) / sizeof(ShowSeg);
    return n > 65535 ? 65535 : n;
  }
  size_t freeBytes = ESP.getFreeHeap() + (segs ? (size_t)count * sizeof(ShowSeg) : 0);
  return freeBytes > 40000 ? (freeBytes - 40000) / sizeof(ShowSeg) : 0;
}

bool showBegin(uint32_t newId, uint16_t n) {
  showClear();
  if (n == 0 || n > showMaxSegments()) return false;
  segs = (ShowSeg *)heap_caps_malloc((size_t)n * sizeof(ShowSeg), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!segs) segs = (ShowSeg *)malloc((size_t)n * sizeof(ShowSeg));
  if (!segs) return false;
  count = n;
  id = newId;
  return true;
}

bool showAdd(uint16_t idx, const ShowSeg &s) {
  if (!segs || idx >= count || idx != received) return false;   // chunks must arrive in order
  if (s.zone >= MAX_ZONES || s.t1 <= s.t0 || s.p0 > s.t0) return false;
  if (idx > 0) {
    const ShowSeg &p = segs[idx - 1];
    // Sorted by zone, then time, without overlaps inside a zone.
    if (s.zone < p.zone || (s.zone == p.zone && s.t0 < p.t1)) return false;
  }
  segs[idx] = s;
  received++;
  return true;
}

bool showCommit() {
  if (!segs || received != count) { showClear(); return false; }
  for (int z = 0; z < MAX_ZONES; z++) zoneFirst[z] = zoneEnd[z] = 0;
  lengthMs = 0;
  for (uint16_t i = 0; i < count; i++) {
    uint8_t z = segs[i].zone;
    if (zoneEnd[z] == 0) zoneFirst[z] = i;
    zoneEnd[z] = i + 1;
    if (segs[i].t1 > lengthMs) lengthMs = segs[i].t1;
  }
  ready = true;
  return true;
}

void showPlay(int64_t start) {
  if (!ready) return;
  startUp = start;
  lastT = -1;
  playing = true;
  blackout = false;
}

void showStop()          { playing = false; }
void showBlackout(bool on) { blackout = on; }
bool showBlackedOut()    { return blackout; }
bool showPlaying()       { return playing; }
uint32_t showId()        { return ready ? id : 0; }
uint16_t showCount()     { return ready ? count : 0; }
uint32_t showLengthMs()  { return ready ? lengthMs : 0; }

bool showFrame(uint64_t upMs, FxCtx *ctx) {
  int64_t t = (int64_t)upMs - startUp;
  if (t >= (int64_t)lengthMs) { playing = false; blackout = true; return false; }   // ends dark

  if (t < lastT) lastT = -1;            // jumped backwards: search from the start again
  if (lastT < 0) for (int z = 0; z < MAX_ZONES; z++) cursor[z] = zoneFirst[z];
  lastT = t;

  for (int z = 0; z < MAX_ZONES; z++) {
    ctx[z].dark = true;
    if (t < 0 || zoneEnd[z] == 0) continue;     // before the start (lead-in) or nothing for this zone
    uint16_t &k = cursor[z];
    while (k < zoneEnd[z] && (int64_t)segs[k].t1 <= t) k++;
    if (k >= zoneEnd[z] || (int64_t)segs[k].t0 > t) continue;   // gap
    const ShowSeg &s = segs[k];
    FxParams p = {s.fx, s.pal, s.bri, s.scl, s.rate, s.c1, s.c2, s.dx, s.dy, s.dz, s.hasDir};
    fxPrepare(ctx[z], p, (uint64_t)(t - s.p0));  // each clip starts its animation from phase 0
    ctx[z].frameMode = s.frameMode;
    ctx[z].group = s.group;
  }
  return true;
}

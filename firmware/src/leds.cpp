#include "leds.h"
#include "effects.h"
#include "show.h"
#include "ddp.h"
#include <Adafruit_NeoPixel.h>
#include <LittleFS.h>
#include <math.h>

// Strings are sent at the same time, one RMT channel each (the LEDs take ~30 us each to send, so with
// several strings this is what sets the frame rate). Build with -DESPECTACLE_SERIAL_OUTPUT to send them one
// after another through Adafruit_NeoPixel instead.
#if defined(ESP_PLATFORM) && !defined(ESPECTACLE_SERIAL_OUTPUT)
#define PARALLEL_OUTPUT 1
#include "driver/rmt.h"
#include "soc/soc_caps.h"
#endif

#define FRAME_MS        16      // ~60 fps target (fewer when the strings take longer than this to send)
#define SCAN_TIMEOUT_MS 600000  // leave scan mode if the app goes quiet for 10 minutes
#define POS_MAGIC       0x34474C54UL   // "TLG4"

struct PosHeader {
  uint32_t magic;
  uint16_t count;
  uint16_t reserved;
  uint32_t baseIndex;
  uint32_t geoId;
};

static Adafruit_NeoPixel *strips[MAX_STRINGS];
static bool      isRgbw[MAX_STRINGS];
static uint16_t  total = 0;
static Geo      *geo = nullptr;
static uint8_t  *fb = nullptr;         // total * 3, RGB after gamma
static bool      mapped = false;
static uint32_t  baseIdx = 0;
static uint32_t  geoId = 0;
static FxCtx     zoneCtx[MAX_ZONES];

static uint8_t   lut[256];
static int       lutBri = -1;
static uint32_t  lastFrame = 0;
static bool      darkShown = false;

static bool      scanning = false;
static uint32_t  scanLast = 0;
static int       soloString = -1, soloIndex = -1;
static uint32_t  identifyUntil = 0;

// Adafruit_NeoPixel's type is the byte position of each colour: (W << 6) | (R << 4) | (G << 2) | B, with
// W = R for 3-channel strips (that's how NEO_GRB, NEO_WBRG... are defined), so any order can be built.
static neoPixelType orderType(const char *o) {
  if (!validOrder(o)) return NEO_GRB;
  auto at = [&](char c) { return (neoPixelType)(strchr(o, c) - o); };
  neoPixelType r = at('R'), g = at('G'), b = at('B'), w = strlen(o) == 4 ? at('W') : r;
  return (w << 6) | (r << 4) | (g << 2) | b;
}

#ifdef PARALLEL_OUTPUT
#ifdef SOC_RMT_TX_CANDIDATES_PER_GROUP
#define TX_CHANNELS SOC_RMT_TX_CANDIDATES_PER_GROUP     // 8 on ESP32, 4 on S2/S3
#else
#define TX_CHANNELS 4
#endif
static rmt_channel_t rmtCh[MAX_STRINGS];
static bool          rmtOn[MAX_STRINGS];
static uint8_t       rmtPin[MAX_STRINGS];
static uint32_t      lastSentUs = 0;
static uint32_t      t0h, t0l, t1h, t1l;                  // WS2812 bit timings in RMT ticks

// Turns pixel bytes into RMT pulses as the channel needs them (called from the RMT interrupt).
static void IRAM_ATTR rmtAdapter(const void *src, rmt_item32_t *dest, size_t srcSize, size_t wanted,
                                 size_t *translated, size_t *items) {
  if (!src || !dest) { *translated = 0; *items = 0; return; }
  rmt_item32_t bit0, bit1;
  bit0.duration0 = t0h; bit0.level0 = 1; bit0.duration1 = t0l; bit0.level1 = 0;
  bit1.duration0 = t1h; bit1.level0 = 1; bit1.duration1 = t1l; bit1.level1 = 0;
  const uint8_t *p = (const uint8_t *)src;
  size_t size = 0, num = 0;
  while (size < srcSize && num < wanted) {
    for (int i = 7; i >= 0; i--) { dest->val = (*p >> i) & 1 ? bit1.val : bit0.val; dest++; }
    num += 8; size++; p++;
  }
  *translated = size; *items = num;
}

static void outputStop() {
  for (int s = 0; s < MAX_STRINGS; s++) {
    if (!rmtOn[s]) continue;
    rmt_wait_tx_done(rmtCh[s], pdMS_TO_TICKS(200));
    rmt_driver_uninstall(rmtCh[s]);
    pinMatrixOutDetach(rmtPin[s], false, false);         // give the pin back, held low
    pinMode(rmtPin[s], OUTPUT);
    digitalWrite(rmtPin[s], LOW);
    rmtOn[s] = false;
  }
}

static void outputStart() {
  int n = cfg.nStrings;
  if (n <= 0) return;
  // Share out the RMT memory: more per string means more tolerance of interrupt delays (WiFi).
  int blocks = TX_CHANNELS / n;
  if (blocks < 1) blocks = 1;
  if (blocks > 4) blocks = 4;
  for (int s = 0; s < n && s < MAX_STRINGS; s++) {
    if (!strips[s]) continue;
    rmt_channel_t ch = (rmt_channel_t)(s * blocks);
    rmt_config_t c;
    memset(&c, 0, sizeof(c));                             // (not RMT_DEFAULT_CONFIG_TX: C designated initialisers)
    c.rmt_mode = RMT_MODE_TX;
    c.channel = ch;
    c.gpio_num = (gpio_num_t)cfg.strings[s].pin;
    c.clk_div = 2;                                        // 40 MHz: 25 ns ticks
    c.mem_block_num = blocks;
    c.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
    c.tx_config.idle_output_en = true;
    if (rmt_config(&c) != ESP_OK || rmt_driver_install(ch, 0, 0) != ESP_OK) continue;
    rmt_translator_init(ch, rmtAdapter);
    if (!t0h) {
      uint32_t hz = 0;
      rmt_get_counter_clock(ch, &hz);
      float r = hz / 1e9f;
      t0h = r * 400; t0l = r * 850; t1h = r * 800; t1l = r * 450;
    }
    rmtCh[s] = ch; rmtPin[s] = cfg.strings[s].pin; rmtOn[s] = true;
  }
}

// Sends the strings in `mask` together and waits until they have all gone.
static void transmit(uint8_t mask) {
  while ((uint32_t)(micros() - lastSentUs) < 300) {}      // latch gap after the previous frame
  bool sent[MAX_STRINGS] = {};
  for (int s = 0; s < MAX_STRINGS; s++) {
    if (!(mask & (1 << s)) || !rmtOn[s] || !strips[s]) continue;
    size_t bytes = (size_t)strips[s]->numPixels() * (isRgbw[s] ? 4 : 3);
    sent[s] = rmt_write_sample(rmtCh[s], strips[s]->getPixels(), bytes, false) == ESP_OK;
  }
  for (int s = 0; s < MAX_STRINGS; s++) if (sent[s]) rmt_wait_tx_done(rmtCh[s], pdMS_TO_TICKS(200));
  lastSentUs = micros();
}
#else
static void outputStop() {}
static void outputStart() {}
static void transmit(uint8_t mask) {
  for (int s = 0; s < MAX_STRINGS; s++) if ((mask & (1 << s)) && strips[s]) strips[s]->show();
}
#endif

static void showAll() { transmit(0xFF); }
static void clearAll() {
  for (int s = 0; s < cfg.nStrings; s++) if (strips[s]) strips[s]->clear();
}

// With no 3D map yet, pretend the wire is wound up a cone so that the
// spatial effects still do something sensible.
static void synthGeo() {
  const float H = 1800.0f, s = 2048.0f / (H * 0.5f);
  const float maxD = sqrtf(550.0f * 550.0f + (H * 0.5f) * (H * 0.5f));
  for (uint16_t i = 0; i < total; i++) {
    float f = total > 1 ? (float)i / (float)(total - 1) : 0;
    float r = 50.0f + (1.0f - f) * 500.0f;
    float a = i * (6.2831853f / 30.0f);
    float x = cosf(a) * r, y = f * H - H * 0.5f, z = sinf(a) * r;
    Geo &g = geo[i];
    g.x = (int16_t)(x * s); g.y = (int16_t)(y * s); g.z = (int16_t)(z * s);
    g.h = (uint16_t)(f * 65535.0f);
    g.ang = (uint16_t)(((uint32_t)i * 65536UL / 30UL) & 0xFFFF);
    g.rad = (uint16_t)(r / 550.0f * 65535.0f);
    g.d3 = (uint16_t)(sqrtf(x * x + y * y + z * z) / maxD * 65535.0f);
    g.zone = 0; g.pad = 0;
  }
  baseIdx = 0;
  geoId = 0;
  mapped = false;
}

static bool loadPositions() {
  File f = LittleFS.open("/pos.bin", "r");
  if (!f) return false;
  PosHeader hd;
  bool ok = f.read((uint8_t *)&hd, sizeof(hd)) == sizeof(hd) && hd.magic == POS_MAGIC && hd.count == total;
  if (ok) {
    size_t n = (size_t)total * sizeof(Geo);
    ok = f.read((uint8_t *)geo, n) == n &&
         f.read((uint8_t *)zoneFrames, sizeof(zoneFrames)) == sizeof(zoneFrames);
  }
  f.close();
  if (!ok) return false;
  baseIdx = hd.baseIndex;
  geoId = hd.geoId;
  mapped = true;
  return true;
}

void ledsBegin() {
  for (int s = 0; s < MAX_STRINGS; s++) if (strips[s]) strips[s]->clear();
  transmit(0xFF);                 // blank the old strings
  outputStop();
  for (int s = 0; s < MAX_STRINGS; s++) { delete strips[s]; strips[s] = nullptr; }
  free(geo); free(fb);
  geo = nullptr; fb = nullptr;

  total = 0;
  for (int s = 0; s < cfg.nStrings; s++) {
    const StringCfg &c = cfg.strings[s];
    isRgbw[s] = strlen(c.order) == 4;
    strips[s] = new Adafruit_NeoPixel(c.count, c.pin, orderType(c.order) + NEO_KHZ800);
    strips[s]->begin();
    strips[s]->clear();
    total += c.count;
  }
  outputStart();
  showAll();
  if (total) {
    geo = (Geo *)calloc(total, sizeof(Geo));
    fb = (uint8_t *)calloc((size_t)total * 3, 1);
    if (!geo || !fb) {            // out of memory: run dark rather than crash
      free(geo); free(fb);
      geo = nullptr; fb = nullptr; total = 0;
    }
  }
  scanning = false; soloString = soloIndex = -1; darkShown = false;
  if (total && !loadPositions()) synthGeo();
}

uint16_t ledsTotal() { return total; }
bool     ledsMapped() { return mapped; }

static void rebuildLut() {
  lutBri = st.bri;
  for (int i = 0; i < 256; i++) {
    float v = powf(i / 255.0f, 2.2f) * st.bri;
    lut[i] = (uint8_t)(v + 0.5f);
  }
}

static void outputFrame(uint32_t sum);

static void renderFrame() {
  if (lutBri != st.bri) rebuildLut();

  // A playing show gives every zone (plant) its own effect; otherwise one effect for all.
  bool show = showPlaying() && showFrame(uptimeMs(), zoneCtx);
  const uint8_t *overlay = ddpOverlay();  // messages from the server: drawn over everything
  bool off = false;
  if (!show) {
    if (!st.on || showBlackedOut()) {
      if (!overlay) {
        if (!darkShown) { clearAll(); showAll(); darkShown = true; }
        return;
      }
      off = true;                           // lights off, but a message is showing
    } else {
      FxParams p = {st.fx, st.pal, 255, st.scl, fxRateFromSpeed(st.spd), st.c1, st.c2, st.dx, st.dy, st.dz, st.hasDir};
      fxPrepare(zoneCtx[0], p, nowMs());
    }
  }
  darkShown = false;

  uint32_t sum = 0;
  uint8_t *p = fb;
  const uint8_t *layer = ddpLayer();      // online effects (streamed by the server)
  for (uint16_t i = 0; i < total; i++) {
    const FxCtx &c = zoneCtx[show && geo[i].zone < MAX_ZONES ? geo[i].zone : 0];
    uint32_t col = 0;
    if (!c.dark && !off) {
      if (fxIsOnline(c.fx)) col = layer ? ((uint32_t)layer[i * 3] << 16) | ((uint32_t)layer[i * 3 + 1] << 8) | layer[i * 3 + 2] : 0;
      else col = fxPixel(c, geo[i], baseIdx + i);
      if (c.bri != 255) {
        uint16_t s = (uint16_t)c.bri + 1;
        col = ((((col >> 16) & 0xFF) * s >> 8) << 16) | ((((col >> 8) & 0xFF) * s >> 8) << 8) | ((col & 0xFF) * s >> 8);
      }
    }
    if (overlay) {                         // black = see-through; anything else replaces the effect
      const uint8_t *o = overlay + i * 3;
      if (o[0] | o[1] | o[2]) col = ((uint32_t)o[0] << 16) | ((uint32_t)o[1] << 8) | o[2];
    }
    uint8_t r = lut[(col >> 16) & 0xFF], g = lut[(col >> 8) & 0xFF], b = lut[col & 0xFF];
    *p++ = r; *p++ = g; *p++ = b;
    sum += r + g + b;
  }

  outputFrame(sum);
}

// Sends `fb` to the strips, dimmed if needed to stay under the current limit.
static void outputFrame(uint32_t sum) {
  // Current limiter: ~20 mA per fully-lit colour channel.
  uint32_t scale = 256;
  if (cfg.maxMilliamps) {
    uint32_t mA = sum * 20 / 255;
    if (mA > cfg.maxMilliamps) scale = (uint32_t)cfg.maxMilliamps * 256 / mA;
  }

  const uint8_t *p = fb;
  for (int s = 0; s < cfg.nStrings; s++) {
    Adafruit_NeoPixel *np = strips[s];
    uint16_t n = cfg.strings[s].count;
    for (uint16_t i = 0; i < n; i++) {
      uint8_t r = (p[0] * scale) >> 8, g = (p[1] * scale) >> 8, b = (p[2] * scale) >> 8;
      p += 3;
      if (isRgbw[s]) {
        uint8_t w = r < g ? (r < b ? r : b) : (g < b ? g : b);
        np->setPixelColor(i, r - w, g - w, b - w, w);
      } else {
        np->setPixelColor(i, r, g, b);
      }
    }
  }
  showAll();
}

static void renderIdentify() {
  static const uint32_t cols[MAX_STRINGS] = {0x400000, 0x004000, 0x000040, 0x303000};
  bool onPhase = ((millis() / 300) & 1) == 0;
  for (int s = 0; s < cfg.nStrings; s++) {
    uint32_t c = onPhase ? cols[s] : 0;
    for (uint16_t i = 0; i < cfg.strings[s].count; i++)
      strips[s]->setPixelColor(i, (c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF);
  }
  showAll();
}

void ledsTick() {
  if (!total) return;
  uint32_t now = millis();

  if (scanning) {
    if (now - scanLast > SCAN_TIMEOUT_MS) scanSet(false);   // app went away
    return;                                                  // pixels only change on command
  }
  if (now - lastFrame < FRAME_MS) return;
  lastFrame = now;

  if (identifyUntil) {
    if ((int32_t)(identifyUntil - now) > 0) { renderIdentify(); darkShown = false; return; }
    identifyUntil = 0;
  }
  if (ddpActive()) return;          // xLights is driving the LEDs
  renderFrame();
}

void ledsShowRealtime(const uint8_t *rgb) {
  if (!total || !fb || scanning) return;
  uint32_t sum = 0;
  uint16_t s = (uint16_t)st.bri + 1;           // master brightness, linear (xLights does its own curves)
  for (size_t i = 0; i < (size_t)total * 3; i++) {
    fb[i] = (uint8_t)((rgb[i] * s) >> 8);
    sum += fb[i];
  }
  darkShown = false;
  outputFrame(sum);
}

// ---------- scan mode ----------
void scanSet(bool on) {
  if (on) showStop();
  scanning = on;
  scanLast = millis();
  soloString = soloIndex = -1;
  darkShown = false;
  if (total) { clearAll(); showAll(); }
}
bool scanActive() { return scanning; }

bool scanSolo(int s, int i, uint8_t v) {
  if (!scanning) scanSet(true);
  scanLast = millis();
  int prevString = soloString;
  if (soloString >= 0 && soloIndex >= 0) strips[soloString]->setPixelColor(soloIndex, 0, 0, 0, 0);
  soloString = soloIndex = -1;

  bool ok = true;
  if (i >= 0) {
    if (s < 0 || s >= cfg.nStrings || i >= cfg.strings[s].count) ok = false;
    else {
      if (isRgbw[s]) strips[s]->setPixelColor(i, 0, 0, 0, v);
      else           strips[s]->setPixelColor(i, v, v, v);
      soloString = s; soloIndex = i;
    }
  }
  uint8_t mask = 0;
  if (prevString >= 0) mask |= 1 << prevString;
  if (soloString >= 0) mask |= 1 << soloString;
  if (mask) transmit(mask);
  return ok;
}

void identifyStart() { identifyUntil = millis() + 4000; if (!identifyUntil) identifyUntil = 1; }

// ---------- position upload ----------
static uint16_t posExpected = 0;

bool posBegin(uint16_t n) {
  if (n != total || !total) return false;
  posExpected = n;
  return true;
}
bool posSet(uint16_t idx, const Geo &g) {
  if (idx >= posExpected || idx >= total) return false;
  geo[idx] = g;
  return true;
}
bool posCommit(uint32_t baseIndex, uint32_t newId) {
  if (!total || posExpected != total) return false;
  baseIdx = baseIndex;
  geoId = newId;
  mapped = true;

  PosHeader hd = {POS_MAGIC, total, 0, baseIdx, geoId};
  File f = LittleFS.open("/pos.bin", "w");
  if (!f) return false;
  f.write((const uint8_t *)&hd, sizeof(hd));
  f.write((const uint8_t *)geo, (size_t)total * sizeof(Geo));
  f.write((const uint8_t *)zoneFrames, sizeof(zoneFrames));
  f.close();
  return true;
}
uint32_t posId() { return mapped ? geoId : 0; }

void posClear() {
  LittleFS.remove("/pos.bin");
  posExpected = 0;
  if (total) synthGeo();
}

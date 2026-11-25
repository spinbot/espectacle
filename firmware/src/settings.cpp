#include "settings.h"
#include "build_config.h"
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <sys/time.h>
#include <esp_timer.h>

Config cfg;
State  st;
String deviceId;

static bool     stateDirty = false;
static uint32_t stateDirtyAt = 0;

#if defined(CONFIG_IDF_TARGET_ESP32S3)
// ESP32-S3: 0/3/45/46 = boot straps, 19/20 = USB, 22-34 = flash/PSRAM or missing,
// 35-37 = octal PSRAM on N16R8-type boards, 43/44 = serial, 48 = onboard RGB LED on DevKitC boards.
bool validPin(int pin) {
  if (pin == 1 || pin == 2) return true;
  if (pin >= 4 && pin <= 18) return true;
  if (pin == 21) return true;
#if !defined(ESPECTACLE_OCTAL_PSRAM)
  if (pin >= 35 && pin <= 37) return true;
#endif
  if (pin >= 38 && pin <= 42) return true;
  if (pin == 47) return true;
  return false;
}
#elif defined(CONFIG_IDF_TARGET_ESP32)
// Original ESP32 (WROOM-32 DevKits): 0/2/5/12/15 = boot straps, 1/3 = serial, 6-11 = flash,
// 34-39 = input only. (16/17 are free on WROOM; WROVER modules use them for PSRAM.)
bool validPin(int pin) {
  static const uint8_t ok[] = {4, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33};
  for (uint8_t p : ok) if (p == pin) return true;
  return false;
}
#else
// ESP32-S2: 0 = boot button, 19/20 = USB, 26-32 = flash/PSRAM, 46 = input only.
bool validPin(int pin) {
  if (pin >= 1 && pin <= 18) return true;
  if (pin == 21) return true;
  if (pin >= 33 && pin <= 45) return true;
  return false;
}
#endif

// Any order of R, G, B (3 channels) or R, G, B, W (4 channels), as the strip receives them: "GRB", "WBRG"...
bool validOrder(const char *o) {
  size_t n = strlen(o);
  if (n != 3 && n != 4) return false;
  for (const char *need = n == 4 ? "RGBW" : "RGB"; *need; need++) {
    const char *p = strchr(o, *need);
    if (!p || strchr(p + 1, *need)) return false;      // missing or repeated
  }
  return true;
}

static void defaults() {
  memset(&cfg, 0, sizeof(cfg));
#ifdef ESPECTACLE_NAME
  strlcpy(cfg.name, ESPECTACLE_NAME, sizeof(cfg.name));
#else
  snprintf(cfg.name, sizeof(cfg.name), "Tree %s", deviceId.c_str());
#endif
  cfg.nStrings = 1;
#ifdef ESPECTACLE_LED_PIN
  cfg.strings[0].pin = validPin(ESPECTACLE_LED_PIN) ? ESPECTACLE_LED_PIN : DEFAULT_LED_PIN;
#else
  cfg.strings[0].pin = DEFAULT_LED_PIN;
#endif
#ifdef ESPECTACLE_LED_COUNT
  cfg.strings[0].count = ESPECTACLE_LED_COUNT;
#else
  cfg.strings[0].count = 50;
#endif
  strcpy(cfg.strings[0].order, "GRB");
  cfg.maxMilliamps = 2000;

  st.on = true; st.fx = 1; st.pal = 1; st.bri = 128; st.spd = 96; st.scl = 128;
  st.hasDir = false; st.dx = st.dy = st.dz = 0;
  st.c1 = 0xFF0000; st.c2 = 0x00A000;
}

void settingsLoad() {
  defaults();

  File f = LittleFS.open("/config.json", "r");
  if (f) {
    JsonDocument d;
    if (!deserializeJson(d, f)) {
      strlcpy(cfg.name, d["name"] | cfg.name, sizeof(cfg.name));
      cfg.maxMilliamps = d["maxMilliamps"] | cfg.maxMilliamps;
      JsonArray arr = d["strings"].as<JsonArray>();
      if (!arr.isNull()) {
        cfg.nStrings = 0;
        uint32_t total = 0;
        for (JsonObject s : arr) {
          if (cfg.nStrings >= MAX_STRINGS) break;
          int pin = s["pin"] | -1;
          int count = s["count"] | 0;
          const char *order = s["order"] | "GRB";
          if (!validPin(pin) || count <= 0 || !validOrder(order)) continue;
          if (total + count > MAX_LEDS) count = MAX_LEDS - total;
          if (count <= 0) break;
          StringCfg &c = cfg.strings[cfg.nStrings++];
          c.pin = pin; c.count = count; strlcpy(c.order, order, sizeof(c.order));
          total += count;
        }
      }
    }
    f.close();
  }

  f = LittleFS.open("/state.json", "r");
  if (f) {
    JsonDocument d;
    if (!deserializeJson(d, f)) {
      st.on  = d["on"]  | st.on;
      st.fx  = d["fx"]  | st.fx;
      st.pal = d["pal"] | st.pal;
      st.bri = d["bri"] | st.bri;
      st.spd = d["spd"] | st.spd;
      st.scl = d["scl"] | st.scl;
      st.c1  = d["c1"]  | st.c1;
      st.c2  = d["c2"]  | st.c2;
      JsonArray dir = d["dir"].as<JsonArray>();
      if (dir.size() == 3) { st.hasDir = true; st.dx = dir[0]; st.dy = dir[1]; st.dz = dir[2]; }
    }
    f.close();
  }
}

void configSave() {
  JsonDocument d;
  d["name"] = cfg.name;
  d["maxMilliamps"] = cfg.maxMilliamps;
  JsonArray arr = d["strings"].to<JsonArray>();
  for (int i = 0; i < cfg.nStrings; i++) {
    JsonObject s = arr.add<JsonObject>();
    s["pin"] = cfg.strings[i].pin;
    s["count"] = cfg.strings[i].count;
    s["order"] = cfg.strings[i].order;
  }
  File f = LittleFS.open("/config.json", "w");
  if (f) { serializeJson(d, f); f.close(); }
}

static void stateSave() {
  JsonDocument d;
  d["on"] = st.on; d["fx"] = st.fx; d["pal"] = st.pal; d["bri"] = st.bri;
  d["spd"] = st.spd; d["scl"] = st.scl; d["c1"] = st.c1; d["c2"] = st.c2;
  if (st.hasDir) { JsonArray dir = d["dir"].to<JsonArray>(); dir.add(st.dx); dir.add(st.dy); dir.add(st.dz); }
  File f = LittleFS.open("/state.json", "w");
  if (f) { serializeJson(d, f); f.close(); }
}

void stateMarkDirty() { stateDirty = true; stateDirtyAt = millis(); }

void stateTick() {
  // Debounced so dragging a slider in the app doesn't wear the flash.
  if (stateDirty && millis() - stateDirtyAt > 5000) {
    stateDirty = false;
    stateSave();
  }
}

uint64_t nowMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)(tv.tv_usec / 1000);
}

uint64_t uptimeMs() { return (uint64_t)(esp_timer_get_time() / 1000); }

void setClockMs(uint64_t ms) {
  struct timeval tv;
  tv.tv_sec = (time_t)(ms / 1000ULL);
  tv.tv_usec = (suseconds_t)((ms % 1000ULL) * 1000ULL);
  settimeofday(&tv, nullptr);
}

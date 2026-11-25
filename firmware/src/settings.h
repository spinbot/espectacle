// ESPectacle - shared types and persistent settings
#pragma once
#include <Arduino.h>

#define FW_VERSION   "1.14.0"
#define MAX_STRINGS  4
#define MAX_LEDS     1500
#ifndef DEFAULT_LED_PIN
#define DEFAULT_LED_PIN 16
#endif

struct StringCfg {
  uint8_t  pin;
  uint16_t count;
  char     order[5];   // byte order on the wire: any of RGB ("GRB", "RGB"...) or RGBW ("GRBW", "WBRG"...)
};

struct Config {
  char      name[33];
  uint8_t   nStrings;
  StringCfg strings[MAX_STRINGS];
  uint16_t  maxMilliamps;   // 0 = no limit
};

struct State {
  bool     on;
  uint8_t  fx;    // effect id
  uint8_t  pal;   // palette id
  uint8_t  bri;   // master brightness 0..255
  uint8_t  spd;   // speed 0..255
  uint8_t  scl;   // scale / size / density 0..255
  uint32_t c1;    // 0xRRGGBB
  uint32_t c2;
  bool     hasDir;          // direction of travel for moving effects (else each effect's default)
  int16_t  dx, dy, dz;      // unit vector, 4096 == 1
};

extern Config cfg;
extern State  st;
extern String deviceId;     // last 3 MAC bytes, hex

bool   validPin(int pin);    // GPIOs that are safe for LED data on this chip
bool   validOrder(const char *o);
void   settingsLoad();
void   configSave();
void   stateMarkDirty();    // saved to flash a few seconds after the last change
void   stateTick();
uint64_t nowMs();           // shared "tree clock" in ms (wall clock once synced)
uint64_t uptimeMs();        // monotonic ms since boot (never jumps; used for shows)
void   setClockMs(uint64_t ms);

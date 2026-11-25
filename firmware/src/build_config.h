// Settings baked in by the ESPectacle server when it builds firmware for you (Devices tab → Build).
// It writes espectacle_build_config.h next to this file in its own copy of the source; normal
// PlatformIO builds don't have it, and everything below falls back to the usual defaults.
//   ESPECTACLE_WIFI_SSID / ESPECTACLE_WIFI_PASS  join this WiFi on first boot (no setup hotspot)
//   ESPECTACLE_NAME                               the controller's name
//   ESPECTACLE_LED_PIN / ESPECTACLE_LED_COUNT     its first LED string
//   ESPECTACLE_SERVER                             e.g. "http://192.168.1.20:8080": says hello there
#pragma once
#if __has_include("espectacle_build_config.h")
#include "espectacle_build_config.h"
#endif

// ESPectacle - DDP receiver, so xLights (or FPP, WLED tools, …) can drive the LEDs directly.
// In xLights add an Ethernet controller with protocol DDP, this controller's IP address and
// 3 channels per LED (the "channels" value in /api/info). Channels follow the LED order:
// string 1 first, then string 2, and so on. While DDP data keeps arriving it overrides the
// built-in effects and shows; 2.5 s after the last packet the controller goes back to them.
#pragma once
#include <Arduino.h>

#define DDP_PORT 4048

void ddpBegin();
void ddpTick();          // call from loop()
bool ddpActive();
// The online layer: DDP sent to destination 2 by the ESPectacle server (marquee, video...). It doesn't
// take over; LEDs whose effect is an online one show it. nullptr when nothing arrived in the last second.
const uint8_t *ddpLayer();
// The overlay: DDP to destination 3 (messages from the server). Non-black pixels replace whatever the
// LED shows, even with the lights off; black is see-through. nullptr when nothing arrived in the last second.
const uint8_t *ddpOverlay();
uint32_t ddpPackets();

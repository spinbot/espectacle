#include "ddp.h"
#include "leds.h"
#include <WiFiUdp.h>

static WiFiUDP  udp;
static bool     started = false;
static uint8_t *buf = nullptr;
static size_t   bufLen = 0;
static uint32_t lastPacket = 0;
static bool     everReceived = false;
static uint32_t packets = 0;
static uint8_t *layer = nullptr;          // destination 2: the online layer
static size_t   layerLen = 0;
static uint32_t lastLayer = 0;
static uint8_t *overlay = nullptr;        // destination 3: the message overlay
static size_t   overlayLen = 0;
static uint32_t lastOverlay = 0;

void ddpBegin() {
  udp.begin(DDP_PORT);
  started = true;
}

bool ddpActive() { return everReceived && millis() - lastPacket < 2500; }
uint32_t ddpPackets() { return packets; }
const uint8_t *ddpLayer() { return layer && lastLayer && millis() - lastLayer < 1000 ? layer : nullptr; }
const uint8_t *ddpOverlay() { return overlay && lastOverlay && millis() - lastOverlay < 1000 ? overlay : nullptr; }

static inline uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static inline uint16_t be16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }

void ddpTick() {
  if (!started) return;
  int n;
  int budget = 32;                       // don't starve the web server if packets flood in
  while (budget-- > 0 && (n = udp.parsePacket()) > 0) {
    uint8_t hdr[14];
    if (n < 10 || udp.read(hdr, 10) != 10) { udp.flush(); continue; }
    uint8_t flags = hdr[0];
    if ((flags & 0xC0) != 0x40 || (flags & 0x02)) { udp.flush(); continue; }   // version 1 data only
    size_t hlen = 10;
    if (flags & 0x10) {                  // timecode present
      if (n < 14 || udp.read(hdr + 10, 4) != 4) { udp.flush(); continue; }
      hlen = 14;
    }
    uint8_t dest = hdr[3];
    if (dest != 1 && dest != 2 && dest != 3 && dest != 255) { udp.flush(); continue; }   // 1 = default output, 255 = all

    size_t need = (size_t)ledsTotal() * 3;
    if (!need) { udp.flush(); continue; }
    if (dest == 2 || dest == 3) {        // online layer / message overlay: keep it for rendering
      uint8_t *&b = dest == 2 ? layer : overlay;
      size_t &bl = dest == 2 ? layerLen : overlayLen;
      if (bl != need) {
        free(b);
        b = (uint8_t *)calloc(need, 1);
        bl = b ? need : 0;
        if (!b) { udp.flush(); continue; }
      }
      uint32_t off = be32(hdr + 4);
      size_t len = be16(hdr + 8), avail = (size_t)n - hlen;
      if (len > avail) len = avail;
      if (off < need) udp.read(b + off, len < need - off ? len : need - off);
      udp.flush();
      packets++;
      uint32_t &last = dest == 2 ? lastLayer : lastOverlay;
      last = millis();
      if (!last) last = 1;
      continue;
    }
    if (bufLen != need) {
      free(buf);
      buf = (uint8_t *)calloc(need, 1);
      bufLen = buf ? need : 0;
      if (!buf) { udp.flush(); continue; }
    }
    uint32_t off = be32(hdr + 4);
    size_t len = be16(hdr + 8);
    size_t avail = (size_t)n - hlen;
    if (len > avail) len = avail;
    if (off < need) {
      size_t take = len < need - off ? len : need - off;
      udp.read(buf + off, take);
    }
    udp.flush();
    packets++;
    lastPacket = millis();
    everReceived = true;
    // Show on PUSH, or when a sender that never pushes has filled the last channel.
    if ((flags & 0x01) || off + len >= need) ledsShowRealtime(buf);
  }
}

// ESPectacle - ESP32-S2 firmware
// Individually addressable Christmas tree LEDs with 3D-mapped effects,
// controlled over WiFi by the ESPectacle iOS app.
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <esp_sntp.h>
#include <Update.h>
#include "settings.h"
#include "effects.h"
#include "leds.h"
#include "show.h"
#include "ddp.h"
#include "build_config.h"
#ifdef ESPECTACLE_SERVER
#include <HTTPClient.h>
#endif

static WebServer   server(80);
static DNSServer   dns;
static Preferences prefs;

static String   wifiSsid, wifiPass, hostName;
static bool     apMode = false;
static bool     staRetrying = false;
static uint32_t staRetryAt = 0, lastRetry = 0;
static bool     ntpSynced = false;
static uint32_t rebootAt = 0;

#ifndef ESPECTACLE_BOARD
#define ESPECTACLE_BOARD "unknown"      // set per PlatformIO environment by tools/espectacle_build.py
#endif
// Found by the ESPectacle server in uploaded firmware files, to know their version and board.
extern "C" const char ESPECTACLE_FW_TAG[] __attribute__((used)) = "ESPECTACLE_FW|" FW_VERSION "|" ESPECTACLE_BOARD "|";

// ---------------------------------------------------------------- WiFi
static void onNtpSync(struct timeval *) { ntpSynced = true; }

static void onStaConnected() {
  WiFi.setSleep(false);   // modem sleep adds up to ~100 ms of latency to every request
  MDNS.addServiceTxt("espectacle", "tcp", "ip", WiFi.localIP().toString());
  MDNS.addServiceTxt("treelights", "tcp", "ip", WiFi.localIP().toString());
  sntp_set_time_sync_notification_cb(onNtpSync);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  Serial.printf("WiFi connected: %s\n", WiFi.localIP().toString().c_str());
}

// The network name (DHCP hostname and <name>.local) comes from the controller's name: "Front Tree" →
// "front-tree". Letters, digits and dashes only; falls back to espectacle-<id>.
static String hostFromName(const char *name) {
  String h;
  for (const char *p = name; *p && h.length() < 32; p++) {
    char c = *p;
    if (c >= 'A' && c <= 'Z') c += 32;
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) h += c;
    else if (h.length() && h[h.length() - 1] != '-') h += '-';
  }
  while (h.length() && h[h.length() - 1] == '-') h.remove(h.length() - 1);
  return h.length() ? h : "espectacle-" + deviceId;
}

static void mdnsBegin() {
  MDNS.begin(hostName.c_str());
  // Advertised as _espectacle._tcp, and as _treelights._tcp too so app versions from before the rename
  // still find it.
  for (const char *svc : {"espectacle", "treelights"}) {
    MDNS.addService(svc, "tcp", 80);
    MDNS.addServiceTxt(svc, "tcp", "id", deviceId);
    if (!apMode) MDNS.addServiceTxt(svc, "tcp", "ip", WiFi.localIP().toString());
  }
}

static void startAP() {
  apMode = true;
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(("ESPectacle-" + deviceId).c_str());
  dns.start(53, "*", WiFi.softAPIP());   // captive portal
  lastRetry = millis();
  Serial.printf("Setup AP started: ESPectacle-%s  http://%s\n", deviceId.c_str(), WiFi.softAPIP().toString().c_str());
}

static void wifiBegin() {
  WiFi.persistent(false);
  WiFi.setHostname(hostName.c_str());
  WiFi.setAutoReconnect(true);
  if (wifiSsid.length()) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) { ledsTick(); delay(5); }
  }
  if (WiFi.status() != WL_CONNECTED) startAP();

  mdnsBegin();
  if (!apMode) onStaConnected();
}

// If the router was down at boot we fall back to the setup AP; keep
// quietly retrying the stored network so the tree recovers by itself.
static void wifiTick() {
  if (!apMode || !wifiSsid.length()) return;
  uint32_t now = millis();
  if (!staRetrying) {
    if (now - lastRetry > 60000 && WiFi.softAPgetStationNum() == 0) {
      WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
      staRetrying = true; staRetryAt = now;
    }
  } else if (WiFi.status() == WL_CONNECTED) {
    staRetrying = false; apMode = false;
    dns.stop();
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    onStaConnected();
  } else if (now - staRetryAt > 15000) {
    WiFi.disconnect();
    staRetrying = false; lastRetry = now;
  }
}

// ---------------------------------------------------------------- HTTP helpers
static void sendJson(int code, JsonDocument &d) {
  String out;
  serializeJson(d, out);
  server.send(code, "application/json", out);
}
static void sendOk() { server.send(200, "application/json", "{\"ok\":true}"); }
static void sendErr(int code, const char *msg) {
  JsonDocument d; d["ok"] = false; d["error"] = msg;
  sendJson(code, d);
}
static bool readBody(JsonDocument &d) {
  if (!server.hasArg("plain")) { sendErr(400, "missing body"); return false; }
  if (deserializeJson(d, server.arg("plain"))) { sendErr(400, "bad json"); return false; }
  return true;
}
static void fillState(JsonObject o) {
  o["on"] = st.on; o["fx"] = st.fx; o["pal"] = st.pal; o["bri"] = st.bri;
  o["spd"] = st.spd; o["scl"] = st.scl; o["c1"] = st.c1; o["c2"] = st.c2;
  if (st.hasDir) { JsonArray dir = o["dir"].to<JsonArray>(); dir.add(st.dx); dir.add(st.dy); dir.add(st.dz); }
  else o["dir"] = nullptr;
}

// ---------------------------------------------------------------- HTTP handlers
static void handleInfo() {
  JsonDocument d;
  d["id"] = deviceId;
  d["name"] = cfg.name;
  d["fw"] = FW_VERSION;
  d["host"] = hostName;
  d["ip"] = apMode ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
  d["ap"] = apMode;
  d["ssid"] = wifiSsid;
  d["rssi"] = apMode ? 0 : WiFi.RSSI();
  d["heap"] = ESP.getFreeHeap();
  d["total"] = ledsTotal();
  d["mapped"] = ledsMapped();
  d["scan"] = scanActive();
  d["maxLeds"] = MAX_LEDS;
  d["maxStrings"] = MAX_STRINGS;
  d["maxMilliamps"] = cfg.maxMilliamps;
  d["fxCount"] = FX_COUNT;
  d["timeMs"] = nowMs();
  d["up"] = uptimeMs();
  d["geoId"] = posId();
  d["showId"] = showId();
  d["showSegs"] = showCount();
  d["playing"] = showPlaying();
  d["channels"] = ledsTotal() * 3;     // for xLights (DDP, 3 channels per LED)
  d["chip"] = ESP.getChipModel();
  d["board"] = ESPECTACLE_BOARD;
  d["build"] = ESPECTACLE_FW_TAG;
  d["ota"] = true;                     // accepts POST /api/update (firmware 1.10+)
  d["sketch"] = ESP.getSketchSize();
  d["sketchFree"] = ESP.getFreeSketchSpace();
  d["psram"] = ESP.getPsramSize();
  JsonArray pins = d["pins"].to<JsonArray>();   // GPIOs the app may offer for LED strings
  for (int p = 0; p <= 48; p++) if (validPin(p)) pins.add(p);
  d["ddp"] = ddpActive();
  d["ntp"] = ntpSynced;
  JsonArray arr = d["strings"].to<JsonArray>();
  for (int i = 0; i < cfg.nStrings; i++) {
    JsonObject s = arr.add<JsonObject>();
    s["pin"] = cfg.strings[i].pin;
    s["count"] = cfg.strings[i].count;
    s["order"] = cfg.strings[i].order;
  }
  fillState(d["state"].to<JsonObject>());
  sendJson(200, d);
}

static void handleConfig() {
  JsonDocument d;
  if (!readBody(d)) return;

  Config n = cfg;
  if (d["name"].is<const char *>()) strlcpy(n.name, d["name"].as<const char *>(), sizeof(n.name));
  if (d["maxMilliamps"].is<int>()) n.maxMilliamps = constrain(d["maxMilliamps"].as<int>(), 0, 60000);

  JsonArray arr = d["strings"].as<JsonArray>();
  if (!arr.isNull()) {
    n.nStrings = 0;
    uint32_t total = 0;
    for (JsonObject s : arr) {
      if (n.nStrings >= MAX_STRINGS) return sendErr(400, "too many strings");
      int pin = s["pin"] | -1;
      int count = s["count"] | 0;
      const char *order = s["order"] | "GRB";
      if (!validPin(pin)) return sendErr(400, "invalid GPIO pin");
      if (count < 1) return sendErr(400, "invalid LED count");
      if (!validOrder(order)) return sendErr(400, "invalid colour order");
      for (int k = 0; k < n.nStrings; k++)
        if (n.strings[k].pin == pin) return sendErr(400, "GPIO pin used twice");
      total += count;
      if (total > MAX_LEDS) return sendErr(400, "too many LEDs");
      StringCfg &c = n.strings[n.nStrings++];
      c.pin = pin; c.count = count; strlcpy(c.order, order, sizeof(c.order));
    }
    if (n.nStrings == 0) return sendErr(400, "at least one string required");
  }

  bool stringsChanged = n.nStrings != cfg.nStrings ||
                        memcmp(n.strings, cfg.strings, sizeof(cfg.strings)) != 0;
  cfg = n;
  configSave();
  if (stringsChanged) ledsBegin();
  String h = hostFromName(cfg.name);
  if (h != hostName) {               // renamed: <name>.local follows now, the router's DNS after a restart
    hostName = h;
    WiFi.setHostname(hostName.c_str());
    MDNS.end();
    mdnsBegin();
  }
  handleInfo();
}

static void handleStateGet() {
  JsonDocument d;
  fillState(d.to<JsonObject>());
  sendJson(200, d);
}

static void applyClock(JsonDocument &d) {
  // Once NTP has synced, every controller already shares wall-clock time,
  // so the phone's clock is only used when there is no internet.
  if (!ntpSynced && d["t"].is<uint64_t>()) setClockMs(d["t"].as<uint64_t>());
}

static void handleStatePost() {
  JsonDocument d;
  if (!readBody(d)) return;
  if (d["on"].is<bool>()) st.on = d["on"].as<bool>();
  if (d["fx"].is<int>())  st.fx  = fxClamp(d["fx"].as<int>());
  if (d["pal"].is<int>()) st.pal = constrain(d["pal"].as<int>(), 0, PAL_COUNT - 1);
  if (d["bri"].is<int>()) st.bri = constrain(d["bri"].as<int>(), 0, 255);
  if (d["spd"].is<int>()) st.spd = constrain(d["spd"].as<int>(), 0, 255);
  if (d["scl"].is<int>()) st.scl = constrain(d["scl"].as<int>(), 0, 255);
  if (d["c1"].is<uint32_t>()) st.c1 = d["c1"].as<uint32_t>() & 0xFFFFFF;
  if (d["c2"].is<uint32_t>()) st.c2 = d["c2"].as<uint32_t>() & 0xFFFFFF;
  // "dir": [dx, dy, dz] (unit vector, 4096 == 1) sets a direction; null clears it.
  if (d["dir"].is<JsonArray>() && d["dir"].size() == 3) {
    st.hasDir = true;
    st.dx = constrain(d["dir"][0].as<int>(), -4096, 4096);
    st.dy = constrain(d["dir"][1].as<int>(), -4096, 4096);
    st.dz = constrain(d["dir"][2].as<int>(), -4096, 4096);
  } else if (d["dir"].isNull() && d.containsKey("dir")) {
    st.hasDir = false;
  }
  applyClock(d);
  if (scanActive()) scanSet(false);
  showStop();             // changing the look from the app overrides a playing show
  showBlackout(false);
  stateMarkDirty();
  handleStateGet();
}

static void handleSync() {
  JsonDocument d;
  if (!readBody(d)) return;
  applyClock(d);
  JsonDocument r; r["ok"] = true; r["timeMs"] = nowMs(); r["ntp"] = ntpSynced;
  sendJson(200, r);
}

// POST /api/scan?on=1|0
static void handleScan() {
  scanSet(server.arg("on").toInt() != 0);
  sendOk();
}

// POST /api/solo?s=<string>&i=<index>&v=<0..255>   (i=-1: all off)
// Replies only after the LED data has been clocked out, so the app can
// time its camera capture from the response.
static void handleSolo() {
  int s = server.arg("s").toInt();
  int i = server.hasArg("i") ? server.arg("i").toInt() : -1;
  int v = server.hasArg("v") ? constrain(server.arg("v").toInt(), 1, 255) : 128;
  if (!scanSolo(s, i, (uint8_t)v)) return sendErr(400, "no such LED");
  server.send(200, "text/plain", "OK");
}

static int16_t clamp16i(JsonVariant v) { return (int16_t)constrain(v.as<long>(), -32767L, 32767L); }

// POST /api/positions?offset=<first index>&total=<n>[&final=1&base=<global index>&id=<geometry id>]
// body: {"g8":[x,y,z,h,ang,rad,d3,zone, ...]} - eight integers per LED, see Geo in effects.h
// (the older {"g":[...]} with seven integers per LED, zone 0, is still accepted)
static void handlePositions() {
  JsonDocument d;
  if (!readBody(d)) return;
  int offset = server.arg("offset").toInt();
  int total = server.arg("total").toInt();
  if (offset == 0 && !posBegin(total)) return sendErr(409, "LED count does not match controller config");
  int per = 8;
  JsonArray p = d["g8"].as<JsonArray>();
  if (p.isNull()) { p = d["g"].as<JsonArray>(); per = 7; }
  if (p.isNull() || p.size() % per) return sendErr(400, "bad geometry array");
  int idx = offset;
  for (size_t k = 0; k + per - 1 < p.size(); k += per, idx++) {
    Geo g;
    g.x = constrain(p[k].as<int>(), -32767, 32767);
    g.y = constrain(p[k + 1].as<int>(), -32767, 32767);
    g.z = constrain(p[k + 2].as<int>(), -32767, 32767);
    g.h = constrain(p[k + 3].as<int>(), 0, 65535);
    g.ang = constrain(p[k + 4].as<int>(), 0, 65535);
    g.rad = constrain(p[k + 5].as<int>(), 0, 65535);
    g.d3 = constrain(p[k + 6].as<int>(), 0, 65535);
    g.zone = per == 8 ? constrain(p[k + 7].as<int>(), 0, MAX_ZONES - 1) : 0;
    g.pad = 0;
    if (!posSet(idx, g)) return sendErr(400, "position index out of range");
  }
  if (server.arg("final").toInt()) {
    // Optional plant frames: {"zf":[cx,cy,cz,half,ymin,height,radius, ...]} - seven per zone.
    JsonArray zf = d["zf"].as<JsonArray>();
    for (size_t k = 0, z = 0; !zf.isNull() && k + 6 < zf.size() && z < MAX_ZONES; k += 7, z++) {
      zoneFrames[z] = {clamp16i(zf[k]), clamp16i(zf[k + 1]), clamp16i(zf[k + 2]), clamp16i(zf[k + 3]),
                       clamp16i(zf[k + 4]), clamp16i(zf[k + 5]), clamp16i(zf[k + 6])};
    }
    uint32_t base = (uint32_t)server.arg("base").toInt();
    uint32_t gid = (uint32_t)strtoul(server.arg("id").c_str(), nullptr, 10);
    if (!posCommit(base, gid)) return sendErr(500, "could not store positions");
  }
  sendOk();
}

// GET /api/time - the controller's uptime clock, for lining shows up with the music.
// Kept tiny so the round trip is as short and even as possible.
static void handleTime() {
  char buf[48];
  snprintf(buf, sizeof(buf), "{\"up\":%llu}", (unsigned long long)uptimeMs());
  server.send(200, "application/json", buf);
}

// POST /api/show?offset=<first>&total=<n>&id=<show id>[&final=1]
// body: {"s":[zone,t0,t1,p0,fx,pal,bri,scl,rate,c1,c2, mode,cx,cy,cz,half,ymin,height,radius, ...]}
// then optionally hasDir,dx,dy,dz (direction of travel, 4096 == 1)
// - nineteen or twenty-three integers per segment (mode and the group frame: see Frame in effects.h),
// sorted by zone then time. Uploading stops any playing show.
static void handleShowUpload() {
  JsonDocument d;
  if (!readBody(d)) return;
  int offset = server.arg("offset").toInt();
  int total = server.arg("total").toInt();
  uint32_t sid = (uint32_t)strtoul(server.arg("id").c_str(), nullptr, 10);
  if (offset == 0 && !showBegin(sid, (uint16_t)constrain(total, 0, 65535))) {
    char msg[64];
    snprintf(msg, sizeof(msg), "show too big: this controller fits %u segments", (unsigned)showMaxSegments());
    return sendErr(507, msg);
  }
  JsonArray a = d["s"].as<JsonArray>();
  int per = server.arg("per").toInt() == 23 ? 23 : 19;
  if (a.isNull() || a.size() % per) return sendErr(400, "bad segment array");
  int idx = offset;
  for (size_t k = 0; k + per - 1 < a.size(); k += per, idx++) {
    ShowSeg s;
    s.zone = constrain(a[k].as<int>(), 0, MAX_ZONES - 1);
    s.t0 = a[k + 1].as<uint32_t>();
    s.t1 = a[k + 2].as<uint32_t>();
    s.p0 = a[k + 3].as<uint32_t>();
    s.fx = fxClamp(a[k + 4].as<int>());
    s.pal = constrain(a[k + 5].as<int>(), 0, PAL_COUNT - 1);
    s.bri = constrain(a[k + 6].as<int>(), 0, 255);
    s.scl = constrain(a[k + 7].as<int>(), 0, 255);
    s.rate = constrain(a[k + 8].as<long>(), 1L, 65535L);
    s.c1 = a[k + 9].as<uint32_t>() & 0xFFFFFF;
    s.c2 = a[k + 10].as<uint32_t>() & 0xFFFFFF;
    s.frameMode = constrain(a[k + 11].as<int>(), 0, 2);
    s.group = {clamp16i(a[k + 12]), clamp16i(a[k + 13]), clamp16i(a[k + 14]), clamp16i(a[k + 15]),
               clamp16i(a[k + 16]), clamp16i(a[k + 17]), clamp16i(a[k + 18])};
    s.hasDir = per == 23 ? (a[k + 19].as<int>() != 0) : 0;
    s.dx = per == 23 ? constrain(a[k + 20].as<int>(), -4096, 4096) : 0;
    s.dy = per == 23 ? constrain(a[k + 21].as<int>(), -4096, 4096) : 0;
    s.dz = per == 23 ? constrain(a[k + 22].as<int>(), -4096, 4096) : 0;
    if (!showAdd(idx, s)) { showClear(); return sendErr(400, "bad or out-of-order segment"); }
  }
  if (server.arg("final").toInt() && !showCommit()) return sendErr(400, "incomplete show upload");
  sendOk();
}

static void handleShowGet() {
  JsonDocument d;
  d["id"] = showId();
  d["segs"] = showCount();
  d["lengthMs"] = showLengthMs();
  d["playing"] = showPlaying();
  d["maxSegs"] = showMaxSegments();
  sendJson(200, d);
}

// POST /api/show/play {"id":<show id>,"start":<uptime ms at show time 0>}
static void handleShowPlay() {
  JsonDocument d;
  if (!readBody(d)) return;
  if (!showCount() || d["id"].as<uint32_t>() != showId()) return sendErr(409, "show not loaded");
  if (scanActive()) scanSet(false);
  showPlay(d["start"].as<long long>());
  sendOk();
}

// POST /api/show/stop[?dark=1] - dark=1 also turns every LED off until the next play or look change
static void handleShowStop() {
  showStop();
  showBlackout(server.arg("dark").toInt() != 0);
  sendOk();
}

static void handlePositionsDelete() { posClear(); sendOk(); }

static void saveWifi(const String &ssid, const String &pass) {
  prefs.begin("wifi", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.end();
  rebootAt = millis() + 1500;
}

static void handleWifi() {
  JsonDocument d;
  if (!readBody(d)) return;
  const char *ssid = d["ssid"] | "";
  const char *pass = d["pass"] | "";
  if (!strlen(ssid)) return sendErr(400, "ssid required");
  saveWifi(ssid, pass);
  sendOk();
}

static void handleNetworks() {
  int n = WiFi.scanNetworks();
  JsonDocument d;
  JsonArray arr = d["networks"].to<JsonArray>();
  for (int i = 0; i < n && i < 25; i++) {
    JsonObject o = arr.add<JsonObject>();
    o["ssid"] = WiFi.SSID(i);
    o["rssi"] = WiFi.RSSI(i);
    o["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
  }
  WiFi.scanDelete();
  sendJson(200, d);
}

static void handleIdentify() { identifyStart(); sendOk(); }
static void handleReboot()   { sendOk(); rebootAt = millis() + 500; }

// POST /api/update - multipart upload of a firmware .bin (from the ESPectacle server or a browser).
// The LEDs go dark while it writes; on success the controller restarts into the new firmware.
static bool   otaOk = false, otaFirst = false;
static String otaErr;
static void handleUpdateUpload() {
  HTTPUpload &u = server.upload();
  if (u.status == UPLOAD_FILE_START) {
    otaOk = false; otaErr = ""; otaFirst = true;
    showStop();
    scanSet(true);                       // all LEDs dark, nothing else drawing
    if (!Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH)) otaErr = Update.errorString();
  } else if (u.status == UPLOAD_FILE_WRITE) {
    if (otaErr.length()) return;
    if (otaFirst) {
      otaFirst = false;
      if (u.currentSize < 16 || u.buf[0] != 0xE9) { otaErr = "not an ESP32 firmware file"; Update.abort(); return; }
#ifdef CONFIG_IDF_FIRMWARE_CHIP_ID
      uint16_t chip = u.buf[12] | (u.buf[13] << 8);
      if (chip != CONFIG_IDF_FIRMWARE_CHIP_ID) { otaErr = "firmware is for a different chip"; Update.abort(); return; }
#endif
    }
    if (Update.write(u.buf, u.currentSize) != u.currentSize) otaErr = Update.errorString();
  } else if (u.status == UPLOAD_FILE_END) {
    if (!otaErr.length()) {
      if (Update.end(true)) otaOk = true;
      else otaErr = Update.errorString();
    }
  } else if (u.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
    otaErr = "upload interrupted";
  }
}
static void handleUpdateDone() {
  if (otaOk) {
    sendOk();
    rebootAt = millis() + 800;
  } else {
    scanSet(false);
    sendErr(400, otaErr.length() ? otaErr.c_str() : "no firmware received");
  }
}

// Minimal web page so a controller can be put on WiFi without the app.
static const char SETUP_PAGE[] PROGMEM = R"HTML(<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ESPectacle setup</title>
<style>body{font-family:-apple-system,sans-serif;max-width:22em;margin:2em auto;padding:0 1em}
input,button{font-size:1.1em;width:100%;padding:.5em;margin:.3em 0;box-sizing:border-box}</style></head><body>
<h2>ESPectacle</h2><p>Connect this controller to your WiFi network.</p>
<form method="post" action="/wifi"><input name="ssid" placeholder="Network name" required>
<input name="pass" type="password" placeholder="Password"><button>Save and restart</button></form>
</body></html>)HTML";

static void handleRoot() { server.send_P(200, "text/html", SETUP_PAGE); }

static void handleWifiForm() {
  String ssid = server.arg("ssid");
  if (!ssid.length()) return server.send(400, "text/plain", "Network name required");
  saveWifi(ssid, server.arg("pass"));
  server.send(200, "text/html", "<html><body><h3>Saved. The controller is restarting and will join your network.</h3></body></html>");
}

static void handleNotFound() {
  if (apMode) {   // captive portal: send everything to the setup page
    server.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
    server.send(302, "text/plain", "");
  } else {
    sendErr(404, "not found");
  }
}

static void httpBegin() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/wifi", HTTP_POST, handleWifiForm);
  server.on("/api/info", HTTP_GET, handleInfo);
  server.on("/api/config", HTTP_POST, handleConfig);
  server.on("/api/state", HTTP_GET, handleStateGet);
  server.on("/api/state", HTTP_POST, handleStatePost);
  server.on("/api/sync", HTTP_POST, handleSync);
  server.on("/api/scan", HTTP_POST, handleScan);
  server.on("/api/solo", HTTP_POST, handleSolo);
  server.on("/api/positions", HTTP_POST, handlePositions);
  server.on("/api/positions", HTTP_DELETE, handlePositionsDelete);
  server.on("/api/wifi", HTTP_POST, handleWifi);
  server.on("/api/networks", HTTP_GET, handleNetworks);
  server.on("/api/identify", HTTP_POST, handleIdentify);
  server.on("/api/time", HTTP_GET, handleTime);
  server.on("/api/show", HTTP_GET, handleShowGet);
  server.on("/api/show", HTTP_POST, handleShowUpload);
  server.on("/api/show/play", HTTP_POST, handleShowPlay);
  server.on("/api/show/stop", HTTP_POST, handleShowStop);
  server.on("/api/reboot", HTTP_POST, handleReboot);
  server.on("/api/update", HTTP_POST, handleUpdateDone, handleUpdateUpload);
  server.onNotFound(handleNotFound);
  server.begin();
}

// Hold the BOOT button (GPIO0) for 5 seconds to forget the WiFi network.
static void buttonTick() {
  static uint32_t downSince = 0;
  if (digitalRead(0) == LOW) {
    if (!downSince) downSince = millis();
    else if (millis() - downSince > 5000) {
      prefs.begin("wifi", false); prefs.clear(); prefs.end();
      ESP.restart();
    }
  } else {
    downSince = 0;
  }
}

// ---------------------------------------------------------------- Arduino entry points
void setup() {
  Serial.begin(115200);
  pinMode(0, INPUT_PULLUP);

  uint64_t mac = ESP.getEfuseMac();   // byte 0 of the MAC is the low byte
  char idbuf[8];
  snprintf(idbuf, sizeof(idbuf), "%02x%02x%02x", (unsigned)((mac >> 24) & 0xFF),
           (unsigned)((mac >> 32) & 0xFF), (unsigned)((mac >> 40) & 0xFF));
  deviceId = idbuf;
  LittleFS.begin(true);
  settingsLoad();
  hostName = hostFromName(cfg.name);
  fxInit();
  ledsBegin();           // lights come on straight away with the last used effect

  prefs.begin("wifi", true);
  wifiSsid = prefs.getString("ssid", "");
  wifiPass = prefs.getString("pass", "");
  prefs.end();
#ifdef ESPECTACLE_WIFI_SSID
  // Firmware built by the ESPectacle server carries your WiFi. Use it when it's new to this controller
  // (first boot, or a build with different WiFi); WiFi set later in the app stays until then.
  {
    String built = String(ESPECTACLE_WIFI_SSID) + "\n" + String(ESPECTACLE_WIFI_PASS);
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < built.length(); i++) h = (h ^ (uint8_t)built[i]) * 16777619u;
    prefs.begin("wifi", false);
    if (prefs.getUInt("built", 0) != h && strlen(ESPECTACLE_WIFI_SSID)) {
      wifiSsid = ESPECTACLE_WIFI_SSID;
      wifiPass = ESPECTACLE_WIFI_PASS;
      prefs.putString("ssid", wifiSsid);
      prefs.putString("pass", wifiPass);
      prefs.putUInt("built", h);
    }
    prefs.end();
  }
#endif

  wifiBegin();
  httpBegin();
  ddpBegin();
}

// Firmware built by the ESPectacle server says hello to it now and then, so the server can list new
// controllers and follow address changes. Kept short (it briefly holds up the LEDs).
#ifdef ESPECTACLE_SERVER
static void helloTick() {
  static uint32_t last = 0, n = 0;
  if (apMode || WiFi.status() != WL_CONNECTED || scanActive()) return;
  uint32_t now = millis();
  uint32_t wait = n == 0 ? 5000 : n < 3 ? 30000 : 600000;     // soon after boot, then every 10 minutes
  if (now - last < wait) return;
  last = now;
  n++;
  JsonDocument d;
  d["id"] = deviceId; d["name"] = cfg.name; d["ip"] = WiFi.localIP().toString();
  d["fw"] = FW_VERSION; d["board"] = ESPECTACLE_BOARD; d["total"] = ledsTotal();
  String body;
  serializeJson(d, body);
  HTTPClient http;
  http.setConnectTimeout(600);
  http.setTimeout(800);
  if (http.begin(String(ESPECTACLE_SERVER) + "/api/hello")) {
    http.addHeader("Content-Type", "application/json");
    http.POST(body);
    http.end();
  }
}
#else
static void helloTick() {}
#endif

void loop() {
  server.handleClient();
  helloTick();
  if (apMode) dns.processNextRequest();
  wifiTick();
  ddpTick();
  ledsTick();
  stateTick();
  buttonTick();
  if (rebootAt && (int32_t)(millis() - rebootAt) > 0) ESP.restart();
  if (!scanActive()) delay(1);
}

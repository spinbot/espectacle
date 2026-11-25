# ESPectacle

**Website:** `docs/` is the project's landing page, ready for GitHub Pages (Settings → Pages → Deploy
from a branch → `main`, folder `/docs`). Edit `docs/site.html` and run `python3 docs/build.py` to
regenerate `docs/index.html`. Licensed under the MIT licence (see `LICENSE`).

3D-mapped addressable LEDs for a Christmas tree or a whole yard of props: ESP32-S2 controllers
drive the LEDs, and an iOS app manages the controllers, works out where every LED is in space
with the camera and LiDAR, and runs position-aware animations.

*Formerly TreeLights.* For older setups: the server still accepts the `TREELIGHTS_…` environment
variables, controllers also advertise `_treelights._tcp` (for app versions from before the rename), the
app moves its saved `treelights.json` over by itself, and the server reads firmware files tagged with
either name. Home Assistant entities moved from `treelights_…` to `espectacle_…` (see Home Assistant).

```
server/     Optional home server + website: shared project, 3D yard view, effect preview (Docker)
firmware/   PlatformIO project for the ESP32-S2 (Arduino framework)
ios/        Xcode project for the app (SwiftUI + ARKit, iOS 18+): iPhone, iPad, and Mac (Designed for iPad)
```

## How it fits together

- Each controller drives up to 4 LED strings (1500 LEDs total) and renders the effects itself,
  so the tree keeps running when the phone is away.
- LEDs are grouped into **props**. Each prop is scanned on its own, then placed in the yard by
  entering its X/Y/Z position. The app combines the two and uploads ready-to-use geometry for every
  LED, and sends the same effect settings to every controller.
- Controllers stay in step with each other by rendering from wall-clock time (NTP, or the phone's
  clock when there is no internet), so nothing needs to stream between them.

## Hardware

| ESP32-S2 | LEDs |
|---|---|
| Data GPIO (default 16) | DIN, through a 3.3 V → 5 V level shifter (74AHCT125 or similar) and a ~330 Ω series resistor |
| GND | LED supply GND (must be common) |
| 5 V | Power the board from the LED supply, or from USB with grounds joined |

- Budget up to 60 mA per RGB LED at full white. Set the **current limit** (app or website) a little below
  your supply's rating; the firmware dims to stay under it.
- Put a 470–1000 µF capacitor across the supply at the start of each string and inject power every
  100–150 LEDs on 5 V strings.
- Usable data pins on the ESP32-S2: GPIO 1–18, 21, 33–45 (ESP32-S3: see below).
- Speed: each LED takes ~30 µs to send, and all strings (up to 4) are sent at the same time (firmware
  1.12+). So the longest string sets the frame rate: 500 LEDs ≈ 15 ms, ~60 fps; 1500 on one pin ≈ 45 ms,
  ~20 fps; 4 × 375 ≈ 11 ms, 60 fps (the cap). Split big props across pins for smoother effects.
  If you ever see flicker with several strings, build with `-DESPECTACLE_SERIAL_OUTPUT` to send them one
  after another as before.

## Firmware

```
cd firmware
pio run -e lolin_s2_mini -t upload        # Wemos/Lolin S2 Mini
pio run -e esp32-s2-saola-1 -t upload     # Saola / generic S2 dev boards
```

On an S2 Mini, hold button `0` and tap `RST` to enter the bootloader before uploading, then tap
`RST` afterwards.

**Ready-made firmware:** every [release](https://github.com/spinbot/espectacle/releases) has, for each
board, `espectacle-<version>-<board>-factory.bin` (a complete image: flash it over USB at `0x0` with
`esptool.py write_flash 0x0 …` or a browser flasher such as Adafruit's WebSerial ESPTool) and
`espectacle-<version>-<board>.bin` (for updating a controller over WiFi from the website's Devices tab).
These have no WiFi built in: the controller starts its setup hotspot. To have WiFi and the server
address baked in, build on the server instead (below).

ESP32-S3 boards (DevKitC-1 style, recommended – dual core, more memory):

```
pio run -e esp32-s3-n8r2 -t upload        # 8 MB flash / 2 MB PSRAM ("N8R2")
pio run -e esp32-s3-n16r8 -t upload       # 16 MB flash / 8 MB PSRAM ("N16R8")
```

On boards with two USB-C ports, plug into the one marked UART/COM to flash without pressing
buttons. Usable LED pins on the S3: GPIO 1, 2, 4–18, 21, 35–42 and 47 (35–37 are not available on
N16R8 boards; 48 drives the onboard RGB LED). The app reads each controller's allowed pins, so S2 and
S3 controllers can be mixed. With PSRAM, shows are stored there, so each controller can hold far
longer shows.

Original ESP32 boards (ESP32-WROOM-32 DevKits, dual core, no PSRAM): `pio run -e esp32dev -t upload`
(hold BOOT if the upload doesn't start). Usable LED pins: GPIO 4, 13, 14, 16–19, 21–23, 25–27, 32 and 33.

First boot: the controller has no WiFi details, so it starts a hotspot called `ESPectacle-xxxxxx`.
Use **Controllers → Set up a new controller's WiFi** in the app (or join the hotspot and browse to
`192.168.4.1`). Holding the BOOT (0) button for 5 seconds forgets the network.
If the saved network is unavailable at power-up, the hotspot comes back and the controller retries
the saved network once a minute.

## iOS app

1. Open `ios/ESPectacle.xcodeproj` in Xcode 16 or newer.
2. Select the ESPectacle target → Signing & Capabilities → choose your team and change the bundle
   identifier from `com.example.ESPectacle`.
3. Run on an iPhone. ARKit needs a real device; a Pro model adds LiDAR.

If the project won't open, `brew install xcodegen && xcodegen` in `ios/` regenerates it from
`project.yml`.

**Apple accounts.** A free Apple Account is enough to build and run the app on your own iPhone or iPad
from Xcode on a Mac (choose your *Personal Team* in step 2). The app needs no paid-only capabilities
(camera, ARKit and the local network all work). Apple limits free installs, though: the app stops
opening after **7 days** and has to be rebuilt and reinstalled from Xcode, there's a limit of 3 such
apps per device, and you can't pass the build to anyone else. A paid Apple Developer Program
membership (US$99 a year, or the local price) makes your own installs last a year, and lets one member
share the app with everyone else through TestFlight (a public link, builds last 90 days) or the App
Store; those users need no developer account or Mac. Without the app, everything except scanning works
from the website.

## Using it

1. **Controllers tab** – add each controller (they are found automatically), then set the GPIO pin,
   LED count and colour order for each string and tap *Save to controller*. *Identify* blinks a
   controller, each string in a different colour.
2. **Props tab → Add prop.** Tick the LED strings that are on that prop. A prop can use strings
   from several controllers, and one controller can feed several props (one string each).
3. **Scan this prop.** Keep some light on (ARKit needs to see its surroundings – dusk works well
   outdoors), stand back with the whole prop in frame, hold steady and tap *Scan from here*. The
   app lights that prop's LEDs one at a time (several per second) while everything else stays dark.
   Then walk to another side and scan again – all in the same session. Markers appear as LEDs are
   located: green = seen from 2+ sides (triangulated), yellow = one view + LiDAR depth,
   grey = estimated from neighbours on the wire. Tap *Save map*.
   To improve a prop later, use *Scan the N LEDs that aren't green*: green LEDs keep their saved
   positions and are skipped (a few are re-lit as anchors so the new scan can be lined up with the
   old one). If a green LED looks wrong, tap it in the prop's 3D preview to un-flag it – it turns
   orange and is included in the next top-up scan. Tap again to undo. On the scan screen itself,
   tapping a green or yellow marker discards that LED so the next pass locates it again.
   For the stubborn ones there are two more tools on the scan screen. **Flash each LED** blinks
   every LED three times against a dark frame and only accepts it if it is seen in the same place
   at least twice (slower, far fewer false readings). **Place LEDs by hand** steps along the wire
   one LED at a time: the LED is lit on the prop and you drag a white marker onto it, then look
   from another side and drag again to set its depth. Hand-placed LEDs count as good.
4. **Position in yard.** Enter where the prop's base is in metres from any fixed point: X = right,
   Y = up, Z = towards you when looking at the yard from the front. Rotation turns the prop about
   its vertical axis. The Props tab shows the whole yard in 3D.
5. **Lights tab** – choose an effect, palette, colours, speed and scale.

Spiral, Stripes, Beam, Gradient, Rings, Fire and Snow wrap each prop individually (using its own
height and axis). Sweep, Plasma and Pulse travel across the whole yard. A single tree is just one
prop left at 0, 0, 0.

### Mapping tips

- The spot you stood in for a prop's first pass becomes that prop's "front" (+Z before rotation).
- Reflective surfaces and windows cause false sightings. The solver discards rays that disagree,
  but raising the detection threshold (slider icon on the scan screen) also helps.
- LEDs are lit in wire order. Any LED measured further from its neighbours than the wire allows
  (default 10 cm per LED step, adjustable on the scan screen) is treated as a bad reading and
  scanned again. Set the limit a little above your real LED spacing.
- Lower the scan LED brightness if LEDs bloom into big blobs; raise it if few are detected.
  Blooming matters more now that neighbours are lit one after another.
- LiDAR reaches about 5 m and is weak in sunlight. Without it an LED must be seen from two sides
  at least ~5° apart to be placed.
- A scan belongs to the prop's LEDs in wiring order, not to a controller or pin: move the strip to
  another controller, pin or LED range and the scan still fits, as long as the same LEDs stay in the
  same order. If the LED count changes, the prop asks what happened – *Use the first/last N* when the
  strip was shortened, *Add N at the far end / where the data goes in* when it was lengthened (then
  *Scan the LEDs that aren't green* finds just the new ones) – and *Reverse LED order* covers a strip
  now fed from its other end. Moving a prop only needs new X/Y/Z values.

## Server and website (optional)

`server/` is a small Node service you run on a home server (Docker; see `server/README.md`). It
stores the project so every iPhone, iPad and Mac shares one copy (no more exporting and
importing), and hosts a website with the yard in 3D – the LiDAR scan plus every LED – that
previews the built-in effects exactly as the controllers render them and can send them to the
real lights. Shows can be edited there too, with the music and a live 3D preview. In the app: **Controllers → Server sync**.

While editing a show on the website, **💡 On the lights** puts the preview on the real lights as you
scrub and play: the browser draws every frame and the server sends it to the controllers (DDP takeover,
like xLights), so it works with any firmware that has DDP and nothing needs uploading. The music plays
on the computer. The controllers go back to their own look about 2.5 s after you turn it off (or close
the tab).

## Shows (music + timeline)

Needs firmware 1.3 or later on every controller.

1. **Shows tab → Scan the yard** (LiDAR iPhone/iPad). Walk slowly round the yard to capture it as a
   coloured 3D point cloud. To place a prop, pick it, aim the crosshair at the ground at its base
   and tap *Base is here*; its scanned LEDs appear over the real prop – turn it with the slider
   until they line up. The spot where the scan started becomes the front of the yard. A new yard
   scan has new axes, so place every prop again when you rescan.
2. **Arrange props in 3D** shows the yard scan with every prop on top. In *Move* mode drag a prop
   across the ground and twist with two fingers to turn it; X/Y/Z can also be typed.
3. **New show**, then *Show settings → Choose music*. The tempo and first beat are detected and
   drawn as a beat grid (use Half/Double if it picked half or double time, or put a beat at the
   playhead).
4. Add tracks: each plays on all props or on the props you tick (*Choose props…* in the track's
   menu). A track with several props can animate **each prop on its own** (every prop gets its
   own spiral, sweep and pulse, fitted to its size) or **all as one prop** (a spiral winds round
   the whole group, a sweep crosses it, a gradient runs from its lowest LED to its highest). Tap an empty spot on a track to add a
   clip, drag clips to move them (they snap to beats), drag the right edge to resize, and edit the
   effect, palette, colours, brightness and speed in the inspector. Speed is set in beats, so
   *Flash* at 1 beat flashes on every beat. Where tracks overlap, the lower track wins.
5. Press play. The music plays from the device running the app (connect it to a speaker). If the
   lights are ahead of or behind the music – Bluetooth speakers add delay – adjust *Lights delay*.

While a show is open in the editor, every controller's LEDs are off except while it plays, and
anything with no clip at that moment stays dark. A show that plays to the end also finishes dark.
Leaving the editor (or changing the look on the Lights tab) brings the normal look back.

How sync works: before playing, the app uploads the compiled show to every controller and measures
each controller's clock against its own (the quickest of several round trips). It then tells each
controller when, on its own clock, the show starts, and schedules the music for the same moment. The
controllers then run the show by themselves, so WiFi hiccups during the song don't matter.

**iPad and Mac.** The app runs on iPad and, on Apple Silicon Macs, as "Designed for iPad" (pick
*My Mac (Designed for iPad)* as the run destination in Xcode). Scanning needs an iPhone or iPad.
To edit on another device: *Shows → Share project…* on the iPhone (AirDrop or Save to Files), then
*Import project…* on the iPad/Mac. Importing replaces everything on that device, including its
controllers list, props, yard scan, shows and music.

## xLights

**Props as xLights models.** *Props → Export to xLights…* writes an `.xmodel` custom model for
each scanned prop, plus one for the whole yard with every prop in place. xLights custom models
are 3D grids, so each LED is rounded to the nearest grid point (1–10 cm, default 3 cm); LEDs
closer together than the grid are nudged to the nearest free point. Each physical string becomes a
string in the model, with its start channel written as `!<controller name>:<channel>`.

**Controllers as xLights controllers (firmware 1.4).** Each controller receives DDP on UDP port
4048. In xLights → Controllers, add an Ethernet controller per ESPectacle controller: protocol
DDP, its IP address, 3 channels per LED, and *exactly the same name* as in the app so the imported
models find their start channels. Then *Import Model* each `.xmodel` in the Layout tab. Channels
follow the controller's LED order (string 1 first). While DDP data arrives it overrides the
built-in effects and shows (with the app's brightness and current limit still applied); about
2.5 s after it stops the controller goes back to its own effects.

## HTTP API (port 80, JSON)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/info` | Identity, strings, state, WiFi status |
| POST | `/api/config` | `{name, maxMilliamps, strings:[{pin,count,order}]}` |
| GET/POST | `/api/state` | `{on, fx, pal, bri, spd, scl, c1, c2, dir, t}` – any subset; `t` = epoch ms; `dir` = `[dx,dy,dz]` direction of travel for moving effects (unit vector, 4096 = 1; +X right, +Y up, +Z towards the street) or `null` for the effect's default |
| POST | `/api/sync` | `{t}` – set the clock when NTP is unavailable |
| POST | `/api/scan?on=1\|0` | Enter/leave scan mode (all dark) |
| POST | `/api/solo?s=&i=&v=` | Light one LED (`i=-1` all off); replies after the LED has changed |
| POST | `/api/positions?offset=&total=[&final=1&base=&id=]` | `{g8:[x,y,z,h,ang,rad,d3,zone,…], zf:[…]}` – 8 integers per LED (see `Geo` in `effects.h`); `zone` is the prop, for show tracks; `zf` (last chunk) is each prop's box, 7 integers per zone (see `Frame`) |
| DELETE | `/api/positions` | Forget the map |
| GET | `/api/networks` | Scan for WiFi networks |
| POST | `/api/wifi` | `{ssid, pass}` then restart |
| POST | `/api/identify`, `/api/reboot` | |
| GET | `/api/time` | `{up}` – uptime clock (ms) used to line shows up with the music |
| GET/POST | `/api/show?offset=&total=&id=[&final=1]` | Upload `{s:[zone,t0,t1,p0,fx,pal,bri,scl,rate,c1,c2,mode,cx,cy,cz,half,ymin,height,radius,…]}` – 19 integers per segment (or 23 with `&per=23`: then `hasDir,dx,dy,dz`), sorted by zone then time; `mode` 1 = each prop on its own, 2 = the group box that follows treated as one prop |
| POST | `/api/show/play`, `/api/show/stop[?dark=1]` | `{id, start}` – start = controller uptime (ms) at show time 0; `dark=1` keeps every LED off until the next play or look change |

Controllers advertise `_espectacle._tcp` over mDNS (and `_treelights._tcp`, for app versions from before the rename). Their network name comes from the controller's name (firmware 1.13+): "Front Tree" is `front-tree.local` and registers as `front-tree` with the router's DHCP (letters, digits and dashes; an empty name falls back to `espectacle-xxxxxx`). Renaming takes effect on `.local` straight away and in the router's DNS after the controller restarts.

Effects (`fx`): 0 Solid, 1 Gradient, 2 Spiral, 3 Stripes, 4 Sweep, 5 Rings, 6 Beam, 7 Pulse,
8 Twinkle, 9 Glitter, 10 Plasma, 11 Fire, 12 Snow, 13 Chase, 14 Flash, 15 Meteor, 16 Ripple, 17 Spin,
18 Clouds (firmware 1.6+). Gradient, Sweep, Rings, Plasma, Meteor, Spin and Clouds follow `dir` when it is set.
2D camera effects (firmware 1.7+): 19 Bars, 20 Wave, 21 Radar, 22 Tunnel, 23 Checker – a flat picture as seen
from a camera; for these `dir` is the way the camera looks (default `[0,0,-4096]`, from the street).
Palettes (`pal`): 0 Custom (c1/c2), 1 Rainbow, 2 Christmas, 3 Ice, 4 Fire, 5 Candy cane,
6 Warm gold, 7 Aurora. To add an effect, add a `case` to `fxPixel()` in
`firmware/src/effects.cpp` (integer maths only – the S2 has no FPU) and an entry in
`ios/ESPectacle/Model/EffectCatalog.swift` and `server/shared/catalog.ts` (then `npm run build:wasm`).

## Online effects (Marquee, Video)

Effects 200+ are drawn by the server rather than the controllers and streamed to them about 30 times a
second with DDP to destination 2 (the "online layer", firmware 1.8+). The controllers keep running the
look or show; LEDs whose current effect is an online one show the layer (dark if nothing has arrived in
the last second). So they work in the normal look, in shows played by the app (it tells the server
when show time 0 is: `POST /api/online/show {id, start}` / `POST /api/online/stop`) and in schedules,
but only while the server is running. Like the 2D effects they draw a flat picture seen from the camera,
using the LEDs' exact positions, so a matrix panel shows crisp text.

- **Marquee**: scrolling text (8-pixel font; fits a panel's height at the middle text size).
- **Video**: upload on the website (Look tab → Video → Upload); ffmpeg (in the Docker image) shrinks it
  to 64 px wide, 20 fps, first 2 minutes, looped. `GET/PUT/DELETE /api/media[/name]`.

The **Panel** prop type is an LED matrix (8×8, 16×16, 32×8, 8×32 or custom; LED spacing; panels
across/down; first-LED corner, rows/columns, zigzag).

## Phones, Android and the website

Everything except scanning works from the website, on a computer or a phone (Android included):

- **Devices → Add controller** by its address (controllers built on the server also say hello and
  appear by themselves), then **Set up** for its name, LED strings (GPIO, LED count, colour order) and
  current limit. Saving writes it to the controller, as the app does.
- **Props → Wiring**: tick the strings on each prop, or use LED ranges.
- Looks, shows, schedules, drawn props, fine-tuning LED positions, firmware and Home Assistant are all
  there too. Without a scan, use drawn shapes and type each prop's position.

On a phone the 3D view sits on top and the controls below. To keep it on your home screen like an app:
Chrome → ⋮ → **Add to Home screen** (or **Install app**). It opens full-screen as its own app only when
the server is on HTTPS (for example behind Home Assistant's NGINX add-on or Caddy); over plain HTTP it
opens as a browser shortcut.

## Devices and firmware updates

Website → **Devices** lists every controller with its firmware, board, LEDs, WiFi and
uptime, plus Identify and Restart. **Updates over WiFi**: firmware files live on the server in
`data/firmware/`. Building with PlatformIO copies each build there automatically as
`espectacle-<version>-<env>.bin` (`firmware/tools/espectacle_build.py`; set `ESPECTACLE_FIRMWARE_DIR` if
the server's data folder is elsewhere), or upload a `firmware.bin` on the Devices tab. Each file carries
its version and board, so a controller is only offered files built for its board; **Update** sends it
(`POST /api/update` on the controller, multipart) and waits for it to come back on the new version. The
app's controller screen has the same button (via the server). Controllers need firmware 1.10+ (one USB
flash) to update over WiFi.

## Building firmware on the server (like ESPHome)

The Docker image includes PlatformIO, so the server can build the firmware itself, with your WiFi, the
controller's name, LED pin and LED count, and the server's address baked in, for the board you pick.

1. Mount the firmware source into the container: in `server/docker-compose.yml`, under `volumes:`, add
   `- ../firmware:/firmware:ro`, then `docker compose up -d --build` (the image is now Debian-based and
   larger, about 600 MB, because of Python and PlatformIO).
2. Website → **Settings → Firmware builds**: WiFi name and password, and this server's address as the
   controllers reach it (your Mac's LAN address, e.g. `http://192.168.1.20:8080`, not localhost).
3. **Devices → Build firmware**: pick the board, name, pin and LED count, then **Build**. The first build
   downloads the ESP32 toolchain into `data/platformio` (a few minutes, ~1 GB); later builds take about a
   minute. Each build also lands in the firmware library for WiFi updates.
4. **Install over USB…** flashes it from the browser (ESP Web Tools). Web Serial only works in Chrome or Edge
   on `http://localhost:8080` (or https), on the computer the board is plugged into; anywhere else use
   **Download** and flash the file at 0x0 with esptool. S2 Mini: hold button 0 and tap RST first.

On boot a built controller joins your WiFi and says hello to the server (`POST /api/hello`); it then appears
under **New controllers** on the Devices tab, where **Add** adds it with its LED strings. Known controllers
that get a new IP from DHCP are followed automatically. For existing controllers, **Build & update** builds
for their board and sends it over WiFi. The WiFi password is stored only on the server (and inside the
firmware files it builds, so treat those like the password).

## Countdown

Online effect 202: "32 DAYS", then "05:12:09" on the last day, then your message (default MERRY
CHRISTMAS). Counts to midnight at the start of Christmas Day in your time zone (taken from the browser
that saves Settings or schedules), or to any date and time you pick. Fits a panel without scrolling when
the text is short enough.

## Home Assistant

**As an add-on:** Settings → Add-ons → Add-on Store → ⋮ → Repositories, add
`https://github.com/spinbot/espectacle`, then install **ESPectacle**, set a password in its
Configuration tab and start it. The website opens with *Open Web UI* (port 8080). It runs the same server
as the Docker image, on the host network so it can reach the controllers, with its data in Home
Assistant's backups (apart from the ESP32 build toolchain, which is downloaded again when needed).
Installing firmware over USB from the browser needs HTTPS or localhost, so from Home Assistant use
*Download* and flash it, or use a release image.

**MQTT and REST** – website → Settings. **MQTT discovery**: give the broker (e.g. the Mosquitto add-on) and ESPectacle shows
up as a device with a light (on/off, brightness, effect list, colour), a Show select (plays a show once,
lights only), a Schedules switch, a Message text, a Stop-show button and a Now-playing sensor. Topics live
under `espectacle/…`; availability on `espectacle/status`; entity IDs start `espectacle_` (e.g.
`light.espectacle_lights`, `select.espectacle_show`). Before the rename they were `treelights_…`: the
server removes those old entities when it connects, so update any automations, scripts or dashboards
that used them.

**Messages** scroll over everything on the chosen props (even with the lights off) for the set time, via
the controllers' overlay (DDP destination 3, firmware 1.9+).

**REST** (same password as the app, `Authorization: Bearer <password>`): `GET /api/ha/state`,
`POST /api/ha/look {on, bri, effect, rgb, pal, spd, scl, text, target}`, `POST /api/ha/message {text,
seconds, rgb}`, `DELETE /api/ha/message`, `POST /api/ha/show {show}`, `POST /api/ha/show/stop`,
`POST /api/ha/schedules {enabled}`. The Settings tab shows ready-made `rest_command` YAML.

## Schedules

Website → Schedule tab. Each schedule has days, a start and end time (an end at or before the start runs
past midnight), a list of shows played in order and looped, and what happens at the end (all LEDs off,
or back to the normal look). The server runs them, so neither the app nor a browser needs to be open:
it sends the geometry if needed, uploads each show and starts every controller together. Lights only –
no music. Times are in the time zone of the browser that last edited them. "Stop until this one ends"
pauses the running schedule until its end time. Status: `GET /api/schedule/status`.

## Yard: street direction

The yard's axes come from where the phone faced when the yard scan started. Props tab → Yard → Street
direction turns them (blue arrow on the website, white dot in the app's preview) so the street is the
front: effect directions and camera views are measured from it. The controllers get geometry turned by
this angle; LED positions and prop placements don't change.

## Drawn props, clones and shared strings

- **Drawn shapes** (Props tab in the app or on the website → Add): grid, cone (mega tree: strands or one
  spiral), polyline, circle and arch. Set the size, where the first LED is and how it is wired (zigzag,
  rows/columns, clockwise...), and the LED count directly or as LEDs per metre. No scanning needed.
- **Clone** copies a prop's shape (scanned or drawn) half a metre to the right. Give the copy its own LEDs.
- **LED ranges** let several props share one string: each range is a controller string, the first LED
  (numbered from 1) and a count; a prop's ranges run one after another. Props without ranges use the
  whole strings assigned to them, as before.
- Every map (scanned, drawn or cloned) is valid whenever the prop's LED count matches, whichever
  controllers, strings or ranges feed it.
- **Fine-tune LED positions** (website, Props tab → open a scanned prop): the view flies to the prop,
  seen from the side it was scanned from, filling the screen. Click an LED in the 3D view –
  it lights up white on the real prop and gets a yellow ring – then nudge it with the arrow buttons
  (they follow the view: ← is left as you see it; Further/Closer move it away or towards you) or type
  its X/Y/Z. Keys: `[` `]` previous/next LED, Alt+arrows to move, Alt+Shift+↑/↓ further/closer,
  Ctrl/⌘+Z undo. Steps from 0.5 to 10 cm. **Straight runs:** place both ends, *Mark … as one end*,
  select the other end (cyan and yellow rings; on the real prop the ends light white and the run dim
  blue), then *Straighten* spaces every LED between them evenly along the line. Moved LEDs count as good, so a partial rescan leaves them
  alone, and the server sends the new positions to the controllers a couple of seconds after each change.

## Releasing

1. Bump `FW_VERSION` in `firmware/src/settings.h` and `version` in `ha-addon/config.yaml` (keep them the same).
2. Commit, then tag and push: `git tag v1.15.0 && git push origin main v1.15.0`.
3. GitHub Actions then builds the firmware for every board into a release (`firmware.yml`; it stops if
   the tag and `FW_VERSION` differ) and the Docker image for amd64 and arm64 as
   `ghcr.io/spinbot/espectacle:1.15.0`, `:1.15` (`docker.yml`). Every push to `main` that touches the
   server or firmware also updates `:latest`. The Home Assistant add-on pulls the image matching its `version`.

The first time the image is published, make it public: GitHub → your profile → Packages → espectacle →
Package settings → Change visibility → Public.

## Notes

- The API is unauthenticated and the setup hotspot is open; keep controllers on a trusted network.
- Frame rate is up to 60 fps and falls as strings get longer (WS281x data takes 30 µs per LED; strings
  on one controller are sent together). Splitting long runs across pins or controllers keeps it smooth.

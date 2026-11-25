# ESPectacle server

Keeps the ESPectacle project (props and their scans, the yard scan, shows, music) in one place,
so the iPhone, iPad, Mac and a web browser all work on the same copy. It also hosts the web
editor: a 3D view of the yard that previews the built-in effects exactly as the controllers
render them (the firmware's effect code, compiled to WebAssembly), and can send a look to the
real lights.

## Run it (Docker, e.g. on Proxmox)

On any Docker host on your home network (a small Debian/Ubuntu LXC or VM on Proxmox with Docker
installed works well):

```
cd server
cp .env.example .env && chmod 600 .env
nano .env                    # set ESPECTACLE_PASSWORD
docker compose up -d --build
```

The password lives in `server/.env`, which git ignores and the Docker build leaves out, so
`docker-compose.yml` can be committed safely. Compose reads it through `env_file: .env`.

Then open `http://<host-ip>:8080` in a browser. Everything is stored in `server/data/` (back
this folder up). The container needs to reach the controllers' IP addresses on your LAN; the
default Docker network does that.

Without Docker: Node 20+, then `npm ci && npm run build && ESPECTACLE_PASSWORD=… npm start`.

| Variable | Default | |
|---|---|---|
| `PORT` | 8080 | |
| `ESPECTACLE_DATA` | `./data` (`/data` in Docker) | data folder |
| `ESPECTACLE_PASSWORD` | – | password for the app and website; unset = open to the network |
| `ESPECTACLE_FIRMWARE_SRC` | `/firmware` | firmware source for building on the server |

The older `TREELIGHTS_…` names still work.

To reach it away from home, use a VPN (Tailscale, WireGuard, or Home Assistant's remote access);
don't expose it directly to the internet.

## Backup and restore

Website → **Settings → Backup & restore**. *Download backup* saves one `espectacle-backup-<date>.tar.gz`
with the project (props, scans, shows, schedules), the server settings (including the WiFi and MQTT
passwords, so keep it safe), the yard scan, music, videos and firmware files. The PlatformIO tools and
build folders are left out (they download again) and so is the login secret (you just log in again).

*Restore from a backup…* uploads one: the project and settings are replaced, the files added, and every
app and browser picks up the restored project straight away (it is saved as a newer revision than
anything they have). Use it to move the server to another machine, rename its container or folder, or
start the data folder afresh.

## Connect the app

In the app: **Controllers → Server sync**, enter `http://<host-ip>:8080` and the password, tap
**Connect**. If both the phone and the server already have a project you're asked which wins.
After that the app pushes its changes a couple of seconds after you make them and checks for
changes from elsewhere every 20 s. Prop placements edited on the website reach the controllers
when an app next syncs.

## Website

- **Look**: pick an effect, palette, colours, speed and scale; the 3D view animates it. Tick
  *Also show on the real lights* to send it to every controller as you change it.
- **Props**: move or turn props (metres / degrees). Saved for every device.
- **Shows**: the show timeline – music with waveform and detected beat grid, tracks for all props
  or chosen props (each on its own, or as one), clips with effect, palette, colours, brightness
  and speed in beats. Press play (or space) to hear the music and watch the show in the 3D view,
  rendered exactly as the controllers will. Shows are shared with the app, which plays them on
  the real lights.

## API (all under `/api`, password as `Authorization: Bearer …` or the website's login cookie)

| Method | Path | |
|---|---|---|
| POST | `/login` | `{password}` → cookie |
| GET | `/project`, `/revision` | the project and its revision number |
| PUT | `/project` | `{baseRevision, data, force?}`; 409 with the current project if someone saved in between |
| GET | `/events` | Server-Sent Events: `{revision}` after every change |
| GET/PUT | `/area` | yard scan (the app's `area.bin` format) |
| GET | `/audio` | music files on the server |
| GET/PUT | `/audio/<name>` | one music file |
| GET | `/status` | latest `/api/info` from each controller |
| POST | `/lights/state` | send a look to every controller |
| GET | `/backup` | everything the server keeps as one `.tar.gz` (project, settings incl. passwords, yard scan, music, videos, firmware) |
| POST | `/restore` | upload a backup (`.tar.gz` body): replaces the project and settings, adds the files |

## Development

```
npm install
npm run build        # web/public/app.js and dist/server.js
npm run typecheck
npm run build:wasm   # rebuild web/public/fx.wasm after changing firmware/src/effects.cpp (needs clang + wasm-ld)
```

The layout maths in `shared/layout.ts` is a port of the app's `TreeStore` geometry code; keep the
two in step.

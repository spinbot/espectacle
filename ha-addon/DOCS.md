# ESPectacle

The ESPectacle server as a Home Assistant add-on: the website with the 3D yard, looks, shows, schedules,
props, backup and restore, and building and updating controller firmware.

## Options

- **password**: needed to open the website and to connect the iPhone app. Leave it empty only on a
  network you trust.
- **port**: the website's port (default 8080). The add-on uses the host network so it can reach your
  controllers, so pick a port nothing else on this machine uses.

## After starting

1. Open the website with **Open Web UI** (or `http://<home-assistant-address>:8080`).
2. **Settings → Firmware builds**: your WiFi, and this server's address as the controllers reach it,
   e.g. `http://192.168.1.10:8080`.
3. **Devices → Build firmware** builds for your board. Installing over USB from the browser needs HTTPS
   or localhost, so from Home Assistant use **Download** and flash it at 0x0 with esptool, or the
   ready-made images on the project's GitHub releases page.
4. **Settings → Home Assistant**: point MQTT at your broker (e.g. `core-mosquitto`, port 1883) and
   ESPectacle appears as a device with a light, a show picker and more.

Everything is stored in the add-on's data folder and included in Home Assistant backups, apart from the
ESP32 toolchain. ESPectacle's own **Settings → Backup & restore** works too.

More: https://github.com/spinbot/espectacle

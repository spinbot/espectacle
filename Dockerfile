# The published image (ghcr.io/spinbot/espectacle): the server, with the firmware source built in so
# that "Build firmware" works without mounting anything. Also what the Home Assistant add-on runs.
# Build from the repository root:   docker build -t espectacle .
# (server/Dockerfile is the same server for building inside server/ with docker compose.)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

FROM node:22-bookworm-slim
# ffmpeg decodes uploaded videos (Video effect). Python + PlatformIO build controller firmware; PlatformIO
# downloads the ESP32 toolchain into /data/platformio the first time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/pio && /opt/pio/bin/pip install --no-cache-dir platformio
WORKDIR /app
ENV NODE_ENV=production ESPECTACLE_DATA=/data PORT=8080 ESPECTACLE_FIRMWARE_SRC=/firmware \
    PATH=/opt/pio/bin:$PATH PLATFORMIO_CORE_DIR=/data/platformio
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/public ./web/public
COPY firmware/platformio.ini /firmware/
COPY firmware/src /firmware/src
COPY firmware/tools /firmware/tools
LABEL org.opencontainers.image.source="https://github.com/spinbot/espectacle" \
      org.opencontainers.image.description="ESPectacle server: 3D-mapped LED displays for ESP32" \
      org.opencontainers.image.licenses="MIT"
VOLUME /data
EXPOSE 8080
# Runs as root so it can write to whatever /data it's given (Home Assistant add-ons, NAS volumes).
CMD ["node", "--enable-source-maps", "dist/server.js"]

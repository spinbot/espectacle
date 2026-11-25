# ESPectacle server. Build:  docker build -t espectacle .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Source files may arrive readable only by their owner; make them readable for the runtime user.
RUN chmod -R a+rX /app && npm run build

FROM node:22-bookworm-slim
# ffmpeg decodes uploaded videos for the Video online effect. Python + PlatformIO build controller firmware
# (Devices → Build firmware); PlatformIO downloads the ESP32 toolchain into /data/platformio on first use.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/pio && /opt/pio/bin/pip install --no-cache-dir platformio
WORKDIR /app
ENV NODE_ENV=production ESPECTACLE_DATA=/data PORT=8080 \
    PATH=/opt/pio/bin:$PATH PLATFORMIO_CORE_DIR=/data/platformio
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/web/public ./web/public
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "--enable-source-maps", "dist/server.js"]

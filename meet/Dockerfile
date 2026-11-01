FROM mcr.microsoft.com/playwright:v1.64.1-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends pulseaudio xvfb ffmpeg xdotool x11vnc novnc websockify \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# The base image already holds the browsers for this exact Playwright version.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist/runner.mjs dist/login.mjs ./dist/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh && mkdir -p /work /out

ENTRYPOINT ["/app/entrypoint.sh"]

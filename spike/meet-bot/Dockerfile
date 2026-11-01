FROM mcr.microsoft.com/playwright:v1.64.1-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends pulseaudio xvfb ffmpeg xdotool x11vnc novnc websockify \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN npm init -y >/dev/null && npm install playwright@1.64.1
COPY join.mjs human.mjs login.mjs metrics.mjs entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]

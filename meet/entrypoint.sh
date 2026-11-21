#!/bin/bash
set -e
export DISPLAY=:99
export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p "$XDG_RUNTIME_DIR" /work

# Background daemons must not hold this script's stdin or stdout: the runner reads its job from stdin,
# and an inherited stdout keeps an exec stream open forever.
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp </dev/null >/dev/null 2>&1 &

if [ "$1" = "login" ]; then
  sleep 1
  x11vnc -display :99 -forever -nopw -quiet -rfbport 5900 </dev/null >/dev/null 2>&1 &
  websockify --web /usr/share/novnc 6080 localhost:5900 </dev/null >/dev/null 2>&1 &
  exec node /app/dist/login.mjs
fi

pulseaudio --start --exit-idle-time=-1 --daemonize=yes --disallow-exit </dev/null >/dev/null 2>&1
# Chromium plays the call into "meet"; the runner records meet.monitor.
pactl load-module module-null-sink sink_name=meet sink_properties=device.description=meet >/dev/null
# The default microphone is a silent sink's monitor, so the bot can never send the call audio back into the call.
pactl load-module module-null-sink sink_name=mic sink_properties=device.description=mic >/dev/null
pactl set-default-sink meet
pactl set-default-source mic.monitor
exec node /app/dist/runner.mjs

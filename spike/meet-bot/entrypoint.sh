#!/bin/bash
set -e
export DISPLAY=:99
export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p "$XDG_RUNTIME_DIR" /out

# Background daemons must not hold this script's stdout, or a streamed exec never ends.
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &

if [ "$1" = "login" ]; then
  sleep 1
  x11vnc -display :99 -forever -nopw -quiet -rfbport 5900 >/dev/null 2>&1 &
  websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
  exec node login.mjs
fi

pulseaudio --start --exit-idle-time=-1 --daemonize=yes --disallow-exit >/dev/null 2>&1
pactl load-module module-null-sink sink_name=meet sink_properties=device.description=meet >/dev/null
pactl set-default-sink meet
node metrics.mjs >/dev/null 2>&1 &

exec node join.mjs

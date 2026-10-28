#!/bin/bash
set -e
export DISPLAY=:99
export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p "$XDG_RUNTIME_DIR" /out

Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &

if [ "$1" = "login" ]; then
  sleep 1
  x11vnc -display :99 -forever -nopw -quiet -rfbport 5900 &
  websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
  exec node login.mjs
fi

pulseaudio --start --exit-idle-time=-1 --daemonize=yes --disallow-exit
pactl load-module module-null-sink sink_name=meet sink_properties=device.description=meet
pactl set-default-sink meet

exec node join.mjs

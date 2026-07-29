#!/usr/bin/env bash
set -euo pipefail
OUT="assets/video/amberone-hero.mp4"
mkdir -p assets/video
FONT="C:/Windows/Fonts/georgia.ttf"
# Escape for ffmpeg drawtext: colon and special chars
ffmpeg -y -f lavfi -i "color=c=0xe8e3da:s=720x960:d=20" \
  -vf "drawbox=x=28:y=28:w=664:h=904:color=0xfaf8f4@0.96:t=fill,\
drawbox=x=28:y=28:w=664:h=6:color=0xc48912:t=fill,\
drawtext=fontfile=${FONT}:text='AmberOne':fontcolor=0x2c2a26:fontsize=64:x=(w-text_w)/2:y=140,\
drawtext=fontfile=${FONT}:text='One Assistant. One Place. One Life.':fontcolor=0x5e5950:fontsize=22:x=(w-text_w)/2:y=220,\
drawtext=fontfile=${FONT}:text='Your AI operating system':fontcolor=0xc48912:fontsize=30:x=(w-text_w)/2:y=360:enable='lt(t\,5)',\
drawtext=fontfile=${FONT}:text='Talk  Remember  Schedule  Guide':fontcolor=0x2c2a26:fontsize=24:x=(w-text_w)/2:y=420:enable='lt(t\,5)',\
drawtext=fontfile=${FONT}:text='Personal life':fontcolor=0xc48912:fontsize=34:x=(w-text_w)/2:y=360:enable='between(t\,5\,10)',\
drawtext=fontfile=${FONT}:text='Calendar reminders notes briefings':fontcolor=0x2c2a26:fontsize=22:x=(w-text_w)/2:y=420:enable='between(t\,5\,10)',\
drawtext=fontfile=${FONT}:text='Family and work':fontcolor=0xc48912:fontsize=34:x=(w-text_w)/2:y=360:enable='between(t\,10\,15)',\
drawtext=fontfile=${FONT}:text='Chores CRM meetings appointments':fontcolor=0x2c2a26:fontsize=22:x=(w-text_w)/2:y=420:enable='between(t\,10\,15)',\
drawtext=fontfile=${FONT}:text='Amber stays until finished':fontcolor=0xc48912:fontsize=30:x=(w-text_w)/2:y=360:enable='gte(t\,15)',\
drawtext=fontfile=${FONT}:text='Guide  verify  recover  learn':fontcolor=0x2c2a26:fontsize=22:x=(w-text_w)/2:y=420:enable='gte(t\,15)',\
drawtext=fontfile=${FONT}:text='What AmberOne does':fontcolor=0x8a847a:fontsize=20:x=(w-text_w)/2:y=820" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$OUT"
ls -la "$OUT"

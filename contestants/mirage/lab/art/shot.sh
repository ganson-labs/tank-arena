#!/bin/zsh
# usage: shot.sh <query-string> <out.png> [WxH]
# renders lab/art/preview.html?<query> with headless Chrome
ART="$(cd "$(dirname "$0")" && pwd)"
SIZE="${3:-1400,900}"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --allow-file-access-from-files --virtual-time-budget=4000 \
  --window-size="$SIZE" --screenshot="$2" "file://$ART/preview.html?$1" 2>/dev/null
ls -la "$2"

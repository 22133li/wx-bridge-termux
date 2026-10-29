#!/data/data/com.termux/files/usr/bin/bash
# wx-bridge phone bootstrap: fetch the login script and run it.
set -e
cd "$HOME"
mkdir -p wx-bridge/state
curl -sL https://raw.githubusercontent.com/22133li/wx-bridge-termux/main/login.mjs -o wx-bridge/login.mjs
cd wx-bridge
node login.mjs

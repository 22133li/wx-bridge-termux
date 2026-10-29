#!/data/data/com.termux/files/usr/bin/bash
# wx-bridge phase 2: one-time relay-token setup + start the daemon.
set -e
cd "$HOME/wx-bridge"
if [ ! -f state/account.json ]; then
  echo "未找到登录凭据，请先跑登录：curl -sL https://raw.githubusercontent.com/22133li/wx-bridge-termux/main/bootstrap.sh | bash"
  exit 1
fi
curl -sL https://raw.githubusercontent.com/22133li/wx-bridge-termux/main/bridge.mjs -o bridge.mjs
if [ ! -f state/relay.json ]; then
  echo "首次设置：请粘贴中继仓库的 GitHub 令牌（输入不显示，粘好后按回车）："
  read -s -r PAT < /dev/tty
  printf '{"pat":"%s"}' "$PAT" > state/relay.json
  chmod 600 state/relay.json
  echo "令牌已保存（仅本机）。"
fi
termux-wake-lock 2>/dev/null || true
if [ -f bridge.pid ] && kill -0 "$(cat bridge.pid)" 2>/dev/null; then
  echo "桥接已在运行（PID $(cat bridge.pid)），最近日志："
  tail -n 15 bridge.log || true
  exit 0
fi
nohup node bridge.mjs > bridge.log 2>&1 &
echo $! > bridge.pid
sleep 4
echo "桥接已启动（PID $(cat bridge.pid)），最近日志："
tail -n 15 bridge.log || true
echo "提示：让 Termux 保持后台存活（华为手机管家/电池设置里把 Termux 设为允许后台运行）。"

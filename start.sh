#!/data/data/com.termux/files/usr/bin/bash
# wx-bridge phase 2: deploy-key setup + start the daemon. No GitHub password
# or token is ever typed here; the phone generates its own SSH keypair.
set -e
cd "$HOME"
mkdir -p wx-bridge/state .ssh
if ! command -v git >/dev/null 2>&1 || ! command -v ssh-keygen >/dev/null 2>&1; then
  echo "正在安装 git / openssh……"
  pkg install -y git openssh
fi
if [ ! -f wx-bridge/state/account.json ]; then
  echo "未找到登录凭据，请先跑登录：curl -sL https://raw.githubusercontent.com/22133li/wx-bridge-termux/main/bootstrap.sh | bash"
  exit 1
fi
if [ ! -f .ssh/wxrelay ]; then
  ssh-keygen -t ed25519 -N "" -f .ssh/wxrelay -C wx-bridge-phone >/dev/null
  echo "本机密钥已生成。"
fi
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/wxrelay -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if ! git ls-remote git@github.com:22133li/wx-bridge-relay.git >/dev/null 2>&1; then
  echo ""
  echo "=== 还差一步：把下面这一整行发给关博（这是公钥，可以公开） ==="
  cat .ssh/wxrelay.pub
  echo "=== 发完等关博回复「好了」，把本命令原样再跑一次即可 ==="
  exit 0
fi
cd wx-bridge
if [ ! -d relay/.git ]; then
  git clone -q git@github.com:22133li/wx-bridge-relay.git relay
  cd relay && git config user.email "wx-bridge@phone" && git config user.name "wx-bridge" && cd ..
fi
curl -sL https://raw.githubusercontent.com/22133li/wx-bridge-termux/main/bridge.mjs -o bridge.mjs
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

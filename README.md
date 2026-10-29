# wx-bridge-termux

Standalone WeChat iLink Bot login for Termux (Android), adapted from the
protocol used by `@tencent-weixin/openclaw-weixin` (Tencent iLink Bot API).
No OpenClaw required. The bot token is stored only on the phone
(`~/wx-bridge/state/account.json`, mode 0600).

One-line run (in Termux):

    pkg update -y && pkg install -y curl nodejs-lts qrencode && curl -sL https://raw.githubusercontent.com/22133li/wx-bridge-termux/main/bootstrap.sh | bash

// wx-bridge phone login (Termux) — standalone iLink Bot QR login.
// Protocol mirrors @tencent-weixin/openclaw-weixin 2.4.10 (read from its dist):
//   POST ilink/bot/get_bot_qrcode?bot_type=3 {local_token_list: []}
//   GET  ilink/bot/get_qrcode_status?qrcode=... [&verify_code=...]  (long-poll)
// On "confirmed": saves {token, botId, userId, baseUrl} to state/account.json (0600).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFile } from "node:child_process";

const BASE = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const STATE_DIR = path.join(process.env.HOME, "wx-bridge", "state");
const ACCOUNT = path.join(STATE_DIR, "account.json");
const QR_PNG = path.join(process.env.HOME, "wx-bridge", "qr.png");
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10); // plugin 2.4.10

fs.mkdirSync(STATE_DIR, { recursive: true });

function commonHeaders() {
  return { "iLink-App-Id": "bot", "iLink-App-ClientVersion": CLIENT_VERSION };
}
function postHeaders() {
  const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
  return { "Content-Type": "application/json", AuthorizationType: "ilink_bot_token", "X-WECHAT-UIN": uin, ...commonHeaders() };
}
async function fetchQR(baseUrl) {
  const res = await fetch(new URL(`ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, baseUrl + "/"), {
    method: "POST", headers: postHeaders(), body: JSON.stringify({ local_token_list: [] }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`get_bot_qrcode ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
async function pollStatus(baseUrl, qrcode, verifyCode) {
  let ep = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) ep += `&verify_code=${encodeURIComponent(verifyCode)}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 35000);
  try {
    const res = await fetch(new URL(ep, baseUrl + "/"), { headers: commonHeaders(), signal: ctl.signal });
    if (!res.ok) return { status: "wait" };
    return JSON.parse(await res.text());
  } catch { return { status: "wait" }; }
  finally { clearTimeout(t); }
}
async function showQR(qrUrl) {
  console.log("\n二维码链接: " + qrUrl);
  try {
    const QRCode = (await import("qrcode")).default;
    await QRCode.toFile(QR_PNG, qrUrl, { width: 720, margin: 2 });
    console.log("二维码图片已生成，正在打开……请用 iPhone 上的微信扫描这台安卓机屏幕上的二维码。");
    execFile("termux-open", [QR_PNG], () => {});
  } catch {
    console.log("(二维码图片生成失败，请把上面的链接想办法发到另一台设备上打开/扫码)");
  }
}
function askLine(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (ans) => { rl.close(); resolve(ans.trim()); }));
}

const deadline = Date.now() + 8 * 60_000;
let baseUrl = BASE;
let refreshCount = 0;
let qr = await fetchQR(baseUrl);
let qrcode = qr.qrcode;
showQR(qr.qrcode_img_content);
let pendingCode = null;
let scanned = false;

while (Date.now() < deadline) {
  const st = await pollStatus(baseUrl, qrcode, pendingCode);
  switch (st.status) {
    case "wait": break;
    case "scaned":
      if (!scanned) { scanned = true; console.log("\n已扫码，正在验证…"); }
      if (pendingCode) pendingCode = null;
      break;
    case "need_verifycode": {
      const code = await askLine(pendingCode ? "\n数字不匹配，请重新输入 iPhone 微信上显示的数字: " : "\n请输入 iPhone 微信上显示的数字: ");
      pendingCode = code || null;
      break;
    }
    case "expired": {
      refreshCount++;
      if (refreshCount > 3) { console.log("\n二维码多次失效，请重新运行脚本。"); process.exit(2); }
      console.log(`\n二维码已过期，正在刷新 (${refreshCount}/3)…`);
      qr = await fetchQR(baseUrl);
      qrcode = qr.qrcode;
      scanned = false;
      showQR(qr.qrcode_img_content);
      break;
    }
    case "verify_code_blocked":
      console.log("\n数字多次输入错误，流程已停止，请稍后再试。");
      process.exit(1);
    case "binded_redirect":
      console.log("\n这个机器人已经连接过了，无需重复登录。");
      process.exit(3);
    case "scaned_but_redirect":
      if (st.redirect_host) { baseUrl = `https://${st.redirect_host}`; }
      break;
    case "confirmed": {
      const account = { token: st.bot_token, botId: st.ilink_bot_id, userId: st.ilink_user_id, baseUrl: st.baseurl || baseUrl, savedAt: new Date().toISOString() };
      fs.writeFileSync(ACCOUNT, JSON.stringify(account, null, 2), { mode: 0o600 });
      console.log(`\n✅ 已连接！机器人 ID: ${st.ilink_bot_id}`);
      console.log("登录凭据已保存在本机 ~/wx-bridge/state/account.json");
      process.exit(0);
    }
    default: break;
  }
  await new Promise(r => setTimeout(r, 1000));
}
console.log("\n等待超时，请重新运行脚本。");
process.exit(1);

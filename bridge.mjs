// wx-bridge daemon (Termux): long-polls iLink getupdates, relays messages
// to/from the private GitHub relay repo (22133li/wx-bridge-relay).
// Zero dependencies (Node >= 18). Credentials live only on this phone:
//   ~/wx-bridge/state/account.json  (iLink bot token, from login.mjs)
//   ~/wx-bridge/state/relay.json    ({"pat": "..."} GitHub fine-grained PAT)
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";

const STATE = process.env.HOME + "/wx-bridge/state";
const RELAY = "22133li/wx-bridge-relay";
const PLUGIN_VERSION = "2.4.10";
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 10; // 132106

const log = (...a) => console.log(new Date().toISOString(), ...a);
const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const saveJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2), { mode: 0o600 });

const account = loadJson(STATE + "/account.json");
const relay = loadJson(STATE + "/relay.json");
const BASE = account.baseUrl || "https://ilinkai.weixin.qq.com";
let syncBuf = "";
try { syncBuf = loadJson(STATE + "/sync.json").get_updates_buf || ""; } catch {}

const uin = () => Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");

async function ilink(endpoint, body, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + "/" + endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": String(CLIENT_VERSION),
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": uin(),
        Authorization: "Bearer " + account.token,
      },
      body: JSON.stringify({ ...body, base_info: { channel_version: PLUGIN_VERSION, bot_agent: "OpenClaw" } }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    // uint64 message_id would lose precision in JSON.parse; quote it first.
    return JSON.parse(raw.replace(/"(message_id)"\s*:\s*(\d{10,})/g, '"$1":"$2"'));
  } finally { clearTimeout(t); }
}

const GH = "https://api.github.com/repos/" + RELAY + "/contents";
async function gh(method, path, body) {
  const res = await fetch(GH + "/" + path, {
    method,
    headers: {
      Authorization: "Bearer " + relay.pat,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "wx-bridge-termux",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("GitHub " + method + " " + path + " -> " + res.status + " " + (data.message || ""));
  return data;
}
const b64e = (s) => Buffer.from(s, "utf8").toString("base64");
const b64d = (s) => Buffer.from(String(s).replace(/\n/g, ""), "base64").toString("utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pushed = new Set();
async function pushInbox(msg) {
  const name = String(msg.message_id) + ".json";
  if (pushed.has(name)) return;
  let text = "";
  for (const it of msg.item_list || []) {
    if (it.type === 1 && it.text_item?.text) text += it.text_item.text;
    else if (it.type === 3 && it.voice_item?.text) text += it.voice_item.text;
    else if (it.type === 2) text += "[图片]";
    else if (it.type === 5) text += "[视频]";
    else if (it.type === 4) text += "[文件 " + (it.file_item?.file_name || "") + "]";
  }
  const payload = {
    id: String(msg.message_id),
    from: msg.from_user_id || "",
    text: text.trim(),
    context_token: msg.context_token || "",
    ts: msg.create_time_ms || Date.now(),
  };
  try {
    await gh("PUT", "inbox/" + name, { message: "wx msg " + payload.id, content: b64e(JSON.stringify(payload)) });
    log("📩 已转发到中继:", payload.text.slice(0, 80));
  } catch (e) {
    if (String(e.message).includes("422")) { /* already in relay */ }
    else throw e;
  }
  pushed.add(name);
}

async function inboundLoop() {
  try { await ilink("ilink/bot/msg/notifystart", {}, 15000); log("notifyStart 已发送"); }
  catch (e) { log("notifyStart 失败(忽略):", e.message); }
  for (;;) {
    try {
      const resp = await ilink("ilink/bot/getupdates", { get_updates_buf: syncBuf });
      if (resp.errcode === -14) {
        log("⛔ 登录态已失效(errcode -14)，请重新运行登录脚本扫码。桥接退出。");
        process.exit(3);
      }
      if (resp.ret && resp.ret !== 0) {
        log("getupdates ret=" + resp.ret + " errmsg=" + (resp.errmsg || ""));
        await sleep(5000);
        continue;
      }
      if (resp.get_updates_buf) { syncBuf = resp.get_updates_buf; saveJson(STATE + "/sync.json", { get_updates_buf: syncBuf }); }
      for (const m of resp.msgs || []) {
        if (m.message_type !== 1) continue;
        if (account.botId && m.from_user_id === account.botId) continue;
        await pushInbox(m);
      }
    } catch (e) {
      if (e.name === "AbortError") continue; // long-poll timeout is normal
      log("getupdates 出错:", e.message);
      await sleep(5000);
    }
  }
}

const sentOut = new Set();
async function outboundLoop() {
  for (;;) {
    try {
      const list = await gh("GET", "outbox");
      if (Array.isArray(list)) {
        for (const f of list) {
          if (f.name === ".gitkeep" || sentOut.has(f.name)) continue;
          const file = await gh("GET", "outbox/" + f.name);
          if (!file?.content) continue;
          const job = JSON.parse(b64d(file.content));
          const resp = await ilink("ilink/bot/sendmessage", {
            msg: {
              from_user_id: "",
              to_user_id: job.to,
              client_id: "openclaw-weixin-" + randomUUID(),
              message_type: 2,
              message_state: 2,
              item_list: [{ type: 1, text_item: { text: String(job.text || "") } }],
              context_token: job.context_token || undefined,
            },
          }, 30000);
          if (resp.ret && resp.ret !== 0) throw new Error("sendmessage ret=" + resp.ret + " " + (resp.errmsg || ""));
          await gh("DELETE", "outbox/" + f.name, { message: "sent " + f.name, sha: file.sha });
          sentOut.add(f.name);
          log("📤 已发送回复:", String(job.text).slice(0, 80));
        }
      }
    } catch (e) { log("outbox 轮询出错:", e.message); }
    await sleep(15000);
  }
}

log("wx-bridge 桥接启动，机器人:", account.botId || "(unknown)");
inboundLoop();
outboundLoop();

// wx-bridge daemon (Termux): long-polls iLink getupdates and relays messages
// through a local git clone of the private relay repo (SSH deploy key auth).
// Zero npm dependencies (Node >= 18). Credentials live only on this phone:
//   ~/wx-bridge/state/account.json  (iLink bot token, from login.mjs)
//   ~/.ssh/wxrelay                  (deploy key for the relay repo only)
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

const HOME = process.env.HOME;
const DIR = HOME + "/wx-bridge";
const STATE = DIR + "/state";
const RELAY_DIR = DIR + "/relay";
const PLUGIN_VERSION = "2.4.10";
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 10; // 132106

const log = (...a) => console.log(new Date().toISOString(), ...a);
const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const saveJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2), { mode: 0o600 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const account = loadJson(STATE + "/account.json");
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

// ---- git relay (serialized: one git operation at a time) ----
const gitEnv = { ...process.env, GIT_SSH_COMMAND: "ssh -i " + HOME + "/.ssh/wxrelay -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" };
function git(args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: RELAY_DIR, env: gitEnv }, (e, so, se) =>
      e ? reject(new Error("git " + args.join(" ") + ": " + String(se).trim())) : resolve(String(so).trim()));
  });
}
let chain = Promise.resolve();
function withGit(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

async function pullRebase() { await git(["pull", "--rebase", "origin", "main"]); }
async function pushWithRetry() {
  for (let i = 0; i < 3; i++) {
    try { await git(["push", "origin", "main"]); return; }
    catch (e) { if (i === 2) throw e; await pullRebase(); }
  }
}

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
  await withGit(async () => {
    await pullRebase();
    const p = RELAY_DIR + "/inbox/" + name;
    if (existsSync(p)) return;
    writeFileSync(p, JSON.stringify(payload));
    await git(["add", "inbox/" + name]);
    await git(["commit", "-qm", "wx msg " + payload.id]);
    await pushWithRetry();
  });
  pushed.add(name);
  log("📩 已转发到中继:", payload.text.slice(0, 80));
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

async function outboundLoop() {
  for (;;) {
    try {
      await withGit(async () => {
        await pullRebase();
        const names = readdirSync(RELAY_DIR + "/outbox").filter((n) => n.endsWith(".json"));
        const done = [];
        for (const name of names) {
          let job;
          try { job = JSON.parse(readFileSync(RELAY_DIR + "/outbox/" + name, "utf8")); }
          catch { continue; }
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
          done.push(name);
          log("📤 已发送回复:", String(job.text).slice(0, 80));
        }
        if (done.length) {
          for (const name of done) unlinkSync(RELAY_DIR + "/outbox/" + name);
          await git(["add", "-A", "outbox"]);
          await git(["commit", "-qm", "sent " + done.join(",")]);
          await pushWithRetry();
        }
      });
    } catch (e) { log("outbox 轮询出错:", e.message); }
    await sleep(15000);
  }
}

if (!existsSync(RELAY_DIR + "/.git")) {
  log("⛔ 中继仓库还没克隆，请先重新运行 start.sh");
  process.exit(2);
}
log("wx-bridge 桥接启动，机器人:", account.botId || "(unknown)");
inboundLoop();
outboundLoop();

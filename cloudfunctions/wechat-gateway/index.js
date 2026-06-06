/**
 * 微信公众号消息网关（事件函数版本）
 * 处理微信消息回调：记账录入 / 攻略查询 / 账单汇总
 */
const crypto = require("crypto");
const { parseExpenses } = require("./tracker");
const { CATEGORY_RULES } = require("./categoryConfig");

// ---------- 配置 ----------
const WECHAT_TOKEN = process.env.WECHAT_TOKEN || "travel_planner_2026";
const CLOUDBASE_ENV = "travel-d6gc9rtii6d0f6a87";
const GUIDE_URL = "https://travel-d6gc9rtii6d0f6a87-1439099044.tcloudbaseapp.com";

// ---------- 工具 ----------

/**
 * 修复 CloudBase HTTP 访问服务的 UTF-8 双重编码问题。
 * 网关将原始 UTF-8 字节当成 Latin-1 字符再编码为 UTF-8，导致中文乱码。
 * 此函数检测并还原：latin1 解码 → 得到原始字节 → utf-8 解码
 */
function recoverUTF8(str) {
  if (!str) return str;
  // 如果已有中文字符，说明编码正常，不需修复
  if (/[一-鿿]/.test(str)) return str;

  // 方法1: 标准 Latin-1 双重编码还原（所有字符 ≤ 0xFF 时有效）
  try {
    const recovered = Buffer.from(str, "latin1").toString("utf-8");
    if (/[一-鿿]/.test(recovered)) return recovered;
  } catch (_) {}

  // 方法2: 反向双重编码还原（处理含 > 0xFF 字符的乱码）
  // 将字符串的 UTF-8 字节视为 Latin-1，再解码为 UTF-8
  try {
    const utf8Bytes = Buffer.from(str, "utf-8");
    const recovered = Buffer.from(utf8Bytes.toString("latin1"), "latin1").toString("utf-8");
    if (/[一-鿿]/.test(recovered)) return recovered;
  } catch (_) {}

  return str;
}

/** 解析微信 XML 消息 */
function parseXML(xml) {
  const msg = {};
  const re = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>/gs;
  let m;
  while ((m = re.exec(xml)) !== null) {
    msg[m[1]] = m[2];
  }
  const simpleRe = /<(\w+)>([^<]+)<\/\1>/g;
  while ((m = simpleRe.exec(xml)) !== null) {
    if (!(m[1] in msg)) msg[m[1]] = m[2];
  }
  return msg;
}

/** 构建微信文本回复 XML */
function buildReply(toUser, fromUser, content) {
  return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
}

/** 微信签名验证 */
function checkSignature(signature, timestamp, nonce) {
  const arr = [WECHAT_TOKEN, timestamp, nonce].sort();
  const hash = crypto.createHash("sha1").update(arr.join("")).digest("hex");
  return hash === signature;
}

function now() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000 + 8 * 3600000);
  return local.toISOString().replace("T", " ").substring(0, 16);
}

function todayStr() {
  return now().substring(0, 10);
}

function thisMonthRange() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000 + 8 * 3600000);
  const y = local.getFullYear();
  const m = local.getMonth();
  const first = new Date(Date.UTC(y, m, 1)).toISOString().substring(0, 10);
  const last = new Date(Date.UTC(y, m + 1, 0)).toISOString().substring(0, 10);
  return { first, last };
}

let _db = null;
let _collectionsEnsured = false;

function getDb() {
  if (!_db) {
    const cloudbase = require("@cloudbase/node-sdk");
    const app = cloudbase.init({ env: CLOUDBASE_ENV });
    _db = app.database();
  }
  return _db;
}

async function ensureCollections(db) {
  if (_collectionsEnsured) return;
  try {
    await db.createCollection("expenses");
    console.log("[DB] 创建集合: expenses");
  } catch (e) {
    // 集合已存在时会报错，忽略
    if (!String(e).includes("already exist") && !String(e).includes("ResourceConflict")) {
      console.log("[DB] 集合可能已存在:", e.message || e);
    }
  }
  _collectionsEnsured = true;
}

// ---------- 消息处理 ----------

async function processMessage(content, openid) {
  const text = content.trim();

  if (/\d+\.?\d*\s*元/.test(text)) {
    return await handleExpense(text, openid);
  }

  if (/^(太原|攻略|地图|旅行|旅游|伊犁|新疆)$/.test(text) ||
      /(太原|伊犁|新疆).*(攻略|旅游|旅行|地图)/.test(text)) {
    return handleTravel(text);
  }

  if (/^(汇总|账单|明细|本月|今日)$/.test(text) ||
      /(本月|今日|这月).*(汇总|账单|消费|花了|用了)/.test(text)) {
    const isMonth = /本月|这月/.test(text);
    return await handleSummary(openid, isMonth ? "month" : "today");
  }

  if (/^(帮助|help|\?|？|怎么用|使用)$/i.test(text)) {
    return handleHelp();
  }

  return [
    "发送以下内容给我：",
    "",
    "【记账】羊肉面：18元，打车：25元",
    "【查攻略】太原 / 伊犁",
    "【查账单】本月 / 汇总 / 账单",
    "【帮助】重新看使用说明",
  ].join("\n");
}

async function handleExpense(text, openid) {
  const entries = parseExpenses(text);
  if (entries.length === 0) {
    return "未能识别记账内容。\n格式示例：羊肉面：18元，打车：25元";
  }

  const dateStr = todayStr();
  const timeStr = now().substring(11);

  const db = getDb();
  await ensureCollections(db);
  const collection = db.collection("expenses");

  try {
    for (const e of entries) {
      await collection.add({
        openid,
        item: e.item,
        amount: e.amount,
        category: e.category,
        date: dateStr,
        time: timeStr,
        createTime: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error("DB写入失败:", err);
    return "记账失败，请稍后重试。";
  }

  const total = entries.reduce((s, e) => s + e.amount, 0);
  const lines = ["已记账 ✓", ""];
  for (const e of entries) {
    lines.push(`${e.category} | ${e.item} | ${e.amount.toFixed(2)}元`);
  }
  lines.push("---");
  lines.push(`本次: ${entries.length}笔 共${total.toFixed(2)}元`);

  const uncat = entries.filter((e) => e.category === "其他");
  if (uncat.length > 0) {
    lines.push("");
    lines.push("⚠ 以下未识别分类（归入「其他」）：");
    for (const e of uncat) {
      lines.push(`  - ${e.item} ${e.amount.toFixed(2)}元`);
    }
  }

  return lines.join("\n");
}

function handleTravel(text) {
  if (/伊犁|新疆/.test(text)) {
    return [
      "伊犁7日草原环线攻略",
      "路线: 伊宁→赛里木湖→果子沟→伊昭公路→夏塔→特克斯→那拉提→唐布拉",
      `在线地图: ${GUIDE_URL}`,
    ].join("\n");
  }
  return [
    "太原3-4天深度游攻略",
    "含互动地图 · 路线规划 · 美食住宿",
    "",
    `点击查看: ${GUIDE_URL}`,
  ].join("\n");
}

async function handleSummary(openid, scope) {
  const db = getDb();
  await ensureCollections(db);
  const collection = db.collection("expenses");

  let records;
  try {
    if (scope === "today") {
      const res = await collection.where({ openid, date: todayStr() }).get();
      records = res.data;
    } else {
      const { first, last } = thisMonthRange();
      const res = await collection
        .where({
          openid,
          date: db.command.gte(first).and(db.command.lte(last)),
        })
        .limit(500)
        .get();
      records = res.data;
    }
  } catch (err) {
    console.error("DB查询失败:", err);
    return "查询失败，请稍后重试。";
  }

  if (!records || records.length === 0) {
    return scope === "today" ? "今日暂无记账记录。" : "本月暂无记账记录。";
  }

  const total = records.reduce((s, r) => s + r.amount, 0);
  const byCat = {};
  for (const r of records) {
    byCat[r.category] = (byCat[r.category] || 0) + r.amount;
  }

  const lines = [];
  lines.push(scope === "today" ? "今日记账汇总" : "本月记账汇总");
  lines.push("");
  for (const [cat, amt] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    lines.push(`${cat}: ${amt.toFixed(2)}元`);
  }
  lines.push("---");
  lines.push(`${records.length}笔 合计: ${total.toFixed(2)}元`);
  return lines.join("\n");
}

function handleHelp() {
  return [
    "【记账助手】使用说明",
    "",
    "1 记账 — 直接发送消费记录",
    "   羊肉面：18元，打车：25元",
    "",
    "2 查攻略 — 发送城市名",
    "   太原 / 伊犁",
    "",
    "3 查账单 — 发送「汇总」",
    `更新时间: ${now()}`,
  ].join("\n");
}

// ---------- 入口 ----------

exports.main = async (event) => {
  const httpMethod = event.httpMethod || "GET";

  // OPTIONS: CORS 预检
  if (httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  // GET: 微信服务器验证
  if (httpMethod === "GET") {
    const params = event.queryStringParameters || event.queryString || {};
    const { signature, timestamp, nonce, echostr } = params;

    if (checkSignature(signature, timestamp, nonce)) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/plain" },
        body: echostr,
      };
    }
    return { statusCode: 403, body: "signature check failed" };
  }

  // POST: 微信消息 or 聊天页 JSON
  if (httpMethod === "POST") {
    let body = event.body || "";

    // 如果是 base64 编码，先解码
    if (event.isBase64Encoded) {
      body = Buffer.from(body, "base64").toString("utf-8");
    }

    // 修复 CloudBase 网关 UTF-8 双重编码
    body = recoverUTF8(body);

    // ---- JSON 请求（聊天 PWA 页面）----
    if (body.trim().startsWith("{")) {
      try {
        const { message, userId } = JSON.parse(body);
        console.log(`[JSON] message="${message}"`);
        const replyText = await processMessage(message || "", userId || "web");
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({ reply: replyText }),
        };
      } catch (e) {
        return {
          statusCode: 400,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reply: "消息格式错误" }),
        };
      }
    }

    // ---- XML 请求（微信）----
    console.log(`[消息] body=${body}`);

    const msg = parseXML(body);

    if (msg.MsgType !== "text") {
      const reply = buildReply(
        msg.FromUserName,
        msg.ToUserName,
        "暂不支持此类消息，请发送文字。"
      );
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/xml; charset=utf-8" },
        body: reply,
      };
    }

    console.log(`[内容] "${msg.Content}"`);

    const replyText = await processMessage(msg.Content, msg.FromUserName);
    const reply = buildReply(msg.FromUserName, msg.ToUserName, replyText);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
      body: reply,
    };
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};

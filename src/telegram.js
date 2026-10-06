/* Проверка подписи initData по правилам Telegram (Web Crypto — работает в Cloudflare Workers без node-модулей).
   Подделать чужой id нельзя: подпись считается от токена бота, который знает только сервер. */
const enc = new TextEncoder();
async function hmac(key, msg){
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const hex = a => [...a].map(b => b.toString(16).padStart(2, "0")).join("");
function sameHex(a, b){
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyInitData(initData, botToken, maxAgeSec = 30 * 86400, nowSec = Math.floor(Date.now() / 1000)){
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = (params.get("hash") || "").toLowerCase();
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + "=" + v)
    .join("\n");
  const secret = await hmac("WebAppData", botToken);
  const calc = hex(await hmac(secret, dataCheck));
  if (!sameHex(calc, hash)) return null;
  const authDate = +params.get("auth_date") || 0;
  if (nowSec - authDate > maxAgeSec) return null;
  try { return JSON.parse(params.get("user") || "null"); } catch (e) { return null; }
}

export async function sendMessage(botToken, chatId, text, appUrl){
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (appUrl) body.reply_markup = { inline_keyboard: [[{ text: "Открыть расписание", web_app: { url: appUrl } }]] };
  const r = await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  return { ok: !!j.ok, error: j.description || (r.ok ? "" : "HTTP " + r.status) };
}

/* Достаёт токен из того, что вставили в BOT_TOKEN: даже если туда попало
   целиком сообщение BotFather, кавычки, пробелы или «BOT_TOKEN=». */
export function cleanToken(raw){
  const s = String(raw || "");
  const m = s.match(/\d{5,}:[A-Za-z0-9_-]{30,}/);
  if (m) return m[0];
  return s.trim().replace(/\s+/g, "");
}

/* Объясняет, почему подпись не сошлась: спрашивает у Telegram, чей это токен. */
export async function signatureHint(token, initData){
  if (!initData) return "Приложение открыто не из Telegram — подписи нет.";
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)){
    const peek = token.length ? "«" + token.slice(0, 8) + (token.length > 8 ? "…" : "") + "», " + token.length + " симв." : "пусто";
    return "BOT_TOKEN на сервере не похож на токен бота (сейчас там: " + peek + "). Нужна строка вида 123456789:AAH… из @BotFather → /mybots → бот → API Token.";
  }
  try {
    const r = await fetch("https://api.telegram.org/bot" + token + "/getMe");
    const j = await r.json();
    if (!j.ok) return "Telegram не принимает BOT_TOKEN с сервера (" + (j.description || "HTTP " + r.status) + "). Возможно, токен перевыпускали — скопируйте актуальный из @BotFather.";
    return "Подпись Telegram не прошла проверку. Токен на сервере — от бота @" + j.result.username +
      ", а приложение открыто через другого бота. Откройте приложение кнопкой в @" + j.result.username + " или поставьте в BOT_TOKEN токен того бота, через которого открываете.";
  } catch (e) {
    return "Подпись Telegram не прошла проверку, а проверить токен у Telegram не удалось.";
  }
}

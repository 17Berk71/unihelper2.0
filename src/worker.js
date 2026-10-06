/* UniHelper на Cloudflare Workers.
   - Статика (public/index.html) отдаётся Cloudflare напрямую, бесплатно и без лимита.
   - POST /api/sync — приложение присылает выжимку для утренней сводки.
   - Расписание (cron) раз в час — шлёт сводку тем, у кого сейчас 7 утра.
   Данные пользователей лежат в KV (привязка USERS), ключ "u:<telegram id>". */
import { verifyInitData, sendMessage, cleanToken, signatureHint } from "./telegram.js";
import { buildDigest, runMorning } from "./digest.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8" }
});

/* KV в том же виде, в каком digest.js ждёт хранилище */
function kvStore(kv){
  return {
    async list(){
      const blobs = []; let cursor;
      do {
        const r = await kv.list({ prefix: "u:", cursor });
        r.keys.forEach(k => blobs.push({ key: k.name }));
        cursor = r.list_complete ? null : r.cursor;
      } while (cursor);
      return { blobs };
    },
    get: (key) => kv.get(key, { type: "json" }),
    setJSON: (key, val) => kv.put(key, JSON.stringify(val))
  };
}

/* что в снимке важно для сводки — если это не поменялось, в KV не пишем
   (на бесплатном тарифе KV — 1000 записей в сутки) */
const essence = s => JSON.stringify([s.tz, s.notify, s.subjects, s.lessons, s.urgent, s.appUrl]);

async function sync(req, env, origin){
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const token = cleanToken(env.BOT_TOKEN);
  if (!token) return json({ ok: false, error: "На сервере не задан BOT_TOKEN" }, 500);

  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  const user = await verifyInitData(body.initData, token);
  if (!user || !user.id) return json({ ok: false, error: await signatureHint(token, body.initData) }, 401);

  const s = body.snapshot || {};
  const key = "u:" + user.id;
  const prev = (await env.USERS.get(key, { type: "json" })) || {};
  const snap = {
    chatId: user.id,
    appUrl: origin + "/",
    tz: String(s.tz || "Europe/Moscow").slice(0, 64),
    notify: s.notify !== false,
    subjects: (s.subjects || []).slice(0, 200).map(x => ({ id: String(x.id), name: String(x.name || "").slice(0, 120), room: String(x.room || "").slice(0, 20) })),
    lessons: (s.lessons || []).slice(0, 1500).map(l => ({
      date: l.date ? String(l.date).slice(0, 10) : "", day: Number.isInteger(l.day) ? l.day : -1,
      time: String(l.time || "").slice(0, 5), end: String(l.end || "").slice(0, 5),
      subjectId: String(l.subjectId || ""), room: String(l.room || "").slice(0, 20), kind: String(l.kind || "").slice(0, 20)
    })),
    urgent: (s.urgent || []).slice(0, 50).map(t => String(t).slice(0, 200)),
    lastSent: prev.lastSent || "",
    lastError: prev.lastError || "",
    updated: Date.now()
  };
  if (essence(snap) !== essence(prev)) await env.USERS.put(key, JSON.stringify(snap));

  if (body.test){
    const d = buildDigest(snap);
    const text = d.text + (d.hasContent ? "" : "\n\n<i>Сегодня пар нет, поэтому утром бот бы промолчал. Это пробная отправка — так выглядит сводка.</i>");
    const r = await sendMessage(token, user.id, text, snap.appUrl);
    return json({ ok: r.ok, error: r.error });
  }
  return json({ ok: true, lastError: snap.lastError });
}

async function morning(env){
  const token = cleanToken(env.BOT_TOKEN);
  if (!token){ console.log("BOT_TOKEN не задан"); return; }
  const res = await runMorning({
    store: kvStore(env.USERS),
    send: (chatId, text, snap) => sendMessage(token, chatId, text, snap && snap.appUrl)
  });
  console.log("утренняя сводка:", JSON.stringify(res));
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    if (url.pathname === "/api/sync") return sync(req, env, url.origin);
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx){
    ctx.waitUntil(morning(env));
  }
};

/* Утренняя сводка: собирается из того, что прислало приложение. */
const DAYS = ["Понедельник","Вторник","Среда","Четверг","Пятница","Суббота","Воскресенье"];
const MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const WD = { Mon:0, Tue:1, Wed:2, Thu:3, Fri:4, Sat:5, Sun:6 };

export const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const mins = t => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
function plural(n, one, few, many){
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/* местные дата, час и день недели пользователя */
export function localNow(now, tz){
  let zone = tz;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch (e) { zone = "Europe/Moscow"; }
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23", weekday: "short"
  });
  const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value]));
  return { iso: p.year + "-" + p.month + "-" + p.day, hour: +p.hour, wd: WD[p.weekday],
           day: +p.day, month: +p.month - 1 };
}

/* та же логика, что в приложении: пара либо на конкретную дату, либо еженедельная */
export function todayLessons(snap, loc){
  return (snap.lessons || [])
    .filter(l => (l.date ? l.date === loc.iso : l.day === loc.wd))
    .sort((a, b) => mins(a.time) - mins(b.time));
}

export function buildDigest(snap, now = new Date()){
  const loc = localNow(now, snap.tz);
  const lessons = todayLessons(snap, loc);
  const urgent = (snap.urgent || []).filter(Boolean);
  const subj = id => (snap.subjects || []).find(s => s.id === id) || {};
  const lines = ["<b>Доброе утро!</b> " + DAYS[loc.wd] + ", " + loc.day + " " + MONTHS[loc.month], ""];

  if (lessons.length){
    lines.push(lessons.length === 1 ? "Сегодня одна пара:" :
      "Сегодня " + lessons.length + " " + plural(lessons.length, "пара", "пары", "пар") + ":");
    lessons.forEach((l, i) => {
      const s = subj(l.subjectId), room = l.room || s.room;
      lines.push((i + 1) + ". <b>" + esc(l.time) + (l.end ? "–" + esc(l.end) : "") + "</b> — " + esc(s.name || "пара") +
        (l.kind ? " (" + esc(String(l.kind).toLowerCase()) + ")" : "") + (room ? ", ауд. " + esc(room) : ""));
    });
  } else {
    lines.push("Сегодня пар нет.");
  }

  if (urgent.length){
    lines.push("", "🔴 <b>Срочно и важно</b> — " + urgent.length + " " +
      plural(urgent.length, "невыполненная задача", "невыполненные задачи", "невыполненных задач") + ":");
    urgent.slice(0, 8).forEach(t => lines.push("• " + esc(t)));
    if (urgent.length > 8) lines.push("… и ещё " + (urgent.length - 8));
  }
  return { text: lines.join("\n"), hasContent: lessons.length > 0, loc };
}

/* Раз в час: кому уже наступило 7 утра и сегодня ещё не отправляли — шлём.
   Окно 7:00–9:59 — на случай, если плановый запуск немного опоздает. */
export async function runMorning({ store, send, now = new Date() }){
  const out = { checked: 0, sent: 0, skipped: 0, failed: 0 };
  const { blobs } = await store.list();
  for (const { key } of blobs){
    const snap = await store.get(key, { type: "json" });
    if (!snap) continue;
    out.checked++;
    if (snap.notify === false){ out.skipped++; continue; }
    const d = buildDigest(snap, now);
    if (d.loc.hour < 7 || d.loc.hour > 9 || snap.lastSent === d.loc.iso){ out.skipped++; continue; }
    /* в день без пар сводка не нужна, даже если есть срочные задачи */
    if (!d.hasContent){ snap.lastSent = d.loc.iso; await store.setJSON(key, snap); out.skipped++; continue; }
    const r = await send(snap.chatId, d.text, snap);
    if (r.ok){ snap.lastSent = d.loc.iso; snap.lastError = ""; out.sent++; }
    else { snap.lastError = r.error; out.failed++; }
    await store.setJSON(key, snap);
  }
  return out;
}

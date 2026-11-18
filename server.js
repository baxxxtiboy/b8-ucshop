require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const { sb, must } = require("./db");
const { launch, notifyUser, notifyAdmins } = require("./bot");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ============ KONFIGURATSIYA (narxlar serverda — mijozga ishonib bo'lmaydi) ============ */
const PACKAGES = [
  { uc: 60,   bonus: 0,    price: 12000 },
  { uc: 300,  bonus: 25,   price: 59000 },
  { uc: 600,  bonus: 60,   price: 118000 },
  { uc: 1500, bonus: 300,  price: 295000 },
  { uc: 3000, bonus: 850,  price: 585000 },
  { uc: 8000, bonus: 2800, price: 1560000 }
];
const PAYMENTS = ["Click", "Payme", "Uzum", "Uzcard"];
// Omad g'ildiragi sektorlari (w — tushish ehtimoli vazni)
const SECTORS = [
  { label: "10 UC", uc: 10, w: 24 }, { label: "Omad kelmadi", w: 22 },
  { label: "60 UC", uc: 60, w: 16 }, { label: "Yana urinish", retry: true, w: 14 },
  { label: "300 UC", uc: 300, w: 5 }, { label: "30 UC", uc: 30, w: 14 },
  { label: "660 UC", uc: 660, w: 1.5 }, { label: "1000 UC", uc: 1000, w: 1 }
];
const SPIN_COST_UC = 60;   // Balansdan 1 ta urinish narxi
const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " so'm";
const mask = id => (id || "").length > 6 ? id.slice(0, 3) + "****" + id.slice(-3) : "***";
// DB qatori (snake_case) -> frontend formati (camelCase)
const toUser = u => ({ id: u.id, telegramId: u.telegram_id, username: u.username, pubgId: u.pubg_id,
                       balance: u.balance, ucSpinsLeft: u.spins_left });

/* ============ AUTENTIFIKATSIYA ============ */
// Telegram Mini App initData imzosini tekshirish (HMAC-SHA256)
function verifyInitData(initData) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash"); p.delete("hash");
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(str).digest("hex");
  return calc === hash ? JSON.parse(p.get("user")) : null;
}

const auth = async (req, res, next) => {
  try {
    let tg = null;
    const init = req.get("x-init-data");
    if (init && process.env.BOT_TOKEN) tg = verifyInitData(init);
    else if (process.env.DEV_MODE === "true" && req.get("x-telegram-id"))   // faqat test uchun
      tg = { id: +req.get("x-telegram-id"), username: "dev_user" };
    if (!tg) return res.status(401).json({ error: "Iltimos, Telegram bot orqali kiring." });
    // Foydalanuvchini yaratish yoki yangilash (yangi bo'lsa DB defaultlari: 1 ta bepul urinish)
    const row = must(await sb.from("users")
      .upsert({ telegram_id: tg.id, username: tg.username || "" }, { onConflict: "telegram_id" })
      .select().single());
    req.user = toUser(row);
    next();
  } catch (e) { next(e); }
};
const adminOnly = async (req, res, next) => {
  try {
    const a = must(await sb.from("admins").select("telegram_id").eq("telegram_id", req.user.telegramId).maybeSingle());
    if (a) return next();
    res.status(403).json({ error: "Ruxsat yo'q" });
  } catch (e) { next(e); }
};
const wrap = fn => (req, res, next) => fn(req, res).catch(next);

/* ============ OMMAVIY MA'LUMOT ============ */
app.get("/api/config", (req, res) =>
  res.json({ packages: PACKAGES, payments: PAYMENTS, sectors: SECTORS.map(s => s.label), spinCost: SPIN_COST_UC }));

app.get("/api/me", auth, (req, res) => res.json({ user: req.user }));

// PUBG ID tekshiruvi (SIMULYATSIYA: PUBG'da ochiq rasmiy API yo'q)
app.post("/api/check-id", auth, (req, res) => {
  const id = String(req.body.pubgId || "");
  if (!/^\d{7,12}$/.test(id)) return res.status(400).json({ error: "ID kamida 7 ta raqam bo'lsin" });
  const nicks = ["PRO_UZB_GAMER", "TASHKENT_WOLF", "SAMARQAND_KING", "NINJA_UZ", "SNIPER_ALI"];
  const servers = ["Osiyo", "Yevropa", "Global"];
  const s = [...id].reduce((a, c) => a + +c, 0);
  res.json({ nickname: nicks[s % nicks.length], server: servers[s % servers.length] });
});

/* ============ BUYURTMA ============ */
app.post("/api/order", auth, wrap(async (req, res) => {
  const { pubgId, ucPackage, paymentMethod } = req.body;
  const pack = PACKAGES.find(p => p.uc === +ucPackage);
  if (!/^\d{7,12}$/.test(String(pubgId))) return res.status(400).json({ error: "PUBG ID noto'g'ri" });
  if (!pack) return res.status(400).json({ error: "Paket topilmadi" });
  if (!PAYMENTS.includes(paymentMethod)) return res.status(400).json({ error: "To'lov usuli noto'g'ri" });

  const order = must(await sb.from("orders").insert({
    user_id: req.user.id, pubg_id: pubgId, payment_method: paymentMethod,
    uc: pack.uc, bonus: pack.bonus, amount: pack.price
  }).select().single());
  must(await sb.from("users").update({ pubg_id: pubgId }).eq("id", req.user.id));

  const total = pack.uc + pack.bonus;
  notifyUser(req.user.telegramId, `✅ Buyurtma qabul qilindi\n💎 ${total} UC\n💰 ${fmt(pack.price)} (${paymentMethod})\n🆔 PUBG ID: ${pubgId}\nUC tez orada tushadi.`);
  notifyAdmins(`🛒 <b>Yangi buyurtma</b>\n@${req.user.username || req.user.telegramId}\n💎 ${total} UC — ${fmt(pack.price)}\n🆔 ${pubgId} · ${paymentMethod}`);
  res.json({ orderId: order.id, status: order.status });
}));

/* ============ OMAD G'ILDIRAGI ============ */
const pickSector = () => {
  let r = Math.random() * SECTORS.reduce((a, s) => a + s.w, 0);
  for (let i = 0; i < SECTORS.length; i++) { r -= SECTORS[i].w; if (r <= 0) return i; }
  return 0;
};

app.post("/api/spin", auth, wrap(async (req, res) => {
  const index = pickSector(), s = SECTORS[index];
  // Atomik (SQL funksiya): urinish bor bo'lsagina ayiriladi — ikki marta bosishdan himoya
  const rows = must(await sb.rpc("spin_user", { p_user: req.user.id, p_uc: s.uc || 0, p_retry: !!s.retry }));
  if (!rows.length) return res.status(400).json({ error: "Urinishlar tugadi" });
  const user = toUser(rows[0]);
  must(await sb.from("spins").insert({ user_id: user.id, prize: s.label, uc: s.uc || 0 }));

  if (s.uc) {
    notifyUser(user.telegramId, `🎉 Omad g'ildiragida <b>${s.label}</b> yutdingiz!\nBalans: ${user.balance} UC`);
    if (s.uc >= 300) notifyAdmins(`🎰 @${user.username || user.telegramId} spinda <b>${s.label}</b> yutdi`);
  }
  res.json({ index, prize: s, user });
}));

// Yutilgan UC balansidan qo'shimcha urinish sotib olish
app.post("/api/spin/buy", auth, wrap(async (req, res) => {
  const rows = must(await sb.rpc("buy_spin", { p_user: req.user.id, p_cost: SPIN_COST_UC }));
  if (!rows.length) return res.status(400).json({ error: `Balansda kamida ${SPIN_COST_UC} UC bo'lishi kerak` });
  res.json({ user: toUser(rows[0]) });
}));

/* ============ KONKURSLAR ============ */
app.get("/api/contests", auth, wrap(async (req, res) => {
  const list = must(await sb.from("contests").select("*, contest_participants(user_id)")
    .order("created_at", { ascending: false }).limit(20));
  const view = c => ({
    id: c.id, title: c.title, prize: c.prize, description: c.description, icon: c.icon,
    endTime: c.end_time, max: c.max_participants, count: c.contest_participants.length, status: c.status,
    joined: c.contest_participants.some(p => p.user_id === req.user.id),
    winner: c.winner_pubg_id ? mask(c.winner_pubg_id) : null
  });
  res.json({ active: list.filter(c => c.status === "active").map(view),
             ended: list.filter(c => c.status === "ended").slice(0, 5).map(view) });
}));

app.post("/api/contests/:id/join", auth, wrap(async (req, res) => {
  const { pubgId, telegram } = req.body;
  if (!/^\d{7,12}$/.test(String(pubgId))) return res.status(400).json({ error: "PUBG ID noto'g'ri" });
  if (!/^@[A-Za-z0-9_]{4,32}$/.test(String(telegram))) return res.status(400).json({ error: "Telegram username noto'g'ri" });
  // Barcha shartlar SQL funksiya ichida: faol, vaqti tugamagan, joy bor, oldin qatnashmagan
  const { data: count, error } = await sb.rpc("join_contest",
    { p_contest: req.params.id, p_user: req.user.id, p_pubg: pubgId, p_tg: telegram });
  if (error && error.code === "22P02") return res.status(400).json({ error: "Konkurs topilmadi" });  // noto'g'ri UUID
  if (error) throw error;
  if (count < 0) return res.status(400).json({ error: "Qatnashib bo'lmaydi (tugagan, to'lgan yoki allaqachon qatnashgansiz)" });
  notifyUser(req.user.telegramId, `🏆 Siz konkursda ishtirokchisiz! Omad!`);
  res.json({ count });
}));

/* ============ ADMIN ============ */
const admin = express.Router();
admin.use(auth, adminOnly);

admin.get("/stats", wrap(async (req, res) => res.json(must(await sb.rpc("admin_stats")))));

admin.get("/orders", wrap(async (req, res) => {
  const rows = must(await sb.from("orders").select("*, users(username, telegram_id)")
    .order("created_at", { ascending: false }).limit(100));
  // Frontend kutgan shaklga o'tkazamiz
  res.json({ orders: rows.map(o => ({
    _id: o.id, pubgId: o.pubg_id, amount: o.amount, paymentMethod: o.payment_method, status: o.status,
    ucPackage: { uc: o.uc, bonus: o.bonus },
    user: { username: o.users?.username, telegramId: o.users?.telegram_id }
  })) });
}));

admin.patch("/orders/:id", wrap(async (req, res) => {
  const { status } = req.body;
  if (!["pending", "done", "cancelled"].includes(status)) return res.status(400).json({ error: "Status noto'g'ri" });
  const { data: o, error } = await sb.from("orders").update({ status }).eq("id", req.params.id)
    .select("*, users(telegram_id)").maybeSingle();
  if (error && error.code !== "22P02") throw error;
  if (!o) return res.status(404).json({ error: "Topilmadi" });
  const msg = { done: "✅ Buyurtmangiz bajarildi! UC hisobingizga tushdi.", cancelled: "❌ Buyurtmangiz bekor qilindi.", pending: "⏳ Buyurtmangiz kutishda." };
  notifyUser(o.users.telegram_id, msg[status]);
  res.json({ ok: true });
}));

admin.post("/contests", wrap(async (req, res) => {
  const { title, prize, hours, maxParticipants, description } = req.body;
  if (!title || !prize || !(+hours > 0)) return res.status(400).json({ error: "Nom, sovrin va soat kerak" });
  const c = must(await sb.from("contests").insert({
    title, prize, description: description || "", max_participants: +maxParticipants || 2000,
    end_time: new Date(Date.now() + hours * 3600e3).toISOString()
  }).select().single());
  res.json({ contest: c });
}));

// G'olibni tasodifiy tanlash
admin.post("/contests/:id/draw", wrap(async (req, res) => {
  const parts = must(await sb.from("contest_participants").select("pubg_id, telegram, users(telegram_id)")
    .eq("contest_id", req.params.id));
  if (!parts.length) return res.status(400).json({ error: "Ishtirokchilar yo'q" });
  const w = parts[crypto.randomInt(parts.length)];
  // Faqat hali faol konkurs yopiladi (ikki marta tanlashdan himoya)
  const done = must(await sb.from("contests").update({ status: "ended", winner_pubg_id: w.pubg_id, winner_telegram: w.telegram })
    .eq("id", req.params.id).eq("status", "active").select("title, prize"));
  if (!done.length) return res.status(400).json({ error: "Konkurs faol emas" });
  notifyUser(w.users.telegram_id, `🎊 Tabriklaymiz! Siz “${done[0].title}” konkursida g'olib bo'ldingiz!\nSovrin: ${done[0].prize}`);
  res.json({ winner: { pubgId: w.pubg_id, telegram: w.telegram } });
}));
app.use("/api/admin", admin);

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "Server xatosi" }); });

/* ============ ISHGA TUSHIRISH ============ */
(async () => {
  // Adminlarni .env dan sinxronlash
  const ids = (process.env.ADMIN_IDS || "").split(",").filter(Boolean).map(id => ({ telegram_id: +id, role: "owner" }));
  if (ids.length) must(await sb.from("admins").upsert(ids, { onConflict: "telegram_id" }));
  // Demo konkurs
  const { count } = await sb.from("contests").select("id", { count: "exact", head: true });
  if (!count)
    must(await sb.from("contests").insert({ title: "M416 Glacier + 8100 UC", prize: "M416 Glacier + 8100 UC", icon: "🔫",
      description: "Afsonaviy M416 Glacier va 8100 UC — 1 nafar g'olibga.", end_time: new Date(Date.now() + 7 * 864e5).toISOString() }));
  app.listen(process.env.PORT || 3000, () => console.log("🚀 Server: http://localhost:" + (process.env.PORT || 3000)));
  launch();
})().catch(e => { console.error("Ishga tushmadi:", e.message); process.exit(1); });

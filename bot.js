// Telegram bot: /start + Web App tugmasi + xabarnomalar
const { Telegraf, Markup } = require("telegraf");
const { sb, must } = require("./db");

const bot = process.env.BOT_TOKEN ? new Telegraf(process.env.BOT_TOKEN) : null;

if (bot) {
  bot.start(ctx => ctx.reply(
    `Salom, ${ctx.from.first_name}! 👑\nPUBG Mobile UC do‘koniga xush kelibsiz.\nUC sotib oling, omad g‘ildiragini aylantiring va konkurslarda qatnashing.`,
    Markup.inlineKeyboard([[Markup.button.webApp("🛒 Mini App-ni ochish", process.env.WEBAPP_URL)]])
  ));
  bot.catch(err => console.error("Bot xatosi:", err.message));
}

// Bitta foydalanuvchiga xabar (xato bo'lsa, server to'xtab qolmaydi)
async function notifyUser(telegramId, text) {
  if (!bot) return console.log(`[bot o'chiq] -> ${telegramId}: ${text}`);
  try { await bot.telegram.sendMessage(telegramId, text, { parse_mode: "HTML" }); }
  catch (e) { console.error("Xabar yuborilmadi:", telegramId, e.message); }
}

// Barcha adminlarga xabar
async function notifyAdmins(text) {
  const admins = must(await sb.from("admins").select("telegram_id"));
  await Promise.all(admins.map(a => notifyUser(a.telegram_id, text)));
}

function launch() { if (bot) bot.launch().then(() => console.log("🤖 Bot ishga tushdi")); }
process.once("SIGINT", () => bot && bot.stop("SIGINT"));
process.once("SIGTERM", () => bot && bot.stop("SIGTERM"));

module.exports = { launch, notifyUser, notifyAdmins };

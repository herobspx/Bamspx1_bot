require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ====== DB ======
const client = new MongoClient(process.env.MONGO_URI);
let db;
(async () => {
  await client.connect();
  db = client.db('bamspx1');
  console.log('DB connected');
})();

// ====== Config ======
const CHANNEL_ID = process.env.CHANNEL_ID; // مثال: -100xxxxxxxxx
const ADMIN_ID = Number(process.env.ADMIN_ID);

const PLANS = {
  "شهري": { price: 250, days: 30 },
  "3 شهور": { price: 550, days: 90 },
  "6 شهور": { price: 1000, days: 180 },
  "سنوي": { price: 2500, days: 365 }
};

// ====== Helpers ======
function mainMenu() {
  return Markup.keyboard([
    ["💳 الاشتراكات"],
    ["📌 حالتي"],
    ["🆘 الدعم"]
  ]).resize();
}

async function createOrder(user, planName) {
  const order_id = uuidv4().slice(0, 8);
  const plan = PLANS[planName];

  await db.collection('orders').insertOne({
    order_id,
    user_id: user.id,
    username: user.username || "",
    plan: planName,
    price: plan.price,
    status: "PENDING",
    created_at: new Date()
  });

  return { order_id, plan };
}

function paymentText(order_id, planName, price) {
  return `🧾 رقم الطلب: ${order_id}
📦 الباقة: ${planName}
💰 المبلغ: ${price} ريال

💳 طرق الدفع:
- STC Pay: 05XXXXXXXX
- بنك: SAxxxxxxxxxxxxxxxx

📌 بعد التحويل:
اضغط "تم التحويل" وارسل صورة الإيصال.`;
}

// ====== Start ======
bot.start(async (ctx) => {
  await db.collection('users').updateOne(
    { user_id: ctx.from.id },
    { $setOnInsert: { user_id: ctx.from.id, status: "NONE" } },
    { upsert: true }
  );

  ctx.reply("أهلاً بك في BAMSPX 👋", mainMenu());
});

// ====== Subscriptions ======
bot.hears("💳 الاشتراكات", (ctx) => {
  ctx.reply("اختر الباقة:", Markup.inlineKeyboard([
    [Markup.button.callback("شهري - 250", "plan_شهري")],
    [Markup.button.callback("3 شهور - 550", "plan_3 شهور")],
    [Markup.button.callback("6 شهور - 1000", "plan_6 شهور")],
    [Markup.button.callback("سنوي - 2500", "plan_سنوي")]
  ]));
});

bot.action(/plan_(.+)/, async (ctx) => {
  const planName = ctx.match[1];
  const { order_id, plan } = await createOrder(ctx.from, planName);

  await ctx.reply(paymentText(order_id, planName, plan.price), Markup.inlineKeyboard([
    [Markup.button.callback("✅ تم التحويل", `paid_${order_id}`)]
  ]));
});

// ====== Upload Proof ======
const awaitingProof = new Map();

bot.action(/paid_(.+)/, async (ctx) => {
  const order_id = ctx.match[1];
  awaitingProof.set(ctx.from.id, order_id);
  await ctx.reply("📤 أرسل صورة الإيصال الآن:");
});

bot.on('photo', async (ctx) => {
  const order_id = awaitingProof.get(ctx.from.id);
  if (!order_id) return;

  const file_id = ctx.message.photo.pop().file_id;

  await db.collection('orders').updateOne(
    { order_id },
    { $set: { proof_file_id: file_id, status: "PENDING_REVIEW" } }
  );

  awaitingProof.delete(ctx.from.id);

  // Notify admin
  await bot.telegram.sendPhoto(ADMIN_ID, file_id, {
    caption: `طلب جديد\nID: ${order_id}`,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("✅ قبول", `approve_${order_id}`),
        Markup.button.callback("❌ رفض", `reject_${order_id}`)
      ]
    ])
  });

  ctx.reply("⏳ تم استلام الإثبات، بانتظار المراجعة.");
});

// ====== Admin Approve/Reject ======
bot.action(/approve_(.+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const order_id = ctx.match[1];
  const order = await db.collection('orders').findOne({ order_id });
  if (!order) return;

  const now = new Date();
  const end = new Date(now.getTime() + (PLANS[order.plan].days * 86400000));

  await db.collection('users').updateOne(
    { user_id: order.user_id },
    { $set: { status: "ACTIVE", plan: order.plan, start_date: now, end_date: end } },
    { upsert: true }
  );

  await db.collection('orders').updateOne(
    { order_id },
    { $set: { status: "APPROVED" } }
  );

  // Add to channel
  await bot.telegram.unbanChatMember(CHANNEL_ID, order.user_id);

  await bot.telegram.sendMessage(order.user_id, `✅ تم التفعيل حتى ${end.toLocaleString()}`);

  ctx.editMessageCaption(`✅ تم قبول الطلب ${order_id}`);
});

bot.action(/reject_(.+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const order_id = ctx.match[1];

  await db.collection('orders').updateOne(
    { order_id },
    { $set: { status: "REJECTED" } }
  );

  ctx.editMessageCaption(`❌ تم رفض الطلب ${order_id}`);
});

// ====== Status ======
bot.hears("📌 حالتي", async (ctx) => {
  const user = await db.collection('users').findOne({ user_id: ctx.from.id });
  if (!user || user.status !== "ACTIVE") {
    return ctx.reply("❌ لا يوجد اشتراك نشط");
  }

  ctx.reply(`✅ اشتراكك نشط
📦 الباقة: ${user.plan}
⏳ ينتهي: ${new Date(user.end_date).toLocaleString()}`);
});

// ====== Expiry Cron ======
cron.schedule("*/10 * * * *", async () => {
  const now = new Date();
  const users = await db.collection('users').find({
    status: "ACTIVE",
    end_date: { $lt: now }
  }).toArray();

  for (const u of users) {
    await bot.telegram.banChatMember(CHANNEL_ID, u.user_id);
    await bot.telegram.unbanChatMember(CHANNEL_ID, u.user_id);

    await db.collection('users').updateOne(
      { user_id: u.user_id },
      { $set: { status: "EXPIRED" } }
    );

    await bot.telegram.sendMessage(u.user_id, "⛔ انتهى اشتراكك، جدد للدخول مجددًا.");
  }
});

bot.launch();

require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');

const bot = new Telegraf(process.env.BOT_TOKEN);
const client = new MongoClient(process.env.MONGO_URI);

const CHANNEL_ID = Number(process.env.CHANNEL_ID);
const TRIAL_HOURS = 48;

let db;

// اتصال قاعدة البيانات
(async () => {
  await client.connect();
  db = client.db('bamspx1');
  console.log('DB Connected');
  bot.launch();
})();

// القائمة الرئيسية
function mainMenu() {
  return Markup.keyboard([
    ['الاشتراك', 'اشتراكي'],
    ['فترة تجريبية', 'التفاصيل'],
    ['الدعم']
  ]).resize();
}

// رسالة البداية
bot.start(async (ctx) => {
  await ctx.reply(
`أهلاً بك في BAMSPX

من خلال هذا البوت يمكنك:
- الاشتراك في القناة
- تجربة مجانية لمدة 48 ساعة
- متابعة اشتراكك
- التواصل مع الدعم

اختر الخدمة من الأسفل.`,
    mainMenu()
  );
});

// التفاصيل
bot.hears('التفاصيل', async (ctx) => {
  await ctx.reply(
`تفاصيل الاشتراك

الباقات:
شهري: 250
3 شهور: 550
6 شهور: 1000
سنوي: 2500

طريقة الاشتراك:
1. تختار الباقة
2. تحول
3. ترسل الإيصال
4. يتم التفعيل

مميزات:
- رابط خاص
- حماية من المشاركة
- حذف تلقائي بعد الانتهاء`
  );
});

// التجربة
bot.hears('فترة تجريبية', async (ctx) => {
  await ctx.reply(
    'اضغط لمشاركة رقم الجوال لتفعيل التجربة',
    Markup.keyboard([
      [{ text: 'مشاركة رقم الجوال', request_contact: true }]
    ]).resize()
  );
});

// استقبال رقم الجوال
bot.on('contact', async (ctx) => {
  const phone = ctx.message.contact.phone_number;
  const userId = ctx.from.id;

  const exists = await db.collection('trials').findOne({ phone });

  if (exists) {
    return ctx.reply('هذا الرقم استخدم التجربة مسبقاً', mainMenu());
  }

  const end = new Date(Date.now() + TRIAL_HOURS * 60 * 60 * 1000);

  await db.collection('trials').insertOne({
    userId,
    phone,
    end,
    status: 'active'
  });

  await db.collection('users').updateOne(
    { userId },
    {
      $set: {
        status: 'TRIAL',
        end
      }
    },
    { upsert: true }
  );

  const link = await bot.telegram.createChatInviteLink(CHANNEL_ID, {
    creates_join_request: true,
    expire_date: Math.floor(Date.now() / 1000) + 600
  });

  ctx.reply(
`تم تفعيل التجربة 48 ساعة

اضغط للدخول:`,
    Markup.inlineKeyboard([
      [Markup.button.url('دخول القناة', link.invite_link)]
    ])
  );
});

// قبول الدخول فقط لصاحب الرابط
bot.on('chat_join_request', async (ctx) => {
  const userId = ctx.update.chat_join_request.from.id;

  const user = await db.collection('users').findOne({ userId });

  if (!user) {
    return bot.telegram.declineChatJoinRequest(CHANNEL_ID, userId);
  }

  await bot.telegram.approveChatJoinRequest(CHANNEL_ID, userId);
});

// حذف بعد انتهاء التجربة
cron.schedule('*/5 * * * *', async () => {
  const now = new Date();

  const expired = await db.collection('trials').find({
    status: 'active',
    end: { $lt: now }
  }).toArray();

  for (let t of expired) {
    await db.collection('trials').updateOne(
      { _id: t._id },
      { $set: { status: 'expired' } }
    );

    await bot.telegram.banChatMember(CHANNEL_ID, t.userId);
    await bot.telegram.unbanChatMember(CHANNEL_ID, t.userId);

    await bot.telegram.sendMessage(
      t.userId,
      'انتهت الفترة التجريبية'
    );
  }
});

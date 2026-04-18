require('dotenv').config();

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

console.log('BOOT START');
console.log('BOT_TOKEN exists:', !!process.env.BOT_TOKEN);
console.log('MONGO_URI exists:', !!process.env.MONGO_URI);
console.log('CHANNEL_ID:', process.env.CHANNEL_ID);
console.log('ADMIN_ID:', process.env.ADMIN_ID);

const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

const web = express();
const PORT = process.env.PORT || 3000;

web.get('/', (req, res) => {
  res.send('BAMSPX bot is running');
});

web.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

if (!process.env.BOT_TOKEN) {
  console.error('Missing BOT_TOKEN');
  process.exit(1);
}
if (!process.env.MONGO_URI) {
  console.error('Missing MONGO_URI');
  process.exit(1);
}
if (!process.env.CHANNEL_ID) {
  console.error('Missing CHANNEL_ID');
  process.exit(1);
}
if (!process.env.ADMIN_ID) {
  console.error('Missing ADMIN_ID');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const client = new MongoClient(process.env.MONGO_URI);

let db;

const CHANNEL_ID = Number(process.env.CHANNEL_ID);
const ADMIN_ID = Number(process.env.ADMIN_ID);

const BANK_NAME = process.env.BANK_NAME || 'اسم البنك';
const ACCOUNT_NAME = process.env.ACCOUNT_NAME || 'اسم صاحب الحساب';
const BANK_IBAN = process.env.BANK_IBAN || 'SAxxxxxxxxxxxxxxxxxxxx';
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || '@support';

// مدة صلاحية رابط طلب الانضمام بالدقائق
const JOIN_LINK_EXPIRE_MINUTES = Number(process.env.JOIN_LINK_EXPIRE_MINUTES || 10);

if (Number.isNaN(CHANNEL_ID)) {
  console.error('CHANNEL_ID is not a valid number:', process.env.CHANNEL_ID);
  process.exit(1);
}
if (Number.isNaN(ADMIN_ID)) {
  console.error('ADMIN_ID is not a valid number:', process.env.ADMIN_ID);
  process.exit(1);
}
if (Number.isNaN(JOIN_LINK_EXPIRE_MINUTES) || JOIN_LINK_EXPIRE_MINUTES <= 0) {
  console.error('JOIN_LINK_EXPIRE_MINUTES is invalid:', process.env.JOIN_LINK_EXPIRE_MINUTES);
  process.exit(1);
}

const PLANS = {
  'شهري': { price: 250, days: 30 },
  '3 شهور': { price: 550, days: 90 },
  '6 شهور': { price: 1000, days: 180 },
  'سنوي': { price: 2500, days: 365 }
};

const awaitingProof = new Map();

function mainMenu() {
  return Markup.keyboard([
    ['الاشتراكات', 'حالة الاشتراك'],
    ['الدعم']
  ]).resize();
}

function plansMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('شهري — 250 ريال', 'plan_شهري')],
    [Markup.button.callback('3 شهور — 550 ريال', 'plan_3 شهور')],
    [Markup.button.callback('6 شهور — 1000 ريال', 'plan_6 شهور')],
    [Markup.button.callback('سنوي — 2500 ريال', 'plan_سنوي')],
    [Markup.button.callback('رجوع', 'back_main')]
  ]);
}

async function connectDB() {
  try {
    console.log('Connecting to MongoDB...');
    await client.connect();
    db = client.db('bamspx1');

    await db.collection('users').createIndex({ user_id: 1 }, { unique: true });
    await db.collection('orders').createIndex({ order_id: 1 }, { unique: true });
    await db.collection('join_links').createIndex({ user_id: 1 });
    await db.collection('join_links').createIndex({ invite_link: 1 });

    console.log('DB connected');
  } catch (err) {
    console.error('DB CONNECTION ERROR:', err);
    process.exit(1);
  }
}

async function createOrder(user, planName) {
  const order_id = uuidv4().slice(0, 8);
  const plan = PLANS[planName];

  if (!plan) {
    throw new Error(`Invalid plan selected: ${planName}`);
  }

  await db.collection('orders').insertOne({
    order_id,
    user_id: user.id,
    username: user.username || '',
    full_name: [user.first_name, user.last_name].filter(Boolean).join(' '),
    plan: planName,
    price: plan.price,
    status: 'PENDING',
    created_at: new Date()
  });

  return { order_id, plan };
}

function paymentText(order_id, planName, price) {
  return `تفاصيل الطلب

رقم الطلب: ${order_id}
الباقة: ${planName}
المبلغ: ${price} ريال

طريقة الدفع:
تحويل بنكي

اسم البنك: ${BANK_NAME}
اسم الحساب: ${ACCOUNT_NAME}
رقم الآيبان:
${BANK_IBAN}

بعد التحويل اضغط "تم التحويل" ثم أرسل صورة الإيصال.`;
}

async function revokeActiveJoinLinksForUser(userId) {
  const activeLinks = await db.collection('join_links').find({
    user_id: userId,
    status: { $in: ['ACTIVE', 'PENDING_JOIN'] }
  }).toArray();

  for (const link of activeLinks) {
    try {
      await bot.telegram.callApi('revokeChatInviteLink', {
        chat_id: CHANNEL_ID,
        invite_link: link.invite_link
      });
    } catch (err) {
      console.error('REVOKE LINK ERROR:', err?.description || err);
    }

    await db.collection('join_links').updateOne(
      { _id: link._id },
      {
        $set: {
          status: 'REVOKED',
          revoked_at: new Date()
        }
      }
    );
  }
}

async function createPrivateJoinRequestLinkForUser(userId, orderId) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + JOIN_LINK_EXPIRE_MINUTES * 60 * 1000);
  const expireDateUnix = Math.floor(expiresAt.getTime() / 1000);

  const linkResponse = await bot.telegram.callApi('createChatInviteLink', {
    chat_id: CHANNEL_ID,
    name: `order_${orderId}_user_${userId}`,
    expire_date: expireDateUnix,
    creates_join_request: true
  });

  await db.collection('join_links').insertOne({
    user_id: userId,
    order_id: orderId,
    invite_link: linkResponse.invite_link,
    invite_link_name: linkResponse.name || null,
    expires_at: expiresAt,
    status: 'ACTIVE',
    created_at: new Date(),
    approved_join_at: null,
    used_by_user_id: null
  });

  return {
    inviteLink: linkResponse.invite_link,
    expiresAt
  };
}

bot.start(async (ctx) => {
  try {
    await db.collection('users').updateOne(
      { user_id: ctx.from.id },
      {
        $setOnInsert: {
          user_id: ctx.from.id,
          username: ctx.from.username || '',
          full_name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
          status: 'NONE',
          created_at: new Date()
        }
      },
      { upsert: true }
    );

    await ctx.reply(
      `أهلاً بك في BAMSPX

من هنا يمكنك:
- الاشتراك
- متابعة حالة اشتراكك
- التواصل مع الدعم`,
      mainMenu()
    );
  } catch (err) {
    console.error('START ERROR:', err);
    await ctx.reply('حدث خطأ أثناء التشغيل، حاول مرة أخرى.');
  }
});

bot.hears('الاشتراكات', async (ctx) => {
  try {
    await ctx.reply(
      `الباقات المتاحة

اختر الباقة المناسبة:`,
      plansMenu()
    );
  } catch (err) {
    console.error('SUBSCRIPTIONS MENU ERROR:', err);
    await ctx.reply('تعذر عرض الباقات حالياً.');
  }
});

bot.hears('حالة الاشتراك', async (ctx) => {
  try {
    const user = await db.collection('users').findOne({ user_id: ctx.from.id });

    if (!user || user.status !== 'ACTIVE') {
      return await ctx.reply(
        `لا يوجد لديك اشتراك نشط حالياً.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('الاشتراكات', 'open_plans')],
          [Markup.button.callback('الدعم', 'open_support')]
        ])
      );
    }

    const activeJoinLink = await db.collection('join_links').findOne({
      user_id: ctx.from.id,
      status: { $in: ['ACTIVE', 'PENDING_JOIN', 'APPROVED'] }
    });

    const buttons = [];
    if (activeJoinLink && ['ACTIVE', 'PENDING_JOIN'].includes(activeJoinLink.status)) {
      buttons.push([Markup.button.url('رابط الدخول الحالي', activeJoinLink.invite_link)]);
    }
    buttons.push([Markup.button.callback('تجديد الاشتراك', 'open_plans')]);

    await ctx.reply(
      `حالة الاشتراك: نشط

الباقة: ${user.plan}
ينتهي: ${new Date(user.end_date).toLocaleString('ar-SA')}`,
      Markup.inlineKeyboard(buttons)
    );
  } catch (err) {
    console.error('STATUS ERROR:', err);
    await ctx.reply('تعذر جلب حالة الاشتراك حالياً.');
  }
});

bot.hears('الدعم', async (ctx) => {
  try {
    await ctx.reply(
      `للتواصل مع الدعم:
${SUPPORT_USERNAME}`,
      Markup.inlineKeyboard([
        [Markup.button.url('تواصل مع الدعم', `https://t.me/${SUPPORT_USERNAME.replace('@', '')}`)],
        [Markup.button.callback('رجوع', 'back_main')]
      ])
    );
  } catch (err) {
    console.error('SUPPORT ERROR:', err);
  }
});

bot.action('back_main', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply(
      `أهلاً بك في BAMSPX

من هنا يمكنك:
- الاشتراك
- متابعة حالة اشتراكك
- التواصل مع الدعم`,
      mainMenu()
    );
  } catch (err) {
    console.error('BACK MAIN ERROR:', err);
  }
});

bot.action('open_plans', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply(
      `الباقات المتاحة

اختر الباقة المناسبة:`,
      plansMenu()
    );
  } catch (err) {
    console.error('OPEN PLANS ERROR:', err);
  }
});

bot.action('open_support', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply(
      `للتواصل مع الدعم:
${SUPPORT_USERNAME}`,
      Markup.inlineKeyboard([
        [Markup.button.url('تواصل مع الدعم', `https://t.me/${SUPPORT_USERNAME.replace('@', '')}`)],
        [Markup.button.callback('رجوع', 'back_main')]
      ])
    );
  } catch (err) {
    console.error('OPEN SUPPORT ERROR:', err);
  }
});

bot.action(/plan_(.+)/, async (ctx) => {
  try {
    const planName = ctx.match[1];
    const { order_id, plan } = await createOrder(ctx.from, planName);

    await ctx.answerCbQuery();
    await ctx.reply(
      paymentText(order_id, planName, plan.price),
      Markup.inlineKeyboard([
        [Markup.button.callback('تم التحويل', `paid_${order_id}`)],
        [Markup.button.callback('نسخ الآيبان', 'copy_iban')],
        [Markup.button.callback('رجوع', 'open_plans')]
      ])
    );
  } catch (err) {
    console.error('PLAN ACTION ERROR:', err);
    try {
      await ctx.answerCbQuery('حدث خطأ');
      await ctx.reply('تعذر إنشاء الطلب، حاول مرة أخرى.');
    } catch (_) {}
  }
});

bot.action('copy_iban', async (ctx) => {
  try {
    await ctx.answerCbQuery('تم عرض الآيبان');
    await ctx.reply(`رقم الآيبان:
${BANK_IBAN}`);
  } catch (err) {
    console.error('COPY IBAN ERROR:', err);
  }
});

bot.action(/paid_(.+)/, async (ctx) => {
  try {
    const order_id = ctx.match[1];
    awaitingProof.set(ctx.from.id, order_id);

    await ctx.answerCbQuery();
    await ctx.reply('أرسل صورة الإيصال الآن.');
  } catch (err) {
    console.error('PAID ACTION ERROR:', err);
    try {
      await ctx.answerCbQuery('حدث خطأ');
    } catch (_) {}
  }
});

bot.on('photo', async (ctx) => {
  try {
    const order_id = awaitingProof.get(ctx.from.id);
    if (!order_id) return;

    const photoSizes = ctx.message.photo;
    const file_id = photoSizes[photoSizes.length - 1].file_id;

    const order = await db.collection('orders').findOne({ order_id });
    if (!order) {
      awaitingProof.delete(ctx.from.id);
      return await ctx.reply('تعذر العثور على الطلب، أعد المحاولة.');
    }

    await db.collection('orders').updateOne(
      { order_id },
      {
        $set: {
          proof_file_id: file_id,
          status: 'PENDING_REVIEW',
          proof_uploaded_at: new Date()
        }
      }
    );

    awaitingProof.delete(ctx.from.id);

    await bot.telegram.sendPhoto(ADMIN_ID, file_id, {
      caption: `طلب اشتراك جديد

رقم الطلب: ${order_id}
اسم المستخدم: ${ctx.from.first_name || ''} ${ctx.from.last_name || ''}
Telegram ID: ${ctx.from.id}
الباقة: ${order.plan}
المبلغ: ${order.price} ريال

يرجى مراجعة الإيصال واتخاذ الإجراء المناسب.`,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('قبول الطلب', `approve_${order_id}`),
          Markup.button.callback('رفض الطلب', `reject_${order_id}`)
        ]
      ])
    });

    await ctx.reply(
      `تم استلام الإيصال.

طلبك الآن تحت المراجعة، وسيتم إشعارك بعد اعتماد الاشتراك.`
    );
  } catch (err) {
    console.error('PHOTO HANDLER ERROR:', err);
    await ctx.reply('حدث خطأ أثناء رفع الإيصال.');
  }
});

bot.action(/approve_(.+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) {
      return await ctx.answerCbQuery('غير مصرح');
    }

    const order_id = ctx.match[1];
    const order = await db.collection('orders').findOne({ order_id });

    if (!order) {
      return await ctx.answerCbQuery('الطلب غير موجود');
    }

    if (order.status === 'APPROVED') {
      return await ctx.answerCbQuery('تم اعتماد الطلب مسبقاً');
    }

    const planInfo = PLANS[order.plan];
    if (!planInfo) {
      throw new Error(`Plan not found for approved order: ${order.plan}`);
    }

    const now = new Date();
    const end = new Date(now.getTime() + planInfo.days * 24 * 60 * 60 * 1000);

    await db.collection('users').updateOne(
      { user_id: order.user_id },
      {
        $set: {
          status: 'ACTIVE',
          plan: order.plan,
          start_date: now,
          end_date: end,
          updated_at: new Date()
        }
      },
      { upsert: true }
    );

    await db.collection('orders').updateOne(
      { order_id },
      {
        $set: {
          status: 'APPROVED',
          approved_at: new Date(),
          approved_by: ctx.from.id
        }
      }
    );

    // إلغاء أي روابط سابقة للمستخدم
    await revokeActiveJoinLinksForUser(order.user_id);

    // إنشاء رابط طلب انضمام خاص بالمستخدم
    const { inviteLink, expiresAt } = await createPrivateJoinRequestLinkForUser(order.user_id, order_id);

    await bot.telegram.sendMessage(
      order.user_id,
      `تم تفعيل اشتراكك بنجاح

الباقة: ${order.plan}
ينتهي الاشتراك: ${end.toLocaleString('ar-SA')}

هذا الرابط خاص بك فقط.
صلاحية الرابط تنتهي خلال ${JOIN_LINK_EXPIRE_MINUTES} دقائق.

بعد الضغط على الرابط:
أرسل طلب الانضمام، وسيتم قبولك تلقائياً إذا كان الحساب هو نفس الحساب المشترك.`,
      Markup.inlineKeyboard([
        [Markup.button.url('طلب الانضمام', inviteLink)],
        [Markup.button.url('الدعم', `https://t.me/${SUPPORT_USERNAME.replace('@', '')}`)]
      ])
    );

    await ctx.answerCbQuery('تم القبول');
    await ctx.editMessageCaption(`تم قبول الطلب ${order_id}`);
  } catch (err) {
    console.error('APPROVE ERROR:', err);
    try {
      await ctx.answerCbQuery('حدث خطأ أثناء القبول');
    } catch (_) {}
  }
});

bot.action(/reject_(.+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) {
      return await ctx.answerCbQuery('غير مصرح');
    }

    const order_id = ctx.match[1];
    const order = await db.collection('orders').findOne({ order_id });

    await db.collection('orders').updateOne(
      { order_id },
      {
        $set: {
          status: 'REJECTED',
          rejected_at: new Date(),
          rejected_by: ctx.from.id
        }
      }
    );

    if (order?.user_id) {
      await bot.telegram.sendMessage(
        order.user_id,
        `تعذر اعتماد طلبك.

يرجى التواصل مع الدعم أو إعادة إرسال إثبات واضح.`,
        Markup.inlineKeyboard([
          [Markup.button.url('التواصل مع الدعم', `https://t.me/${SUPPORT_USERNAME.replace('@', '')}`)],
          [Markup.button.callback('إعادة الاشتراك', 'open_plans')]
        ])
      );
    }

    await ctx.answerCbQuery('تم الرفض');
    await ctx.editMessageCaption(`تم رفض الطلب ${order_id}`);
  } catch (err) {
    console.error('REJECT ERROR:', err);
    try {
      await ctx.answerCbQuery('حدث خطأ أثناء الرفض');
    } catch (_) {}
  }
});

// استقبال طلبات الانضمام والموافقة فقط على صاحب الاشتراك
bot.on('chat_join_request', async (ctx) => {
  try {
    const joinRequest = ctx.update.chat_join_request;
    const requestUserId = joinRequest.from.id;
    const inviteLinkUsed = joinRequest.invite_link?.invite_link || null;

    console.log('CHAT JOIN REQUEST:', {
      requestUserId,
      inviteLinkUsed,
      chatId: joinRequest.chat.id
    });

    const joinLink = await db.collection('join_links').findOne({
      invite_link: inviteLinkUsed
    });

    if (!joinLink) {
      await bot.telegram.callApi('declineChatJoinRequest', {
        chat_id: CHANNEL_ID,
        user_id: requestUserId
      });
      return;
    }

    const now = new Date();

    if (joinLink.status !== 'ACTIVE' && joinLink.status !== 'PENDING_JOIN') {
      await bot.telegram.callApi('declineChatJoinRequest', {
        chat_id: CHANNEL_ID,
        user_id: requestUserId
      });
      return;
    }

    if (new Date(joinLink.expires_at).getTime() < now.getTime()) {
      await db.collection('join_links').updateOne(
        { _id: joinLink._id },
        {
          $set: {
            status: 'EXPIRED',
            expired_at: now
          }
        }
      );

      await bot.telegram.callApi('declineChatJoinRequest', {
        chat_id: CHANNEL_ID,
        user_id: requestUserId
      });

      if (requestUserId === joinLink.user_id) {
        try {
          await bot.telegram.sendMessage(
            requestUserId,
            `انتهت صلاحية رابط الانضمام.

يرجى التواصل مع الدعم أو طلب رابط جديد من الإدارة.`
          );
        } catch (err) {
          console.error('EXPIRED LINK MESSAGE ERROR:', err);
        }
      }
      return;
    }

    if (requestUserId !== joinLink.user_id) {
      await bot.telegram.callApi('declineChatJoinRequest', {
        chat_id: CHANNEL_ID,
        user_id: requestUserId
      });

      try {
        await bot.telegram.sendMessage(
          ADMIN_ID,
          `تم رفض طلب انضمام من مستخدم غير مطابق للرابط الخاص.

User ID: ${requestUserId}
الرابط مخصص للمستخدم: ${joinLink.user_id}`
        );
      } catch (err) {
        console.error('ADMIN ALERT ERROR:', err);
      }

      return;
    }

    await bot.telegram.callApi('approveChatJoinRequest', {
      chat_id: CHANNEL_ID,
      user_id: requestUserId
    });

    await db.collection('join_links').updateOne(
      { _id: joinLink._id },
      {
        $set: {
          status: 'APPROVED',
          approved_join_at: now,
          used_by_user_id: requestUserId
        }
      }
    );

    try {
      await bot.telegram.sendMessage(
        requestUserId,
        `تم قبول طلب انضمامك بنجاح.

مرحباً بك في BAMSPX.`
      );
    } catch (err) {
      console.error('JOIN APPROVED MESSAGE ERROR:', err);
    }
  } catch (err) {
    console.error('CHAT JOIN REQUEST HANDLER ERROR:', err);
  }
});

cron.schedule('*/10 * * * *', async () => {
  try {
    if (!db) return;

    const now = new Date();

    const expiredUsers = await db.collection('users').find({
      status: 'ACTIVE',
      end_date: { $lt: now }
    }).toArray();

    for (const user of expiredUsers) {
      await db.collection('users').updateOne(
        { user_id: user.user_id },
        {
          $set: {
            status: 'EXPIRED',
            expired_at: new Date()
          }
        }
      );

      await revokeActiveJoinLinksForUser(user.user_id);

      try {
        await bot.telegram.sendMessage(
          user.user_id,
          `انتهى اشتراكك.

يمكنك التجديد من خلال البوت أو التواصل مع الدعم.`,
          Markup.inlineKeyboard([
            [Markup.button.callback('تجديد الاشتراك', 'open_plans')],
            [Markup.button.url('الدعم', `https://t.me/${SUPPORT_USERNAME.replace('@', '')}`)]
          ])
        );
      } catch (msgErr) {
        console.error(`EXPIRE MESSAGE ERROR for ${user.user_id}:`, msgErr);
      }
    }

    // تنظيف روابط الانضمام المنتهية الصلاحية
    const expiredLinks = await db.collection('join_links').find({
      status: { $in: ['ACTIVE', 'PENDING_JOIN'] },
      expires_at: { $lt: now }
    }).toArray();

    for (const link of expiredLinks) {
      try {
        await bot.telegram.callApi('revokeChatInviteLink', {
          chat_id: CHANNEL_ID,
          invite_link: link.invite_link
        });
      } catch (err) {
        console.error('EXPIRED LINK REVOKE ERROR:', err?.description || err);
      }

      await db.collection('join_links').updateOne(
        { _id: link._id },
        {
          $set: {
            status: 'EXPIRED',
            expired_at: now
          }
        }
      );
    }
  } catch (err) {
    console.error('CRON ERROR:', err);
  }
});

(async () => {
  try {
    await connectDB();
    console.log('Launching bot...');
    await bot.launch({
      allowedUpdates: ['message', 'callback_query', 'chat_join_request']
    });
    console.log('Bot launched successfully');
  } catch (err) {
    console.error('BOT LAUNCH ERROR:', err);
    process.exit(1);
  }
})();

process.once('SIGINT', () => {
  console.log('SIGINT received, stopping bot...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('SIGTERM received, stopping bot...');
  bot.stop('SIGTERM');
});

require('dotenv').config();

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

console.log('BOOT START');
console.log('BOT_TOKEN exists:', !!process.env.BOT_TOKEN);
console.log('MONGO_URI exists:', !!process.env.MONGO_URI);
console.log('CHANNEL_ID:', process.env.CHANNEL_ID);
console.log('ADMIN_ID:', process.env.ADMIN_ID);

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

const JOIN_LINK_EXPIRE_MINUTES = Number(process.env.JOIN_LINK_EXPIRE_MINUTES || 10);
const REMINDER_DAYS_BEFORE = Number(process.env.REMINDER_DAYS_BEFORE || 3);

if (Number.isNaN(CHANNEL_ID)) {
  console.error('CHANNEL_ID is not a valid number:', process.env.CHANNEL_ID);
  process.exit(1);
}
if (Number.isNaN(ADMIN_ID)) {
  console.error('ADMIN_ID is not a valid number:', process.env.ADMIN_ID);
  process.exit(1);
}
if (Number.isNaN(JOIN_LINK_EXPIRE_MINUTES) || JOIN_LINK_EXPIRE_MINUTES <= 0) {
  console.error('JOIN_LINK_EXPIRE_MINUTES is invalid');
  process.exit(1);
}
if (Number.isNaN(REMINDER_DAYS_BEFORE) || REMINDER_DAYS_BEFORE < 0) {
  console.error('REMINDER_DAYS_BEFORE is invalid');
  process.exit(1);
}

const PLANS = {
  'شهري': { price: 250, days: 30 },
  '3 شهور': { price: 550, days: 90 },
  '6 شهور': { price: 1000, days: 180 },
  'سنوي': { price: 2500, days: 365 }
};

const awaitingProof = new Map();

function isAdmin(userId) {
  return Number(userId) === ADMIN_ID;
}

function mainMenu(userId) {
  const rows = [
    ['الاشتراك', 'اشتراكي'],
    ['الدعم']
  ];

  if (isAdmin(userId)) {
    rows.push(['الإدارة']);
  }

  return Markup.keyboard(rows).resize();
}

function plansMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('شهري', 'plan_شهري'),
      Markup.button.callback('3 شهور', 'plan_3 شهور')
    ],
    [
      Markup.button.callback('6 شهور', 'plan_6 شهور'),
      Markup.button.callback('سنوي', 'plan_سنوي')
    ],
    [Markup.button.callback('رجوع', 'back_main')]
  ]);
}

function adminMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('الإحصائيات', 'admin_stats'),
      Markup.button.callback('الطلبات', 'admin_pending')
    ],
    [
      Markup.button.callback('المشتركين', 'admin_active_users'),
      Markup.button.callback('المنتهية', 'admin_expired_users')
    ],
    [Markup.button.callback('رجوع', 'back_main')]
  ]);
}

function paymentButtons(orderId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('تم التحويل', `paid_${orderId}`)],
    [Markup.button.callback('نسخ الآيبان', 'copy_iban')],
    [Markup.button.callback('رجوع', 'open_plans')]
  ]);
}

function supportButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.url('تواصل مع الدعم', `https://t.me/${SUPPORT_USERNAME.replace('@', '')}`)],
    [Markup.button.callback('رجوع', 'back_main')]
  ]);
}

function activeSubscriptionButtons(joinLink) {
  const rows = [];
  if (joinLink && ['ACTIVE', 'PENDING_JOIN'].includes(joinLink.status)) {
    rows.push([Markup.button.url('رابط الدخول', joinLink.invite_link)]);
  }
  rows.push([
    Markup.button.callback('رابط جديد', 'new_link'),
    Markup.button.callback('تجديد', 'open_plans')
  ]);
  return Markup.inlineKeyboard(rows);
}

async function connectDB() {
  try {
    console.log('Connecting to MongoDB...');
    await client.connect();
    db = client.db('bamspx1');

    await db.collection('users').createIndex({ user_id: 1 }, { unique: true });
    await db.collection('orders').createIndex({ order_id: 1 }, { unique: true });
    await db.collection('join_links').createIndex({ invite_link: 1 }, { unique: true });
    await db.collection('join_links').createIndex({ user_id: 1 });
    await db.collection('users').createIndex({ status: 1 });
    await db.collection('orders').createIndex({ status: 1 });

    console.log('DB connected');
  } catch (err) {
    console.error('DB CONNECTION ERROR:', err);
    process.exit(1);
  }
}

function paymentText(orderId, planName, price) {
  return `تفاصيل الطلب

رقم الطلب: ${orderId}
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

async function createOrder(user, planName) {
  const orderId = uuidv4().slice(0, 8);
  const plan = PLANS[planName];

  if (!plan) {
    throw new Error(`Invalid plan: ${planName}`);
  }

  await db.collection('orders').insertOne({
    order_id: orderId,
    user_id: user.id,
    username: user.username || '',
    full_name: [user.first_name, user.last_name].filter(Boolean).join(' '),
    plan: planName,
    price: plan.price,
    status: 'PENDING',
    created_at: new Date()
  });

  return { orderId, plan };
}

async function ensureUser(ctx) {
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
}

async function revokeLink(inviteLink) {
  try {
    await bot.telegram.callApi('revokeChatInviteLink', {
      chat_id: CHANNEL_ID,
      invite_link: inviteLink
    });
  } catch (err) {
    console.error('REVOKE LINK ERROR:', err?.description || err);
  }
}

async function revokeActiveJoinLinksForUser(userId) {
  const links = await db.collection('join_links').find({
    user_id: userId,
    status: { $in: ['ACTIVE', 'PENDING_JOIN'] }
  }).toArray();

  for (const link of links) {
    await revokeLink(link.invite_link);
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
    name: `user_${userId}_order_${orderId}`,
    expire_date: expireDateUnix,
    creates_join_request: true
  });

  await db.collection('join_links').insertOne({
    user_id: userId,
    order_id: orderId,
    invite_link: linkResponse.invite_link,
    expires_at: expiresAt,
    status: 'ACTIVE',
    created_at: new Date(),
    used_by_user_id: null,
    approved_join_at: null,
    reminder_sent: false
  });

  return {
    inviteLink: linkResponse.invite_link,
    expiresAt
  };
}

async function getLatestActiveJoinLink(userId) {
  return db.collection('join_links').findOne(
    {
      user_id: userId,
      status: { $in: ['ACTIVE', 'PENDING_JOIN', 'APPROVED'] }
    },
    {
      sort: { created_at: -1 }
    }
  );
}

async function createFreshJoinLinkForActiveUser(userId) {
  const user = await db.collection('users').findOne({ user_id: userId });

  if (!user || user.status !== 'ACTIVE') {
    throw new Error('User does not have active subscription');
  }

  await revokeActiveJoinLinksForUser(userId);

  const latestApprovedOrder = await db.collection('orders').findOne(
    {
      user_id: userId,
      status: 'APPROVED'
    },
    { sort: { approved_at: -1 } }
  );

  const orderId = latestApprovedOrder?.order_id || `manual_${Date.now()}`;

  return createPrivateJoinRequestLinkForUser(userId, orderId);
}

async function removeUserFromChannel(userId) {
  try {
    await bot.telegram.banChatMember(CHANNEL_ID, userId);
    await bot.telegram.unbanChatMember(CHANNEL_ID, userId);
  } catch (err) {
    console.error(`REMOVE USER FROM CHANNEL ERROR (${userId}):`, err?.description || err);
  }
}

async function sendMainMenu(ctxOrChatId, userId, text) {
  const messageText = text || `أهلاً بك في BAMSPX

اختر الخدمة المطلوبة من القائمة التالية.`;

  if (typeof ctxOrChatId === 'number') {
    await bot.telegram.sendMessage(ctxOrChatId, messageText, mainMenu(userId));
  } else {
    await ctxOrChatId.reply(messageText, mainMenu(userId));
  }
}

bot.start(async (ctx) => {
  try {
    await ensureUser(ctx);
    await sendMainMenu(ctx, ctx.from.id);
  } catch (err) {
    console.error('START ERROR:', err);
    await ctx.reply('حدث خطأ أثناء التشغيل، حاول مرة أخرى.');
  }
});

bot.hears('الاشتراك', async (ctx) => {
  try {
    await ctx.reply(
      `الباقات المتاحة

اختر الباقة المناسبة:`,
      plansMenu()
    );
  } catch (err) {
    console.error('OPEN SUBSCRIPTIONS ERROR:', err);
  }
});

bot.hears('اشتراكي', async (ctx) => {
  try {
    const user = await db.collection('users').findOne({ user_id: ctx.from.id });

    if (!user || user.status !== 'ACTIVE') {
      return await ctx.reply(
        `لا يوجد لديك اشتراك نشط حالياً.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('الاشتراك', 'open_plans')],
          [Markup.button.callback('الدعم', 'open_support')]
        ])
      );
    }

    const joinLink = await getLatestActiveJoinLink(ctx.from.id);

    await ctx.reply(
      `حالة الاشتراك: نشط

الباقة: ${user.plan}
ينتهي: ${new Date(user.end_date).toLocaleString('ar-SA')}`,
      activeSubscriptionButtons(joinLink)
    );
  } catch (err) {
    console.error('MY SUBSCRIPTION ERROR:', err);
    await ctx.reply('تعذر جلب حالة الاشتراك حالياً.');
  }
});

bot.hears('الدعم', async (ctx) => {
  try {
    await ctx.reply(
      `للتواصل مع الدعم:
${SUPPORT_USERNAME}`,
      supportButtons()
    );
  } catch (err) {
    console.error('SUPPORT ERROR:', err);
  }
});

bot.hears('الإدارة', async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.reply('لوحة الإدارة', adminMenu());
  } catch (err) {
    console.error('ADMIN MENU ERROR:', err);
  }
});

bot.action('back_main', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await sendMainMenu(ctx, ctx.from.id);
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
      supportButtons()
    );
  } catch (err) {
    console.error('OPEN SUPPORT ERROR:', err);
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

bot.action(/plan_(.+)/, async (ctx) => {
  try {
    const planName = ctx.match[1];
    const { orderId, plan } = await createOrder(ctx.from, planName);

    await ctx.answerCbQuery();
    await ctx.reply(
      paymentText(orderId, planName, plan.price),
      paymentButtons(orderId)
    );
  } catch (err) {
    console.error('PLAN ACTION ERROR:', err);
    try {
      await ctx.answerCbQuery('حدث خطأ');
    } catch (_) {}
  }
});

bot.action(/paid_(.+)/, async (ctx) => {
  try {
    const orderId = ctx.match[1];
    awaitingProof.set(ctx.from.id, orderId);

    await ctx.answerCbQuery();
    await ctx.reply('أرسل صورة الإيصال الآن.');
  } catch (err) {
    console.error('PAID ACTION ERROR:', err);
  }
});

bot.on('photo', async (ctx) => {
  try {
    const orderId = awaitingProof.get(ctx.from.id);
    if (!orderId) return;

    const photoSizes = ctx.message.photo;
    const fileId = photoSizes[photoSizes.length - 1].file_id;

    const order = await db.collection('orders').findOne({ order_id: orderId });
    if (!order) {
      awaitingProof.delete(ctx.from.id);
      return await ctx.reply('تعذر العثور على الطلب، أعد المحاولة.');
    }

    await db.collection('orders').updateOne(
      { order_id: orderId },
      {
        $set: {
          proof_file_id: fileId,
          status: 'PENDING_REVIEW',
          proof_uploaded_at: new Date()
        }
      }
    );

    awaitingProof.delete(ctx.from.id);

    await bot.telegram.sendPhoto(ADMIN_ID, fileId, {
      caption: `طلب جديد

رقم الطلب: ${orderId}
المستخدم: ${ctx.from.first_name || ''} ${ctx.from.last_name || ''}
Telegram ID: ${ctx.from.id}
الباقة: ${order.plan}
المبلغ: ${order.price} ريال`,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('قبول', `approve_${orderId}`),
          Markup.button.callback('رفض', `reject_${orderId}`)
        ]
      ])
    });

    await ctx.reply(
      `تم استلام الإيصال.

طلبك الآن تحت المراجعة.`
    );
  } catch (err) {
    console.error('PHOTO HANDLER ERROR:', err);
    await ctx.reply('حدث خطأ أثناء رفع الإيصال.');
  }
});

bot.action(/approve_(.+)/, async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) {
      return await ctx.answerCbQuery('غير مصرح');
    }

    const orderId = ctx.match[1];
    const order = await db.collection('orders').findOne({ order_id: orderId });

    if (!order) {
      return await ctx.answerCbQuery('الطلب غير موجود');
    }

    if (order.status === 'APPROVED') {
      return await ctx.answerCbQuery('تم اعتماد الطلب مسبقاً');
    }

    const planInfo = PLANS[order.plan];
    if (!planInfo) {
      throw new Error(`Plan not found for order ${order.plan}`);
    }

    const currentUser = await db.collection('users').findOne({ user_id: order.user_id });
    const now = new Date();

    let startDate = now;
    if (currentUser && currentUser.status === 'ACTIVE' && currentUser.end_date && new Date(currentUser.end_date) > now) {
      startDate = new Date(currentUser.end_date);
    }

    const endDate = new Date(startDate.getTime() + planInfo.days * 24 * 60 * 60 * 1000);

    await db.collection('users').updateOne(
      { user_id: order.user_id },
      {
        $set: {
          status: 'ACTIVE',
          plan: order.plan,
          start_date: currentUser?.status === 'ACTIVE' ? currentUser.start_date || now : now,
          end_date: endDate,
          updated_at: new Date(),
          reminder_sent: false
        }
      },
      { upsert: true }
    );

    await db.collection('orders').updateOne(
      { order_id: orderId },
      {
        $set: {
          status: 'APPROVED',
          approved_at: new Date(),
          approved_by: ctx.from.id
        }
      }
    );

    await revokeActiveJoinLinksForUser(order.user_id);
    const { inviteLink } = await createPrivateJoinRequestLinkForUser(order.user_id, orderId);

    await bot.telegram.sendMessage(
      order.user_id,
      `تم تفعيل اشتراكك بنجاح

الباقة: ${order.plan}
ينتهي الاشتراك: ${endDate.toLocaleString('ar-SA')}

هذا الرابط خاص بك فقط.
صلاحية الرابط ${JOIN_LINK_EXPIRE_MINUTES} دقائق.`,
      Markup.inlineKeyboard([
        [Markup.button.url('طلب الانضمام', inviteLink)],
        [
          Markup.button.callback('رابط جديد', 'new_link'),
          Markup.button.url('الدعم', `https://t.me/${SUPPORT_USERNAME.replace('@', '')}`)
        ]
      ])
    );

    await ctx.answerCbQuery('تم القبول');
    await ctx.editMessageCaption(`تم قبول الطلب ${orderId}`);
  } catch (err) {
    console.error('APPROVE ERROR:', err);
    try {
      await ctx.answerCbQuery('حدث خطأ');
    } catch (_) {}
  }
});

bot.action(/reject_(.+)/, async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) {
      return await ctx.answerCbQuery('غير مصرح');
    }

    const orderId = ctx.match[1];
    const order = await db.collection('orders').findOne({ order_id: orderId });

    await db.collection('orders').updateOne(
      { order_id: orderId },
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
          [Markup.button.url('الدعم', `https://t.me/${SUPPORT_USERNAME.replace('@', '')}`)],
          [Markup.button.callback('الاشتراك', 'open_plans')]
        ])
      );
    }

    await ctx.answerCbQuery('تم الرفض');
    await ctx.editMessageCaption(`تم رفض الطلب ${orderId}`);
  } catch (err) {
    console.error('REJECT ERROR:', err);
  }
});

bot.action('new_link', async (ctx) => {
  try {
    const user = await db.collection('users').findOne({ user_id: ctx.from.id });

    if (!user || user.status !== 'ACTIVE') {
      await ctx.answerCbQuery('لا يوجد اشتراك نشط');
      return;
    }

    await revokeActiveJoinLinksForUser(ctx.from.id);
    const { inviteLink } = await createFreshJoinLinkForActiveUser(ctx.from.id);

    await ctx.answerCbQuery('تم إنشاء رابط جديد');
    await ctx.reply(
      `تم إنشاء رابط جديد.

صلاحية الرابط ${JOIN_LINK_EXPIRE_MINUTES} دقائق.`,
      Markup.inlineKeyboard([
        [Markup.button.url('طلب الانضمام', inviteLink)],
        [Markup.button.callback('رجوع', 'back_main')]
      ])
    );
  } catch (err) {
    console.error('NEW LINK ERROR:', err);
    try {
      await ctx.answerCbQuery('تعذر إنشاء رابط جديد');
    } catch (_) {}
  }
});

bot.on('chat_join_request', async (ctx) => {
  try {
    const joinRequest = ctx.update.chat_join_request;
    const requestUserId = joinRequest.from.id;
    const inviteLinkUsed = joinRequest.invite_link?.invite_link || null;

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

    if (!['ACTIVE', 'PENDING_JOIN'].includes(joinLink.status)) {
      await bot.telegram.callApi('declineChatJoinRequest', {
        chat_id: CHANNEL_ID,
        user_id: requestUserId
      });
      return;
    }

    if (new Date(joinLink.expires_at) < now) {
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
          `تم رفض طلب انضمام غير مطابق

المستخدم: ${requestUserId}
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

    await bot.telegram.sendMessage(
      requestUserId,
      `تم قبول طلب الانضمام بنجاح.`
    );
  } catch (err) {
    console.error('CHAT JOIN REQUEST ERROR:', err);
  }
});

bot.action('admin_stats', async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    const activeCount = await db.collection('users').countDocuments({ status: 'ACTIVE' });
    const expiredCount = await db.collection('users').countDocuments({ status: 'EXPIRED' });
    const pendingOrders = await db.collection('orders').countDocuments({ status: 'PENDING_REVIEW' });
    const approvedOrders = await db.collection('orders').countDocuments({ status: 'APPROVED' });

    await ctx.answerCbQuery();
    await ctx.reply(
      `الإحصائيات

المشتركين النشطين: ${activeCount}
الاشتراكات المنتهية: ${expiredCount}
الطلبات المعلقة: ${pendingOrders}
الطلبات المعتمدة: ${approvedOrders}`,
      adminMenu()
    );
  } catch (err) {
    console.error('ADMIN STATS ERROR:', err);
  }
});

bot.action('admin_pending', async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    const orders = await db.collection('orders')
      .find({ status: 'PENDING_REVIEW' })
      .sort({ created_at: -1 })
      .limit(10)
      .toArray();

    await ctx.answerCbQuery();

    if (!orders.length) {
      return await ctx.reply('لا توجد طلبات معلقة.', adminMenu());
    }

    const text = orders.map((o, i) =>
      `${i + 1}) ${o.order_id} — ${o.plan} — ${o.price} ريال`
    ).join('\n');

    await ctx.reply(`الطلبات المعلقة

${text}`, adminMenu());
  } catch (err) {
    console.error('ADMIN PENDING ERROR:', err);
  }
});

bot.action('admin_active_users', async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    const users = await db.collection('users')
      .find({ status: 'ACTIVE' })
      .sort({ end_date: 1 })
      .limit(10)
      .toArray();

    await ctx.answerCbQuery();

    if (!users.length) {
      return await ctx.reply('لا يوجد مشتركون نشطون.', adminMenu());
    }

    const text = users.map((u, i) =>
      `${i + 1}) ${u.user_id} — ${u.plan} — ${new Date(u.end_date).toLocaleDateString('ar-SA')}`
    ).join('\n');

    await ctx.reply(`أحدث المشتركين النشطين

${text}`, adminMenu());
  } catch (err) {
    console.error('ADMIN ACTIVE USERS ERROR:', err);
  }
});

bot.action('admin_expired_users', async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    const users = await db.collection('users')
      .find({ status: 'EXPIRED' })
      .sort({ expired_at: -1 })
      .limit(10)
      .toArray();

    await ctx.answerCbQuery();

    if (!users.length) {
      return await ctx.reply('لا توجد اشتراكات منتهية حالياً.', adminMenu());
    }

    const text = users.map((u, i) =>
      `${i + 1}) ${u.user_id} — ${u.plan || '-'}`
    ).join('\n');

    await ctx.reply(`أحدث الاشتراكات المنتهية

${text}`, adminMenu());
  } catch (err) {
    console.error('ADMIN EXPIRED USERS ERROR:', err);
  }
});

bot.command('admin', async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.reply('لوحة الإدارة', adminMenu());
  } catch (err) {
    console.error('/admin ERROR:', err);
  }
});

bot.command('extend', async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 3) {
      return await ctx.reply('الاستخدام:\n/extend USER_ID DAYS');
    }

    const userId = Number(parts[1]);
    const days = Number(parts[2]);

    if (Number.isNaN(userId) || Number.isNaN(days) || days <= 0) {
      return await ctx.reply('صيغة غير صحيحة.');
    }

    const user = await db.collection('users').findOne({ user_id: userId });
    const now = new Date();

    const startFrom = user?.status === 'ACTIVE' && user?.end_date && new Date(user.end_date) > now
      ? new Date(user.end_date)
      : now;

    const newEndDate = new Date(startFrom.getTime() + days * 24 * 60 * 60 * 1000);

    await db.collection('users').updateOne(
      { user_id: userId },
      {
        $set: {
          status: 'ACTIVE',
          end_date: newEndDate,
          updated_at: new Date(),
          reminder_sent: false
        }
      },
      { upsert: true }
    );

    await ctx.reply(`تم تمديد الاشتراك للمستخدم ${userId} لمدة ${days} يوم.`);
  } catch (err) {
    console.error('/extend ERROR:', err);
    await ctx.reply('حدث خطأ أثناء التمديد.');
  }
});

bot.command('link', async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return;

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      return await ctx.reply('الاستخدام:\n/link USER_ID');
    }

    const userId = Number(parts[1]);
    if (Number.isNaN(userId)) {
      return await ctx.reply('USER_ID غير صحيح.');
    }

    const user = await db.collection('users').findOne({ user_id: userId });
    if (!user || user.status !== 'ACTIVE') {
      return await ctx.reply('هذا المستخدم لا يملك اشتراكًا نشطًا.');
    }

    await revokeActiveJoinLinksForUser(userId);
    const { inviteLink } = await createFreshJoinLinkForActiveUser(userId);

    await bot.telegram.sendMessage(
      userId,
      `تم إنشاء رابط دخول جديد لك.

صلاحية الرابط ${JOIN_LINK_EXPIRE_MINUTES} دقائق.`,
      Markup.inlineKeyboard([
        [Markup.button.url('طلب الانضمام', inviteLink)]
      ])
    );

    await ctx.reply(`تم إرسال رابط جديد للمستخدم ${userId}.`);
  } catch (err) {
    console.error('/link ERROR:', err);
    await ctx.reply('حدث خطأ أثناء إنشاء الرابط.');
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
            expired_at: now
          }
        }
      );

      await revokeActiveJoinLinksForUser(user.user_id);
      await removeUserFromChannel(user.user_id);

      try {
        await bot.telegram.sendMessage(
          user.user_id,
          `انتهى اشتراكك.

يمكنك التجديد من خلال البوت أو التواصل مع الدعم.`,
          Markup.inlineKeyboard([
            [Markup.button.callback('تجديد', 'open_plans')],
            [Markup.button.url('الدعم', `https://t.me/${SUPPORT_USERNAME.replace('@', '')}`)]
          ])
        );
      } catch (err) {
        console.error('EXPIRED USER MESSAGE ERROR:', err);
      }
    }

    const reminderTargetStart = new Date(now.getTime() + REMINDER_DAYS_BEFORE * 24 * 60 * 60 * 1000);
    const reminderTargetEnd = new Date(reminderTargetStart.getTime() + 10 * 60 * 1000);

    const usersToRemind = await db.collection('users').find({
      status: 'ACTIVE',
      end_date: { $gte: reminderTargetStart, $lt: reminderTargetEnd },
      reminder_sent: { $ne: true }
    }).toArray();

    for (const user of usersToRemind) {
      try {
        await bot.telegram.sendMessage(
          user.user_id,
          `تنبيه

اشتراكك سينتهي خلال ${REMINDER_DAYS_BEFORE} يوم.

يمكنك التجديد الآن لتفادي الانقطاع.`,
          Markup.inlineKeyboard([
            [Markup.button.callback('تجديد', 'open_plans')],
            [Markup.button.callback('اشتراكي', 'back_main')]
          ])
        );

        await db.collection('users').updateOne(
          { user_id: user.user_id },
          { $set: { reminder_sent: true } }
        );
      } catch (err) {
        console.error('REMINDER MESSAGE ERROR:', err);
      }
    }

    const expiredLinks = await db.collection('join_links').find({
      status: { $in: ['ACTIVE', 'PENDING_JOIN'] },
      expires_at: { $lt: now }
    }).toArray();

    for (const link of expiredLinks) {
      await revokeLink(link.invite_link);
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

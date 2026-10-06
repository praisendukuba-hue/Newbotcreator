const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { db } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');

const OFFICIAL_CHANNEL = '@DAILYUUPA';
const OFFICIAL_URL = 'https://t.me/DAILYUUPA';

const activeBots = {};  // botId -> { bot, cfg }
const awaiting = {};    // "botId:uid" -> 'wallet' | 'withdraw'

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ---------- USER DATA ----------
async function getUser(botId, uid) {
  const ref = db.collection('bots').doc(botId).collection('users').doc(String(uid));
  const snap = await ref.get();
  if (!snap.exists) {
    const fresh = { balance: 0, wallet: 'Not Set', refer: null, refs: 0, joinedAt: Date.now() };
    await ref.set(fresh);
    return { ref, data: fresh, isNew: true };
  }
  return { ref, data: snap.data(), isNew: false };
}

// ---------- START A BOT ----------
function startBot(cfg) {
  const botId = cfg.id;
  if (activeBots[botId]) stopBot(botId);

  const bot = new TelegramBot(cfg.token, { polling: true });
  activeBots[botId] = { bot, cfg };

  const currency = cfg.currency || 'TON';
  const pay = cfg.payMethod || 'Manual';
  const minW = Number(cfg.minW || 0.01);
  const maxW = Number(cfg.maxW || 100);
  const refB = Number(cfg.refBonus || 0.01);
  const payout = cfg.payoutChannel || OFFICIAL_CHANNEL;
  const apiKey = cfg.apiKey || '';
  const must = [OFFICIAL_CHANNEL, ...(cfg.mustJoin || [])];
  const tasks = cfg.tasks || [];
  const name = cfg.name || 'Rewards Bot';

  console.log(`[engine] ✅ STARTED bot ${botId} (${name}) · ${currency} · ${pay}`);

  // Token died? Deactivate automatically
  const deactivate = async (reason) => {
    stopBot(botId);    try { await db.collection('bots').doc(botId).update({ status: 'deactivated', deactivationReason: reason }); } catch (e) {}
    console.log(`[engine] ❌ deactivated ${botId}: ${reason}`);
  };

  bot.getMe().catch(() => deactivate('Token invalid or deleted from BotFather'));
  bot.on('polling_error', (err) => {
    if (/401|404/.test(String(err.message))) deactivate('Token invalid or deleted from BotFather');
    else if (/409/.test(String(err.message))) console.log(`[engine] ⚠️ ${botId}: another poller is running (stop old worker!)`);
  });

  // ---------- HELPERS ----------
  const menuOpts = () => {
    const keyboard = [
      [{ text: '🏦 Balance' }, { text: '👥 Invite' }],
      [{ text: '📋 Task' }, { text: '💸 Withdraw' }]
    ];
    if (pay === 'Manual' || pay === 'AutoPay1') keyboard.push([{ text: '👛 Wallet' }]);
    return { reply_markup: { keyboard, resize_keyboard: true }, parse_mode: 'HTML' };
  };

  async function joinedAll(uid) {
    for (const ch of must) {
      try {
        const m = await bot.getChatMember(ch, uid);
        if (m.status === 'left' || m.status === 'kicked') return false;
      } catch (e) { /* bot not admin in this channel -> skip */ }
    }
    return true;
  }

  async function notifyPayout(text) {
    try { await bot.sendMessage(payout, text, { parse_mode: 'HTML' }); } catch (e) {}
  }

  async function logWithdraw(uid, amount, status, wallet) {
    try {
      await db.collection('bots').doc(botId).collection('withdrawals').add({
        uid: String(uid), amount, currency, status, wallet: wallet || '-', at: Date.now()
      });
    } catch (e) {}
  }

  // ---------- /start ----------
  bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
    const uid = msg.chat.id;
    const { ref, data, isNew } = await getUser(botId, uid);
    if (isNew) {
      await db.collection('bots').doc(botId).update({ users: FieldValue.increment(1) }).catch(() => {});
    }
    await db.collection('bots').doc(botId).update({ lastActive: Date.now() }).catch(() => {});
    // Referral
    const refId = match && match[1] ? match[1] : null;
    if (refId && refId !== String(uid) && !data.refer) {
      await ref.update({ refer: refId }).catch(() => {});
      await db.collection('bots').doc(botId).collection('users').doc(refId)
        .update({ balance: FieldValue.increment(refB), refs: FieldValue.increment(1) }).catch(() => {});
      try { await bot.sendMessage(refId, `🎉 You earned <b>${refB} ${currency}</b> for inviting a new user!`, { parse_mode: 'HTML' }); } catch (e) {}
    }

    // Channel lock (official channel FIRST)
    if (!(await joinedAll(uid))) {
      const rows = [[{ text: '📢 Join Official Channel', url: OFFICIAL_URL }]];
      must.slice(1).forEach((ch, i) => rows.push([{ text: `📢 Join Channel ${i + 2}`, url: `https://t.me/${ch.replace('@', '')}` }]));
      rows.push([{ text: '✅ I Have Joined', callback_data: 'recheck' }]);
      return bot.sendMessage(uid, '🚫 <b>ACCESS DENIED</b>\n\nJoin the required channels below, then tap verify.', {
        reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML'
      });
    }

    bot.sendMessage(uid,
      `💎 <b>WELCOME TO ${esc(name)}</b>\n\n🚀 Earn ${currency} rewards for free!\n👥 Invite friends & earn ${refB} ${currency}\n⚡ Fast withdrawals\n\n🔓 Choose an option below:`,
      menuOpts());
  });

  // ---------- Verify callback ----------
  bot.on('callback_query', async (cq) => {
    if (cq.data !== 'recheck') return;
    const uid = cq.from.id;
    if (await joinedAll(uid)) {
      await bot.answerCallbackQuery(cq.id, { text: '✅ Verified!' });
      bot.sendMessage(uid, '🏡 <b>Main Menu</b>', menuOpts());
    } else {
      await bot.answerCallbackQuery(cq.id, { text: '❌ You haven\'t joined all channels yet!', show_alert: true });
    }
  });

  // ---------- Menu handlers ----------
  bot.on('message', async (msg) => {
    const txt = (msg.text || '').trim();
    const uid = msg.chat.id;
    if (!txt || txt.startsWith('/')) return;
    const key = `${botId}:${uid}`;

    // Waiting for wallet address
    if (awaiting[key] === 'wallet') {
      delete awaiting[key];
      await db.collection('bots').doc(botId).collection('users').doc(String(uid)).update({ wallet: txt });
      return bot.sendMessage(uid, `✅ <b>Wallet saved!</b>\n\n<code>${esc(txt)}</code>`, { parse_mode: 'HTML' });
    }    // Waiting for withdrawal amount
    if (awaiting[key] === 'withdraw') {
      delete awaiting[key];
      return handleWithdrawAmount(uid, txt);
    }

    if (txt === '🏦 Balance') return handleBalance(uid);
    if (txt === '👥 Invite') return handleInvite(uid);
    if (txt === '📋 Task') return handleTask(uid);
    if (txt === '👛 Wallet' && (pay === 'Manual' || pay === 'AutoPay1')) return handleWallet(uid, key);
    if (txt === '💸 Withdraw') return handleWithdraw(uid, key);
  });

  async function handleBalance(uid) {
    const { data } = await getUser(botId, uid);
    bot.sendMessage(uid,
      `<b>👤 MY ACCOUNT</b>\n\n━━━━━━━━━━\n\n💰 <b>Balance</b>\n<b>${Number(data.balance || 0).toFixed(2)} ${currency}</b>\n\n👛 <b>Wallet</b>\n<code>${esc(data.wallet)}</code>\n\n👥 <b>Referrals</b>\n${data.refs || 0} users\n\n━━━━━━━━━━\n${esc(name)} Account`,
      { parse_mode: 'HTML' });
  }

  async function handleInvite(uid) {
    const me = await bot.getMe();
    const { data } = await getUser(botId, uid);
    bot.sendMessage(uid,
      `🎁 <b>INVITE & EARN</b>\n\n━━━━━━━━━━\n\n💎 <b>Referral Reward</b>\n${refB} ${currency} per invite\n\n👥 <b>Your Referrals</b>\n${data.refs || 0} users\n\n━━━━━━━━━━\n\n🔗 <b>Your Invite Link</b>\n\n<code>https://t.me/${me.username}?start=${uid}</code>`,
      { parse_mode: 'HTML' });
  }

  async function handleTask(uid) {
    let lines = ['📋 <b>AVAILABLE TASKS</b>', '━━━━━━━━━━', `1️⃣ <b>Join Official Channel:</b> ${OFFICIAL_CHANNEL}`];
    tasks.forEach((t, i) => lines.push(`${i + 2}️⃣ <b>${esc(t.n)}:</b> ${t.l}`));
    lines.push('━━━━━━━━━━', '✅ Complete all tasks to earn rewards!');
    bot.sendMessage(uid, lines.join('\n'), { parse_mode: 'HTML' });
  }

  async function handleWallet(uid, key) {
    const { data } = await getUser(botId, uid);
    awaiting[key] = 'wallet';
    bot.sendMessage(uid,
      `👛 <b>${currency} WALLET</b>\n\nCurrent: <code>${esc(data.wallet)}</code>\n\n📝 <b>Send your new wallet address now:</b>`,
      { parse_mode: 'HTML' });
  }

  async function handleWithdraw(uid, key) {
    const { data } = await getUser(botId, uid);
    if ((pay === 'Manual' || pay === 'AutoPay1') && (!data.wallet || data.wallet === 'Not Set')) {
      return bot.sendMessage(uid, '👛 Please set your wallet first: tap <b>👛 Wallet</b>', { parse_mode: 'HTML' });
    }
    awaiting[key] = 'withdraw';
    bot.sendMessage(uid, `💸 <b>Enter withdrawal amount (${currency})</b>\n\nMin: ${minW}\nMax: ${maxW}\n\nSend the number now:`);  }

  async function handleWithdrawAmount(uid, raw) {
    const amount = parseFloat(raw);
    if (isNaN(amount)) return bot.sendMessage(uid, '❌ Please enter a valid number.');
    if (amount < minW || amount > maxW) return bot.sendMessage(uid, `❌ Amount must be between ${minW} and ${maxW} ${currency}`);

    const { ref, data } = await getUser(botId, uid);
    if (Number(data.balance || 0) < amount) return bot.sendMessage(uid, `❌ Insufficient balance.\n\n💰 Your balance: ${Number(data.balance || 0).toFixed(2)} ${currency}`);

    // ----- AutoPay 1: Pt Exchange -----
    if (pay === 'AutoPay1') {
      let ok = false, errMsg = 'API error';
      try {
        const r = await axios.post(`https://ptexchange-api.vercel.app/pay/${currency.toLowerCase()}`, {
          api_key: apiKey, to_address: data.wallet, amount, comment: `Withdrawal from ${name}`
        }, { timeout: 30000 });
        ok = r.status === 200 && r.data && (r.data.success || r.data.ok);
        if (!ok) errMsg = (r.data && (r.data.message || r.data.error)) || 'Rejected';
      } catch (e) { errMsg = e.message; }

      if (ok) {
        await ref.update({ balance: FieldValue.increment(-amount) });
        await logWithdraw(uid, amount, 'paid', data.wallet);
        await notifyPayout(`💸 <b>AutoPay1 PAID</b>\n👤 ${uid}\n💰 ${amount} ${currency}\n👛 ${esc(data.wallet)}`);
        return bot.sendMessage(uid, `✅ <b>Withdrawal Paid!</b>\n\n💰 Amount: ${amount} ${currency}\n👛 Wallet: <code>${esc(data.wallet)}</code>`, { parse_mode: 'HTML' });
      }
      await notifyPayout(`❌ <b>AutoPay1 FAILED</b>\n👤 ${uid}\n💰 ${amount} ${currency}\n❗ ${esc(errMsg).slice(0, 200)}`);
      return bot.sendMessage(uid, `❌ Payment failed: ${esc(errMsg).slice(0, 150)}\n\n💰 Balance NOT deducted.`);
    }

    // ----- AutoPay 2: xRocket -----
    if (pay === 'AutoPay2') {
      let ok = false, errMsg = 'API error';
      try {
        const r = await axios.post('https://pay.api.xrocket.exchange/api/v1/payouts', {
          clientPayoutId: `CLUR-${uid}-${Date.now()}`,
          target: String(uid), targetType: 'telegram_user_id',
          asset: currency.toUpperCase(), amount: String(amount), description: `Withdrawal from ${name}`
        }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 });
        ok = r.status === 200;
        if (!ok) errMsg = (r.data && (r.data.message || r.data.error)) || 'Rejected';
      } catch (e) { errMsg = e.message; }

      if (ok) {
        await ref.update({ balance: FieldValue.increment(-amount) });
        await logWithdraw(uid, amount, 'paid', 'telegram');
        await notifyPayout(`💸 <b>AutoPay2 (xRocket) PAID</b>\n👤 ${uid}\n💰 ${amount} ${currency}`);
        return bot.sendMessage(uid, `✅ <b>Withdrawal Paid via xRocket!</b>\n\n💰 Amount: ${amount} ${currency}`);
      }      await notifyPayout(`❌ <b>AutoPay2 FAILED</b>\n👤 ${uid}\n💰 ${amount} ${currency}\n❗ ${esc(errMsg).slice(0, 200)}`);
      return bot.sendMessage(uid, `❌ Payment failed: ${esc(errMsg).slice(0, 150)}\n\n💰 Balance NOT deducted.`);
    }

    // ----- Manual -----
    await ref.update({ balance: FieldValue.increment(-amount) });
    await logWithdraw(uid, amount, 'pending', data.wallet);
    await notifyPayout(`💸 <b>NEW MANUAL WITHDRAWAL</b>\n\n👤 User: <code>${uid}</code>\n💰 Amount: ${amount} ${currency}\n👛 Wallet: <code>${esc(data.wallet)}</code>\n📦 Status: Pending`);
    bot.sendMessage(uid, `⏳ <b>Request submitted!</b>\n\n💰 Amount: ${amount} ${currency}\n📦 Status: Pending admin review`);
  }
}

// ---------- STOP / RESTART / LOAD ----------
function stopBot(botId) {
  const info = activeBots[botId];
  if (!info) return;
  try { info.bot.stopPolling(); } catch (e) {}
  delete activeBots[botId];
  console.log(`[engine] ⏹ stopped bot ${botId}`);
}

async function restartBot(botId) {
  stopBot(botId);
  const snap = await db.collection('bots').doc(botId).get();
  if (!snap.exists) return;
  const cfg = { id: snap.id, ...snap.data() };
  if (cfg.status === 'active') startBot(cfg);
}

async function loadAllBots() {
  try {
    const snap = await db.collection('bots').where('status', '==', 'active').get();
    console.log(`[engine] 🔄 loading ${snap.size} active bots from Firebase...`);
    let i = 0;
    for (const doc of snap.docs) {
      startBot({ id: doc.id, ...doc.data() });
      i++;
      if (i % 5 === 0) await sleep(1000);
    }
    console.log('[engine] ✅ all bots loaded and live');
  } catch (e) {
    console.error('[engine] loadAllBots error:', e.message);
  }
}

module.exports = { startBot, stopBot, restartBot, loadAllBots, activeBots };

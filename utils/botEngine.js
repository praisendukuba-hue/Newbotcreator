const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { db } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');

const OFFICIAL_CHANNEL = '@DAILYUUPA';
const OFFICIAL_URL = 'https://t.me/DAILYUUPA';

const activeBots = {};
const tokenOwner = {};
const awaiting = {};
const captchaStore = {};
const seenMsgs = new Set();

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const chanUrl = (ch) => String(ch).startsWith('http') ? ch : `https://t.me/${String(ch).replace('@', '')}`;

async function getUser(botId, uid) {
  const ref = db.collection('bots').doc(botId).collection('users').doc(String(uid));
  const snap = await ref.get();
  if (!snap.exists) {
    const fresh = { balance: 0, wallet: 'Not Set', refer: null, refs: 0, captchaPassed: false, joinedAt: Date.now() };
    await ref.set(fresh);
    return { ref, data: fresh, isNew: true };
  }
  return { ref, data: snap.data(), isNew: false };
}

function startBot(cfg) {
  const botId = cfg.id;
  if (activeBots[botId]) stopBot(botId);

  const prev = tokenOwner[cfg.token];
  if (prev && prev !== botId) stopBot(prev);

  const bot = new TelegramBot(cfg.token, { polling: true });
  activeBots[botId] = { bot, cfg };
  tokenOwner[cfg.token] = botId;

  const currency = cfg.currency || 'TON';
  const pay = cfg.payMethod || 'Manual';
  const minW = Number(cfg.minW || 0.01);
  const maxW = Number(cfg.maxW || 100);
  const refB = Number(cfg.refBonus || 0.01);
  const payout = cfg.payoutChannel || '';
  const apiKey = cfg.apiKey || '';
  const mustJoin = (cfg.mustJoin || []).slice(0, 10);
  const nonMust = (cfg.nonMust || []).slice(0, 10);
  const tasks = cfg.tasks || [];
  const botDetect = !!cfg.botDetect;  const name = cfg.name || 'Rewards Bot';

  console.log(`[engine] ✅ STARTED bot ${botId} (${name}) · ${currency} · ${pay} · detect:${botDetect ? 'ON' : 'OFF'}`);

  const deactivate = async (reason) => {
    stopBot(botId);
    try { await db.collection('bots').doc(botId).update({ status: 'deactivated', deactivationReason: reason }); } catch (e) {}
    console.log(`[engine] ❌ deactivated ${botId}: ${reason}`);
  };

  bot.getMe().catch(() => deactivate('Token invalid or deleted from BotFather'));
  bot.on('polling_error', (err) => {
    const m = String(err.message);
    if (/401|404/.test(m)) deactivate('Token invalid or deleted from BotFather');
    else if (/409/.test(m)) console.log(`[engine] ⚠️ ${botId}: token used by another service`);
  });

  const menuKeyboard = () => {
    const keyboard = [
      [{ text: '🏦 Balance' }, { text: '👥 Invite' }],
      [{ text: '📋 Tasks' }, { text: '💸 Withdraw' }]
    ];
    if (pay === 'Manual' || pay === 'AutoPay1') keyboard.push([{ text: '👛 Wallet' }]);
    return { reply_markup: { keyboard, resize_keyboard: true }, parse_mode: 'HTML' };
  };

  async function notifyPayout(text) {
    if (!payout) return;
    try { await bot.sendMessage(payout, text, { parse_mode: 'HTML' }); } catch (e) {}
  }

  async function logWithdraw(uid, amount, status, wallet) {
    try {
      await db.collection('bots').doc(botId).collection('withdrawals').add({
        uid: String(uid), amount, currency, status, wallet: wallet || '-', at: Date.now()
      });
    } catch (e) {}
  }

  // /start
  bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
    const uid = msg.chat.id;
    const { ref, data, isNew } = await getUser(botId, uid);
    if (isNew) await db.collection('bots').doc(botId).update({ users: FieldValue.increment(1) }).catch(() => {});
    await db.collection('bots').doc(botId).update({ lastActive: Date.now() }).catch(() => {});

    const refId = match && match[1] ? match[1] : null;
    if (refId && refId !== String(uid) && !data.refer) {
      await ref.update({ refer: refId }).catch(() => {});
      await db.collection('bots').doc(botId).collection('users').doc(refId)        .update({ balance: FieldValue.increment(refB), refs: FieldValue.increment(1) }).catch(() => {});
      try { await bot.sendMessage(refId, `🎉 You earned <b>${refB} ${currency}</b> for inviting a new user!`, { parse_mode: 'HTML' }); } catch (e) {}
    }

    if (botDetect && !data.captchaPassed) {
      const a = Math.floor(Math.random() * 10) + 1;
      const b = Math.floor(Math.random() * 10) + 1;
      const answer = a + b;
      captchaStore[`${botId}:${uid}`] = answer;
      awaiting[`${botId}:${uid}`] = 'captcha';
      return bot.sendMessage(uid, `🤖 <b>Are you a robot?</b>\n\nSolve this to continue:\n\n<b>${a} + ${b} = ?</b>\n\n👉 Send the answer:`, { parse_mode: 'HTML' });
    }

    await showChannels(uid);
  });

  bot.on('message', async (msg) => {
    const txt = (msg.text || '').trim();
    const uid = msg.chat.id;
    const key = `${botId}:${uid}`;

    if (awaiting[key] === 'captcha') {
      const answer = parseInt(txt);
      if (answer === captchaStore[key]) {
        delete awaiting[key];
        delete captchaStore[key];
        const { ref } = await getUser(botId, uid);
        await ref.update({ captchaPassed: true });
        return showChannels(uid);
      } else {
        const a = Math.floor(Math.random() * 10) + 1;
        const b = Math.floor(Math.random() * 10) + 1;
        captchaStore[key] = a + b;
        return bot.sendMessage(uid, `❌ Wrong! Try again:\n\n<b>${a} + ${b} = ?</b>`, { parse_mode: 'HTML' });
      }
    }

    if (awaiting[key] === 'wallet') {
      delete awaiting[key];
      await db.collection('bots').doc(botId).collection('users').doc(String(uid)).update({ wallet: txt });
      return bot.sendMessage(uid, `✅ <b>Wallet saved!</b>\n\n<code>${esc(txt)}</code>`, { parse_mode: 'HTML' });
    }

    if (awaiting[key] === 'withdraw') {
      delete awaiting[key];
      return handleWithdrawAmount(uid, txt);
    }

    if (awaiting[key] === 'taskProof') {
      delete awaiting[key];      return handleTaskProof(uid, msg);
    }

    if (!txt || txt.startsWith('/')) return;
    if (txt === '🏦 Balance') return handleBalance(uid);
    if (txt === '👥 Invite') return handleInvite(uid);
    if (txt === '📋 Tasks') return handleTasks(uid);
    if (txt === '👛 Wallet' && (pay === 'Manual' || pay === 'AutoPay1')) return handleWallet(uid, key);
    if (txt === '💸 Withdraw') return handleWithdraw(uid, key);
  });

  async function showChannels(uid) {
    const rows = [[{ text: '📢 DOV Channel', url: OFFICIAL_URL }]];
    let idx = 1;
    for (const ch of mustJoin) {
      rows.push([{ text: `📢 Channel ${idx}`, url: chanUrl(ch) }]);
      idx++;
    }
    for (const ch of nonMust) {
      rows.push([{ text: `📢 Channel ${idx}`, url: chanUrl(ch) }]);
      idx++;
    }
    if (payout) rows.push([{ text: '💰 Payout Channel', url: chanUrl(payout) }]);
    rows.push([{ text: '🚀 CONTINUE', callback_data: 'continue' }]);

    await bot.sendMessage(uid,
      `💎 <b>WELCOME TO ${esc(name)}</b>\n\n━━━━━━━━━━━━━━\n\n📢 <b>Join these channels first:</b>\n\nTap each button below, then tap <b>🚀 CONTINUE</b>\n\n━━━━━━━━━━━━━━`,
      { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' });
  }

  async function checkMustJoin(uid) {
    for (const ch of mustJoin) {
      try {
        const m = await bot.getChatMember(ch, uid);
        if (m.status === 'left' || m.status === 'kicked') return false;
      } catch (e) { continue; }
    }
    return true;
  }

  bot.on('callback_query', async (cq) => {
    if (cq.data === 'continue') {
      const uid = cq.from.id;
      if (!(await checkMustJoin(uid))) {
        return await bot.answerCallbackQuery(cq.id, { text: '❌ Join all required channels first!', show_alert: true });
      }
      await bot.answerCallbackQuery(cq.id, { text: '✅ Verified!' });
      return bot.sendMessage(uid, `🏡 <b>Main Menu</b>`, menuKeyboard());
    }
    if (cq.data.startsWith('task_')) {
      const taskIdx = parseInt(cq.data.split('_')[1]);
      const task = tasks[taskIdx];
      if (!task) return;
      awaiting[`${botId}:${cq.from.id}`] = 'taskProof';
      return bot.sendMessage(cq.from.id, `📋 <b>Task: ${esc(task.n)}</b>\n\n${esc(task.l)}\n\n📸 <b>Send proof (screenshot) to the bot owner:</b>\n\nTap the button below to send your proof.`, {
        reply_markup: { inline_keyboard: [[{ text: '📤 Send Proof Now', callback_data: 'sendProof' }]] }, parse_mode: 'HTML'
      });
    }

    if (cq.data === 'sendProof') {
      return bot.sendMessage(cq.from.id, `📸 <b>Send your task proof now</b> (screenshot or message):`);
    }

    if (cq.data.startsWith('approve_')) {
      const proofId = cq.data.split('_')[1];
      try {
        await db.collection('bots').doc(botId).collection('taskProofs').doc(proofId).delete();
        await bot.editMessageText('✅ <b>Approved!</b> Proof deleted.', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: 'HTML' });
      } catch (e) {}
    }

    if (cq.data.startsWith('decline_')) {
      const proofId = cq.data.split('_')[1];
      try {
        await db.collection('bots').doc(botId).collection('taskProofs').doc(proofId).delete();
        await bot.editMessageText('❌ <b>Declined.</b> Proof deleted.', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: 'HTML' });
      } catch (e) {}
    }
  });

  async function handleBalance(uid) {
    const { data } = await getUser(botId, uid);
    await bot.sendMessage(uid,
      `<b>👤 MY ACCOUNT</b>\n\n━━━━━━━━━━━━━━\n\n💰 <b>Balance:</b> <b>${Number(data.balance || 0).toFixed(2)} ${currency}</b>\n\n👛 <b>Wallet:</b> <code>${esc(data.wallet)}</code>\n\n👥 <b>Referrals:</b> ${data.refs || 0}\n\n━━━━━━━━━━━━━━`,
      { parse_mode: 'HTML' });
  }

  async function handleInvite(uid) {
    const me = await bot.getMe();
    const { data } = await getUser(botId, uid);
    await bot.sendMessage(uid,
      `🎁 <b>INVITE & EARN</b>\n\n━━━━━━━━━━━━━━\n\n💎 <b>Reward:</b> ${refB} ${currency} per invite\n\n👥 <b>Your Referrals:</b> ${data.refs || 0}\n\n━━━━━━━━━━━━━━\n\n🔗 <b>Your Link:</b>\n\n<code>https://t.me/${me.username}?start=${uid}</code>`,
      { parse_mode: 'HTML' });
  }

  async function handleTasks(uid) {
    if (!tasks.length) {
      return await bot.sendMessage(uid, '📋 <b>No tasks available yet.</b>', { parse_mode: 'HTML' });
    }    const rows = tasks.map((t, i) => [{ text: `${i + 1}. ${t.n}`, callback_data: `task_${i}` }]);
    await bot.sendMessage(uid, '📋 <b>AVAILABLE TASKS</b>\n\n━━━━━━━━━━━━━━\n\nTap a task to complete it:', {
      reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML'
    });
  }

  async function handleWallet(uid, key) {
    const { data } = await getUser(botId, uid);
    awaiting[key] = 'wallet';
    await bot.sendMessage(uid,
      `👛 <b>${currency} WALLET</b>\n\nCurrent: <code>${esc(data.wallet)}</code>\n\n📝 <b>Send your new wallet address:</b>`,
      { parse_mode: 'HTML' });
  }

  async function handleWithdraw(uid, key) {
    const { data } = await getUser(botId, uid);
    if ((pay === 'Manual' || pay === 'AutoPay1') && (!data.wallet || data.wallet === 'Not Set')) {
      return await bot.sendMessage(uid, '👛 Please set your wallet first: tap <b>👛 Wallet</b>', { parse_mode: 'HTML' });
    }
    awaiting[key] = 'withdraw';
    await bot.sendMessage(uid, `💸 <b>Enter withdrawal amount (${currency})</b>\n\nMin: ${minW}\nMax: ${maxW}`);
  }

  async function handleTaskProof(uid, msg) {
    const proofData = {
      uid: String(uid),
      proofText: msg.text || '',
      proofPhoto: msg.photo ? msg.photo[msg.photo.length - 1].file_id : null,
      status: 'pending',
      at: Date.now()
    };
    const docRef = await db.collection('bots').doc(botId).collection('taskProofs').add(proofData);

    const text = `🧾 <b>New Task Proof</b>\n\n👤 User: <code>${uid}</code>\n\n📝 <b>Proof:</b>\n${esc(msg.text || 'Photo attached')}\n\n━━━━━━━━━━━━━━`;
    await notifyPayout(text);
    await bot.sendMessage(payout, `🧾 Proof from ${uid}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Approve', callback_data: `approve_${docRef.id}` }, { text: '❌ Decline', callback_data: `decline_${docRef.id}` }]
        ]
      }
    });
    if (msg.photo) {
      await bot.sendPhoto(payout, msg.photo[msg.photo.length - 1].file_id);
    }
    await bot.sendMessage(uid, '✅ <b>Proof sent!</b> Waiting for approval.');
  }

  async function handleWithdrawAmount(uid, raw) {
    const amount = parseFloat(raw);    if (isNaN(amount)) return await bot.sendMessage(uid, '❌ Please enter a valid number.');
    if (amount < minW || amount > maxW) return await bot.sendMessage(uid, `❌ Amount must be between ${minW} and ${maxW} ${currency}`);

    const { ref, data } = await getUser(botId, uid);
    if (Number(data.balance || 0) < amount) return await bot.sendMessage(uid, `❌ Insufficient balance.\n\n💰 Your balance: ${Number(data.balance || 0).toFixed(2)} ${currency}`);

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
        return await bot.sendMessage(uid, `✅ <b>Withdrawal Paid!</b>\n\n💰 Amount: ${amount} ${currency}\n👛 Wallet: <code>${esc(data.wallet)}</code>`, { parse_mode: 'HTML' });
      }
      await notifyPayout(`❌ <b>AutoPay1 FAILED</b>\n👤 ${uid}\n💰 ${amount} ${currency}\n❗ ${esc(errMsg).slice(0, 200)}`);
      return await bot.sendMessage(uid, `❌ Payment failed: ${esc(errMsg).slice(0, 150)}\n\n💰 Balance NOT deducted.`);
    }

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
        return await bot.sendMessage(uid, `✅ <b>Withdrawal Paid via xRocket!</b>\n\n💰 Amount: ${amount} ${currency}`);
      }
      await notifyPayout(`❌ <b>AutoPay2 FAILED</b>\n👤 ${uid}\n💰 ${amount} ${currency}\n❗ ${esc(errMsg).slice(0, 200)}`);
      return await bot.sendMessage(uid, `❌ Payment failed: ${esc(errMsg).slice(0, 150)}\n\n💰 Balance NOT deducted.`);
    }

    await ref.update({ balance: FieldValue.increment(-amount) });
    await logWithdraw(uid, amount, 'pending', data.wallet);    await notifyPayout(`💸 <b>NEW MANUAL WITHDRAWAL</b>\n\n👤 User: <code>${uid}</code>\n💰 Amount: ${amount} ${currency}\n👛 Wallet: <code>${esc(data.wallet)}</code>\n📦 Status: Pending`);
    await bot.sendMessage(uid, `⏳ <b>Request submitted!</b>\n\n💰 Amount: ${amount} ${currency}\n📦 Status: Pending admin review`);
  }
}

function stopBot(botId) {
  const info = activeBots[botId];
  if (!info) return;
  try { info.bot.stopPolling(); } catch (e) {}
  delete tokenOwner[info.cfg.token];
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
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 1000));
    }
    console.log('[engine] ✅ all bots loaded and live');
  } catch (e) {
    console.error('[engine] loadAllBots error:', e.message);
  }
}

module.exports = { startBot, stopBot, restartBot, loadAllBots, activeBots };

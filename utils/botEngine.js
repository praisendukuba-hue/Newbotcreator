const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { db } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');

const OFFICIAL_URL = 'https://t.me/DAILYUUPA';
const activeBots = {};
const tokenOwner = {};
const awaiting = {};      // "botId:uid" -> { type, expiresAt, data }
const captchaStore = {};

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const chanUrl = (ch) => String(ch).startsWith('http') ? ch : `https://t.me/${String(ch).replace('@', '')}`;

function clearAwaiting(key) {
  delete awaiting[key];
  delete captchaStore[key];
  delete awaiting[key + '_task'];
}

function isAwaiting(key) {
  const a = awaiting[key];
  if (!a) return false;
  if (a.expiresAt && Date.now() > a.expiresAt) {
    clearAwaiting(key);
    return false;
  }
  return true;
}

function setAwaiting(key, type, data = {}) {
  awaiting[key] = { type, expiresAt: Date.now() + 300000, data }; // 5 min timeout
}

async function getUser(botId, uid) {
  const ref = db.collection('bots').doc(botId).collection('users').doc(String(uid));
  const snap = await ref.get();
  if (!snap.exists) {
    const fresh = { balance: 0, wallet: 'Not Set', refer: null, refs: 0, captchaPassed: false, banned: false, joinedAt: Date.now() };
    await ref.set(fresh);
    return { ref, data: fresh, isNew: true };
  }
  return { ref, data: snap.data(), isNew: false };
}

function sendTo(botId, uid, text) {
  const info = activeBots[botId];
  if (!info) return Promise.resolve(false);
  return info.bot.sendMessage(uid, text, { parse_mode: 'HTML' }).then(() => true).catch(() => false);
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
  const botDetect = !!cfg.botDetect;
  const name = cfg.name || 'Rewards Bot';

  console.log(`[engine] ✅ STARTED ${botId} (${name}) · ${currency} · ${pay}`);

  const deactivate = async (r) => {
    stopBot(botId);
    await db.collection('bots').doc(botId).update({ status: 'deactivated', deactivationReason: r }).catch(() => {});
  };
  bot.getMe().catch(() => deactivate('Token invalid'));
  bot.on('polling_error', (e) => {
    const m = String(e.message);
    if (/401|404/.test(m)) deactivate('Token invalid');
  });

  const menuKeyboard = () => {
    const keyboard = [[{ text: 'Balance' }, { text: 'Invite' }], [{ text: 'Tasks' }, { text: 'Withdraw' }]];
    if (pay === 'Manual' || pay === 'AutoPay1') keyboard.push([{ text: 'Wallet' }]);
    return { reply_markup: { keyboard, resize_keyboard: true }, parse_mode: 'HTML' };
  };

  const notifyPayout = async (text, opts) => {
    if (!payout) return;
    try { await bot.sendMessage(payout, text, opts || { parse_mode: 'HTML' }); } catch (e) {}
  };

  const logWithdraw = async (uid, amount, status, wallet) => {
    await db.collection('bots').doc(botId).collection('withdrawals').add({ uid: String(uid), amount, currency, status, wallet: wallet || '-', at: Date.now() }).catch(() => {});
  };
  // ========== COMMAND HANDLERS ==========
  bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
    try {
      const uid = msg.chat.id;
      const key = `${botId}:${uid}`;
      clearAwaiting(key); // Always clear any pending states on /start

      const { ref, data, isNew } = await getUser(botId, uid);
      if (data.banned) return bot.sendMessage(uid, '🚫 <b>You are banned from this bot.</b>', { parse_mode: 'HTML' });
      
      if (isNew) await db.collection('bots').doc(botId).update({ users: FieldValue.increment(1) }).catch(() => {});
      await db.collection('bots').doc(botId).update({ lastActive: Date.now() }).catch(() => {});

      const refId = match && match[1] ? match[1] : null;
      if (refId && refId !== String(uid) && !data.refer) {
        await ref.update({ refer: refId }).catch(() => {});
        await db.collection('bots').doc(botId).collection('users').doc(refId).update({ balance: FieldValue.increment(refB), refs: FieldValue.increment(1) }).catch(() => {});
        bot.sendMessage(refId, `✅ You earned <b>${refB} ${currency}</b> for a new referral!`, { parse_mode: 'HTML' }).catch(() => {});
      }

      if (botDetect && !data.captchaPassed) {
        const a = Math.floor(Math.random() * 10) + 1, b = Math.floor(Math.random() * 10) + 1;
        captchaStore[key] = a + b;
        setAwaiting(key, 'captcha');
        return bot.sendMessage(uid, `🤖 <b>ARE YOU A ROBOT?</b>\n\nProve you are human:\n\n<b>${a} + ${b} = ?</b>\n\nSend your answer:`, { parse_mode: 'HTML' });
      }
      
      return showChannels(uid);
    } catch (e) {
      console.error('[engine] /start error:', e);
      bot.sendMessage(msg.chat.id, '⚠️ Error starting bot. Try again.', { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // ========== MESSAGE HANDLER ==========
  bot.on('message', async (msg) => {
    try {
      const txt = (msg.text || '').trim();
      const uid = msg.chat.id;
      const key = `${botId}:${uid}`;

      // Skip if no text or is a command (commands handled by onText)
      if (!txt || txt.startsWith('/')) return;

      // Check user banned status
      const { ref, data } = await getUser(botId, uid);
      if (data.banned) return bot.sendMessage(uid, '🚫 <b>You are banned.</b>', { parse_mode: 'HTML' });

      // Handle awaiting states with timeout      if (isAwaiting(key)) {
        const awaitType = awaiting[key].type;
        clearAwaiting(key); // Clear immediately to prevent stuck states

        if (awaitType === 'captcha') {
          if (parseInt(txt, 10) === captchaStore[key]) {
            const { ref } = await getUser(botId, uid);
            await ref.update({ captchaPassed: true });
            bot.sendMessage(uid, '✅ Human verified!', { parse_mode: 'HTML' });
            return showChannels(uid);
          }
          const a = Math.floor(Math.random() * 10) + 1, b = Math.floor(Math.random() * 10) + 1;
          captchaStore[key] = a + b;
          setAwaiting(key, 'captcha');
          return bot.sendMessage(uid, `❌ Wrong! Try again:\n\n<b>${a} + ${b} = ?</b>`, { parse_mode: 'HTML' });
        }

        if (awaitType === 'wallet') {
          await db.collection('bots').doc(botId).collection('users').doc(String(uid)).update({ wallet: txt });
          return bot.sendMessage(uid, `✅ <b>Wallet saved</b>\n\n<code>${esc(txt)}</code>`, { parse_mode: 'HTML' });
        }

        if (awaitType === 'withdraw') {
          return handleWithdrawAmount(uid, txt);
        }

        if (awaitType === 'proof') {
          const taskName = awaiting[key + '_task'] || 'Task';
          return saveProof(uid, msg, taskName);
        }
      }

      // Handle button clicks
      if (txt === 'Balance') return handleBalance(uid);
      if (txt === 'Invite') return handleInvite(uid);
      if (txt === 'Tasks') return handleTasks(uid);
      if (txt === 'Wallet' && (pay === 'Manual' || pay === 'AutoPay1')) {
        setAwaiting(key, 'wallet');
        return bot.sendMessage(uid, `👛 Current: <code>${esc(data.wallet)}</code>\n\nSend your new wallet address:`, { parse_mode: 'HTML' });
      }
      if (txt === 'Withdraw') {
        if ((pay === 'Manual' || pay === 'AutoPay1') && (!data.wallet || data.wallet === 'Not Set')) {
          return bot.sendMessage(uid, '⚠️ Set your wallet first: tap <b>Wallet</b>', { parse_mode: 'HTML' });
        }
        setAwaiting(key, 'withdraw');
        return bot.sendMessage(uid, `📤 Enter amount (${currency})\nMin: ${minW} · Max: ${maxW}`);
      }

    } catch (e) {
      console.error('[engine] message handler error:', e);      bot.sendMessage(msg.chat.id, '⚠️ Error processing your request. Try again.', { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // ========== CALLBACK HANDLER ==========
  bot.on('callback_query', async (cq) => {
    try {
      const uid = cq.from.id;
      
      if (cq.data === 'continue') {
        for (const ch of mustJoin) {
          try {
            const m = await bot.getChatMember(ch, uid);
            if (m.status === 'left' || m.status === 'kicked') {
              return bot.answerCallbackQuery(cq.id, { text: '❌ Join all REQUIRED channels first!', show_alert: true });
            }
          } catch (e) {}
        }
        await bot.answerCallbackQuery(cq.id, { text: '✅ Verified!' });
        return bot.sendMessage(uid, `🏡 <b>${esc(name)} Menu</b>\n\nTap an option below:`, menuKeyboard());
      }

      if (cq.data.startsWith('task_')) {
        const idx = parseInt(cq.data.split('_')[1], 10);
        const t = tasks[idx];
        if (!t) return;
        const key = `${botId}:${uid}`;
        setAwaiting(key, 'proof');
        awaiting[key + '_task'] = t.n;
        return bot.sendMessage(uid, `📋 <b>${esc(t.n)}</b>\n\n🔗 ${esc(t.l)}\n\n📸 Now send your proof (screenshot or text):`, { parse_mode: 'HTML' });
      }

      if (cq.data.startsWith('approve_') || cq.data.startsWith('decline_')) {
        const approve = cq.data.startsWith('approve_');
        const pid = cq.data.split('_')[1];
        const ref = db.collection('bots').doc(botId).collection('proofs').doc(pid);
        const doc = await ref.get();
        if (doc.exists) {
          const p = doc.data();
          await ref.delete();
          bot.sendMessage(p.uid, approve ? '✅ <b>Your proof was APPROVED!</b>' : '❌ <b>Your proof was declined.</b>', { parse_mode: 'HTML' }).catch(() => {});
        }
        bot.editMessageText(approve ? '✅ Approved & deleted.' : '❌ Declined & deleted.', { chat_id: cq.message.chat.id, message_id: cq.message.message_id }).catch(() => {});
      }
    } catch (e) {
      console.error('[engine] callback error:', e);
    }
  });

  // ========== HELPER FUNCTIONS ==========  async function showChannels(uid) {
    try {
      const rows = [[{ text: '📢 DOV Channel', url: OFFICIAL_URL }]];
      let i = 1;
      for (const ch of mustJoin) { rows.push([{ text: `📢 Channel ${i} (Required)`, url: chanUrl(ch) }]); i++; }
      for (const ch of nonMust) { rows.push([{ text: `📢 Channel ${i}`, url: chanUrl(ch) }]); i++; }
      if (payout) rows.push([{ text: '💼 Payout', url: chanUrl(payout) }]);
      rows.push([{ text: '🚀 CONTINUE', callback_data: 'continue' }]);
      await bot.sendMessage(uid,
        `⭐ <b>WELCOME TO ${esc(name)}</b>\n\n━━━━━━━━━━━━━━\n\n🔥 <b>HOW TO START</b>\n\n1️⃣ Join the channels below\n2️⃣ Tap CONTINUE\n3️⃣ Complete tasks to earn ${currency}\n4️⃣ Withdraw anytime\n\n━━━━━━━━━━━━━━\n\n✅ Referral bonus: <b>${refB} ${currency}</b> per invite`,
        { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' });
    } catch (e) {
      console.error('[engine] showChannels error:', e);
    }
  }

  async function saveProof(uid, msg, taskName) {
    try {
      const docRef = await db.collection('bots').doc(botId).collection('proofs').add({
        uid: String(uid), task: taskName, text: msg.text || '', photo: msg.photo ? msg.photo[msg.photo.length - 1].file_id : null, status: 'pending', at: Date.now()
      });
      const caption = `🧾 <b>NEW TASK PROOF</b>\n\n📋 Task: ${esc(taskName)}\n👤 User: <code>${uid}</code>\n📝 ${esc(msg.text || '(photo)')}`;
      const btns = { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${docRef.id}` }, { text: '❌ Decline', callback_data: `decline_${docRef.id}` }]] } };
      if (msg.photo) { 
        await notifyPayout(caption, { parse_mode: 'HTML', ...btns }); 
        await bot.sendPhoto(payout, msg.photo[msg.photo.length - 1].file_id, { caption: `Proof from ${uid}` }).catch(() => {}); 
      } else {
        await notifyPayout(caption, { parse_mode: 'HTML', ...btns });
      }
      bot.sendMessage(uid, '✅ Proof sent to the owner for review!', { parse_mode: 'HTML' });
    } catch (e) {
      console.error('[engine] saveProof error:', e);
      bot.sendMessage(uid, '⚠️ Error saving proof', { parse_mode: 'HTML' });
    }
  }

  async function handleBalance(uid) {
    try {
      const { data } = await getUser(botId, uid);
      await bot.sendMessage(uid,
        `<b>MY ACCOUNT</b>\n\n━━━━━━━━━━━━━━\n\n⭐ Balance: <b>${Number(data.balance || 0).toFixed(2)} ${currency}</b>\n👛 Wallet: <code>${esc(data.wallet)}</code>\n👥 Referrals: ${data.refs || 0}\n🎁 Referral reward: <b>${refB} ${currency}</b> per invite\n\n━━━━━━━━━━━━━━`,
        { parse_mode: 'HTML' });
    } catch (e) {
      console.error('[engine] handleBalance error:', e);
    }
  }

  async function handleInvite(uid) {
    try {
      const me = await bot.getMe();      const { data } = await getUser(botId, uid);
      await bot.sendMessage(uid,
        `<b>INVITE & EARN</b>\n\n━━━━━━━━━━━━━━\n\n🎁 Reward: <b>${refB} ${currency}</b> per invite\n👥 Your referrals: ${data.refs || 0}\n\n━━━━━━━━━━━━━━\n\nYour link:\n<code>https://t.me/${me.username}?start=${uid}</code>`,
        { parse_mode: 'HTML' });
    } catch (e) {
      console.error('[engine] handleInvite error:', e);
    }
  }

  async function handleTasks(uid) {
    try {
      if (!tasks.length) return bot.sendMessage(uid, '📋 <b>No tasks available yet.</b>', { parse_mode: 'HTML' });
      const rows = tasks.map((t, i) => [{ text: `${i + 1}. ${t.n}`, callback_data: `task_${i}` }]);
      await bot.sendMessage(uid, '📋 <b>TASKS</b>\n\nTap a task, complete it, then send proof:', { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' });
    } catch (e) {
      console.error('[engine] handleTasks error:', e);
    }
  }

  async function handleWithdrawAmount(uid, raw) {
    try {
      const amount = parseFloat(raw);
      if (isNaN(amount)) return bot.sendMessage(uid, '❌ Numbers only.');
      if (amount < minW || amount > maxW) return bot.sendMessage(uid, `❌ Between ${minW} and ${maxW} ${currency}`);
      const { ref, data } = await getUser(botId, uid);
      if (Number(data.balance || 0) < amount) return bot.sendMessage(uid, `❌ Insufficient balance (${Number(data.balance || 0).toFixed(2)} ${currency})`);

      if (pay === 'AutoPay1') {
        let ok = false, err = 'API error';
        try {
          const r = await axios.post(`https://ptexchange-api.vercel.app/pay/${currency.toLowerCase()}`, { api_key: apiKey, to_address: data.wallet, amount, comment: name }, { timeout: 30000 });
          ok = r.status === 200 && r.data && (r.data.success || r.data.ok);
          if (!ok) err = (r.data && (r.data.message || r.data.error)) || 'Rejected';
        } catch (e) { err = e.message; }
        if (ok) {
          await ref.update({ balance: FieldValue.increment(-amount) });
          await logWithdraw(uid, amount, 'paid', data.wallet);
          await notifyPayout(`✅ <b>AutoPay1 PAID</b>\n👤 ${uid}\n⭐ ${amount} ${currency}\n👛 ${esc(data.wallet)}`);
          return bot.sendMessage(uid, `✅ <b>Paid!</b> ${amount} ${currency} sent to your wallet.`);
        }
        await notifyPayout(`❌ <b>AutoPay1 FAILED</b>\n👤 ${uid}\n⭐ ${amount} ${currency}\n⚠️ ${esc(err).slice(0, 200)}`);
        return bot.sendMessage(uid, `❌ Failed: ${esc(err).slice(0, 120)}\nBalance NOT deducted.`);
      }

      if (pay === 'AutoPay2') {
        let ok = false, err = 'API error';
        try {
          const r = await axios.post('https://pay.api.xrocket.exchange/api/v1/payouts', {
            clientPayoutId: `CLUR-${uid}-${Date.now()}`, target: String(uid), targetType: 'telegram_user_id',
            asset: currency.toUpperCase(), amount: String(amount), description: name          }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 });
          ok = r.status === 200;
          if (!ok) err = (r.data && (r.data.message || r.data.error)) || 'Rejected';
        } catch (e) { err = e.message; }
        if (ok) {
          await ref.update({ balance: FieldValue.increment(-amount) });
          await logWithdraw(uid, amount, 'paid', 'telegram');
          await notifyPayout(`✅ <b>AutoPay2 PAID</b>\n👤 ${uid}\n⭐ ${amount} ${currency}`);
          return bot.sendMessage(uid, `✅ <b>Paid via xRocket!</b> ${amount} ${currency}`);
        }
        await notifyPayout(`❌ <b>AutoPay2 FAILED</b>\n👤 ${uid}\n⭐ ${amount} ${currency}\n⚠️ ${esc(err).slice(0, 200)}`);
        return bot.sendMessage(uid, `❌ Failed: ${esc(err).slice(0, 120)}\nBalance NOT deducted.`);
      }

      await ref.update({ balance: FieldValue.increment(-amount) });
      await logWithdraw(uid, amount, 'pending', data.wallet);
      await notifyPayout(`📥 <b>MANUAL WITHDRAWAL</b>\n\n👤 <code>${uid}</code>\n⭐ ${amount} ${currency}\n👛 <code>${esc(data.wallet)}</code>\nStatus: Pending`);
      bot.sendMessage(uid, `⏳ Submitted! ${amount} ${currency} pending admin review.`);
    } catch (e) {
      console.error('[engine] handleWithdrawAmount error:', e);
      bot.sendMessage(uid, '⚠️ Error processing withdrawal', { parse_mode: 'HTML' });
    }
  }
}

function stopBot(botId) {
  const info = activeBots[botId];
  if (!info) return;
  try { info.bot.stopPolling(); } catch (e) {}
  delete tokenOwner[info.cfg.token];
  delete activeBots[botId];
}

async function restartBot(botId) {
  stopBot(botId);
  const snap = await db.collection('bots').doc(botId).get();
  if (!snap.exists) return;
  const cfg = { id: snap.id, ...snap.data() };
  if (cfg.status === 'active') startBot(cfg);
}

async function loadAllBots() {
  const snap = await db.collection('bots').where('status', '==', 'active').get();
  console.log(`[engine] loading ${snap.size} bots...`);
  let i = 0;
  for (const d of snap.docs) { startBot({ id: d.id, ...d.data() }); i++; if (i % 5 === 0) await new Promise(r => setTimeout(r, 800)); }
  console.log('[engine] ✅ all bots live');
}

module.exports = { startBot, stopBot, restartBot, loadAllBots, activeBots, sendTo };

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { db } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');

const OFFICIAL_URL = 'https://t.me/DAILYUUPA';
const activeBots = {};
const tokenOwner = {};
const awaiting = {};
const lastMsg = {};

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const chanUrl = (ch) => String(ch).startsWith('http') ? ch : 'https://t.me/' + String(ch).replace('@', '');

function setA(key, type, extra) {
  awaiting[key] = Object.assign({ type: type, exp: Date.now() + 300000 }, extra || {});
}
function getA(key) {
  const a = awaiting[key];
  if (!a) return null;
  if (Date.now() > a.exp) { delete awaiting[key]; return null; }
  return a;
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
  try { if (activeBots[botId]) stopBot(botId); } catch (e) {}
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

  console.log('[engine] STARTED ' + botId + ' (' + name + ') ' + currency + ' ' + pay);

  async function deactivate(reason) {
    stopBot(botId);
    try { await db.collection('bots').doc(botId).update({ status: 'deactivated', deactivationReason: reason }); } catch (e) {}
    console.log('[engine] deactivated ' + botId + ': ' + reason);
  }

  bot.getMe().catch(() => deactivate('Token invalid'));
  bot.on('polling_error', (err) => {
    const m = String((err && err.message) || err);
    if (/401|404/.test(m)) deactivate('Token invalid');
    else console.log('[engine] polling ' + botId + ': ' + m.slice(0, 100));
  });
  bot.on('error', (err) => console.log('[engine] err ' + botId + ': ' + String(err).slice(0, 100)));

  // wraps every handler so NOTHING can crash the process
  const safe = (fn) => async function () {
    try { await fn.apply(null, arguments); }
    catch (e) { console.error('[engine] handler ' + botId + ':', e.message); }
  };

  const menuKeyboard = () => {
    const keyboard = [[{ text: 'Balance' }, { text: 'Invite' }], [{ text: 'Tasks' }, { text: 'Withdraw' }]];
    if (pay === 'Manual' || pay === 'AutoPay1') keyboard.push([{ text: 'Wallet' }]);
    return { reply_markup: { keyboard, resize_keyboard: true }, parse_mode: 'HTML' };
  };

  async function notifyPayout(text, opts) {
    if (!payout) return;
    try { await bot.sendMessage(payout, text, opts || { parse_mode: 'HTML' }); } catch (e) {}
  }

  async function logWithdraw(uid, amount, status, wallet) {
    try {
      await db.collection('bots').doc(botId).collection('withdrawals').add({ uid: String(uid), amount, currency, status, wallet: wallet || '-', at: Date.now() });    } catch (e) {}
  }

  // FAIL-CLOSED must join check: if we cannot verify, user does NOT pass
  async function mustJoinOk(uid) {
    for (const ch of mustJoin) {
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          const m = await bot.getChatMember(ch, uid);
          ok = !(m.status === 'left' || m.status === 'kicked');
        } catch (e) {
          ok = false;
          await new Promise(r => setTimeout(r, 400));
        }
      }
      if (!ok) return false;
    }
    return true;
  }

  async function showChannels(uid) {
    const rows = [[{ text: '📢 DOV Channel', url: OFFICIAL_URL }]];
    let i = 1;
    for (const ch of mustJoin) { rows.push([{ text: '📢 Channel ' + i + ' (REQUIRED)', url: chanUrl(ch) }]); i++; }
    for (const ch of nonMust) { rows.push([{ text: '📢 Channel ' + i, url: chanUrl(ch) }]); i++; }
    if (payout) rows.push([{ text: '💼 Payout', url: chanUrl(payout) }]);
    rows.push([{ text: '🚀 CONTINUE', callback_data: 'continue' }]);
    await bot.sendMessage(uid,
      '⭐ <b>WELCOME TO ' + esc(name) + '</b>\n\n━━━━━━━━━━━━━━\n\n📢 <b>Join these channels first:</b>\n\nRequired ones are marked (REQUIRED).\nThen tap CONTINUE.\n\n━━━━━━━━━━━━━━\n\n✅ Referral bonus: <b>' + refB + ' ' + currency + '</b> per invite',
      { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' });
  }

  function askCaptcha(uid, key, wrong) {
    const a = Math.floor(Math.random() * 10) + 1;
    const b = Math.floor(Math.random() * 10) + 1;
    setA(key, 'captcha', { answer: a + b });
    bot.sendMessage(uid,
      (wrong ? '❌ Wrong! Try again:\n\n' : '🤖 <b>ARE YOU A ROBOT?</b>\n\nProve you are human:\n\n') +
      '<b>' + a + ' + ' + b + ' = ?</b>\n\nSend your answer:', { parse_mode: 'HTML' });
  }

  // /start
  bot.onText(/\/start(?:\s+(\d+))?/, safe(async (msg, match) => {
    const uid = msg.chat.id;
    const key = botId + ':' + uid;
    delete awaiting[key];
    const got = await getUser(botId, uid);
    if (got.data.banned) return bot.sendMessage(uid, '🚫 <b>You are banned from this bot.</b>', { parse_mode: 'HTML' });
    if (got.isNew) await db.collection('bots').doc(botId).update({ users: FieldValue.increment(1) }).catch(() => {});    await db.collection('bots').doc(botId).update({ lastActive: Date.now() }).catch(() => {});

    const refId = match && match[1] ? match[1] : null;
    if (refId && refId !== String(uid) && !got.data.refer) {
      await got.ref.update({ refer: refId }).catch(() => {});
      await db.collection('bots').doc(botId).collection('users').doc(refId)
        .update({ balance: FieldValue.increment(refB), refs: FieldValue.increment(1) }).catch(() => {});
      bot.sendMessage(refId, '✅ You earned <b>' + refB + ' ' + currency + '</b> for a new referral!', { parse_mode: 'HTML' }).catch(() => {});
    }

    if (botDetect && !got.data.captchaPassed) return askCaptcha(uid, key, false);
    await showChannels(uid);
  }));

  // messages
  bot.on('message', safe(async (msg) => {
    const uid = msg.chat.id;
    const key = botId + ':' + uid;
    if (lastMsg[key] === msg.message_id) return; // no double replies
    lastMsg[key] = msg.message_id;

    const txt = (msg.text || '').trim();
    if (!txt || txt.startsWith('/')) return;

    const got = await getUser(botId, uid);
    if (got.data.banned) return bot.sendMessage(uid, '🚫 <b>You are banned.</b>', { parse_mode: 'HTML' });

    const st = getA(key);
    if (st) {
      delete awaiting[key];
      if (st.type === 'captcha') {
        if (parseInt(txt, 10) === st.answer) {
          await got.ref.update({ captchaPassed: true });
          bot.sendMessage(uid, '✅ Human verified!', { parse_mode: 'HTML' });
          return showChannels(uid);
        }
        return askCaptcha(uid, key, true);
      }
      if (st.type === 'wallet') {
        await got.ref.update({ wallet: txt });
        return bot.sendMessage(uid, '✅ <b>Wallet saved</b>\n\n<code>' + esc(txt) + '</code>', { parse_mode: 'HTML' });
      }
      if (st.type === 'withdraw') return handleWithdrawAmount(uid, txt);
      if (st.type === 'proof') return saveProof(uid, msg, st.task);
    }

    if (txt === 'Balance') return handleBalance(uid);
    if (txt === 'Invite') return handleInvite(uid);
    if (txt === 'Tasks') return handleTasks(uid);
    if (txt === 'Wallet' && (pay === 'Manual' || pay === 'AutoPay1')) {      setA(key, 'wallet');
      return bot.sendMessage(uid, '👛 Current: <code>' + esc(got.data.wallet) + '</code>\n\nSend your new wallet address:', { parse_mode: 'HTML' });
    }
    if (txt === 'Withdraw') {
      if ((pay === 'Manual' || pay === 'AutoPay1') && (!got.data.wallet || got.data.wallet === 'Not Set')) {
        return bot.sendMessage(uid, '⚠️ Set your wallet first: tap <b>Wallet</b>', { parse_mode: 'HTML' });
      }
      setA(key, 'withdraw');
      return bot.sendMessage(uid, '📤 Enter amount (' + currency + ')\nMin: ' + minW + ' · Max: ' + maxW);
    }
  }));

  // callbacks
  bot.on('callback_query', safe(async (cq) => {
    const uid = cq.from.id;
    const key = botId + ':' + uid;

    if (cq.data === 'continue') {
      const ok = await mustJoinOk(uid);
      if (!ok) {
        return bot.answerCallbackQuery(cq.id, { text: '❌ Join ALL (REQUIRED) channels first, then try again!', show_alert: true });
      }
      await bot.answerCallbackQuery(cq.id, { text: '✅ Verified!' });
      return bot.sendMessage(uid, '🏡 <b>' + esc(name) + ' Menu</b>\n\nTap an option below:', menuKeyboard());
    }

    if (cq.data && cq.data.indexOf('task_') === 0) {
      const t = tasks[parseInt(cq.data.split('_')[1], 10)];
      if (!t) return;
      setA(key, 'proof', { task: t.n });
      return bot.sendMessage(uid, '📋 <b>' + esc(t.n) + '</b>\n\n🔗 ' + esc(t.l) + '\n\n📸 Now send your proof (screenshot or text):', { parse_mode: 'HTML' });
    }

    if (cq.data && (cq.data.indexOf('approve_') === 0 || cq.data.indexOf('decline_') === 0)) {
      const approve = cq.data.indexOf('approve_') === 0;
      const pid = cq.data.split('_')[1];
      const ref = db.collection('bots').doc(botId).collection('proofs').doc(pid);
      const doc = await ref.get();
      if (doc.exists) {
        const p = doc.data();
        await ref.delete();
        bot.sendMessage(p.uid, approve ? '✅ <b>Your proof was APPROVED!</b>' : '❌ <b>Your proof was declined.</b>', { parse_mode: 'HTML' }).catch(() => {});
      }
      try { await bot.editMessageText(approve ? '✅ Approved & deleted.' : '❌ Declined & deleted.', { chat_id: cq.message.chat.id, message_id: cq.message.message_id }); } catch (e) {}
    }
  }));

  async function saveProof(uid, msg, taskName) {
    const docRef = await db.collection('bots').doc(botId).collection('proofs').add({
      uid: String(uid), task: taskName, text: msg.text || '', photo: msg.photo ? msg.photo[msg.photo.length - 1].file_id : null, status: 'pending', at: Date.now()    });
    const caption = '🧾 <b>NEW TASK PROOF</b>\n\n📋 Task: ' + esc(taskName) + '\n👤 User: <code>' + uid + '</code>\n📝 ' + esc(msg.text || '(photo)');
    const btns = { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: 'approve_' + docRef.id }, { text: '❌ Decline', callback_data: 'decline_' + docRef.id }]] }, parse_mode: 'HTML' };
    if (msg.photo) {
      await notifyPayout(caption, btns);
      await bot.sendPhoto(payout, msg.photo[msg.photo.length - 1].file_id, { caption: 'Proof from ' + uid }).catch(() => {});
    } else {
      await notifyPayout(caption, btns);
    }
    bot.sendMessage(uid, '✅ Proof sent to the owner for review!', { parse_mode: 'HTML' });
  }

  async function handleBalance(uid) {
    const got = await getUser(botId, uid);
    await bot.sendMessage(uid,
      '<b>MY ACCOUNT</b>\n\n━━━━━━━━━━━━━━\n\n⭐ Balance: <b>' + Number(got.data.balance || 0).toFixed(2) + ' ' + currency + '</b>\n👛 Wallet: <code>' + esc(got.data.wallet) + '</code>\n👥 Referrals: ' + (got.data.refs || 0) + '\n🎁 Per referral: <b>' + refB + ' ' + currency + '</b>\n\n━━━━━━━━━━━━━━',
      { parse_mode: 'HTML' });
  }

  async function handleInvite(uid) {
    const me = await bot.getMe();
    const got = await getUser(botId, uid);
    await bot.sendMessage(uid,
      '<b>INVITE & EARN</b>\n\n━━━━━━━━━━━━━━\n\n🎁 Per referral: <b>' + refB + ' ' + currency + '</b>\n👥 Your referrals: ' + (got.data.refs || 0) + '\n\n━━━━━━━━━━━━━━\n\nYour link:\n<code>https://t.me/' + me.username + '?start=' + uid + '</code>',
      { parse_mode: 'HTML' });
  }

  async function handleTasks(uid) {
    if (!tasks.length) return bot.sendMessage(uid, '📋 <b>No tasks available yet.</b>', { parse_mode: 'HTML' });
    const rows = tasks.map((t, i) => [{ text: (i + 1) + '. ' + t.n, callback_data: 'task_' + i }]);
    await bot.sendMessage(uid, '📋 <b>TASKS</b>\n\nTap a task, complete it, then send proof:', { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' });
  }

  async function handleWithdrawAmount(uid, raw) {
    const amount = parseFloat(raw);
    if (isNaN(amount)) return bot.sendMessage(uid, '❌ Numbers only.');
    if (amount < minW || amount > maxW) return bot.sendMessage(uid, '❌ Between ' + minW + ' and ' + maxW + ' ' + currency);
    const got = await getUser(botId, uid);
    if (Number(got.data.balance || 0) < amount) return bot.sendMessage(uid, '❌ Insufficient balance (' + Number(got.data.balance || 0).toFixed(2) + ' ' + currency + ')');

    if (pay === 'AutoPay1') {
      let ok = false, err = 'API error';
      try {
        const r = await axios.post('https://ptexchange-api.vercel.app/pay/' + currency.toLowerCase(), { api_key: apiKey, to_address: got.data.wallet, amount, comment: name }, { timeout: 30000 });
        ok = r.status === 200 && r.data && (r.data.success || r.data.ok);
        if (!ok) err = (r.data && (r.data.message || r.data.error)) || 'Rejected';
      } catch (e) { err = e.message; }
      if (ok) {
        await got.ref.update({ balance: FieldValue.increment(-amount) });
        await logWithdraw(uid, amount, 'paid', got.data.wallet);        await notifyPayout('✅ <b>AutoPay1 PAID</b>\n👤 ' + uid + '\n⭐ ' + amount + ' ' + currency + '\n👛 ' + esc(got.data.wallet));
        return bot.sendMessage(uid, '✅ <b>Paid!</b> ' + amount + ' ' + currency + ' sent to your wallet.');
      }
      await notifyPayout('❌ <b>AutoPay1 FAILED</b>\n👤 ' + uid + '\n⭐ ' + amount + ' ' + currency + '\n⚠️ ' + esc(err).slice(0, 200));
      return bot.sendMessage(uid, '❌ Failed: ' + esc(err).slice(0, 120) + '\nBalance NOT deducted.');
    }

    if (pay === 'AutoPay2') {
      let ok = false, err = 'API error';
      try {
        const r = await axios.post('https://pay.api.xrocket.exchange/api/v1/payouts', {
          clientPayoutId: 'CLUR-' + uid + '-' + Date.now(), target: String(uid), targetType: 'telegram_user_id',
          asset: currency.toUpperCase(), amount: String(amount), description: name
        }, { headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, timeout: 30000 });
        ok = r.status === 200;
        if (!ok) err = (r.data && (r.data.message || r.data.error)) || 'Rejected';
      } catch (e) { err = e.message; }
      if (ok) {
        await got.ref.update({ balance: FieldValue.increment(-amount) });
        await logWithdraw(uid, amount, 'paid', 'telegram');
        await notifyPayout('✅ <b>AutoPay2 PAID</b>\n👤 ' + uid + '\n⭐ ' + amount + ' ' + currency);
        return bot.sendMessage(uid, '✅ <b>Paid via xRocket!</b> ' + amount + ' ' + currency);
      }
      await notifyPayout('❌ <b>AutoPay2 FAILED</b>\n👤 ' + uid + '\n⭐ ' + amount + ' ' + currency + '\n⚠️ ' + esc(err).slice(0, 200));
      return bot.sendMessage(uid, '❌ Failed: ' + esc(err).slice(0, 120) + '\nBalance NOT deducted.');
    }

    await got.ref.update({ balance: FieldValue.increment(-amount) });
    await logWithdraw(uid, amount, 'pending', got.data.wallet);
    await notifyPayout('📥 <b>MANUAL WITHDRAWAL</b>\n\n👤 <code>' + uid + '</code>\n⭐ ' + amount + ' ' + currency + '\n👛 <code>' + esc(got.data.wallet) + '</code>\nStatus: Pending');
    bot.sendMessage(uid, '⏳ Submitted! ' + amount + ' ' + currency + ' pending admin review.');
  }
}

function stopBot(botId) {
  const info = activeBots[botId];
  if (!info) return;
  try { info.bot.stopPolling(); } catch (e) {}
  try { delete tokenOwner[info.cfg.token]; } catch (e) {}
  delete activeBots[botId];
  console.log('[engine] stopped ' + botId);
}

async function restartBot(botId) {
  stopBot(botId);
  try {
    const snap = await db.collection('bots').doc(botId).get();
    if (!snap.exists) return;
    const cfg = Object.assign({ id: snap.id }, snap.data());
    if (cfg.status === 'active') startBot(cfg);  } catch (e) { console.error('[engine] restart error:', e.message); }
}

async function loadAllBots() {
  try {
    const snap = await db.collection('bots').where('status', '==', 'active').get();
    console.log('[engine] loading ' + snap.size + ' bots...');
    let i = 0;
    for (const d of snap.docs) {
      try { startBot(Object.assign({ id: d.id }, d.data())); } catch (e) { console.error('[engine] start fail ' + d.id + ':', e.message); }
      i++;
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 800));
    }
    console.log('[engine] all bots live');
  } catch (e) { console.error('[engine] loadAllBots error:', e.message); }
}

module.exports = { startBot, stopBot, restartBot, loadAllBots, activeBots, sendTo };

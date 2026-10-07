const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { db } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');

const POWERED_BY = 'Crulbotcreatiobot';
const OFFICIAL_URL = 'https://t.me/DAILYUUPA';
const activeBots = {};
const tokenOwner = {};
const awaiting = {};
const lastMsg = {};

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function normchan(ch) {
  let s = String(ch || '').trim();
  if (!s) return '';
  if (s.startsWith('http')) {
    const m = s.match(/t\.me\/(?:c\/)?([^\/?]+)/);
    if (m) s = m[1];
  }
  if (/^-?\d/.test(s)) return s;
  return s.startsWith('@') ? s : '@' + s;
}

const chanUrl = (ch) => {
  const s = normchan(ch);
  if (/^-?\d/.test(s)) return 'https://t.me/c/' + s;
  return 'https://t.me/' + s.replace('@', '');
};

// Coin slugs for payment APIs (fixes USDT/USDC/NOT/DOGS)
function ptSlug(cur) {
  const c = String(cur || '').toLowerCase();
  if (c === 'usdt') return 'usdt';
  if (c === 'usdc') return 'usdc';
  if (c === 'dogs') return 'dogs';
  if (c === 'not') return 'not';
  if (c === 'ton') return 'ton';
  return c;
}
function xrAsset(cur) {
  return String(cur || '').toUpperCase();
}

function setA(key, type, extra) { awaiting[key] = Object.assign({ type: type, exp: Date.now() + 300000 }, extra || {}); }
function getA(key) {
  const a = awaiting[key];
  if (!a) return null;
  if (Date.now() > a.exp) { delete awaiting[key]; return null; }  return a;
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

function startBot(cfgIn) {
  const cfg = Object.assign({}, cfgIn);
  const botId = cfg.id;
  try { if (activeBots[botId]) stopBot(botId); } catch (e) {}
  const prev = tokenOwner[cfg.token];
  if (prev && prev !== botId) stopBot(prev);

  const bot = new TelegramBot(cfg.token, { polling: true });
  activeBots[botId] = { bot, cfg };
  tokenOwner[cfg.token] = botId;

  let currency = cfg.currency || '';
  let pay = cfg.payMethod || 'Manual';
  let minW = Number(cfg.minW || 0);
  let maxW = Number(cfg.maxW || 0);
  let refB = Number(cfg.refBonus || 0);
  let payout = cfg.payoutChannel || '';
  let apiKey = cfg.apiKey || '';
  let mustJoin = (cfg.mustJoin || []).slice(0, 10);
  let nonMust = (cfg.nonMust || []).slice(0, 10);
  let tasks = cfg.tasks || [];
  let botDetect = !!cfg.botDetect;
  let name = cfg.name || 'Rewards Bot';
  let fee = Number(cfg.withdrawFee || 0); // fee ONLY if owner sets it

  console.log('[engine] STARTED ' + botId + ' (' + name + ')');

  async function deactivate(reason) {
    stopBot(botId);
    try { await db.collection('bots').doc(botId).update({ status: 'deactivated', deactivationReason: reason }); } catch (e) {}  }

  bot.getMe().catch(() => deactivate('Token invalid'));
  bot.on('polling_error', (err) => {
    const m = String((err && err.message) || err);
    if (/401|404/.test(m)) deactivate('Token invalid');
    else console.log('[engine] polling ' + botId + ': ' + m.slice(0, 100));
  });
  bot.on('error', (err) => console.log('[engine] err ' + botId + ': ' + String(err).slice(0, 100)));

  const safe = (fn) => async function () {
    try { await fn.apply(null, arguments); }
    catch (e) { console.error('[engine] handler ' + botId + ':', e.message); }
  };

  async function refreshCfg() {
    try {
      const snap = await db.collection('bots').doc(botId).get();
      if (!snap.exists) { deactivate('Deleted'); return false; }
      const d = snap.data();
      if (d.status !== 'active') { deactivate('Status changed'); return false; }
      currency = d.currency || currency;
      pay = d.payMethod || pay;
      minW = Number(d.minW != null ? d.minW : minW);
      maxW = Number(d.maxW != null ? d.maxW : maxW);
      refB = Number(d.refBonus != null ? d.refBonus : refB);
      payout = d.payoutChannel || payout;
      apiKey = d.apiKey || apiKey;
      mustJoin = (d.mustJoin || []).slice(0, 10);
      nonMust = (d.nonMust || []).slice(0, 10);
      tasks = d.tasks || tasks;
      botDetect = !!d.botDetect;
      name = d.name || name;
      fee = Number(d.withdrawFee != null ? d.withdrawFee : fee);
      return true;
    } catch (e) { return true; }
  }

  const menuKeyboard = () => {
    const keyboard = [
      [{ text: '🏦 Balance' }, { text: '🎁 Invite' }],
      [{ text: '📋 Tasks' }, { text: '💸 Withdraw' }]
    ];
    if (pay === 'Manual' || pay === 'AutoPay1') keyboard.push([{ text: '👛 Wallet' }]);
    return { reply_markup: { keyboard, resize_keyboard: true }, parse_mode: 'HTML' };
  };

  async function notifyPayout(text, opts) {
    if (!payout) return;
    try { await bot.sendMessage(normchan(payout), text, opts || { parse_mode: 'HTML' }); } catch (e) {}  }

  async function logWithdraw(uid, amount, status, wallet, txHash, feeAmount, receivedAmount) {
    try {
      await db.collection('bots').doc(botId).collection('withdrawals').add({
        uid: String(uid), amount, fee: feeAmount || 0, received: receivedAmount || amount,
        currency, status, wallet: wallet || '-', txHash: txHash || null, at: Date.now()
      });
    } catch (e) {}
  }

  async function getUsername(uid) {
    try { const c = await bot.getChat(uid); return c.username ? '@' + c.username : (c.first_name || ''); } catch (e) { return ''; }
  }

  function askCaptcha(uid, key, wrong) {
    const a = Math.floor(Math.random() * 10) + 1;
    const b = Math.floor(Math.random() * 10) + 1;
    setA(key, 'captcha', { answer: a + b });
    bot.sendMessage(uid,
      (wrong ? '❌ Wrong answer!\n\nTry again:\n\n' : '🤖 <b>ARE YOU A ROBOT?</b>\n\nProve you are human first:\n\n') +
      '🧮 <b>' + a + ' + ' + b + ' = ?</b>\n\n👉 Send your answer:', { parse_mode: 'HTML' });
  }

  async function showChannels(uid) {
    const rows = [[{ text: '💼 Official Channel', url: OFFICIAL_URL }]];
    let channelNum = 1;
    for (const ch of mustJoin) {
      rows.push([{ text: '📢 Channel ' + channelNum + ' (Required)', url: chanUrl(ch) }]);
      channelNum++;
    }
    for (const ch of nonMust) {
      rows.push([{ text: '📢 Channel ' + channelNum, url: chanUrl(ch) }]);
      channelNum++;
    }
    if (payout) rows.push([{ text: '💰 Payment Channel', url: chanUrl(payout) }]);
    rows.push([{ text: '✅ START', callback_data: 'continue' }]);

    const welcomeMsg = '🎉 <b>Welcome to ' + esc(name) + '!</b>\n\n' +
      'Here\'s how it works:\n' +
      '• Invite friends using your unique link\n' +
      '• Earn ' + esc(currency) + ' for every friend who joins\n' +
      '• Withdraw your earnings anytime\n\n' +
      '👉 <i>First, join our channels:</i>\n\n' +
      '🤖 Powered By: <a href="https://t.me/' + POWERED_BY + '">@' + POWERED_BY + '</a>';

    await bot.sendMessage(uid, welcomeMsg,
      { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML', disable_web_page_preview: true });
  }
  bot.onText(/\/start(?:\s+(\d+))?/, safe(async (msg, match) => {
    const uid = msg.chat.id;
    const key = botId + ':' + uid;
    delete awaiting[key];
    const alive = await refreshCfg();
    if (!alive) return;
    const got = await getUser(botId, uid);
    if (got.data.banned) return bot.sendMessage(uid, '🚫 <b>You are banned from this bot.</b>', { parse_mode: 'HTML' });
    if (got.isNew) await db.collection('bots').doc(botId).update({ users: FieldValue.increment(1) }).catch(() => {});
    await db.collection('bots').doc(botId).update({ lastActive: Date.now() }).catch(() => {});

    const refId = match && match[1] ? match[1] : null;
    if (refId && refId !== String(uid) && !got.data.refer) {
      await got.ref.update({ refer: refId }).catch(() => {});
      await db.collection('bots').doc(botId).collection('users').doc(refId)
        .update({ balance: FieldValue.increment(refB), refs: FieldValue.increment(1) }).catch(() => {});
      bot.sendMessage(refId, '🎁 You earned <b>' + refB + ' ' + esc(currency) + '</b> for a new referral!', { parse_mode: 'HTML' }).catch(() => {});
    }

    await showChannels(uid);
  }));

  bot.on('message', safe(async (msg) => {
    const uid = msg.chat.id;
    const key = botId + ':' + uid;
    if (lastMsg[key] === msg.message_id) return;
    lastMsg[key] = msg.message_id;

    const txt = (msg.text || '').trim();
    if (!txt) return;
    if (txt.startsWith('/')) { delete awaiting[key]; return; }

    const got = await getUser(botId, uid);
    if (got.data.banned) return bot.sendMessage(uid, '🚫 <b>You are banned.</b>', { parse_mode: 'HTML' });

    const st = getA(key);
    if (st) {
      delete awaiting[key];
      if (st.type === 'captcha') {
        if (parseInt(txt, 10) === st.answer) {
          await got.ref.update({ captchaPassed: true });
          bot.sendMessage(uid, '✅ <b>Human verified!</b>', { parse_mode: 'HTML' });
          return bot.sendMessage(uid, '🏡 <b>' + esc(name) + ' Menu</b>\n\nTap an option below:', menuKeyboard());
        }
        return askCaptcha(uid, key, true);
      }
      if (st.type === 'wallet') {
        await got.ref.update({ wallet: txt });
        return bot.sendMessage(uid, '✅ <b>Wallet saved</b>\n\n👛 <code>' + esc(txt) + '</code>', { parse_mode: 'HTML' });
      }      if (st.type === 'withdraw') return handleWithdrawAmount(uid, txt, got);
      if (st.type === 'proof') return saveProof(uid, msg, st.task, st.reward);
    }

    if (txt === '🏦 Balance') return handleBalance(uid, got);
    if (txt === '🎁 Invite') return handleInvite(uid, got);
    if (txt === '📋 Tasks') return handleTasks(uid);
    if (txt === '👛 Wallet' && (pay === 'Manual' || pay === 'AutoPay1')) {
      setA(key, 'wallet');
      return bot.sendMessage(uid, '👛 Current wallet:\n<code>' + esc(got.data.wallet) + '</code>\n\n📝 Send your new wallet address:', { parse_mode: 'HTML' });
    }
    if (txt === '💸 Withdraw') {
      if (!minW || !maxW || !payout) return bot.sendMessage(uid, '⚠️ Bot owner has not finished setup yet. Try later.');
      if ((pay === 'Manual' || pay === 'AutoPay1') && (!got.data.wallet || got.data.wallet === 'Not Set')) {
        return bot.sendMessage(uid, '⚠️ Set your wallet first: tap <b>👛 Wallet</b>', { parse_mode: 'HTML' });
      }
      setA(key, 'withdraw');
      return bot.sendMessage(uid,
        '💸 <b>WITHDRAW</b>\n\n' +
        '💰 Enter amount (' + esc(currency) + ')\n' +
        '⬇️ Min: ' + minW + '  ·  ⬆️ Max: ' + maxW + '\n\n' +
        '<i>Want more? Tap Earn More below:</i>',
        { reply_markup: { inline_keyboard: [[{ text: '🎯 Earn More', callback_data: 'earnmore' }]] }, parse_mode: 'HTML' });
    }
  }));

  bot.on('callback_query', safe(async (cq) => {
    const uid = cq.from.id;
    const key = botId + ':' + uid;

    if (cq.data === 'continue') {
      await refreshCfg();
      for (const ch of mustJoin) {
        const chan = normchan(ch);
        let m;
        try {
          m = await bot.getChatMember(chan, uid);
        } catch (e) {
          console.log('[engine] getChatMember error for ' + chan + ': ' + e.message);
          return bot.answerCallbackQuery(cq.id, { text: '⚠️ Bot is not admin in ' + ch + ' — contact the owner.', show_alert: true });
        }
        if (m.status === 'left' || m.status === 'kicked') {
          return bot.answerCallbackQuery(cq.id, { text: '❌ Please join ' + ch + ' first!', show_alert: true });
        }
      }
      await bot.answerCallbackQuery(cq.id, { text: '✅ Channels verified!' });

      if (botDetect) {
        const got = await getUser(botId, uid);
        if (!got.data.captchaPassed) return askCaptcha(uid, key, false);      }
      return bot.sendMessage(uid, '🏡 <b>' + esc(name) + ' Menu</b>\n\nTap an option below:', menuKeyboard());
    }

    if (cq.data === 'earnmore') {
      const me = await bot.getMe();
      const rows = taskRows();
      rows.push([{ text: '🎁 Invite Friends — earn ' + refB + ' ' + currency, url: 'https://t.me/' + me.username + '?start=' + uid }]);
      return bot.sendMessage(uid,
        '<b>🎯 EARN MORE ' + esc(currency) + '</b>\n\n━━━━━━━━━━━━━━\n\n' +
        '1️⃣ <b>Invite friends</b> — earn ' + refB + ' ' + esc(currency) + ' per referral\n' +
        '<code>https://t.me/' + me.username + '?start=' + uid + '</code>\n\n' +
        '2️⃣ <b>Complete tasks</b> — tap a task below:\n\n━━━━━━━━━━━━━━',
        { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' });
    }

    if (cq.data && cq.data.indexOf('task_') === 0) {
      const idx = parseInt(cq.data.split('_')[1], 10);
      const t = tasks[idx];
      if (!t) return;
      setA(key, 'proof', { task: t.n, reward: Number(t.reward || 0) });
      return bot.sendMessage(uid,
        '📋 <b>' + esc(t.n) + '</b>\n\n🔗 ' + esc(t.l) + '\n\n' +
        (t.reward ? '🎁 Prize: <b>' + t.reward + ' ' + esc(currency) + '</b>\n\n' : '') +
        '📸 Now send your proof (screenshot or text):', { parse_mode: 'HTML' });
    }

    if (cq.data && (cq.data.indexOf('approve_') === 0 || cq.data.indexOf('decline_') === 0)) {
      const approve = cq.data.indexOf('approve_') === 0;
      const pid = cq.data.split('_')[1];
      const ref = db.collection('bots').doc(botId).collection('proofs').doc(pid);
      const doc = await ref.get();
      if (doc.exists) {
        const p = doc.data();
        if (approve && p.reward) {
          await db.collection('bots').doc(botId).collection('users').doc(p.uid)
            .update({ balance: FieldValue.increment(p.reward) }).catch(() => {});
          bot.sendMessage(p.uid, '✅ <b>APPROVED!</b>\n\n🎁 You earned <b>' + p.reward + ' ' + esc(currency) + '</b>!', { parse_mode: 'HTML' }).catch(() => {});
        } else {
          bot.sendMessage(p.uid, approve ? '✅ <b>Your proof was APPROVED!</b>' : '❌ <b>Your proof was declined.</b>', { parse_mode: 'HTML' }).catch(() => {});
        }
        await ref.delete();
      }
      try { await bot.editMessageText(approve ? '✅ Approved & deleted.' : '❌ Declined & deleted.', { chat_id: cq.message.chat.id, message_id: cq.message.message_id }); } catch (e) {}
    }
  }));

  async function saveProof(uid, msg, taskName, reward) {
    const docRef = await db.collection('bots').doc(botId).collection('proofs').add({
      uid: String(uid), task: taskName, reward: reward || 0, text: msg.text || '',      photo: msg.photo ? msg.photo[msg.photo.length - 1].file_id : null, status: 'pending', at: Date.now()
    });
    const caption = '🧾 <b>NEW TASK PROOF</b>\n\n📋 Task: ' + esc(taskName) + '\n🎁 Prize: ' + (reward || 0) + ' ' + esc(currency) + '\n👤 User ID: <code>' + uid + '</code>\n📝 ' + esc(msg.text || '(photo)');
    const btns = { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: 'approve_' + docRef.id }, { text: '❌ Decline', callback_data: 'decline_' + docRef.id }]] }, parse_mode: 'HTML' };
    if (msg.photo) {
      await notifyPayout(caption, btns);
      await bot.sendPhoto(normchan(payout), msg.photo[msg.photo.length - 1].file_id, { caption: 'Proof from ' + uid }).catch(() => {});
    } else {
      await notifyPayout(caption, btns);
    }
    bot.sendMessage(uid, '✅ Proof sent for review!', { parse_mode: 'HTML' });
  }

  async function handleBalance(uid, got) {
    await bot.sendMessage(uid,
      '<b>🏦 MY ACCOUNT</b>\n\n━━━━━━━━━━━━━━\n\n🏦 Balance: <b>' + Number(got.data.balance || 0).toFixed(2) + ' ' + esc(currency) + '</b>\n\n' +
      '👛 Wallet: <code>' + esc(got.data.wallet) + '</code>\n\n' +
      '🎁 Referrals: ' + (got.data.refs || 0) + '\n\n' +
      '💎 Per referral: <b>' + refB + ' ' + esc(currency) + '</b>\n\n━━━━━━━━━━━━━━\n' +
      '🤖 Powered By: <a href="https://t.me/' + POWERED_BY + '">@' + POWERED_BY + '</a>',
      { parse_mode: 'HTML', disable_web_page_preview: true });
  }

  async function handleInvite(uid, got) {
    const me = await bot.getMe();
    await bot.sendMessage(uid,
      '<b>🎁 INVITE & EARN</b>\n\n━━━━━━━━━━━━━━\n\n💎 Per referral: <b>' + refB + ' ' + esc(currency) + '</b>\n\n🎁 Your referrals: ' + (got.data.refs || 0) + '\n\n━━━━━━━━━━━━━━\n\nYour link:\n<code>https://t.me/' + me.username + '?start=' + uid + '</code>',
      { parse_mode: 'HTML' });
  }

  function taskRows() {
    return tasks.map((t, i) => [{ text: (i + 1) + '. ' + t.n + (t.reward ? ' (+' + t.reward + ')' : ''), callback_data: 'task_' + i }]);
  }

  async function handleTasks(uid) {
    if (!tasks.length) return bot.sendMessage(uid, '📋 <b>No tasks available yet.</b>', { parse_mode: 'HTML' });
    await bot.sendMessage(uid, '📋 <b>TASKS</b>\n\nTap a task, complete it, then send proof:', { reply_markup: { inline_keyboard: taskRows() }, parse_mode: 'HTML' });
  }

  // receipt builder: wallet hidden for AutoPay2 (xRocket)
  function receipt(status, amount, feeAmount, receivedAmount, wallet, txHash, newBalance, paid) {
    let out = '';
    out += (paid ? '✅ <b>Withdrawal Paid Successfully!</b>' : '✅ <b>Withdrawal Request Submitted!</b>') + '\n\n';
    out += '💰 Requested: <b>' + amount + ' ' + esc(currency) + '</b>\n\n';
    out += '💳 Fee: <b>' + feeAmount + ' ' + esc(currency) + '</b>\n\n';
    out += (paid ? '📤 You Received: <b>' + receivedAmount + ' ' + esc(currency) + '</b>\n\n' : '📤 You will receive: <b>' + receivedAmount + ' ' + esc(currency) + '</b>\n\n');
    out += '📦 Status: <b>' + status + '</b>\n\n';
    if (pay === 'AutoPay2') {
      out += '📬 Delivery: <b>Your Telegram account</b> (xRocket)\n\n';
    } else {      out += '🏦 Wallet:\n<code>' + esc(wallet) + '</code>\n\n';
    }
    if (txHash) out += '💳 Transaction:\n<code>' + esc(txHash) + '</code>\n\n';
    out += '💰 Remaining Balance:\n<b>' + newBalance.toFixed(2) + ' ' + esc(currency) + '</b>';
    if (!paid) out += '\n\n<i>⏳ Owner will process your payment soon.</i>';
    return out;
  }

  async function handleWithdrawAmount(uid, raw, got) {
    const amount = parseFloat(raw);
    if (isNaN(amount)) return bot.sendMessage(uid, '❌ Numbers only.');
    if (amount < minW || amount > maxW) return bot.sendMessage(uid, '❌ Between ' + minW + ' and ' + maxW + ' ' + esc(currency));
    if (Number(got.data.balance || 0) < amount) return bot.sendMessage(uid, '❌ Insufficient balance (' + Number(got.data.balance || 0).toFixed(2) + ' ' + esc(currency) + ')');

    const feeAmount = fee;
    const receivedAmount = Math.max(0, amount - feeAmount);
    const walletLine = (pay === 'AutoPay2')
      ? '📬 Delivery: <b>Your Telegram account</b> (xRocket)'
      : '🏦 Wallet:\n<code>' + esc(got.data.wallet) + '</code>';

    await bot.sendMessage(uid,
      '⏳ <b>Processing withdrawal...</b>\n\n' +
      '💰 Requested: <b>' + amount + ' ' + esc(currency) + '</b>\n\n' +
      '💳 Fee: <b>' + feeAmount + ' ' + esc(currency) + '</b>\n\n' +
      '📤 You will receive: <b>' + receivedAmount + ' ' + esc(currency) + '</b>\n\n' +
      walletLine, { parse_mode: 'HTML' });

    // ---------- AUTOPAY 1: PT EXCHANGE ----------
    if (pay === 'AutoPay1') {
      let ok = false, err = 'API error', txHash = '';
      try {
        const slug = ptSlug(currency);
        const payload = { api_key: apiKey, to_address: got.data.wallet, address: got.data.wallet, wallet: got.data.wallet, amount: receivedAmount, comment: name };
        if (slug === 'usdt') payload.network = 'BEP20';
        const r = await axios.post('https://ptexchange-api.vercel.app/pay/' + slug, payload, { timeout: 30000 });
        console.log('[pay1] ' + botId + ' ' + slug + ' status=' + r.status + ' body=' + JSON.stringify(r.data).slice(0, 250));
        const d = r.data || {};
        ok = r.status === 200 && (d.success === true || d.ok === true || d.status === 'success' || !!d.tx_hash || !!d.hash || !!d.transaction || !!d.txHash);
        txHash = d.tx_hash || d.hash || d.transaction || d.txHash || '';
        if (!ok) err = d.message || d.error || 'Rejected';
      } catch (e) { err = e.message; console.log('[pay1] error ' + botId + ': ' + err); }

      if (ok) {
        await got.ref.update({ balance: FieldValue.increment(-amount) });
        await logWithdraw(uid, amount, 'paid', got.data.wallet, txHash, feeAmount, receivedAmount);
        await notifyPayout('✅ <b>AutoPay1 PAID</b>\n\n👤 User ID: <code>' + uid + '</code>\n\n💰 ' + amount + ' ' + esc(currency) + ' (received ' + receivedAmount + ')\n\n👛 ' + esc(got.data.wallet) + (txHash ? '\n\n💳 TX: <code>' + txHash + '</code>' : ''));
        const newBalance = Number(got.data.balance || 0) - amount;
        return bot.sendMessage(uid, receipt('PAID', amount, feeAmount, receivedAmount, got.data.wallet, txHash, newBalance, true), { parse_mode: 'HTML' });
      }
      await notifyPayout('❌ <b>AutoPay1 FAILED</b>\n\n👤 User ID: <code>' + uid + '</code>\n\n💰 ' + amount + ' ' + esc(currency) + '\n\n⚠️ ' + esc(err).slice(0, 200));      return bot.sendMessage(uid, '❌ <b>Payment failed</b>\n\n⚠️ ' + esc(err).slice(0, 120) + '\n\n💰 Balance NOT deducted.');
    }

    // ---------- AUTOPAY 2: XROCKET ----------
    if (pay === 'AutoPay2') {
      let ok = false, err = 'API error', txHash = '';
      try {
        const r = await axios.post('https://pay.api.xrocket.exchange/api/v1/payouts', {
          clientPayoutId: 'CLUR-' + uid + '-' + Date.now(),
          target: String(uid), targetType: 'telegram_user_id',
          asset: xrAsset(currency), amount: String(receivedAmount), description: name
        }, { headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, timeout: 30000 });
        console.log('[pay2] ' + botId + ' ' + xrAsset(currency) + ' status=' + r.status + ' body=' + JSON.stringify(r.data).slice(0, 250));
        const d = r.data || {};
        ok = (r.status === 200 || r.status === 201) && !d.error && d.status !== 'failed';
        txHash = d.payoutId || d.id || d.tx_hash || d.hash || '';
        if (!ok) err = d.message || d.error || 'Rejected';
      } catch (e) { err = e.message; console.log('[pay2] error ' + botId + ': ' + err); }

      if (ok) {
        await got.ref.update({ balance: FieldValue.increment(-amount) });
        await logWithdraw(uid, amount, 'paid', 'telegram', txHash, feeAmount, receivedAmount);
        await notifyPayout('✅ <b>AutoPay2 PAID</b>\n\n👤 User ID: <code>' + uid + '</code>\n\n💰 ' + amount + ' ' + esc(currency) + ' (received ' + receivedAmount + ')' + (txHash ? '\n\n💳 Payout ID: <code>' + txHash + '</code>' : ''));
        const newBalance = Number(got.data.balance || 0) - amount;
        return bot.sendMessage(uid, receipt('PAID', amount, feeAmount, receivedAmount, got.data.wallet, txHash, newBalance, true), { parse_mode: 'HTML' });
      }
      await notifyPayout('❌ <b>AutoPay2 FAILED</b>\n\n👤 User ID: <code>' + uid + '</code>\n\n💰 ' + amount + ' ' + esc(currency) + '\n\n⚠️ ' + esc(err).slice(0, 200));
      return bot.sendMessage(uid, '❌ <b>Payment failed</b>\n\n⚠️ ' + esc(err).slice(0, 120) + '\n\n💰 Balance NOT deducted.');
    }

    // ---------- MANUAL ----------
    await got.ref.update({ balance: FieldValue.increment(-amount) });
    await logWithdraw(uid, amount, 'pending', got.data.wallet, null, feeAmount, receivedAmount);
    const uname = await getUsername(uid);
    await notifyPayout(
      '📥 <b>NEW WITHDRAWAL REQUEST</b>\n\n' +
      '🤖 Bot: ' + esc(name) + '\n\n' +
      '👤 User ID: <code>' + uid + '</code>\n\n' +
      '🧑 User: ' + esc(uname || 'no username') + '\n\n' +
      '💰 Requested: <b>' + amount + ' ' + esc(currency) + '</b>\n\n' +
      '💳 Fee: ' + feeAmount + ' ' + esc(currency) + '\n\n' +
      '📤 Pay this user: <b>' + receivedAmount + ' ' + esc(currency) + '</b>\n\n' +
      '👛 Wallet: <code>' + esc(got.data.wallet) + '</code>\n\n' +
      '📦 Status: <b>PENDING</b>\n\n' +
      '🕒 ' + new Date().toLocaleString()
    );
    const newBalance = Number(got.data.balance || 0) - amount;
    bot.sendMessage(uid, receipt('PENDING', amount, feeAmount, receivedAmount, got.data.wallet, '', newBalance, false), { parse_mode: 'HTML' });
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
    if (cfg.status === 'active') startBot(cfg);
  } catch (e) { console.error('[engine] restart error:', e.message); }
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

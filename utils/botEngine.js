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
const botErrors = {};

const AUTO_PAY_COINS = ['TON', 'NOT', 'DOGS', 'USDT', 'USDC', 'BNB'];

function isAutoPayCoin(cur) {
  return AUTO_PAY_COINS.includes(String(cur || '').toUpperCase());
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

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

function getPTConfig(cur) {
  const c = String(cur || '').trim().toLowerCase();
  const tonGateway = 'https://ptexchange-api.vercel.app';
  const bscGateway = 'https://pt-kappa-ten.vercel.app';
  
  if (c === 'ton') return { url: tonGateway + '/pay/ton', type: 'ton', blockchain: 'TON' };
  if (c === 'not') return { url: tonGateway + '/pay/jetton', type: 'jetton', symbol: 'NOT', blockchain: 'TON' };  if (c === 'dogs') return { url: tonGateway + '/pay/jetton', type: 'jetton', symbol: 'DOGS', blockchain: 'TON' };
  if (c === 'usdt') return { url: bscGateway + '/pay/bep20', type: 'bep20', symbol: 'USDT', tokenAddress: '0x55d398326f99059fF775485246999027B3197955', blockchain: 'BSC' };
  if (c === 'usdc') return { url: bscGateway + '/pay/bep20', type: 'bep20', symbol: 'USDC', tokenAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', blockchain: 'BSC' };
  if (c === 'bnb') return { url: bscGateway + '/pay/bnb', type: 'bnb', blockchain: 'BSC' };
  
  return null;
}

function xrAsset(cur) {
  return String(cur || '').trim().toUpperCase();
}

function normalizePayMethod(value) {
  const s = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (['autopay1', 'pt', 'ptexchange', 'btexchange', 'bt'].includes(s)) return 'AutoPay1';
  if (['autopay2', 'xrocket', 'acerocket', 'ace'].includes(s)) return 'AutoPay2';
  if (['manual', 'manualpayment'].includes(s)) return 'Manual';
  return value || 'Manual';
}

function cleanAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n.toFixed(12).replace(/\.?0+$/, '');
}

function providerError(error, fallback) {
  try {
    if (error && error.response) {
      const status = error.response.status;
      const data = error.response.data;
      if (typeof data === 'string') return 'HTTP ' + status + ': ' + data.slice(0, 300);
      if (data) {
        const detail = data.detail || data.message || data.error || data.title || data.type;
        if (detail) return 'HTTP ' + status + ': ' + String(detail).slice(0, 300);
        return 'HTTP ' + status + ': ' + JSON.stringify(data).slice(0, 300);
      }
      return 'HTTP ' + status;
    }
    if (error && error.code) return String(error.code) + ': ' + String(error.message || '').slice(0, 250);
    if (error && error.message) return String(error.message).slice(0, 300);
  } catch (e) {}
  return fallback || 'Payment provider error';
}

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
    const fresh = { balance: 0, wallet: 'Not Set', refer: null, refs: 0, captchaPassed: false, banned: false, joinedAt: Date.now(), completedTasks: [] };
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

function isAuthError(err) {
  const msg = String((err && (err.message || err.code || err.description)) || err).toLowerCase();
  return /401|403|unauthorized|bot was blocked|token invalid|deleted/i.test(msg);
}

function sanitizeDescription(text) {
  if (!text) return '';
  const cleaned = String(text).replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
  return cleaned.substring(0, 50);
}

async function sendPTPayment({ botId, apiKey, currency, wallet, amount, comment }) {
  if (!apiKey) throw new Error('AutoPay1 API key is missing.');
  const ptConfig = getPTConfig(currency);
  if (!ptConfig) throw new Error('Currency ' + currency + ' is not supported by PT Exchange');

  const payload = { api_key: apiKey, to_address: wallet, amount: parseFloat(amount) };
  if (ptConfig.type === 'ton') payload.comment = comment || 'Clur Bot withdrawal';
  else if (ptConfig.type === 'jetton') { payload.jetton_symbol = ptConfig.symbol; payload.comment = comment || 'Clur Bot withdrawal'; }
  else if (ptConfig.type === 'bep20') { payload.token_address = ptConfig.tokenAddress; payload.comment = comment || 'Clur Bot withdrawal'; }
  else if (ptConfig.type === 'bnb') payload.comment = comment || 'Clur Bot withdrawal';
  
  console.log(`[engine:${botId}] AutoPay1 request: ${currency} (${ptConfig.blockchain}) → ${wallet} (${amount})`);
  const response = await axios.post(ptConfig.url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true });
  const d = response.data || {};
  if (response.status < 200 || response.status >= 300) {    throw new Error(String(d.detail || d.message || d.error || 'HTTP ' + response.status).slice(0, 300));
  }
  const txHash = d.tx_hash || d.txHash || d.hash || d.transaction || d.transactionHash || d.tx || d.id || '';
  const success = d.success === true || d.ok === true || d.status === 'success' || d.status === 'completed' || d.status === 'paid' || !!txHash;
  if (!success) throw new Error(String(d.message || d.error || d.detail || 'PT Exchange rejected').slice(0, 300));

  return { success: true, txHash: txHash, data: d, blockchain: ptConfig.blockchain };
}

async function sendXRocketPayment({ botId, apiKey, uid, currency, amount, description }) {
  if (!apiKey) throw new Error('AutoPay2 API key is missing.');
  const asset = xrAsset(currency);
  const payload = { clientPayoutId: 'CLUR-' + botId + '-' + uid + '-' + Date.now(), target: String(uid), targetType: 'telegram_user_id', asset, amount: String(amount) };
  const sanitizedDesc = sanitizeDescription(description);
  if (sanitizedDesc) payload.description = sanitizedDesc;

  const response = await axios.post('https://pay.api.xrocket.exchange/api/v1/payouts', payload, {
    headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true
  });
  const d = response.data || {};
  if (response.status < 200 || response.status >= 300) throw new Error(String(d.detail || d.message || d.error || 'HTTP ' + response.status).slice(0, 300));

  const status = String(d.status || '').toLowerCase();
  if (status === 'finished') return { success: true, paid: true, status: 'finished', payoutId: d.payoutId || d.id, clientPayoutId: payload.clientPayoutId, data: d };
  if (status === 'pending') return { success: true, paid: false, status: 'pending', payoutId: d.payoutId || d.id, clientPayoutId: payload.clientPayoutId, data: d };
  if (status === 'failed') throw new Error(String(d.detail || d.message || d.error || 'xRocket rejected').slice(0, 300));
  throw new Error('xRocket returned unknown status: ' + (d.status || 'missing'));
}

async function stopBot(botId) {
  const info = activeBots[botId];
  if (!info) return;
  try { await info.bot.stopPolling(); } catch (e) { console.log(`[engine:${botId}] stopPolling error:`, e.message); }
  try { delete tokenOwner[info.cfg.token]; } catch (e) {}
  delete activeBots[botId];
  console.log(`[engine:${botId}] ⏹ stopped and polling terminated`);
}

async function startBot(cfgIn) {
  const cfg = Object.assign({}, cfgIn);
  const botId = cfg.id;
  
  if (activeBots[botId]) { console.log(`[engine:${botId}] Restarting existing bot...`); await stopBot(botId); }
  const prev = tokenOwner[cfg.token];
  if (prev && prev !== botId) { console.log(`[engine:${botId}] Token belongs to another bot ID (${prev}), stopping it first...`); await stopBot(prev); }

  const bot = new TelegramBot(cfg.token, { polling: true });
  activeBots[botId] = { bot, cfg };
  tokenOwner[cfg.token] = botId;
  botErrors[botId] = 0;
  let currency = cfg.currency || '';
  let pay = normalizePayMethod(cfg.payMethod || 'Manual');
  let minW = Number(cfg.minW || 0);
  let maxW = Number(cfg.maxW || 0);
  let refB = Number(cfg.refBonus || 0);
  let payout = cfg.payoutChannel || '';
  let apiKey = cfg.apiKey || '';
  let mustJoin = (cfg.mustJoin || []).slice(0, 10);
  let nonMust = (cfg.nonMust || []).slice(0, 10);
  let tasks = Array.isArray(cfg.tasks) ? cfg.tasks : [];
  let botDetect = !!cfg.botDetect;
  let name = cfg.name || 'Rewards Bot';
  let fee = Number(cfg.withdrawFee || 0);
  let taskProofChannel = cfg.taskProofChannel || ''; // ✅ NEW: Task Proof Channel

  console.log(`[engine:${botId}] ✅ STARTED (${name}) · ${currency} · ${pay} · detect:${botDetect} · fee:${fee}`);

  async function deactivate(reason) {
    console.log(`[engine:${botId}] ❌ DEACTIVATING: ${reason}`);
    await stopBot(botId);
    try { await db.collection('bots').doc(botId).update({ status: 'deactivated', deactivationReason: reason, deactivatedAt: Date.now() }); } catch (e) {}
  }

  (async function verifyStartup() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await bot.getMe(); return; } catch (err) {
        if (isAuthError(err)) return deactivate('Token invalid or deleted from BotFather');
        console.log(`[engine:${botId}] getMe attempt ${attempt}/3 failed (network): ${String(err.message || err).slice(0, 100)}`);
        await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }
    console.log(`[engine:${botId}] ⚠️ Could not verify token after 3 attempts.`);
  })();

  bot.on('polling_error', (err) => {
    const msg = String((err && err.message) || err);
    botErrors[botId] = (botErrors[botId] || 0) + 1;
    if (isAuthError(err)) deactivate('Auth error: ' + msg.slice(0, 100));
    else if (/409/.test(msg)) console.log(`[engine:${botId}] ⚠️ 409 conflict - another poller is running`);
    else if (/ETELEGRAM|network|timeout|ECONNRESET|socket hang/i.test(msg)) {
      if (botErrors[botId] % 10 === 1) console.log(`[engine:${botId}] network blip (${botErrors[botId]} total): ${msg.slice(0, 100)}`);
    } else console.log(`[engine:${botId}] polling error: ${msg.slice(0, 150)}`);
  });

  bot.on('error', (err) => {
    const msg = String(err).slice(0, 100);
    if (isAuthError(err)) deactivate('Bot error: ' + msg);
    else console.log(`[engine:${botId}] error: ${msg}`);
  });
  const safe = (fn) => async function () {
    try { await fn.apply(null, arguments); } catch (e) { console.error(`[engine:${botId}] handler crashed:`, e.message); console.error(e.stack); }
  };

  async function refreshCfg() {
    try {
      const snap = await db.collection('bots').doc(botId).get();
      if (!snap.exists) { console.log(`[engine:${botId}] Bot deleted from DB. Stopping...`); await stopBot(botId); return false; }
      const d = snap.data();
      if (d.status === 'deactivated' || d.status === 'deleted' || d.status === 'paused') { 
        console.log(`[engine:${botId}] Status changed to: ${d.status}. Stopping...`); await stopBot(botId); return false; 
      }
      currency = d.currency || currency;
      pay = normalizePayMethod(d.payMethod || pay);
      minW = Number(d.minW != null ? d.minW : minW);
      maxW = Number(d.maxW != null ? d.maxW : maxW);
      refB = Number(d.refBonus != null ? d.refBonus : refB);
      payout = d.payoutChannel || payout;
      apiKey = d.apiKey || apiKey;
      mustJoin = (d.mustJoin || []).slice(0, 10);
      nonMust = (d.nonMust || []).slice(0, 10);
      tasks = Array.isArray(d.tasks) ? d.tasks : tasks;
      botDetect = d.botDetect === true;
      name = d.name || name;
      fee = Number(d.withdrawFee != null ? d.withdrawFee : fee);
      taskProofChannel = d.taskProofChannel || taskProofChannel; // ✅ Refresh task proof channel
      return true;
    } catch (e) { console.log(`[engine:${botId}] refreshCfg error: ${e.message}`); return true; }
  }

  const menuKeyboard = () => {
    const keyboard = [[{ text: '🏦 Balance' }, { text: '🎁 Invite' }], [{ text: '📋 Tasks' }, { text: '💸 Withdraw' }]];
    if (pay === 'Manual' || pay === 'AutoPay1') keyboard.push([{ text: '👛 Wallet' }]);
    return { reply_markup: { keyboard, resize_keyboard: true }, parse_mode: 'HTML' };
  };

  async function notifyPayout(text, opts) {
    if (!payout) return;
    try { await bot.sendMessage(normchan(payout), text, opts || { parse_mode: 'HTML' }); } catch (e) {}
  }

  async function logWithdraw(uid, amount, status, wallet, txHash, feeAmount, receivedAmount, extra) {
    try {
      await db.collection('bots').doc(botId).collection('withdrawals').add(
        Object.assign({ uid: String(uid), amount, fee: feeAmount || 0, received: receivedAmount || amount, currency, status, wallet: wallet || '-', txHash: txHash || null, at: Date.now() }, extra || {})
      );
    } catch (e) {}
  }
  async function getUsername(uid) {
    try { const c = await bot.getChat(uid); return c.username ? '@' + c.username : (c.first_name || ''); } catch (e) { return ''; }
  }

  function askCaptcha(uid, key, wrong) {
    const a = Math.floor(Math.random() * 10) + 1;
    const b = Math.floor(Math.random() * 10) + 1;
    setA(key, 'captcha', { answer: a + b });
    bot.sendMessage(uid, (wrong ? '❌ Wrong answer!\n\nTry again:\n\n' : '🤖 <b>ARE YOU A ROBOT?</b>\n\nProve you are human first:\n\n') + '🧮 <b>' + a + ' + ' + b + ' = ?</b>\n\n👉 Send your answer:', { parse_mode: 'HTML' }).catch(() => {});
  }

  async function showChannels(uid) {
    const allChannels = [];
    allChannels.push({ text: '💼 Official', url: OFFICIAL_URL });
    
    let channelNum = 1;
    for (const ch of mustJoin) { 
      allChannels.push({ text: `📢 Ch ${channelNum}`, url: chanUrl(ch) }); 
      channelNum++; 
    }
    for (const ch of nonMust) { 
      allChannels.push({ text: `📢 Ch ${channelNum}`, url: chanUrl(ch) }); 
      channelNum++; 
    }
    if (payout) {
      allChannels.push({ text: '💰 Payment', url: chanUrl(payout) });
    }

    const rows = [];
    for (let i = 0; i < allChannels.length; i += 2) {
      rows.push(allChannels.slice(i, i + 2));
    }
    rows.push([{ text: '✅ START', callback_data: 'continue' }]);

    const welcomeMsg = '🎉 <b>Welcome to ' + esc(name) + '!</b>\n\nHere\'s how it works:\n• Invite friends using your unique link\n• Earn ' + esc(currency) + ' for every friend who joins\n• Withdraw your earnings anytime\n\n👉 <i>First, join our channels:</i>\n\n🤖 Powered By: <a href="https://t.me/' + POWERED_BY + '">@' + POWERED_BY + '</a>';
    
    await bot.sendMessage(uid, welcomeMsg, { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
  }

  bot.onText(/\/start(?:\s+(\d+))?/, safe(async (msg, match) => {
    const uid = msg.chat.id;
    const key = botId + ':' + uid;
    delete awaiting[key];
    const alive = await refreshCfg();
    if (!alive) return;
    const got = await getUser(botId, uid);
    if (got.data.banned) return bot.sendMessage(uid, '🚫 <b>You are banned from this bot.</b>', { parse_mode: 'HTML' }).catch(() => {});
    if (got.isNew) await db.collection('bots').doc(botId).update({ users: FieldValue.increment(1) }).catch(() => {});
    await db.collection('bots').doc(botId).update({ lastActive: Date.now() }).catch(() => {});
    const refId = match && match[1] ? match[1] : null;
    if (refId && refId !== String(uid) && !got.data.refer) {
      await got.ref.update({ refer: refId }).catch(() => {});
      await db.collection('bots').doc(botId).collection('users').doc(refId).update({ balance: FieldValue.increment(refB), refs: FieldValue.increment(1) }).catch(() => {});
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
    const hasPhoto = msg.photo && msg.photo.length > 0;
    
    if (!txt && !hasPhoto) return;
    if (txt.startsWith('/') && !hasPhoto) { delete awaiting[key]; return; }
    
    const got = await getUser(botId, uid);
    if (got.data.banned) return bot.sendMessage(uid, '🚫 <b>You are banned.</b>', { parse_mode: 'HTML' }).catch(() => {});

    const st = getA(key);
    if (st) {
      delete awaiting[key];
      if (st.type === 'captcha') {
        if (parseInt(txt, 10) === st.answer) {
          await got.ref.update({ captchaPassed: true });
          bot.sendMessage(uid, '✅ <b>Human verified!</b>', { parse_mode: 'HTML' }).catch(() => {});
          return bot.sendMessage(uid, '🏡 <b>' + esc(name) + ' Menu</b>\n\nTap an option below:', menuKeyboard()).catch(() => {});
        }
        return askCaptcha(uid, key, true);
      }
      if (st.type === 'wallet') {
        await got.ref.update({ wallet: txt });
        return bot.sendMessage(uid, '✅ <b>Wallet saved</b>\n\n👛 <code>' + esc(txt) + '</code>', { parse_mode: 'HTML' }).catch(() => {});
      }
      if (st.type === 'withdraw') return handleWithdrawAmount(uid, txt, got);
      if (st.type === 'proof') return saveProof(uid, msg, st.task, st.reward);
    }

    if (txt === '🏦 Balance') return handleBalance(uid, got);
    if (txt === '🎁 Invite') return handleInvite(uid, got);
    if (txt === '📋 Tasks') return handleTasks(uid);
    if (txt === '👛 Wallet' && (pay === 'Manual' || pay === 'AutoPay1')) {
      setA(key, 'wallet');
      return bot.sendMessage(uid, '👛 Current wallet:\n<code>' + esc(got.data.wallet) + '</code>\n\n📝 Send your new wallet address:', { parse_mode: 'HTML' }).catch(() => {});
    }    if (txt === '💸 Withdraw') {
      if (!minW || !maxW || !payout) return bot.sendMessage(uid, '⚠️ Bot owner has not finished setup yet. Try later.').catch(() => {});
      if ((pay === 'Manual' || pay === 'AutoPay1') && (!got.data.wallet || got.data.wallet === 'Not Set')) {
        return bot.sendMessage(uid, '⚠️ Set your wallet first: tap <b>👛 Wallet</b>', { parse_mode: 'HTML' }).catch(() => {});
      }
      setA(key, 'withdraw');
      return bot.sendMessage(uid, '💸 <b>WITHDRAW</b>\n\n💰 Enter amount (' + esc(currency) + ')\n⬇️ Min: ' + minW + '  ·  ⬆️ Max: ' + maxW + (fee > 0 ? '\n💳 Fee: ' + fee + ' ' + esc(currency) : '') + '\n\n<i>Want more? Tap Earn More below:</i>', { reply_markup: { inline_keyboard: [[{ text: '🎯 Earn More', callback_data: 'earnmore' }]] }, parse_mode: 'HTML' }).catch(() => {});
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
        try { m = await bot.getChatMember(chan, uid); } catch (e) {
          return bot.answerCallbackQuery(cq.id, { text: '⚠️ Bot is not admin in ' + ch + ' — contact the owner.', show_alert: true }).catch(() => {});
        }
        if (m.status === 'left' || m.status === 'kicked') {
          return bot.answerCallbackQuery(cq.id, { text: '❌ Please join ' + ch + ' first!', show_alert: true }).catch(() => {});
        }
      }
      await bot.answerCallbackQuery(cq.id, { text: '✅ Channels verified!' }).catch(() => {});
      if (botDetect) {
        const got = await getUser(botId, uid);
        if (!got.data.captchaPassed) return askCaptcha(uid, key, false);
      }
      return bot.sendMessage(uid, '🏡 <b>' + esc(name) + ' Menu</b>\n\nTap an option below:', menuKeyboard()).catch(() => {});
    }

    if (cq.data === 'earnmore') {
      const me = await bot.getMe();
      const got = await getUser(botId, uid);
      const completed = Array.isArray(got.data.completedTasks) ? got.data.completedTasks : [];
      const rows = taskRows(completed);
      rows.push([{ text: '🎁 Invite Friends — earn ' + refB + ' ' + currency, url: 'https://t.me/' + me.username + '?start=' + uid }]);
      return bot.sendMessage(uid, '<b>🎯 EARN MORE ' + esc(currency) + '</b>\n\n━━━━━━━━━━━━━━\n\n1️⃣ <b>Invite friends</b> — earn ' + refB + ' ' + esc(currency) + ' per referral\n<code>https://t.me/' + me.username + '?start=' + uid + '</code>\n\n2️⃣ <b>Complete tasks</b> — tap a task below:\n\n━━━━━━━━━━━━━━', { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' }).catch(() => {});
    }

    if (cq.data && cq.data.indexOf('task_completed_') === 0) {
      return bot.answerCallbackQuery(cq.id, { text: '✅ You have already completed or submitted proof for this task!', show_alert: true }).catch(() => {});
    }

    if (cq.data && cq.data.indexOf('task_') === 0) {
      const idx = parseInt(cq.data.split('_')[1], 10);
      const t = tasks[idx];      if (!t) return;
      setA(key, 'proof', { task: t.n, reward: Number(t.reward || 0) });
      return bot.sendMessage(uid, '📋 <b>' + esc(t.n) + '</b>\n\n' + (t.reward ? '🎁 Prize: <b>' + t.reward + ' ' + esc(currency) + '</b>\n\n' : '') + '1️⃣ Click "🔗 Open Task" to complete it.\n2️⃣ Click "📸 Submit Proof" and send your screenshot or text.', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔗 Open Task', url: t.l }], [{ text: '📸 Submit Proof', callback_data: 'confirm_proof_' + idx }]] } }).catch(() => {});
    }

    if (cq.data && cq.data.indexOf('confirm_proof_') === 0) {
      const idx = parseInt(cq.data.split('_')[2], 10);
      const t = tasks[idx];
      if (!t) return;
      setA(key, 'proof', { task: t.n, reward: Number(t.reward || 0) });
      return bot.sendMessage(uid, '📸 <b>Ready!</b>\n\nPlease send your proof now.\n<i>(You can send a photo/screenshot or a text message)</i>', { parse_mode: 'HTML' }).catch(() => {});
    }

    // ✅ SECURITY CHECK: Only channel admins can approve/decline task proofs
    if (cq.data && (cq.data.startsWith('ap_prf_') || cq.data.startsWith('dec_prf_'))) {
      const isApprove = cq.data.startsWith('ap_prf_');
      const parts = cq.data.split('_');
      const proofUid = parts[2];
      const reward = parseFloat(parts[3]) || 0;
      
      // Check if the person clicking is an admin or creator of the channel
      const chatId = cq.message.chat.id;
      const clickerId = cq.from.id;
      
      try {
        const member = await bot.getChatMember(chatId, clickerId);
        if (member.status !== 'creator' && member.status !== 'administrator') {
          return bot.answerCallbackQuery(cq.id, { 
            text: '⚠️ Only channel admins can approve/decline tasks!', 
            show_alert: true 
          });
        }
      } catch (e) {
        // If it's a private chat (fallback), we allow it (assuming the owner is checking their DMs)
      }

      const msgText = cq.message.text || cq.message.caption || '';
      const taskMatch = msgText.match(/📋 Task:\s*(.+)/);
      const taskName = taskMatch ? taskMatch[1].trim().split('\n')[0] : 'Task';

      const userRef = db.collection('bots').doc(botId).collection('users').doc(proofUid);
      
      if (isApprove) {
        await userRef.update({ 
          balance: FieldValue.increment(reward),
          completedTasks: FieldValue.arrayUnion(taskName)
        }).catch(() => {});
        
        bot.sendMessage(proofUid, `✅ <b>APPROVED!</b>\n\n🎁 You earned <b>${reward} ${esc(currency)}</b> for: ${esc(taskName)}`, { parse_mode: 'HTML' }).catch(() => {});
        await bot.editMessageText(`✅ <b>APPROVED</b>\n\n👤 User: <code>${proofUid}</code>\n📋 Task: ${esc(taskName)}\n💰 Reward: ${reward}`, { chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: 'HTML' });      } else {
        await userRef.update({ 
          completedTasks: FieldValue.arrayUnion(taskName)
        }).catch(() => {});
        
        bot.sendMessage(proofUid, `❌ <b>Your proof for "${esc(taskName)}" was declined.</b>`, { parse_mode: 'HTML' }).catch(() => {});
        await bot.editMessageText(`❌ <b>DECLINED</b>\n\n👤 User: <code>${proofUid}</code>\n📋 Task: ${esc(taskName)}`, { chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: 'HTML' });
      }
    }
  }));

  // ✅ UPDATED: Send proof to Task Proof Channel (with Payout channel as fallback)
  async function saveProof(uid, msg, taskName, reward) {
    try {
      const hasPhoto = msg.photo && msg.photo.length > 0;
      const primaryTarget = taskProofChannel;
      const fallbackTarget = payout;
      
      const caption = `🧾 <b>NEW TASK PROOF</b>\n\n📋 Task: ${esc(taskName)}\n🎁 Prize: ${reward} ${esc(currency)}\n👤 User ID: <code>${uid}</code>\n📝 ${esc(msg.text || '(photo sent)')}`;
      const btns = { 
        reply_markup: { 
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `ap_prf_${uid}_${reward}` }, 
            { text: '❌ Decline', callback_data: `dec_prf_${uid}_${reward}` }
          ]] 
        }, 
        parse_mode: 'HTML' 
      };

      const sendProof = async (targetId, isFallback) => {
        if (!targetId) throw new Error('No target ID provided');
        const finalCaption = isFallback ? caption + `\n\n⚠️ (Sent to fallback: ${targetId})` : caption;
        if (hasPhoto) {
          await bot.sendPhoto(targetId, msg.photo[msg.photo.length - 1].file_id, { caption: finalCaption, ...btns });
        } else {
          await bot.sendMessage(targetId, finalCaption, btns);
        }
      };

      try {
        await sendProof(primaryTarget, false);
        bot.sendMessage(uid, '✅ Proof sent to task channel for review!', { parse_mode: 'HTML' }).catch(() => {});
      } catch (e) {
        console.warn(`[engine:${botId}] saveProof to primary target (${primaryTarget}) failed: ${e.message}. Trying fallback...`);
        if (fallbackTarget && fallbackTarget !== primaryTarget) {
          try {
            await sendProof(fallbackTarget, true);
            bot.sendMessage(uid, '✅ Proof sent to payout channel (fallback) for review!', { parse_mode: 'HTML' }).catch(() => {});
          } catch (e2) {
            throw new Error(`Both primary and fallback failed.`);          }
        } else {
          throw e;
        }
      }
    } catch (e) {
      console.error(`[engine:${botId}] saveProof completely failed:`, e.message);
      bot.sendMessage(uid, '❌ Failed to send proof. Please ensure the bot is an admin in the Task Proof Channel.', { parse_mode: 'HTML' }).catch(() => {});
    }
  }

  async function handleBalance(uid, got) {
    await bot.sendMessage(uid, '<b>🏦 MY ACCOUNT</b>\n\n━━━━━━━━━━━━━━\n\n🏦 Balance: <b>' + Number(got.data.balance || 0).toFixed(2) + ' ' + esc(currency) + '</b>\n\n👛 Wallet: <code>' + esc(got.data.wallet) + '</code>\n\n🎁 Referrals: ' + (got.data.refs || 0) + '\n\n💎 Per referral: <b>' + refB + ' ' + esc(currency) + '</b>' + (fee > 0 ? '\n\n💳 Withdraw fee: <b>' + fee + ' ' + esc(currency) + '</b>' : '') + '\n\n━━━━━━━━━━━━━━\n🤖 Powered By: <a href="https://t.me/' + POWERED_BY + '">@' + POWERED_BY + '</a>', { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
  }

  async function handleInvite(uid, got) {
    const me = await bot.getMe();
    await bot.sendMessage(uid, '<b>🎁 INVITE & EARN</b>\n\n━━━━━━━━━━━━━━\n\n💎 Per referral: <b>' + refB + ' ' + esc(currency) + '</b>\n\n🎁 Your referrals: ' + (got.data.refs || 0) + '\n\n━━━━━━━━━━━━━━\n\nYour link:\n<code>https://t.me/' + me.username + '?start=' + uid + '</code>', { parse_mode: 'HTML' }).catch(() => {});
  }

  function taskRows(completed = []) {
    return tasks.map((t, i) => {
      const isCompleted = completed.includes(t.n);
      return [{ text: (isCompleted ? '✅ ' : '') + (i + 1) + '. ' + t.n + (t.reward ? ' (+' + t.reward + ')' : ''), callback_data: isCompleted ? 'task_completed_' + i : 'task_' + i }];
    });
  }

  async function handleTasks(uid) {
    await refreshCfg();
    const got = await getUser(botId, uid);
    const completed = Array.isArray(got.data.completedTasks) ? got.data.completedTasks : [];
    if (!Array.isArray(tasks) || tasks.length === 0) return bot.sendMessage(uid, '📋 <b>No tasks available yet.</b>', { parse_mode: 'HTML' }).catch(() => {});
    const rows = taskRows(completed);
    await bot.sendMessage(uid, '📋 <b>TASKS</b>\n\nTap a task to complete it:', { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' }).catch(() => {});
  }

  function receipt(status, amount, feeAmount, receivedAmount, wallet, txHash, newBalance, paid) {
    let out = '';
    out += (paid ? '✅ <b>Withdrawal Paid Successfully!</b>' : '✅ <b>Withdrawal Request Submitted!</b>') + '\n\n';
    out += '💰 Requested: <b>' + amount + ' ' + esc(currency) + '</b>\n\n';
    if (feeAmount > 0) out += '💳 Fee: <b>' + feeAmount + ' ' + esc(currency) + '</b>\n\n';
    out += (paid ? '📤 You Received: <b>' + receivedAmount + ' ' + esc(currency) + '</b>\n\n' : '📤 You will receive: <b>' + receivedAmount + ' ' + esc(currency) + '</b>\n\n');
    out += '📦 Status: <b>' + status + '</b>\n\n';
    if (pay === 'AutoPay2') out += '📬 Delivery: <b>Your Telegram account</b> (xRocket)\n\n';
    else out += '🏦 Wallet:\n<code>' + esc(wallet) + '</code>\n\n';
    if (txHash) out += '💳 Transaction:\n<code>' + esc(txHash) + '</code>\n\n';
    out += '💰 Remaining Balance:\n<b>' + newBalance.toFixed(2) + ' ' + esc(currency) + '</b>';
    if (!paid) out += '\n\n<i>⏳ Owner will process your payment soon.</i>';
    return out;
  }
  async function handleWithdrawAmount(uid, raw, got) {
    const amount = parseFloat(raw);
    if (isNaN(amount)) return bot.sendMessage(uid, '❌ Numbers only.').catch(() => {});
    if (amount < minW || amount > maxW) return bot.sendMessage(uid, '❌ Between ' + minW + ' and ' + maxW + ' ' + esc(currency)).catch(() => {});
    if (Number(got.data.balance || 0) < amount) return bot.sendMessage(uid, '❌ Insufficient balance (' + Number(got.data.balance || 0).toFixed(2) + ' ' + esc(currency) + ')').catch(() => {});

    const feeAmount = fee;
    const receivedAmount = Math.max(0, amount - feeAmount);
    const cleanReceived = cleanAmount(receivedAmount);
    if (!cleanReceived) return bot.sendMessage(uid, '❌ Invalid withdrawal amount after fee.').catch(() => {});

    const walletLine = pay === 'AutoPay2' ? '📬 Delivery: <b>Your Telegram account</b> (xRocket)' : '🏦 Wallet:\n<code>' + esc(got.data.wallet) + '</code>';
    await bot.sendMessage(uid, '⏳ <b>Processing withdrawal...</b>\n\n💰 Requested: <b>' + amount + ' ' + esc(currency) + '</b>\n\n' + (feeAmount > 0 ? '💳 Fee: <b>' + feeAmount + ' ' + esc(currency) + '</b>\n\n' : '') + '📤 You will receive: <b>' + receivedAmount + ' ' + esc(currency) + '</b>\n\n' + walletLine, { parse_mode: 'HTML' }).catch(() => {});

    if (pay === 'AutoPay1') {
      if (!isAutoPayCoin(currency)) return bot.sendMessage(uid, '❌ <b>AutoPay1 does not support ' + esc(currency) + '</b>\n\nOnly these coins support auto payment:\n' + AUTO_PAY_COINS.join(', ') + '\n\nPlease switch to Manual payment or use a supported coin.', { parse_mode: 'HTML' }).catch(() => {});
      let txHash = '';
      try {
        const result = await sendPTPayment({ botId, apiKey, currency, wallet: got.data.wallet, amount: cleanReceived, comment: name });
        txHash = result.txHash || '';
        await got.ref.update({ balance: FieldValue.increment(-amount) });
        await logWithdraw(uid, amount, 'paid', got.data.wallet, txHash, feeAmount, receivedAmount, { provider: 'PT', providerStatus: 'finished' });
        await notifyPayout('✅ <b>AutoPay1 PAID</b>\n\n👤 User ID: <code>' + uid + '</code>\n\n💰 ' + amount + ' ' + esc(currency) + ' (received ' + receivedAmount + ')\n\n👛 ' + esc(got.data.wallet) + (txHash ? '\n\n💳 TX: <code>' + esc(txHash) + '</code>' : ''));
        const newBalance = Number(got.data.balance || 0) - amount;
        return bot.sendMessage(uid, receipt('PAID', amount, feeAmount, receivedAmount, got.data.wallet, txHash, newBalance, true), { parse_mode: 'HTML' }).catch(() => {});
      } catch (e) {
        const err = providerError(e, 'PT payment failed');
        console.log(`[engine:${botId}] ❌ AutoPay1 ERROR: ${err}`);
        await logWithdraw(uid, amount, 'failed', got.data.wallet, null, feeAmount, receivedAmount, { provider: 'PT', error: err });
        await notifyPayout('❌ <b>AutoPay1 FAILED</b>\n\n👤 User ID: <code>' + uid + '</code>\n\n💰 ' + amount + ' ' + esc(currency) + '\n\n👛 ' + esc(got.data.wallet) + '\n\n⚠️ ' + esc(err).slice(0, 300));
        return bot.sendMessage(uid, '❌ <b>Payment failed</b>\n\n⚠️ ' + esc(err).slice(0, 250) + '\n\n💰 Balance NOT deducted.', { parse_mode: 'HTML' }).catch(() => {});
      }
    }

    if (pay === 'AutoPay2') {
      if (!isAutoPayCoin(currency)) return bot.sendMessage(uid, '❌ <b>AutoPay2 does not support ' + esc(currency) + '</b>\n\nOnly these coins support auto payment:\n' + AUTO_PAY_COINS.join(', ') + '\n\nPlease switch to Manual payment or use a supported coin.', { parse_mode: 'HTML' }).catch(() => {});
      let payoutId = '';
      try {
        const result = await sendXRocketPayment({ botId, apiKey, uid, currency, amount: cleanReceived, description: name });
        payoutId = result.payoutId || '';
        if (!result.paid) {
          await logWithdraw(uid, amount, 'pending', 'telegram', payoutId, feeAmount, receivedAmount, { provider: 'xRocket', providerStatus: result.status, clientPayoutId: result.clientPayoutId });
          await notifyPayout('⏳ <b>AutoPay2 PENDING</b>\n\n👤 User ID: <code>' + uid + '</code>\n\n💰 ' + amount + ' ' + esc(currency) + '\n\n📦 Status: ' + result.status);
          return bot.sendMessage(uid, '⏳ <b>Payment submitted</b>\n\n💰 Requested: <b>' + amount + ' ' + esc(currency) + '</b>\n\n📤 You will receive: <b>' + receivedAmount + ' ' + esc(currency) + '</b>\n\n📦 Status: <b>PENDING</b>\n\n💰 <b>Balance NOT deducted yet.</b>', { parse_mode: 'HTML' }).catch(() => {});
        }
        await got.ref.update({ balance: FieldValue.increment(-amount) });
        await logWithdraw(uid, amount, 'paid', 'telegram', payoutId, feeAmount, receivedAmount, { provider: 'xRocket', providerStatus: 'finished', clientPayoutId: result.clientPayoutId });
        await notifyPayout('✅ <b>AutoPay2 PAID</b>\n\n👤 User ID: <code>' + uid + '</code>\n\n💰 ' + amount + ' ' + esc(currency) + ' (received ' + receivedAmount + ')' + (payoutId ? '\n\n💳 Payout ID: <code>' + esc(payoutId) + '</code>' : ''));
        const newBalance = Number(got.data.balance || 0) - amount;        return bot.sendMessage(uid, receipt('PAID', amount, feeAmount, receivedAmount, 'telegram', payoutId, newBalance, true), { parse_mode: 'HTML' }).catch(() => {});
      } catch (e) {
        const err = providerError(e, 'xRocket payment failed');
        console.log(`[engine:${botId}] ❌ AutoPay2 ERROR: ${err}`);
        await logWithdraw(uid, amount, 'failed', 'telegram', null, feeAmount, receivedAmount, { provider: 'xRocket', error: err });
        await notifyPayout('❌ <b>AutoPay2 FAILED</b>\n\n👤 User ID: <code>' + uid + '</code>\n\n💰 ' + amount + ' ' + esc(currency) + '\n\n⚠️ ' + esc(err).slice(0, 300));
        return bot.sendMessage(uid, '❌ <b>Payment failed</b>\n\n⚠️ ' + esc(err).slice(0, 250) + '\n\n💰 Balance NOT deducted.', { parse_mode: 'HTML' }).catch(() => {});
      }
    }

    try {
      await got.ref.update({ balance: FieldValue.increment(-amount) });
      await logWithdraw(uid, amount, 'pending', got.data.wallet, null, feeAmount, receivedAmount, { provider: 'Manual' });
      const uname = await getUsername(uid);
      await notifyPayout('📥 <b>NEW WITHDRAWAL REQUEST</b>\n\n🤖 Bot: ' + esc(name) + '\n\n👤 User ID: <code>' + uid + '</code>\n\n🧑 User: ' + esc(uname || 'no username') + '\n\n💰 Requested: <b>' + amount + ' ' + esc(currency) + '</b>\n\n' + (feeAmount > 0 ? '💳 Fee: ' + feeAmount + ' ' + esc(currency) + '\n\n' : '') + '📤 Pay this user: <b>' + receivedAmount + ' ' + esc(currency) + '</b>\n\n👛 Wallet: <code>' + esc(got.data.wallet) + '</code>\n\n📦 Status: <b>PENDING</b>\n\n🕒 ' + new Date().toLocaleString());
      const newBalance = Number(got.data.balance || 0) - amount;
      bot.sendMessage(uid, receipt('PENDING', amount, feeAmount, receivedAmount, got.data.wallet, '', newBalance, false), { parse_mode: 'HTML' }).catch(() => {});
    } catch (e) {
      console.log(`[engine:${botId}] ❌ Manual withdraw error: ${e.message}`);
      bot.sendMessage(uid, '❌ Error processing withdrawal. Try again.', { parse_mode: 'HTML' }).catch(() => {});
    }
  }
}

async function restartBot(botId) {
  await stopBot(botId);
  try {
    const snap = await db.collection('bots').doc(botId).get();
    if (!snap.exists) return;
    const cfg = Object.assign({ id: snap.id }, snap.data());
    if (cfg.status === 'active') await startBot(cfg);
  } catch (e) { console.error(`[engine:${botId}] ❌ restart error: ${e.message}`); }
}

async function loadAllBots() {
  try {
    const snap = await db.collection('bots').where('status', '==', 'active').get();
    console.log(`[engine] 🔄 loading ${snap.size} bots sequentially...`);
    let i = 0;
    for (const d of snap.docs) {
      try { 
        await startBot(Object.assign({ id: d.id }, d.data())); 
        console.log(`[engine] ✅ Loaded bot ${i + 1}/${snap.size}: ${d.data().name}`);
      } catch (e) { console.error(`[engine:${d.id}] ❌ start fail:`, e.message); }
      i++;
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 800));
    }
    console.log('[engine] ✅ all bots live');
  } catch (e) { console.error('[engine] ❌ loadAllBots error:', e.message); }
}
setInterval(async () => {
  try {
    const snap = await db.collection('bots').where('status', '==', 'active').get();
    let healed = 0;
    for (const doc of snap.docs) {
      if (!activeBots[doc.id]) {
        console.log(`[engine:heal] 🩹 restarting missing active bot ${doc.id}`);
        await startBot(Object.assign({ id: doc.id }, doc.data()));
        healed++;
        await new Promise(r => setTimeout(r, 800));
      }
    }
    if (healed > 0) console.log(`[engine:heal] ✅ healed ${healed} bots`);
  } catch (e) { console.error('[engine:heal] ❌ sweep error:', e.message); }
}, 180000);

module.exports = { startBot, stopBot, restartBot, loadAllBots, activeBots, sendTo };

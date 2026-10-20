require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');

const { db, admin } = require('./firebase');
const engine = require('./utils/botEngine');

process.on('unhandledRejection', (reason) => { console.error('[guard] unhandledRejection:', reason); });
process.on('uncaughtException', (err) => { console.error('[guard] uncaughtException:', err); });

const app = express();
app.use(cors({ origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key', 'x-backend-secret'] }));
app.use(express.json({ limit: '10mb' }));

const SERVER_VERSION = 'v2026.10.08-manual-fix';
const AUTO_PAY_COINS = ['TON', 'NOT', 'DOGS', 'USDT', 'USDC', 'BNB'];

function cleanString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeCurrency(currency) {
  return cleanString(currency).toUpperCase();
}

function isAutoPayCoin(currency) {
  return AUTO_PAY_COINS.includes(normalizeCurrency(currency));
}

function normalizeProvider(provider) {
  const p = cleanString(provider).toLowerCase();
  if (['autopay1', 'ptexchange', 'pt', 'auto pay 1'].includes(p)) return 'AutoPay1';
  if (['autopay2', 'xrocket', 'xrocket pay', 'auto pay 2'].includes(p)) return 'AutoPay2';
  if (['manual', 'manual payment'].includes(p)) return 'Manual';
  return p;
}

function safeAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}

function makeClientId(prefix, botId, uid) {            return prefix + '_' + String(botId || 'bot') + '_' + String(uid || 'user') + '_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

async function notifyOwner(text) {
  if (!process.env.ADMIN_TELEGRAM_BOT_TOKEN || !process.env.ADMIN_CHAT_ID) return;
  try {
    await axios.post('https://api.telegram.org/bot' + process.env.ADMIN_TELEGRAM_BOT_TOKEN + '/sendMessage',
      { chat_id: process.env.ADMIN_CHAT_ID, text: text, parse_mode: 'HTML' }, { timeout: 5000 });
  } catch (e) {}
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', version: SERVER_VERSION, botsOnline: Object.keys(engine.activeBots || {}).length });
});

app.get('/ping', (req, res) => {
  res.json({ pong: true, version: SERVER_VERSION, time: new Date().toISOString() });
});

app.get('/api/payment-health', (req, res) => {
  res.json({
    ok: true,
    version: SERVER_VERSION,
    supportedCoins: AUTO_PAY_COINS,
    providers: { AutoPay1: 'PT Exchange', AutoPay2: 'xRocket', Manual: 'manual' }
  });
});

app.post('/api/verify-token', async (req, res) => {
  try {
    const token = req.body.token;
    if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
    const r = await axios.get('https://api.telegram.org/bot' + token + '/getMe', { timeout: 5000 });
    if (r.data.ok) return res.json({ ok: true, username: r.data.result.username, firstName: r.data.result.first_name, id: r.data.result.id });
    res.status(400).json({ ok: false, error: 'Invalid token' });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'Failed to verify' });
  }
});

app.post('/api/check-channel-admin', async (req, res) => {
  try {
    const token = req.body.token;
    const channel = req.body.channel;
    if (!token || !channel) return res.json({ ok: true, isAdmin: false, status: 'missing' });
    const me = await axios.get('https://api.telegram.org/bot' + token + '/getMe', { timeout: 5000 });
    const m = await axios.get('https://api.telegram.org/bot' + token + '/getChatMember', { params: { chat_id: channel, user_id: me.data.result.id }, timeout: 5000 });
    const st = m.data.result.status;
    res.json({ ok: true, isAdmin: st === 'administrator' || st === 'creator', status: st });  
  } catch (e) {                    res.json({ ok: true, isAdmin: false, status: 'error' });
  }
});

app.post('/api/create-bot', async (req, res) => {
  try {
    const data = req.body;
    if (!data.token || !data.name || !data.ownerId) return res.status(400).json({ error: 'Missing fields' });
    const v = await axios.get('https://api.telegram.org/bot' + data.token + '/getMe', { timeout: 5000 });
    if (!v.data.ok) return res.status(400).json({ error: 'Token invalid' });
    
    const mj = (data.mustJoin || []).slice(0, 10);
    const nm = (data.nonMust || []).slice(0, Math.max(0, 10 - mj.length));
    const parsedTasks = (data.tasks || []).map(function(t) { return { n: t.n, l: t.l, reward: Number(t.reward || 0) }; });
    
    const botData = {
      ownerId: data.ownerId, coAdmins: [], type: data.type || 'bot',
      name: data.name, username: v.data.result.username, token: data.token,
      currency: data.currency, payMethod: data.payMethod, apiKey: data.apiKey || '',
      payoutChannel: data.payoutChannel || '', 
      taskProofChannel: data.taskProofChannel || '', 
      minW: parseFloat(data.minW) || 0.01,
      maxW: parseFloat(data.maxW) || 100, refBonus: parseFloat(data.refBonus) || 0.01,
      withdrawFee: parseFloat(data.withdrawFee) || 0, mustJoin: mj, nonMust: nm,
      tasks: parsedTasks, botDetect: data.botDetect === true,
      officialChannel: 'https://t.me/DAILYUUPA', users: 0, status: 'active',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    const ref = await db.collection('bots').add(botData);
    engine.startBot(Object.assign({ id: ref.id }, botData));
    res.json({ success: true, botId: ref.id, username: v.data.result.username });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/user/:uid/bots', async (req, res) => {
  try {
    const snap = await db.collection('bots').where('ownerId', '==', req.params.uid).get();
    const bots = [];
    snap.forEach(function(d) { bots.push(Object.assign({ id: d.id }, d.data())); });
    res.json({ success: true, bots: bots });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bot/:id', async (req, res) => {  
  try {
    const doc = await db.collection('bots').doc(req.params.id).get();        if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const b = doc.data();            
    delete b.token; delete b.apiKey;
    
    b.withdrawFee = Number(b.withdrawFee || 0);
    b.botDetect = !!b.botDetect;
    
    let userList = [], withdrawals = [], proofs = [];
    try {
      const u = await db.collection('bots').doc(req.params.id).collection('users').limit(300).get();
      userList = u.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
      const w = await db.collection('bots').doc(req.params.id).collection('withdrawals').limit(100).get();
      withdrawals = w.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
      const p = await db.collection('bots').doc(req.params.id).collection('proofs').where('status', '==', 'pending').limit(100).get();
      proofs = p.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (e) {}
    const created = b.createdAt ? new Date(b.createdAt).getTime() : Date.now();
    b.hours = Math.max(0, Math.floor((Date.now() - created) / 3600000));
    b.online = !!engine.activeBots[req.params.id];
    b.userList = userList; b.withdrawals = withdrawals; b.proofs = proofs;
    res.json({ success: true, bot: Object.assign({ id: doc.id }, b) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/bot/:id/settings', async (req, res) => {
  try {
    const body = req.body;
    const u = { updatedAt: new Date().toISOString() };
    if (body.minW !== undefined) u.minW = parseFloat(body.minW);
    if (body.maxW !== undefined) u.maxW = parseFloat(body.maxW);
    if (body.refBonus !== undefined) u.refBonus = parseFloat(body.refBonus);
    if (body.withdrawFee !== undefined) u.withdrawFee = parseFloat(body.withdrawFee) || 0;
    
    if (body.payoutChannel !== undefined) u.payoutChannel = body.payoutChannel;
    if (body.taskProofChannel !== undefined) u.taskProofChannel = body.taskProofChannel;
    
    if (body.mustJoin !== undefined) {
      u.mustJoin = typeof body.mustJoin === 'string' ? body.mustJoin.split(',').map(function(s) { return s.trim(); }).filter(Boolean).slice(0, 10) : body.mustJoin;
    }
    if (body.nonMust !== undefined) {
      u.nonMust = typeof body.nonMust === 'string' ? body.nonMust.split(',').map(function(s) { return s.trim(); }).filter(Boolean).slice(0, 10) : body.nonMust;
    }
    if (body.tasks !== undefined) {
      u.tasks = (body.tasks || []).map(function(t) { return { n: t.n, l: t.l, reward: Number(t.reward || 0) }; });    
    }
    if (body.botDetect !== undefined) u.botDetect = body.botDetect === true;
    if (body.coAdmins !== undefined) {      
      u.coAdmins = typeof body.coAdmins === 'string' ? body.coAdmins.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : body.coAdmins;    }
    await db.collection('bots').doc(req.params.id).update(u);
    await engine.restartBot(req.params.id);
    
    const after = await db.collection('bots').doc(req.params.id).get();
    const d = after.exists ? after.data() : {};    
    res.json({      
      success: true,
      saved: {
        withdrawFee: Number(d.withdrawFee || 0),
        botDetect: !!d.botDetect,
        minW: d.minW,
        maxW: d.maxW,
        refBonus: d.refBonus,
        payoutChannel: d.payoutChannel || '', 
        taskProofChannel: d.taskProofChannel || ''
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/bot/:id', async (req, res) => {  
  try {
    engine.stopBot(req.params.id);
    const subs = ['users', 'withdrawals', 'proofs'];
    for (const sub of subs) {
      const snap = await db.collection('bots').doc(req.params.id).collection(sub).limit(500).get();
      const batch = db.batch();
      snap.docs.forEach(function(d) { batch.delete(d.ref); });
      await batch.commit();
    }
    await db.collection('bots').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bot/:id/broadcast', async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.status(400).json({ error: 'Message required' });
    const doc = await db.collection('bots').doc(req.params.id).get();    
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const token = doc.data().token;
    const u = await db.collection('bots').doc(req.params.id).collection('users').limit(5000).get();
    let sent = 0, failed = 0;    
    for (const x of u.docs) {      try {
        await axios.post('https://api.telegram.org/bot' + token + '/sendMessage', { chat_id: x.id, text: message, parse_mode: 'HTML' }, { timeout: 5000 });
        sent++;
      } catch (e) { failed++; }
      await new Promise(function(r) { setTimeout(r, 35); });
    }    
    res.json({ success: true, sent: sent, failed: failed });
  } catch (e) {    
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/broadcast', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (!key || key !== process.env.OWNER_KEY) return res.status(403).json({ error: 'Invalid owner key' });
    const message = req.body.message;
    if (!message) return res.status(400).json({ error: 'Message required' });
    const bots = await db.collection('bots').where('status', '==', 'active').get();
    let sent = 0, failed = 0;
    for (const b of bots.docs) {
      const token = b.data().token;
      const u = await db.collection('bots').doc(b.id).collection('users').limit(5000).get();
      for (const x of u.docs) {        
        try {
          await axios.post('https://api.telegram.org/bot' + token + '/sendMessage', { chat_id: x.id, text: message, parse_mode: 'HTML' }, { timeout: 5000 });
          sent++;
        } catch (e) { failed++; }
        await new Promise(function(r) { setTimeout(r, 35); });
      }
    }
    res.json({ success: true, sent: sent, failed: failed, bots: bots.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bot/:id/users/:uid/update', async (req, res) => {
  try {
    const body = req.body;
    const ref = db.collection('bots').doc(req.params.id).collection('users').doc(String(req.params.uid));
    const u = {};
    if (body.banned !== undefined) u.banned = body.banned === true;
    if (body.addBalance !== undefined) u.balance = admin.firestore.FieldValue.increment(parseFloat(body.addBalance));
    if (body.setBalance !== undefined) u.balance = parseFloat(body.setBalance);    
    await ref.set(u, { merge: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });  
  }});

app.post('/api/bot/:id/submit-proof', async (req, res) => {
  try {
    const { id: botId } = req.params;    
    const { userId, taskName, text, photoFileId, botToken } = req.body;

    if (!userId || !taskName || !botToken) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let imageUrl = null;
    if (photoFileId) {
      try {
        const fileRes = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${photoFileId}`, { timeout: 10000 });
        if (!fileRes.data.ok) throw new Error('Failed to get file info from Telegram');
        const filePath = fileRes.data.result.file_path;
        imageUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
      } catch (err) {
        console.error('[submit-proof] Error processing photo:', err.message);
        return res.status(500).json({ success: false, error: 'Failed to process image from Telegram' });
      }
    }

    const proofId = `proof_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newProof = {
      id: proofId,
      uid: String(userId),      
      task: taskName,
      text: text || '',
      imageUrl: imageUrl, 
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('bots').doc(botId).collection('proofs').doc(proofId).set(newProof);
    res.json({ success: true, proofId, message: 'Proof submitted successfully' });
  } catch (error) {    
    console.error('[submit-proof] Error:', error);
    res.status(500).json({ success: false, error: error.message });  
  }
});

app.post('/api/bot/:id/proofs/:pid/resolve', async (req, res) => {
  try {
    const approve = !!req.body.approve;
    const ref = db.collection('bots').doc(req.params.id).collection('proofs').doc(req.params.pid);    
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Proof already resolved' });
    const p = doc.data();    if (approve && p.reward) {
      try {        
        await db.collection('bots').doc(req.params.id).collection('users').doc(p.uid)
          .update({ balance: admin.firestore.FieldValue.increment(p.reward) });
      } catch (e) {}
      await engine.sendTo(req.params.id, p.uid, '✅ <b>Your task proof was APPROVED!</b>\n\n🎁 You earned <b>' + p.reward + '</b>!');
    } else {
      await engine.sendTo(req.params.id, p.uid, approve ? '✅ <b>Your task proof was APPROVED!</b>' : '❌ <b>Your task proof was declined.</b>');
    }
    await ref.delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PT Exchange Payment
async function payWithPTExchange({ wallet, amount, currency, clientWithdrawalId }) {
  const apiKey = process.env.PT_API_KEY || process.env.PT_EXCHANGE_API_KEY;
  if (!apiKey) throw new Error('PT_API_KEY is not configured');
  
  const cur = normalizeCurrency(currency);
  if (!isAutoPayCoin(cur)) throw new Error('Currency ' + cur + ' not supported. Only: ' + AUTO_PAY_COINS.join(', '));
  
  const tonGateway = 'https://ptexchange-api.vercel.app';
  const bscGateway = 'https://pt-kappa-ten.vercel.app';  
  let url, payload;
  
  if (cur === 'TON') {
    url = tonGateway + '/pay/ton';
    payload = { api_key: apiKey, to_address: wallet, amount: amount, comment: clientWithdrawalId || 'Clur Bot' };
  } else if (cur === 'BNB') {
    url = bscGateway + '/pay/bnb';
    payload = { api_key: apiKey, to_address: wallet, amount: amount, comment: clientWithdrawalId || 'Clur Bot' };
  } else {
    url = tonGateway + '/pay/jetton';
    payload = { api_key: apiKey, to_address: wallet, jetton_symbol: cur, amount: amount, comment: clientWithdrawalId || 'Clur Bot' };
  }  
  console.log('[PT Exchange] Sending:', cur, 'to', wallet, 'amount:', amount);
  
  const response = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 30000,
    validateStatus: function(status) { return status >= 200 && status < 500; }
  });  
  
  if (response.status < 200 || response.status >= 300) {
    const error = response.data || {};    
    const message = error.error || error.message || error.detail || ('PT Exchange returned HTTP ' + response.status);
    const err = new Error(message);    err.status = response.status;
    err.providerResponse = response.data;
    throw err;
  }
  
  return { provider: 'pt_exchange', status: 'success', data: response.data };
}

// xRocket Payment
async function payWithXRocket({ telegramUserId, amount, currency, clientPayoutId, description }) {  
  const token = process.env.XROCKET_API_KEY || process.env.XROCKET_TOKEN;
  if (!token) throw new Error('XROCKET_API_KEY is not configured');
  if (!telegramUserId) throw new Error('Telegram user ID is required for xRocket');
  
  const cur = normalizeCurrency(currency);
  if (!isAutoPayCoin(cur)) throw new Error('Currency ' + cur + ' not supported. Only: ' + AUTO_PAY_COINS.join(', '));
  
  const url = process.env.XROCKET_PAYOUT_URL || 'https://pay.api.xrocket.exchange/api/v1/payouts';
  const payload = {
    clientPayoutId: clientPayoutId,
    target: String(telegramUserId),    
    targetType: 'telegram_user_id',
    asset: cur,
    amount: String(amount),
    description: description || 'Bot reward withdrawal'
  };
  
  console.log('[xRocket] Sending:', cur, 'to user', telegramUserId, 'amount:', amount);
  
  const response = await axios.post(url, payload, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 30000,
    validateStatus: function(status) { return status >= 200 && status < 500; }
  });
  
  if (response.status < 200 || response.status >= 300) {
    const error = response.data || {};
    const message = error.detail || error.message || error.error || ('xRocket returned HTTP ' + response.status);
    const err = new Error(message);
    err.status = response.status;
    err.providerResponse = response.data;    
    throw err;
  }
  
  const data = response.data || {};
  const status = cleanString(data.status).toLowerCase();
  if (status === 'failed') {
    const err = new Error('xRocket payout failed');
    err.status = response.status;
    err.providerResponse = data;    throw err;
  }
  
  return { provider: 'xrocket', status: status || 'success', data: data };
}

app.post('/api/withdraw', async (req, res) => {  
  try {
    const body = req.body || {};
    const botId = cleanString(body.botId || body.bot || body.bot_id);
    const uid = cleanString(body.uid || body.userId || body.telegramUserId);
    const amount = safeAmount(body.amount);
    const currency = normalizeCurrency(body.currency || body.asset || 'NOT');
    const provider = normalizeProvider(body.provider || body.payMethod || body.paymentMethod);
    const wallet = cleanString(body.wallet || body.address);
    const telegramUserId = cleanString(body.telegramUserId || body.userId || body.uid);
    
    if (!amount) return res.status(400).json({ ok: false, error: 'Invalid amount' });
    if (!provider) return res.status(400).json({ ok: false, error: 'Payment provider required' });    
    if (!currency) return res.status(400).json({ ok: false, error: 'Currency required' });
    
    // ✅ STRICT CHECK: Airtime and Data are MANUAL ONLY
    if ((currency === 'AIRTIME' || currency === 'DATA') && provider !== 'Manual') {
      return res.status(400).json({ ok: false, error: 'Airtime and Data withdrawals are Manual only.' });
    }
    
    const clientId = cleanString(body.clientWithdrawalId || body.clientPayoutId) || makeClientId('withdraw', botId, uid);    
    
    if (provider === 'Manual') {
      return res.json({ ok: true, success: true, provider: 'Manual', status: 'pending', clientId: clientId, message: 'Withdrawal submitted for manual processing' });
    }

    if (!isAutoPayCoin(currency)) {
      return res.status(400).json({ ok: false, error: 'Currency ' + currency + ' not supported for AutoPay. Only: ' + AUTO_PAY_COINS.join(', ') });
    }
    
    if (provider === 'AutoPay1' && !wallet) {
      return res.status(400).json({ ok: false, error: 'Wallet address required for PT Exchange' });
    }
    if (provider === 'AutoPay2' && !telegramUserId) {
      return res.status(400).json({ ok: false, error: 'Telegram user ID required for xRocket' });
    }
    
    if (provider === 'AutoPay1') {
      try {        
        const result = await payWithPTExchange({ wallet, amount, currency, clientWithdrawalId: clientId });        
        return res.json({ ok: true, success: true, provider: 'AutoPay1', status: 'paid', currency, amount, wallet, clientId, result: result.data });
      } catch (e) {
        console.error('[PT Exchange]', e.message);
        return res.status(e.status || 502).json({ ok: false, provider: 'AutoPay1', status: 'failed', error: e.message, clientId });      }
    }    
    if (provider === 'AutoPay2') {
      try {
        const result = await payWithXRocket({ telegramUserId, amount, currency, clientPayoutId: clientId, description: body.description || 'Bot reward withdrawal' });
        return res.json({ ok: true, success: true, provider: 'AutoPay2', status: result.status, currency, amount, telegramUserId, clientId, result: result.data });
      } catch (e) {
        console.error('[xRocket]', e.message);
        return res.status(e.status || 502).json({ ok: false, provider: 'AutoPay2', status: 'failed', error: e.message, clientId });
      }
    }    
    return res.status(400).json({ ok: false, error: 'Unsupported payment provider: ' + provider });
  } catch (e) {
    console.error('[withdraw] fatal:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ... (Keep the rest of your server.js routes: /pay/notcoin, /pay/jetton, /pay/xrocket, /api/bot/:id/withdrawals, /api/check-payment, /api/process-payment, /api/admin/payments, /api/user/:uid/profile, /api/store/*, cron jobs, admin chats, etc. exactly as they were) ...

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Clur Backend ' + SERVER_VERSION + ' on port ' + PORT);
  console.log('[payments] Supported Auto-Pay coins:', AUTO_PAY_COINS.join(', '));
  engine.loadAllBots();
  const APP_URL = process.env.APP_URL || '';
  if (APP_URL) {
    setInterval(function() { axios.get(APP_URL + '/ping', { timeout: 3000 }).catch(function() {}); }, 1000);
    console.log('[keepalive] pinging every 1 second - service will never sleep');
  } else {
    console.log('[keepalive] APP_URL not set - self-ping disabled');
  }
});

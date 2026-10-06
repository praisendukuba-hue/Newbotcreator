require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const { db, admin } = require('./firebase');
const engine = require('./utils/botEngine');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

async function notifyOwner(text) {
  if (!process.env.ADMIN_TELEGRAM_BOT_TOKEN || !process.env.ADMIN_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.ADMIN_TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: process.env.ADMIN_CHAT_ID, text, parse_mode: 'HTML' }, { timeout: 5000 });
  } catch (e) {}
}

app.get('/', (req, res) => res.json({ status: 'ok', botsOnline: Object.keys(engine.activeBots).length }));

// ============ VERIFY TOKEN ============
app.post('/api/verify-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
    const r = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 5000 });
    if (r.data.ok) return res.json({ ok: true, username: r.data.result.username, firstName: r.data.result.first_name, id: r.data.result.id });
    res.status(400).json({ ok: false, error: 'Invalid token' });
  } catch (e) { res.status(400).json({ ok: false, error: 'Failed to verify' }); }
});

// ============ CHECK IF BOT IS ADMIN IN CHANNEL ============
app.post('/api/check-channel-admin', async (req, res) => {
  try {
    const { token, channel } = req.body;
    const me = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 5000 });
    const m = await axios.get(`https://api.telegram.org/bot${token}/getChatMember`, { params: { chat_id: channel, user_id: me.data.result.id }, timeout: 5000 });
    const st = m.data.result.status;
    res.json({ ok: true, isAdmin: st === 'administrator' || st === 'creator', status: st });
  } catch (e) { res.json({ ok: true, isAdmin: false, status: 'error' }); }
});

// ============ CREATE BOT ============
app.post('/api/create-bot', async (req, res) => {
  try {
    const data = req.body;
    if (!data.token || !data.name || !data.ownerId) return res.status(400).json({ error: 'Missing fields' });
    const v = await axios.get(`https://api.telegram.org/bot${data.token}/getMe`, { timeout: 5000 });    if (!v.data.ok) return res.status(400).json({ error: 'Token invalid' });

    const mj = (data.mustJoin || []).slice(0, 10);
    const nm = (data.nonMust || []).slice(0, Math.max(0, 10 - mj.length));

    const botData = {
      ownerId: data.ownerId, coAdmins: [], type: data.type || 'bot',
      name: data.name, username: v.data.result.username, token: data.token,
      currency: data.currency, payMethod: data.payMethod, apiKey: data.apiKey || '',
      payoutChannel: data.payoutChannel, minW: parseFloat(data.minW) || 0.01,
      maxW: parseFloat(data.maxW) || 100, refBonus: parseFloat(data.refBonus) || 0.01,
      mustJoin: mj, nonMust: nm, tasks: data.tasks || [], botDetect: !!data.botDetect,
      officialChannel: 'https://t.me/DAILYUUPA', users: 0, status: 'active',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    const ref = await db.collection('bots').add(botData);
    engine.startBot({ id: ref.id, ...botData });
    res.json({ success: true, botId: ref.id, username: v.data.result.username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ USER BOTS ============
app.get('/api/user/:uid/bots', async (req, res) => {
  const snap = await db.collection('bots').where('ownerId', '==', req.params.uid).get();
  const bots = []; snap.forEach(d => bots.push({ id: d.id, ...d.data() }));
  res.json({ success: true, bots });
});

// ============ FULL BOT ============
app.get('/api/bot/:id', async (req, res) => {
  try {
    const doc = await db.collection('bots').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const b = doc.data(); delete b.token; delete b.apiKey;
    let userList = [], withdrawals = [], proofs = [];
    try {
      const u = await db.collection('bots').doc(req.params.id).collection('users').limit(300).get();
      userList = u.docs.map(d => ({ id: d.id, ...d.data() }));
      const w = await db.collection('bots').doc(req.params.id).collection('withdrawals').limit(100).get();
      withdrawals = w.docs.map(d => ({ id: d.id, ...d.data() }));
      const p = await db.collection('bots').doc(req.params.id).collection('proofs').where('status', '==', 'pending').limit(100).get();
      proofs = p.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {}
    const created = b.createdAt ? new Date(b.createdAt).getTime() : Date.now();
    b.hours = Math.max(0, Math.floor((Date.now() - created) / 3600000));
    b.online = !!engine.activeBots[req.params.id];
    b.userList = userList; b.withdrawals = withdrawals; b.proofs = proofs;
    res.json({ success: true, bot: { id: doc.id, ...b } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ============ SETTINGS ============
app.put('/api/bot/:id/settings', async (req, res) => {
  try {
    const { minW, maxW, refBonus, mustJoin, nonMust, tasks, botDetect, coAdmins } = req.body;
    const u = { updatedAt: new Date().toISOString() };
    if (minW !== undefined) u.minW = parseFloat(minW);
    if (maxW !== undefined) u.maxW = parseFloat(maxW);
    if (refBonus !== undefined) u.refBonus = parseFloat(refBonus);
    if (mustJoin !== undefined) u.mustJoin = typeof mustJoin === 'string' ? mustJoin.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10) : mustJoin;
    if (nonMust !== undefined) u.nonMust = typeof nonMust === 'string' ? nonMust.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10) : nonMust;
    if (tasks !== undefined) u.tasks = tasks;
    if (botDetect !== undefined) u.botDetect = !!botDetect;
    if (coAdmins !== undefined) u.coAdmins = typeof coAdmins === 'string' ? coAdmins.split(',').map(s => s.trim()).filter(Boolean) : coAdmins;
    await db.collection('bots').doc(req.params.id).update(u);
    await engine.restartBot(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ DELETE BOT (full cleanup) ============
app.delete('/api/bot/:id', async (req, res) => {
  try {
    engine.stopBot(req.params.id);
    for (const sub of ['users', 'withdrawals', 'proofs']) {
      const snap = await db.collection('bots').doc(req.params.id).collection(sub).limit(500).get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    await db.collection('bots').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ BOT BROADCAST ============
app.post('/api/bot/:id/broadcast', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    const doc = await db.collection('bots').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const token = doc.data().token;
    const u = await db.collection('bots').doc(req.params.id).collection('users').limit(5000).get();
    let sent = 0, failed = 0;
    for (const x of u.docs) {
      try { await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: x.id, text: message, parse_mode: 'HTML' }, { timeout: 5000 }); sent++; } catch (e) { failed++; }
      await new Promise(r => setTimeout(r, 35));
    }
    res.json({ success: true, sent, failed });  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ OWNER BROADCAST (ALL BOTS) ============
app.post('/api/admin/broadcast', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.OWNER_KEY) return res.status(403).json({ error: 'Invalid owner key' });
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  const bots = await db.collection('bots').where('status', '==', 'active').get();
  let sent = 0, failed = 0;
  for (const b of bots.docs) {
    const token = b.data().token;
    const u = await db.collection('bots').doc(b.id).collection('users').limit(5000).get();
    for (const x of u.docs) {
      try { await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: x.id, text: message, parse_mode: 'HTML' }, { timeout: 5000 }); sent++; } catch (e) { failed++; }
      await new Promise(r => setTimeout(r, 35));
    }
  }
  res.json({ success: true, sent, failed, bots: bots.size });
});

// ============ USER MANAGEMENT (ban / balance) ============
app.post('/api/bot/:id/users/:uid/update', async (req, res) => {
  try {
    const { banned, addBalance, setBalance } = req.body;
    const ref = db.collection('bots').doc(req.params.id).collection('users').doc(String(req.params.uid));
    const u = {};
    if (banned !== undefined) u.banned = !!banned;
    if (addBalance !== undefined) u.balance = admin.firestore.FieldValue.increment(parseFloat(addBalance));
    if (setBalance !== undefined) u.balance = parseFloat(setBalance);
    await ref.set(u, { merge: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ TASK PROOFS (approve / decline) ============
app.post('/api/bot/:id/proofs/:pid/resolve', async (req, res) => {
  try {
    const { approve } = req.body;
    const ref = db.collection('bots').doc(req.params.id).collection('proofs').doc(req.params.pid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Proof already resolved' });
    const p = doc.data();
    await ref.delete(); // delete immediately as requested
    await engine.sendTo(req.params.id, p.uid, approve
      ? '✅ <b>Your task proof was APPROVED!</b>'
      : '❌ <b>Your task proof was declined.</b>');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }});

// ============ PAYMENTS ============
async function applyPayment(memo, amount, currency, txHash, sender) {
  const parts = memo.split('_');
  const type = parts[1]; // PREMIUM | UPLOAD | BUY
  if (type === 'PREMIUM') {
    const uid = parts[2];
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.collection('users').doc(uid).set({ isPremium: true, premiumExpiresAt: expires, premiumMethod: currency, premiumTxHash: txHash }, { merge: true });
    return { type, uid };
  }
  if (type === 'UPLOAD') {
    return { type, uid: parts[2] };
  }
  if (type === 'BUY') {
    const itemId = parts[2], uid = parts[3];
    const itemRef = db.collection('storeTemplates').doc(itemId);
    const item = await itemRef.get();
    if (!item.exists) return { type, error: 'item gone' };
    const d = item.data();
    if (d.status === 'sold') return { type, error: 'already sold' };
    await itemRef.update({ status: 'sold', soldTo: uid, soldAt: Date.now() });
    await db.collection('users').doc(uid).set({ purchasedTemplates: admin.firestore.FieldValue.arrayUnion(itemId) }, { merge: true });
    await db.collection('sales').add({ itemId, item: d.name, price: d.price, sellerId: d.sellerId, sellerWallet: d.sellerWallet, buyerId: uid, currency, txHash, at: Date.now() });
    await notifyOwner(`🛒 <b>ITEM SOLD!</b>\n\n📦 ${d.name}\n💵 Price: ${d.price}\n👛 Seller wallet: <code>${d.sellerWallet || 'none'}</code>\n\nSend the seller their money.`);
    return { type, uid, itemId, link: d.link };
  }
  return { type: 'unknown' };
}

app.post('/api/check-payment', async (req, res) => {
  const { memo } = req.body;
  if (!memo) return res.status(400).json({ error: 'Memo required' });
  const snap = await db.collection('payments').where('memo', '==', memo).where('status', '==', 'confirmed').limit(1).get();
  if (snap.empty) return res.json({ confirmed: false });
  const p = snap.docs[0].data();
  res.json({ confirmed: true, type: p.payType, link: p.link || null });
});

app.post('/api/process-payment', async (req, res) => {
  try {
    const { txHash, memo, amount, sender, currency } = req.body;
    const exist = await db.collection('payments').where('txHash', '==', txHash).limit(1).get();
    if (!exist.empty) return res.json({ success: true, message: 'already processed' });
    const result = await applyPayment(memo, amount, currency, txHash, sender);
    await db.collection('payments').add({ txHash, memo, amount, currency, sender, status: 'confirmed', payType: result.type, link: result.link || null, at: Date.now() });
    res.json({ success: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Naira manual approval (you approve from Firebase or ask me for an admin page later)
app.post('/api/admin/payments/:pid/approve', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.OWNER_KEY) return res.status(403).json({ error: 'Invalid owner key' });
  const ref = db.collection('payments').doc(req.params.pid);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Not found' });
  const p = doc.data();
  const result = await applyPayment(p.memo, p.amount, 'NGN', p.ref, p.ownerId);
  await ref.update({ status: 'confirmed', payType: result.type, link: result.link || null });
  res.json({ success: true, result });
});

// ============ PROFILE ============
app.get('/api/user/:uid/profile', async (req, res) => {
  const doc = await db.collection('users').doc(req.params.uid).get();
  res.json({ success: true, profile: doc.exists ? doc.data() : { isPremium: false } });
});

// ============ STORE ============
app.get('/api/store/templates', async (req, res) => {
  const snap = await db.collection('storeTemplates').where('active', '==', true).get();
  const t = []; snap.forEach(d => t.push({ id: d.id, ...d.data() }));
  res.json({ success: true, templates: t });
});

app.post('/api/store/add', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.OWNER_KEY) return res.status(403).json({ error: 'Invalid owner key' });
  const item = req.body;
  if (!item.name || !item.price) return res.status(400).json({ error: 'Name and price required' });
  const doc = await db.collection('storeTemplates').add({ ...item, sellerId: 'OWNER', sellerWallet: '', status: 'available', active: true, createdAt: Date.now() });
  res.json({ success: true, id: doc.id });
});

// User uploads item AFTER paying 0.2 TON fee
app.post('/api/store/upload', async (req, res) => {
  try {
    const { sellerId, name, desc, icon, type, link, price, wallet } = req.body;
    if (!sellerId || !name || !link) return res.status(400).json({ error: 'Missing fields' });
    const doc = await db.collection('storeTemplates').add({
      name, desc: desc || '', icon: icon || '🤖', type: type || 'bot', link, price: price || '1 TON',
      sellerId, sellerWallet: wallet || '', status: 'available', active: true, createdAt: Date.now()
    });
    await notifyOwner(`📦 <b>New store upload!</b>\n\n🏷 ${name}\n👤 Seller: ${sellerId}\n👛 Seller wallet: <code>${wallet || 'none'}</code>`);
    res.json({ success: true, id: doc.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/store/purchase', async (req, res) => {
  const { userId, templateId } = req.body;
  await db.collection('users').doc(userId).set({ purchasedTemplates: admin.firestore.FieldValue.arrayUnion(templateId) }, { merge: true });
  res.json({ success: true });
});
// ============ KEEP ALIVE (never sleep) ============
app.get('/ping', (req, res) => res.json({ pong: true }));

const APP_URL = process.env.APP_URL || '';
if (APP_URL) {
  setInterval(() => {
    axios.get(APP_URL + '/ping', { timeout: 3000 }).catch(() => {});
  }, 1000);
  console.log('[keepalive] pinging every 1 second - service will never sleep');
}
// ============ CRON ============
cron.schedule('0 0 * * *', async () => {
  const now = new Date().toISOString();
  const snap = await db.collection('users').where('isPremium', '==', true).where('premiumExpiresAt', '<', now).get();
  for (const d of snap.docs) await d.ref.update({ isPremium: false });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Clur Backend on port ${PORT}`);
  engine.loadAllBots();
});

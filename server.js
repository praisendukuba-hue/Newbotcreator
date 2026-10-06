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

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Clur Bot Creator Backend is running', botsOnline: Object.keys(engine.activeBots).length });
});

// ============ 1. VERIFY TOKEN ============
app.post('/api/verify-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: 'Token is required' });
    const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 5000 });
    if (response.data.ok) {
      res.json({ ok: true, username: response.data.result.username, firstName: response.data.result.first_name, id: response.data.result.id });
    } else {
      res.status(400).json({ ok: false, error: 'Invalid token' });
    }
  } catch (error) {
    res.status(400).json({ ok: false, error: 'Failed to verify token' });
  }
});

// ============ 2. CREATE BOT (instant live) ============
app.post('/api/create-bot', async (req, res) => {
  try {
    const data = req.body;
    if (!data.token || !data.name || !data.ownerId) return res.status(400).json({ error: 'Missing required fields' });

    const verifyRes = await axios.get(`https://api.telegram.org/bot${data.token}/getMe`, { timeout: 5000 });
    if (!verifyRes.data.ok) return res.status(400).json({ error: 'Token is invalid or bot was deleted.' });

    const botData = {
      ownerId: data.ownerId,
      type: data.type || 'bot',
      name: data.name,
      username: verifyRes.data.result.username,
      token: data.token,
      currency: data.currency,
      payMethod: data.payMethod,
      apiKey: data.apiKey || '',      payoutChannel: data.payoutChannel,
      minW: parseFloat(data.minW) || 0.01,
      maxW: parseFloat(data.maxW) || 100,
      refBonus: parseFloat(data.refBonus) || 0.01,
      mustJoin: data.mustJoin || [],
      nonMust: data.nonMust || [],
      tasks: data.tasks || [],
      officialChannel: 'https://t.me/DAILYUUPA',
      users: 0,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const docRef = await db.collection('bots').add(botData);

    // 🪄 MAGIC: bot goes live RIGHT NOW
    engine.startBot({ id: docRef.id, ...botData });

    res.json({ success: true, botId: docRef.id, message: 'Bot created and is LIVE!', username: verifyRes.data.result.username });
  } catch (error) {
    console.error('Create bot error:', error.message);
    res.status(500).json({ error: 'Failed to create bot: ' + error.message });
  }
});

// ============ 3. GET USER BOTS ============
app.get('/api/user/:uid/bots', async (req, res) => {
  try {
    const snapshot = await db.collection('bots').where('ownerId', '==', req.params.uid).orderBy('createdAt', 'desc').get();
    const bots = [];
    snapshot.forEach(doc => bots.push({ id: doc.id, ...doc.data() }));
    res.json({ success: true, bots });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bots' });
  }
});

// ============ 4. GET FULL BOT (dashboard + admin panel) ============
app.get('/api/bot/:id', async (req, res) => {
  try {
    const doc = await db.collection('bots').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Bot not found' });
    const b = doc.data();
    delete b.token; delete b.apiKey;

    let userList = [], withdrawals = [];
    try {
      const uSnap = await db.collection('bots').doc(req.params.id).collection('users').limit(200).get();
      userList = uSnap.docs.map(d => ({ id: d.id, ...d.data() }));      const wSnap = await db.collection('bots').doc(req.params.id).collection('withdrawals').limit(100).get();
      withdrawals = wSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {}

    const created = b.createdAt ? new Date(b.createdAt).getTime() : Date.now();
    b.hours = Math.max(0, Math.floor((Date.now() - created) / 3600000));
    b.online = !!engine.activeBots[req.params.id];
    b.userList = userList;
    b.withdrawals = withdrawals;

    res.json({ success: true, bot: { id: doc.id, ...b } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bot' });
  }
});

// ============ 5. UPDATE SETTINGS (auto-restart bot) ============
app.put('/api/bot/:id/settings', async (req, res) => {
  try {
    const { minW, maxW, refBonus, mustJoin, nonMust, tasks } = req.body;
    const updateData = { updatedAt: new Date().toISOString() };
    if (minW !== undefined) updateData.minW = parseFloat(minW);
    if (maxW !== undefined) updateData.maxW = parseFloat(maxW);
    if (refBonus !== undefined) updateData.refBonus = parseFloat(refBonus);
    if (mustJoin !== undefined) updateData.mustJoin = typeof mustJoin === 'string' ? mustJoin.split(',').map(s => s.trim()).filter(Boolean) : mustJoin;
    if (nonMust !== undefined) updateData.nonMust = typeof nonMust === 'string' ? nonMust.split(',').map(s => s.trim()).filter(Boolean) : nonMust;
    if (tasks !== undefined) updateData.tasks = tasks;

    await db.collection('bots').doc(req.params.id).update(updateData);
    await engine.restartBot(req.params.id); // 🪄 new settings live in ~2 seconds

    res.json({ success: true, message: 'Settings updated and bot restarted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ============ 6. DELETE BOT ============
app.delete('/api/bot/:id', async (req, res) => {
  try {
    engine.stopBot(req.params.id);
    await db.collection('bots').doc(req.params.id).delete();
    res.json({ success: true, message: 'Bot deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete bot' });
  }
});

// ============ 7. BROADCAST TO BOT USERS ============
app.post('/api/bot/:id/broadcast', async (req, res) => {  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    const doc = await db.collection('bots').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Bot not found' });
    const token = doc.data().token;

    const uSnap = await db.collection('bots').doc(req.params.id).collection('users').limit(5000).get();
    let sent = 0, failed = 0;
    for (const u of uSnap.docs) {
      try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: u.id, text: message, parse_mode: 'HTML' }, { timeout: 5000 });
        sent++;
      } catch (e) { failed++; }
      await new Promise(r => setTimeout(r, 40));
    }
    res.json({ success: true, sent, failed });
  } catch (error) {
    res.status(500).json({ error: 'Broadcast failed' });
  }
});

// ============ 8. CHECK PAYMENT (frontend polls) ============
app.post('/api/check-payment', async (req, res) => {
  try {
    const { memo } = req.body;
    if (!memo) return res.status(400).json({ error: 'Memo is required' });
    const paymentDoc = await db.collection('payments').where('memo', '==', memo).where('status', '==', 'confirmed').get();
    res.json({ confirmed: !paymentDoc.empty });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check payment' });
  }
});

// ============ 9. PROCESS BLOCKCHAIN PAYMENT ============
app.post('/api/process-payment', async (req, res) => {
  try {
    const { txHash, memo, amount, sender, currency } = req.body;
    if (!txHash || !memo || !amount || !currency) return res.status(400).json({ error: 'Missing payment fields' });
    const parts = memo.split('_');
    if (parts.length < 3 || parts[0] !== 'CLUR' || parts[1] !== 'PREMIUM') return res.status(400).json({ error: 'Invalid memo' });
    const userId = parts[2];

    const existing = await db.collection('payments').where('txHash', '==', txHash).get();
    if (!existing.empty) return res.json({ success: true, message: 'Already processed' });

    await db.collection('payments').add({ txHash, memo, userId, amount, currency, sender, status: 'confirmed', confirmedAt: new Date().toISOString() });

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.collection('users').doc(userId).set({      isPremium: true, premiumExpiresAt: expiresAt, premiumMethod: currency,
      premiumTxHash: txHash, premiumActivatedAt: new Date().toISOString()
    }, { merge: true });

    res.json({ success: true, message: 'Premium activated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process payment' });
  }
});

// ============ 10. USER PROFILE ============
app.get('/api/user/:uid/profile', async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.params.uid).get();
    if (!doc.exists) return res.json({ success: true, profile: { isPremium: false } });
    res.json({ success: true, profile: doc.data() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ============ 11. STORE ============
app.get('/api/store/templates', async (req, res) => {
  try {
    const snapshot = await db.collection('storeTemplates').where('active', '==', true).get();
    const templates = [];
    snapshot.forEach(doc => templates.push({ id: doc.id, ...doc.data() }));
    res.json({ success: true, templates });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

app.post('/api/store/add', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (!key || key !== process.env.OWNER_KEY) return res.status(403).json({ error: 'Invalid owner key' });
    const item = req.body;
    if (!item.name || !item.price) return res.status(400).json({ error: 'Name and price required' });
    const doc = await db.collection('storeTemplates').add({ ...item, active: true, createdAt: Date.now() });
    res.json({ success: true, id: doc.id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add item' });
  }
});


app.post('/api/store/purchase', async (req, res) => {
  try {
    const { userId, templateId } = req.body;
    await db.collection('users').doc(userId).set({      purchasedTemplates: admin.firestore.FieldValue.arrayUnion(templateId)
    }, { merge: true });
    res.json({ success: true, message: 'Template purchased' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to purchase' });
  }
});
// ============ OWNER BROADCAST TO ALL BOTS ============
app.post('/api/admin/broadcast', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (!key || key !== process.env.OWNER_KEY) return res.status(403).json({ error: 'Invalid owner key' });

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const botsSnap = await db.collection('bots').where('status', '==', 'active').get();
    let totalSent = 0, totalFailed = 0;

    for (const botDoc of botsSnap.docs) {
      const token = botDoc.data().token;
      const uSnap = await db.collection('bots').doc(botDoc.id).collection('users').limit(5000).get();
      
      for (const u of uSnap.docs) {
        try {
          await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: u.id, text: message, parse_mode: 'HTML'
          }, { timeout: 5000 });
          totalSent++;
        } catch (e) { totalFailed++; }
        await new Promise(r => setTimeout(r, 40));
      }
    }

    res.json({ success: true, sent: totalSent, failed: totalFailed, bots: botsSnap.size });
  } catch (error) {
    res.status(500).json({ error: 'Broadcast failed' });
  }
});
// ============ CRON: premium expiry (daily) ============
cron.schedule('0 0 * * *', async () => {
  try {
    const now = new Date().toISOString();
    const snap = await db.collection('users').where('isPremium', '==', true).where('premiumExpiresAt', '<', now).get();
    for (const doc of snap.docs) {
      await doc.ref.update({ isPremium: false });
      console.log(`⏰ Premium expired: ${doc.id}`);
    }
  } catch (e) { console.error('Premium cron error:', e.message); }
});

// ============ START ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Clur Backend running on port ${PORT}`);
  engine.loadAllBots(); // 🪄 all saved bots come back online automatically after every deploy/restart
});

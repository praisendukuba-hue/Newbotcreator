require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');

const { db, admin } = require('./firebase');
const engine = require('./utils/botEngine');

// ============================================================
// CRASH GUARDS
// ============================================================

process.on('unhandledRejection', (reason) => {
  console.error('[guard] unhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[guard] uncaughtException:', err);
});

// ============================================================
// APP
// ============================================================

const app = express();

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-admin-key',
    'x-backend-secret'
  ]
}));

app.use(express.json({ limit: '10mb' }));

// ============================================================
// VERSION
// ============================================================

const SERVER_VERSION = 'v2026.10.07-payment-fix2';

// ============================================================
// HELPERS
// ============================================================

function cleanString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeCurrency(currency) {
  return cleanString(currency).toUpperCase();
}

function normalizeProvider(provider) {
  const p = cleanString(provider).toLowerCase();

  if (
    p === 'auto pay 1' ||
    p === 'autopay 1' ||
    p === 'auto_pay_1' ||
    p === 'pt exchange' ||
    p === 'pt_exchange' ||
    p === 'ptexchange' ||
    p === 'pt'
  ) {
    return 'pt_exchange';
  }

  if (
    p === 'auto pay 2' ||
    p === 'autopay 2' ||
    p === 'auto_pay_2' ||
    p === 'xrocket' ||
    p === 'xrocket pay' ||
    p === 'xrocket_pay'
  ) {
    return 'xrocket';
  }

  if (
    p === 'manual' ||
    p === 'manual payment' ||
    p === 'manual withdrawal'
  ) {
    return 'manual';
  }

  return p;
}

function safeAmount(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;

  return n;
}

function makeClientId(prefix, botId, uid) {
  return (
    prefix +
    '_' +
    String(botId || 'bot') +
    '_' +
    String(uid || 'user') +
    '_' +
    Date.now() +
    '_' +
    crypto.randomBytes(4).toString('hex')
  );
}

function getBackendSecret() {
  return (
    process.env.BACKEND_SECRET ||
    process.env.BOT_BACKEND_SECRET ||
    ''
  );
}

function checkBackendSecret(req) {
  const secret = getBackendSecret();

  // Preserve existing behaviour if no secret has been configured.
  if (!secret) return true;

  const supplied =
    req.headers['x-backend-secret'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '');

  return supplied === secret;
}

function getProviderFromBody(body) {
  return normalizeProvider(
    body.provider ||
    body.payMethod ||
    body.paymentMethod ||
    body.method ||
    ''
  );
}

function getWalletFromBody(body) {
  return cleanString(
    body.wallet ||
    body.address ||
    body.recipient ||
    body.destination
  );
}

function getTelegramUserId(body) {
  return cleanString(
    body.telegramUserId ||
    body.userId ||
    body.uid ||
    body.target
  );
}

// ============================================================
// OWNER NOTIFICATION
// ============================================================

async function notifyOwner(text) {
  if (
    !process.env.ADMIN_TELEGRAM_BOT_TOKEN ||
    !process.env.ADMIN_CHAT_ID
  ) {
    return;
  }

  try {
    await axios.post(
      'https://api.telegram.org/bot' +
        process.env.ADMIN_TELEGRAM_BOT_TOKEN +
        '/sendMessage',
      {
        chat_id: process.env.ADMIN_CHAT_ID,
        text: text,
        parse_mode: 'HTML'
      },
      {
        timeout: 5000
      }
    );
  } catch (e) {
    console.error('[notifyOwner]', e.message);
  }
}

// ============================================================
// HEALTH
// ============================================================

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    version: SERVER_VERSION,
    botsOnline: Object.keys(engine.activeBots || {}).length,
    ownerKeySet: !!process.env.OWNER_KEY,
    paymentSystem: {
      ptExchange: !!process.env.PT_API_KEY,
      xRocket: !!process.env.XROCKET_API_KEY
    }
  });
});

app.get('/ping', (req, res) => {
  res.json({
    pong: true,
    version: SERVER_VERSION,
    time: new Date().toISOString()
  });
});

// ============================================================
// PAYMENT HEALTH CHECK
// ============================================================

app.get('/api/payment-health', (req, res) => {
  res.json({
    ok: true,
    version: SERVER_VERSION,
    providers: {
      pt_exchange: {
        configured: !!process.env.PT_API_KEY
      },
      xrocket: {
        configured: !!process.env.XROCKET_API_KEY
      },
      manual: {
        configured: true
      }
    }
  });
});

// ============================================================
// VERIFY TOKEN
// ============================================================

app.post('/api/verify-token', async (req, res) => {
  try {
    const token = req.body.token;

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: 'Token required'
      });
    }

    const r = await axios.get(
      'https://api.telegram.org/bot' + token + '/getMe',
      {
        timeout: 5000
      }
    );

    if (r.data.ok) {
      return res.json({
        ok: true,
        username: r.data.result.username,
        firstName: r.data.result.first_name,
        id: r.data.result.id
      });
    }

    return res.status(400).json({
      ok: false,
      error: 'Invalid token'
    });

  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: 'Failed to verify'
    });
  }
});

// ============================================================
// CHECK BOT ADMIN IN CHANNEL
// ============================================================

app.post('/api/check-channel-admin', async (req, res) => {
  try {
    const token = req.body.token;
    const channel = req.body.channel;

    if (!token || !channel) {
      return res.json({
        ok: true,
        isAdmin: false,
        status: 'missing'
      });
    }

    const me = await axios.get(
      'https://api.telegram.org/bot' + token + '/getMe',
      {
        timeout: 5000
      }
    );

    const m = await axios.get(
      'https://api.telegram.org/bot' + token + '/getChatMember',
      {
        params: {
          chat_id: channel,
          user_id: me.data.result.id
        },
        timeout: 5000
      }
    );

    const st = m.data.result.status;

    return res.json({
      ok: true,
      isAdmin:
        st === 'administrator' ||
        st === 'creator',
      status: st
    });

  } catch (e) {
    return res.json({
      ok: true,
      isAdmin: false,
      status: 'error'
    });
  }
});

// ============================================================
// CREATE BOT
// ============================================================

app.post('/api/create-bot', async (req, res) => {
  try {
    const data = req.body;

    if (
      !data.token ||
      !data.name ||
      !data.ownerId
    ) {
      return res.status(400).json({
        error: 'Missing fields'
      });
    }

    const v = await axios.get(
      'https://api.telegram.org/bot' +
        data.token +
        '/getMe',
      {
        timeout: 5000
      }
    );

    if (!v.data.ok) {
      return res.status(400).json({
        error: 'Token invalid'
      });
    }

    const mj = (data.mustJoin || [])
      .slice(0, 10);

    const nm = (data.nonMust || [])
      .slice(
        0,
        Math.max(0, 10 - mj.length)
      );

    const parsedTasks =
      (data.tasks || []).map(function(t) {
        return {
          n: t.n,
          l: t.l,
          reward: Number(t.reward || 0)
        };
      });

    const botData = {
      ownerId: data.ownerId,
      coAdmins: [],
      type: data.type || 'bot',
      name: data.name,
      username: v.data.result.username,
      token: data.token,

      currency: data.currency,
      payMethod: data.payMethod,

      apiKey: data.apiKey || '',

      payoutChannel:
        data.payoutChannel || '',

      minW:
        parseFloat(data.minW) || 0.01,

      maxW:
        parseFloat(data.maxW) || 100,

      refBonus:
        parseFloat(data.refBonus) || 0.01,

      withdrawFee:
        parseFloat(data.withdrawFee) || 0,

      mustJoin: mj,
      nonMust: nm,

      tasks: parsedTasks,

      botDetect:
        data.botDetect === true,

      // Permanent official channel.
      officialChannel:
        'https://t.me/DAILYUUPA',

      users: 0,

      status: 'active',

      createdAt:
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString()
    };

    const ref =
      await db.collection('bots').add(botData);

    engine.startBot(
      Object.assign(
        { id: ref.id },
        botData
      )
    );

    return res.json({
      success: true,
      botId: ref.id,
      username: v.data.result.username
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// USER BOTS
// ============================================================

app.get('/api/user/:uid/bots', async (req, res) => {
  try {
    const snap =
      await db
        .collection('bots')
        .where(
          'ownerId',
          '==',
          req.params.uid
        )
        .get();

    const bots = [];

    snap.forEach(function(d) {
      bots.push(
        Object.assign(
          { id: d.id },
          d.data()
        )
      );
    });

    return res.json({
      success: true,
      bots: bots
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// FULL BOT
// ============================================================

app.get('/api/bot/:id', async (req, res) => {
  try {
    const doc =
      await db
        .collection('bots')
        .doc(req.params.id)
        .get();

    if (!doc.exists) {
      return res.status(404).json({
        error: 'Not found'
      });
    }

    const b = doc.data();

    delete b.token;
    delete b.apiKey;

    let userList = [];
    let withdrawals = [];
    let proofs = [];

    try {
      const u =
        await db
          .collection('bots')
          .doc(req.params.id)
          .collection('users')
          .limit(300)
          .get();

      userList =
        u.docs.map(function(d) {
          return Object.assign(
            { id: d.id },
            d.data()
          );
        });

      const w =
        await db
          .collection('bots')
          .doc(req.params.id)
          .collection('withdrawals')
          .limit(100)
          .get();

      withdrawals =
        w.docs.map(function(d) {
          return Object.assign(
            { id: d.id },
            d.data()
          );
        });

      const p =
        await db
          .collection('bots')
          .doc(req.params.id)
          .collection('proofs')
          .where(
            'status',
            '==',
            'pending'
          )
          .limit(100)
          .get();

      proofs =
        p.docs.map(function(d) {
          return Object.assign(
            { id: d.id },
            d.data()
          );
        });

    } catch (e) {
      console.error(
        '[bot details]',
        e.message
      );
    }

    const created =
      b.createdAt
        ? new Date(b.createdAt).getTime()
        : Date.now();

    b.hours =
      Math.max(
        0,
        Math.floor(
          (Date.now() - created) /
            3600000
        )
      );

    b.online =
      !!engine.activeBots[
        req.params.id
      ];

    b.userList = userList;
    b.withdrawals = withdrawals;
    b.proofs = proofs;

    return res.json({
      success: true,
      bot: Object.assign(
        { id: doc.id },
        b
      )
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// SETTINGS
// ============================================================

app.put('/api/bot/:id/settings', async (req, res) => {
  try {
    const body = req.body;

    const u = {
      updatedAt:
        new Date().toISOString()
    };

    if (body.minW !== undefined) {
      u.minW =
        parseFloat(body.minW);
    }

    if (body.maxW !== undefined) {
      u.maxW =
        parseFloat(body.maxW);
    }

    if (body.refBonus !== undefined) {
      u.refBonus =
        parseFloat(body.refBonus);
    }

    if (body.withdrawFee !== undefined) {
      u.withdrawFee =
        parseFloat(
          body.withdrawFee
        ) || 0;
    }

    if (body.mustJoin !== undefined) {
      u.mustJoin =
        typeof body.mustJoin === 'string'
          ? body.mustJoin
              .split(',')
              .map(function(s) {
                return s.trim();
              })
              .filter(Boolean)
              .slice(0, 10)
          : body.mustJoin;
    }

    if (body.nonMust !== undefined) {
      u.nonMust =
        typeof body.nonMust === 'string'
          ? body.nonMust
              .split(',')
              .map(function(s) {
                return s.trim();
              })
              .filter(Boolean)
              .slice(0, 10)
          : body.nonMust;
    }

    if (body.tasks !== undefined) {
      u.tasks =
        (body.tasks || [])
          .map(function(t) {
            return {
              n: t.n,
              l: t.l,
              reward:
                Number(
                  t.reward || 0
                )
            };
          });
    }

    if (body.botDetect !== undefined) {
      u.botDetect =
        body.botDetect === true;
    }

    if (body.coAdmins !== undefined) {
      u.coAdmins =
        typeof body.coAdmins === 'string'
          ? body.coAdmins
              .split(',')
              .map(function(s) {
                return s.trim();
              })
              .filter(Boolean)
          : body.coAdmins;
    }

    await db
      .collection('bots')
      .doc(req.params.id)
      .update(u);

    // AUTO-REACTIVATE
    const doc =
      await db
        .collection('bots')
        .doc(req.params.id)
        .get();

    if (
      doc.exists &&
      doc.data().status === 'deactivated'
    ) {
      try {
        const v =
          await axios.get(
            'https://api.telegram.org/bot' +
              doc.data().token +
              '/getMe',
            {
              timeout: 5000
            }
          );

        if (v.data.ok) {
          await db
            .collection('bots')
            .doc(req.params.id)
            .update({
              status: 'active',
              deactivationReason: ''
            });

          console.log(
            '[settings] auto-reactivated bot ' +
              req.params.id
          );
        }

      } catch (e) {}
    }

    await engine.restartBot(
      req.params.id
    );

    const after =
      await db
        .collection('bots')
        .doc(req.params.id)
        .get();

    const d =
      after.exists
        ? after.data()
        : {};

    return res.json({
      success: true,
      saved: {
        botDetect:
          !!d.botDetect,

        withdrawFee:
          Number(
            d.withdrawFee || 0
          ),

        minW: d.minW,
        maxW: d.maxW,
        refBonus: d.refBonus
      }
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// DELETE BOT
// ============================================================

app.delete('/api/bot/:id', async (req, res) => {
  try {
    engine.stopBot(
      req.params.id
    );

    const subs = [
      'users',
      'withdrawals',
      'proofs'
    ];

    for (const sub of subs) {
      const snap =
        await db
          .collection('bots')
          .doc(req.params.id)
          .collection(sub)
          .limit(500)
          .get();

      const batch =
        db.batch();

      snap.docs.forEach(function(d) {
        batch.delete(d.ref);
      });

      await batch.commit();
    }

    await db
      .collection('bots')
      .doc(req.params.id)
      .delete();

    return res.json({
      success: true
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// BOT BROADCAST
// ============================================================

app.post('/api/bot/:id/broadcast', async (req, res) => {
  try {
    const message =
      req.body.message;

    if (!message) {
      return res.status(400).json({
        error: 'Message required'
      });
    }

    const doc =
      await db
        .collection('bots')
        .doc(req.params.id)
        .get();

    if (!doc.exists) {
      return res.status(404).json({
        error: 'Not found'
      });
    }

    const token =
      doc.data().token;

    const u =
      await db
        .collection('bots')
        .doc(req.params.id)
        .collection('users')
        .limit(5000)
        .get();

    let sent = 0;
    let failed = 0;

    for (const x of u.docs) {
      try {
        await axios.post(
          'https://api.telegram.org/bot' +
            token +
            '/sendMessage',
          {
            chat_id: x.id,
            text: message,
            parse_mode: 'HTML'
          },
          {
            timeout: 5000
          }
        );

        sent++;

      } catch (e) {
        try {
          await axios.post(
            'https://api.telegram.org/bot' +
              token +
              '/sendMessage',
            {
              chat_id: x.id,
              text: message
            },
            {
              timeout: 5000
            }
          );

          sent++;

        } catch (e2) {
          failed++;
        }
      }

      await new Promise(function(r) {
        setTimeout(r, 35);
      });
    }

    return res.json({
      success: true,
      sent: sent,
      failed: failed
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// PLATFORM ADMIN BROADCAST
// ============================================================

app.post('/api/admin/broadcast', async (req, res) => {
  try {
    if (!process.env.OWNER_KEY) {
      return res.status(500).json({
        error:
          'OWNER_KEY is NOT set in Render Environment Variables!'
      });
    }

    const key =
      req.headers['x-admin-key'];

    if (
      !key ||
      key !== process.env.OWNER_KEY
    ) {
      return res.status(403).json({
        error: 'Invalid owner key'
      });
    }

    const message =
      req.body.message;

    if (!message) {
      return res.status(400).json({
        error: 'Message required'
      });
    }

    const bots =
      await db
        .collection('bots')
        .where(
          'status',
          '==',
          'active'
        )
        .get();

    if (bots.empty) {
      return res.json({
        success: true,
        sent: 0,
        failed: 0,
        bots: 0,
        note:
          'No active bots have users yet'
      });
    }

    let sent = 0;
    let failed = 0;

    for (const b of bots.docs) {
      try {
        const token =
          b.data().token;

        const u =
          await db
            .collection('bots')
            .doc(b.id)
            .collection('users')
            .limit(5000)
            .get();

        for (const x of u.docs) {
          try {
            await axios.post(
              'https://api.telegram.org/bot' +
                token +
                '/sendMessage',
              {
                chat_id: x.id,
                text: message,
                parse_mode: 'HTML'
              },
              {
                timeout: 5000
              }
            );

            sent++;

          } catch (e1) {
            try {
              await axios.post(
                'https://api.telegram.org/bot' +
                  token +
                  '/sendMessage',
                {
                  chat_id: x.id,
                  text: message
                },
                {
                  timeout: 5000
                }
              );

              sent++;

            } catch (e2) {
              failed++;
            }
          }

          await new Promise(function(r) {
            setTimeout(r, 35);
          });
        }

      } catch (eBot) {
        console.log(
          '[broadcast] bot ' +
            b.id +
            ' error: ' +
            eBot.message
        );
      }
    }

    return res.json({
      success: true,
      sent: sent,
      failed: failed,
      bots: bots.size
    });

  } catch (e) {
    console.error(
      '[broadcast] fatal:',
      e.message
    );

    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// USER MANAGEMENT
// ============================================================

app.post('/api/bot/:id/users/:uid/update', async (req, res) => {
  try {
    const body = req.body;

    const ref =
      db
        .collection('bots')
        .doc(req.params.id)
        .collection('users')
        .doc(
          String(req.params.uid)
        );

    const u = {};

    if (body.banned !== undefined) {
      u.banned =
        body.banned === true;
    }

    if (body.addBalance !== undefined) {
      u.balance =
        admin.firestore.FieldValue.increment(
          parseFloat(
            body.addBalance
          )
        );
    }

    if (body.setBalance !== undefined) {
      u.balance =
        parseFloat(
          body.setBalance
        );
    }

    await ref.set(
      u,
      {
        merge: true
      }
    );

    return res.json({
      success: true
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// TASK PROOFS
// ============================================================

app.post('/api/bot/:id/proofs/:pid/resolve', async (req, res) => {
  try {
    const approve =
      !!req.body.approve;

    const ref =
      db
        .collection('bots')
        .doc(req.params.id)
        .collection('proofs')
        .doc(req.params.pid);

    const doc =
      await ref.get();

    if (!doc.exists) {
      return res.status(404).json({
        error: 'Proof already resolved'
      });
    }

    const p =
      doc.data();

    if (approve && p.reward) {
      try {
        await db
          .collection('bots')
          .doc(req.params.id)
          .collection('users')
          .doc(p.uid)
          .update({
            balance:
              admin.firestore.FieldValue.increment(
                p.reward
              )
          });
      } catch (e) {}

      await engine.sendTo(
        req.params.id,
        p.uid,
        '✅ <b>Your task proof was APPROVED!</b>\n\n' +
          '🎁 You earned <b>' +
          p.reward +
          '</b>!'
      );

    } else {
      await engine.sendTo(
        req.params.id,
        p.uid,
        approve
          ? '✅ <b>Your task proof was APPROVED!</b>'
          : '❌ <b>Your task proof was declined.</b>'
      );
    }

    await ref.delete();

    return res.json({
      success: true
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// ============================================================
// PAYMENT SYSTEM
// ============================================================
// ============================================================
//
// Auto Pay 1 = PT Exchange
// Auto Pay 2 = xRocket
// Manual   = pending/manual
//
// The frontend/bot should call:
//
// POST /api/withdraw
//
// or existing compatibility:
//
// POST /pay/notcoin
// POST /pay/jetton
//
// ============================================================

// ============================================================
// PT EXCHANGE
// ============================================================

async function payWithPTExchange({
  wallet,
  amount,
  currency,
  clientWithdrawalId
}) {
  const apiKey =
    process.env.PT_API_KEY ||
    process.env.PT_EXCHANGE_API_KEY;

  if (!apiKey) {
    throw new Error(
      'PT_API_KEY is not configured'
    );
  }

  /*
   * Keep the endpoint configurable.
   *
   * Default endpoint follows the PT Exchange
   * jetton payment setup used by your NOTCOIN backend.
   */
  const url =
    process.env.PT_API_URL ||
    'https://api.ptexchange.app/pay/jetton';

  const payload = {
    wallet: wallet,
    amount: amount,
    jetton_symbol: currency,

    // Optional idempotency identifier.
    clientWithdrawalId:
      clientWithdrawalId
  };

  const headers = {
    'Content-Type':
      'application/json',
    Accept:
      'application/json',

    // Standard backend authentication.
    Authorization:
      'Bearer ' + apiKey,

    // Compatibility with APIs that read API keys
    // from a dedicated header.
    'X-API-Key': apiKey
  };

  const response =
    await axios.post(
      url,
      payload,
      {
        headers: headers,
        timeout: 30000,
        validateStatus:
          function(status) {
            return status >= 200 &&
              status < 500;
          }
      }
    );

  if (
    response.status < 200 ||
    response.status >= 300
  ) {
    const error =
      response.data || {};

    const message =
      error.error ||
      error.message ||
      error.detail ||
      (
        'PT Exchange returned HTTP ' +
        response.status
      );

    const err =
      new Error(message);

    err.status =
      response.status;

    err.providerResponse =
      response.data;

    throw err;
  }

  return {
    provider: 'pt_exchange',
    status: 'success',
    data: response.data
  };
}

// ============================================================
// xROCKET
// ============================================================

async function payWithXRocket({
  telegramUserId,
  amount,
  currency,
  clientPayoutId,
  description
}) {
  const token =
    process.env.XROCKET_API_KEY ||
    process.env.XROCKET_TOKEN;

  if (!token) {
    throw new Error(
      'XROCKET_API_KEY is not configured'
    );
  }

  if (!telegramUserId) {
    throw new Error(
      'Telegram user ID is required for xRocket Auto Pay 2'
    );
  }

  /*
   * Current xRocket Pay API.
   *
   * Production:
   * https://pay.api.xrocket.exchange/api/v1/payouts
   *
   * The endpoint can still be overridden in Render.
   */
  const url =
    process.env.XROCKET_PAYOUT_URL ||
    'https://pay.api.xrocket.exchange/api/v1/payouts';

  const payload = {
    clientPayoutId:
      clientPayoutId,

    target:
      String(telegramUserId),

    targetType:
      'telegram_user_id',

    asset:
      normalizeCurrency(currency),

    amount:
      String(amount),

    description:
      description ||
      'Bot reward withdrawal'
  };

  const response =
    await axios.post(
      url,
      payload,
      {
        headers: {
          Authorization:
            'Bearer ' + token,

          'Content-Type':
            'application/json',

          Accept:
            'application/json'
        },

        timeout: 30000,

        validateStatus:
          function(status) {
            return status >= 200 &&
              status < 500;
          }
      }
    );

  if (
    response.status < 200 ||
    response.status >= 300
  ) {
    const error =
      response.data || {};

    const message =
      error.detail ||
      error.message ||
      error.title ||
      error.error ||
      (
        'xRocket returned HTTP ' +
        response.status
      );

    const err =
      new Error(message);

    err.status =
      response.status;

    err.providerResponse =
      response.data;

    throw err;
  }

  const data =
    response.data || {};

  /*
   * Current xRocket Pay API returns
   * the payout object directly.
   *
   * Successful payout should have a valid
   * payout response. We accept finished and
   * pending because the API can expose status.
   */
  const status =
    cleanString(
      data.status
    ).toLowerCase();

  if (
    status === 'failed'
  ) {
    const err =
      new Error(
        'xRocket payout failed'
      );

    err.status =
      response.status;

    err.providerResponse =
      data;

    throw err;
  }

  return {
    provider: 'xrocket',
    status:
      status || 'success',
    data: data
  };
}

// ============================================================
// CREATE WITHDRAWAL RECORD
// ============================================================

async function createWithdrawalRecord({
  botId,
  uid,
  amount,
  currency,
  provider,
  wallet,
  telegramUserId,
  fee,
  clientId
}) {
  const ref =
    await db
      .collection('bots')
      .doc(botId)
      .collection('withdrawals')
      .add({
        uid: String(uid || ''),
        amount: Number(amount),
        currency:
          normalizeCurrency(currency),

        provider:
          normalizeProvider(provider),

        wallet:
          wallet || '',

        telegramUserId:
          String(
            telegramUserId || ''
          ),

        fee:
          Number(fee || 0),

        clientId:
          clientId || '',

        status:
          'processing',

        createdAt:
          Date.now(),

        updatedAt:
          Date.now()
      });

  return ref;
}

// ============================================================
// UNIVERSAL WITHDRAWAL
// ============================================================

app.post('/api/withdraw', async (req, res) => {
  try {
    if (!checkBackendSecret(req)) {
      return res.status(403).json({
        ok: false,
        success: false,
        error: 'Invalid backend secret'
      });
    }

    const body =
      req.body || {};

    const botId =
      cleanString(
        body.botId ||
        body.bot ||
        body.bot_id
      );

    const uid =
      cleanString(
        body.uid ||
        body.userId ||
        body.telegramUserId
      );

    const amount =
      safeAmount(
        body.amount
      );

    const currency =
      normalizeCurrency(
        body.currency ||
        body.asset ||
        body.jetton ||
        'NOT'
      );

    const provider =
      getProviderFromBody(body);

    const wallet =
      getWalletFromBody(body);

    const telegramUserId =
      getTelegramUserId(body);

    if (!amount) {
      return res.status(400).json({
        ok: false,
        success: false,
        error: 'Invalid amount'
      });
    }

    if (!provider) {
      return res.status(400).json({
        ok: false,
        success: false,
        error: 'Payment provider required'
      });
    }

    if (!currency) {
      return res.status(400).json({
        ok: false,
        success: false,
        error: 'Currency required'
      });
    }

    /*
     * PT Exchange sends to an external wallet.
     */
    if (
      provider === 'pt_exchange' &&
      !wallet
    ) {
      return res.status(400).json({
        ok: false,
        success: false,
        error:
          'Wallet address required for PT Exchange'
      });
    }

    /*
     * xRocket sends to a Telegram/xRocket user.
     */
    if (
      provider === 'xrocket' &&
      !telegramUserId
    ) {
      return res.status(400).json({
        ok: false,
        success: false,
        error:
          'Telegram user ID required for xRocket'
      });
    }

    const clientId =
      cleanString(
        body.clientWithdrawalId ||
        body.clientPayoutId
      ) ||
      makeClientId(
        'withdraw',
        botId,
        uid
      );

    // --------------------------------------------------------
    // MANUAL
    // --------------------------------------------------------

    if (provider === 'manual') {
      if (!botId) {
        return res.status(400).json({
          ok: false,
          success: false,
          error:
            'botId required for manual withdrawal'
        });
      }

      const ref =
        await createWithdrawalRecord({
          botId,
          uid,
          amount,
          currency,
          provider,
          wallet,
          telegramUserId,
          fee: body.fee || 0,
          clientId
        });

      await ref.update({
        status: 'pending_manual',
        updatedAt: Date.now()
      });

      return res.json({
        ok: true,
        success: true,
        provider: 'manual',
        status: 'pending_manual',
        withdrawalId: ref.id,
        clientId: clientId,
        message:
          'Withdrawal submitted for manual processing'
      });
    }

    // --------------------------------------------------------
    // PT EXCHANGE
    // --------------------------------------------------------

    if (provider === 'pt_exchange') {
      const withdrawalRef =
        botId
          ? await createWithdrawalRecord({
              botId,
              uid,
              amount,
              currency,
              provider,
              wallet,
              telegramUserId,
              fee: body.fee || 0,
              clientId
            })
          : null;

      try {
        const result =
          await payWithPTExchange({
            wallet,
            amount,
            currency,
            clientWithdrawalId:
              clientId
          });

        if (withdrawalRef) {
          await withdrawalRef.update({
            status: 'paid',
            providerResponse:
              result.data,
            paidAt: Date.now(),
            updatedAt: Date.now()
          });
        }

        return res.json({
          ok: true,
          success: true,
          provider: 'pt_exchange',
          status: 'paid',
          currency,
          amount,
          wallet,
          clientId,
          result: result.data
        });

      } catch (e) {
        if (withdrawalRef) {
          await withdrawalRef.update({
            status: 'failed',
            error:
              e.message,
            providerStatus:
              e.status || null,
            providerResponse:
              e.providerResponse || null,
            updatedAt: Date.now()
          });
        }

        console.error(
          '[PT Exchange]',
          e.message
        );

        return res.status(
          e.status &&
          e.status >= 400 &&
          e.status < 600
            ? e.status
            : 502
        ).json({
          ok: false,
          success: false,
          provider: 'pt_exchange',
          status: 'failed',
          error: e.message,
          clientId
        });
      }
    }

    // --------------------------------------------------------
    // xROCKET
    // --------------------------------------------------------

    if (provider === 'xrocket') {
      const withdrawalRef =
        botId
          ? await createWithdrawalRecord({
              botId,
              uid,
              amount,
              currency,
              provider,
              wallet,
              telegramUserId,
              fee: body.fee || 0,
              clientId
            })
          : null;

      try {
        const result =
          await payWithXRocket({
            telegramUserId,
            amount,
            currency,
            clientPayoutId:
              clientId,
            description:
              body.description ||
              'Bot reward withdrawal'
          });

        if (withdrawalRef) {
          await withdrawalRef.update({
            status:
              result.status === 'finished'
                ? 'paid'
                : result.status,
            providerResponse:
              result.data,
            paidAt:
              result.status === 'finished'
                ? Date.now()
                : null,
            updatedAt: Date.now()
          });
        }

        return res.json({
          ok: true,
          success: true,
          provider: 'xrocket',
          status:
            result.status,
          currency,
          amount,
          telegramUserId,
          clientId,
          result: result.data
        });

      } catch (e) {
        if (withdrawalRef) {
          await withdrawalRef.update({
            status: 'failed',
            error:
              e.message,
            providerStatus:
              e.status || null,
            providerResponse:
              e.providerResponse || null,
            updatedAt: Date.now()
          });
        }

        console.error(
          '[xRocket]',
          e.message
        );

        return res.status(
          e.status &&
          e.status >= 400 &&
          e.status < 600
            ? e.status
            : 502
        ).json({
          ok: false,
          success: false,
          provider: 'xrocket',
          status: 'failed',
          error: e.message,
          clientId
        });
      }
    }

    return res.status(400).json({
      ok: false,
      success: false,
      error:
        'Unsupported payment provider: ' +
        provider
    });

  } catch (e) {
    console.error(
      '[withdraw] fatal:',
      e
    );

    return res.status(500).json({
      ok: false,
      success: false,
      error: e.message
    });
  }
});

// ============================================================
// NOTCOIN COMPATIBILITY ROUTE
// ============================================================
//
// Your existing NOTCOIN bot was calling:
//
// POST /pay/notcoin
//
// Keep this route so the old bot does not need to be rebuilt
// just because the backend was upgraded.
//

app.post('/pay/notcoin', async (req, res) => {
  try {
    const body =
      req.body || {};

    const wallet =
      getWalletFromBody(body);

    const amount =
      safeAmount(
        body.amount
      );

    if (!wallet) {
      return res.status(400).json({
        ok: false,
        success: false,
        error: 'wallet is required'
      });
    }

    if (!amount) {
      return res.status(400).json({
        ok: false,
        success: false,
        error: 'Invalid amount'
      });
    }

    /*
     * The old NOTCOIN backend uses PT Exchange.
     */
    const clientId =
      cleanString(
        body.clientWithdrawalId ||
        body.clientPayoutId
      ) ||
      makeClientId(
        'not',
        body.botId || 'notcoin',
        body.uid || body.userId
      );

    const result =
      await payWithPTExchange({
        wallet,
        amount,
        currency: 'NOT',
        clientWithdrawalId:
          clientId
      });

    return res.json({
      ok: true,
      success: true,
      provider: 'pt_exchange',
      currency: 'NOT',
      amount,
      wallet,
      clientId,
      result: result.data
    });

  } catch (e) {
    console.error(
      '[NOTCOIN]',
      e.message,
      e.providerResponse || ''
    );

    return res.status(
      e.status &&
      e.status >= 400 &&
      e.status < 600
        ? e.status
        : 502
    ).json({
      ok: false,
      success: false,
      provider: 'pt_exchange',
      currency: 'NOT',
      error: e.message,
      details:
        e.providerResponse || null
    });
  }
});

// ============================================================
// GENERIC JETTON COMPATIBILITY ROUTE
// ============================================================
//
// Supports:
//
// NOT
// USDT
// USDC
// DOGS
// and other PT Exchange jettons.
//

app.post('/pay/jetton', async (req, res) => {
  try {
    const body =
      req.body || {};

    const wallet =
      getWalletFromBody(body);

    const amount =
      safeAmount(
        body.amount
      );

    const currency =
      normalizeCurrency(
        body.jetton_symbol ||
        body.currency ||
        body.asset
      );

    if (!wallet) {
      return res.status(400).json({
        ok: false,
        success: false,
        error: 'wallet is required'
      });
    }

    if (!amount) {
      return res.status(400).json({
        ok: false,
        success: false,
        error: 'Invalid amount'
      });
    }

    if (!currency) {
      return res.status(400).json({
        ok: false,
        success: false,
        error:
          'jetton_symbol/currency is required'
      });
    }

    const clientId =
      cleanString(
        body.clientWithdrawalId ||
        body.clientPayoutId
      ) ||
      makeClientId(
        'jetton',
        body.botId || 'bot',
        body.uid || body.userId
      );

    const result =
      await payWithPTExchange({
        wallet,
        amount,
        currency,
        clientWithdrawalId:
          clientId
      });

    return res.json({
      ok: true,
      success: true,
      provider: 'pt_exchange',
      currency,
      amount,
      wallet,
      clientId,
      result: result.data
    });

  } catch (e) {
    console.error(
      '[JETTON]',
      e.message,
      e.providerResponse || ''
    );

    return res.status(
      e.status &&
      e.status >= 400 &&
      e.status < 600
        ? e.status
        : 502
    ).json({
      ok: false,
      success: false,
      error: e.message,
      details:
        e.providerResponse || null
    });
  }
});

// ============================================================
// xROCKET COMPATIBILITY ROUTE
// ============================================================
//
// POST /pay/xrocket
//
// This is useful for existing bots that already use a
// dedicated xRocket backend endpoint.
//

app.post('/pay/xrocket', async (req, res) => {
  try {
    const body =
      req.body || {};

    const telegramUserId =
      getTelegramUserId(body);

    const amount =
      safeAmount(
        body.amount
      );

    const currency =
      normalizeCurrency(
        body.currency ||
        body.asset
      );

    if (!telegramUserId) {
      return res.status(400).json({
        ok: false,
        success: false,
        error:
          'telegramUserId is required'
      });
    }

    if (!amount) {
      return res.status(400).json({
        ok: false,
        success: false,
        error: 'Invalid amount'
      });
    }

    if (!currency) {
      return res.status(400).json({
        ok: false,
        success: false,
        error: 'Currency required'
      });
    }

    const clientId =
      cleanString(
        body.clientPayoutId ||
        body.clientWithdrawalId
      ) ||
      makeClientId(
        'rocket',
        body.botId || 'bot',
        telegramUserId
      );

    const result =
      await payWithXRocket({
        telegramUserId,
        amount,
        currency,
        clientPayoutId:
          clientId,
        description:
          body.description ||
          'Bot reward withdrawal'
      });

    return res.json({
      ok: true,
      success: true,
      provider: 'xrocket',
      currency,
      amount,
      telegramUserId,
      clientId,
      status:
        result.status,
      result:
        result.data
    });

  } catch (e) {
    console.error(
      '[xRocket route]',
      e.message,
      e.providerResponse || ''
    );

    return res.status(
      e.status &&
      e.status >= 400 &&
      e.status < 600
        ? e.status
        : 502
    ).json({
      ok: false,
      success: false,
      provider: 'xrocket',
      error: e.message,
      details:
        e.providerResponse || null
    });
  }
});

// ============================================================
// WITHDRAWAL LIST
// ============================================================

app.get('/api/bot/:id/withdrawals', async (req, res) => {
  try {
    const snap =
      await db
        .collection('bots')
        .doc(req.params.id)
        .collection('withdrawals')
        .limit(500)
        .get();

    const withdrawals =
      snap.docs.map(function(d) {
        return Object.assign(
          { id: d.id },
          d.data()
        );
      });

    return res.json({
      success: true,
      withdrawals
    });

  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

// ============================================================
// MANUAL WITHDRAWAL APPROVAL
// ============================================================

app.post(
  '/api/bot/:id/withdrawals/:wid/resolve',
  async (req, res) => {
    try {
      if (!process.env.OWNER_KEY) {
        return res.status(500).json({
          success: false,
          error:
            'OWNER_KEY is not configured'
        });
      }

      const key =
        req.headers['x-admin-key'];

      if (
        !key ||
        key !== process.env.OWNER_KEY
      ) {
        return res.status(403).json({
          success: false,
          error: 'Invalid owner key'
        });
      }

      const ref =
        db
          .collection('bots')
          .doc(req.params.id)
          .collection('withdrawals')
          .doc(req.params.wid);

      const doc =
        await ref.get();

      if (!doc.exists) {
        return res.status(404).json({
          success: false,
          error: 'Withdrawal not found'
        });
      }

      const approve =
        req.body.approve === true;

      await ref.update({
        status:
          approve
            ? 'paid_manual'
            : 'declined',
        resolvedAt:
          Date.now(),
        updatedAt:
          Date.now(),
        adminNote:
          req.body.note || ''
      });

      return res.json({
        success: true,
        status:
          approve
            ? 'paid_manual'
            : 'declined'
      });

    } catch (e) {
      return res.status(500).json({
        success: false,
        error: e.message
      });
    }
  }
);

// ============================================================
// OLD PAYMENT SYSTEM
// ============================================================

async function applyPayment(
  memo,
  amount,
  currency,
  txHash,
  sender
) {
  const parts =
    String(memo || '')
      .split('_');

  const type =
    parts[1];

  if (type === 'PREMIUM') {
    const uid =
      parts[2];

    const expires =
      new Date(
        Date.now() +
          30 *
          24 *
          60 *
          60 *
          1000
      ).toISOString();

    await db
      .collection('users')
      .doc(uid)
      .set(
        {
          isPremium: true,
          premiumExpiresAt:
            expires,
          premiumMethod:
            currency,
          premiumTxHash:
            txHash
        },
        {
          merge: true
        }
      );

    return {
      type: type,
      uid: uid
    };
  }

  if (type === 'UPLOAD') {
    return {
      type: type,
      uid: parts[2]
    };
  }

  if (type === 'BUY') {
    const itemId =
      parts[2];

    const uid =
      parts[3];

    const itemRef =
      db
        .collection('storeTemplates')
        .doc(itemId);

    const item =
      await itemRef.get();

    if (!item.exists) {
      return {
        type: type,
        error: 'item gone'
      };
    }

    const d =
      item.data();

    if (d.status === 'sold') {
      return {
        type: type,
        error: 'already sold'
      };
    }

    await itemRef.update({
      status: 'sold',
      soldTo: uid,
      soldAt: Date.now()
    });

    await db
      .collection('users')
      .doc(uid)
      .set(
        {
          purchasedTemplates:
            admin.firestore.FieldValue.arrayUnion(
              itemId
            )
        },
        {
          merge: true
        }
      );

    await db
      .collection('sales')
      .add({
        itemId: itemId,
        item: d.name,
        price: d.price,
        sellerId:
          d.sellerId,
        sellerWallet:
          d.sellerWallet,
        buyerId: uid,
        currency:
          currency,
        txHash:
          txHash,
        at: Date.now()
      });

    await notifyOwner(
      '🛒 <b>ITEM SOLD!</b>\n\n' +
      '📦 ' +
      d.name +
      '\n' +
      '💵 Price: ' +
      d.price +
      '\n' +
      '👛 Seller wallet: <code>' +
      (d.sellerWallet || 'none') +
      '</code>\n\n' +
      'Send the seller their money.'
    );

    return {
      type: type,
      uid: uid,
      itemId: itemId,
      link: d.link
    };
  }

  return {
    type: 'unknown'
  };
}

// ============================================================
// CHECK PAYMENT
// ============================================================

app.post('/api/check-payment', async (req, res) => {
  try {
    const memo =
      req.body.memo;

    if (!memo) {
      return res.status(400).json({
        error: 'Memo required'
      });
    }

    const snap =
      await db
        .collection('payments')
        .where(
          'memo',
          '==',
          memo
        )
        .where(
          'status',
          '==',
          'confirmed'
        )
        .limit(1)
        .get();

    if (snap.empty) {
      return res.json({
        confirmed: false
      });
    }

    const p =
      snap.docs[0].data();

    return res.json({
      confirmed: true,
      type: p.payType,
      link:
        p.link || null
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// PROCESS PAYMENT
// ============================================================

app.post('/api/process-payment', async (req, res) => {
  try {
    const body =
      req.body;

    if (
      !body.txHash ||
      !body.memo
    ) {
      return res.status(400).json({
        error:
          'Missing fields'
      });
    }

    const exist =
      await db
        .collection('payments')
        .where(
          'txHash',
          '==',
          body.txHash
        )
        .limit(1)
        .get();

    if (!exist.empty) {
      return res.json({
        success: true,
        message:
          'already processed'
      });
    }

    const result =
      await applyPayment(
        body.memo,
        body.amount,
        body.currency,
        body.txHash,
        body.sender
      );

    await db
      .collection('payments')
      .add({
        txHash:
          body.txHash,
        memo:
          body.memo,
        amount:
          body.amount,
        currency:
          body.currency,
        sender:
          body.sender,
        status:
          'confirmed',
        payType:
          result.type,
        link:
          result.link ||
          null,
        at:
          Date.now()
      });

    return res.json({
      success: true,
      result:
        result
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// NAIRA MANUAL APPROVAL
// ============================================================

app.post(
  '/api/admin/payments/:pid/approve',
  async (req, res) => {
    try {
      const key =
        req.headers['x-admin-key'];

      if (
        !key ||
        key !== process.env.OWNER_KEY
      ) {
        return res.status(403).json({
          error:
            'Invalid owner key'
        });
      }

      const ref =
        db
          .collection('payments')
          .doc(req.params.pid);

      const doc =
        await ref.get();

      if (!doc.exists) {
        return res.status(404).json({
          error: 'Not found'
        });
      }

      const p =
        doc.data();

      const result =
        await applyPayment(
          p.memo,
          p.amount,
          'NGN',
          p.ref,
          p.ownerId
        );

      await ref.update({
        status:
          'confirmed',
        payType:
          result.type,
        link:
          result.link ||
          null
      });

      return res.json({
        success: true,
        result:
          result
      });

    } catch (e) {
      return res.status(500).json({
        error: e.message
      });
    }
  }
);

// ============================================================
// PROFILE
// ============================================================

app.get('/api/user/:uid/profile', async (req, res) => {
  try {
    const doc =
      await db
        .collection('users')
        .doc(req.params.uid)
        .get();

    return res.json({
      success: true,
      profile:
        doc.exists
          ? doc.data()
          : {
              isPremium: false
            }
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// STORE
// ============================================================

app.get('/api/store/templates', async (req, res) => {
  try {
    const snap =
      await db
        .collection('storeTemplates')
        .where(
          'active',
          '==',
          true
        )
        .get();

    const t = [];

    snap.forEach(function(d) {
      t.push(
        Object.assign(
          { id: d.id },
          d.data()
        )
      );
    });

    return res.json({
      success: true,
      templates: t
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// STORE ADD
// ============================================================

app.post('/api/store/add', async (req, res) => {
  try {
    const key =
      req.headers['x-admin-key'];

    if (
      !key ||
      key !== process.env.OWNER_KEY
    ) {
      return res.status(403).json({
        error:
          'Invalid owner key'
      });
    }

    const item =
      req.body;

    if (
      !item.name ||
      !item.price
    ) {
      return res.status(400).json({
        error:
          'Name and price required'
      });
    }

    const doc =
      await db
        .collection('storeTemplates')
        .add(
          Object.assign(
            {},
            item,
            {
              sellerId:
                'OWNER',

              sellerWallet:
                '',

              status:
                'available',

              active:
                true,

              createdAt:
                Date.now()
            }
          )
        );

    return res.json({
      success: true,
      id: doc.id
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// STORE UPLOAD
// ============================================================

app.post('/api/store/upload', async (req, res) => {
  try {
    const b =
      req.body;

    if (
      !b.sellerId ||
      !b.name ||
      !b.link
    ) {
      return res.status(400).json({
        error:
          'Missing fields'
      });
    }

    const doc =
      await db
        .collection('storeTemplates')
        .add({
          name:
            b.name,

          desc:
            b.desc || '',

          icon:
            b.icon ||
            'bi-robot',

          type:
            b.type ||
            'bot',

          link:
            b.link,

          price:
            b.price ||
            '1 TON',

          sellerId:
            b.sellerId,

          sellerWallet:
            b.wallet ||
            '',

          status:
            'available',

          active:
            true,

          createdAt:
            Date.now()
        });

    await notifyOwner(
      '📦 <b>New store upload!</b>\n\n' +
      '🏷 ' +
      b.name +
      '\n' +
      '👤 Seller: ' +
      b.sellerId +
      '\n' +
      '👛 Seller wallet: <code>' +
      (b.wallet || 'none') +
      '</code>'
    );

    return res.json({
      success: true,
      id: doc.id
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// STORE PURCHASE
// ============================================================

app.post('/api/store/purchase', async (req, res) => {
  try {
    const b =
      req.body;

    await db
      .collection('users')
      .doc(b.userId)
      .set(
        {
          purchasedTemplates:
            admin.firestore.FieldValue.arrayUnion(
              b.templateId
            )
        },
        {
          merge: true
        }
      );

    return res.json({
      success: true
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
});

// ============================================================
// PREMIUM EXPIRY
// ============================================================

cron.schedule(
  '0 0 * * *',
  async () => {
    try {
      const now =
        new Date().toISOString();

      const snap =
        await db
          .collection('users')
          .where(
            'isPremium',
            '==',
            true
          )
          .where(
            'premiumExpiresAt',
            '<',
            now
          )
          .get();

      for (const d of snap.docs) {
        await d.ref.update({
          isPremium:
            false
        });
      }

    } catch (e) {
      console.error(
        '[cron] premium expiry error:',
        e.message
      );
    }
  }
);

// ============================================================
// START
// ============================================================

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  function() {
    console.log(
      'Clur Backend ' +
        SERVER_VERSION +
        ' on port ' +
        PORT
    );

    console.log(
      '[payments] PT Exchange:',
      !!process.env.PT_API_KEY
    );

    console.log(
      '[payments] xRocket:',
      !!process.env.XROCKET_API_KEY
    );

    engine.loadAllBots();

    const APP_URL =
      process.env.APP_URL || '';

    if (APP_URL) {
      setInterval(
        function() {
          axios
            .get(
              APP_URL +
                '/ping',
              {
                timeout: 3000
              }
            )
            .catch(
              function() {}
            );
        },
        1000
      );

      console.log(
        '[keepalive] pinging every 1 second - service will never sleep'
      );

    } else {
      console.log(
        '[keepalive] APP_URL not set - self-ping disabled'
      );
    }
  }
);

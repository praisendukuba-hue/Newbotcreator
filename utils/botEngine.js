require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { db, admin } = require('../firebase'); 

const activeBots = {};
const pendingProofs = new Map();
const API_BASE = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

function startBot(botData) {
  if (activeBots[botData.id]) {
    console.log(`[Engine] Bot ${botData.id} already running.`);
    return;
  }

  try {
    const bot = new TelegramBot(botData.token, { polling: true });
    botData.users = botData.users || 0;

    bot.onText(/\/start/, async (msg) => {
      try {
        const chatId = msg.chat.id;
        const userId = String(msg.from.id);
        const firstName = msg.from.first_name || 'User';
        const userRef = db.collection('bots').doc(botData.id).collection('users').doc(userId);
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
          await userRef.set({ id: userId, firstName, balance: 0, banned: false, joinedAt: new Date().toISOString() });
          botData.users += 1;
        } else if (userDoc.data().banned) {
          return bot.sendMessage(chatId, '🚫 You have been banned.');
        }

        const inlineKeyboard = [];
        const allChannels = [...(botData.mustJoin || []), ...(botData.nonMust || [])];
        
        // ✅ STEALTHY: No "required" text added, just the raw channel handle
        allChannels.forEach(channel => {
          inlineKeyboard.push([{ text: channel, url: `https://t.me/${channel.replace('@', '').trim()}` }]);
        });
        
        if (botData.officialChannel) {
          const offName = botData.officialChannel.replace('https://t.me/', '').replace('@', '');
          inlineKeyboard.push([{ text: `📢 ${offName}`, url: botData.officialChannel }]);
        }

        const welcomeText = `👋 Welcome, <b>${firstName}</b>!\n\n💰 Balance: <b>0 ${botData.currency || 'TON'}</b>\n\nPlease join the channels below:`;
        bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKeyboard } });
      } catch (err) {        console.error(`[Bot ${botData.id}] /start error:`, err.message);
      }
    });

    bot.on('photo', async (msg) => {
      try {
        const chatId = msg.chat.id;
        const userId = String(msg.from.id);
        const botId = botData.id;
        const proofKey = `${botId}_${userId}`;
        const pendingTask = pendingProofs.get(proofKey);

        if (!pendingTask) {
          return bot.sendMessage(chatId, '❌ No pending task. Please start a task first.');
        }

        bot.sendMessage(chatId, '⏳ Uploading proof...');
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const caption = msg.caption || '';

        const response = await axios.post(`${API_BASE}/api/bot/${botId}/submit-proof`, {
          userId, taskName: pendingTask.taskName, text: caption, photoFileId: fileId, botToken: botData.token
        }, { timeout: 15000 });

        if (response.data.success) {
          pendingProofs.delete(proofKey);
          bot.sendMessage(chatId, '✅ Proof submitted! Owner will review shortly.', { parse_mode: 'HTML' });
        } else {
          bot.sendMessage(chatId, '❌ Failed to submit proof.');
        }
      } catch (error) {
        console.error(`[Bot ${botData.id}] Photo error:`, error.message);
        bot.sendMessage(msg.chat.id, '❌ Upload error. Try again.');
      }
    });

    bot.on('text', async (msg) => {
      try {
        const chatId = msg.chat.id;
        const text = msg.text.trim();
        const userId = String(msg.from.id);
        const botId = botData.id;
        const proofKey = `${botId}_${userId}`;
        const pendingTask = pendingProofs.get(proofKey);

        if (pendingTask && text.toLowerCase() !== 'cancel') {
          bot.sendMessage(chatId, '⏳ Submitting text proof...');
          const response = await axios.post(`${API_BASE}/api/bot/${botId}/submit-proof`, {
            userId, taskName: pendingTask.taskName, text, photoFileId: null, botToken: botData.token
          }, { timeout: 15000 });
          if (response.data.success) {
            pendingProofs.delete(proofKey);
            bot.sendMessage(chatId, '✅ Proof submitted! Owner will review shortly.', { parse_mode: 'HTML' });
          } else {
            bot.sendMessage(chatId, '❌ Failed to submit proof.');
          }
          return;
        }

        if (text === '💰 Balance' || text === '/balance') {
          const userDoc = await db.collection('bots').doc(botId).collection('users').doc(userId).get();
          const bal = userDoc.exists ? userDoc.data().balance : 0;
          return bot.sendMessage(chatId, `💰 Balance: <b>${bal} ${botData.currency || 'TON'}</b>`, { parse_mode: 'HTML' });
        }

        if (text === '📤 Withdraw' || text === '/withdraw') {
          return bot.sendMessage(chatId, '📤 Withdrawal: Please use the main menu.');
        }

        if (text === '📋 Tasks' || text === '/tasks') {
          if (botData.tasks && botData.tasks.length > 0) {
            const task = botData.tasks[0];
            pendingProofs.set(proofKey, { taskName: task.n, taskReward: task.reward });
            return bot.sendMessage(chatId, `📌 <b>Task:</b> ${task.n}\n💰 <b>Reward:</b> ${task.reward} ${botData.currency}\n\nSend a <b>screenshot</b> or <b>text proof</b> here!`, {
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [[{ text: '🔗 Open Link', url: task.l }]] }
            });
          }
          return bot.sendMessage(chatId, 'No tasks available.');
        }

        bot.sendMessage(chatId, 'Use the menu below:', {
          reply_markup: { keyboard: [['💰 Balance'], ['📋 Tasks'], ['📤 Withdraw']], resize_keyboard: true }
        });
      } catch (err) {
        console.error(`[Bot ${botData.id}] Text error:`, err.message);
      }
    });

    activeBots[botData.id] = bot;
    console.log(`[Engine] ✅ Started: @${botData.username} (ID: ${botData.id})`);
  } catch (error) {
    console.error(`[Engine] ❌ Failed to start bot ${botData.id}:`, error.message);
  }
}

function stopBot(botId) {
  if (activeBots[botId]) {
    activeBots[botId].stopPolling().catch(() => {});    delete activeBots[botId];
    console.log(`[Engine] 🛑 Stopped: ${botId}`);
    return true;
  }
  return false;
}

async function restartBot(botId) {
  console.log(`[Engine] 🔄 Restarting: ${botId}`);
  stopBot(botId);
  try {
    const doc = await db.collection('bots').doc(botId).get();
    if (doc.exists) startBot(Object.assign({ id: doc.id }, doc.data()));
  } catch (e) {
    console.error(`[Engine] Restart failed for ${botId}:`, e.message);
  }
}

async function loadAllBots() {
  try {
    console.log('[Engine] Loading active bots...');
    const snap = await db.collection('bots').where('status', '==', 'active').get();
    let count = 0;
    snap.forEach((doc) => {
      startBot(Object.assign({ id: doc.id }, doc.data()));
      count++;
    });
    console.log(`[Engine] ✅ Loaded ${count} bots.`);
  } catch (e) {
    console.error('[Engine] Failed to load bots:', e.message);
  }
}

async function sendTo(botId, userId, text) {
  if (activeBots[botId]) {
    try {
      await activeBots[botId].sendMessage(userId, text, { parse_mode: 'HTML' });
      return true;
    } catch (e) {
      console.error(`[Engine] Send failed to ${userId} in ${botId}:`, e.message);
      return false;
    }
  }
  return false;
}

module.exports = { activeBots, startBot, stopBot, restartBot, loadAllBots, sendTo };

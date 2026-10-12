require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ✅ CRUCIAL: This MUST be ../firebase to go up one folder to the root directory
const { db, admin } = require('../firebase'); 

const activeBots = {};
const pendingProofs = new Map(); // Tracks users awaiting proof submission: "botId_userId" -> { taskName, reward }

const PORT = process.env.PORT || 3000;
const API_BASE = process.env.APP_URL || `http://localhost:${PORT}`;

// ==========================================
// 1. START A BOT
// ==========================================
function startBot(botData) {
  if (activeBots[botData.id]) {
    console.log(`[Engine] Bot ${botData.id} (@${botData.username}) is already running.`);
    return;
  }

  try {
    // Initialize bot. (Note: For 700+ bots, ensure your Render plan has enough RAM for polling connections)
    const bot = new TelegramBot(botData.token, { polling: true });
    botData.users = botData.users || 0;

    // --- /start Command ---
    bot.onText(/\/start/, async (msg) => {
      try {
        const chatId = msg.chat.id;
        const userId = String(msg.from.id);
        const firstName = msg.from.first_name || 'User';

        const userRef = db.collection('bots').doc(botData.id).collection('users').doc(userId);
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
          await userRef.set({
            id: userId,
            firstName: firstName,
            balance: 0,
            banned: false,
            joinedAt: new Date().toISOString()
          });
          botData.users += 1;
        } else {
          const uData = userDoc.data();
          if (uData.banned) {
            return bot.sendMessage(chatId, '🚫 You have been banned from using this bot.');          }
        }

        // ✅ STEALTHY CHANNEL BUTTONS: NO "REQUIRED" TEXT ADDED
        const inlineKeyboard = [];
        const allChannels = [...(botData.mustJoin || []), ...(botData.nonMust || [])];
        
        allChannels.forEach(channel => {
          const cleanChannel = channel.replace('@', '').trim();
          // Button text is EXACTLY the channel handle (e.g., "@mychannel")
          inlineKeyboard.push([{ text: channel, url: `https://t.me/${cleanChannel}` }]);
        });

        if (botData.officialChannel) {
          const offName = botData.officialChannel.replace('https://t.me/', '').replace('@', '');
          inlineKeyboard.push([{ text: `📢 ${offName}`, url: botData.officialChannel }]);
        }

        let welcomeText = `👋 Welcome, <b>${firstName}</b>!\n\n`;
        welcomeText += `💰 Your Balance: <b>0 ${botData.currency || 'TON'}</b>\n\n`;
        welcomeText += `Please join the channels below to get started:`;

        bot.sendMessage(chatId, welcomeText, { 
          parse_mode: 'HTML', 
          reply_markup: { inline_keyboard: inlineKeyboard } 
        });
      } catch (err) {
        console.error(`[Bot ${botData.id}] /start error:`, err.message);
      }
    });

    // ✅ HANDLE PHOTO PROOFS (Transforms image to Firestore via server endpoint)
    bot.on('photo', async (msg) => {
      try {
        const chatId = msg.chat.id;
        const userId = String(msg.from.id);
        const botId = botData.id;
        const proofKey = `${botId}_${userId}`;
        const pendingTask = pendingProofs.get(proofKey);

        if (!pendingTask) {
          return bot.sendMessage(chatId, '❌ You do not have a pending task. Please start a task first.');
        }

        bot.sendMessage(chatId, '⏳ Uploading your proof, please wait...');

        // Get the highest resolution photo file_id
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const caption = msg.caption || '';
        // Send to your existing server.js endpoint
        const response = await axios.post(`${API_BASE}/api/bot/${botId}/submit-proof`, {
          userId: userId,
          taskName: pendingTask.taskName,
          text: caption,
          photoFileId: fileId,
          botToken: botData.token
        }, { timeout: 15000 });

        if (response.data.success) {
          pendingProofs.delete(proofKey); // Clear pending state
          bot.sendMessage(chatId, '✅ <b>Proof submitted successfully!</b>\n\nThe bot owner will review it shortly.', { parse_mode: 'HTML' });
        } else {
          bot.sendMessage(chatId, '❌ Failed to submit proof. Please try again.');
        }
      } catch (error) {
        console.error(`[Bot ${botData.id}] Photo proof error:`, error.message);
        bot.sendMessage(msg.chat.id, '❌ An error occurred while uploading. Please try again later.');
      }
    });

    // ✅ HANDLE TEXT PROOFS & MENU COMMANDS
    bot.on('text', async (msg) => {
      try {
        const chatId = msg.chat.id;
        const text = msg.text.trim();
        const userId = String(msg.from.id);
        const botId = botData.id;
        const proofKey = `${botId}_${userId}`;
        const pendingTask = pendingProofs.get(proofKey);

        // If user is in proof submission mode and didn't type 'cancel'
        if (pendingTask && text.toLowerCase() !== 'cancel') {
          bot.sendMessage(chatId, '⏳ Submitting your text proof...');
          
          const response = await axios.post(`${API_BASE}/api/bot/${botId}/submit-proof`, {
            userId: userId,
            taskName: pendingTask.taskName,
            text: text,
            photoFileId: null,
            botToken: botData.token
          }, { timeout: 15000 });

          if (response.data.success) {
            pendingProofs.delete(proofKey);
            bot.sendMessage(chatId, '✅ <b>Proof submitted successfully!</b>\n\nThe bot owner will review it shortly.', { parse_mode: 'HTML' });
          } else {
            bot.sendMessage(chatId, '❌ Failed to submit proof.');
          }
          return; // Stop further processing        }

        // Default Menu Handlers
        if (text === '💰 Balance' || text === '/balance') {
           const userDoc = await db.collection('bots').doc(botId).collection('users').doc(userId).get();
           const bal = userDoc.exists ? userDoc.data().balance : 0;
           return bot.sendMessage(chatId, `💰 Your Balance: <b>${bal} ${botData.currency || 'TON'}</b>`, { parse_mode: 'HTML' });
        }

        if (text === '📤 Withdraw' || text === '/withdraw') {
           return bot.sendMessage(chatId, '📤 Withdrawal feature: Please use the withdrawal button in the main menu.');
        }

        if (text === '📋 Tasks' || text === '/tasks') {
          if (botData.tasks && botData.tasks.length > 0) {
            const task = botData.tasks[0]; // Fetches the first task
            pendingProofs.set(proofKey, { taskName: task.n, taskReward: task.reward });
            
            return bot.sendMessage(chatId,
              `📌 <b>Task:</b> ${task.n}\n💰 <b>Reward:</b> ${task.reward} ${botData.currency}\n\nPlease complete the task and send a <b>screenshot (photo)</b> or <b>text proof</b> here!`, 
              { 
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [[{ text: '🔗 Open Link', url: task.l }]]
                }
              }
            );
          } else {
            return bot.sendMessage(chatId, 'No tasks available at the moment.');
          }
        }

        // Fallback Menu
        bot.sendMessage(chatId, 'Use the menu buttons below to navigate.', {
          reply_markup: {
            keyboard: [['💰 Balance'], ['📋 Tasks'], ['📤 Withdraw']],
            resize_keyboard: true
          }
        });
      } catch (err) {
        console.error(`[Bot ${botData.id}] Text handler error:`, err.message);
      }
    });

    activeBots[botData.id] = bot;
    console.log(`[Engine] ✅ Bot started: @${botData.username} (ID: ${botData.id})`);

  } catch (error) {
    console.error(`[Engine] Critical failure starting bot ${botData.id}:`, error.message);
  }}

// ==========================================
// 2. STOP A BOT
// ==========================================
function stopBot(botId) {
  if (activeBots[botId]) {
    activeBots[botId].stopPolling().catch(() => {});
    delete activeBots[botId];
    console.log(`[Engine] 🛑 Bot stopped: ${botId}`);
    return true;
  }
  return false;
}

// ==========================================
// 3. RESTART A BOT
// ==========================================
async function restartBot(botId) {
  console.log(`[Engine] 🔄 Restarting bot: ${botId}`);
  stopBot(botId);
  try {
    const doc = await db.collection('bots').doc(botId).get();
    if (doc.exists) {
      const botData = Object.assign({ id: doc.id }, doc.data());
      startBot(botData);
    }
  } catch (e) {
    console.error(`[Engine] Restart failed for ${botId}:`, e.message);
  }
}

// ==========================================
// 4. LOAD ALL BOTS ON STARTUP
// ==========================================
async function loadAllBots() {
  try {
    console.log('[Engine] Loading all active bots from Firestore...');
    const snap = await db.collection('bots').where('status', '==', 'active').get();
    let count = 0;
    snap.forEach((doc) => {
      const botData = Object.assign({ id: doc.id }, doc.data());
      startBot(botData);
      count++;
    });
    console.log(`[Engine] ✅ Successfully loaded ${count} bots.`);
  } catch (e) {
    console.error('[Engine] Failed to load bots:', e.message);
  }
}
// ==========================================
// 5. SEND MESSAGE TO USER (Called by server.js)
// ==========================================
async function sendTo(botId, userId, text) {
  if (activeBots[botId]) {
    try {
      await activeBots[botId].sendMessage(userId, text, { parse_mode: 'HTML' });
      return true;
    } catch (e) {
      console.error(`[Engine] Failed to send message to ${userId} in bot ${botId}:`, e.message);
      return false;
    }
  }
  return false;
}

// ==========================================
// EXPORTS (Must exactly match what server.js expects)
// ==========================================
module.exports = {
  activeBots,
  startBot,
  stopBot,
  restartBot,
  loadAllBots,
  sendTo
};

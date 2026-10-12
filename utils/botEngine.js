require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { db, admin } = require('../firebase'); // ✅ CRUCIAL: Must be ../firebase

const activeBots = {};
const pendingProofs = new Map();

const PORT = process.env.PORT || 3000;
const API_BASE = process.env.APP_URL || `http://localhost:${PORT}`;

function startBot(botData) {
  if (activeBots[botData.id]) {
    console.log(`[Engine] Bot ${botData.id} is already running.`);
    return;
  }

  try {
    const bot = new Telegraf(botData.token);
    botData.users = botData.users || 0;

    bot.start(async (ctx) => {
      const userId = String(ctx.from.id);
      const firstName = ctx.from.first_name || 'User';

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
          return ctx.reply('🚫 You have been banned from using this bot.');
        }
      }

      const buttons = [];
      const allChannels = [...(botData.mustJoin || []), ...(botData.nonMust || [])];
      
      allChannels.forEach(channel => {
        // ✅ STEALTHY: No "required" text added, just the raw channel name
        buttons.push(Markup.button.url(channel, `https://t.me/${channel.replace('@', '')}`));      });

      if (botData.officialChannel) {
        const offName = botData.officialChannel.replace('https://t.me/', '');
        buttons.push(Markup.button.url(`📢 ${offName}`, botData.officialChannel));
      }

      const keyboard = Markup.inlineKeyboard(buttons.map(b => [b]), { columns: 1 });

      let welcomeText = `👋 Welcome, <b>${firstName}</b>!\n\n`;
      welcomeText += `💰 Your Balance: <b>0 ${botData.currency || 'TON'}</b>\n\n`;
      welcomeText += `Please join the channels below to get started:`;

      ctx.reply(welcomeText, { parse_mode: 'HTML', ...keyboard });
    });

    // ✅ HANDLE PHOTO PROOFS
    bot.on('photo', async (ctx) => {
      const userId = String(ctx.from.id);
      const botId = botData.id;
      const proofKey = `${botId}_${userId}`;
      const pendingTask = pendingProofs.get(proofKey);

      if (!pendingTask) {
        return ctx.reply('❌ You do not have a pending task. Please start a task first.');
      }

      try {
        ctx.reply('⏳ Uploading your proof, please wait...');

        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const fileId = photo.file_id;
        const caption = ctx.message.caption || '';

        const response = await axios.post(`${API_BASE}/api/bot/${botId}/submit-proof`, {
          userId: userId,
          taskName: pendingTask.taskName,
          text: caption,
          photoFileId: fileId,
          botToken: botData.token
        }, { timeout: 15000 });

        if (response.data.success) {
          pendingProofs.delete(proofKey);
          ctx.reply('✅ <b>Proof submitted successfully!</b>\n\nThe bot owner will review it shortly.', { parse_mode: 'HTML' });
        } else {
          ctx.reply('❌ Failed to submit proof. Please try again.');
        }
      } catch (error) {
        console.error(`[Bot ${botId}] Proof submission error:`, error.message);        ctx.reply('❌ An error occurred while uploading. Please try again later.');
      }
    });

    // ✅ HANDLE TEXT PROOFS
    bot.on('text', async (ctx) => {
      const text = ctx.message.text.trim();
      const userId = String(ctx.from.id);
      const botId = botData.id;
      const proofKey = `${botId}_${userId}`;
      const pendingTask = pendingProofs.get(proofKey);

      if (pendingTask && text.toLowerCase() !== 'cancel') {
        try {
          ctx.reply('⏳ Submitting your text proof...');
          
          const response = await axios.post(`${API_BASE}/api/bot/${botId}/submit-proof`, {
            userId: userId,
            taskName: pendingTask.taskName,
            text: text,
            photoFileId: null,
            botToken: botData.token
          }, { timeout: 15000 });

          if (response.data.success) {
            pendingProofs.delete(proofKey);
            ctx.reply('✅ <b>Proof submitted successfully!</b>\n\nThe bot owner will review it shortly.', { parse_mode: 'HTML' });
          } else {
            ctx.reply('❌ Failed to submit proof.');
          }
        } catch (error) {
          ctx.reply('❌ An error occurred. Please try again.');
        }
        return;
      }

      // Default fallback
      ctx.reply('Use the menu buttons below to navigate.', {
        reply_markup: {
          keyboard: [[{ text: '💰 Balance' }], [{ text: '📋 Tasks' }], [{ text: '📤 Withdraw' }]],
          resize_keyboard: true
        }
      });
    });

    bot.hears('📋 Tasks', (ctx) => {
      const userId = String(ctx.from.id);
      const botId = botData.id;
      
      if (botData.tasks && botData.tasks.length > 0) {        const task = botData.tasks[0];
        pendingProofs.set(`${botId}_${userId}`, { taskName: task.n, taskReward: task.reward });
        
        ctx.reply(`📌 <b>Task:</b> ${task.n}\n💰 <b>Reward:</b> ${task.reward} ${botData.currency}\n\nPlease complete the task and send a <b>screenshot (photo)</b> or <b>text proof</b> here!`, { 
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[Markup.button.url('🔗 Open Link', task.l)]]
          }
        });
      } else {
        ctx.reply('No tasks available at the moment.');
      }
    });

    bot.launch({ dropPendingUpdates: true });
    activeBots[botData.id] = bot;
    console.log(`[Engine] ✅ Bot started: @${botData.username} (ID: ${botData.id})`);

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));

  } catch (error) {
    console.error(`[Engine] Failed to start bot ${botData.id}:`, error.message);
  }
}

function stopBot(botId) {
  if (activeBots[botId]) {
    activeBots[botId].stop('Restart/Stop');
    delete activeBots[botId];
    console.log(`[Engine] 🛑 Bot stopped: ${botId}`);
    return true;
  }
  return false;
}

async function restartBot(botId) {
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

async function loadAllBots() {  try {
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

async function sendTo(botId, userId, text) {
  if (activeBots[botId]) {
    try {
      await activeBots[botId].telegram.sendMessage(userId, text, { parse_mode: 'HTML' });
      return true;
    } catch (e) {
      console.error(`[Engine] Failed to send message to ${userId} in bot ${botId}:`, e.message);
      return false;
    }
  }
  return false;
}

module.exports = {
  activeBots,
  startBot,
  stopBot,
  restartBot,
  loadAllBots,
  sendTo
};

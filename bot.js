const { Client, GatewayIntentBits } = require('discord.js');
const fs   = require('fs');
const http = require('http');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const REMIND_AFTER_MS = 60 * 60 * 1000;
const BOT_WAIT_MS     = 5000;
const DATA_FILE       = './data.json';

// ─── OVR MAP (exact card values) ───────────────────────────
function getOVR(cardValue) {
  if (cardValue <= 6755)    return '77-';
  if (cardValue === 10250)  return '78';
  if (cardValue === 14600)  return '79';
  if (cardValue === 31445)  return '80';
  if (cardValue === 56420)  return '81';
  if (cardValue === 84750)  return '82';
  if (cardValue === 137650) return '83';
  if (cardValue === 214750) return '84';
  if (cardValue === 335250) return '85';
  if (cardValue === 460550) return '86';
  if (cardValue === 545250) return '87';
  if (cardValue === 650575) return '88';
  if (cardValue === 786750) return '89';
  if (cardValue >= 960500)  return '90+';
  return null;
}

// ─── PERSISTENT DATA ───────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error loading data:', e); }
  return { reminders: {}, stats: { total: 0, ovr: {}, unknown: [] } };
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Error saving data:', e); }
}

const data = loadData();
const processedMsgIds = new Set();
const activeReminders = new Map();

// ─── RESTORE REMINDERS ON STARTUP ──────────────────────────
async function restoreReminders() {
  const now = Date.now();
  for (const [userId, rem] of Object.entries(data.reminders)) {
    const timeLeft = rem.remindAt - now;
    if (timeLeft <= 0) {
      sendReminder(userId, rem.channelId);
      delete data.reminders[userId];
      saveData();
    } else {
      const timeout = setTimeout(() => {
        sendReminder(userId, rem.channelId);
        delete data.reminders[userId];
        saveData();
        activeReminders.delete(userId);
      }, timeLeft);
      activeReminders.set(userId, timeout);
      console.log(`⏰ Restored reminder for ${userId} — ${Math.ceil(timeLeft/60000)} min left`);
    }
  }
}

async function sendReminder(userId, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(`<@${userId}> ⏰ **cgdrop reminder!** 1 hour's up — go claim your drop! 🎁`);
  } catch (_) {
    try {
      const user = await client.users.fetch(userId);
      await user.send(`⏰ **cgdrop reminder!** 1 hour's up — go claim your drop! 🎁`);
    } catch (err) {
      console.error('Could not send reminder:', err);
    }
  }
}

client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  restoreReminders();
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim().toLowerCase();

  // ── !ping ──
  if (content === '!ping') {
    await message.reply('✅ Bot is alive and watching for cgdrop!');
    return;
  }

  // ── !stats ──
  if (content === '!stats') {
    const s = data.stats;
    if (s.total === 0) {
      await message.reply('📊 No drops registered yet!');
      return;
    }
    const OVR_ORDER = ['77-','78','79','80','81','82','83','84','85','86','87','88','89','90+'];
    let msg = `📊 **Drop Stats — ${s.total} total drops**\n\`\`\`\n`;
    msg += `${'OVR'.padEnd(6)} ${'Count'.padEnd(8)} Percentage\n`;
    msg += `${'─'.repeat(30)}\n`;
    for (const ovr of OVR_ORDER) {
      const count = s.ovr[ovr] || 0;
      if (count === 0) continue;
      const pct = ((count / s.total) * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(pct / 5));
      msg += `${ovr.padEnd(6)} ${String(count).padEnd(8)} ${pct}% ${bar}\n`;
    }
    msg += `\`\`\``;
    if (s.unknown.length > 0) {
      msg += `\n⚠️ **${s.unknown.length} unknown card value(s)** — use \`!unknown\` to see them`;
    }
    await message.reply(msg);
    return;
  }

  // ── !unknown ──
  if (content === '!unknown') {
    const unknowns = data.stats.unknown;
    if (unknowns.length === 0) {
      await message.reply('✅ No unknown card values logged!');
      return;
    }
    const list = unknowns.slice(-20).map(u => `• Value: **${u.value}** by ${u.user} at ${u.time}`).join('\n');
    await message.reply(`⚠️ **Unknown card values (last 20):**\n${list}`);
    return;
  }

  // ── !resetstats ──
  if (content === '!resetstats') {
    data.stats = { total: 0, ovr: {}, unknown: [] };
    saveData();
    await message.reply('🗑️ Stats reset!');
    return;
  }

  if (!content.startsWith('cgdrop')) return;

  if (processedMsgIds.has(message.id)) return;
  processedMsgIds.add(message.id);
  setTimeout(() => processedMsgIds.delete(message.id), 10 * 60 * 1000);

  const channel = message.channel;
  const userId  = message.author.id;

  console.log(`🎯 Detected cgdrop by ${message.author.tag}`);

  let replyMsg = null;
  try {
    const collected = await channel.awaitMessages({
      filter: (m) => m.author.bot && (
        m.embeds.length > 0 ||
        m.content.toLowerCase().includes('claim') ||
        m.content.toLowerCase().includes('cooldown') ||
        m.content.toLowerCase().includes('card value')
      ),
      max: 1,
      time: BOT_WAIT_MS,
      errors: [],
    });
    if (collected.size > 0) replyMsg = collected.first();
  } catch (_) {}

  if (replyMsg) {
    const allText = extractText(replyMsg).toLowerCase();
    const rawText = extractText(replyMsg);
    console.log(`📨 Game bot replied: "${rawText.slice(0, 300)}"`);

    // ── Cooldown check ──
    const isCooldown = /claim your next/i.test(allText) || /cooldown/i.test(allText);
    if (isCooldown) {
      const timestampMatch = rawText.match(/<t:(\d+):/);
      let minsLeft = 'some';
      if (timestampMatch) {
        const diffMins = Math.ceil((parseInt(timestampMatch[1]) - Math.floor(Date.now() / 1000)) / 60);
        minsLeft = diffMins > 0 ? String(diffMins) : 'a few';
      }
      console.log(`⏳ Cooldown for ${message.author.tag} — ${minsLeft} min left.`);
      await message.react('⏳').catch(() => {});
      try {
        const user = await client.users.fetch(userId);
        await user.send(`⏳ Cooldown still active — **${minsLeft} minutes** left before you can claim again!`);
      } catch (_) {}
      return;
    }

    // ── Extract card value ──
    const cardMatch = rawText.match(/card value\s*`?([\d,]+)`?/i);
    if (cardMatch) {
      const cardValue = parseInt(cardMatch[1].replace(/,/g, ''));
      const ovr = getOVR(cardValue);
      console.log(`🃏 Card value: ${cardValue} → OVR: ${ovr || 'UNKNOWN'}`);

      data.stats.total += 1;
      if (ovr) {
        data.stats.ovr[ovr] = (data.stats.ovr[ovr] || 0) + 1;
      } else {
        data.stats.unknown.push({
          value: cardValue,
          user: message.author.tag,
          time: new Date().toLocaleString()
        });
        await channel.send(`⚠️ <@${userId}> Unknown card value **${cardValue}** — not in OVR map! Use \`!unknown\` to review.`);
      }
      saveData();
    } else {
      console.log(`⚠️ Could not extract card value from reply.`);
    }

    console.log(`✅ Claim succeeded for ${message.author.tag}!`);
  } else {
    console.log(`⚠️ No game bot response. Assuming claim succeeded for ${message.author.tag}.`);
  }

  if (activeReminders.has(userId)) clearTimeout(activeReminders.get(userId));

  await message.react('⏰').catch(() => {});

  const remindAt = Date.now() + REMIND_AFTER_MS;
  data.reminders[userId] = { remindAt, channelId: message.channel.id };
  saveData();

  const timeout = setTimeout(() => {
    sendReminder(userId, message.channel.id);
    delete data.reminders[userId];
    saveData();
    activeReminders.delete(userId);
  }, REMIND_AFTER_MS);

  activeReminders.set(userId, timeout);
  console.log(`✅ Reminder set for ${message.author.tag}.`);
});

function extractText(msg) {
  let text = msg.content || '';
  for (const embed of msg.embeds) {
    if (embed.title)       text += ' ' + embed.title;
    if (embed.description) text += ' ' + embed.description;
    for (const field of (embed.fields || [])) {
      text += ' ' + field.name + ' ' + field.value;
    }
    if (embed.footer?.text) text += ' ' + embed.footer.text;
  }
  return text;
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot is running!')).listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);

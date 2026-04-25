const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ─── CONFIG ────────────────────────────────────────────────
const REMIND_AFTER_MS = 60 * 60 * 1000; // 1 hour
const BOT_WAIT_MS     = 8000;            // wait up to 8s for game bot reply
// ───────────────────────────────────────────────────────────

const activeReminders = new Map(); // userId -> timeout

client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim().toLowerCase();

  // ── !ping — anyone can check if bot is alive ──
  if (content === '!ping') {
    await message.reply('✅ Bot is alive and watching for cgdrop!');
    return;
  }

  if (!content.startsWith('cgdrop')) return;

  const channel = message.channel;
  const userId  = message.author.id;

  console.log(`🎯 Detected cgdrop by ${message.author.tag} — waiting for game bot response...`);

  // Wait for game bot reply
  let replyMsg = null;
  try {
    const collected = await channel.awaitMessages({
      filter: (m) => m.author.bot,
      max: 1,
      time: BOT_WAIT_MS,
      errors: [],
    });
    if (collected.size > 0) replyMsg = collected.first();
  } catch (_) {}

  if (replyMsg) {
    const allText = extractText(replyMsg).toLowerCase();
    console.log(`📨 Game bot replied: "${allText.slice(0, 200)}"`);

    const isCooldown =
      /claim your next/i.test(allText) ||
      /cooldown/i.test(allText);

    const minsMatch = allText.match(/in\s+(\d+)\s*min/i);
    const minsLeft = minsMatch ? minsMatch[1] : '?';

    if (isCooldown) {
      console.log(`⏳ Cooldown active for ${message.author.tag} — ${minsLeft} min left.`);
      await message.react('⏳').catch(() => {});
      try {
        const user = await client.users.fetch(userId);
        await user.send(`⏳ Cooldown still active — **${minsLeft} minutes** left before you can claim again!`);
      } catch (_) {}
      return;
    }

    console.log(`✅ Claim succeeded for ${message.author.tag}!`);
  } else {
    console.log(`⚠️ No game bot response in ${BOT_WAIT_MS / 1000}s for ${message.author.tag}. Assuming claim succeeded.`);
  }

  // Cancel existing reminder for this user
  if (activeReminders.has(userId)) {
    clearTimeout(activeReminders.get(userId));
    console.log(`🔄 Reset existing reminder for ${message.author.tag}.`);
  }

  await message.react('⏰').catch(() => {});

  const timeout = setTimeout(async () => {
    activeReminders.delete(userId);
    console.log(`🔔 1 hour up! Pinging ${message.author.tag}`);
    try {
      await channel.send(`<@${userId}> ⏰ **cgdrop reminder!** 1 hour's up — go claim your drop! 🎁`);
    } catch (_) {
      try {
        const user = await client.users.fetch(userId);
        await user.send(`⏰ **cgdrop reminder!** 1 hour's up — go claim your drop! 🎁`);
      } catch (err) {
        console.error('Could not send reminder:', err);
      }
    }
  }, REMIND_AFTER_MS);

  activeReminders.set(userId, timeout);
  const pingAt = new Date(Date.now() + REMIND_AFTER_MS);
  console.log(`✅ Reminder set for ${message.author.tag}. Will ping at ${pingAt.toLocaleTimeString()}`);
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

const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot is running!')).listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);

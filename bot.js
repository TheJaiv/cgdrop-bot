const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const REMIND_AFTER_MS = 60 * 60 * 1000;
const BOT_WAIT_MS     = 5000;

const activeReminders = new Map();
const processingUsers = new Set();

client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim().toLowerCase();

  if (content === '!ping') {
    await message.reply('✅ Bot is alive and watching for cgdrop!');
    return;
  }

  if (!content.startsWith('cgdrop')) return;

  const userId = message.author.id;
  if (processingUsers.has(userId)) return;
  processingUsers.add(userId);

  const channel = message.channel;
  console.log(`🎯 Detected cgdrop by ${message.author.tag}`);

  let replyMsg = null;
  try {
    const collected = await channel.awaitMessages({
      filter: (m) => m.author.bot && (
        m.embeds.length > 0 ||
        m.content.toLowerCase().includes('claim') ||
        m.content.toLowerCase().includes('cooldown')
      ),
      max: 1,
      time: BOT_WAIT_MS,
      errors: [],
    });
    if (collected.size > 0) replyMsg = collected.first();
  } catch (_) {}

  processingUsers.delete(userId);

  if (replyMsg) {
    const allText = extractText(replyMsg).toLowerCase();
    const rawText = extractText(replyMsg); // keep original case for timestamp
    console.log(`📨 Game bot replied: "${allText.slice(0, 300)}"`);

    const isCooldown =
      /claim your next/i.test(allText) ||
      /cooldown/i.test(allText);

    if (isCooldown) {
      // Extract Unix timestamp from Discord <t:XXXXXXXXXX:r> format
      const timestampMatch = rawText.match(/<t:(\d+):/);
      let minsLeft = 'some';

      if (timestampMatch) {
        const unixSeconds = parseInt(timestampMatch[1]);
        const nowSeconds  = Math.floor(Date.now() / 1000);
        const diffMins    = Math.ceil((unixSeconds - nowSeconds) / 60);
        minsLeft = diffMins > 0 ? String(diffMins) : 'a few';
      }

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
    console.log(`⚠️ No game bot response. Assuming claim succeeded for ${message.author.tag}.`);
  }

  if (activeReminders.has(userId)) {
    clearTimeout(activeReminders.get(userId));
    console.log(`🔄 Reset existing reminder for ${message.author.tag}.`);
  }

  await message.react('⏰').catch(() => {});

  const timeout = setTimeout(async () => {
    activeReminders.delete(userId);
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

const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot is running!')).listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);

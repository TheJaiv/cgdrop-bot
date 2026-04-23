const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ─── CONFIG ────────────────────────────────────────────────
const YOUR_USER_ID    = '1087369198801526836'; // your Discord user ID
const REMIND_AFTER_MS = 60 * 60 * 1000;              // 1 hour in ms
const BOT_WAIT_MS     = 8000;                         // wait up to 8s for game bot reply
// ───────────────────────────────────────────────────────────

const activeReminders = new Map();

client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  // Ignore bots, ignore other users
  if (message.author.bot) return;
  if (message.author.id !== YOUR_USER_ID) return;

  const content = message.content.trim().toLowerCase();
  if (!content.startsWith('cgdrop')) return;

  const channel = message.channel;
  const userId  = message.author.id;

  console.log(`🎯 Detected cgdrop — waiting up to ${BOT_WAIT_MS / 1000}s for game bot response...`);

  // ── Wait for the first bot reply in this channel ──
  let replyMsg = null;
  try {
    const collected = await channel.awaitMessages({
      filter: (m) => m.author.bot,
      max: 1,
      time: BOT_WAIT_MS,
      errors: [],
    });
    if (collected.size > 0) replyMsg = collected.first();
  } catch (_) { /* timeout, no reply */ }

  if (replyMsg) {
    const allText = extractText(replyMsg).toLowerCase();
    console.log(`📨 Game bot replied: "${allText.slice(0, 120)}..."`);

    // Check for cooldown phrases (based on what CG bot sends)
    // "Claim your next player in 21 minutes" / "cooldown" etc.
    const cooldownRegex = /claim your next(?:\s+player)?\s+in\s+(\d+)\s*min/i;
    const match = allText.match(cooldownRegex);

    if (match) {
      const minsLeft = match[1];
      console.log(`⏳ Cooldown active — ${minsLeft} min left. Skipping reminder.`);

      // React with hourglass so you know bot saw it
      await message.react('⏳').catch(() => {});

      // DM you the time left
      try {
        const user = await client.users.fetch(userId);
        await user.send(`⏳ Cooldown still active — **${minsLeft} minutes** left before you can claim again!`);
      } catch (_) { /* DMs closed, skip */ }

      return; // ← Do NOT set reminder
    }

    // No cooldown found → claim succeeded
    console.log(`✅ No cooldown detected. Claim succeeded!`);
  } else {
    // No bot response in time — could mean claim succeeded silently or bot is slow
    console.log(`⚠️ No game bot response in ${BOT_WAIT_MS / 1000}s. Assuming claim succeeded.`);
  }

  // ── Cancel existing reminder if any ──
  if (activeReminders.has(userId)) {
    clearTimeout(activeReminders.get(userId));
    console.log(`🔄 Reset existing reminder.`);
  }

  // ── Confirm with reaction ──
  await message.react('⏰').catch(() => {});

  // ── Set 1-hour reminder ──
  const timeout = setTimeout(async () => {
    activeReminders.delete(userId);
    console.log(`🔔 1 hour up! Pinging ${message.author.tag}`);

    try {
      await channel.send(`<@${userId}> ⏰ **cgdrop reminder!** 1 hour's up — go claim your drop! 🎁`);
    } catch (_) {
      // Channel ping failed, try DM
      try {
        const user = await client.users.fetch(userId);
        await user.send(`⏰ **cgdrop reminder!** 1 hour's up — go claim your drop! 🎁`);
      } catch (err) {
        console.error('Could not send reminder anywhere:', err);
      }
    }
  }, REMIND_AFTER_MS);

  activeReminders.set(userId, timeout);
  const pingAt = new Date(Date.now() + REMIND_AFTER_MS);
  console.log(`✅ Reminder set. Will ping at ${pingAt.toLocaleTimeString()}`);
});

// ── Pull all text from a message including embeds ──
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

// ── Dummy HTTP server so Render doesn't shut us down ──
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot is running!')).listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);

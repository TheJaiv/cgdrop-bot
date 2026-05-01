const { Client, GatewayIntentBits } = require('discord.js');
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
const JSONBIN_KEY     = process.env.JSONBIN_KEY;
let   binId           = process.env.JSONBIN_BIN_ID || null;
const OWNER_ID        = process.env.OWNER_ID;

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

async function loadData() {
  try {
    if (binId) {
      const res = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
        headers: { 'X-Master-Key': JSONBIN_KEY }
      });
      const json = await res.json();
      console.log('✅ Data loaded from JSONBin');
      return json.record;
    }
  } catch (e) { console.error('Error loading from JSONBin:', e.message); }
  return { reminders: {}, stats: { total: 0, ovr: {}, unknown: [] } };
}

async function saveData(data) {
  try {
    if (!binId) {
      const res = await fetch('https://api.jsonbin.io/v3/b', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': JSONBIN_KEY,
          'X-Bin-Name': 'cgdrop-bot-data',
          'X-Bin-Private': 'true'
        },
        body: JSON.stringify(data)
      });
      const json = await res.json();
      binId = json.metadata.id;
      console.log(`✅ Created new JSONBin: ${binId}`);
      console.log(`⚠️ ADD TO RENDER ENV: JSONBIN_BIN_ID=${binId}`);
    } else {
      await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
        body: JSON.stringify(data)
      });
    }
  } catch (e) { console.error('Error saving to JSONBin:', e.message); }
}

let data = { reminders: {}, stats: { total: 0, ovr: {}, unknown: [] } };
const processedMsgIds = new Set();
const activeReminders = new Map();

async function sendReminder(userId, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(`<@${userId}> ⏰ **cgdrop reminder!** 1 hour's up — go claim your drop! 🎁`);
  } catch (_) {
    try {
      const user = await client.users.fetch(userId);
      await user.send(`⏰ **cgdrop reminder!** 1 hour's up — go claim your drop! 🎁`);
    } catch (err) { console.error('Could not send reminder:', err); }
  }
}

async function restoreReminders() {
  const now = Date.now();
  for (const [userId, rem] of Object.entries(data.reminders || {})) {
    const timeLeft = rem.remindAt - now;
    if (timeLeft <= 0) {
      sendReminder(userId, rem.channelId);
      delete data.reminders[userId];
      await saveData(data);
    } else {
      const timeout = setTimeout(async () => {
        sendReminder(userId, rem.channelId);
        delete data.reminders[userId];
        await saveData(data);
        activeReminders.delete(userId);
      }, timeLeft);
      activeReminders.set(userId, timeout);
      console.log(`⏰ Restored reminder for ${userId} — ${Math.ceil(timeLeft/60000)} min left`);
    }
  }
}

function buildStatsMsg(s) {
  const OVR_ORDER = ['90+','89','88','87','86','85','84','83','82','81','80','79','78','77-'];
  const EMOJI = {
    '90+':'💎','89':'🔴','88':'🔴','87':'🔴',
    '86':'🟠','85':'🟠','84':'🟠',
    '83':'🟡','82':'🟡','81':'🟡',
    '80':'🔵','79':'🔵','78':'🔵',
    '77-':'⚪'
  };

  const activeOVRs = OVR_ORDER.filter(o => s.ovr[o] > 0);
  const maxPct = Math.max(...activeOVRs.map(o => (s.ovr[o] / s.total) * 100));

  // Unique counts sorted descending — assign unique bar lengths
  const uniqueCounts = [...new Set(activeOVRs.map(o => s.ovr[o]))].sort((a, b) => b - a);
  const countToBar = {};
  const usedLengths = new Set();

  // 77- always gets 20 bars
  countToBar['__77-__'] = 20;

  // Get unique pcts from non-77- OVRs that have drops
  const nonBase = activeOVRs.filter(o => o !== '77-');
  const uniquePcts = [...new Set(nonBase.map(o => parseFloat(((s.ovr[o] / s.total) * 100).toFixed(1))))].sort((a,b) => a - b);

  // Assign bars starting from 1, +1 each step, +2 if gap > 5%
  let currentBar = 1;
  const pctToBar = {};
  uniquePcts.forEach((pct, idx) => {
    if (idx === 0) {
      pctToBar[pct] = currentBar;
    } else {
      const gap = pct - uniquePcts[idx - 1];
      currentBar += gap > 5 ? 2 : 1;
      pctToBar[pct] = currentBar;
    }
    console.log(`Bar mapping: pct=${pct}% len=${pctToBar[pct]}`);
  });

  // Map each OVR to its bar length
  for (const ovr of activeOVRs) {
    if (ovr === '77-') {
      countToBar[ovr] = 20;
    } else {
      const pct = parseFloat(((s.ovr[ovr] / s.total) * 100).toFixed(1));
      countToBar[ovr] = pctToBar[pct] || 1;
    }
  }

  let msg = `📊 **Drop Stats — ${s.total} total drops**\n\`\`\`\n`;
  msg += `OVR    Ct   Pct     Bar\n`;
  msg += `${'─'.repeat(42)}\n`;

  for (const ovr of OVR_ORDER) {
    const count = s.ovr[ovr] || 0;
    if (count === 0) continue;
    const pct = (count / s.total) * 100;
    const pctStr = pct.toFixed(1) + '%';
    const bar = '█'.repeat(countToBar[ovr] || 1);
    msg += `${EMOJI[ovr]} ${ovr.padEnd(4)} ${String(count).padEnd(5)}${pctStr.padEnd(8)}${bar}\n`;
  }
  msg += `\`\`\``;
  if (s.unknown && s.unknown.length > 0) {
    msg += `\n⚠️ **${s.unknown.length} unknown card value(s)** — use \`!unknown\` to see them`;
  }
  return msg;
}

function extractText(msg) {
  let text = msg.content || '';
  for (const embed of msg.embeds) {
    if (embed.title)       text += ' ' + embed.title;
    if (embed.description) text += ' ' + embed.description;
    for (const field of (embed.fields || [])) text += ' ' + field.name + ' ' + field.value;
    if (embed.footer?.text) text += ' ' + embed.footer.text;
  }
  return text;
}

client.once('ready', async () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  data = await loadData();
  await restoreReminders();
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim().toLowerCase();

  if (content === '!ping') {
    console.log(`✅ !ping by ${message.author.tag}`);
    await message.reply('✅ Bot is alive and watching for cgdrop!').catch(e => console.error('Reply error:', e.message));
    return;
  }

  if (content === '!stats') {
    console.log(`📊 !stats by ${message.author.tag}`);
    if (data.stats.total === 0) {
      await message.reply('📊 No drops registered yet!');
      return;
    }
    await message.reply(buildStatsMsg(data.stats));
    return;
  }

  if (content === '!unknown') {
    const unknowns = data.stats.unknown || [];
    if (unknowns.length === 0) {
      await message.reply('✅ No unknown card values logged!');
      return;
    }
    const list = unknowns.slice(-20).map(u => `• Value: **${u.value}** by ${u.user} at ${u.time}`).join('\n');
    await message.reply(`⚠️ **Unknown card values (last 20):**\n${list}`);
    return;
  }

  if (content === '!myavg') {
    if (message.author.id !== OWNER_ID) {
      await message.reply('❌ This command is only for the server owner!');
      return;
    }
    const o = data.owner;
    if (!o || o.totalDrops === 0) {
      await message.reply('📊 No sale data yet!');
      return;
    }
    const avg = Math.round(o.totalSale / o.totalDrops);
    await message.reply(`💰 **Your Drop Averages**\n\`\`\`\nTotal drops : ${o.totalDrops}\nTotal earned: ${o.totalSale.toLocaleString()} coins\nAvg per drop: ${avg.toLocaleString()} coins\`\`\``);
    return;
  }

  if (content.startsWith('!addvote')) {
    if (message.author.id !== OWNER_ID) {
      await message.reply('❌ This command is only for the server owner!');
      return;
    }
    const parts = message.content.trim().split(' ');
    const amount = parseInt((parts[1] || '').replace(/,/g, ''));
    if (isNaN(amount) || amount <= 0) {
      await message.reply('❌ Usage: `!addvote 4500` or `!addvote 4500 yesterday`');
      return;
    }
    // Determine date — today or yesterday IST
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    if (parts[2] === 'yesterday') nowIST.setDate(nowIST.getDate() - 1);
    const targetDate = nowIST.toISOString().slice(0, 10);
    data.owner = data.owner || { totalSale: 0, totalDrops: 0, days: {} };
    data.owner.days[targetDate] = data.owner.days[targetDate] || { totalSale: 0, drops: 0, vote: 0 };
    data.owner.days[targetDate].vote = (data.owner.days[targetDate].vote || 0) + amount;
    await saveData(data);
    console.log(`🗳️ Vote earnings added: ${amount} for ${targetDate}`);
    await message.reply(`✅ Added **${amount.toLocaleString()} coins** from vote to **${targetDate}**!`);
    return;
  }

  if (content === '!myearnings') {
    if (message.author.id !== OWNER_ID) {
      await message.reply('❌ This command is only for the server owner!');
      return;
    }
    const o = data.owner;
    if (!o || !o.days || Object.keys(o.days).length === 0) {
      await message.reply('📊 No earnings data yet!');
      return;
    }
    const days = Object.entries(o.days).sort((a,b) => a[0].localeCompare(b[0])).slice(-14);
    const totalDays = days.length;
    const totalDropIncome = days.reduce((sum, [,d]) => sum + (d.totalSale || 0), 0);
    const totalVote       = days.reduce((sum, [,d]) => sum + (d.vote || 0), 0);
    const totalEarned     = totalDropIncome + totalVote;
    const avgDropPerDay   = Math.round(totalDropIncome / totalDays);
    const avgVotePerDay   = Math.round(totalVote / totalDays);
    const avgTotalPerDay  = Math.round(totalEarned / totalDays);
    let msg = `💰 **Your Daily Earnings (last ${totalDays} days)**\n\`\`\`\n`;
    msg += `Date        Dr  Drop        Vote        Total\n`;
    msg += '─'.repeat(50) + '\n';
    for (const [date, d] of days) {
      const drop  = (d.totalSale || 0).toLocaleString().padEnd(12);
      const vote  = (d.vote || 0).toLocaleString().padEnd(12);
      const total = ((d.totalSale || 0) + (d.vote || 0)).toLocaleString();
      msg += `${date} ${String(d.drops||0).padEnd(4)}${drop}${vote}${total}\n`;
    }
    msg += '─'.repeat(50) + '\n';
    msg += `${'Avg/day'.padEnd(13)}${' '.padEnd(4)}${avgDropPerDay.toLocaleString().padEnd(12)}${avgVotePerDay.toLocaleString().padEnd(12)}${avgTotalPerDay.toLocaleString()}\n`;
    msg += `${'Total'.padEnd(13)}${' '.padEnd(4)}${totalDropIncome.toLocaleString().padEnd(12)}${totalVote.toLocaleString().padEnd(12)}${totalEarned.toLocaleString()}\n`;
    msg += `\`\`\``;
    await message.reply(msg);
    return;
  }

  if (content === '!resetstats') {
    data.stats = { total: 0, ovr: {}, unknown: [] };
    await saveData(data);
    await message.reply('🗑️ Stats reset!');
    return;
  }

  if (!content.startsWith('cgdrop') && !content.startsWith('cg drop')) return;

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
    console.log(`📨 Game bot replied: "${rawText.slice(0, 200)}"`);

    const isCooldown = /claim your next/i.test(allText) || /cooldown/i.test(allText);
    if (isCooldown) {
      const timestampMatch = rawText.match(/<t:(\d+):/);
      let minsLeft = 'some';
      if (timestampMatch) {
        const diffMins = Math.ceil((parseInt(timestampMatch[1]) - Math.floor(Date.now() / 1000)) / 60);
        minsLeft = diffMins > 0 ? String(diffMins) : 'a few';
      }
      console.log(`⏳ Cooldown for ${message.author.tag} — ${minsLeft} min left.`);
      await message.react('⏳').catch(e => console.error('React error:', e.message));
      try {
        const user = await client.users.fetch(userId);
        await user.send(`⏳ Cooldown still active — **${minsLeft} minutes** left before you can claim again!`);
      } catch (_) {}
      return;
    }

    const cardMatch = rawText.match(/card value\s*`?([\d,]+)`?/i);
    const saleMatch  = rawText.match(/sale value\s*`?([\d,]+)`?/i);
    if (cardMatch) {
      const cardValue = parseInt(cardMatch[1].replace(/,/g, ''));
      const ovr = getOVR(cardValue);
      console.log(`🃏 Card value: ${cardValue} → OVR: ${ovr || 'UNKNOWN'}`);
      data.stats.total += 1;
      if (ovr) {
        data.stats.ovr[ovr] = (data.stats.ovr[ovr] || 0) + 1;
      } else {
        data.stats.unknown = data.stats.unknown || [];
        data.stats.unknown.push({ value: cardValue, user: message.author.tag, time: new Date().toLocaleString() });
        await channel.send(`⚠️ <@${userId}> Unknown card value **${cardValue}** — not in OVR map! Use \`!unknown\` to review.`);
      }
    }
    // Track sale value for owner
    if (saleMatch && userId === OWNER_ID) {
      const saleValue = parseInt(saleMatch[1].replace(/,/g, ''));
      const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
      data.owner = data.owner || { totalSale: 0, totalDrops: 0, days: {} };
      data.owner.totalSale  += saleValue;
      data.owner.totalDrops += 1;
      data.owner.days[today] = data.owner.days[today] || { totalSale: 0, drops: 0 };
      data.owner.days[today].totalSale += saleValue;
      data.owner.days[today].drops     += 1;
      console.log(`💰 Sale value: ${saleValue} for owner on ${today}`);
    }
    if (cardMatch || saleMatch) await saveData(data);
    console.log(`✅ Claim succeeded for ${message.author.tag}!`);
  } else {
    console.log(`⚠️ No game bot response. Assuming claim succeeded for ${message.author.tag}.`);
  }

  if (activeReminders.has(userId)) clearTimeout(activeReminders.get(userId));
  await message.react('⏰').catch(e => console.error('React error:', e.message));

  const remindAt = Date.now() + REMIND_AFTER_MS;
  data.reminders[userId] = { remindAt, channelId: message.channel.id };
  await saveData(data);

  const timeout = setTimeout(async () => {
    sendReminder(userId, message.channel.id);
    delete data.reminders[userId];
    await saveData(data);
    activeReminders.delete(userId);
  }, REMIND_AFTER_MS);

  activeReminders.set(userId, timeout);
  console.log(`✅ Reminder set for ${message.author.tag}.`);
});

process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); });

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot is running!')).listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);

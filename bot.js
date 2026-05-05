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

// ─── OVR MAP ───────────────────────────────────────────────
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

// ─── JSONBIN ───────────────────────────────────────────────
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

// ─── HELPERS ───────────────────────────────────────────────
function getISTDate(offset = 0) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function pad(str, len) {
  return String(str).padEnd(len);
}

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function extractText(msg) {
  let text = msg.content || '';
  for (const embed of msg.embeds) {
    if (embed.title)       text += ' ' + embed.title;
    if (embed.description) text += ' ' + embed.description;
    for (const f of (embed.fields || [])) text += ' ' + f.name + ' ' + f.value;
    if (embed.footer?.text) text += ' ' + embed.footer.text;
  }
  return text;
}

// ─── REMINDERS ─────────────────────────────────────────────
let data = { reminders: {}, stats: { total: 0, ovr: {}, unknown: [] } };
const processedMsgIds = new Set();
const activeReminders = new Map();

async function sendReminder(userId, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(`<@${userId}> ⏰ **cgdrop reminder!** 1 hour's up — go claim your drop! 🎁\nTo disable reminders type \`!remind off\``);
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

// ─── STATS MSG ─────────────────────────────────────────────
function buildStatsMsg(s) {
  const OVR_ORDER = ['90+','89','88','87','86','85','84','83','82','81','80','79','78','77-'];
  const EMOJI = {
    '90+':'💎','89':'🔴','88':'🔴','87':'🔴',
    '86':'🟠','85':'🟠','84':'🟠',
    '83':'🟡','82':'🟡','81':'🟡',
    '80':'🔵','79':'🔵','78':'🔵','77-':'⚪'
  };

  const activeOVRs = OVR_ORDER.filter(o => s.ovr[o] > 0);
  const nonBase    = activeOVRs.filter(o => o !== '77-');
  const uniquePcts = [...new Set(nonBase.map(o => parseFloat(((s.ovr[o] / s.total) * 100).toFixed(1))))].sort((a,b) => a-b);

  let currentBar = 1;
  const pctToBar = {};
  uniquePcts.forEach((pct, idx) => {
    if (idx === 0) { pctToBar[pct] = currentBar; }
    else {
      const gap = pct - uniquePcts[idx-1];
      currentBar += gap > 5 ? 2 : 1;
      pctToBar[pct] = currentBar;
    }
  });

  const ovrToBar = {};
  for (const ovr of activeOVRs) {
    if (ovr === '77-') { ovrToBar[ovr] = 20; }
    else {
      const pct = parseFloat(((s.ovr[ovr] / s.total) * 100).toFixed(1));
      ovrToBar[ovr] = pctToBar[pct] || 1;
    }
  }

  let msg = `📊 **Drop Stats — ${s.total} total drops**\n\`\`\`\n`;
  msg += `OVR    Ct   Pct     Bar\n`;
  msg += '─'.repeat(42) + '\n';
  for (const ovr of OVR_ORDER) {
    const count = s.ovr[ovr] || 0;
    if (count === 0) continue;
    const pct  = (count / s.total) * 100;
    const pctStr = pct.toFixed(1) + '%';
    const bar  = '█'.repeat(ovrToBar[ovr] || 1);
    msg += `${EMOJI[ovr]} ${ovr.padEnd(4)} ${String(count).padEnd(5)}${pctStr.padEnd(8)}${bar}\n`;
  }
  msg += `\`\`\``;
  if (s.unknown && s.unknown.length > 0)
    msg += `\n⚠️ **${s.unknown.length} unknown card value(s)** — use \`!unknown\` to see them`;
  return msg;
}

// ─── ADD INCOME HELPER ─────────────────────────────────────
async function addIncome(message, type, label) {
  if (message.author.id !== OWNER_ID) {
    await message.reply(`❌ This command is only for the server owner!`);
    return;
  }
  const parts  = message.content.trim().split(' ');
  const amount = parseInt((parts[1] || '').replace(/,/g, '').replace(/−/g, '-'));
  if (isNaN(amount)) {
    await message.reply(`❌ Usage: \`!add${type} 4500\` or \`!add${type} 4500 yesterday\``);
    return;
  }
  const offset = parts[2] === 'yesterday' ? -1 : 0;
  const date   = getISTDate(offset);
  data.owner = data.owner || { totalSale: 0, totalDrops: 0, days: {} };
  data.owner.days[date] = data.owner.days[date] || { totalSale: 0, drops: 0, vote: 0, match: 0, misc: 0 };
  data.owner.days[date][type] = (data.owner.days[date][type] || 0) + amount;
  await saveData(data);
  console.log(`💰 ${label} earnings added: ${amount} for ${date}`);
  await message.reply(`✅ Added **${fmt(amount)} coins** from ${label} to **${date}**!`);
}

// ─── READY ─────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  data = await loadData();
  await restoreReminders();
});

// ─── MESSAGES ──────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim().toLowerCase();

  // !ping
  if (content === '!ping') {
    console.log(`✅ !ping by ${message.author.tag}`);
    await message.reply('✅ Bot is alive and watching for cgdrop!').catch(e => console.error('Reply error:', e.message));
    return;
  }

  // !stats
  if (content === '!stats') {
    console.log(`📊 !stats by ${message.author.tag}`);
    if (data.stats.total === 0) { await message.reply('📊 No drops registered yet!'); return; }
    await message.reply(buildStatsMsg(data.stats));
    return;
  }

  // !unknown
  if (content === '!unknown') {
    const unknowns = data.stats.unknown || [];
    if (unknowns.length === 0) { await message.reply('✅ No unknown card values logged!'); return; }
    const list = unknowns.slice(-20).map(u => `• Value: **${u.value}** by ${u.user} at ${u.time}`).join('\n');
    await message.reply(`⚠️ **Unknown card values (last 20):**\n${list}`);
    return;
  }

  // !resetstats
  if (content === '!resetstats') {
    data.stats = { total: 0, ovr: {}, unknown: [] };
    await saveData(data);
    await message.reply('🗑️ Stats reset!');
    return;
  }

  // !myavg
  if (content === '!myavg') {
    if (message.author.id !== OWNER_ID) { await message.reply('❌ Owner only!'); return; }
    const o = data.owner;
    if (!o || o.totalDrops === 0) { await message.reply('📊 No sale data yet!'); return; }
    const avg = Math.round(o.totalSale / o.totalDrops);
    await message.reply(`💰 **Your Drop Averages**\n\`\`\`\nTotal drops : ${o.totalDrops}\nTotal earned: ${fmt(o.totalSale)} coins\nAvg per drop: ${fmt(avg)} coins\`\`\``);
    return;
  }

  // !addvote, !addmatch, !addmisc
  if (content.startsWith('!addvote'))  { await addIncome(message, 'vote',  'Vote');  return; }
  if (content.startsWith('!addmatch')) { await addIncome(message, 'match', 'Match'); return; }
  if (content.startsWith('!addmisc'))  { await addIncome(message, 'misc',  'Misc');  return; }

  // !myearnings
  if (content === '!myearnings') {
    if (message.author.id !== OWNER_ID) { await message.reply('❌ Owner only!'); return; }
    const o = data.owner;
    if (!o || !o.days || Object.keys(o.days).length === 0) { await message.reply('📊 No earnings data yet!'); return; }

    const days = Object.entries(o.days).sort((a,b) => a[0].localeCompare(b[0])).slice(-7);
    const n    = days.length;

    const totDrop  = days.reduce((s,[,d]) => s + (d.totalSale||0), 0);
    const totVote  = days.reduce((s,[,d]) => s + (d.vote||0), 0);
    const totMatch = days.reduce((s,[,d]) => s + (d.match||0), 0);
    const totMisc  = days.reduce((s,[,d]) => s + (d.misc||0), 0);
    const totAll   = totDrop + totVote + totMatch + totMisc;

    const C = { date:11, dr:4, drop:9, vote:9, match:9, misc:9, total:9 };

    let msg = `💰 **Your Daily Earnings (last ${n} days)**\n\`\`\`\n`;
    msg += pad('Date',C.date) + pad('Dr',C.dr) + pad('Drop',C.drop) + pad('Vote',C.vote) + pad('Match',C.match) + pad('Misc',C.misc) + 'Total\n';
    msg += '─'.repeat(C.date+C.dr+C.drop+C.vote+C.match+C.misc+C.total) + '\n';

    for (const [date, d] of days) {
      const total = (d.totalSale||0)+(d.vote||0)+(d.match||0)+(d.misc||0);
      msg += pad(date,C.date) + pad(d.drops||0,C.dr) + pad(fmt(d.totalSale||0),C.drop) + pad(fmt(d.vote||0),C.vote) + pad(fmt(d.match||0),C.match) + pad(fmt(d.misc||0),C.misc) + fmt(total) + '\n';
    }

    msg += '─'.repeat(C.date+C.dr+C.drop+C.vote+C.match+C.misc+C.total) + '\n';
    msg += pad('Avg/day',C.date) + pad('',C.dr) + pad(fmt(Math.round(totDrop/n)),C.drop) + pad(fmt(Math.round(totVote/n)),C.vote) + pad(fmt(Math.round(totMatch/n)),C.match) + pad(fmt(Math.round(totMisc/n)),C.misc) + fmt(Math.round(totAll/n)) + '\n';
    msg += pad('Total',C.date)   + pad('',C.dr) + pad(fmt(totDrop),C.drop) + pad(fmt(totVote),C.vote) + pad(fmt(totMatch),C.match) + pad(fmt(totMisc),C.misc) + fmt(totAll) + '\n';
    msg += '`\`\`';
    await message.reply(msg);
    return;
  }

  // !remind toggle
  if (content === '!remind off') {
    data.reminderDisabled = data.reminderDisabled || {};
    data.reminderDisabled[message.author.id] = true;
    await saveData(data);
    await message.reply('🔕 Reminders disabled! Type `!remind on` to enable again.');
    return;
  }

  if (content === '!remind on') {
    data.reminderDisabled = data.reminderDisabled || {};
    delete data.reminderDisabled[message.author.id];
    await saveData(data);
    await message.reply('🔔 Reminders enabled!');
    return;
  }

  // !remind toggle
  if (content === '!remind off') {
    data.remindDisabled = data.remindDisabled || {};
    data.remindDisabled[message.author.id] = true;
    await saveData(data);
    await message.reply('🔕 Reminders disabled! Type `!remind on` to enable again.');
    return;
  }

  if (content === '!remind on') {
    data.remindDisabled = data.remindDisabled || {};
    delete data.remindDisabled[message.author.id];
    await saveData(data);
    await message.reply('🔔 Reminders enabled!');
    return;
  }

  // cgdrop detection
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
      max: 1, time: BOT_WAIT_MS, errors: [],
    });
    if (collected.size > 0) replyMsg = collected.first();
  } catch (_) {}

  if (replyMsg) {
    const allText = extractText(replyMsg).toLowerCase();
    const rawText = extractText(replyMsg);
    console.log(`📨 Game bot replied: "${rawText.slice(0, 200)}"`);

    const isCooldown = /claim your next/i.test(allText) || /cooldown/i.test(allText);
    if (isCooldown) {
      const tsMatch = rawText.match(/<t:(\d+):/);
      let minsLeft  = 'some';
      if (tsMatch) {
        const diff = Math.ceil((parseInt(tsMatch[1]) - Math.floor(Date.now()/1000)) / 60);
        minsLeft = diff > 0 ? String(diff) : 'a few';
      }
      console.log(`⏳ Cooldown for ${message.author.tag} — ${minsLeft} min left.`);
      await message.react('⏳').catch(e => console.error('React error:', e.message));
      return;
    }

    const cardMatch = rawText.match(/card value\s*`?([\d,]+)`?/i);
    const saleMatch = rawText.match(/sale value\s*`?([\d,]+)`?/i);

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

    if (saleMatch && userId === OWNER_ID) {
      const saleValue = parseInt(saleMatch[1].replace(/,/g, ''));
      const today = getISTDate();
      data.owner = data.owner || { totalSale: 0, totalDrops: 0, days: {} };
      data.owner.totalSale  = (data.owner.totalSale  || 0) + saleValue;
      data.owner.totalDrops = (data.owner.totalDrops || 0) + 1;
      data.owner.days[today] = data.owner.days[today] || { totalSale: 0, drops: 0, vote: 0, match: 0, misc: 0 };
      data.owner.days[today].totalSale += saleValue;
      data.owner.days[today].drops     += 1;
      console.log(`💰 Sale value: ${saleValue} for owner on ${today}`);
    }

    if (cardMatch || saleMatch) await saveData(data);
    console.log(`✅ Claim succeeded for ${message.author.tag}!`);
  } else {
    console.log(`⚠️ No game bot response. Assuming claim succeeded for ${message.author.tag}.`);
  }

  // Check if user has reminders disabled
  const isDisabled = data.reminderDisabled && data.reminderDisabled[userId];
  if (isDisabled) {
    console.log(`🔕 Reminders disabled for ${message.author.tag}, skipping.`);
    return;
  }

  if (activeReminders.has(userId)) clearTimeout(activeReminders.get(userId));
  await message.react('⏰').catch(e => console.error('React error:', e.message));

  // Check if user has disabled reminders
  if (data.remindDisabled && data.remindDisabled[userId]) {
    console.log(`🔕 Reminders disabled for ${message.author.tag}, skipping.`);
    return;
  }

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



  // Short tip message in channel
  try {
    await message.channel.send(`<@${userId}> ⏰ Reminder set! Type \`!remind off\` to disable reminders.`);
  } catch (_) {}
});

process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); });

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot is running!')).listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);

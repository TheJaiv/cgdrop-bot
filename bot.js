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

// ─── WHITELIST CHECK ───────────────────────────────────────
// Owner always passes. Whitelisted users pass for !myearnings / !myavg.
function isWhitelisted(userId) {
  if (userId === OWNER_ID) return true;
  return !!(data.whitelist && data.whitelist[userId]);
}

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
      console.log('💾 Data saved to JSONBin');
    }
  } catch (e) { console.error('Error saving to JSONBin:', e.message); }
}

// ─── DEBOUNCED SAVE (5s) ───────────────────────────────────
// All writes go through scheduleSave(). Multiple calls within
// 5 seconds collapse into a single JSONBin PUT — minimising API pulls.
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await saveData(data);
  }, 5000);
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
      scheduleSave();
    } else {
      const timeout = setTimeout(async () => {
        sendReminder(userId, rem.channelId);
        delete data.reminders[userId];
        scheduleSave();
        activeReminders.delete(userId);
      }, timeLeft);
      activeReminders.set(userId, timeout);
      console.log(`⏰ Restored reminder for ${userId} — ${Math.ceil(timeLeft/60000)} min left`);
    }
  }
}

// ─── STATS MSG BUILDER (shared by !stats and !mystats) ─────
function buildStatsMsg(s, title) {
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

  let msg = `📊 **${title} — ${s.total} total drops**\n\`\`\`\n`;
  msg += `OVR    Ct   Pct     Bar\n`;
  msg += '─'.repeat(42) + '\n';
  for (const ovr of OVR_ORDER) {
    const count = s.ovr[ovr] || 0;
    if (count === 0) continue;
    const pct    = (count / s.total) * 100;
    const pctStr = pct.toFixed(1) + '%';
    const bar    = '█'.repeat(ovrToBar[ovr] || 1);
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
  scheduleSave();
  console.log(`💰 ${label} earnings added: ${amount} for ${date}`);
  await message.reply(`✅ Added **${fmt(amount)} coins** from ${label} to **${date}**!`);
}

// ─── READY ─────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  data = await loadData();  // only pull — ever
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

  // !stats — reads from memory, no pull
  if (content === '!stats') {
    console.log(`📊 !stats by ${message.author.tag}`);
    if (data.stats.total === 0) { await message.reply('📊 No drops registered yet!'); return; }
    await message.reply(buildStatsMsg(data.stats, 'Drop Stats'));
    return;
  }

  // !mystats — reads from memory, no pull
  if (content === '!mystats') {
    const userId   = message.author.id;
    const userStat = data.userStats && data.userStats[userId];
    if (!userStat || userStat.total === 0) {
      await message.reply(`📊 No personal drop stats recorded for you yet${data.recordingEnabled === false ? ' (recording is currently off)' : ''}!`);
      return;
    }
    console.log(`📊 !mystats by ${message.author.tag}`);
    await message.reply(buildStatsMsg(userStat, `${message.author.username}'s Stats`));
    return;
  }

  // !recording on/off — owner only
  if (content === '!recording on') {
    if (message.author.id !== OWNER_ID) { await message.reply('❌ Owner only!'); return; }
    data.recordingEnabled = true;
    scheduleSave();
    await message.reply('✅ **Recording ON** — drops will now log to everyone\'s `!mystats`.');
    return;
  }

  if (content === '!recording off') {
    if (message.author.id !== OWNER_ID) { await message.reply('❌ Owner only!'); return; }
    data.recordingEnabled = false;
    scheduleSave();
    await message.reply('🔕 **Recording OFF** — drops will still count in `!stats` but not in personal `!mystats`.');
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
    if (message.author.id !== OWNER_ID) { await message.reply('❌ Owner only!'); return; }
    data.stats = { total: 0, ovr: {}, unknown: [] };
    scheduleSave();
    await message.reply('🗑️ Global stats reset!');
    return;
  }

  // !resetmystats
  if (content === '!resetmystats') {
    const userId = message.author.id;
    if (data.userStats && data.userStats[userId]) {
      data.userStats[userId] = { total: 0, ovr: {}, unknown: [] };
      scheduleSave();
    }
    await message.reply('🗑️ Your personal stats have been reset!');
    return;
  }

  // !myavg
  if (content === '!myavg') {
    if (!isWhitelisted(message.author.id)) { await message.reply('❌ You do not have access to this command!'); return; }
    const o = data.owner;
    if (!o || o.totalDrops === 0) { await message.reply('📊 No sale data yet!'); return; }
    const avg = Math.round(o.totalSale / o.totalDrops);
    await message.reply(`💰 **Your Drop Averages**\n\`\`\`\nTotal drops : ${o.totalDrops}\nTotal earned: ${fmt(o.totalSale)} coins\nAvg per drop: ${fmt(avg)} coins\`\`\``);
    return;
  }

  // !adduser — owner only, grants whitelist access
  if (content.startsWith('!adduser')) {
    if (message.author.id !== OWNER_ID) { await message.reply('❌ Owner only!'); return; }
    const mentioned = message.mentions.users.first();
    if (!mentioned) { await message.reply('❌ Usage: `!adduser @user`'); return; }
    if (mentioned.id === OWNER_ID) { await message.reply('❌ You are already the owner!'); return; }
    data.whitelist = data.whitelist || {};
    data.whitelist[mentioned.id] = mentioned.tag;
    scheduleSave();
    await message.reply(`✅ **${mentioned.tag}** has been granted access to \`!myearnings\` and \`!myavg\`!`);
    return;
  }

  // !removeuser — owner only, revokes whitelist access
  if (content.startsWith('!removeuser')) {
    if (message.author.id !== OWNER_ID) { await message.reply('❌ Owner only!'); return; }
    const mentioned = message.mentions.users.first();
    if (!mentioned) { await message.reply('❌ Usage: `!removeuser @user`'); return; }
    if (!data.whitelist || !data.whitelist[mentioned.id]) {
      await message.reply(`❌ **${mentioned.tag}** is not in the whitelist.`);
      return;
    }
    delete data.whitelist[mentioned.id];
    scheduleSave();
    await message.reply(`✅ **${mentioned.tag}** has been removed from the whitelist.`);
    return;
  }

  // !listusers — owner only, shows current whitelist
  if (content === '!listusers') {
    if (message.author.id !== OWNER_ID) { await message.reply('❌ Owner only!'); return; }
    const wl = data.whitelist || {};
    const entries = Object.values(wl);
    if (entries.length === 0) { await message.reply('📋 Whitelist is empty.'); return; }
    await message.reply(`📋 **Whitelisted users:**\n${entries.map(t => `• ${t}`).join('\n')}`);
    return;
  }

  // !addvote
  if (content.startsWith('!addvote')) { await addIncome(message, 'vote', 'Vote'); return; }

  // !myearnings
  if (content === '!myearnings') {
    if (!isWhitelisted(message.author.id)) { await message.reply('❌ You do not have access to this command!'); return; }
    const o = data.owner;
    if (!o || !o.days || Object.keys(o.days).length === 0) { await message.reply('📊 No earnings data yet!'); return; }

    const allDays   = Object.entries(o.days).sort((a,b) => a[0].localeCompare(b[0]));
    const last7     = allDays.slice(-7);
    const n         = last7.length;
    const totalDays = allDays.length;

    const tot7Drop   = last7.reduce((s,[,d]) => s + (d.totalSale||0), 0);
    const tot7Vote   = last7.reduce((s,[,d]) => s + (d.vote||0), 0);
    const tot7All    = tot7Drop + tot7Vote;

    const totAllDrop = allDays.reduce((s,[,d]) => s + (d.totalSale||0), 0);
    const totAllVote = allDays.reduce((s,[,d]) => s + (d.vote||0), 0);
    const totAllAll  = totAllDrop + totAllVote;

    const avgDrop    = Math.round(totAllDrop / totalDays);
    const avgVote    = Math.round(totAllVote / totalDays);
    const avgAll     = Math.round(totAllAll  / totalDays);

    let bestDate = '', bestTotal = 0;
    for (const [date, d] of allDays) {
      const dayTotal = (d.totalSale||0) + (d.vote||0);
      if (dayTotal > bestTotal) { bestTotal = dayTotal; bestDate = date; }
    }
    const bestDay  = o.days[bestDate] || {};
    const bestDrop = bestDay.totalSale || 0;
    const bestVote = bestDay.vote || 0;

    const C       = { date:11, dr:4, drop:9, vote:9, total:9 };
    const divider = '─'.repeat(C.date + C.dr + C.drop + C.vote + C.total);

    let msg = `💰 **Your Daily Earnings (last ${n} days)**\n\`\`\`\n`;
    msg += pad('Date',C.date) + pad('Dr',C.dr) + pad('Drop',C.drop) + pad('Vote',C.vote) + 'Total\n';
    msg += divider + '\n';
    for (const [date, d] of last7) {
      const total = (d.totalSale||0) + (d.vote||0);
      msg += pad(date,C.date) + pad(d.drops||0,C.dr) + pad(fmt(d.totalSale||0),C.drop) + pad(fmt(d.vote||0),C.vote) + fmt(total) + '\n';
    }
    msg += divider + '\n';
    msg += pad('7d Total',C.date)  + pad('',C.dr) + pad(fmt(tot7Drop),C.drop)   + pad(fmt(tot7Vote),C.vote)   + fmt(tot7All)   + '\n';
    msg += pad('All Total',C.date) + pad('',C.dr) + pad(fmt(totAllDrop),C.drop) + pad(fmt(totAllVote),C.vote) + fmt(totAllAll) + '\n';
    msg += divider + '\n';
    msg += pad('Avg/day',C.date)   + pad('',C.dr) + pad(fmt(avgDrop),C.drop)    + pad(fmt(avgVote),C.vote)    + fmt(avgAll)    + '\n';
    msg += divider + '\n';
    msg += pad(`🏆 ${bestDate}`,C.date + C.dr) + pad(fmt(bestDrop),C.drop) + pad(fmt(bestVote),C.vote) + fmt(bestTotal) + '\n';
    msg += '`\`\`';
    await message.reply(msg);
    return;
  }

  // !remind off
  if (content === '!remind off') {
    data.reminderDisabled = data.reminderDisabled || {};
    data.reminderDisabled[message.author.id] = true;
    scheduleSave();
    await message.reply('🔕 Reminders disabled! Type `!remind on` to enable again.');
    return;
  }

  // !remind on
  if (content === '!remind on') {
    data.reminderDisabled = data.reminderDisabled || {};
    delete data.reminderDisabled[message.author.id];
    scheduleSave();
    await message.reply('🔔 Reminders enabled!');
    return;
  }

  // ─── cgdrop detection ──────────────────────────────────────
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

      // ── Always log to global !stats ──
      data.stats.total += 1;
      if (ovr) {
        data.stats.ovr[ovr] = (data.stats.ovr[ovr] || 0) + 1;
      } else {
        data.stats.unknown = data.stats.unknown || [];
        data.stats.unknown.push({ value: cardValue, user: message.author.tag, time: new Date().toLocaleString() });
        await channel.send(`⚠️ <@${userId}> Unknown card value **${cardValue}** — not in OVR map! Use \`!unknown\` to review.`);
      }

      // ── Log to !mystats only if recording is on OR user is owner ──
      const recordingOn = data.recordingEnabled !== false; // default true
      if (recordingOn || userId === OWNER_ID) {
        data.userStats = data.userStats || {};
        data.userStats[userId] = data.userStats[userId] || { total: 0, ovr: {}, unknown: [] };
        const us = data.userStats[userId];
        us.total += 1;
        if (ovr) {
          us.ovr[ovr] = (us.ovr[ovr] || 0) + 1;
        } else {
          us.unknown = us.unknown || [];
          us.unknown.push({ value: cardValue, time: new Date().toLocaleString() });
        }
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

    if (cardMatch || saleMatch) scheduleSave();
    console.log(`✅ Claim succeeded for ${message.author.tag}!`);
  } else {
    console.log(`⚠️ No game bot response. Assuming claim succeeded for ${message.author.tag}.`);
  }

  // ── Reminder logic ──
  const isDisabled = (data.reminderDisabled && data.reminderDisabled[userId]);
  if (isDisabled) {
    console.log(`🔕 Reminders disabled for ${message.author.tag}, skipping.`);
    return;
  }

  if (activeReminders.has(userId)) clearTimeout(activeReminders.get(userId));
  await message.react('⏰').catch(e => console.error('React error:', e.message));

  const remindAt = Date.now() + REMIND_AFTER_MS;
  data.reminders[userId] = { remindAt, channelId: message.channel.id };
  scheduleSave();

  const timeout = setTimeout(async () => {
    sendReminder(userId, message.channel.id);
    delete data.reminders[userId];
    scheduleSave();
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

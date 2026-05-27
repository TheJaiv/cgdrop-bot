const fs   = require('fs');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const http = require('http');

// ══════════════════════════════════════════════════════════════════════════════
//  CONFIG  (all secrets via environment variables)
// ══════════════════════════════════════════════════════════════════════════════
const JSONBIN_KEY         = process.env.JSONBIN_KEY;
const CGDROP_BIN_ID_ENV   = process.env.CGDROP_BIN_ID || process.env.JSONBIN_BIN_ID || null;
const AUCTION_BIN_ID_ENV  = process.env.AUCTION_BIN_ID  || null;
const AUCTION_LOCAL_FILE  = './auction_data.json';
const OWNER_ID            = process.env.OWNER_ID;
const DISCORD_TOKEN       = process.env.DISCORD_TOKEN;

// Default prefixes — configurable per guild
const DEFAULT_CGDROP_PREFIX  = '!';
const DEFAULT_AUCTION_PREFIX = '.';

// ── Server approval checks ─────────────────────────────────────────────────
function isAuctionApproved(guildId) {
  return !!(auctionData.approvedGuilds && auctionData.approvedGuilds[String(guildId)]);
}
function isCgApproved(guildId) {
  return !!(cgData.approvedGuilds && cgData.approvedGuilds[String(guildId)]);
}

// cgdrop timing
const BOT_WAIT_MS    = 5000;

// ══════════════════════════════════════════════════════════════════════════════
//  IN-MEMORY STATE
// ══════════════════════════════════════════════════════════════════════════════
let cgdropBinId  = CGDROP_BIN_ID_ENV;
let auctionBinId = AUCTION_BIN_ID_ENV;

// cgdrop data
let cgData = {
  reminders: {}, reminderDisabled: {}, reminderTime: {},
  stats: { total: 0, ovr: {}, unknown: [] },
  userStats: {}, userEarnings: {}, owner: null,
  whitelist: {}, recordingEnabled: true,
  guildPrefixes: {}   // cgdrop prefix per guild
};

// auction data
let auctionData = {
  guilds: {},          // keyed by guild id
  guildPrefixes: {}    // auction prefix per guild
};

const processedMsgIds = new Set();
const activeReminders = new Map();

// ══════════════════════════════════════════════════════════════════════════════
//  JSONBIN HELPERS
// ══════════════════════════════════════════════════════════════════════════════
async function loadBin(binId, label) {
  try {
    const res  = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_KEY }
    });
    const json = await res.json();
    console.log(`✅ ${label} data loaded from JSONBin`);
    return json.record;
  } catch (e) {
    console.error(`Error loading ${label} from JSONBin:`, e.message);
    return null;
  }
}

async function saveBin(data, binIdRef, setFn, label, binName) {
  try {
    if (!binIdRef) {
      const res  = await fetch('https://api.jsonbin.io/v3/b', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': JSONBIN_KEY,
          'X-Bin-Name': binName,
          'X-Bin-Private': 'true'
        },
        body: JSON.stringify(data)
      });
      const json = await res.json();
      setFn(json.metadata.id);
      console.log(`✅ Created new JSONBin for ${label}: ${json.metadata.id}`);
      console.log(`⚠️  ADD TO ENV: ${binName.toUpperCase().replace(/-/g,'_')}_BIN_ID=${json.metadata.id}`);
    } else {
      await fetch(`https://api.jsonbin.io/v3/b/${binIdRef}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
        body: JSON.stringify(data)
      });
      console.log(`💾 ${label} saved to JSONBin`);
    }
  } catch (e) {
    console.error(`Error saving ${label} to JSONBin:`, e.message);
  }
}

// ── Local file helpers ────────────────────────────────────────────────────
function loadLocalAuction() {
  try {
    if (fs.existsSync(AUCTION_LOCAL_FILE)) {
      const raw = fs.readFileSync(AUCTION_LOCAL_FILE, 'utf8');
      console.log('✅ Auction data loaded from local file');
      return JSON.parse(raw);
    }
  } catch (e) { console.error('Error reading local auction file:', e.message); }
  return null;
}

function saveLocalAuction() {
  try {
    fs.writeFileSync(AUCTION_LOCAL_FILE, JSON.stringify(auctionData), 'utf8');
  } catch (e) { console.error('Error writing local auction file:', e.message); }
}

// ── Dirty flags — mark data as changed, actual upload happens on interval ──
let cgDirty = false, auctionDirty = false;

function scheduleCgSave()      { cgDirty = true; }
function scheduleAuctionSave() {
  saveLocalAuction();   // instant local write
  auctionDirty = true;  // mark for next 30-min JSONBin sync
}

// ── Flush: only uploads if dirty, resets flag after ────────────────────────
async function flushCg() {
  if (!cgDirty) return;
  cgDirty = false;
  await saveBin(cgData, cgdropBinId, id => { cgdropBinId = id; }, 'cgdrop', 'cgdrop-bot-data');
}

async function flushAuction() {
  if (!auctionDirty) return;
  auctionDirty = false;
  saveLocalAuction(); // ensure local is up to date
  await saveBin(auctionData, auctionBinId, id => { auctionBinId = id; }, 'auction', 'auction-bot-data');
}

// ── Periodic upload every 30 minutes ───────────────────────────────────────
const FLUSH_INTERVAL_MS = 30 * 60 * 1000;
function startFlushInterval() {
  setInterval(async () => {
    await flushCg();
    await flushAuction();
  }, FLUSH_INTERVAL_MS);
  console.log('⏱️  Auto-flush every 30 min started');
}

// ══════════════════════════════════════════════════════════════════════════════
//  PREFIX HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function getCgPrefix(guildId)      { return (cgData.guildPrefixes     && cgData.guildPrefixes[guildId])      || DEFAULT_CGDROP_PREFIX; }
function getAuctionPrefix(guildId) { return (auctionData.guildPrefixes && auctionData.guildPrefixes[guildId]) || DEFAULT_AUCTION_PREFIX; }

// ══════════════════════════════════════════════════════════════════════════════
//  AUCTION DATA HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function getGuildData(guildId) {
  const gid = String(guildId);
  if (!auctionData.guilds[gid]) {
    auctionData.guilds[gid] = {
      logChannel: null,
      purses: {},
      squads: {},
      auction: null,
      queue: [],
      difference: 500000,
    };
  }
  return auctionData.guilds[gid];
}

// ══════════════════════════════════════════════════════════════════════════════
//  AMOUNT HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function parseAmount(value) {
  if (!value) return null;
  const s = String(value).trim().replace(/,/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function formatAmount(amount) {
  if (amount === null || amount === undefined) return '0';
  // Show up to 2 decimal places, strip trailing zeros
  return parseFloat(amount.toFixed(2)).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmt(n) { return Number(n || 0).toLocaleString(); }

// ══════════════════════════════════════════════════════════════════════════════
//  PERMISSION HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function isWhitelisted(userId) {
  if (userId === OWNER_ID) return true;
  return !!(cgData.whitelist && cgData.whitelist[userId]);
}

function hasAuctionPermission(member) {
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return member.roles.cache.some(r => r.name === 'Auctioneer');
}

// ══════════════════════════════════════════════════════════════════════════════
//  CGDROP HELPERS
// ══════════════════════════════════════════════════════════════════════════════
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

function getISTDate(offset = 0) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function pad(str, len) { return String(str).padEnd(len); }

function extractText(msg) {
  let text = msg.content || '';
  for (const embed of msg.embeds) {
    if (embed.title)        text += ' ' + embed.title;
    if (embed.description)  text += ' ' + embed.description;
    for (const f of (embed.fields || [])) text += ' ' + f.name + ' ' + f.value;
    if (embed.footer?.text) text += ' ' + embed.footer.text;
  }
  return text;
}

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
  msg += '```';
  if (s.unknown && s.unknown.length > 0)
    msg += `\n⚠️ **${s.unknown.length} unknown card value(s)** — use \`!unknown\` to see them`;
  return msg;
}

function buildEarningsMsg(earningsData, username) {
  if (!earningsData || !earningsData.days || Object.keys(earningsData.days).length === 0) return null;
  const allDays   = Object.entries(earningsData.days).sort((a,b) => a[0].localeCompare(b[0]));
  const last7     = allDays.slice(-7);
  const n         = last7.length;
  const totalDays = allDays.length;
  const tot7Drop   = last7.reduce((s,[,d]) => s + (d.totalSale||0), 0);
  const tot7Vote   = last7.reduce((s,[,d]) => s + (d.vote||0), 0);
  const tot7Match  = last7.reduce((s,[,d]) => s + (d.match||0), 0);
  const tot7All    = tot7Drop + tot7Vote + tot7Match;
  const totAllDrop  = allDays.reduce((s,[,d]) => s + (d.totalSale||0), 0);
  const totAllVote  = allDays.reduce((s,[,d]) => s + (d.vote||0), 0);
  const totAllMatch = allDays.reduce((s,[,d]) => s + (d.match||0), 0);
  const totAllAll   = totAllDrop + totAllVote + totAllMatch;
  const avgDrop    = Math.round(totAllDrop  / totalDays);
  const avgVote    = Math.round(totAllVote  / totalDays);
  const avgMatch   = Math.round(totAllMatch / totalDays);
  const avgAll     = avgDrop + avgVote + avgMatch;
  let bestDate = '', bestTotal = 0;
  for (const [date, d] of allDays) {
    const dayTotal = (d.totalSale||0) + (d.vote||0) + (d.match||0);
    if (dayTotal > bestTotal) { bestTotal = dayTotal; bestDate = date; }
  }
  const bestDay   = earningsData.days[bestDate] || {};
  const bestDrop  = bestDay.totalSale || 0;
  const bestVote  = bestDay.vote || 0;
  const bestMatch = bestDay.match || 0;
  const C       = { date:11, dr:4, drop:9, vote:9, match:9, total:9 };
  const divider = '─'.repeat(C.date + C.dr + C.drop + C.vote + C.match + C.total);
  let msg = `💰 **${username}'s Daily Earnings (last ${n} days)**\n\`\`\`\n`;
  msg += pad('Date',C.date) + pad('Dr',C.dr) + pad('Drop',C.drop) + pad('Vote',C.vote) + pad('Match',C.match) + 'Total\n';
  msg += divider + '\n';
  for (const [date, d] of last7) {
    const total = (d.totalSale||0) + (d.vote||0) + (d.match||0);
    msg += pad(date,C.date) + pad(d.drops||0,C.dr) + pad(fmt(d.totalSale||0),C.drop) + pad(fmt(d.vote||0),C.vote) + pad(fmt(d.match||0),C.match) + fmt(total) + '\n';
  }
  msg += divider + '\n';
  msg += pad('7d Total',C.date)  + pad('',C.dr) + pad(fmt(tot7Drop),C.drop)   + pad(fmt(tot7Vote),C.vote)   + pad(fmt(tot7Match),C.match)   + fmt(tot7All)   + '\n';
  msg += pad('All Total',C.date) + pad('',C.dr) + pad(fmt(totAllDrop),C.drop) + pad(fmt(totAllVote),C.vote) + pad(fmt(totAllMatch),C.match) + fmt(totAllAll) + '\n';
  msg += divider + '\n';
  msg += pad('Avg/day',C.date)   + pad('',C.dr) + pad(fmt(avgDrop),C.drop)    + pad(fmt(avgVote),C.vote)    + pad(fmt(avgMatch),C.match)    + fmt(avgAll)    + '\n';
  msg += divider + '\n';
  msg += pad(`🏆 ${bestDate}`,C.date + C.dr) + pad(fmt(bestDrop),C.drop) + pad(fmt(bestVote),C.vote) + pad(fmt(bestMatch),C.match) + fmt(bestTotal) + '\n';
  msg += '```';
  return msg;
}

// ══════════════════════════════════════════════════════════════════════════════
//  REMINDER HELPERS
// ══════════════════════════════════════════════════════════════════════════════
async function sendReminder(userId, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(`<@${userId}> ⏰ **cgdrop reminder!** 1 hour's up — go claim your drop! 🎁\nTo disable reminders type \`!remind off\``);
  } catch {
    try {
      const user = await client.users.fetch(userId);
      await user.send(`⏰ **cgdrop reminder!** 1 hour's up — go claim your drop! 🎁`);
    } catch (err) { console.error('Could not send reminder:', err); }
  }
}

async function restoreReminders() {
  const now = Date.now();
  for (const [userId, rem] of Object.entries(cgData.reminders || {})) {
    const timeLeft = rem.remindAt - now;
    if (timeLeft <= 0) {
      sendReminder(userId, rem.channelId);
      delete cgData.reminders[userId];
      scheduleCgSave();
    } else {
      const timeout = setTimeout(async () => {
        sendReminder(userId, rem.channelId);
        delete cgData.reminders[userId];
        scheduleCgSave();
        activeReminders.delete(userId);
      }, timeLeft);
      activeReminders.set(userId, timeout);
      console.log(`⏰ Restored reminder for ${userId} — ${Math.ceil(timeLeft/60000)} min left`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUCTION HELPERS
// ══════════════════════════════════════════════════════════════════════════════
async function sendLog(guild, embed) {
  const gd = getGuildData(guild.id);
  if (gd.logChannel) {
    const ch = guild.channels.cache.get(gd.logChannel);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

async function doSold(message, gd) {
  const auction = gd.auction;
  if (!auction) {
    return message.channel.send('❌ No auction is currently running.');
  }

  const { player, current_bid: bid, highest_bidder: bidderName, highest_bidder_id: bidderId } = auction;
  let embed;

  if (bidderId) {
    const curPurse = gd.purses[bidderId] || 0;
    gd.purses[bidderId] = Math.max(0, curPurse - bid);
    if (!gd.squads[bidderId]) gd.squads[bidderId] = [];
    gd.squads[bidderId].push({ player, price: bid });

    embed = new EmbedBuilder()
      .setTitle('🔨 SOLD!')
      .setDescription(`**${player}** has been sold to **${bidderName}** for **${formatAmount(bid)}**!`)
      .setColor(0xFFD700)
      .addFields({ name: 'Remaining Balance', value: formatAmount(gd.purses[bidderId]), inline: true })
      .setTimestamp();
  } else {
    embed = new EmbedBuilder()
      .setTitle('🔨 UNSOLD')
      .setDescription(`**${player}** received no bids and is unsold.`)
      .setColor(0xAAAAAA)
      .setTimestamp();
  }

  gd.auction = null;
  scheduleAuctionSave();

  const ch = message.guild.channels.cache.get(auction.channel_id) || message.channel;
  await ch.send({ embeds: [embed] });
  await sendLog(message.guild, embed);

  // Auto-start next from queue
  if (gd.queue && gd.queue.length > 0) {
    const next = gd.queue.shift();
    gd.auction = {
      player: next.player,
      base: next.base,
      current_bid: next.base,
      difference: next.difference,
      highest_bidder: null,
      highest_bidder_id: null,
      channel_id: String(ch.id)
    };
    scheduleAuctionSave();

    const nextEmbed = new EmbedBuilder()
      .setTitle('🏏 NEXT AUCTION STARTED!')
      .setDescription(`*Auto-started from queue — ${gd.queue.length} player(s) remaining.*`)
      .setColor(0xFF0000)
      .addFields(
        { name: 'Player',        value: `**${next.player}**`,           inline: true },
        { name: 'Base Price',    value: formatAmount(next.base),        inline: true },
        { name: 'Min Increment', value: formatAmount(next.difference),  inline: true }
      )
      .setTimestamp();
    await ch.send({ embeds: [nextEmbed] });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  CLIENT
// ══════════════════════════════════════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

// ══════════════════════════════════════════════════════════════════════════════
//  READY
// ══════════════════════════════════════════════════════════════════════════════
client.once('ready', async () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);

  // Load both bins
  if (cgdropBinId) {
    const loaded = await loadBin(cgdropBinId, 'cgdrop');
    if (loaded) cgData = { ...cgData, ...loaded };
  }

  // Auction: prefer local file, only pull JSONBin as fallback on first boot
  const localAuction = loadLocalAuction();
  if (localAuction) {
    auctionData = { ...auctionData, ...localAuction };
    console.log('📂 Auction loaded from local file (no JSONBin pull needed)');
  } else if (auctionBinId) {
    const loaded = await loadBin(auctionBinId, 'auction');
    if (loaded) {
      auctionData = { ...auctionData, ...loaded };
      saveLocalAuction(); // seed local file from JSONBin
      console.log('☁️  Auction seeded from JSONBin → saved locally');
    }
  }

  await restoreReminders();
  startFlushInterval();

  // Register slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName('sell')
      .setDescription('Start an auction for a player')
      .addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true))
      .addStringOption(o => o.setName('base').setDescription('Base price (e.g. 2m, 500k)').setRequired(true))
      .addStringOption(o => o.setName('increment').setDescription('Min increment (optional)')),
    new SlashCommandBuilder()
      .setName('setauctionprefix')
      .setDescription('Change the auction command prefix for this server')
      .addStringOption(o => o.setName('prefix').setDescription('New prefix (e.g. .)').setRequired(true)),
    new SlashCommandBuilder()
      .setName('setcgprefix')
      .setDescription('Change the cgdrop command prefix for this server')
      .addStringOption(o => o.setName('prefix').setDescription('New prefix (e.g. !)').setRequired(true)),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered globally');
  } catch (e) { console.error('Slash command registration failed:', e.message); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  SLASH COMMANDS
// ══════════════════════════════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const guildId = interaction.guildId;

  if (interaction.commandName === 'sell') {
    if (!hasAuctionPermission(interaction.member)) {
      return interaction.reply({ content: '❌ You need **Administrator** or **Auctioneer** role.', ephemeral: true });
    }
    const gd = getGuildData(guildId);
    if (gd.auction) return interaction.reply({ content: '❌ An auction is already running!', ephemeral: true });

    const playerName = interaction.options.getString('player');
    const base       = parseAmount(interaction.options.getString('base'));
    const incRaw     = interaction.options.getString('increment');
    if (!base) return interaction.reply({ content: '❌ Invalid base price.', ephemeral: true });
    const diff = incRaw ? parseAmount(incRaw) : (gd.difference || 500000);

    gd.auction = { player: playerName, base, current_bid: base, difference: diff,
      highest_bidder: null, highest_bidder_id: null, channel_id: String(interaction.channelId) };
    scheduleAuctionSave();

    const embed = new EmbedBuilder()
      .setTitle('🏏 AUCTION STARTED!')
      .setColor(0xFF0000)
      .addFields(
        { name: 'Player',        value: `**${playerName}**`,  inline: true },
        { name: 'Base Price',    value: formatAmount(base),   inline: true },
        { name: 'Min Increment', value: formatAmount(diff),   inline: true },
        { name: 'How to bid',    value: `Use \`${getAuctionPrefix(guildId)}bid <amount>\` to place a bid!`, inline: false }
      )
      .setFooter({ text: `Started by ${interaction.user.tag}` })
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'setauctionprefix') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
      return interaction.reply({ content: '❌ Admin only!', ephemeral: true });
    const np = interaction.options.getString('prefix');
    auctionData.guildPrefixes = auctionData.guildPrefixes || {};
    auctionData.guildPrefixes[guildId] = np;
    scheduleAuctionSave();
    return interaction.reply({ content: `✅ Auction prefix changed to \`${np}\``, ephemeral: true });
  }

  if (interaction.commandName === 'setcgprefix') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
      return interaction.reply({ content: '❌ Admin only!', ephemeral: true });
    const np = interaction.options.getString('prefix');
    cgData.guildPrefixes = cgData.guildPrefixes || {};
    cgData.guildPrefixes[guildId] = np;
    scheduleCgSave();
    return interaction.reply({ content: `✅ CGDrop prefix changed to \`${np}\``, ephemeral: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════════════════════
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const content    = message.content.trim();
  const lower      = content.toLowerCase();
  const guildId    = message.guild?.id;
  const cgPfx      = guildId ? getCgPrefix(guildId)      : DEFAULT_CGDROP_PREFIX;
  const aucPfx     = guildId ? getAuctionPrefix(guildId) : DEFAULT_AUCTION_PREFIX;
  const userId     = message.author.id;

  // ── Determine which prefix was used ──────────────────────────────────────
  const usesCg  = content.startsWith(cgPfx);
  const usesAuc = content.startsWith(aucPfx);

  // Strip prefix and get command + args
  const cgCmd  = usesCg  ? lower.slice(cgPfx.length).trim()      : null;
  const aucCmd = usesAuc ? lower.slice(aucPfx.length).trim()      : null;
  const cgArgs  = usesCg  ? content.slice(cgPfx.length).trim().split(/\s+/).slice(1)  : [];
  const aucArgs = usesAuc ? content.slice(aucPfx.length).trim().split(/\s+/).slice(1) : [];
  const aucRaw  = usesAuc ? content.slice(aucPfx.length).trim()   : null;

  // ════════════════════════════════════════════════════════════════════════
  //  CGDROP COMMANDS  (! prefix)
  // ════════════════════════════════════════════════════════════════════════

  if (usesCg) {

    // Always allow !help regardless of approval
    const cgOwnerCmds = ['approveauction','approvecg','unapproveauction','unapprovecg','listapprovals'];
    if (cgCmd !== 'help' && cgCmd !== 'ping' && !cgOwnerCmds.includes(cgCmd) && !isCgApproved(guildId)) {
      await message.channel.send('⛔ This server is not approved for cgdrop commands.\nContact **frenzy_guy** to get access.');
      return;
    }

    // !ping
    if (cgCmd === 'ping') {
      await message.channel.send('✅ Bot is alive and watching for cgdrop!');
      return;
    }

    // !stats
    if (cgCmd === 'stats') {
      if (cgData.stats.total === 0) { await message.channel.send('📊 No drops registered yet!'); return; }
      await message.channel.send(buildStatsMsg(cgData.stats, 'Drop Stats'));
      return;
    }

    // !mystats
    if (cgCmd === 'mystats') {
      const us = cgData.userStats && cgData.userStats[userId];
      if (!us || us.total === 0) {
        await message.channel.send(`📊 No personal drop stats recorded for you yet${cgData.recordingEnabled === false ? ' (recording is currently off)' : ''}!`);
        return;
      }
      await message.channel.send(buildStatsMsg(us, `${message.author.username}'s Stats`));
      return;
    }

    // !recording on/off
    if (cgCmd === 'recording on') {
      if (userId !== OWNER_ID) { await message.channel.send('❌ Owner only!'); return; }
      cgData.recordingEnabled = true; scheduleCgSave();
      await message.channel.send('✅ **Recording ON**'); return;
    }
    if (cgCmd === 'recording off') {
      if (userId !== OWNER_ID) { await message.channel.send('❌ Owner only!'); return; }
      cgData.recordingEnabled = false; scheduleCgSave();
      await message.channel.send('🔕 **Recording OFF**'); return;
    }

    // !unknown
    if (cgCmd === 'unknown') {
      const unknowns = cgData.stats.unknown || [];
      if (unknowns.length === 0) { await message.channel.send('✅ No unknown card values logged!'); return; }
      const list = unknowns.slice(-20).map(u => `• Value: **${u.value}** by ${u.user} at ${u.time}`).join('\n');
      await message.channel.send(`⚠️ **Unknown card values (last 20):**\n${list}`);
      return;
    }

    // !resetstats
    if (cgCmd === 'resetstats') {
      if (userId !== OWNER_ID) { await message.channel.send('❌ Owner only!'); return; }
      cgData.stats = { total: 0, ovr: {}, unknown: [] }; scheduleCgSave();
      await message.channel.send('🗑️ Global stats reset!'); return;
    }

    // !resetmystats
    if (cgCmd === 'resetmystats') {
      if (cgData.userStats && cgData.userStats[userId])
        cgData.userStats[userId] = { total: 0, ovr: {}, unknown: [] };
      scheduleCgSave();
      await message.channel.send('🗑️ Your personal stats have been reset!'); return;
    }

    // !myavg
    if (cgCmd === 'myavg') {
      if (!isWhitelisted(userId)) { await message.channel.send('❌ You do not have access to this command!'); return; }
      const isOwner      = userId === OWNER_ID;
      const earningsData = isOwner ? cgData.owner : (cgData.userEarnings && cgData.userEarnings[userId]);
      if (!earningsData || !earningsData.days || Object.keys(earningsData.days).length === 0) {
        await message.channel.send('📊 No earnings data yet!'); return;
      }
      const allDays   = Object.entries(earningsData.days);
      const totalDays = allDays.length;
      const avgDrop   = Math.round(allDays.reduce((s,[,d]) => s + (d.totalSale||0), 0) / totalDays);
      const avgVote   = Math.round(allDays.reduce((s,[,d]) => s + (d.vote||0),      0) / totalDays);
      const avgMatch  = Math.round(allDays.reduce((s,[,d]) => s + (d.match||0),     0) / totalDays);
      const avgAll    = avgDrop + avgVote + avgMatch;
      const name      = isOwner ? 'Your' : message.author.username + "'s";
      const C         = { label:10, drop:9, vote:9, match:9, total:9 };
      const divider   = '─'.repeat(C.label + C.drop + C.vote + C.match + C.total);
      let msg = `📊 **${name} Daily Averages** (all-time, ${totalDays} days)\n\`\`\`\n`;
      msg += pad('',C.label) + pad('Drop',C.drop) + pad('Vote',C.vote) + pad('Match',C.match) + 'Total\n';
      msg += divider + '\n';
      msg += pad('Avg/day',C.label) + pad(fmt(avgDrop),C.drop) + pad(fmt(avgVote),C.vote) + pad(fmt(avgMatch),C.match) + fmt(avgAll) + '\n';
      msg += '```';
      await message.channel.send(msg); return;
    }

    // !adduser
    if (cgCmd && cgCmd.startsWith('adduser')) {
      if (userId !== OWNER_ID) { await message.channel.send('❌ Owner only!'); return; }
      const mentioned = message.mentions.users.first();
      if (!mentioned) { await message.channel.send('❌ Usage: `!adduser @user`'); return; }
      if (mentioned.id === OWNER_ID) { await message.channel.send('❌ You are already the owner!'); return; }
      cgData.whitelist = cgData.whitelist || {};
      cgData.whitelist[mentioned.id] = mentioned.tag;
      scheduleCgSave();
      await message.channel.send(`✅ **${mentioned.tag}** granted access to \`!myearnings\` and \`!myavg\`!`); return;
    }

    // !removeuser
    if (cgCmd && cgCmd.startsWith('removeuser')) {
      if (userId !== OWNER_ID) { await message.channel.send('❌ Owner only!'); return; }
      const mentioned = message.mentions.users.first();
      if (!mentioned) { await message.channel.send('❌ Usage: `!removeuser @user`'); return; }
      if (!cgData.whitelist || !cgData.whitelist[mentioned.id]) {
        await message.channel.send(`❌ **${mentioned.tag}** is not in the whitelist.`); return;
      }
      delete cgData.whitelist[mentioned.id]; scheduleCgSave();
      await message.channel.send(`✅ **${mentioned.tag}** removed from whitelist.`); return;
    }

    // !listusers
    if (cgCmd === 'listusers') {
      if (userId !== OWNER_ID) { await message.channel.send('❌ Owner only!'); return; }
      const entries = Object.values(cgData.whitelist || {});
      if (entries.length === 0) { await message.channel.send('📋 Whitelist is empty.'); return; }
      await message.channel.send(`📋 **Whitelisted users:**\n${entries.map(t => `• ${t}`).join('\n')}`); return;
    }

    // !addvote
    if (cgCmd && cgCmd.startsWith('addvote')) {
      if (!isWhitelisted(userId)) { await message.channel.send('❌ You do not have permission!'); return; }
      const parts  = content.slice(cgPfx.length).trim().split(' ');
      const amount = parseInt((parts[1] || '').replace(/,/g, '').replace(/−/g, '-'));
      if (isNaN(amount)) { await message.channel.send('❌ Usage: `!addvote 4500` or `!addvote 4500 yesterday`'); return; }
      const offset = parts[2] === 'yesterday' ? -1 : 0;
      const date   = getISTDate(offset);
      if (userId === OWNER_ID) {
        cgData.owner = cgData.owner || { totalSale: 0, totalDrops: 0, days: {} };
        cgData.owner.days[date] = cgData.owner.days[date] || { totalSale: 0, drops: 0, vote: 0, match: 0, misc: 0 };
        cgData.owner.days[date].vote = (cgData.owner.days[date].vote || 0) + amount;
      } else {
        cgData.userEarnings = cgData.userEarnings || {};
        cgData.userEarnings[userId] = cgData.userEarnings[userId] || { totalSale: 0, totalDrops: 0, days: {} };
        cgData.userEarnings[userId].days[date] = cgData.userEarnings[userId].days[date] || { totalSale: 0, drops: 0, vote: 0, match: 0, misc: 0 };
        cgData.userEarnings[userId].days[date].vote = (cgData.userEarnings[userId].days[date].vote || 0) + amount;
      }
      scheduleCgSave();
      await message.channel.send(`✅ Added **${fmt(amount)} coins** from Vote to **${date}**!`); return;
    }

    // !addmatch
    if (cgCmd && cgCmd.startsWith('addmatch')) {
      if (!isWhitelisted(userId)) { await message.channel.send('❌ You do not have permission!'); return; }
      const parts  = content.slice(cgPfx.length).trim().split(' ');
      const amount = parseInt((parts[1] || '').replace(/,/g, '').replace(/−/g, '-'));
      if (isNaN(amount)) { await message.channel.send('❌ Usage: `!addmatch 4500` or `!addmatch 4500 yesterday`'); return; }
      const offset = parts[2] === 'yesterday' ? -1 : 0;
      const date   = getISTDate(offset);
      if (userId === OWNER_ID) {
        cgData.owner = cgData.owner || { totalSale: 0, totalDrops: 0, days: {} };
        cgData.owner.days[date] = cgData.owner.days[date] || { totalSale: 0, drops: 0, vote: 0, match: 0, misc: 0 };
        cgData.owner.days[date].match = (cgData.owner.days[date].match || 0) + amount;
      } else {
        cgData.userEarnings = cgData.userEarnings || {};
        cgData.userEarnings[userId] = cgData.userEarnings[userId] || { totalSale: 0, totalDrops: 0, days: {} };
        cgData.userEarnings[userId].days[date] = cgData.userEarnings[userId].days[date] || { totalSale: 0, drops: 0, vote: 0, match: 0, misc: 0 };
        cgData.userEarnings[userId].days[date].match = (cgData.userEarnings[userId].days[date].match || 0) + amount;
      }
      scheduleCgSave();
      await message.channel.send(`✅ Added **${fmt(amount)} coins** from Match to **${date}**!`); return;
    }

    // !myearnings
    if (cgCmd === 'myearnings') {
      if (!isWhitelisted(userId)) { await message.channel.send('❌ You do not have access!'); return; }
      const isOwner      = userId === OWNER_ID;
      const earningsData = isOwner ? cgData.owner : (cgData.userEarnings && cgData.userEarnings[userId]);
      const msg = buildEarningsMsg(earningsData, isOwner ? 'Your' : message.author.username);
      if (!msg) { await message.channel.send('📊 No earnings data yet!'); return; }
      await message.channel.send(msg); return;
    }

    // !remind off/on
    if (cgCmd === 'remind off') {
      cgData.reminderDisabled = cgData.reminderDisabled || {};
      cgData.reminderDisabled[userId] = true; scheduleCgSave();
      await message.channel.send('🔕 Reminders disabled! Type `!remind on` to enable.'); return;
    }
    if (cgCmd === 'remind on') {
      cgData.reminderDisabled = cgData.reminderDisabled || {};
      delete cgData.reminderDisabled[userId]; scheduleCgSave();
      await message.channel.send('🔔 Reminders enabled!'); return;
    }

    // !setreminder
    if (cgCmd && cgCmd.startsWith('setreminder')) {
      if (!isWhitelisted(userId)) { await message.channel.send('❌ You do not have permission!'); return; }
      const mins = parseInt(cgCmd.split(' ')[1]);
      if (isNaN(mins) || mins < 1 || mins > 120) {
        await message.channel.send('❌ Usage: `!setreminder 40` (1–120 minutes)'); return;
      }
      cgData.reminderTime = cgData.reminderTime || {};
      cgData.reminderTime[userId] = mins; scheduleCgSave();
      await message.channel.send(`✅ Drop reminder set to **${mins} minutes**!`); return;
    }

    // !reminderstatus
    if (cgCmd === 'reminderstatus') {
      if (!isWhitelisted(userId)) { await message.channel.send('❌ You do not have permission!'); return; }
      const mins   = (cgData.reminderTime && cgData.reminderTime[userId]) || 60;
      const status = (cgData.reminderDisabled && cgData.reminderDisabled[userId]) ? '🔕 Disabled' : '🔔 Enabled';
      await message.channel.send(`⏰ Your reminder is **${status}** and set to **${mins} minutes**.`); return;
    }

    // !help
    if (cgCmd === 'help' || (cgCmd && cgCmd.startsWith('help '))) {
      const isWL = isWhitelisted(userId);
      const sub  = cgCmd.split(' ')[1] || null; // drop / wl / auction

      // ── Embed builders ──────────────────────────────────────────────────
      function dropEmbed() {
        return new EmbedBuilder()
          .setTitle('🎮 Drop Commands')
          .setColor(0x5865F2)
          .setDescription(`Prefix: \`${cgPfx}\``)
          .addFields(
            { name: `\`${cgPfx}ping\``,         value: 'Check if bot is alive', inline: true },
            { name: `\`${cgPfx}stats\``,         value: 'Global drop OVR stats', inline: true },
            { name: `\`${cgPfx}mystats\``,       value: 'Your personal OVR stats', inline: true },
            { name: `\`${cgPfx}resetmystats\``,  value: 'Reset your personal stats', inline: true },
            { name: `\`${cgPfx}unknown\``,       value: 'View unrecognised card values', inline: true },
            { name: `\`${cgPfx}remind on/off\``, value: 'Toggle your drop reminder', inline: true }
          )
          .setFooter({ text: `Use ${cgPfx}help wl for whitelisted cmds • ${cgPfx}help auction for auction cmds` });
      }

      function wlEmbed() {
        return new EmbedBuilder()
          .setTitle('🔒 Whitelisted Commands')
          .setColor(0x57F287)
          .setDescription(isWL ? `✅ You have access\nPrefix: \`${cgPfx}\`` : '❌ You do not have access\nContact **frenzy_guy** 👑 to get whitelisted.')
          .addFields(
            { name: `\`${cgPfx}myearnings\``,           value: 'Your daily earnings breakdown', inline: true },
            { name: `\`${cgPfx}myavg\``,                value: 'Your all-time daily averages', inline: true },
            { name: `\`${cgPfx}addvote <amt>\``,        value: 'Log vote coins\n(add `yesterday` for prev day)', inline: true },
            { name: `\`${cgPfx}addmatch <amt>\``,       value: 'Log match coins\n(add `yesterday` for prev day)', inline: true },
            { name: `\`${cgPfx}setreminder <mins>\``,   value: 'Set custom reminder time (1–120 min)', inline: true },
            { name: `\`${cgPfx}reminderstatus\``,       value: 'Check your reminder time & status', inline: true }
          )
          .setFooter({ text: `Use ${cgPfx}help drop for drop cmds • ${cgPfx}help auction for auction cmds` });
      }

      function auctionEmbed() {
        return new EmbedBuilder()
          .setTitle('🏏 Auction Commands')
          .setColor(0xFF0000)
          .setDescription(`Prefix: \`${aucPfx}\` — Admin/Auctioneer role required for marked commands`)
          .addFields(
            { name: `\`${aucPfx}sell <player> <base> [inc]\``,  value: 'Start an auction *(Admin/Auctioneer)*', inline: false },
            { name: `\`${aucPfx}bid <amount>\``,                 value: 'Place a bid (omit amount to auto-bid)', inline: false },
            { name: `\`${aucPfx}sold\``,                         value: 'End auction & auto-start next from queue *(Admin/Auctioneer)*', inline: false },
            { name: `\`${aucPfx}aq <player> <base> [inc]\``,    value: 'Add player to auction queue *(Admin/Auctioneer)*', inline: false },
            { name: `\`${aucPfx}sq\``,                           value: 'Start auction from queue *(Admin/Auctioneer)*', inline: false },
            { name: `\`${aucPfx}q\``,                            value: 'View the auction queue', inline: true },
            { name: `\`${aucPfx}rq <index>\``,                  value: 'Remove player from queue *(Admin/Auctioneer)*', inline: true },
            { name: `\`${aucPfx}cq\``,                           value: 'Clear entire queue *(Admin/Auctioneer)*', inline: true },
            { name: `\`${aucPfx}bal [@user]\``,                  value: 'Check purse balance', inline: true },
            { name: `\`${aucPfx}lb\``,                           value: 'Purse leaderboard', inline: true },
            { name: `\`${aucPfx}squad [@user]\``,               value: "View someone's bought players", inline: true },
            { name: `\`${aucPfx}setpurse @user <amt>\``,        value: 'Set a user purse *(Admin/Auctioneer)*', inline: true },
            { name: `\`${aucPfx}slc #channel\``,                value: 'Set log channel *(Admin/Auctioneer)*', inline: true },
            { name: `\`${aucPfx}sd <amount>\``,                 value: 'Set default bid increment *(Admin/Auctioneer)*', inline: true },
            { name: `\`${aucPfx}addsquad @user <player> [price]\``, value: 'Manually add player to squad *(Admin/Auctioneer)*', inline: false },
            { name: `\`${aucPfx}setauctioneer @user\``,         value: 'Grant/revoke Auctioneer role *(Admin)*', inline: false },
            { name: `\`${aucPfx}delete @user <index|all>\``,    value: 'Remove player from squad *(Admin)*', inline: false },
            { name: '`/sell` `/setauctionprefix` `/setcgprefix`', value: 'Slash commands', inline: false }
          )
          .setFooter({ text: `Use ${cgPfx}help drop for drop cmds • ${cgPfx}help wl for whitelisted cmds` });
      }

      // ── Direct sub-command ───────────────────────────────────────────────
      if (sub === 'drop')    { await message.channel.send({ embeds: [dropEmbed()] });    return; }
      if (sub === 'wl')      { await message.channel.send({ embeds: [wlEmbed()] });      return; }
      if (sub === 'auction') { await message.channel.send({ embeds: [auctionEmbed()] }); return; }

      // ── Main menu with buttons ───────────────────────────────────────────
      const menuEmbed = new EmbedBuilder()
        .setTitle('📖 Bot Help')
        .setColor(0x5865F2)
        .setDescription('Choose a category below, or use a shortcut:')
        .addFields(
          { name: `\`${cgPfx}help drop\``,    value: '🎮 Drop commands', inline: true },
          { name: `\`${cgPfx}help wl\``,      value: '🔒 Whitelisted commands', inline: true },
          { name: `\`${cgPfx}help auction\``, value: '🏏 Auction commands', inline: true }
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('help_drop').setLabel('🎮 Drop').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('help_wl').setLabel('🔒 Whitelisted').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('help_auction').setLabel('🏏 Auction').setStyle(ButtonStyle.Danger)
      );

      const sent = await message.channel.send({ embeds: [menuEmbed], components: [row] });

      // Collector — only the person who ran !help can click, expires in 60s
      const collector = sent.createMessageComponentCollector({
        filter: i => i.user.id === userId,
        time: 60_000
      });

      collector.on('collect', async i => {
        if (i.customId === 'help_drop')    await i.update({ embeds: [dropEmbed()],    components: [] });
        if (i.customId === 'help_wl')      await i.update({ embeds: [wlEmbed()],      components: [] });
        if (i.customId === 'help_auction') await i.update({ embeds: [auctionEmbed()], components: [] });
      });

      collector.on('end', (_, reason) => {
        if (reason === 'time') sent.edit({ components: [] }).catch(() => {});
      });

      return;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  AUCTION COMMANDS  (. prefix)
  // ════════════════════════════════════════════════════════════════════════

  if (usesAuc && guildId) {
    const gd = getGuildData(guildId);
    const parts = aucRaw.split(/\s+/);
    const cmd   = parts[0].toLowerCase();

    // Allow approve/unapprove/listapprovals even on unapproved servers (owner only)
    const ownerOnlyCmds = ['approveauction','approvecg','unapproveauction','unapprovecg','listapprovals','sync'];
    if (!ownerOnlyCmds.includes(cmd) && !isAuctionApproved(guildId)) {
      await message.channel.send('⛔ This server is not approved for auction commands.\nContact **frenzy_guy** to get access.');
      return;
    }

    // .setpurse / .sp
    if (cmd === 'setpurse' || cmd === 'sp') {
      if (!hasAuctionPermission(message.member)) {
        await message.channel.send('❌ You need **Administrator** or **Auctioneer** role.'); return;
      }
      const mentioned = message.mentions.members.first();
      const amtRaw    = parts[2];
      if (!mentioned || !amtRaw) { await message.channel.send(`❌ Usage: \`${aucPfx}setpurse @user <amount>\``); return; }
      const parsed = parseAmount(amtRaw);
      if (!parsed) { await message.channel.send('❌ Invalid amount.'); return; }
      gd.purses[mentioned.id] = parsed;
      scheduleAuctionSave();
      const embed = new EmbedBuilder()
        .setTitle('💰 Purse Set')
        .setDescription(`${mentioned} purse set to **${formatAmount(parsed)}**`)
        .setColor(0x00FF00).setTimestamp()
        .setFooter({ text: `Set by ${message.author.tag}` });
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .setlogchannel / .slc
    if (cmd === 'setlogchannel' || cmd === 'slc') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const ch = message.mentions.channels.first();
      if (!ch) { await message.channel.send(`❌ Usage: \`${aucPfx}setlogchannel #channel\``); return; }
      gd.logChannel = ch.id; scheduleAuctionSave();
      const embed = new EmbedBuilder().setTitle('📋 Log Channel Set').setDescription(`Logs → ${ch}`).setColor(0x0099FF);
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .setdifference / .sd
    if (cmd === 'setdifference' || cmd === 'sd') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const parsed = parseAmount(parts[1]);
      if (!parsed) { await message.channel.send('❌ Invalid amount.'); return; }
      gd.difference = parsed; scheduleAuctionSave();
      const embed = new EmbedBuilder().setTitle('⚙️ Bid Increment Set')
        .setDescription(`Min increment: **${formatAmount(parsed)}**`).setColor(0xFF8800);
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .sell
    if (cmd === 'sell') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      if (gd.auction) { await message.channel.send('❌ Auction already running! Use `.sold` first.'); return; }
      const playerName = parts[1];
      const base       = parseAmount(parts[2]);
      if (!playerName || !base) { await message.channel.send(`❌ Usage: \`${aucPfx}sell <player> <base> [increment]\``); return; }
      const diff = parts[3] ? parseAmount(parts[3]) : (gd.difference || 500000);
      gd.auction = { player: playerName, base, current_bid: base, difference: diff,
        highest_bidder: null, highest_bidder_id: null, channel_id: String(message.channel.id) };
      scheduleAuctionSave();
      const embed = new EmbedBuilder().setTitle('🏏 AUCTION STARTED!').setColor(0xFF0000)
        .addFields(
          { name: 'Player',        value: `**${playerName}**`,  inline: true },
          { name: 'Base Price',    value: formatAmount(base),   inline: true },
          { name: 'Min Increment', value: formatAmount(diff),   inline: true },
          { name: 'How to bid',    value: `Use \`${aucPfx}bid <amount>\``, inline: false }
        ).setFooter({ text: `Started by ${message.author.tag}` }).setTimestamp();
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .bid / .b
    if (cmd === 'bid' || cmd === 'b') {
      const auction = gd.auction;
      if (!auction) { await message.channel.send('❌ No auction running.'); return; }

      // Block self-overbid — can't bid if you're already the highest bidder
      if (auction.highest_bidder_id === userId) {
        await message.channel.send(`❌ You already have the highest bid of **${formatAmount(auction.current_bid)}**! Wait for someone else to bid first.`);
        return;
      }

      const userPurse = gd.purses[userId] || 0;
      let bidAmt;
      if (!parts[1]) {
        bidAmt = auction.current_bid + auction.difference;
      } else {
        bidAmt = parseAmount(parts[1]);
        if (!bidAmt) { await message.channel.send('❌ Invalid bid amount.'); return; }
      }
      const minBid = auction.highest_bidder_id ? auction.current_bid + auction.difference : auction.base;
      if (bidAmt < minBid) { await message.channel.send(`❌ Minimum bid is **${formatAmount(minBid)}**.`); return; }
      if (userPurse < bidAmt) { await message.channel.send(`❌ Insufficient funds! Your balance: **${formatAmount(userPurse)}**`); return; }
      auction.current_bid       = bidAmt;
      auction.highest_bidder    = message.member.displayName;
      auction.highest_bidder_id = userId;
      scheduleAuctionSave();
      const embed = new EmbedBuilder().setTitle('💸 New Bid Placed!').setColor(0x00CC00)
        .addFields(
          { name: 'Player', value: auction.player,          inline: true },
          { name: 'Bid',    value: formatAmount(bidAmt),    inline: true },
          { name: 'Bidder', value: `<@${userId}>`,          inline: true }
        ).setTimestamp();
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // .sold
    if (cmd === 'sold') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      await doSold(message, gd); return;
    }

    // .addqueue / .aq
    if (cmd === 'addqueue' || cmd === 'aq') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const playerName = parts[1];
      const base       = parseAmount(parts[2]);
      if (!playerName || !base) { await message.channel.send(`❌ Usage: \`${aucPfx}aq <player> <base> [increment]\``); return; }
      const diff = parts[3] ? parseAmount(parts[3]) : (gd.difference || 500000);
      if (!Array.isArray(gd.queue)) gd.queue = [];
      gd.queue.push({ player: playerName, base, difference: diff });
      scheduleAuctionSave();
      const pos = gd.queue.length;
      const embed = new EmbedBuilder().setTitle('📋 Player Added to Queue')
        .setDescription(`**${playerName}** added to queue.`).setColor(0x5865F2)
        .addFields(
          { name: 'Base Price',    value: formatAmount(base),  inline: true },
          { name: 'Min Increment', value: formatAmount(diff),  inline: true },
          { name: 'Position',      value: `#${pos}`,           inline: true }
        ).setFooter({ text: `Added by ${message.author.tag}` }).setTimestamp();
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .startqueue / .sq
    if (cmd === 'startqueue' || cmd === 'sq') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      if (gd.auction) { await message.channel.send(`❌ Auction already running! Use \`${aucPfx}sold\` first.`); return; }
      if (!gd.queue || gd.queue.length === 0) { await message.channel.send(`❌ Queue is empty. Add players with \`${aucPfx}aq\` first.`); return; }
      const next = gd.queue.shift();
      gd.auction = { player: next.player, base: next.base, current_bid: next.base, difference: next.difference,
        highest_bidder: null, highest_bidder_id: null, channel_id: String(message.channel.id) };
      scheduleAuctionSave();
      const embed = new EmbedBuilder().setTitle('🏏 AUCTION STARTED!')
        .setDescription(`*From queue — ${gd.queue.length} player(s) remaining.*`).setColor(0xFF0000)
        .addFields(
          { name: 'Player',        value: `**${next.player}**`,   inline: true },
          { name: 'Base Price',    value: formatAmount(next.base), inline: true },
          { name: 'Min Increment', value: formatAmount(next.difference), inline: true },
          { name: 'How to bid',    value: `Use \`${aucPfx}bid <amount>\``, inline: false }
        ).setFooter({ text: `Started by ${message.author.tag}` }).setTimestamp();
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .queue / .q
    if (cmd === 'queue' || cmd === 'q') {
      const embed = new EmbedBuilder().setTitle('📋 Auction Queue').setColor(0x5865F2).setTimestamp();
      if (gd.auction) {
        embed.addFields({ name: '🔴 Currently Auctioning',
          value: `**${gd.auction.player}** — Current Bid: ${formatAmount(gd.auction.current_bid)}`, inline: false });
      }
      if (!gd.queue || gd.queue.length === 0) {
        embed.addFields({ name: 'Queue', value: 'Queue is empty.', inline: false });
      } else {
        const lines = gd.queue.map((item, i) =>
          `\`${i+1}.\` **${item.player}** — Base: ${formatAmount(item.base)}, Inc: ${formatAmount(item.difference)}`
        ).join('\n');
        embed.addFields({ name: `Up Next (${gd.queue.length} player(s))`, value: lines, inline: false });
      }
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .removequeue / .rq
    if (cmd === 'removequeue' || cmd === 'rq') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const idx = parseInt(parts[1]) - 1;
      if (isNaN(idx) || idx < 0 || idx >= (gd.queue || []).length) {
        await message.channel.send(`❌ Invalid index. Queue has ${(gd.queue || []).length} player(s).`); return;
      }
      const removed = gd.queue.splice(idx, 1)[0];
      scheduleAuctionSave();
      await message.channel.send(`🗑️ Removed **${removed.player}** from the queue.`); return;
    }

    // .clearqueue / .cq
    if (cmd === 'clearqueue' || cmd === 'cq') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const count = (gd.queue || []).length;
      gd.queue = []; scheduleAuctionSave();
      await message.channel.send(`🗑️ Cleared **${count}** player(s) from the queue.`); return;
    }

    // .bal / .b / .wallet
    if (cmd === 'bal' || cmd === 'wallet') {
      const target   = message.mentions.members.first() || message.member;
      const amount   = gd.purses[target.id] || 0;
      const embed = new EmbedBuilder().setTitle(`💼 ${target.displayName}'s Wallet`)
        .setDescription(`**Balance:** ${formatAmount(amount)}`).setColor(0xFFD700)
        .setThumbnail(target.user.displayAvatarURL());
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .leaderboard / .lb
    if (cmd === 'leaderboard' || cmd === 'lb') {
      const purses = gd.purses || {};
      const sorted = Object.entries(purses).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]);
      const embed  = new EmbedBuilder().setTitle('🏆 Purse Leaderboard').setColor(0xFFD700).setTimestamp();
      if (sorted.length === 0) {
        embed.setDescription('No purses set yet.');
      } else {
        const medals = ['🥇','🥈','🥉'];
        const lines  = sorted.slice(0, 10).map(([uid, amt], i) => {
          const member = message.guild.members.cache.get(uid);
          const name   = member ? member.displayName : `User ${uid}`;
          const medal  = i < 3 ? medals[i] : `\`${i+1}.\``;
          return `${medal} **${name}** — ${formatAmount(amt)}`;
        });
        embed.setDescription(lines.join('\n'));
      }
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .squad
    if (cmd === 'squad') {
      const target  = message.mentions.members.first() || message.member;
      const players = (gd.squads && gd.squads[target.id]) || [];
      const embed   = new EmbedBuilder().setTitle(`🏏 ${target.displayName}'s Squad`).setColor(0x0099FF)
        .setThumbnail(target.user.displayAvatarURL()).setTimestamp();
      if (players.length === 0) {
        embed.setDescription('No players bought yet.');
      } else {
        embed.setDescription(players.map((p,i) => `\`${i+1}.\` **${p.player}** — ${formatAmount(p.price)}`).join('\n'));
      }
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .delete
    if (cmd === 'delete') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await message.channel.send('❌ Admin only.'); return;
      }
      const target = message.mentions.members.first();
      if (!target) { await message.channel.send(`❌ Usage: \`${aucPfx}delete @user <index|all>\``); return; }
      const indexArg = parts[2];
      if (!indexArg) { await message.channel.send('❌ Provide index or `all`.'); return; }
      if (!gd.squads) gd.squads = {};
      if (['all','everyone','max'].includes(indexArg.toLowerCase())) {
        gd.squads[target.id] = []; scheduleAuctionSave();
        await message.channel.send(`🗑️ Cleared all players from **${target.displayName}**'s squad.`); return;
      }
      const idx = parseInt(indexArg) - 1;
      const squad = gd.squads[target.id] || [];
      if (isNaN(idx) || idx < 0 || idx >= squad.length) {
        await message.channel.send(`❌ Invalid index. Squad has ${squad.length} player(s).`); return;
      }
      const removed = squad.splice(idx, 1)[0];
      gd.squads[target.id] = squad; scheduleAuctionSave();
      await message.channel.send(`🗑️ Removed **${removed.player}** from **${target.displayName}**'s squad.`); return;
    }

    // .setauctioneer / .sa  — grant/revoke Auctioneer role
    if (cmd === 'setauctioneer' || cmd === 'sa') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await message.channel.send('❌ Admin only.'); return;
      }
      const target = message.mentions.members.first();
      if (!target) { await message.channel.send(`❌ Usage: \`${aucPfx}setauctioneer @user\``); return; }

      // Find or create the Auctioneer role
      let role = message.guild.roles.cache.find(r => r.name === 'Auctioneer');
      if (!role) {
        try {
          role = await message.guild.roles.create({
            name: 'Auctioneer',
            color: 0xFF8800,
            reason: 'Created by auction bot'
          });
        } catch (e) {
          await message.channel.send('❌ Failed to create Auctioneer role. Make sure the bot has **Manage Roles** permission.');
          return;
        }
      }

      // Toggle — if they already have it, remove it
      if (target.roles.cache.has(role.id)) {
        await target.roles.remove(role);
        const embed = new EmbedBuilder()
          .setTitle('🔨 Auctioneer Removed')
          .setDescription(`${target} no longer has the **Auctioneer** role.`)
          .setColor(0xFF4444)
          .setFooter({ text: `Done by ${message.author.tag}` })
          .setTimestamp();
        await message.channel.send({ embeds: [embed] });
      } else {
        await target.roles.add(role);
        const embed = new EmbedBuilder()
          .setTitle('✅ Auctioneer Granted')
          .setDescription(`${target} has been given the **Auctioneer** role and can now run auction commands.`)
          .setColor(0xFF8800)
          .setFooter({ text: `Done by ${message.author.tag}` })
          .setTimestamp();
        await message.channel.send({ embeds: [embed] });
      }
      return;
    }

    // .approveauction / .approvecg / .unapproveauction / .unapprovecg — OWNER only
    if (cmd === 'approveauction' || cmd === 'approvecg' || cmd === 'unapproveauction' || cmd === 'unapprovecg') {
      if (userId !== OWNER_ID) { await message.channel.send('❌ Only the bot owner can use this command.'); return; }
      const gid     = String(guildId);
      const approve = cmd.startsWith('approve');
      const feature = (cmd === 'approveauction' || cmd === 'unapproveauction') ? 'auction' : 'cgdrop';

      if (feature === 'auction') {
        auctionData.approvedGuilds = auctionData.approvedGuilds || {};
        if (approve) auctionData.approvedGuilds[gid] = true;
        else delete auctionData.approvedGuilds[gid];
        scheduleAuctionSave();
      } else {
        cgData.approvedGuilds = cgData.approvedGuilds || {};
        if (approve) cgData.approvedGuilds[gid] = true;
        else delete cgData.approvedGuilds[gid];
        scheduleCgSave();
      }

      const emoji = approve ? '✅' : '🚫';
      await message.channel.send(`${emoji} **${message.guild.name}** has been ${approve ? 'approved' : 'unapproved'} for **${feature}** commands.`);
      return;
    }

    // .listapprovals — OWNER only, shows all approved servers
    if (cmd === 'listapprovals') {
      if (userId !== OWNER_ID) { await message.channel.send('❌ Only the bot owner can use this command.'); return; }
      const aucGuilds = Object.keys(auctionData.approvedGuilds || {});
      const cgGuilds  = Object.keys(cgData.approvedGuilds || {});
      const aucNames  = aucGuilds.map(id => { const g = client.guilds.cache.get(id); return g ? g.name : id; });
      const cgNames   = cgGuilds.map(id =>  { const g = client.guilds.cache.get(id); return g ? g.name : id; });
      const embed = new EmbedBuilder()
        .setTitle('🔐 Approved Servers')
        .setColor(0x5865F2)
        .addFields(
          { name: `🏏 Auction (${aucGuilds.length})`, value: aucNames.length ? aucNames.join('\n') : 'None', inline: true },
          { name: `🎮 CGDrop (${cgGuilds.length})`,   value: cgNames.length  ? cgNames.join('\n')  : 'None', inline: true }
        ).setTimestamp();
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .sync — manual force-push to JSONBin (Admin only)
    if (cmd === 'sync') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await message.channel.send('❌ Admin only.'); return;
      }
      await message.channel.send('🔄 Syncing data to JSONBin...');
      cgDirty = true;
      auctionDirty = true;
      await flushCg();
      await flushAuction();
      await message.channel.send('✅ All data synced to JSONBin!'); return;
    }

    // .addsquad / .as
    if (cmd === 'addsquad' || cmd === 'as') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const target = message.mentions.members.first();
      const afterMention = aucRaw.replace(/^(addsquad|as)\s+/, '').replace(/<@!?\d+>\s*/, '').trim();
      const words = afterMention.split(/\s+/).filter(Boolean);
      if (!target || words.length === 0) {
        await message.channel.send(`❌ Usage: \`${aucPfx}addsquad @user <player> [price]\``); return;
      }
      const lastWord = words[words.length - 1];
      const priceRaw = parseAmount(lastWord);
      let playerName, price;
      if (priceRaw && words.length > 1) {
        playerName = words.slice(0, -1).join(' ');
        price = priceRaw;
      } else {
        playerName = words.join(' ');
        price = 0;
      }
      if (!gd.squads) gd.squads = {};
      if (!gd.squads[target.id]) gd.squads[target.id] = [];
      gd.squads[target.id].push({ player: playerName, price });
      scheduleAuctionSave();
      const embed = new EmbedBuilder()
        .setTitle('✅ Player Added to Squad')
        .setColor(0x57F287)
        .addFields(
          { name: 'Player', value: `**${playerName}**`,              inline: true },
          { name: 'Price',  value: price ? formatAmount(price) : 'N/A', inline: true },
          { name: 'Owner',  value: `${target}`,                      inline: true }
        )
        .setFooter({ text: `Added by ${message.author.tag}` })
        .setTimestamp();
      await message.channel.send({ embeds: [embed] }); return;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CGDROP DETECTION  (no prefix needed)
  // ════════════════════════════════════════════════════════════════════════
  if (!lower.startsWith('cgdrop') && !lower.startsWith('cg drop')) return;
  if (!isCgApproved(guildId)) return; // silently ignore unapproved servers
  if (processedMsgIds.has(message.id)) return;
  processedMsgIds.add(message.id);
  setTimeout(() => processedMsgIds.delete(message.id), 10 * 60 * 1000);

  const channel = message.channel;
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

    const isCooldown = /claim your next/i.test(allText) || /cooldown/i.test(allText);
    if (isCooldown) {
      const tsMatch = rawText.match(/<t:(\d+):/);
      let minsLeft  = 'some';
      if (tsMatch) {
        const diff = Math.ceil((parseInt(tsMatch[1]) - Math.floor(Date.now()/1000)) / 60);
        minsLeft = diff > 0 ? String(diff) : 'a few';
      }
      await message.react('⏳').catch(() => {});
      return;
    }

    const cardMatch = rawText.match(/card value\s*`?([\d,]+)`?/i);
    const saleMatch = rawText.match(/sale value\s*`?([\d,]+)`?/i);

    if (cardMatch) {
      const cardValue = parseInt(cardMatch[1].replace(/,/g, ''));
      const ovr = getOVR(cardValue);
      cgData.stats.total += 1;
      if (ovr) {
        cgData.stats.ovr[ovr] = (cgData.stats.ovr[ovr] || 0) + 1;
      } else {
        cgData.stats.unknown = cgData.stats.unknown || [];
        cgData.stats.unknown.push({ value: cardValue, user: message.author.tag, time: new Date().toLocaleString() });
        await channel.send(`⚠️ <@${userId}> Unknown card value **${cardValue}** — use \`!unknown\` to review.`);
      }
      const recordingOn = cgData.recordingEnabled !== false;
      if (recordingOn || userId === OWNER_ID) {
        cgData.userStats = cgData.userStats || {};
        cgData.userStats[userId] = cgData.userStats[userId] || { total: 0, ovr: {}, unknown: [] };
        const us = cgData.userStats[userId];
        us.total += 1;
        if (ovr) { us.ovr[ovr] = (us.ovr[ovr] || 0) + 1; }
        else { us.unknown = us.unknown || []; us.unknown.push({ value: cardValue, time: new Date().toLocaleString() }); }
      }
    }

    if (saleMatch && (userId === OWNER_ID || isWhitelisted(userId))) {
      const saleValue = parseInt(saleMatch[1].replace(/,/g, ''));
      const today = getISTDate();
      if (userId === OWNER_ID) {
        cgData.owner = cgData.owner || { totalSale: 0, totalDrops: 0, days: {} };
        cgData.owner.totalSale  = (cgData.owner.totalSale  || 0) + saleValue;
        cgData.owner.totalDrops = (cgData.owner.totalDrops || 0) + 1;
        cgData.owner.days[today] = cgData.owner.days[today] || { totalSale: 0, drops: 0, vote: 0, match: 0, misc: 0 };
        cgData.owner.days[today].totalSale += saleValue;
        cgData.owner.days[today].drops     += 1;
      } else {
        cgData.userEarnings = cgData.userEarnings || {};
        cgData.userEarnings[userId] = cgData.userEarnings[userId] || { totalSale: 0, totalDrops: 0, days: {} };
        const ue = cgData.userEarnings[userId];
        ue.totalSale  = (ue.totalSale  || 0) + saleValue;
        ue.totalDrops = (ue.totalDrops || 0) + 1;
        ue.days[today] = ue.days[today] || { totalSale: 0, drops: 0, vote: 0, match: 0, misc: 0 };
        ue.days[today].totalSale += saleValue;
        ue.days[today].drops     += 1;
      }
    }

    if (cardMatch || saleMatch) scheduleCgSave();
    console.log(`✅ Claim processed for ${message.author.tag}`);
  } else {
    console.log(`⚠️ No game bot response for ${message.author.tag}. Assuming claimed.`);
  }

  // Reminder
  const isDisabled = cgData.reminderDisabled && cgData.reminderDisabled[userId];
  if (isDisabled) return;
  if (activeReminders.has(userId)) clearTimeout(activeReminders.get(userId));
  await message.react('⏰').catch(() => {});
  const userMins = (cgData.reminderTime && cgData.reminderTime[userId]) || 60;
  const remindMs = userMins * 60 * 1000;
  const remindAt = Date.now() + remindMs;
  cgData.reminders[userId] = { remindAt, channelId: message.channel.id };
  scheduleCgSave();
  const timeout = setTimeout(async () => {
    sendReminder(userId, message.channel.id);
    delete cgData.reminders[userId];
    scheduleCgSave();
    activeReminders.delete(userId);
  }, remindMs);
  activeReminders.set(userId, timeout);
  console.log(`✅ Reminder set for ${message.author.tag} — ${userMins} min.`);
});

process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); });

// ── Graceful shutdown — flush everything before going offline ──────────────
async function shutdownFlush() {
  console.log('⚠️  Shutdown detected — flushing data to JSONBin...');
  await flushCg();
  await flushAuction();
  console.log('✅ Flush complete. Exiting.');
  process.exit(0);
}
process.on('SIGTERM', shutdownFlush);
process.on('SIGINT',  shutdownFlush);

// ══════════════════════════════════════════════════════════════════════════════
//  HTTP KEEPALIVE  (for Render / Railway / UptimeRobot)
// ══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot is running!')).listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

client.login(DISCORD_TOKEN);

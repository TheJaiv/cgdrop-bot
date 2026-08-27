const fs   = require('fs');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const http = require('http');

// ══════════════════════════════════════════════════════════════════════════════
//  CONFIG  (all secrets via environment variables)ds
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
// Open auction (the days-long, everyone-bids-at-once mode) has its own prefix so
// it can never clash with the live auction. Change it here, or per server with
// `$setopenprefix` / the /setopenprefix slash command.
const DEFAULT_OPEN_PREFIX    = '$';

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

async function saveBin(data, binIdRef, setFn, label, binName, envVarName) {
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
      console.log(`⚠️  ADD TO ENV (Render):  ${envVarName}=${json.metadata.id}`);
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
    auctionData._savedAt = Date.now(); // version stamp — used to pick the freshest copy on boot
    fs.writeFileSync(AUCTION_LOCAL_FILE, JSON.stringify(auctionData), 'utf8');
  } catch (e) { console.error('Error writing local auction file:', e.message); }
}

// ── Saving (JSONBin quota-friendly) ──────────────────────────────────────────
// Changes are written to the LOCAL file instantly and just flagged dirty in
// memory. JSONBin uploads (which cost quota) only happen:
//   • hourly (everything: auction + cgdrop)
//   • after every sold/unsold (auction)
//   • on shutdown, and on manual `.sync`
// This keeps JSONBin requests to roughly a handful per hour instead of per change.
let cgDirty = false, auctionDirty = false;
let auctionSavingPromise = null;

function scheduleCgSave() { cgDirty = true; }    // uploaded on the next hourly flush / shutdown / .sync
function scheduleAuctionSave() {
  saveLocalAuction();   // instant local write (no JSONBin request)
  auctionDirty = true;  // uploaded after a sale / hourly / shutdown / .sync
}

async function flushCg() {
  if (!cgDirty) return;
  cgDirty = false;
  await saveBin(cgData, cgdropBinId, id => { cgdropBinId = id; }, 'cgdrop', 'cgdrop-bot-data', 'CGDROP_BIN_ID');
}

// Coalesces concurrent calls and always writes the latest state.
async function flushAuction() {
  if (auctionSavingPromise) return auctionSavingPromise; // a write is already running; it'll see the dirty flag
  if (!auctionDirty) return;
  auctionSavingPromise = (async () => {
    try {
      while (auctionDirty) {
        auctionDirty = false;
        saveLocalAuction();
        await saveBin(auctionData, auctionBinId, id => { auctionBinId = id; }, 'auction', 'auction-bot-data', 'AUCTION_BIN_ID');
        // Persist the auction bin id into the cg bin RIGHT NOW (not just flagged),
        // so a restart can recover it regardless of flush ordering.
        if (auctionBinId && cgData.auctionBinId !== auctionBinId) {
          cgData.auctionBinId = auctionBinId;
          cgDirty = true;
          await flushCg();
          console.log(`🔗 Stored auction bin id in cg bin: ${auctionBinId}`);
          console.log(`👉 To make this permanent, set env:  AUCTION_BIN_ID=${auctionBinId}`);
        }
      }
    } finally {
      auctionSavingPromise = null;
    }
  })();
  return auctionSavingPromise;
}

// ── Periodic upload every hour — pushes everything (auction + cgdrop) ─────────
const FLUSH_INTERVAL_MS = 60 * 60 * 1000;
function startFlushInterval() {
  setInterval(async () => {
    await flushAuction(); // auction first so the bin-id pointer is captured before cg saves
    await flushCg();
  }, FLUSH_INTERVAL_MS);
  console.log('⏱️  Hourly JSONBin push started');
}

// ══════════════════════════════════════════════════════════════════════════════
//  PREFIX HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function getCgPrefix(guildId)      { return (cgData.guildPrefixes     && cgData.guildPrefixes[guildId])      || DEFAULT_CGDROP_PREFIX; }
function getAuctionPrefix(guildId) { return (auctionData.guildPrefixes && auctionData.guildPrefixes[guildId]) || DEFAULT_AUCTION_PREFIX; }
function getOpenPrefix(guildId)    { return (auctionData.openPrefixes  && auctionData.openPrefixes[guildId])  || DEFAULT_OPEN_PREFIX; }

// ══════════════════════════════════════════════════════════════════════════════
//  AUCTION DATA HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function getGuildData(guildId) {
  const gid = String(guildId);
  if (!auctionData.guilds[gid]) {
    auctionData.guilds[gid] = {
      logChannel: null,    // general/default log channel (fallback for all types)
      soldChannel: null,   // optional override for SOLD logs
      unsoldChannel: null, // optional override for UNSOLD logs
      tradeChannel: null,  // optional override for trade logs
      purses: {},
      squads: {},
      teams: {},           // userId -> team name
      auction: null,
      queue: [],
      difference: 500000,
      minSquad: 0,       // 0 = no minimum
      maxSquad: 0,       // 0 = no maximum
      auctionTimer: 0,   // 0 = no countdown; seconds after each bid
      queuePaused: false,// when true, queue won't auto-advance after a sale
      nextDelay: 0,      // 0 = immediate; seconds of countdown before each auto-advanced player
      trade: null,       // active trade between two members, if any
      draftChannel: null,// optional override for draft pick logs
      skipChannel: null, // optional override for draft skip logs
      draft: null,       // draft state — kept after it ends so `.taken` can still answer
      draftTeams: [],    // roster for the next draft (empty = everyone with a team name)
      draftPool: [],     // allowed player names (empty = any name; host-only visibility)
      draftAuto: false,  // false = pause after each round until the host runs nextround
      draftPrefs: {},    // userId -> preferred player order, auto-drafted on timeout
      setorderEnabled: false, // preset orders are off until a manager runs autodraft on
      payChannel: null,  // optional override for staff payment logs
      payAdmins: {},     // userId -> tag — may add/remove dues and settle claims
      payDefaultAdmin: null, // fallback payer when a staff member has none set
      staffPay: {},      // userId -> { due, payer, history, claim } — staff payment ledger
      payTicket: null,   // custom "how to open a ticket" line shown on a claim
      payShares: {},     // userId -> % cut of every recorded purchase
      payPurchases: [],  // recent purchases and how they were split
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

// Money in the units people actually speak: 10cr, 1.5cr, 40L. Below a lakh a
// plain grouped number is clearer than "0.02L", so small change stays literal.
function formatAmount(amount) {
  if (amount === null || amount === undefined) return '0';
  const n = Number(amount);
  if (!isFinite(n)) return '0';
  const trim = (v) => parseFloat(v.toFixed(2)).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${trim(n / 1e7)}cr`;
  if (abs >= 1e5) return `${trim(n / 1e5)}L`;
  return trim(n);
}

function fmt(n) { return Number(n || 0).toLocaleString(); }

// ── Team-name helpers ───────────────────────────────────────────────────────
function displayNameOf(guild, uid) {
  const m = guild.members.cache.get(uid);
  return m ? m.displayName : `User ${uid}`;
}
function teamNameOf(gd, uid) { return (gd.teams && gd.teams[uid]) || null; }
// Team name only (no personal name) — for SOLD logs & bids.
function teamOnly(gd, guild, uid) { return teamNameOf(gd, uid) || displayNameOf(guild, uid); }
// Team name with the person's name visible too — for squads, balances, leaderboard, etc.
function teamLabel(gd, guild, uid) {
  const t = teamNameOf(gd, uid), n = displayNameOf(guild, uid);
  return t ? `${t} (${n})` : n;
}
// Resolve a target from a mention, a team name, or a raw id; defaults to self.
// Returns { id, member|null } or null if a name/id was given but not found.
function resolveMemberTarget(gd, message, argText) {
  const mention = message.mentions.members.first();
  if (mention) return { id: mention.id, member: mention };
  const q = (argText || '').replace(/<@!?\d+>/g, '').trim();
  if (!q) return { id: message.member.id, member: message.member };
  if (gd.teams) {
    const found = Object.entries(gd.teams).find(([, name]) => name.toLowerCase() === q.toLowerCase());
    if (found) return { id: found[0], member: message.guild.members.cache.get(found[0]) || null };
  }
  if (/^\d{5,}$/.test(q)) return { id: q, member: message.guild.members.cache.get(q) || null };
  return null;
}

// Parse multi-entry queue text (one per line or comma-separated).
// Each entry: "<player...> <base> [increment]". Returns parsed items + unparsable lines.
function parseQueueEntries(text, defaultDiff) {
  const entries = text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  const items = [], failed = [];
  for (const entry of entries) {
    const words         = entry.split(/\s+/).filter(Boolean);
    const lastAmt       = words.length ? parseAmount(words[words.length - 1]) : null;
    const secondLastAmt = words.length >= 3 ? parseAmount(words[words.length - 2]) : null;
    let player = null, base = null, diff = defaultDiff;
    if (lastAmt !== null && secondLastAmt !== null) {
      player = words.slice(0, -2).join(' '); base = secondLastAmt; diff = lastAmt;
    } else if (lastAmt !== null) {
      player = words.slice(0, -1).join(' '); base = lastAmt;
    }
    if (!player || base === null || base <= 0) { failed.push(entry); continue; }
    items.push({ player, base, diff });
  }
  return { items, failed };
}

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
// type: 'sold' | 'unsold' | 'trade' | 'pay' | undefined — routes to the
// type-specific channel if set, otherwise falls back to the general log channel.
async function sendLog(guild, embed, type) {
  const gd = getGuildData(guild.id);
  const byType = { sold: gd.soldChannel, unsold: gd.unsoldChannel, trade: gd.tradeChannel, pay: gd.payChannel };
  const chId = (type && byType[type]) || gd.logChannel;
  if (!chId) return;
  const ch = guild.channels.cache.get(chId);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════════════
//  DRAFT HELPERS
// ══════════════════════════════════════════════════════════════════════════════
const draftTimers = new Map();   // guildId -> pick-window timeout
const draftLocks  = new Map();   // guildId -> promise chain serialising picks vs timeouts
const pendingSetorders = new Map(); // userId -> { guildId, expiresAt } — waiting for a DM reply
// Max bids are asked for in DMs so a ceiling is never visible in the channel.
const pendingOpenMax   = new Map(); // userId -> { guildId, key, name, expiresAt }
const OPEN_MAX_DM_MS   = 10 * 60000;
const SETORDER_DM_MS = 10 * 60 * 1000;

// A pick landing while the skip-timeout is mid-await (or vice versa) must not
// both advance the draft — run every state transition one at a time per guild.
function withDraftLock(guildId, fn) {
  const prev = draftLocks.get(guildId) || Promise.resolve();
  const next = prev.then(fn, fn);
  draftLocks.set(guildId, next.catch(() => {}));
  return next;
}

function clearDraftTimer(guildId) {
  if (draftTimers.has(guildId)) { clearTimeout(draftTimers.get(guildId)); draftTimers.delete(guildId); }
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normPlayer(name) { return name.toLowerCase().replace(/\s+/g, ' ').trim(); }

// Parse a pasted/attached player list into names. Understands the CricVerse
// `cv pl` .txt (and compact `cv pla`) format: skips ═/─ decoration rows, tier
// headers and the Generated footer; names are one per line or comma-separated.
function parsePlayerList(text) {
  const names = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (/^[═─=—_*#-]{3,}/.test(line)) continue;          // decoration rows
    if (/^──/.test(line)) continue;                       // tier header rows
    if (/player database|generated:/i.test(line)) continue;
    for (const part of line.split(',')) {
      const name = part.replace(/\s+/g, ' ').trim();
      if (name && name.length <= 80) names.push(name);
    }
  }
  return names;
}

// Look up a player across every squad — covers retained, auction-bought AND
// drafted players in one check. Returns { userId, entry, pickInfo|null } or null.
function findTakenPlayer(gd, name) {
  const q = normPlayer(name);
  if (!q) return null;
  for (const [uid, squad] of Object.entries(gd.squads || {})) {
    const entry = (squad || []).find(p => normPlayer(p.player) === q);
    if (entry) {
      const pickInfo = ((gd.draft && gd.draft.picks) || []).find(p => normPlayer(p.player) === q) || null;
      return { userId: uid, entry, pickInfo };
    }
  }
  return null;
}

function pickOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Draft/skip/pay-channel log, falling back to general. Accepts a plain string or
// a full payload — pings must go in `content` (embeds never ping), the pretty
// part in the embed.
async function sendLogText(guild, payload, type) {
  const gd = getGuildData(guild.id);
  const byType = { draft: gd.draftChannel, skip: gd.skipChannel, pay: gd.payChannel };
  const chId = (type && byType[type]) || gd.logChannel;
  if (!chId) return;
  const ch = guild.channels.cache.get(chId);
  if (ch) await ch.send(typeof payload === 'string' ? { content: payload } : payload).catch(() => {});
}

// Whose turn is it — { userId, round, pick, makeup } or null when nothing pending.
function draftSlot(gd) {
  const d = gd.draft;
  if (!d || !d.active || d.waiting) return null;   // waiting = paused between rounds
  if (d.phase === 'rounds' && d.idx < d.order.length) {
    return { userId: d.order[d.idx], round: d.round, pick: d.idx + 1, makeup: false };
  }
  if (d.phase === 'makeup' && d.makeupIdx < d.skips.length) {
    const s = d.skips[d.makeupIdx];
    return { userId: s.userId, round: s.round, pick: s.pick, makeup: true };
  }
  return null;
}

// Announce the current pick in the draft channel and arm the timeout.
async function announceDraftTurn(guild, gd) {
  const d = gd.draft;
  if (d.waiting) return;   // paused between rounds — nextround un-pauses
  const slot = draftSlot(gd);
  if (!slot) return finishDraft(guild, gd);
  d.turnToken = (d.turnToken || 0) + 1;   // invalidates any older timer
  const token = d.turnToken;
  const ch = guild.channels.cache.get(d.channelId);
  const header = slot.makeup
    ? `♻️ **Makeup pick** — Round ${slot.round}, ${pickOrdinal(slot.pick)} pick`
    : `🎯 **Round ${slot.round}** — ${pickOrdinal(slot.pick)} pick`;
  if (ch) await ch.send(`${header}\n<@${slot.userId}> (**${teamOnly(gd, guild, slot.userId)}**) — type any player's name within **${d.pickSeconds}s**. Taken names don't count and the timer keeps running.`).catch(() => {});
  clearDraftTimer(guild.id);
  draftTimers.set(guild.id, setTimeout(() => {
    draftTimers.delete(guild.id);
    withDraftLock(guild.id, async () => {
      const cur = gd.draft;
      if (!cur || !cur.active || cur.turnToken !== token) return; // pick landed / draft stopped
      await draftTimeoutSkip(guild, gd);
    }).catch(e => console.error('Draft skip error:', e));
  }, d.pickSeconds * 1000));
}

// Resolve a typed name against the pool: exact match first, else a unique
// substring match ("kohli" -> "Virat Kohli"). Returns:
//   { name }                — resolved (raw name passthrough when no pool)
//   { ambiguous: [names] }  — several pool players match
//   null                    — nothing in the pool matches
function poolResolve(gd, raw) {
  const clean = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const pool = gd.draftPool || [];
  if (!pool.length) return { name: clean };
  const q = normPlayer(clean);
  const exact = pool.find(n => normPlayer(n) === q);
  if (exact) return { name: exact };
  const subs = pool.filter(n => normPlayer(n).includes(q));
  if (subs.length === 1) return { name: subs[0] };
  if (subs.length > 1) return { ambiguous: subs.slice(0, 5) };
  return null;
}

// Parse + resolve a pasted order and store it. Shared by the DM flow and the
// inline `.setorder <list>` form. Returns { cleaned, dropped } (dropped =
// unknown or ambiguous names, in the user's own spelling).
function saveDraftOrder(gd, userId, text) {
  const names = parsePlayerList(text).slice(0, 200);
  const cleaned = [], dropped = [];
  for (const n of names) {
    const r = poolResolve(gd, n);
    if (!r || r.ambiguous) { dropped.push(n); continue; }
    if (!cleaned.some(c => normPlayer(c) === normPlayer(r.name))) cleaned.push(r.name);
  }
  if (cleaned.length) {
    gd.draftPrefs = gd.draftPrefs || {};
    gd.draftPrefs[userId] = cleaned;
    scheduleAuctionSave();
  }
  return { cleaned, dropped };
}

function draftOrderReply(cleaned, dropped) {
  if (!cleaned.length) {
    return `❌ None of those matched the player list — nothing saved.${dropped.length ? `\nNot found/ambiguous: ${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? ', …' : ''}` : ''}`;
  }
  return `✅ Draft order saved — **${cleaned.length}** player(s). If your timer runs out, the top one still available is auto-drafted.`
    + (dropped.length ? `\n⚠️ Dropped (not found/ambiguous): ${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? ', …' : ''}` : '');
}

// First player in this owner's preset order who is a real (pool) player and
// not in any squad yet — null when there's nothing usable.
function firstAvailableFromPrefs(gd, userId) {
  if (!gd.setorderEnabled) return null;   // feature is manager-gated, off by default
  const prefs = (gd.draftPrefs && gd.draftPrefs[userId]) || [];
  const pool = gd.draftPool || [];
  for (const name of prefs) {
    let canon = name;
    if (pool.length) {
      canon = pool.find(n => normPlayer(n) === normPlayer(name));
      if (!canon) continue;   // not a real player
    }
    if (!findTakenPlayer(gd, canon)) return canon;
  }
  return null;
}

// Record a pick (typed or auto) — squad, log line, announcements, then advance.
async function commitDraftPick(guild, gd, slot, player, auto) {
  const d = gd.draft;
  clearDraftTimer(guild.id);
  d.turnToken = (d.turnToken || 0) + 1;   // kill the running window
  if (!gd.squads) gd.squads = {};
  if (!gd.squads[slot.userId]) gd.squads[slot.userId] = [];
  gd.squads[slot.userId].push({ player, price: 0, round: slot.round }); // round shown in .squad instead of a price
  d.picks.push({ player, userId: slot.userId, round: slot.round, pick: slot.pick, makeup: slot.makeup, auto: !!auto });
  if (slot.makeup) { d.skips[d.makeupIdx].filled = true; d.makeupIdx++; }
  else d.idx++;
  scheduleAuctionSave();
  const ch = guild.channels.cache.get(d.channelId);
  const autoNote = auto ? ' *(auto-drafted from their preset order)*' : '';
  if (ch) await ch.send(`✅ **${teamOnly(gd, guild, slot.userId)}** takes **${player}** — Round ${slot.round}, ${pickOrdinal(slot.pick)} pick.${autoNote}`).catch(() => {});
  const tname = teamOnly(gd, guild, slot.userId);
  const logEmbed = new EmbedBuilder()
    .setTitle(`🏏 ${tname} Takes ${player}`)
    .setDescription((slot.makeup
      ? `Makeup pick — Round ${slot.round}, ${pickOrdinal(slot.pick)} pick`
      : `In Round ${slot.round}, ${pickOrdinal(slot.pick)} pick`) + (auto ? ' · auto-drafted from preset order' : ''))
    .setColor(0x57F287).setTimestamp();
  await sendLogText(guild, { embeds: [logEmbed] }, 'draft');
  await advanceDraft(guild, gd);
}

// 30s window expired — auto-draft from the owner's preset order if they have
// a usable one, otherwise log the skip and move on.
async function draftTimeoutSkip(guild, gd) {
  const d = gd.draft;
  const slot = draftSlot(gd);
  if (!slot) return;
  const autoPick = firstAvailableFromPrefs(gd, slot.userId);
  if (autoPick) return commitDraftPick(guild, gd, slot, autoPick, true);
  const ch = guild.channels.cache.get(d.channelId);
  const tname = teamOnly(gd, guild, slot.userId);
  if (slot.makeup) {
    d.skips[d.makeupIdx].finalSkipped = true;
    d.makeupIdx++;
    if (ch) await ch.send(`⏭️ Skipped again — Round ${slot.round}, ${pickOrdinal(slot.pick)} pick is left for the host/managers to fill.`).catch(() => {});
    const e = new EmbedBuilder().setTitle(`⏭️ ${tname} Skipped Again`)
      .setDescription(`Could not decide their makeup pick within ${d.pickSeconds} seconds — Round ${slot.round}, ${pickOrdinal(slot.pick)} pick is left for the host/managers.`)
      .setColor(0xED4245).setTimestamp();
    await sendLogText(guild, { embeds: [e] }, 'skip');
  } else {
    d.skips.push({ userId: slot.userId, round: slot.round, pick: slot.pick });
    d.idx++;
    if (ch) await ch.send(`⏭️ Time's up — skipped for later (retried after all rounds).`).catch(() => {});
    const e = new EmbedBuilder().setTitle(`⏭️ ${tname} Skipped`)
      .setDescription(`Could not decide their pick within ${d.pickSeconds} seconds and is skipped for later — Round ${slot.round}, ${pickOrdinal(slot.pick)} pick.`)
      .setColor(0xED4245).setTimestamp();
    await sendLogText(guild, { embeds: [e] }, 'skip');
  }
  scheduleAuctionSave();
  await advanceDraft(guild, gd);
}

// Step to the next pick — handles round rollover (fresh random order each round),
// the switch into the makeup phase, and finishing.
async function advanceDraft(guild, gd) {
  const d = gd.draft;
  const ch = guild.channels.cache.get(d.channelId);
  if (d.phase === 'rounds' && d.idx >= d.order.length) {
    const aucPfx = getAuctionPrefix(guild.id);
    if (d.round >= d.totalRounds) {
      const pending = d.skips.filter(s => !s.filled && !s.finalSkipped);
      if (!pending.length) return finishDraft(guild, gd);
      d.phase = 'makeup'; d.makeupIdx = 0;
      if (ch) await ch.send(`♻️ **All ${d.totalRounds} round(s) done!** ${pending.length} skipped pick(s) get a second chance, in order.`).catch(() => {});
      if (!gd.draftAuto) {
        d.waiting = true; scheduleAuctionSave();
        if (ch) await ch.send(`⏸️ Paused — start the makeup picks with \`${aucPfx}nextround\`.`).catch(() => {});
        return;
      }
    } else {
      d.round++; d.idx = 0; d.order = shuffled(d.participants);
      if (ch) {
        const lines = d.order.map((uid, i) => `**${i + 1}.** ${teamOnly(gd, guild, uid)}`).join('\n');
        await ch.send({ embeds: [new EmbedBuilder().setTitle(`🔀 Round ${d.round} — new random order`).setColor(0x00B2FF).setDescription(lines)] }).catch(() => {});
      }
      if (!gd.draftAuto) {
        d.waiting = true; scheduleAuctionSave();
        if (ch) await ch.send(`⏸️ Paused — start Round ${d.round} with \`${aucPfx}nextround\` (or turn pauses off with \`${aucPfx}draftauto on\`).`).catch(() => {});
        return;
      }
    }
  }
  if (d.phase === 'makeup' && d.makeupIdx >= d.skips.length) return finishDraft(guild, gd);
  scheduleAuctionSave();
  await announceDraftTurn(guild, gd);
}

async function finishDraft(guild, gd) {
  const d = gd.draft;
  clearDraftTimer(guild.id);
  d.active = false;
  const unfilled = d.skips.filter(s => !s.filled);
  const counts = {};
  for (const p of d.picks) counts[p.userId] = (counts[p.userId] || 0) + 1;
  const teamLines = d.participants.map(uid => `• **${teamOnly(gd, guild, uid)}** — ${counts[uid] || 0} pick(s)`).join('\n') || '*none*';
  const embed = new EmbedBuilder().setTitle('🏁 Draft Complete').setColor(0xFFD700)
    .addFields(
      { name: 'Rounds', value: String(d.totalRounds), inline: true },
      { name: 'Total picks', value: String(d.picks.length), inline: true },
      { name: 'Unfilled skips', value: String(unfilled.length), inline: true },
      { name: 'Picks per team', value: teamLines.slice(0, 1024), inline: false }
    ).setTimestamp();
  if (unfilled.length) {
    embed.addFields({ name: '⚠️ For the host to fill (addsquad)', value: unfilled.map(s => `• ${teamOnly(gd, guild, s.userId)} — Round ${s.round}, ${pickOrdinal(s.pick)} pick`).join('\n').slice(0, 1024), inline: false });
  }
  const ch = guild.channels.cache.get(d.channelId);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  await sendLogText(guild, { embeds: [new EmbedBuilder().setTitle('🏁 Draft Complete')
    .setDescription(`**${d.picks.length}** player(s) drafted${unfilled.length ? ` · **${unfilled.length}** slot(s) left for the host/managers` : ''}.`)
    .setColor(0xFFD700).setTimestamp()] }, 'draft');
  scheduleAuctionSave();
  await flushAuction(); // durability point — all drafted players are in squads now
}

// The team on the clock typed something — treat it as a pick attempt.
async function handleDraftPickAttempt(message, gd) {
  const d = gd.draft;
  // Re-validate under the lock — the turn may have moved on while this message waited
  const slot = draftSlot(gd);
  if (!slot || slot.userId !== message.author.id || d.channelId !== message.channel.id) return;
  let player = message.content.replace(/\s+/g, ' ').trim();
  if (!player) return;
  if (player.length > 80) {
    await message.channel.send(`❌ That doesn't look like a player name (too long) — timer's still running!`).catch(() => {});
    return;
  }
  // Player pool loaded → the name must exist in it ("kohli" resolves to Virat Kohli)
  const resolved = poolResolve(gd, player);
  if (!resolved) {
    await message.channel.send(`❌ **${player}** doesn't exist in the player list — check the spelling, timer's still running!`).catch(() => {});
    return;
  }
  if (resolved.ambiguous) {
    await message.channel.send(`❌ **${player}** matches several players: ${resolved.ambiguous.map(n => `**${n}**`).join(', ')} — be more specific, timer's still running!`).catch(() => {});
    return;
  }
  player = resolved.name;
  const taken = findTakenPlayer(gd, player);
  if (taken) {
    const by = teamOnly(gd, message.guild, taken.userId);
    const when = taken.pickInfo ? ` in Round ${taken.pickInfo.round} (${pickOrdinal(taken.pickInfo.pick)} pick)` : ' (retained/bought)';
    await message.channel.send(`❌ **${taken.entry.player}** is already with **${by}**${when} — timer's still running, name someone else!`).catch(() => {});
    return;
  }
  await message.react('✅').catch(() => {});
  await commitDraftPick(message.guild, gd, slot, player, false);
}

// ══════════════════════════════════════════════════════════════════════════════
//  STAFF PAYMENT HELPERS
// ══════════════════════════════════════════════════════════════════════════════
// A per-server ledger of what each staff member is still owed, who they collect
// it from, and every add/remove/claim in between. This bot only keeps the
// record — the currency itself is transferred with another bot. Claiming takes
// the amount straight off the balance and leaves a claim awaiting transfer.
const PAY_HISTORY_MAX = 40;   // keep the log short enough to fit in one embed

function payEntry(gd, uid) {
  if (!gd.staffPay) gd.staffPay = {};
  if (!gd.staffPay[uid]) gd.staffPay[uid] = { due: 0, payer: null, history: [], claims: [] };
  const e = gd.staffPay[uid];
  if (!Array.isArray(e.history)) e.history = [];
  if (!Array.isArray(e.claims)) e.claims = e.claim ? [e.claim] : [];   // older single-claim shape
  delete e.claim;
  if (typeof e.due !== 'number') e.due = 0;
  return e;
}

// Claimed but not yet handed over in the other bot.
function payPending(e) {
  return ((e && e.claims) || []).reduce((s, c) => s + (c.amount || 0), 0);
}

// Pay admins add/remove dues and settle claims. Admins/Auctioneers always
// qualify, otherwise a fresh server would have nobody able to appoint the first
// pay admin.
function isPayAdmin(gd, member) {
  if (!member) return false;
  if (gd.payAdmins && gd.payAdmins[member.id]) return true;
  return hasAuctionPermission(member);
}

// Who this staff member collects from: their own payer, else the server
// default, else the single pay admin if there's exactly one.
function payerFor(gd, uid) {
  const e = gd.staffPay && gd.staffPay[uid];
  if (e && e.payer) return e.payer;
  if (gd.payDefaultAdmin) return gd.payDefaultAdmin;
  const ids = Object.keys(gd.payAdmins || {});
  return ids.length === 1 ? ids[0] : null;
}

function payerMention(gd, uid) {
  const pid = payerFor(gd, uid);
  return pid ? `<@${pid}>` : null;
}

function payTicketLine(gd) {
  return gd.payTicket || 'Open a ticket in the server\'s ticket/support channel to collect it.';
}

// type: 'add' | 'remove' | 'set' | 'paid' | 'claim' | 'note'
function payLog(entry, type, delta, byId, note) {
  entry.history.push({ ts: Date.now(), type, delta, by: byId, note: (note || '').slice(0, 120) });
  if (entry.history.length > PAY_HISTORY_MAX) entry.history.splice(0, entry.history.length - PAY_HISTORY_MAX);
}

// Most recent first — `limit` 0/undefined means everything we kept.
function payHistoryLines(entry, limit) {
  const icons = { add: '➕', remove: '➖', set: '📝', paid: '✅', claim: '📨', note: '•' };
  const rows  = [...(entry.history || [])].reverse();
  const shown = limit ? rows.slice(0, limit) : rows;
  return shown.map(h => {
    const when  = `<t:${Math.floor(h.ts / 1000)}:d>`;
    const amt   = h.delta ? ` **${h.delta > 0 ? '+' : '−'}${formatAmount(Math.abs(h.delta))}**` : '';
    const by    = h.by ? ` by <@${h.by}>` : '';
    const note  = h.note ? ` — *${h.note}*` : '';
    return `${icons[h.type] || '•'} ${when}${amt}${by}${note}`;
  });
}

function payStatusEmbed(gd, guild, uid, aucPfx) {
  const e       = payEntry(gd, uid);
  const payer   = payerMention(gd, uid);
  const pending = payPending(e);
  const embed = new EmbedBuilder()
    .setTitle(`💵 Payment — ${displayNameOf(guild, uid)}`)
    .setColor(e.due > 0 ? 0xFFA500 : 0x00FF00)
    .setDescription(`**Unclaimed:** ${formatAmount(e.due)}`)
    .addFields({ name: 'Claim from', value: payer || '*Not assigned yet — an admin must run `' + aucPfx + 'payer @staff @admin`*', inline: false })
    .setTimestamp();
  const m = guild.members.cache.get(uid);
  if (m) embed.setThumbnail(m.user.displayAvatarURL());
  if (pending > 0) {
    embed.addFields({ name: `📨 Claimed — waiting for transfer (${formatAmount(pending)})`, value: e.claims.map(c =>
      `• **${formatAmount(c.amount)}** <t:${Math.floor(c.ts / 1000)}:R>${c.note ? ` — *${c.note}*` : ''}`).join('\n').slice(0, 1024), inline: false });
  }
  const lines = payHistoryLines(e, 6);
  if (lines.length) embed.addFields({ name: 'Recent log', value: lines.join('\n').slice(0, 1024), inline: false });
  if (e.due > 0) embed.setFooter({ text: `Run ${aucPfx}payclaim to claim it` });
  return embed;
}

// Find a member without needing a ping: mention, raw id, username, tag, team
// name, or display name (exact, else a unique prefix like "jai" → "jaiv").
function resolvePayMember(guild, gd, q) {
  const raw = (q || '').trim();
  if (!raw) return null;
  const m  = raw.match(/^<@!?(\d+)>$/);
  const id = m ? m[1] : (/^\d{5,}$/.test(raw) ? raw : null);
  if (id) return guild.members.cache.get(id) || null;
  const low   = raw.toLowerCase();
  const cache = guild.members.cache;
  const team  = gd && gd.teams && Object.entries(gd.teams).find(([, name]) => name.toLowerCase() === low);
  if (team) return cache.get(team[0]) || null;
  const exact = cache.find(mem => mem.user.username.toLowerCase() === low)
             || cache.find(mem => mem.displayName.toLowerCase() === low)
             || cache.find(mem => (mem.user.tag || '').toLowerCase() === low);
  if (exact) return exact;
  // Fall back to a prefix match, but only when it points at exactly one person
  const starts = cache.filter(mem => mem.displayName.toLowerCase().startsWith(low) || mem.user.username.toLowerCase().startsWith(low));
  return starts.size === 1 ? starts.first() : null;
}

// Payments are typed in shorthand as often as not — 200k, 1.5l, 2cr, 3m.
function parsePayAmount(value) {
  if (!value) return null;
  const s = String(value).trim().replace(/,/g, '').toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m|l|lakh|lac|cr|crore)$/);
  if (!m) return parseAmount(value);
  const mult = { k: 1e3, m: 1e6, l: 1e5, lakh: 1e5, lac: 1e5, cr: 1e7, crore: 1e7 };
  return parseFloat(m[1]) * mult[m[2]];
}

// `<cmd> <@user|username|id|team> <amount> [note]` — the ping is optional, the
// target and the amount can be typed in either order, and a multi-word name is
// matched greedily (3 words, then 2, then 1). Everything left over is the note.
function parsePayArgs(message, gd, parts) {
  const rest = parts.slice(1).filter(p => !/^<@[!&]?\d+>$/.test(p));
  let target = message.mentions.members.first() || null;
  let from   = 0, take = 0;
  if (!target) {
    // Try a name at the front; if the front is the amount, try just after it
    for (const start of [0, 1]) {
      if (start === 1 && parsePayAmount(rest[0]) === null) break;
      for (let n = Math.min(3, rest.length - start); n >= 1 && !target; n--) {
        const found = resolvePayMember(message.guild, gd, rest.slice(start, start + n).join(' '));
        if (found) { target = found; from = start; take = n; }
      }
      if (target) break;
    }
  }
  const left   = rest.filter((_, i) => i < from || i >= from + take);
  const amount = left.length ? parsePayAmount(left[0]) : null;
  const note   = (amount === null ? left : left.slice(1)).join(' ').trim();
  return { target, amount, note };
}

// ── Percentage lists ───────────────────────────────────────────────────────
// Named lists of "who gets what % of a total" — one per kind of payout
// (tournament, sponsorship, …). Running a total against a list credits every
// member's cut onto what they're owed.
const PAY_PURCHASE_MAX = 40;

function payLists(gd) {
  if (!gd.payLists) gd.payLists = {};
  // Older single-list shape kept everything in gd.payShares
  if (gd.payShares && Object.keys(gd.payShares).length && !gd.payLists.default) {
    gd.payLists.default = gd.payShares;
    delete gd.payShares;
  }
  return gd.payLists;
}

// Case-insensitive lookup — returns { key, list } or null.
function payListFind(gd, name) {
  const lists = payLists(gd);
  const low   = (name || '').trim().toLowerCase();
  if (!low) return null;
  const key = Object.keys(lists).find(k => k.toLowerCase() === low);
  return key ? { key, list: lists[key] } : null;
}

function payShareTotal(list) {
  return Object.values(list || {}).reduce((s, p) => s + (Number(p) || 0), 0);
}

// Split `amount` by a list's percentages, credit everyone and record it.
// Returns { splits: [{ uid, pct, cut }], paidOut, leftover }.
function recordPurchase(gd, listKey, amount, byId, note) {
  const list   = payLists(gd)[listKey] || {};
  const splits = Object.entries(list).filter(([, p]) => (Number(p) || 0) > 0)
    .map(([uid, pct]) => ({ uid, pct: Number(pct), cut: Math.round(amount * Number(pct)) / 100 }))
    .sort((a, b) => b.pct - a.pct);
  for (const s of splits) {
    const e = payEntry(gd, s.uid);
    e.due += s.cut;
    payLog(e, 'add', s.cut, byId, `${s.pct}% of ${formatAmount(amount)} [${listKey}]${note ? ` — ${note}` : ''}`);
  }
  const paidOut = splits.reduce((t, s) => t + s.cut, 0);
  if (!Array.isArray(gd.payPurchases)) gd.payPurchases = [];
  gd.payPurchases.push({ ts: Date.now(), amount, by: byId, list: listKey, note: (note || '').slice(0, 120), splits });
  if (gd.payPurchases.length > PAY_PURCHASE_MAX) gd.payPurchases.splice(0, gd.payPurchases.length - PAY_PURCHASE_MAX);
  return { splits, paidOut, leftover: amount - paidOut };
}

function payHelpEmbed(aucPfx) {
  return new EmbedBuilder()
    .setTitle('💵 Staff Payments')
    .setColor(0x2ECC71)
    .setDescription(
      `Log small payments as they happen, they add up, the staff member claims the total and collects it **in your other bot** — this one only keeps the record.\n` +
      `Prefix: \`${aucPfx}\` · pings optional (username / nickname / team name all work) · amounts accept \`200k\` \`1.5l\` \`2cr\``)
    .addFields(
      { name: '__For staff__', value:
        `\`${aucPfx}pay\` — what you're owed, who to claim it from, your log\n` +
        `\`${aucPfx}payclaim [amount]\` — claim it (no amount = everything). The bot DMs you the ticket instructions`, inline: false },

      { name: '__Logging payments__', value:
        `\`${aucPfx}payadd <user> <amt> [note]\` — log a payment for one person\n` +
        `\`${aucPfx}payremove <user> <amt> [note]\` — take a logged payment back off\n` +
        `\`${aucPfx}purchase <amt> <list> [note]\` — split a total across a list (add \`pending\` to skip the claim step)`, inline: false },

      { name: '__Percentage lists__', value:
        `\`${aucPfx}payshare\` — every list · \`${aucPfx}payshare <list>\` — one list\n` +
        `\`${aucPfx}payshare <list> add <user> <pct>\` — add/edit someone (makes the list)\n` +
        `\`${aucPfx}payshare <list> rem <user>\` · \`rename <new name>\` · \`delete\``, inline: false },

      { name: '__Claims__', value:
        `\`${aucPfx}payclaims\` — everything claimed and waiting to be transferred\n` +
        `\`${aucPfx}paydone <user> [all]\` — you sent it → clears that pending log\n` +
        `\`${aucPfx}paydeny <user> [reason]\` — cancel a claim, amount goes back on their balance`, inline: false },

      { name: '__Who pays / who can run this__', value:
        `\`${aucPfx}payer <user> <admin>\` — who that staff member claims from\n` +
        `\`${aucPfx}payer default <admin>\` — the fallback for everyone else\n` +
        `\`${aucPfx}payadmin add|remove <user>\` — who can use these commands *(Admin/Auctioneer)*`, inline: false },

      { name: '__Records & setup__', value:
        `\`${aucPfx}paylist\` — everyone outstanding · \`${aucPfx}paylog [user]\` — full history\n` +
        `\`${aucPfx}purchases\` — past list payouts · \`${aucPfx}payticket <text>\` — your ticket wording\n` +
        `\`${aucPfx}slc pay #channel\` — send payment logs to their own channel`, inline: false }
    );
}

// ── Auction help pages (shared by !help auction and .ahelp) ────────────────
function auctionHelpPage1(aucPfx, navHint) {
  return new EmbedBuilder()
    .setTitle('🏏 Auction — Bidding & Queue')
    .setColor(0xFF0000)
    .setDescription(`Prefix: \`${aucPfx}\``)
    .addFields(
      { name: `\`${aucPfx}sell <player> <base> [inc]\``, value: 'Start an auction *(Admin/Auctioneer)*', inline: false },
      { name: `\`${aucPfx}bid\` / \`${aucPfx}b\``,          value: 'Place a bid — opens at base, then raises by the increment (no direct jumps)', inline: false },
      { name: `\`${aucPfx}sold\``,                        value: 'End auction & auto-start next from queue *(Admin/Auctioneer)*', inline: false },
      { name: `\`${aucPfx}aq <player> <base> [inc]\``,   value: 'Add to queue — multiple at once, one per line or comma-separated *(Admin/Auctioneer)*', inline: false },
      { name: `\`${aucPfx}aqs <set> <players…>\``,        value: 'Add players under a named set — queue auto-stops at the end of each set *(Admin/Auctioneer)*', inline: false },
      { name: `\`${aucPfx}sq\``,                          value: 'Start / resume queue *(Admin/Auctioneer)*', inline: true },
      { name: `\`${aucPfx}si <seconds>\``,                value: 'Countdown before each auto-advanced player — 0 = off *(Admin/Auctioneer)*', inline: true },
      { name: `\`${aucPfx}stq\``,                         value: 'Stop queue / cancel scheduled start *(Admin/Auctioneer)*', inline: true },
      { name: `\`${aucPfx}q\``,                           value: 'View queue — one set per page, ◀ ▶ to flip', inline: true },
      { name: `\`${aucPfx}rq <index>\``,                  value: 'Remove from queue *(Admin/Auctioneer)*', inline: true },
      { name: `\`${aucPfx}cq\``,                          value: 'Clear queue *(Admin/Auctioneer)*', inline: true },
      { name: `\`${aucPfx}bal [@user]\``,                 value: 'Check purse balance', inline: true },
      { name: `\`${aucPfx}lb\``,                          value: 'Purse leaderboard', inline: true },
      { name: `\`${aucPfx}team [@user] <name>\``,         value: 'Set a team name (yours, or anyone if Admin/Auctioneer) — `clear` to remove', inline: true },
      { name: `\`${aucPfx}squad [@user|team]\``,          value: "View a squad by mention or team name", inline: true },
      { name: `\`${aucPfx}ss\``,                          value: 'Squad status vs min/max limits', inline: true },
      { name: `\`${aucPfx}taken/s <player>\``,            value: 'Is a player taken? By whom & which draft round', inline: true },
      { name: `\`${aucPfx}draft\` / \`${aucPfx}d\``,      value: "Draft status — round, order, who's on the clock", inline: true },
      { name: `\`${aucPfx}draftpicks/dpk\``,              value: 'All draft picks so far, grouped by team', inline: true },
      { name: `\`${aucPfx}draftteams/dt\``,               value: 'Teams in the (next) draft', inline: true },
      { name: `\`${aucPfx}owners/o\``,                    value: 'All owners with their squad sizes', inline: true },
      { name: `\`${aucPfx}setorder/so\``,                    value: 'Set your preset draft order **privately in DMs** — timeouts auto-draft your top available player (`myorder` views it, `setorder clear` removes; needs `autodraft on`)', inline: false },
      { name: `\`${aucPfx}pay\` / \`${aucPfx}payclaim\``, value: 'Staff: what you\'re still owed, who to claim it from, and raising a claim — full list in `' + aucPfx + 'payhelp`', inline: false },
      { name: `\`${aucPfx}trade @user\``,                 value: 'Start a squad trade, then `trade add/rem <player>`, `trade cash <amount>`, `view/accept/cancel` — both sides must total the same value (players + cash)', inline: false },
      { name: `💸 Open auction — \`${DEFAULT_OPEN_PREFIX}ohelp\``, value: `A separate mode on the \`${DEFAULT_OPEN_PREFIX}\` prefix: the whole player list open at once for days, proxy bids, priority order and one big settlement at the end.`, inline: false }
    )
    .setFooter({ text: navHint });
}

function auctionHelpPage2(aucPfx, navHint) {
  return new EmbedBuilder()
    .setTitle('🏏 Auction — Admin Commands')
    .setColor(0xFF6600)
    .setDescription(`Prefix: \`${aucPfx}\` — Requires Admin or Auctioneer role`)
    .addFields(
      { name: `\`${aucPfx}setpurse @user <amt>\``,           value: "Set a user's purse", inline: false },
      { name: `\`${aucPfx}sd <amount>\``,                    value: 'Set default bid increment', inline: true },
      { name: `\`${aucPfx}slc [sold|unsold|trade|draft|skip] #channel\``, value: 'Set log channel (no type = general/default)', inline: true },
      { name: `\`${aucPfx}draftstart/ds <rounds> [secs]\``,  value: 'Start a draft — random order each round, timed picks typed in the channel; skips get a second chance after all rounds', inline: false },
      { name: `\`${aucPfx}draftadd/da @user [team name]\``,  value: 'Add an owner to the draft roster, optionally setting their team name too — `draftremove @user` drops them (unset roster = everyone with a team name)', inline: false },
      { name: `\`${aucPfx}nextround\` / \`${aucPfx}draftauto on|off\``, value: 'Rounds pause after showing the new order — `nextround` starts the next one; `draftauto on` makes them start automatically', inline: false },
      { name: `\`${aucPfx}autodraft/ad on|off\``,            value: 'Allow owners to set preset orders (setorder) so timeouts auto-draft — off by default', inline: false },
      { name: `\`${aucPfx}resetall [full]\``,                value: 'Wipe ALL squads, draft, pool & preset orders for a fresh season (`full` = team names & purses too) — asks for confirm', inline: false },
      { name: `\`${aucPfx}draftpool/dp [clear]\``,           value: 'Load the player list (paste it or attach the .txt) — draft picks must then be real players from it', inline: false },
      { name: `\`${aucPfx}draftstop/dstop\` · \`${aucPfx}draftresume/dr\``, value: 'Cancel the draft, or restart the current pick timer (e.g. after a bot restart)', inline: false },
      { name: `\`${aucPfx}ssl <min> <max>\``,                value: 'Set min/max squad size (0 = none)', inline: true },
      { name: `\`${aucPfx}st <seconds>\``,                   value: 'Bid countdown timer — auto-sold at 0 (0 = off)', inline: true },
      { name: `\`${aucPfx}addsquad @user <players…>\``,   value: 'Add to squad — one player [price], or comma-separated names for bulk retention', inline: false },
      { name: `\`${aucPfx}delete @user <index|name|all>\``,  value: 'Remove player from squad by index or name — also frees them for the draft *(Admin/Auctioneer)*', inline: false },
      { name: `\`${aucPfx}swap @userA @userB\``,             value: 'Swap two members\' purse, squad & team name *(Admin/Auctioneer)*', inline: false },
      { name: `\`${aucPfx}setauctioneer @user\``,            value: 'Grant/revoke Auctioneer role *(Admin/Auctioneer)*', inline: false },
      { name: `\`${aucPfx}payhelp\``,                        value: 'Staff payment ledger — what each staff member is owed, who they claim it from, and claims via ticket', inline: false },
      { name: `\`${aucPfx}sync [pull]\``,                    value: 'Force push to JSONBin (or `sync pull` to reload from it) *(Admin/Auctioneer)*', inline: false },
      { name: `\`${aucPfx}dm @role|@user|username <msg>\``,  value: 'DM a user (mention or username), or everyone with a role *(Owner or users granted via `dmallow`)*', inline: false },
      { name: `\`${aucPfx}gdm @role|@user|username <msg>\``, value: 'Ghost DM — sends just the message, no sender/server info *(same permission as `dm`)*', inline: false },
      { name: `\`${aucPfx}dmallow/dmdeny @user\` / \`${aucPfx}dmlist\``, value: 'Grant/revoke/list `.dm` permission *(Owner only)*', inline: false },
      { name: `\`${aucPfx}approveauction\` / \`${aucPfx}approvecg\``, value: 'Approve server for bot features *(Owner only)*', inline: false },
      { name: '`/sell` `/setauctionprefix` `/setcgprefix`',    value: 'Slash commands', inline: false }
    )
    .setFooter({ text: navHint });
}

// ── Auction countdown timer (in-memory, per guild) ────────────────────────
const auctionTimers = new Map(); // guildId -> { handles: [], cancelled: bool }

function cancelAuctionTimer(guildId) {
  const t = auctionTimers.get(String(guildId));
  if (!t) return;
  t.cancelled = true;
  t.handles.forEach(clearTimeout);
  auctionTimers.delete(String(guildId));
}

function bigCountdown(n) {
  const keycap = { 3: '3️⃣', 2: '2️⃣', 1: '1️⃣' }[n] || String(n);
  return `# ⏳ ${keycap}\n### Going... bid now or it closes!`;
}

// Start (or restart, on each bid) the countdown for a guild's live auction.
function startAuctionTimer(guild, channel, gd) {
  const seconds = gd.auctionTimer || 0;
  if (!seconds) return;
  const gid = String(guild.id);
  cancelAuctionTimer(gid);

  const state = { handles: [], cancelled: false };
  auctionTimers.set(gid, state);
  const schedule = (fn, ms) => { state.handles.push(setTimeout(fn, ms)); };

  const visible = Math.min(seconds, 3);   // last up-to-3s shown as big 3-2-1
  const preWait = (seconds - visible) * 1000;
  let countdownMsg = null;

  const tick = async (n) => {
    if (state.cancelled) return;
    try {
      if (!countdownMsg) countdownMsg = await channel.send(bigCountdown(n));
      else                await countdownMsg.edit(bigCountdown(n));
    } catch (_) {}
  };

  for (let i = 0; i < visible; i++) {
    const n = visible - i; // 3, 2, 1
    schedule(() => tick(n), preWait + i * 1000);
  }

  schedule(async () => {
    if (state.cancelled) return;
    if (!gd.auction) { auctionTimers.delete(gid); return; }
    if (countdownMsg) { try { await countdownMsg.edit("# ⏳ Time's up!"); } catch (_) {} }
    if (state.cancelled) return; // a bid landed during the edit above → don't auto-sell
    auctionTimers.delete(gid);
    await doSold(guild, channel, gd); // sells to highest bidder, or marks UNSOLD if no bids
  }, preWait + visible * 1000);
}

// Shift the front of the queue into a live auction, announce it, and arm the bid timer.
async function startNextFromQueue(guild, channel, gd, startedByTag) {
  if (!gd.queue || gd.queue.length === 0) return false;
  gd.queuePaused = false;
  const next = gd.queue.shift();
  gd.auction = { player: next.player, base: next.base, current_bid: next.base, difference: next.difference, set: next.set || null,
    highest_bidder: null, highest_bidder_id: null, channel_id: String(channel.id) };
  scheduleAuctionSave();
  const embed = new EmbedBuilder().setTitle('🏏 AUCTION STARTED!')
    .setDescription(`*From queue — ${gd.queue.length} player(s) remaining.*`).setColor(0xFF0000)
    .addFields(
      { name: 'Player',        value: `**${next.player}**`,          inline: true },
      { name: 'Base Price',    value: formatAmount(next.base),       inline: true },
      { name: 'Min Increment', value: formatAmount(next.difference), inline: true }
    );
  if (next.set) embed.addFields({ name: 'Set', value: next.set, inline: true });
  if (gd.auctionTimer) embed.addFields({ name: '⏱️ Timer', value: `${gd.auctionTimer}s — no bid before 0 = UNSOLD; each bid resets it.`, inline: false });
  embed.addFields({ name: 'How to bid', value: `Use \`${getAuctionPrefix(guild.id)}bid <amount>\``, inline: false });
  if (startedByTag) embed.setFooter({ text: `Started by ${startedByTag}` });
  embed.setTimestamp();
  await channel.send({ embeds: [embed] });
  startAuctionTimer(guild, channel, gd);
  return true;
}

// ── Pending "next player starts in N seconds" countdown (in-memory) ─────────
const pendingStarts = new Map(); // guildId -> { handles: [], cancelled: bool }

function cancelPendingStart(guildId) {
  const t = pendingStarts.get(String(guildId));
  if (!t) return;
  t.cancelled = true;
  t.handles.forEach(clearTimeout);
  pendingStarts.delete(String(guildId));
}

function startPendingCountdown(guild, channel, gd, seconds) {
  const gid = String(guild.id);
  cancelPendingStart(gid);
  const state = { handles: [], cancelled: false };
  pendingStarts.set(gid, state);
  const schedule = (fn, ms) => { state.handles.push(setTimeout(fn, ms)); };

  const visible = Math.min(seconds, 3);
  const preWait = (seconds - visible) * 1000;
  let msg = null;

  const tick = async (n) => {
    if (state.cancelled) return;
    const keycap = { 3: '3️⃣', 2: '2️⃣', 1: '1️⃣' }[n] || String(n);
    const content = `# ⏳ ${keycap}\n### Next player is coming up for bidding...`;
    try { if (!msg) msg = await channel.send(content); else await msg.edit(content); } catch (_) {}
  };

  for (let i = 0; i < visible; i++) { const n = visible - i; schedule(() => tick(n), preWait + i * 1000); }

  schedule(async () => {
    if (state.cancelled) return;
    pendingStarts.delete(gid);
    if (gd.auction) return;                          // something already started
    if (!gd.queue || gd.queue.length === 0) return;  // queue emptied meanwhile
    if (msg) { try { await msg.edit('# 🏏 Starting!'); } catch (_) {} }
    await startNextFromQueue(guild, channel, gd, null);
  }, preWait + visible * 1000);
}

// ── Queue view helpers ─────────────────────────────────────────────────────
// Group the queue into consecutive runs by set — each run becomes one page.
function queueGroups(gd) {
  const groups = [];
  (gd.queue || []).forEach((item, i) => {
    const s = item.set || null;
    const last = groups[groups.length - 1];
    if (!last || last.set !== s) groups.push({ set: s, items: [] });
    groups[groups.length - 1].items.push({ ...item, pos: i + 1 });
  });
  return groups;
}

function queuePageEmbed(gd, aucPfx, groups, page) {
  const g = groups[page];
  let desc = '';
  if (gd.auction) desc += `🔴 **Now auctioning:** ${gd.auction.player}${gd.auction.set ? ` *(set: ${gd.auction.set})*` : ''} — ${formatAmount(gd.auction.current_bid)}\n\n`;
  if (gd.queuePaused) desc += `⏸️ *Queue is stopped — use \`${aucPfx}sq\` to start the next player.*\n\n`;
  desc += `__${g.set ? `Set: ${g.set}` : 'Ungrouped'}__ — ${g.items.length} player(s)\n`;
  desc += g.items.map(it => `\`${it.pos}.\` **${it.player}** — Base ${formatAmount(it.base)}, Inc ${formatAmount(it.difference)}`).join('\n');
  return new EmbedBuilder().setTitle('📋 Auction Queue').setColor(0x5865F2)
    .setDescription(desc.slice(0, 4096))
    .setFooter({ text: `Set ${page + 1}/${groups.length} • ${gd.queue.length} player(s) total` })
    .setTimestamp();
}

// ── Trade helpers ──────────────────────────────────────────────────────────
function sumOffer(offer) { return (offer || []).reduce((s, p) => s + (p.price || 0), 0); }

function tradeEmbed(gd, guild, aucPfx) {
  const t = gd.trade;
  const nameOf = (uid) => teamLabel(gd, guild, uid);
  const fmtSide = (offer, cash) => {
    const lines = offer.map(p => `• **${p.player}** (${formatAmount(p.price)})`);
    if (cash > 0) lines.push(`💰 **${formatAmount(cash)}** cash`);
    return lines.length ? lines.join('\n') : '*nothing yet*';
  };
  const cashA = t.cashA || 0, cashB = t.cashB || 0;
  const totA = sumOffer(t.offerA) + cashA, totB = sumOffer(t.offerB) + cashB;
  const atLeastOnePlayer = (t.offerA.length + t.offerB.length) > 0;
  const bothHave = totA > 0 && totB > 0;
  const balanced = bothHave && atLeastOnePlayer && totA === totB;
  let status;
  if (!bothHave)             status = 'Each side must offer players and/or cash.';
  else if (!atLeastOnePlayer) status = 'A trade needs at least one player.';
  else if (totA !== totB)    status = `⚖️ Not balanced — difference **${formatAmount(Math.abs(totA - totB))}**. Add players or \`${aucPfx}trade cash <amount>\` to even it out.`;
  else                       status = `✅ Balanced! Both run \`${aucPfx}trade accept\` to confirm.`;
  return new EmbedBuilder().setTitle('🔄 Trade').setColor(balanced ? 0x57F287 : 0xFFA500)
    .addFields(
      { name: `${nameOf(t.a)} gives — ${formatAmount(totA)} ${t.acceptedA ? '✅' : ''}`, value: fmtSide(t.offerA, cashA), inline: true },
      { name: `${nameOf(t.b)} gives — ${formatAmount(totB)} ${t.acceptedB ? '✅' : ''}`, value: fmtSide(t.offerB, cashB), inline: true },
      { name: 'Status', value: status, inline: false }
    )
    .setFooter({ text: `${aucPfx}trade add/rem <player> · cash <amount> · view · accept · cancel` });
}

async function doSold(guild, channel, gd) {
  cancelAuctionTimer(guild.id); // stop any running countdown
  const auction = gd.auction;
  if (!auction) {
    return channel.send('❌ No auction is currently running.');
  }

  const { player, current_bid: bid, highest_bidder: bidderName, highest_bidder_id: bidderId } = auction;
  let embed;

  if (bidderId) {
    const curPurse = gd.purses[bidderId] || 0;
    gd.purses[bidderId] = Math.max(0, curPurse - bid);
    if (!gd.squads[bidderId]) gd.squads[bidderId] = [];
    gd.squads[bidderId].push({ player, price: bid });

    const maxSquad  = gd.maxSquad || 0;
    const squadSize = gd.squads[bidderId].length;
    embed = new EmbedBuilder()
      .setTitle('🔨 SOLD!')
      .setDescription(`**${player}** has been sold to **${teamOnly(gd, guild, bidderId)}** for **${formatAmount(bid)}**!`)
      .setColor(0xFFD700)
      .addFields(
        { name: 'Remaining Balance', value: formatAmount(gd.purses[bidderId]), inline: true },
        { name: 'Squad Size', value: maxSquad ? `${squadSize}/${maxSquad}` : String(squadSize), inline: true }
      )
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

  const ch = guild.channels.cache.get(auction.channel_id) || channel;
  await ch.send({ embeds: [embed] });
  await sendLog(guild, embed, bidderId ? 'sold' : 'unsold');

  // Auto-advance the queue — unless it's stopped or we've hit a set boundary
  if (gd.queue && gd.queue.length > 0) {
    const next     = gd.queue[0];
    const soldSet  = auction.set || null;
    const nextSet  = next.set || null;

    if (gd.queuePaused) {
      await ch.send({ embeds: [new EmbedBuilder().setColor(0xAAAAAA)
        .setTitle('⏸️ Queue Stopped')
        .setDescription(`Auto-advance is off. Use \`.sq\` to start the next player (**${next.player}**${nextSet ? ` — set: ${nextSet}` : ''}).`)] });
    } else if (nextSet !== soldSet) {
      await ch.send({ embeds: [new EmbedBuilder().setColor(0x57F287)
        .setTitle(`✅ Set Complete${soldSet ? ` — ${soldSet}` : ''}`)
        .setDescription(`Next up: **${nextSet ? `Set ${nextSet}` : 'Ungrouped players'}** (${gd.queue.length} player(s) left).\nUse \`.sq\` to start it.`)] });
    } else if (gd.nextDelay > 0) {
      // Delay before the next player comes up — announce, then run the pre-start countdown
      await ch.send({ embeds: [new EmbedBuilder().setColor(0x00B0F4)
        .setTitle('⏳ Up Next')
        .setDescription(`**${next.player}**${nextSet ? ` *(set: ${nextSet})*` : ''} comes up for bidding in **${gd.nextDelay}s**.`)
        .addFields({ name: 'Base Price', value: formatAmount(next.base), inline: true })
        .setTimestamp()] });
      startPendingCountdown(guild, ch, gd, gd.nextDelay);
    } else {
      gd.queue.shift();
      gd.auction = {
        player: next.player,
        base: next.base,
        current_bid: next.base,
        difference: next.difference,
        set: nextSet,
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
        );
      if (nextSet) nextEmbed.addFields({ name: 'Set', value: nextSet, inline: true });
      if (gd.auctionTimer) nextEmbed.addFields({ name: '⏱️ Timer', value: `${gd.auctionTimer}s — no bid before 0 = UNSOLD; each bid resets it.`, inline: false });
      nextEmbed.setTimestamp();
      await ch.send({ embeds: [nextEmbed] });
      startAuctionTimer(guild, ch, gd); // next player also counts down with no bids
    }
  }

  // Persist to JSONBin once per sale — the main durability point (purses & squads)
  await flushAuction();
}

// ══════════════════════════════════════════════════════════════════════════════
//  OPEN AUCTION HELPERS
// ══════════════════════════════════════════════════════════════════════════════
// A completely separate mode from the live auction: the whole player list is open
// at once for days, everyone bids whenever they like, proxy (max) bids fight it
// out automatically, and everything is settled in one go when the clock runs out.
//
// Money rules: only the bids you are CURRENTLY LEADING lock funds. Get outbid and
// that money is instantly free again. You may lead more players than your squad
// has slots — your priority order decides which ones you keep at settlement, and
// the rest cascade down to the next highest bidder.

const OPEN_MAX_POOL = 2000;   // hard cap on pool size (JSONBin payload sanity)
const OPEN_HIST     = 5;      // per-player bid history kept for `search`
const OPEN_FEED     = 40;     // server-wide recent-bid feed length
// History is display-only and there is one array per player, so it is stored as
// packed [userId, amount, unixSeconds] triples rather than named fields — with a
// 1000-player pool the key names alone cost well over a hundred KB per save.
function histEntry(uid, amount, at) { return [uid, amount, Math.floor(at / 1000)]; }

function openDefaults() {
  return {
    active: false, paused: false, startedAt: 0, endsAt: 0, settledAt: 0,
    channelId: null,          // where the bot announces closes/settlement
    cfg: {
      maxSquad:    30,        // squad slots — you may lead more, priority decides
      defaultBase: 100000,    // base price for pool entries with no price given
      minInc:      100000,    // smallest raise; the ladder scales up from this
      ladder:      true,      // raise size grows as a player gets expensive
      antiSnipe:   10,        // minutes — a late bid pushes that player's close back
      overcommit:  false,     // may leading bids exceed the purse? (settlement trims)
      dm:          true,      // outbid DMs
      days:        3          // default auction length
    },
    players:  {},   // key -> { n, set, base, bid, uid, at, closesAt, closed, fl, best, hist, count, sniped }
    autobids: {},   // key -> { userId: maxBid }
    priority: {},   // userId -> [key, ...] most wanted first
    watch:    {},   // userId -> [key, ...]
    noDm:     {},   // userId -> true (opted out of DMs)
    feed:     [],   // recent bids, newest first
    results:  null, // filled in by settlement
    warned:   {}
  };
}

// Existing servers were saved before this mode existed — fill in anything missing.
function ensureOpen(gd) {
  if (!gd.open) gd.open = openDefaults();
  const d = openDefaults();
  for (const k of Object.keys(d))     if (gd.open[k]     === undefined) gd.open[k]     = d[k];
  for (const k of Object.keys(d.cfg)) if (gd.open.cfg[k] === undefined) gd.open.cfg[k] = d.cfg[k];
  return gd.open;
}

// Money with the shorthand people actually type: 2m, 500k, 1.5cr, 20l.
function parseMoney(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m|b|l|lakh|lac|cr|crore)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, l: 1e5, lakh: 1e5, lac: 1e5, cr: 1e7, crore: 1e7 }[m[2]] || 1;
  return Math.round(n * mult);
}

// Raise size grows with the price so a 50m player isn't nudged up in 100k steps.
function bidIncrement(cfg, current) {
  const base = cfg.minInc || 100000;
  if (!cfg.ladder) return base;
  if (current < base * 10)  return base;
  if (current < base * 50)  return base * 2;
  if (current < base * 100) return base * 5;
  return base * 10;
}

function openKey(name) { return normPlayer(name); }

function fmtLeft(ms) {
  if (ms <= 0) return 'closed';
  const d = Math.floor(ms / 86400000), h = Math.floor(ms % 86400000 / 3600000);
  const mi = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${mi}m`;
  if (mi) return `${mi}m`;
  return `${s}s`;
}

// Discord renders this in every reader's own timezone.
function ts(msEpoch, style) { return `<t:${Math.floor(msEpoch / 1000)}:${style || 'R'}>`; }

// Name -> player, the same way the draft resolves names: exact, then a unique
// substring ("kohli" -> Virat Kohli), else the ambiguous list.
function openResolve(o, raw) {
  const clean = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const q = openKey(clean);
  if (o.players[q]) return { key: q, p: o.players[q] };
  const subs = Object.keys(o.players).filter(k => k.includes(q));
  if (subs.length === 1) return { key: subs[0], p: o.players[subs[0]] };
  if (subs.length > 1)   return { ambiguous: subs.slice(0, 6).map(k => o.players[k].n) };
  return null;
}

// ── Balance management ─────────────────────────────────────────────────────
// Committed = every bid you are currently leading. Nothing else is locked.
// Settled players are already paid for out of the purse, so they stop counting.
function openCommitted(o, uid) {
  let total = 0;
  for (const p of Object.values(o.players)) if (p.uid === uid && !p.settled) total += p.bid || 0;
  return total;
}
function openAvailable(gd, uid) {
  const o = ensureOpen(gd);
  return Math.max(0, (gd.purses[uid] || 0) - openCommitted(o, uid));
}

// The most this user could put on THIS player right now — raising your own
// leading bid only costs the difference, since that money is already locked.
function openSpendRoom(gd, uid, key) {
  const o = ensureOpen(gd);
  const purse = gd.purses[uid] || 0;
  if (o.cfg.overcommit) return purse;   // settlement trims by priority instead
  const p = o.players[key];
  const mine = (p && p.uid === uid) ? (p.bid || 0) : 0;
  return Math.max(0, purse - openCommitted(o, uid) + mine);
}

function openLeads(o, uid) {
  return Object.entries(o.players)
    .filter(([, p]) => p.uid === uid && !p.settled)
    .map(([k, p]) => ({ k, p, a: p.bid || 0 }));
}

// Players you bid on but no longer lead — "bids that got overtaken".
function openOutbid(o, uid) {
  return Object.entries(o.players)
    .filter(([, p]) => p.uid !== uid && p.best && p.best[uid])
    .map(([k, p]) => ({ k, p, mine: p.best[uid] }));
}

function openSlotsUsed(gd, uid) { return (gd.squads[uid] || []).length; }

function openPriorityIndex(o, uid, key) {
  const list = (o.priority && o.priority[uid]) || [];
  const i = list.indexOf(key);
  return i === -1 ? Infinity : i;
}

// Most wanted first. With no priority set, the pricier lead is protected first —
// dropping your 12m star to keep a 200k punt would be nonsense.
function sortByOpenPriority(o, uid, list) {
  list.sort((x, y) => {
    const px = openPriorityIndex(o, uid, x.k), py = openPriorityIndex(o, uid, y.k);
    if (px !== py) return px - py;
    return (y.a || 0) - (x.a || 0);
  });
  return list;
}

// ── Proxy bidding ──────────────────────────────────────────────────────────
// Everyone's ceiling on a player = their highest explicit bid, or their max bid
// if it's higher, capped by what they can actually afford. Highest ceiling wins
// and pays just enough to beat the runner-up — so a max never overpays.
function resolveOpenProxies(gd, key) {
  const o = ensureOpen(gd), p = o.players[key];
  if (!p) return null;
  const ceilings = {};
  for (const [uid, a] of Object.entries(p.fl || {}))            ceilings[uid] = Math.max(ceilings[uid] || 0, a);
  for (const [uid, a] of Object.entries(o.autobids[key] || {})) ceilings[uid] = Math.max(ceilings[uid] || 0, a);

  const cands = Object.entries(ceilings)
    .map(([uid, mx]) => ({ uid, mx: Math.min(mx, openSpendRoom(gd, uid, key)) }))
    .filter(c => c.mx >= p.base)
    .sort((a, b) => b.mx - a.mx);
  if (!cands.length) return null;

  const win = cands[0], second = cands[1];
  let price = p.base;
  if (second) price = Math.min(win.mx, second.mx + bidIncrement(o.cfg, second.mx));
  price = Math.max(price, p.base, (p.fl && p.fl[win.uid]) || 0);
  if (p.uid === win.uid) price = Math.max(price, p.bid || 0);   // a standing price never drops

  // Runners-up stay on record at their ceiling — that's what settlement falls
  // back to if the winner has to release the player.
  p.best = {};
  for (const c of cands) p.best[c.uid] = (c.uid === win.uid) ? price : c.mx;
  p.uid = win.uid;
  p.bid = price;
  return { leader: win.uid, price };
}

// Place an explicit bid or set a max, then run the proxies.
// kind: 'bid' (I am standing at this amount) | 'max' (bid for me up to this)
function applyOpenBid(gd, uid, key, amount, kind) {
  const o = ensureOpen(gd), p = o.players[key];
  const now = Date.now();
  if (!p) return { ok: false, err: 'That player is not in the pool.' };
  if (p.closed) return { ok: false, err: 'Bidding on that player has closed.' };

  const inc       = bidIncrement(o.cfg, p.bid || p.base);
  const nextValid = p.uid ? p.bid + inc : p.base;
  const prevUid   = p.uid || null, prevPrice = p.bid || 0;

  if (p.uid === uid && kind === 'bid' && amount <= p.bid) {
    return { ok: false, err: `You already lead at **${formatAmount(p.bid)}** — bid **${formatAmount(nextValid)}** or more to raise yourself.` };
  }
  if (amount < nextValid) {
    return { ok: false, err: `Minimum ${kind === 'max' ? 'max' : 'bid'} is **${formatAmount(nextValid)}** — current ${p.uid ? `bid **${formatAmount(p.bid)}**` : `base **${formatAmount(p.base)}**`}, increment **${formatAmount(inc)}**.` };
  }
  const room = openSpendRoom(gd, uid, key);
  if (amount > room) {
    return { ok: false, err: `Over your available balance for this player (**${formatAmount(room)}**). Your leading bids lock funds — get outbid somewhere and it frees up.` };
  }

  if (kind === 'max') {
    o.autobids[key] = o.autobids[key] || {};
    o.autobids[key][uid] = amount;
  } else {
    p.fl = p.fl || {};
    p.fl[uid] = Math.max(p.fl[uid] || 0, amount);
  }

  const res = resolveOpenProxies(gd, key);
  p.at    = now;
  p.count = (p.count || 0) + 1;
  p.hist  = [histEntry(p.uid, p.bid, now), ...(p.hist || [])].slice(0, OPEN_HIST);
  o.feed  = [{ k: key, u: p.uid, a: p.bid, t: now }, ...(o.feed || [])].slice(0, OPEN_FEED);

  // Anti-snipe: a bid in the dying minutes pushes that player's close back, so
  // nobody wins a 3-day auction by turning up in the last second.
  const ext = (o.cfg.antiSnipe || 0) * 60000;
  let extended = false;
  if (ext && p.closesAt && p.closesAt - now < ext) {
    p.closesAt = now + ext;
    p.sniped = (p.sniped || 0) + 1;
    extended = true;
  }

  scheduleAuctionSave();
  return {
    ok: true, leader: res.leader, price: p.bid, prevUid, prevPrice, extended,
    youLead: res.leader === uid,
    inc: bidIncrement(o.cfg, p.bid)
  };
}

// ── DM alerts (queued so a busy minute can't hit the DM rate limit) ─────────
const openDmQueue = [];
let openDmRunning = false;

function openDm(o, userId, payload) {
  if (!o.cfg.dm || (o.noDm && o.noDm[userId])) return;
  openDmQueue.push({ userId, payload });
  runOpenDmQueue();
}

async function runOpenDmQueue() {
  if (openDmRunning) return;
  openDmRunning = true;
  while (openDmQueue.length) {
    const { userId, payload } = openDmQueue.shift();
    try {
      const u = await client.users.fetch(userId);
      await u.send(payload);
    } catch (_) {}                                   // DMs closed — nothing to do
    await new Promise(r => setTimeout(r, 400));
  }
  openDmRunning = false;
}

async function openAnnounce(guild, gd, payload) {
  const o = ensureOpen(gd);
  const chId = o.channelId || gd.logChannel;
  if (!chId) return;
  const ch = guild.channels.cache.get(chId);
  if (ch) await ch.send(typeof payload === 'string' ? { content: payload } : payload).catch(() => {});
}

// ── Private max bids ───────────────────────────────────────────────────────
// A ceiling typed in the channel is a ceiling everyone can read. `max <player>`
// with no number asks for it in DMs instead, and only the resulting public bid
// ever reaches the channel.
async function startPrivateMax(message, gd, target, pfx) {
  const o = ensureOpen(gd);
  const p = target.p;
  const minimum = p.uid ? p.bid + bidIncrement(o.cfg, p.bid) : p.base;
  try {
    await message.author.send({ embeds: [new EmbedBuilder()
      .setTitle(`🤖 Max bid — ${p.n}`)
      .setColor(0x00B2FF)
      .setDescription(`Reply here with your ceiling for **${p.n}** in **${message.guild.name}**.\nI bid the minimum needed to keep you in front, up to that number. Nobody else ever sees it.`)
      .addFields(
        { name: 'Current bid', value: p.uid ? formatAmount(p.bid) : `*no bids · base ${formatAmount(p.base)}*`, inline: true },
        { name: 'Minimum',     value: formatAmount(minimum), inline: true }
      )
      .setFooter({ text: 'Just the amount — 12cr, 1.5cr, 40L. Say cancel to drop it. Expires in 10 minutes.' })] });
  } catch (_) {
    await message.channel.send(`❌ I can't DM you — allow direct messages from server members, or use \`${pfx}max ${p.n} <amount>\` here.`);
    return;
  }
  pendingOpenMax.set(message.author.id, {
    guildId: message.guild.id, key: target.key, name: p.n, expiresAt: Date.now() + OPEN_MAX_DM_MS
  });
  await message.channel.send(`📬 <@${message.author.id}> — check your DMs to set your max on **${p.n}** privately.`);
}

// The DM reply landed: place the max, then tell the channel only what is public.
async function applyPrivateMax(uid, pending, amount, dmMessage) {
  const guild = client.guilds.cache.get(pending.guildId);
  if (!guild) { pendingOpenMax.delete(uid); await dmMessage.channel.send('❌ That server is not available any more.'); return; }
  const gd = getGuildData(pending.guildId);
  const o  = ensureOpen(gd);
  const p  = o.players[pending.key];
  if (!o.active || o.paused || !p || p.closed) {
    pendingOpenMax.delete(uid);
    await dmMessage.channel.send('❌ Bidding on that player is not open any more.');
    return;
  }

  const before = p.uid, beforePrice = p.bid || 0;
  const res = applyOpenBid(gd, uid, pending.key, amount, 'max');
  if (!res.ok) { await dmMessage.channel.send(`❌ ${res.err}\nSend another amount, or \`cancel\`.`); return; }
  pendingOpenMax.delete(uid);

  await dmMessage.channel.send({ embeds: [new EmbedBuilder()
    .setTitle(res.youLead ? `✅ You lead — ${p.n}` : `❌ Outbid already — ${p.n}`)
    .setColor(res.youLead ? 0x57F287 : 0xED4245)
    .setDescription(`Your max of **${formatAmount(amount)}** is set. Current bid is **${formatAmount(res.price)}** to **${teamOnly(gd, guild, res.leader)}**.`)
    .addFields(
      { name: 'Available', value: formatAmount(openAvailable(gd, uid)), inline: true },
      { name: 'Closes',    value: ts(p.closesAt, 'R'), inline: true }
    )
    .setFooter({ text: 'Nothing in the server shows your ceiling.' })] });

  // The price and the leader are public either way — the ceiling is not.
  if (p.bid !== beforePrice || p.uid !== before) {
    await openAnnounce(guild, gd, `💼 A max bid moved **${p.n}** — now **${formatAmount(p.bid)}** to **${teamOnly(gd, guild, p.uid)}**.`);
  }
  if (before && before !== res.leader && before !== uid) {
    openDm(o, before, {
      embeds: [new EmbedBuilder().setTitle('❌ You have been outbid').setColor(0xED4245)
        .setDescription(`**${p.n}** in **${guild.name}** is now **${formatAmount(res.price)}** to **${teamOnly(gd, guild, res.leader)}**.`)
        .addFields(
          { name: 'Your bid was',   value: formatAmount(res.prevPrice), inline: true },
          { name: 'Next valid bid', value: formatAmount(res.price + res.inc), inline: true },
          { name: 'Freed up',       value: `${formatAmount(openAvailable(gd, before))} available again`, inline: false }
        )]
    });
  }
}

// ── Settlement ─────────────────────────────────────────────────────────────
// Every player is awarded in one pass at the end. A team that leads more players
// than it can fit or fund keeps them in priority order; whatever it releases
// cascades to the next highest bidder, who may in turn have to release someone —
// so this loops until nothing changes.
// onlyKeys limits the pass to one set — the rest of the pool keeps bidding.
function computeOpenSettlement(gd, onlyKeys) {
  const o = ensureOpen(gd), cfg = o.cfg;
  const stacks = {};
  for (const [k, p] of Object.entries(o.players)) {
    if (p.settled) continue;                      // pre-owned, or won in an earlier set
    if (onlyKeys && !onlyKeys.has(k)) continue;
    const st = Object.entries(p.best || {}).map(([uid, a]) => ({ uid, a })).sort((x, y) => y.a - x.a);
    if (st.length) stacks[k] = st;
  }
  const maxS = cfg.maxSquad || 0;
  const released = [];
  let changed = true, guard = 0;

  while (changed && guard++ < 5000) {
    changed = false;
    const lead = {};
    for (const [k, st] of Object.entries(stacks)) {
      if (!st.length) continue;
      (lead[st[0].uid] = lead[st[0].uid] || []).push({ k, a: st[0].a });
    }
    for (const [uid, list] of Object.entries(lead)) {
      const purse = gd.purses[uid] || 0;
      let slots = openSlotsUsed(gd, uid), spend = 0;
      sortByOpenPriority(o, uid, list);
      for (const it of list) {
        const hasRoom = !maxS || slots < maxS;
        const hasCash = spend + it.a <= purse;
        if (hasRoom && hasCash) { slots++; spend += it.a; continue; }
        stacks[it.k].shift();                       // released — next bidder inherits
        released.push({ k: it.k, uid, a: it.a, why: !hasRoom ? 'slots' : 'funds' });
        changed = true;
      }
    }
  }

  const awards = [], unsold = [];
  for (const [k, p] of Object.entries(o.players)) {
    if (p.settled) continue;    // already owned before this auction started
    if (onlyKeys && !onlyKeys.has(k)) continue;
    const st = stacks[k];
    if (st && st.length) awards.push({ k, n: p.n, uid: st[0].uid, a: st[0].a });
    else unsold.push({ k, n: p.n, base: p.base });
  }
  return { awards, unsold, released };
}

// Apply the settlement: purses are debited and players land in the same squads
// the rest of the bot already uses, so squad/trade/delete all keep working.
// opts.onlyKeys settles just those players (one set); opts.label names the set.
async function settleOpenAuction(guild, gd, byTag, opts = {}) {
  const o = ensureOpen(gd);
  const onlyKeys = opts.onlyKeys || null;
  const label    = opts.label || null;
  const { awards, unsold, released } = computeOpenSettlement(gd, onlyKeys);
  const byTeam = {};

  for (const a of awards) {
    gd.purses[a.uid] = Math.max(0, (gd.purses[a.uid] || 0) - a.a);
    gd.squads[a.uid] = gd.squads[a.uid] || [];
    gd.squads[a.uid].push({ player: a.n, price: a.a });
    (byTeam[a.uid] = byTeam[a.uid] || []).push(a);
    const p = o.players[a.k];
    if (p) { p.closed = true; p.settled = true; }
  }
  for (const u of unsold) { const p = o.players[u.k]; if (p) { p.closed = true; p.settled = true; } }

  const now   = Date.now();
  const spend = awards.reduce((s, a) => s + a.a, 0);
  if (!onlyKeys) { o.active = false; o.settledAt = now; }
  // Bid bookkeeping is dead weight once a player is awarded, and on a big pool
  // it is most of the saved payload. Delete rather than blank the fields — empty
  // objects still cost bytes on every save, and every reader already guards for
  // them being missing. The final price and winner stay for display.
  const done = onlyKeys
    ? [...onlyKeys].map(k => o.players[k]).filter(Boolean)
    : Object.values(o.players);
  for (const p of done) {
    delete p.fl; delete p.best; delete p.hist;
    delete p.at; delete p.count; delete p.sniped; delete p.closesAt;
  }
  if (onlyKeys) {
    for (const k of onlyKeys) delete o.autobids[k];
    o.feed = (o.feed || []).filter(f => !onlyKeys.has(f.k));
  } else {
    o.autobids = {};
    o.feed = [];
  }
  // Settling set by set means results accumulate across several passes.
  const prev = (onlyKeys && o.results) ? o.results : null;
  o.results  = {
    at: now,
    awards: [...(prev ? prev.awards : []), ...awards.map(a => ({ k: a.k, n: a.n, uid: a.uid, a: a.a }))],
    unsold: [...(prev ? prev.unsold : []), ...unsold.map(u => u.n)],
    released: (prev ? prev.released : 0) + released.length,
    spend: (prev ? prev.spend : 0) + spend
  };
  scheduleAuctionSave();
  await flushAuction();

  const teamLines = Object.entries(byTeam)
    .sort((x, y) => y[1].reduce((s, a) => s + a.a, 0) - x[1].reduce((s, a) => s + a.a, 0))
    .map(([uid, list]) => `**${teamOnly(gd, guild, uid)}** — ${list.length} player(s), ${formatAmount(list.reduce((s, a) => s + a.a, 0))} spent · ${formatAmount(gd.purses[uid] || 0)} left`);

  const embed = new EmbedBuilder()
    .setTitle(label ? `🏁 Set Sold — ${label}` : '🏁 Open Auction Settled')
    .setColor(0xFFD700)
    .setDescription(
      `**${awards.length}** players sold for **${formatAmount(spend)}**${label ? ` in **${label}**` : ' total'}.\n` +
      `**${unsold.length}** went unsold${released.length ? ` · **${released.length}** bid(s) released and cascaded to the next bidder` : ''}.` +
      (label ? `\nThe rest of the pool is still open — that money has now left the winners' purses.` : '')
    )
    .addFields({ name: 'Squads', value: (teamLines.join('\n') || '*nobody won anything*').slice(0, 1024) })
    .setFooter({ text: byTag ? `Settled by ${byTag}` : 'Auction clock ran out' })
    .setTimestamp();

  await openAnnounce(guild, gd, { embeds: [embed] });

  // Everyone gets their own result sheet.
  for (const [uid, list] of Object.entries(byTeam)) {
    sortByOpenPriority(o, uid, list.map(a => ({ k: a.k, a: a.a })));
    openDm(o, uid, {
      embeds: [new EmbedBuilder().setTitle(`🏁 ${guild.name} — your open auction results`).setColor(0x57F287)
        .setDescription(list.map(a => `• **${a.n}** — ${formatAmount(a.a)}`).join('\n').slice(0, 4000))
        .setFooter({ text: `${list.length} player(s) · ${formatAmount(list.reduce((s, a) => s + a.a, 0))} spent · ${formatAmount(gd.purses[uid] || 0)} left` })]
    });
  }
  // Tell anyone who had a lead pulled out from under them why.
  const lost = {};
  for (const r of released) (lost[r.uid] = lost[r.uid] || []).push(r);
  for (const [uid, list] of Object.entries(lost)) {
    const slots = list.filter(r => r.why === 'slots').length;
    openDm(o, uid, `⚠️ **${guild.name}** — ${list.length} of your leading bid(s) were released at settlement (${slots} over your squad limit, ${list.length - slots} over your purse): ${list.map(r => (o.players[r.k] || {}).n).filter(Boolean).slice(0, 20).join(', ')}`.slice(0, 1900));
  }
  return { awards, unsold, released };
}

// ── Clock ──────────────────────────────────────────────────────────────────
// One minute tick per guild: close players whose time is up, warn about the
// deadline, and settle once everything has closed.
async function openTickGuild(guild, gd) {
  const o = ensureOpen(gd);
  const now = Date.now();
  if (!o.active || o.paused) return;

  const justClosed = [];
  for (const [k, p] of Object.entries(o.players)) {
    if (p.closed || !p.closesAt || p.closesAt > now) continue;
    p.closed = true;
    justClosed.push({ k, p });
  }

  if (justClosed.length) {
    const sold = justClosed.filter(x => x.p.uid);
    const embed = new EmbedBuilder().setTitle(`🔒 ${justClosed.length} player(s) closed`).setColor(0x9B59B6)
      .setDescription(sold.slice(0, 25).map(x => `• **${x.p.n}** — ${formatAmount(x.p.bid)} to **${teamOnly(gd, guild, x.p.uid)}**`).join('\n').slice(0, 4000) || '*no bids on any of them*')
      .setFooter({ text: `${sold.length} with bids · ${justClosed.length - sold.length} without · final results at settlement` })
      .setTimestamp();
    await openAnnounce(guild, gd, { embeds: [embed] });

    const perLeader = {};
    for (const x of sold) (perLeader[x.p.uid] = perLeader[x.p.uid] || []).push(x);
    for (const [uid, list] of Object.entries(perLeader)) {
      openDm(o, uid, `🔒 **${guild.name}** — bidding closed on ${list.length} player(s) you lead: ${list.map(x => `${x.p.n} (${formatAmount(x.p.bid)})`).slice(0, 25).join(', ')}\nThey're yours unless your squad limit or purse forces a release at settlement — check \`${getOpenPrefix(guild.id)}priority\`.`.slice(0, 1900));
    }
    scheduleAuctionSave();
  }

  // Deadline warnings
  const left = o.endsAt - now;
  for (const mark of [86400000, 21600000, 3600000, 600000]) {
    if (left > 0 && left <= mark && !o.warned[mark]) {
      o.warned[mark] = true;
      scheduleAuctionSave();
      await openAnnounce(guild, gd, { embeds: [new EmbedBuilder().setColor(0xFFA500)
        .setTitle(`⏳ ${fmtLeft(mark)} left in the open auction`)
        .setDescription(`Closes ${ts(o.endsAt, 'R')}. Late bids extend that player by **${o.cfg.antiSnipe}m**, so don't count on sniping.`)] });
      break;
    }
  }

  // Closing-soon alerts for watched players
  for (const [uid, keys] of Object.entries(o.watch || {})) {
    const soon = (keys || []).map(k => o.players[k]).filter(p => p && !p.closed && p.closesAt - now > 0 && p.closesAt - now <= 1800000);
    const flag = o.warned[`w${uid}`] || 0;
    if (soon.length && flag < now - 1800000) {
      o.warned[`w${uid}`] = now;
      openDm(o, uid, `👀 **${guild.name}** — closing within 30m on your watchlist: ${soon.map(p => `**${p.n}** (${formatAmount(p.bid || p.base)}${p.uid === uid ? ', you lead' : ''})`).slice(0, 15).join(', ')}`.slice(0, 1900));
    }
  }

  const anyOpen = Object.values(o.players).some(p => !p.closed);
  if (!anyOpen && now >= o.endsAt) await settleOpenAuction(guild, gd, null);
}

async function openTick() {
  for (const [gid, gd] of Object.entries(auctionData.guilds || {})) {
    if (!gd || !gd.open || !gd.open.active) continue;
    const guild = client.guilds.cache.get(gid);
    if (!guild) continue;
    try { await openTickGuild(guild, gd); }
    catch (e) { console.error(`Open auction tick error (${gid}):`, e.message); }
  }
}

function startOpenTicker() {
  setInterval(() => { openTick().catch(e => console.error('Open tick error:', e.message)); }, 60_000);
  console.log('⏱️  Open auction clock started (1 min tick)');
}

// ── Pool parsing ───────────────────────────────────────────────────────────
// Understands three shapes:
//   • the CricVerse `cv pl` export — "── 👑 LEGENDS (18) ──" tier rows followed
//     by one name per line; the tier becomes the set (cleaned to just "LEGENDS")
//   • the `cv pl` RATINGS table — "  1  Don Bradman  99  20  99  Batter  Anchor",
//     from which the name, OVR and role are pulled out
//   • plain lists — "Name", "Name 2m", comma-separated, with "Set: X" headers
// Banner/decoration rows and the Generated footer are ignored in all three.
function parseOpenPool(text, defaultBase) {
  const lines = String(text || '').split(/\r?\n/);
  // The ratings table is columnar, so it has to be read a row at a time rather
  // than word-split — otherwise every stat lands in the player's name.
  const isRatings = lines.some(l => /^\s*#?\s*NAME\s+BAT\s+BOWL\s+OVR\b/i.test(l));
  const out = [];
  let set = null;

  // "👑  LEGENDS (18)" -> "LEGENDS"; pure decoration -> null.
  const cleanSet = (raw) => {
    let s = String(raw || '').replace(/\(\s*\d+\s*\)\s*$/, '').trim();
    s = s.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '').trim();
    return s || null;
  };

  for (let line of lines) {
    if (!line.trim()) continue;
    if (/player database|generated:/i.test(line)) continue;

    if (isRatings) {
      if (/^\s*#?\s*NAME\s+BAT\s+BOWL/i.test(line)) continue;      // column header
      const m = line.match(/^\s*\d+\s+(.+?)\s{2,}(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/);
      if (!m) continue;                                            // banner or divider
      const name = m[1].replace(/\s+/g, ' ').trim();
      if (!name || name.length > 80) continue;
      out.push({ name, base: defaultBase, set: null, ovr: parseInt(m[4], 10), role: m[5] });
      continue;
    }

    // Tier / set header. A row that is nothing but decoration cleans to null and
    // is simply skipped, so it can never become a set name.
    const head = line.match(/^\s*(?:set\s*[:\-]\s*(.+)|[─═]{2,}\s*(.*?)\s*[─═]{2,})\s*$/i);
    if (head) {
      const s = cleanSet(head[1] || head[2]);
      if (s) set = s;
      continue;
    }
    if (/^[═─=—_*#·\s-]+$/.test(line)) continue;                   // any other divider

    for (const part of line.split(',')) {
      const entry = part.replace(/\s+/g, ' ').trim();
      if (!entry) continue;
      const words = entry.split(' ');
      let base = null, name = entry;
      if (words.length > 1) {
        const maybe = parseMoney(words[words.length - 1]);
        if (maybe !== null && maybe > 0) { base = maybe; name = words.slice(0, -1).join(' '); }
      }
      name = name.replace(/^\d+[.)]\s*/, '').trim();   // strip "12." list numbering
      if (!name || name.length > 80) continue;
      out.push({ name, base: base || defaultBase, set });
    }
  }
  return out;
}

// Optional tiered base prices: stars shouldn't open at the same price as filler.
// Uses OVR when the ratings list supplied it, otherwise the tier's position in
// the file (CricVerse lists them best-first).
const OPEN_TIER_MULT = [10, 6, 4, 2.5, 1.5, 1];

function applyTieredBases(items, defaultBase) {
  const tiers = [];
  for (const it of items) if (it.set && !tiers.includes(it.set)) tiers.push(it.set);
  const bands = {};
  for (const it of items) {
    let mult;
    if (it.ovr) {
      mult = it.ovr >= 90 ? 10 : it.ovr >= 85 ? 6 : it.ovr >= 80 ? 4 : it.ovr >= 75 ? 2.5 : it.ovr >= 70 ? 1.5 : 1;
    } else {
      const i = tiers.indexOf(it.set);
      mult = (i === -1 || OPEN_TIER_MULT[i] === undefined) ? 1 : OPEN_TIER_MULT[i];
    }
    it.base = Math.round(defaultBase * mult);
    const label = it.set || (it.ovr ? `OVR ${it.ovr >= 90 ? '90+' : it.ovr >= 85 ? '85-89' : it.ovr >= 80 ? '80-84' : it.ovr >= 75 ? '75-79' : it.ovr >= 70 ? '70-74' : '<70'}` : 'Ungrouped');
    bands[label] = it.base;
  }
  return bands;
}

// ── Embeds ─────────────────────────────────────────────────────────────────
function openPlayerCard(gd, guild, key, viewerId, pfx) {
  const o = ensureOpen(gd), p = o.players[key];
  const now = Date.now();
  const mine = (p.best && p.best[viewerId]) || 0;
  const leading = p.uid === viewerId;
  const myMax = (o.autobids[key] || {})[viewerId] || 0;
  const inc = bidIncrement(o.cfg, p.bid || p.base);

  const embed = new EmbedBuilder()
    .setTitle(`🔎 ${p.n}`)
    .setColor(p.closed ? 0x95A5A6 : leading ? 0x57F287 : mine ? 0xED4245 : 0x00B2FF)
    .addFields(
      { name: 'Base',        value: formatAmount(p.base), inline: true },
      { name: 'Current bid', value: p.uid ? `**${formatAmount(p.bid)}**` : '*no bids*', inline: true },
      { name: 'Leader',      value: p.uid ? teamOnly(gd, guild, p.uid) : '—', inline: true },
      { name: 'Next bid',    value: p.closed ? '*closed*' : formatAmount(p.uid ? p.bid + inc : p.base), inline: true },
      { name: 'Bids',        value: String(p.count || 0), inline: true },
      { name: 'Closes',      value: p.closed ? '*closed*' : p.closesAt ? ts(p.closesAt, 'R') : '*not started*', inline: true }
    );
  if (p.set) embed.addFields({ name: 'Set', value: p.set, inline: true });
  if (p.ovr) embed.addFields({ name: 'OVR', value: `${p.ovr}${p.role ? ` · ${String(p.role).replace(/_/g, ' ')}` : ''}`, inline: true });
  if (p.sniped) embed.addFields({ name: 'Extended', value: `${p.sniped}× by late bids`, inline: true });

  let you = leading ? `✅ **You lead** at ${formatAmount(p.bid)}` : mine ? `❌ **Outbid** — your ceiling was ${formatAmount(mine)}` : '—';
  if (myMax) you += `\n🤖 Your max: **${formatAmount(myMax)}**`;
  embed.addFields({ name: 'You', value: you, inline: false });

  const hist = (p.hist || []).slice(0, 6)
    .map(h => `• ${formatAmount(h[1])} — ${teamOnly(gd, guild, h[0])} ${ts(h[2] * 1000, 'R')}`).join('\n');
  if (hist) embed.addFields({ name: 'Recent activity', value: hist.slice(0, 1024), inline: false });
  embed.setFooter({ text: `${pfx}bn ${p.n} · ${pfx}bid ${p.n} <amount> · ${pfx}max ${p.n} (private) · ${pfx}watch ${p.n}` });
  return embed;
}

async function openPaginate(message, pages) {
  if (!pages.length) return;
  let page = 0;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_prev').setLabel('◀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('open_next').setLabel('▶').setStyle(ButtonStyle.Secondary)
  );
  const sent = await message.channel.send({ embeds: [pages[0]], components: pages.length > 1 ? [row] : [] });
  if (pages.length < 2) return;
  const col = sent.createMessageComponentCollector({ filter: i => i.user.id === message.author.id, time: 120_000 });
  col.on('collect', async i => {
    page = i.customId === 'open_next' ? (page + 1) % pages.length : (page - 1 + pages.length) % pages.length;
    await i.update({ embeds: [pages[page]], components: [row] }).catch(() => {});
  });
  col.on('end', () => { sent.edit({ components: [] }).catch(() => {}); });
}

function openHelpPage1(pfx) {
  return new EmbedBuilder()
    .setTitle('💸 Open Auction — Bidding')
    .setColor(0x00B2FF)
    .setDescription(`Prefix \`${pfx}\` · every player is open at once for days. Only the bids you're **leading** lock money — get outbid and it frees up instantly.`)
    .addFields(
      { name: `\`${pfx}bid <player> <amount>\` / \`${pfx}b\``, value: 'Bid. Short names work ("kohli"). Amounts take `5cr`, `40L`, `500k`.', inline: false },
      { name: `\`${pfx}bn <player>\` / \`${pfx}b next <player>\``, value: 'Bid the next valid step without typing a price — the fastest way to answer someone.', inline: false },
      { name: `\`${pfx}max <player>\``, value: 'Proxy bid, asked for **in your DMs** so the channel never sees your ceiling. I bid the minimum needed for you, up to it, and re-bid when someone outbids you. `max <player> <amount>` still works inline if you don\'t mind people seeing it; `max <player> clear` cancels.', inline: false },
      { name: `\`${pfx}search <player>\` / \`${pfx}s\``, value: 'Player card — current bid, leader, next valid bid, close time, recent bid history and where you stand.', inline: false },
      { name: `\`${pfx}mybids\` / \`${pfx}mb\``, value: 'Everything you lead, everything you were **outbid** on, your maxes and your balance — sent to your DMs (`mybids here` posts it in channel).', inline: false },
      { name: `\`${pfx}priority\` / \`${pfx}pr\``, value: 'Your keep-order for when you lead more players than you have slots or money for. `pr <name1, name2…>` sets it, `pr top <player>` promotes one, `pr clear` resets.', inline: false },
      { name: `\`${pfx}bal\``, value: 'Purse, committed, available, slots used.', inline: true },
      { name: `\`${pfx}squad [@user]\``, value: 'Squad + provisional wins.', inline: true },
      { name: `\`${pfx}team <name>\``, value: 'Name your team.', inline: true },
      { name: `\`${pfx}watch <player>\``, value: 'Watchlist + closing alerts.', inline: true },
      { name: `\`${pfx}players [open|mine|nobids|set]\``, value: 'Browse the pool with live prices.', inline: true },
      { name: `\`${pfx}sets\``, value: 'Every set, what is open, what sold.', inline: true },
      { name: `\`${pfx}hot\``, value: 'Most contested players.', inline: true },
      { name: `\`${pfx}feed\``, value: 'Latest bids server-wide.', inline: true },
      { name: `\`${pfx}status\``, value: 'Clock, pool progress, top spenders.', inline: true },
      { name: `\`${pfx}lb\``, value: 'Spending leaderboard.', inline: true },
      { name: `\`${pfx}notify off\``, value: 'Stop outbid DMs.', inline: true },
      { name: `\`${pfx}results\` · \`${pfx}unsold\``, value: 'After settlement — who got whom, and who nobody wanted.', inline: false }
    )
    .setFooter({ text: `Page 1/2 — ${pfx}ohelp2 for host commands` });
}

function openHelpPage2(pfx) {
  return new EmbedBuilder()
    .setTitle('💸 Open Auction — Host Commands')
    .setColor(0xFF6600)
    .setDescription(`Prefix \`${pfx}\` — Admin or Auctioneer role required.`)
    .addFields(
      { name: `\`${pfx}openpool <paste or .txt>\``, value: 'Load the player list. Reads the CricVerse `cv pl` export as-is (tiers become sets) and the ratings table (keeps OVR + role), plus plain `Name` / `Name 2m` / comma-separated lists with `Set: X` headers. `openpool clear` wipes it, plain `openpool` shows status.', inline: false },
      { name: `\`${pfx}openpool tiered <list>\``, value: 'Same, but base prices scale by tier (or OVR): top tier ×10 down to ×1 off the default base — so Legends don\'t open at the same price as Iron.', inline: false },
      { name: `\`${pfx}openstart [3d|72h]\``, value: 'Open bidding on everything for that long (default 3 days).', inline: false },
      { name: `\`${pfx}openpurse @user <amt>\``, value: 'Set a purse — `openpurse all <amt>` gives everyone in the auction the same one.', inline: false },
      { name: `\`${pfx}ocfg <key> <value>\``, value: '`maxsquad` (30) · `inc` min raise · `ladder on|off` · `antisnipe` mins · `overcommit on|off` · `base` default base · `dm on|off`. Plain `ocfg` shows all.', inline: false },
      { name: `\`${pfx}openextend <hours>\``, value: 'Push the deadline back for every player still open.', inline: true },
      { name: `\`${pfx}openpause\` / \`${pfx}openresume\``, value: 'Freeze/unfreeze bidding without losing anything.', inline: true },
      { name: `\`${pfx}closeset <set>\``, value: 'Sell one set now and leave the rest of the pool running. Preview first, then `closeset <set> confirm`. Winners pay immediately, so their leads elsewhere may not survive.', inline: false },
      { name: `\`${pfx}openend confirm\``, value: 'Close everything and settle right now.', inline: true },
      { name: `\`${pfx}openlog #channel\``, value: 'Where closes, warnings and results are posted.', inline: true },
      { name: `\`${pfx}openreset confirm\``, value: 'Wipe the open auction (pool, bids, results). `full` also clears squads bought here.', inline: true },
      { name: `\`${pfx}setopenprefix <p>\``, value: 'Change this mode\'s prefix for the server.', inline: true },
      { name: 'How settlement works', value: 'Nothing is awarded until the clock ends. Then every team keeps its leading bids in **priority order** while slots and purse allow; anything released cascades to the next highest bidder, who may release in turn — repeated until stable. Purses are debited and players land in the normal squads.', inline: false }
    )
    .setFooter({ text: `Page 2/2 — ${pfx}ohelp for bidding` });
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
    GatewayIntentBits.DirectMessages,   // setorder replies arrive in DMs
  ],
  partials: [Partials.Channel]          // DM channels are uncached — without this, DM messageCreate never fires
});

// ══════════════════════════════════════════════════════════════════════════════
//  READY
// ══════════════════════════════════════════════════════════════════════════════
client.once('ready', async () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);

  if (!JSONBIN_KEY) console.warn('⚠️  JSONBIN_KEY is not set — nothing will persist to JSONBin!');

  // Load cg bin first (it also stores the auction bin id as a durable pointer)
  if (cgdropBinId) {
    const loaded = await loadBin(cgdropBinId, 'cgdrop');
    if (loaded) cgData = { ...cgData, ...loaded };
  }

  // Prefer the env var (Render): it's the durable source of truth and means we
  // only ever UPDATE that bin, never create a new one.
  if (AUCTION_BIN_ID_ENV) {
    console.log(`✅ Using AUCTION_BIN_ID from env: ${AUCTION_BIN_ID_ENV}`);
  } else if (!auctionBinId && cgData.auctionBinId) {
    // Fallback: recover from the cg bin if env didn't provide it.
    auctionBinId = cgData.auctionBinId;
    console.log(`🔗 Recovered auction bin id from cg bin: ${auctionBinId}`);
  }

  // Auction: load BOTH the JSONBin copy and the local file, then keep whichever
  // was saved most recently. This is safe on both ephemeral hosts (local wiped →
  // use bin) and persistent disks (local fresher → use local, never overwritten).
  let binAuction = null;
  if (auctionBinId) {
    const loaded = await loadBin(auctionBinId, 'auction');
    if (loaded && Object.keys(loaded).length) binAuction = loaded;
  }
  const localAuction = loadLocalAuction();
  let chosen = null, src = null;
  if (binAuction && localAuction) {
    if ((binAuction._savedAt || 0) >= (localAuction._savedAt || 0)) { chosen = binAuction; src = 'JSONBin'; }
    else { chosen = localAuction; src = 'local file'; }
  } else if (binAuction) { chosen = binAuction; src = 'JSONBin'; }
  else if (localAuction) { chosen = localAuction; src = 'local file'; }

  if (chosen) {
    auctionData = { ...auctionData, ...chosen };
    saveLocalAuction(); // re-sync local copy
    console.log(`📂 Auction loaded from ${src}${chosen._savedAt ? ` (saved ${new Date(chosen._savedAt).toISOString()})` : ''}`);
    if (src === 'local file' && auctionBinId) { auctionDirty = true; await flushAuction(); } // push the fresher local copy up
  } else if (!auctionBinId) {
    console.log('🆕 No auction data yet — a bin will be created and remembered on first save.');
  }

  // ── Bin id summary — copy these into env so no new bins are ever created ──
  console.log('──────────────────────────────────────────────');
  console.log(`📌 CGDROP_BIN_ID = ${cgdropBinId || '(not set — set this in env!)'}`);
  console.log(`📌 AUCTION_BIN_ID = ${auctionBinId || '(none yet — will be created on first save)'}`);
  if (!AUCTION_BIN_ID_ENV && auctionBinId) console.log(`👉 Add to env to make permanent:  AUCTION_BIN_ID=${auctionBinId}`);
  if (!cgdropBinId) console.warn('⚠️  No cgdrop bin configured — the auction bin id cannot be remembered across restarts. Set CGDROP_BIN_ID (or AUCTION_BIN_ID) in env!');
  console.log('──────────────────────────────────────────────');

  await restoreReminders();
  startFlushInterval();
  startOpenTicker();
  openTick().catch(e => console.error('Open tick error:', e.message));   // catch up on anything that closed while we were down

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
    new SlashCommandBuilder()
      .setName('setopenprefix')
      .setDescription('Change the open auction command prefix for this server')
      .addStringOption(o => o.setName('prefix').setDescription('New prefix (e.g. $)').setRequired(true)),
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

    gd.auction = { player: playerName, base, current_bid: base, difference: diff, set: null,
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
    if (gd.auctionTimer) embed.addFields({ name: '⏱️ Timer', value: `${gd.auctionTimer}s — no bid before 0 = UNSOLD; each bid resets it.`, inline: false });
    await interaction.reply({ embeds: [embed] });
    if (gd.auctionTimer && interaction.channel) startAuctionTimer(interaction.guild, interaction.channel, gd);
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

  if (interaction.commandName === 'setopenprefix') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
      return interaction.reply({ content: '❌ Admin only!', ephemeral: true });
    const np = interaction.options.getString('prefix');
    auctionData.openPrefixes = auctionData.openPrefixes || {};
    auctionData.openPrefixes[guildId] = np;
    scheduleAuctionSave();
    return interaction.reply({ content: `✅ Open auction prefix changed to \`${np}\` — try \`${np}ohelp\``, ephemeral: true });
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

  // ── DM replies for a private max bid (ceiling never touches the channel) ─
  if (!message.guild && pendingOpenMax.has(userId)) {
    const pending = pendingOpenMax.get(userId);
    if (Date.now() > pending.expiresAt) {
      pendingOpenMax.delete(userId);
      await message.channel.send('⌛ That max bid request expired — run the command in the server again.');
      return;
    }
    if (/^(cancel|stop|no|nvm)$/i.test(content)) {
      pendingOpenMax.delete(userId);
      await message.channel.send(`🚫 Dropped — no max set on **${pending.name}**.`);
      return;
    }
    const amt = parseMoney(content.split(/\s+/)[0]);
    if (amt === null || amt <= 0) {
      await message.channel.send('❌ Send just the amount — `12cr`, `1.5cr`, `40L`. Or `cancel`.');
      return;
    }
    await applyPrivateMax(userId, pending, amt, message);
    return;
  }

  // ── DM replies for setorder (draft order arrives privately) ─────────────
  if (!message.guild && pendingSetorders.has(userId)) {
    const pending = pendingSetorders.get(userId);
    if (Date.now() > pending.expiresAt) {
      pendingSetorders.delete(userId);
      await message.channel.send('⌛ That setorder request expired — run `setorder` in the server again.');
      return;
    }
    let text = content;
    const att = message.attachments.first();
    if (att) {
      if (att.size > 2 * 1024 * 1024) { await message.channel.send('❌ File too big (max 2 MB).'); return; }
      try { text = await (await fetch(att.url)).text(); }
      catch (_) { await message.channel.send('❌ Could not read the attachment — try again.'); return; }
    }
    const gdDm = getGuildData(pending.guildId);
    const { cleaned, dropped } = saveDraftOrder(gdDm, userId, text);
    if (cleaned.length) pendingSetorders.delete(userId);   // otherwise keep listening so they can retry
    await message.channel.send(draftOrderReply(cleaned, dropped));
    return;
  }
  // Any other DM: ignore — every command below assumes a guild
  if (!message.guild) return;

  // ── Determine which prefix was used ──────────────────────────────────────
  const openPfx = guildId ? getOpenPrefix(guildId) : DEFAULT_OPEN_PREFIX;
  const usesCg   = content.startsWith(cgPfx);
  const usesOpen = content.startsWith(openPfx);
  // Open auction wins a prefix clash — the live auction has the older, shorter one.
  const usesAuc  = content.startsWith(aucPfx) && !usesOpen;

  // Strip prefix and get command + args
  const cgCmd  = usesCg  ? lower.slice(cgPfx.length).trim()      : null;
  const aucCmd = usesAuc ? lower.slice(aucPfx.length).trim()      : null;
  const cgArgs  = usesCg  ? content.slice(cgPfx.length).trim().split(/\s+/).slice(1)  : [];
  const aucArgs = usesAuc ? content.slice(aucPfx.length).trim().split(/\s+/).slice(1) : [];
  const aucRaw  = usesAuc ? content.slice(aucPfx.length).trim()   : null;
  const openRaw = usesOpen ? content.slice(openPfx.length).trim() : null;

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

      // Auction split into two: bidding/queue and admin
      const auctionEmbed1 = () => auctionHelpPage1(aucPfx, `Page 1/2 — use ${cgPfx}help auction2 (or ${aucPfx}ahelp) for admin cmds`);
      const auctionEmbed2 = () => auctionHelpPage2(aucPfx, `Page 2/2 — use ${cgPfx}help auction (or ${aucPfx}ahelp) for bidding cmds`);

      // Owner-only help page
      function ownerEmbed() {
        return new EmbedBuilder()
          .setTitle('👑 Owner Commands')
          .setColor(0xFFD700)
          .setDescription('Only usable by the bot owner (you)')
          .addFields(
            { name: `\`${aucPfx}approveauction\``,    value: 'Approve this server for auction commands', inline: false },
            { name: `\`${aucPfx}approvecg\``,         value: 'Approve this server for cgdrop commands', inline: false },
            { name: `\`${aucPfx}unapproveauction\``,  value: 'Revoke auction access from this server', inline: false },
            { name: `\`${aucPfx}unapprovecg\``,       value: 'Revoke cgdrop access from this server', inline: false },
            { name: `\`${aucPfx}listapprovals\``,     value: 'List all approved servers', inline: false },
            { name: `\`${aucPfx}sync\``,              value: 'Force push all data to JSONBin', inline: false },
            { name: `\`${cgPfx}adduser @user\``,      value: 'Grant cgdrop whitelist access', inline: false },
            { name: `\`${cgPfx}removeuser @user\``,   value: 'Revoke cgdrop whitelist access', inline: false },
            { name: `\`${cgPfx}listusers\``,          value: 'List whitelisted users', inline: false },
            { name: `\`${cgPfx}recording on/off\``,   value: 'Toggle !mystats recording', inline: false },
            { name: `\`${cgPfx}resetstats\``,         value: 'Reset global drop stats', inline: false }
          );
      }

      // ── Direct sub-command ───────────────────────────────────────────────
      if (sub === 'drop')     { await message.channel.send({ embeds: [dropEmbed()] });     return; }
      if (sub === 'wl')       { await message.channel.send({ embeds: [wlEmbed()] });       return; }
      if (sub === 'auction')  { await message.channel.send({ embeds: [auctionEmbed1()] }); return; }
      if (sub === 'auction2') { await message.channel.send({ embeds: [auctionEmbed2()] }); return; }
      if (sub === 'owner')    { if (userId !== OWNER_ID) return; await message.channel.send({ embeds: [ownerEmbed()] }); return; }

      // ── Main menu with buttons ───────────────────────────────────────────
      const isOwner = userId === OWNER_ID;
      const menuEmbed = new EmbedBuilder()
        .setTitle('📖 Bot Help')
        .setColor(0x5865F2)
        .setDescription('Choose a category below, or use a shortcut:')
        .addFields(
          { name: `\`${cgPfx}help drop\``,     value: '🎮 Drop commands', inline: true },
          { name: `\`${cgPfx}help wl\``,       value: '🔒 Whitelisted commands', inline: true },
          { name: `\`${cgPfx}help auction\``,  value: '🏏 Auction bidding & queue', inline: true },
          { name: `\`${cgPfx}help auction2\``, value: '🔧 Auction admin commands', inline: true },
          ...(isOwner ? [{ name: `\`${cgPfx}help owner\``, value: '👑 Owner commands', inline: true }] : [])
        );

      const rowComponents = [
        new ButtonBuilder().setCustomId('help_drop').setLabel('🎮 Drop').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('help_wl').setLabel('🔒 Whitelisted').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('help_auction').setLabel('🏏 Auction').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('help_auction2').setLabel('🔧 Admin').setStyle(ButtonStyle.Secondary),
      ];
      if (isOwner) rowComponents.push(
        new ButtonBuilder().setCustomId('help_owner').setLabel('👑 Owner').setStyle(ButtonStyle.Secondary)
      );

      const row = new ActionRowBuilder().addComponents(rowComponents);
      const sent = await message.channel.send({ embeds: [menuEmbed], components: [row] });

      const collector = sent.createMessageComponentCollector({
        filter: i => i.user.id === userId,
        time: 60_000
      });

      collector.on('collect', async i => {
        if (i.customId === 'help_drop')     await i.update({ embeds: [dropEmbed()],     components: [] });
        if (i.customId === 'help_wl')       await i.update({ embeds: [wlEmbed()],       components: [] });
        if (i.customId === 'help_auction')  await i.update({ embeds: [auctionEmbed1()], components: [] });
        if (i.customId === 'help_auction2') await i.update({ embeds: [auctionEmbed2()], components: [] });
        if (i.customId === 'help_owner')    await i.update({ embeds: [ownerEmbed()],    components: [] });
      });

      collector.on('end', (_, reason) => {
        if (reason === 'time') sent.edit({ components: [] }).catch(() => {});
      });

      return;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  OPEN AUCTION COMMANDS  ($ prefix)
  // ════════════════════════════════════════════════════════════════════════

  if (usesOpen && guildId) {
    const gd    = getGuildData(guildId);
    const o     = ensureOpen(gd);
    const parts = openRaw.split(/\s+/).filter(Boolean);
    const cmd   = (parts[0] || '').toLowerCase();
    const rest  = openRaw.slice((parts[0] || '').length).trim();
    const host  = () => hasAuctionPermission(message.member);
    const noPerm = async () => { await message.channel.send('❌ You need **Administrator** or the **Auctioneer** role.'); };

    if (!cmd) return;

    // Split "<player name> <amount>" — the amount is always the last word.
    const splitNameAmount = (text) => {
      const w = String(text || '').split(/\s+/).filter(Boolean);
      if (w.length < 2) return { name: w.join(' '), amount: null };
      const amount = parseMoney(w[w.length - 1]);
      if (amount === null) return { name: w.join(' '), amount: null };
      return { name: w.slice(0, -1).join(' '), amount };
    };

    // "3d" / "72h" / "90m" / plain number = days
    const parseDuration = (text) => {
      const m = String(text || '').toLowerCase().trim().match(/^(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minutes)?$/);
      if (!m) return null;
      const n = parseFloat(m[1]);
      if (isNaN(n) || n <= 0) return null;
      const unit = m[2] || 'd';
      if (/^m/.test(unit)) return n * 60000;
      if (/^h/.test(unit)) return n * 3600000;
      return n * 86400000;
    };

    // Resolve a typed player name, replying with the problem if it doesn't land.
    const resolveOrTell = async (raw) => {
      const r = openResolve(o, raw);
      if (!r) { await message.channel.send(`❌ No player called **${raw}** in the pool. Try \`${openPfx}players\` or a shorter name.`); return null; }
      if (r.ambiguous) { await message.channel.send(`❓ **${raw}** matches several: ${r.ambiguous.join(', ')} — be more specific.`); return null; }
      return r;
    };

    // Sets are just the pool's tier headers; ungrouped players share one bucket.
    const setNameOf = (pl) => pl.set || 'Ungrouped';
    const setNames  = () => [...new Set(Object.values(o.players).map(setNameOf))];
    const resolveSet = (raw) => {
      const want = String(raw || '').trim().toLowerCase();
      if (!want) return null;
      const names = setNames();
      const exact = names.find(n => n.toLowerCase() === want);
      if (exact) return { name: exact };
      const partial = names.filter(n => n.toLowerCase().startsWith(want));
      if (partial.length === 1) return { name: partial[0] };
      if (partial.length > 1)   return { ambiguous: partial };
      return null;
    };

    // ── Help — always available, even before approval ──────────────────────
    if (cmd === 'ohelp' || cmd === 'openhelp' || cmd === 'ohelp2') {
      const p1 = () => openHelpPage1(openPfx), p2 = () => openHelpPage2(openPfx);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ohelp_p1').setLabel('💸 Bidding').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ohelp_p2').setLabel('🔧 Host').setStyle(ButtonStyle.Secondary),
      );
      const sent = await message.channel.send({ embeds: [cmd === 'ohelp2' ? p2() : p1()], components: [row] });
      const col = sent.createMessageComponentCollector({ filter: i => i.user.id === userId, time: 120_000 });
      col.on('collect', async i => { await i.update({ embeds: [i.customId === 'ohelp_p2' ? p2() : p1()], components: [row] }).catch(() => {}); });
      col.on('end', () => sent.edit({ components: [] }).catch(() => {}));
      return;
    }

    if (!isAuctionApproved(guildId)) {
      await message.channel.send('⛔ This server is not approved for auction commands.\nContact **frenzy_guy** to get access.');
      return;
    }

    // ── Host: prefix ───────────────────────────────────────────────────────
    if (cmd === 'setopenprefix') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) { await message.channel.send('❌ Admin only!'); return; }
      const np = (parts[1] || '').trim();
      if (!np || np.length > 3) { await message.channel.send(`❌ Usage: \`${openPfx}setopenprefix <prefix>\` (1-3 characters)`); return; }
      auctionData.openPrefixes = auctionData.openPrefixes || {};
      auctionData.openPrefixes[guildId] = np;
      scheduleAuctionSave();
      await message.channel.send(`✅ Open auction prefix is now \`${np}\` — e.g. \`${np}bid kohli 5m\``);
      return;
    }

    // ── Host: pool ─────────────────────────────────────────────────────────
    if (cmd === 'openpool' || cmd === 'opool' || cmd === 'op') {
      if (!host()) return noPerm();
      const sub = (parts[1] || '').toLowerCase();
      const att = message.attachments.first();

      if (sub === 'clear') {
        if (o.active) { await message.channel.send('❌ Auction is running — `openend` or `openreset` first.'); return; }
        o.players = {}; o.autobids = {}; o.priority = {}; o.watch = {}; o.feed = []; o.results = null;
        scheduleAuctionSave();
        await message.channel.send('🗑️ Open auction pool cleared.');
        return;
      }

      if (!att && !rest) {
        const list = Object.values(o.players);
        if (!list.length) {
          await message.channel.send(`📋 No open auction pool loaded.\nLoad one with \`${openPfx}openpool <pasted list>\` or attach a .txt to \`${openPfx}openpool\`.\nLines can be \`Name\`, \`Name 2m\`, or comma-separated. \`Set: X\` / \`── X ──\` rows tag a set.`);
          return;
        }
        const sets = {};
        for (const p of list) sets[p.set || 'Ungrouped'] = (sets[p.set || 'Ungrouped'] || 0) + 1;
        const embed = new EmbedBuilder().setTitle('📋 Open Auction Pool').setColor(0x00B2FF)
          .setDescription(`**${list.length}** players loaded${o.active ? ' — auction is LIVE' : ''}.`)
          .addFields(
            { name: 'Sets', value: Object.entries(sets).map(([s, n]) => `• ${s} — ${n}`).join('\n').slice(0, 1024) || '—', inline: false },
            { name: 'Base prices', value: `${formatAmount(Math.min(...list.map(p => p.base)))} – ${formatAmount(Math.max(...list.map(p => p.base)))}`, inline: true },
            { name: 'With bids', value: String(list.filter(p => p.uid).length), inline: true }
          )
          .setFooter({ text: `${openPfx}openpool <paste|.txt> appends · ${openPfx}openpool clear resets` });
        await message.channel.send({ embeds: [embed] });
        return;
      }

      if (o.active) { await message.channel.send('❌ Auction is running — you can\'t change the pool mid-auction.'); return; }

      const tiered = sub === 'tiered';
      let text = tiered ? rest.replace(/^\S+\s*/, '') : rest;
      if (att) {
        if (att.size > 2 * 1024 * 1024) { await message.channel.send('❌ File too big (max 2 MB).'); return; }
        try { text = await (await fetch(att.url)).text(); }
        catch (_) { await message.channel.send('❌ Could not read the attached file — try again.'); return; }
      }
      if (!text.trim()) { await message.channel.send(`❌ Nothing to load — paste the list after \`${openPfx}openpool${tiered ? ' tiered' : ''}\` or attach the \`cv pl\` .txt to it.`); return; }
      const parsed = parseOpenPool(text, o.cfg.defaultBase);
      if (!parsed.length) { await message.channel.send('❌ No player names found in that.'); return; }
      const bands = tiered ? applyTieredBases(parsed, o.cfg.defaultBase) : null;

      let added = 0, dupes = 0;
      for (const item of parsed) {
        const k = openKey(item.name);
        if (o.players[k]) { dupes++; continue; }
        if (Object.keys(o.players).length >= OPEN_MAX_POOL) break;
        const p = { n: item.name, set: item.set || null, base: item.base, bid: 0, uid: null, at: 0,
                    closesAt: 0, closed: false, fl: {}, best: {}, hist: [], count: 0 };
        if (item.ovr)  p.ovr  = item.ovr;
        if (item.role) p.role = item.role;
        o.players[k] = p;
        added++;
      }
      scheduleAuctionSave();

      const sets = {};
      for (const it of parsed) sets[it.set || (it.ovr ? 'Rated list' : 'Ungrouped')] = (sets[it.set || (it.ovr ? 'Rated list' : 'Ungrouped')] || 0) + 1;
      const embed = new EmbedBuilder().setTitle('✅ Pool loaded').setColor(0x57F287)
        .setDescription(`Added **${added}** player(s)${dupes ? ` · ${dupes} duplicate(s) skipped` : ''} — pool is now **${Object.keys(o.players).length}**${Object.keys(o.players).length >= OPEN_MAX_POOL ? ` (cap ${OPEN_MAX_POOL} reached)` : ''}.`)
        .addFields({ name: 'Sets', value: Object.entries(sets).map(([s, n]) => `• **${s}** — ${n}`).join('\n').slice(0, 1024) || '—' });
      if (bands) {
        embed.addFields({ name: 'Tiered base prices',
          value: Object.entries(bands).map(([s, b]) => `• **${s}** — ${formatAmount(b)}`).join('\n').slice(0, 1024) });
      } else {
        embed.setFooter({ text: `All bases ${formatAmount(o.cfg.defaultBase)} — use ${openPfx}openpool tiered to scale them by tier/OVR instead.` });
      }
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // ── Host: start ────────────────────────────────────────────────────────
    if (cmd === 'openstart' || cmd === 'ostart') {
      if (!host()) return noPerm();
      if (o.active) { await message.channel.send(`❌ An open auction is already running — closes ${ts(o.endsAt, 'R')}.`); return; }
      const count = Object.keys(o.players).length;
      if (!count) { await message.channel.send(`❌ Load a pool first: \`${openPfx}openpool <list>\``); return; }
      const withPurse = Object.keys(gd.purses || {}).filter(u => gd.purses[u] > 0).length;
      if (!withPurse) { await message.channel.send(`❌ Nobody has a purse yet — set them with \`${openPfx}openpurse all <amount>\`.`); return; }

      const dur = rest ? parseDuration(rest) : o.cfg.days * 86400000;
      if (!dur) { await message.channel.send(`❌ Usage: \`${openPfx}openstart 3d\` (also accepts \`72h\`, \`90m\`)`); return; }
      const now = Date.now();
      o.active = true; o.paused = false; o.startedAt = now; o.endsAt = now + dur;
      o.settledAt = 0; o.results = null; o.warned = {}; o.pausedAt = 0;
      o.autobids = {}; o.feed = [];        // stale maxes from a previous run must never fire
      o.channelId = o.channelId || message.channel.id;

      // Anyone already in a squad (retained, drafted or won in an earlier round)
      // is not up for auction — everything else starts from a clean slate.
      let owned = 0, live = 0;
      for (const p of Object.values(o.players)) {
        if (findTakenPlayer(gd, p.n)) {
          p.closed = true; p.settled = true; owned++;
          continue;
        }
        p.bid = 0; p.uid = null; p.at = 0; p.fl = {}; p.best = {};
        p.hist = []; p.count = 0; p.sniped = 0; p.settled = false;
        p.closed = false; p.closesAt = o.endsAt;
        live++;
      }
      scheduleAuctionSave();
      await flushAuction();

      const embed = new EmbedBuilder().setTitle('💸 OPEN AUCTION IS LIVE')
        .setColor(0x00FF00)
        .setDescription(`**${live}** players are open for bidding right now. Bid on as many as you like, whenever you like.` +
          (owned ? `\n*(${owned} already in a squad — not up for auction.)*` : ''))
        .addFields(
          { name: 'Closes',      value: `${ts(o.endsAt, 'F')}\n${ts(o.endsAt, 'R')}`, inline: true },
          { name: 'Squad slots', value: String(o.cfg.maxSquad), inline: true },
          { name: 'Min raise',   value: `${formatAmount(o.cfg.minInc)}${o.cfg.ladder ? ' (scales with price)' : ''}`, inline: true },
          { name: 'How to bid',  value: `\`${openPfx}bid <player> <amount>\` — or \`${openPfx}max <player> <ceiling>\` and I'll bid for you automatically.`, inline: false },
          { name: 'Money',       value: `Only the bids you're **leading** lock funds. Get outbid and it's free again. Check with \`${openPfx}bal\`.`, inline: false },
          { name: 'Over-bidding', value: `You may lead more than ${o.cfg.maxSquad} players — set \`${openPfx}priority\` and the extras are released to the next bidder at settlement.`, inline: false },
          { name: 'Anti-snipe',  value: `A bid in the last **${o.cfg.antiSnipe}m** pushes that player's close back by the same, so late sniping doesn't work.`, inline: false }
        )
        .setFooter({ text: `Started by ${message.author.tag} · ${openPfx}ohelp for everything` })
        .setTimestamp();
      await message.channel.send({ embeds: [embed] });
      if (o.channelId !== message.channel.id) await openAnnounce(message.guild, gd, { embeds: [embed] });
      if (live > 600) {
        await message.channel.send(`ℹ️ Heads up: a **${live}**-player auction is a lot of state to back up. It all saves locally either way, but if the JSONBin upload ever starts failing in the logs, a smaller pool (or splitting the auction into rounds) is the fix.`);
      }
      return;
    }

    // ── Host: clock control ────────────────────────────────────────────────
    if (cmd === 'openextend' || cmd === 'oextend') {
      if (!host()) return noPerm();
      if (!o.active) { await message.channel.send('❌ No open auction is running.'); return; }
      const dur = parseDuration(rest || '');
      if (!dur) { await message.channel.send(`❌ Usage: \`${openPfx}openextend 12h\``); return; }
      o.endsAt += dur;
      let moved = 0;
      for (const p of Object.values(o.players)) if (!p.closed) { p.closesAt += dur; moved++; }
      o.warned = {};
      scheduleAuctionSave();
      await message.channel.send(`⏰ Deadline pushed by **${fmtLeft(dur)}** — ${moved} player(s) still open, now closing ${ts(o.endsAt, 'R')}.`);
      await openAnnounce(message.guild, gd, `⏰ The open auction was extended — it now closes ${ts(o.endsAt, 'R')}.`);
      return;
    }

    if (cmd === 'openpause' || cmd === 'openresume') {
      if (!host()) return noPerm();
      if (!o.active) { await message.channel.send('❌ No open auction is running.'); return; }
      const pausing = cmd === 'openpause';
      if (pausing === !!o.paused) { await message.channel.send(pausing ? '⏸️ Already paused.' : '▶️ Not paused.'); return; }

      if (pausing) {
        o.paused = true;
        o.pausedAt = Date.now();
      } else {
        // Paused time shouldn't eat anyone's bidding window — push every clock back by it.
        const frozen = Math.max(0, Date.now() - (o.pausedAt || Date.now()));
        o.paused = false; o.pausedAt = 0;
        o.endsAt += frozen;
        for (const p of Object.values(o.players)) if (!p.closed) p.closesAt += frozen;
        o.warned = {};
      }
      scheduleAuctionSave();
      await message.channel.send(pausing
        ? `⏸️ Bidding **paused** — every clock is frozen. \`${openPfx}openresume\` to continue.`
        : `▶️ Bidding **resumed** — clocks pushed back by the paused time, closing ${ts(o.endsAt, 'R')}.`);
      await openAnnounce(message.guild, gd, pausing ? '⏸️ The open auction is paused by the host.' : `▶️ The open auction is back on — closes ${ts(o.endsAt, 'R')}.`);
      return;
    }

    if (cmd === 'openend' || cmd === 'oend') {
      if (!host()) return noPerm();
      if (!o.active) { await message.channel.send('❌ No open auction is running.'); return; }
      if ((parts[1] || '').toLowerCase() !== 'confirm') {
        const open = Object.values(o.players).filter(p => !p.closed).length;
        await message.channel.send(`⚠️ This closes **${open}** still-open player(s) and settles everything immediately.\nRun \`${openPfx}openend confirm\` to go ahead.`);
        return;
      }
      for (const p of Object.values(o.players)) p.closed = true;
      const status = await message.channel.send('⚙️ Settling the auction — working out who keeps whom...');
      const res = await settleOpenAuction(message.guild, gd, message.author.tag);
      await status.edit(`✅ Settled — **${res.awards.length}** sold, **${res.unsold.length}** unsold. \`${openPfx}results\` for the full list.`).catch(() => {});
      return;
    }

    // Sell one set at a time instead of settling the whole pool at the end.
    if (cmd === 'closeset' || cmd === 'sellset' || cmd === 'cs') {
      if (!host()) return noPerm();
      if (!o.active) { await message.channel.send('❌ No open auction is running.'); return; }
      const words     = rest.split(/\s+/).filter(Boolean);
      const confirmed = words.length > 1 && /^(confirm|yes|y)$/i.test(words[words.length - 1]);
      const wanted    = (confirmed ? words.slice(0, -1) : words).join(' ').trim();
      if (!wanted) {
        await message.channel.send(`❌ Usage: \`${openPfx}closeset <set>\` to preview, then \`${openPfx}closeset <set> confirm\`. Sets: ${setNames().join(', ') || '*none*'}`);
        return;
      }
      const found = resolveSet(wanted);
      if (!found)            { await message.channel.send(`❌ No set called **${wanted}**. Try: ${setNames().join(', ') || '*none*'}`); return; }
      if (found.ambiguous)   { await message.channel.send(`❓ **${wanted}** matches several: ${found.ambiguous.join(', ')} — be more specific.`); return; }

      const keys = Object.entries(o.players)
        .filter(([, pl]) => setNameOf(pl) === found.name && !pl.settled)
        .map(([k]) => k);
      if (!keys.length) { await message.channel.send(`✅ **${found.name}** is already settled — nothing left in it.`); return; }

      const onlyKeys = new Set(keys);
      const preview  = computeOpenSettlement(gd, onlyKeys);

      if (!confirmed) {
        const byTeam = {};
        for (const a of preview.awards) (byTeam[a.uid] = byTeam[a.uid] || []).push(a);
        const lines = Object.entries(byTeam)
          .sort((x, y) => y[1].reduce((s, a) => s + a.a, 0) - x[1].reduce((s, a) => s + a.a, 0))
          .map(([uid, list]) => `**${teamOnly(gd, message.guild, uid)}** — ${list.length} player(s), ${formatAmount(list.reduce((s, a) => s + a.a, 0))}`);
        const embed = new EmbedBuilder().setTitle(`⚠️ Close set — ${found.name}`).setColor(0xFFA500)
          .setDescription(`This closes **${keys.length}** player(s) in **${found.name}** right now and awards them. The rest of the auction keeps running.`)
          .addFields(
            { name: 'Selling',  value: `${preview.awards.length} sold · ${preview.unsold.length} unsold${preview.released.length ? ` · ${preview.released.length} bid(s) released` : ''}`, inline: false },
            { name: 'Squads',   value: (lines.join('\n') || '*no bids in this set*').slice(0, 1024), inline: false },
            { name: 'Careful',  value: 'Winners pay now, so money they had committed elsewhere may no longer cover their other leads.', inline: false }
          )
          .setFooter({ text: `${openPfx}closeset ${found.name} confirm to go ahead` });
        await message.channel.send({ embeds: [embed] });
        return;
      }

      for (const k of keys) { o.players[k].closed = true; o.players[k].closesAt = Date.now(); }
      const status = await message.channel.send(`⚙️ Selling **${found.name}** — working out who keeps whom...`);
      const res = await settleOpenAuction(message.guild, gd, message.author.tag, { onlyKeys, label: found.name });
      const left = Object.values(o.players).filter(pl => !pl.closed).length;
      await status.edit(`✅ **${found.name}** sold — **${res.awards.length}** sold, **${res.unsold.length}** unsold. ${left} player(s) still open. \`${openPfx}results\` for the list.`).catch(() => {});
      return;
    }

    if (cmd === 'openreset') {
      if (!host()) return noPerm();
      const full = (parts[1] || '').toLowerCase() === 'full';
      const confirmWord = full ? (parts[2] || '') : (parts[1] || '');
      if (confirmWord.toLowerCase() !== 'confirm') {
        await message.channel.send(`⚠️ This wipes the open auction pool, every bid, all maxes and priorities${full ? ' **and empties every squad**' : ''}.\nRun \`${openPfx}openreset ${full ? 'full ' : ''}confirm\` to go ahead.`);
        return;
      }
      if (full) for (const uid of Object.keys(gd.squads || {})) gd.squads[uid] = [];
      gd.open = openDefaults();
      scheduleAuctionSave();
      await flushAuction();
      await message.channel.send(`🗑️ Open auction reset${full ? ' — squads emptied too' : ''}. Load a pool with \`${openPfx}openpool\`.`);
      return;
    }

    // ── Host: config ───────────────────────────────────────────────────────
    if (cmd === 'ocfg' || cmd === 'openconfig') {
      if (!host()) return noPerm();
      const key = (parts[1] || '').toLowerCase(), val = (parts[2] || '').toLowerCase();
      if (!key) {
        const embed = new EmbedBuilder().setTitle('⚙️ Open Auction Config').setColor(0x5865F2)
          .addFields(
            { name: 'maxsquad',   value: `${o.cfg.maxSquad} slots`, inline: true },
            { name: 'inc',        value: formatAmount(o.cfg.minInc), inline: true },
            { name: 'ladder',     value: o.cfg.ladder ? 'on — raises grow with price' : 'off — flat raises', inline: true },
            { name: 'antisnipe',  value: `${o.cfg.antiSnipe} min`, inline: true },
            { name: 'overcommit', value: o.cfg.overcommit ? 'on — may lead beyond the purse' : 'off — leads can never exceed the purse', inline: true },
            { name: 'base',       value: formatAmount(o.cfg.defaultBase), inline: true },
            { name: 'dm',         value: o.cfg.dm ? 'on' : 'off', inline: true },
            { name: 'days',       value: `${o.cfg.days} (default length)`, inline: true }
          )
          .setFooter({ text: `${openPfx}ocfg <key> <value>` });
        await message.channel.send({ embeds: [embed] });
        return;
      }
      const onOff = (v) => v === 'on' || v === 'true' || v === 'yes';
      let msg = null;
      if (key === 'maxsquad')        { const n = parseInt(val); if (isNaN(n) || n < 0 || n > 200) { await message.channel.send('❌ 0-200 (0 = no limit).'); return; } o.cfg.maxSquad = n; msg = `Squad limit: **${n || 'none'}**`; }
      else if (key === 'inc')        { const n = parseMoney(val); if (!n) { await message.channel.send('❌ Invalid amount.'); return; } o.cfg.minInc = n; msg = `Min raise: **${formatAmount(n)}**`; }
      else if (key === 'base')       { const n = parseMoney(val); if (!n) { await message.channel.send('❌ Invalid amount.'); return; } o.cfg.defaultBase = n; msg = `Default base: **${formatAmount(n)}**`; }
      else if (key === 'ladder')     { o.cfg.ladder = onOff(val); msg = `Increment ladder: **${o.cfg.ladder ? 'on' : 'off'}**`; }
      else if (key === 'antisnipe')  { const n = parseInt(val); if (isNaN(n) || n < 0 || n > 180) { await message.channel.send('❌ 0-180 minutes.'); return; } o.cfg.antiSnipe = n; msg = `Anti-snipe: **${n}m**`; }
      else if (key === 'overcommit') { o.cfg.overcommit = onOff(val); msg = `Over-commit: **${o.cfg.overcommit ? 'on — leads may exceed the purse, settlement trims by priority' : 'off — leads can never exceed the purse'}**`; }
      else if (key === 'dm')         { o.cfg.dm = onOff(val); msg = `Outbid DMs: **${o.cfg.dm ? 'on' : 'off'}**`; }
      else if (key === 'days')       { const n = parseFloat(val); if (isNaN(n) || n <= 0) { await message.channel.send('❌ Invalid.'); return; } o.cfg.days = n; msg = `Default length: **${n} day(s)**`; }
      else { await message.channel.send('❌ Keys: `maxsquad` `inc` `base` `ladder` `antisnipe` `overcommit` `dm` `days`'); return; }
      scheduleAuctionSave();
      await message.channel.send(`✅ ${msg}`);
      return;
    }

    if (cmd === 'openpurse' || cmd === 'osp') {
      if (!host()) return noPerm();
      const amt = parseMoney(parts[parts.length - 1]);
      if (amt === null) { await message.channel.send(`❌ Usage: \`${openPfx}openpurse @user 100m\` or \`${openPfx}openpurse all 100m\``); return; }
      if ((parts[1] || '').toLowerCase() === 'all') {
        const ids = new Set([...Object.keys(gd.teams || {}), ...Object.keys(gd.purses || {})]);
        if (!ids.size) { await message.channel.send('❌ Nobody has a team name or purse yet — set team names first (`.team @user <name>`).'); return; }
        for (const uid of ids) gd.purses[uid] = amt;
        scheduleAuctionSave();
        await message.channel.send(`💰 Every team (**${ids.size}**) now has a purse of **${formatAmount(amt)}**.`);
        return;
      }
      const target = resolveMemberTarget(gd, message, parts.slice(1, -1).join(' '));
      if (!target) { await message.channel.send('❌ Could not find that member.'); return; }
      gd.purses[target.id] = amt;
      scheduleAuctionSave();
      await message.channel.send(`💰 **${teamLabel(gd, message.guild, target.id)}** purse set to **${formatAmount(amt)}**.`);
      return;
    }

    if (cmd === 'openlog') {
      if (!host()) return noPerm();
      const ch = message.mentions.channels.first();
      if (!ch) { await message.channel.send(o.channelId ? `📋 Open auction announcements go to <#${o.channelId}>.` : `❌ Usage: \`${openPfx}openlog #channel\``); return; }
      o.channelId = ch.id;
      scheduleAuctionSave();
      await message.channel.send(`✅ Open auction announcements → ${ch}`);
      return;
    }

    // ── Team names ─────────────────────────────────────────────────────────
    // Same store the live auction uses, so a server can run open auctions
    // without ever touching the other prefix.
    if (cmd === 'team' || cmd === 'setteam') {
      if (!gd.teams) gd.teams = {};
      const mentioned = message.mentions.members.first();
      const target = mentioned || message.member;
      if (target.id !== userId && !host()) {
        await message.channel.send("❌ You need **Administrator** or **Auctioneer** role to set someone else's team name."); return;
      }
      let nameRaw = rest.replace(/<@!?\d+>/g, '').trim();
      if (!nameRaw) {
        const cur = gd.teams[target.id];
        await message.channel.send(cur
          ? `🏷️ **${target.displayName}**'s team name is **${cur}**.`
          : `🏷️ **${target.displayName}** has no team name yet. Set with \`${openPfx}team ${target.id === userId ? '' : '@user '}<name>\`.`);
        return;
      }
      if (['clear', 'remove', 'none', 'reset'].includes(nameRaw.toLowerCase())) {
        delete gd.teams[target.id]; scheduleAuctionSave();
        await message.channel.send(`🏷️ Cleared **${target.displayName}**'s team name.`); return;
      }
      gd.teams[target.id] = nameRaw.slice(0, 50); scheduleAuctionSave();
      await message.channel.send({ embeds: [new EmbedBuilder().setTitle('🏷️ Team Name Set').setColor(0x00B0F4)
        .setDescription(`${target} is now **${gd.teams[target.id]}**.`)
        .setFooter({ text: `Set by ${message.author.tag}` })] });
      return;
    }

    // ── Bidding ────────────────────────────────────────────────────────────
    if (cmd === 'bid' || cmd === 'b' || cmd === 'bn' || cmd === 'nextbid' || cmd === 'max' || cmd === 'autobid' || cmd === 'ab') {
      const isMax = cmd === 'max' || cmd === 'autobid' || cmd === 'ab';
      // `bn <player>` / `b next <player>` — take the next valid step, no price typed.
      const quick = cmd === 'bn' || cmd === 'nextbid' || (!isMax && /^next\s+/i.test(rest));
      if (!o.active) { await message.channel.send('❌ No open auction is running.'); return; }
      if (o.paused)  { await message.channel.send('⏸️ Bidding is paused by the host.'); return; }

      const { name, amount } = quick
        ? { name: rest.replace(/^next\s+/i, '').trim(), amount: null }
        : splitNameAmount(rest);
      if (!name) {
        await message.channel.send(quick
          ? `❌ Usage: \`${openPfx}${cmd === 'bn' || cmd === 'nextbid' ? 'bn' : 'b next'} <player>\` — e.g. \`${openPfx}bn kohli\``
          : `❌ Usage: \`${openPfx}${cmd} <player> <amount>\` — e.g. \`${openPfx}${cmd} kohli 5cr\``);
        return;
      }

      // `max <player> clear` cancels a proxy
      if (isMax && /^(clear|off|cancel|remove)$/i.test(rest.split(/\s+/).pop() || '')) {
        const target = await resolveOrTell(rest.split(/\s+/).slice(0, -1).join(' '));
        if (!target) return;
        if (o.autobids[target.key]) delete o.autobids[target.key][userId];
        scheduleAuctionSave();
        await message.channel.send(`🤖 Max bid cleared for **${target.p.n}**. Your standing bid of ${target.p.fl && target.p.fl[userId] ? `**${formatAmount(target.p.fl[userId])}**` : 'nothing'} remains.`);
        return;
      }

      if (!quick && !isMax && (amount === null || amount <= 0)) { await message.channel.send(`❌ Invalid amount. Try \`${openPfx}${cmd} ${name} 5cr\` (also \`40L\`, \`500k\`, or plain numbers).`); return; }
      if (!gd.purses[userId]) { await message.channel.send('❌ You have no purse in this auction — ask a host to set one.'); return; }

      // `max <player>` with no number: ask for the ceiling in DMs instead, so the
      // channel never sees what you were willing to pay.
      if (isMax && (amount === null || amount <= 0)) {
        const t = await resolveOrTell(name);
        if (!t) return;
        await startPrivateMax(message, gd, t, openPfx);
        return;
      }

      const target = await resolveOrTell(name);
      if (!target) return;
      const { key, p } = target;

      let bidAmount = amount;
      if (quick) {
        if (p.uid === userId) {
          await message.channel.send(`✅ You already lead **${p.n}** at **${formatAmount(p.bid)}** — nothing to beat. Raise yourself with \`${openPfx}bid ${p.n} <amount>\` if you really want to.`);
          return;
        }
        bidAmount = p.uid ? p.bid + bidIncrement(o.cfg, p.bid) : p.base;
      }

      const before = p.uid;
      const res = applyOpenBid(gd, userId, key, bidAmount, isMax ? 'max' : 'bid');
      if (!res.ok) { await message.channel.send(`❌ ${res.err}`); return; }

      const leads = openLeads(o, userId);
      const slotsFree = (o.cfg.maxSquad || 0) ? o.cfg.maxSquad - openSlotsUsed(gd, userId) : Infinity;
      const over = leads.length - slotsFree;

      const embed = new EmbedBuilder()
        .setTitle(res.youLead ? '✅ You are the highest bidder' : '❌ Outbid instantly')
        .setColor(res.youLead ? 0x57F287 : 0xED4245)
        .setDescription(`**${p.n}** — **${formatAmount(res.price)}** to **${teamOnly(gd, message.guild, res.leader)}**` +
          (res.youLead ? '' : `\nSomeone's max bid beat you. Next valid bid: **${formatAmount(res.price + res.inc)}**.`))
        .addFields(
          { name: 'Available', value: formatAmount(openAvailable(gd, userId)), inline: true },
          { name: 'Leading',   value: `${leads.length}${(o.cfg.maxSquad || 0) ? ` / ${o.cfg.maxSquad} slots` : ''}`, inline: true },
          { name: 'Closes',    value: ts(p.closesAt, 'R'), inline: true }
        );
      if (isMax) embed.addFields({ name: '🤖 Max set', value: `I'll bid up to **${formatAmount(amount)}** for you automatically.`, inline: false });
      if (res.extended) embed.addFields({ name: '⏱️ Extended', value: `Late bid — **${p.n}** now closes ${ts(p.closesAt, 'R')}.`, inline: false });
      if (over > 0) embed.addFields({ name: '⚠️ Over your slots', value: `You lead **${over}** more player(s) than you can fit. Set \`${openPfx}priority\` or the bot decides which to release at settlement.`, inline: false });
      embed.setFooter({ text: `${message.author.tag}` }).setTimestamp();
      await message.channel.send({ embeds: [embed] });

      // Whoever just lost the lead hears about it straight away.
      if (before && before !== res.leader && before !== userId) {
        openDm(o, before, {
          embeds: [new EmbedBuilder().setTitle('❌ You have been outbid').setColor(0xED4245)
            .setDescription(`**${p.n}** in **${message.guild.name}** is now **${formatAmount(res.price)}** to **${teamOnly(gd, message.guild, res.leader)}**.`)
            .addFields(
              { name: 'Your bid was', value: formatAmount(res.prevPrice), inline: true },
              { name: 'Next valid bid', value: formatAmount(res.price + res.inc), inline: true },
              { name: 'Closes', value: ts(p.closesAt, 'R'), inline: true },
              { name: 'Freed up', value: `${formatAmount(openAvailable(gd, before))} available again`, inline: false }
            )
            .setFooter({ text: `${openPfx}bid ${p.n} <amount> · ${openPfx}max ${p.n} <ceiling> · ${openPfx}notify off to stop these` })]
        });
      }
      // Watchlist pings for everyone else following this player.
      for (const [wid, keys] of Object.entries(o.watch || {})) {
        if (wid === userId || wid === before || !(keys || []).includes(key)) continue;
        openDm(o, wid, `👀 **${p.n}** (${message.guild.name}) is now **${formatAmount(res.price)}** — ${teamOnly(gd, message.guild, res.leader)}. Closes ${ts(p.closesAt, 'R')}.`);
      }
      return;
    }

    // ── Search ─────────────────────────────────────────────────────────────
    if (cmd === 'search' || cmd === 's' || cmd === 'player' || cmd === 'p' || cmd === 'find') {
      if (!rest) { await message.channel.send(`❌ Usage: \`${openPfx}search <player>\``); return; }
      if (!Object.keys(o.players).length) { await message.channel.send('❌ No open auction pool loaded.'); return; }
      const target = await resolveOrTell(rest);
      if (!target) return;
      await message.channel.send({ embeds: [openPlayerCard(gd, message.guild, target.key, userId, openPfx)] });
      return;
    }

    // ── My bids ────────────────────────────────────────────────────────────
    if (cmd === 'mybids' || cmd === 'mb' || cmd === 'bids') {
      const here = /^(here|channel)$/i.test(parts[1] || '');
      const leads = sortByOpenPriority(o, userId, openLeads(o, userId));
      const lost  = openOutbid(o, userId).sort((a, b) => (b.mine || 0) - (a.mine || 0));
      const maxes = Object.entries(o.autobids || {})
        .filter(([k, m]) => m[userId] && o.players[k] && !o.players[k].closed)
        .map(([k, m]) => ({ k, p: o.players[k], max: m[userId] }));
      const purse = gd.purses[userId] || 0, committed = openCommitted(o, userId);
      const used = openSlotsUsed(gd, userId), maxS = o.cfg.maxSquad || 0;

      const embed = new EmbedBuilder()
        .setTitle(`💸 Your open auction — ${message.guild.name}`)
        .setColor(0x00B2FF)
        .addFields(
          { name: 'Purse',     value: formatAmount(purse), inline: true },
          { name: 'Committed', value: `${formatAmount(committed)} *(leading bids)*`, inline: true },
          { name: 'Available', value: `**${formatAmount(Math.max(0, purse - committed))}**`, inline: true },
          { name: 'Squad',     value: maxS ? `${used}/${maxS} filled` : String(used), inline: true },
          { name: 'Leading',   value: String(leads.length), inline: true },
          { name: 'Outbid on', value: String(lost.length), inline: true }
        );

      const slotsFree = maxS ? maxS - used : Infinity;
      if (leads.length > slotsFree) {
        embed.addFields({ name: '⚠️ More leads than slots',
          value: `You lead **${leads.length}** for **${slotsFree}** slot(s). At settlement the bottom **${leads.length - slotsFree}** of your priority order are released to the next bidder. Fix the order with \`${openPfx}priority\`.`, inline: false });
      }
      const leadTxt = leads.map((l, i) => `\`${i + 1}.\` **${l.p.n}** — ${formatAmount(l.a)}${maxS && i >= slotsFree ? ' ⚠️' : ''} · ${l.p.closed ? 'closed' : ts(l.p.closesAt, 'R')}`).join('\n');
      embed.addFields({ name: `✅ Leading (priority order)`, value: (leadTxt || '*nothing yet*').slice(0, 1024), inline: false });
      if (lost.length) {
        embed.addFields({ name: '❌ Outbid', value: lost.slice(0, 12)
          .map(l => `• **${l.p.n}** — yours ${formatAmount(l.mine)}, now **${formatAmount(l.p.bid)}** (${teamOnly(gd, message.guild, l.p.uid)})${l.p.closed ? ' — closed' : ''}`)
          .join('\n').slice(0, 1024), inline: false });
      }
      if (maxes.length) {
        embed.addFields({ name: '🤖 Active maxes', value: maxes.slice(0, 12)
          .map(m => `• **${m.p.n}** — up to ${formatAmount(m.max)}${m.p.uid === userId ? ' *(leading)*' : ''}`)
          .join('\n').slice(0, 1024), inline: false });
      }
      embed.setFooter({ text: `${openPfx}priority to reorder · ${openPfx}search <player> for details` }).setTimestamp();

      if (here) { await message.channel.send({ embeds: [embed] }); return; }
      try {
        await message.author.send({ embeds: [embed] });
        await message.channel.send('📬 Sent to your DMs — your maxes stay private that way. (`mybids here` posts it in channel.)');
      } catch (_) {
        await message.channel.send({ embeds: [embed] });
      }
      return;
    }

    // ── Priority ───────────────────────────────────────────────────────────
    if (cmd === 'priority' || cmd === 'pr' || cmd === 'po') {
      o.priority = o.priority || {};
      const sub = (parts[1] || '').toLowerCase();

      if (sub === 'clear') {
        delete o.priority[userId]; scheduleAuctionSave();
        await message.channel.send('🗑️ Priority cleared — your most expensive leads are protected first by default.');
        return;
      }

      if (sub === 'top' || sub === 'up' || sub === 'down') {
        const target = await resolveOrTell(parts.slice(2).join(' '));
        if (!target) return;
        const list = (o.priority[userId] || sortByOpenPriority(o, userId, openLeads(o, userId)).map(l => l.k)).filter(k => k !== target.key);
        const cur  = (o.priority[userId] || []).indexOf(target.key);
        if (sub === 'top') list.unshift(target.key);
        else {
          const at = cur === -1 ? list.length : cur;
          list.splice(Math.max(0, sub === 'up' ? at - 1 : at + 1), 0, target.key);
        }
        o.priority[userId] = list;
        scheduleAuctionSave();
        await message.channel.send(`✅ **${target.p.n}** moved — now #${list.indexOf(target.key) + 1} in your priority.`);
        return;
      }

      if (rest) {
        const names = rest.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
        const keys = [], missed = [];
        for (const n of names) {
          const r = openResolve(o, n);
          if (!r || r.ambiguous) { missed.push(n); continue; }
          if (!keys.includes(r.key)) keys.push(r.key);
        }
        if (!keys.length) { await message.channel.send(`❌ None of those matched the pool.${missed.length ? ` Unknown: ${missed.slice(0, 8).join(', ')}` : ''}`); return; }
        o.priority[userId] = keys;
        scheduleAuctionSave();
        await message.channel.send(`✅ Priority set — **${keys.length}** player(s), top choice **${o.players[keys[0]].n}**.${missed.length ? `\n⚠️ Not found: ${missed.slice(0, 8).join(', ')}` : ''}`);
        return;
      }

      const leads = sortByOpenPriority(o, userId, openLeads(o, userId));
      const maxS = o.cfg.maxSquad || 0, free = maxS ? maxS - openSlotsUsed(gd, userId) : Infinity;
      const setList = o.priority[userId] || [];
      const embed = new EmbedBuilder().setTitle('🎯 Your priority order').setColor(0xF1C40F)
        .setDescription(setList.length
          ? `**${setList.length}** player(s) explicitly ranked. Anything you lead that isn't ranked sits below them, priciest first.`
          : `You haven't ranked anyone — your **most expensive** leads are protected first.\nSet one with \`${openPfx}priority <player1, player2, …>\`.`)
        .addFields({ name: `Leading now (${leads.length}${maxS ? ` for ${free} slot(s)` : ''})`,
          value: (leads.map((l, i) => `\`${i + 1}.\` **${l.p.n}** — ${formatAmount(l.a)}${i >= free ? ' ⚠️ released first' : ''}`).join('\n') || '*nothing yet*').slice(0, 1024) })
        .setFooter({ text: `${openPfx}pr top <player> · ${openPfx}pr up/down <player> · ${openPfx}pr clear` });
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // ── Balance / squad / leaderboard ──────────────────────────────────────
    if (cmd === 'bal' || cmd === 'balance' || cmd === 'wallet') {
      const target = resolveMemberTarget(gd, message, rest);
      if (!target) { await message.channel.send('❌ Could not find that member.'); return; }
      const uid = target.id;
      const purse = gd.purses[uid] || 0, committed = openCommitted(o, uid);
      const leads = openLeads(o, uid), maxS = o.cfg.maxSquad || 0, used = openSlotsUsed(gd, uid);
      const embed = new EmbedBuilder().setTitle(`💰 ${teamLabel(gd, message.guild, uid)}`).setColor(0x00B2FF)
        .addFields(
          { name: 'Purse',     value: formatAmount(purse), inline: true },
          { name: 'Committed', value: formatAmount(committed), inline: true },
          { name: 'Available', value: `**${formatAmount(Math.max(0, purse - committed))}**`, inline: true },
          { name: 'Leading',   value: String(leads.length), inline: true },
          { name: 'Squad',     value: maxS ? `${used}/${maxS}` : String(used), inline: true },
          { name: 'Avg lead',  value: leads.length ? formatAmount(committed / leads.length) : '—', inline: true }
        ).setTimestamp();
      await message.channel.send({ embeds: [embed] });
      return;
    }

    if (cmd === 'squad') {
      const target = resolveMemberTarget(gd, message, rest);
      if (!target) { await message.channel.send('❌ Could not find that member.'); return; }
      const uid = target.id;
      const bought = gd.squads[uid] || [];
      const leads = sortByOpenPriority(o, uid, openLeads(o, uid));
      const maxS = o.cfg.maxSquad || 0;
      const embed = new EmbedBuilder().setTitle(`🏏 ${teamLabel(gd, message.guild, uid)}`).setColor(0x5865F2)
        .addFields({ name: `Squad (${bought.length}${maxS ? `/${maxS}` : ''})`,
          value: (bought.map((s, i) => `\`${i + 1}.\` **${s.player}** — ${formatAmount(s.price)}`).join('\n') || '*empty*').slice(0, 1024) });
      if (leads.length) {
        embed.addFields({ name: `⏳ Provisionally winning (${leads.length})`,
          value: leads.map(l => `• **${l.p.n}** — ${formatAmount(l.a)}`).join('\n').slice(0, 1024) });
      }
      embed.setFooter({ text: `Purse ${formatAmount(gd.purses[uid] || 0)} · available ${formatAmount(openAvailable(gd, uid))}` });
      await message.channel.send({ embeds: [embed] });
      return;
    }

    if (cmd === 'lb' || cmd === 'leaderboard') {
      const ids = new Set([...Object.keys(gd.purses || {}), ...Object.keys(gd.teams || {})]);
      const rows = [...ids].map(uid => ({
        uid, committed: openCommitted(o, uid), leads: openLeads(o, uid).length,
        squad: openSlotsUsed(gd, uid), avail: openAvailable(gd, uid)
      })).sort((a, b) => b.committed - a.committed);
      if (!rows.length) { await message.channel.send('❌ No teams yet.'); return; }
      const embed = new EmbedBuilder().setTitle('🏆 Open Auction — Spending').setColor(0xFFD700)
        .setDescription(rows.slice(0, 20).map((r, i) =>
          `\`${String(i + 1).padStart(2)}.\` **${teamOnly(gd, message.guild, r.uid)}** — ${formatAmount(r.committed)} on ${r.leads} lead(s) · ${formatAmount(r.avail)} left`).join('\n').slice(0, 4000))
        .setTimestamp();
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // ── Browse the pool ────────────────────────────────────────────────────
    if (cmd === 'players' || cmd === 'pool' || cmd === 'available' || cmd === 'list') {
      const all = Object.entries(o.players);
      if (!all.length) { await message.channel.send('❌ No open auction pool loaded.'); return; }
      const filterArg = rest.toLowerCase();
      let rows = all;
      if (filterArg === 'open')       rows = all.filter(([, p]) => !p.closed);
      else if (filterArg === 'nobids') rows = all.filter(([, p]) => !p.uid);
      else if (filterArg === 'mine')   rows = all.filter(([, p]) => p.uid === userId);
      else if (filterArg)              rows = all.filter(([, p]) => (p.set || '').toLowerCase() === filterArg);
      if (!rows.length) { await message.channel.send(`❌ Nothing matches **${rest}**. Try \`open\`, \`nobids\`, \`mine\` or a set name.`); return; }

      rows.sort((a, b) => (b[1].bid || b[1].base) - (a[1].bid || a[1].base));
      const per = 15, pages = [];
      for (let i = 0; i < rows.length; i += per) {
        const chunk = rows.slice(i, i + per);
        pages.push(new EmbedBuilder().setTitle('📋 Open Auction Players').setColor(0x00B2FF)
          .setDescription(chunk.map(([, p]) =>
            `${p.closed ? '🔒' : p.uid === userId ? '✅' : p.best && p.best[userId] ? '❌' : '•'} **${p.n}**${p.ovr ? ` \`${p.ovr}\`` : ''}${p.set ? ` *(${p.set})*` : ''} — ${p.uid ? `${formatAmount(p.bid)} · ${teamOnly(gd, message.guild, p.uid)}` : `base ${formatAmount(p.base)}, no bids`}`
          ).join('\n').slice(0, 4000))
          .setFooter({ text: `Page ${pages.length + 1}/${Math.ceil(rows.length / per)} · ${rows.length} player(s) · ✅ you lead, ❌ outbid, 🔒 closed` }));
      }
      await openPaginate(message, pages.slice(0, 40));
      return;
    }

    if (cmd === 'hot' || cmd === 'contested') {
      const rows = Object.values(o.players).filter(p => (p.count || 0) > 0)
        .sort((a, b) => (b.count || 0) - (a.count || 0) || b.bid - a.bid).slice(0, 15);
      if (!rows.length) { await message.channel.send('📭 No bids yet.'); return; }
      await message.channel.send({ embeds: [new EmbedBuilder().setTitle('🔥 Most contested').setColor(0xE67E22)
        .setDescription(rows.map((p, i) => `\`${i + 1}.\` **${p.n}** — ${p.count} bid(s), now **${formatAmount(p.bid)}** (${teamOnly(gd, message.guild, p.uid)})`).join('\n').slice(0, 4000))
        .setTimestamp()] });
      return;
    }

    if (cmd === 'feed' || cmd === 'activity' || cmd === 'recent') {
      const feed = (o.feed || []).slice(0, 15);
      if (!feed.length) { await message.channel.send('📭 No bids yet.'); return; }
      await message.channel.send({ embeds: [new EmbedBuilder().setTitle('📡 Latest bids').setColor(0x5865F2)
        .setDescription(feed.map(f => `• **${(o.players[f.k] || {}).n || f.k}** — ${formatAmount(f.a)} · ${teamOnly(gd, message.guild, f.u)} ${ts(f.t, 'R')}`).join('\n').slice(0, 4000))
        .setTimestamp()] });
      return;
    }

    // ── Watchlist & notifications ──────────────────────────────────────────
    if (cmd === 'watch' || cmd === 'w' || cmd === 'unwatch' || cmd === 'watchlist') {
      o.watch = o.watch || {};
      o.watch[userId] = o.watch[userId] || [];
      const sub = (parts[1] || '').toLowerCase();
      if (cmd === 'watchlist' || (!rest && cmd !== 'unwatch')) {
        const list = o.watch[userId].map(k => o.players[k]).filter(Boolean);
        await message.channel.send({ embeds: [new EmbedBuilder().setTitle('👀 Your watchlist').setColor(0x9B59B6)
          .setDescription((list.map(p => `• **${p.n}** — ${p.uid ? `${formatAmount(p.bid)} (${teamOnly(gd, message.guild, p.uid)})` : `base ${formatAmount(p.base)}`}${p.closed ? ' 🔒' : ` · ${ts(p.closesAt, 'R')}`}`).join('\n') || `*empty* — add with \`${openPfx}watch <player>\``).slice(0, 4000))
          .setFooter({ text: 'I DM you when a watched player is bid on, and 30m before it closes.' })] });
        return;
      }
      if (sub === 'clear') { o.watch[userId] = []; scheduleAuctionSave(); await message.channel.send('🗑️ Watchlist cleared.'); return; }
      const target = await resolveOrTell(rest.replace(/^(add|rem|remove)\s+/i, ''));
      if (!target) return;
      const i = o.watch[userId].indexOf(target.key);
      if (cmd === 'unwatch' || i !== -1) {
        if (i !== -1) o.watch[userId].splice(i, 1);
        scheduleAuctionSave();
        await message.channel.send(`👀 Removed **${target.p.n}** from your watchlist.`);
      } else {
        o.watch[userId].push(target.key);
        scheduleAuctionSave();
        await message.channel.send(`👀 Watching **${target.p.n}** — I'll DM you on every bid and 30m before it closes.`);
      }
      return;
    }

    if (cmd === 'notify') {
      const on = /^(on|yes|true)$/i.test(parts[1] || '');
      const off = /^(off|no|false)$/i.test(parts[1] || '');
      if (!on && !off) { await message.channel.send(`❌ Usage: \`${openPfx}notify on\` / \`${openPfx}notify off\``); return; }
      o.noDm = o.noDm || {};
      if (on) delete o.noDm[userId]; else o.noDm[userId] = true;
      scheduleAuctionSave();
      await message.channel.send(on ? '🔔 Outbid DMs **on**.' : '🔕 Outbid DMs **off** — you\'ll have to check `mybids` yourself.');
      return;
    }

    if (cmd === 'sets' || cmd === 'setlist') {
      const all = Object.values(o.players);
      if (!all.length) { await message.channel.send(`📭 No open auction pool loaded — a host can add one with \`${openPfx}openpool\`.`); return; }
      const rows = {};
      for (const pl of all) {
        const s = setNameOf(pl);
        const e = rows[s] = rows[s] || { n: 0, open: 0, sold: 0, money: 0 };
        e.n++;
        if (!pl.closed) e.open++;
        if (pl.settled) e.sold++;
        e.money += pl.bid || 0;
      }
      const embed = new EmbedBuilder().setTitle('🗂️ Sets').setColor(0x00B2FF)
        .setDescription(Object.entries(rows).map(([s, e]) =>
          `**${s}** — ${e.n} player(s) · ${e.open ? `${e.open} open` : 'all closed'}${e.sold ? ` · ${e.sold} sold` : ''} · ${formatAmount(e.money)} bid`
        ).join('\n').slice(0, 4000))
        .setFooter({ text: `${openPfx}players <set> to browse one · hosts close a set with ${openPfx}closeset <set>` });
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // ── Status & results ───────────────────────────────────────────────────
    if (cmd === 'status' || cmd === 'ostatus' || cmd === 'open') {
      const all = Object.values(o.players);
      if (!all.length) { await message.channel.send(`📭 No open auction pool loaded — a host can add one with \`${openPfx}openpool\`.`); return; }
      const openNow = all.filter(p => !p.closed).length;
      const withBids = all.filter(p => p.uid).length;
      const money = all.reduce((s, p) => s + (p.bid || 0), 0);
      const embed = new EmbedBuilder()
        .setTitle(o.active ? (o.paused ? '⏸️ Open Auction — paused' : '💸 Open Auction — live') : o.settledAt ? '🏁 Open Auction — settled' : '📋 Open Auction — not started')
        .setColor(o.active ? (o.paused ? 0xFFA500 : 0x00FF00) : 0x95A5A6)
        .addFields(
          { name: 'Players',  value: `${all.length} total · ${openNow} open · ${all.length - openNow} closed`, inline: false },
          { name: 'Bid on',   value: `${withBids} (${all.length - withBids} untouched)`, inline: true },
          { name: 'On the table', value: formatAmount(money), inline: true },
          { name: 'Teams',    value: String(new Set([...Object.keys(gd.purses || {}), ...Object.keys(gd.teams || {})]).size), inline: true }
        );
      if (o.active) embed.addFields(
        { name: 'Closes', value: `${ts(o.endsAt, 'F')} · ${ts(o.endsAt, 'R')}`, inline: false },
        { name: 'Rules',  value: `${o.cfg.maxSquad} slots · min raise ${formatAmount(o.cfg.minInc)} · anti-snipe ${o.cfg.antiSnipe}m · over-commit ${o.cfg.overcommit ? 'on' : 'off'}`, inline: false }
      );
      if (o.settledAt) embed.addFields({ name: 'Settled', value: `${ts(o.settledAt, 'R')} — \`${openPfx}results\``, inline: false });
      const spenders = [...new Set([...Object.keys(gd.purses || {})])]
        .map(uid => ({ uid, c: openCommitted(o, uid) })).filter(r => r.c > 0)
        .sort((a, b) => b.c - a.c).slice(0, 5);
      if (spenders.length) embed.addFields({ name: 'Top committed', value: spenders.map(r => `**${teamOnly(gd, message.guild, r.uid)}** — ${formatAmount(r.c)}`).join('\n').slice(0, 1024), inline: false });
      embed.setTimestamp();
      await message.channel.send({ embeds: [embed] });
      return;
    }

    if (cmd === 'results') {
      if (!o.results) { await message.channel.send('❌ Nothing settled yet.'); return; }
      const byTeam = {};
      for (const a of o.results.awards) (byTeam[a.uid] = byTeam[a.uid] || []).push(a);
      const pages = [];
      for (const [uid, list] of Object.entries(byTeam).sort((x, y) => y[1].reduce((s, a) => s + a.a, 0) - x[1].reduce((s, a) => s + a.a, 0))) {
        pages.push(new EmbedBuilder().setTitle(`🏁 ${teamLabel(gd, message.guild, uid)}`).setColor(0xFFD700)
          .setDescription(list.map((a, i) => `\`${i + 1}.\` **${a.n}** — ${formatAmount(a.a)}`).join('\n').slice(0, 4000))
          .setFooter({ text: `${list.length} player(s) · ${formatAmount(list.reduce((s, a) => s + a.a, 0))} spent · settled ${new Date(o.results.at).toLocaleString()}` }));
      }
      if (!pages.length) pages.push(new EmbedBuilder().setTitle('🏁 Results').setColor(0xFFD700).setDescription('Nobody won anything.'));
      await openPaginate(message, pages);
      return;
    }

    if (cmd === 'unsold') {
      const list = o.results ? o.results.unsold : Object.values(o.players).filter(p => p.closed && !p.uid).map(p => p.n);
      if (!list.length) { await message.channel.send('✅ Nothing unsold.'); return; }
      await message.channel.send({ embeds: [new EmbedBuilder().setTitle(`📭 Unsold (${list.length})`).setColor(0x95A5A6)
        .setDescription(list.slice(0, 100).join(', ').slice(0, 4000))] });
      return;
    }

    // Unknown command under this prefix. Stay quiet by default — the prefix is a
    // normal character and "$5 each" in chat must not get a reply — but answer
    // anything that is clearly someone looking for the command list.
    if (['help', 'h', 'commands', 'cmds', 'auction', 'openauction', 'ohelp1'].includes(cmd)) {
      await message.channel.send(`❓ Open auction help is \`${openPfx}ohelp\` (bidding) and \`${openPfx}ohelp2\` (host commands).`);
    }
    return;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  AUCTION COMMANDS  (. prefix)
  // ════════════════════════════════════════════════════════════════════════

  if (usesAuc && guildId) {
    const gd = getGuildData(guildId);
    const parts = aucRaw.split(/\s+/);
    const cmd   = parts[0].toLowerCase();

    // .ahelp / .ahelp2 — auction help, always available (even on unapproved servers)
    if (cmd === 'ahelp' || cmd === 'ahelp2') {
      const page1 = () => auctionHelpPage1(aucPfx, `Page 1/2 — click 🔧 Admin below or use ${aucPfx}ahelp2`);
      const page2 = () => auctionHelpPage2(aucPfx, `Page 2/2 — click 🏏 Bidding below or use ${aucPfx}ahelp`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ahelp_p1').setLabel('🏏 Bidding & Queue').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('ahelp_p2').setLabel('🔧 Admin').setStyle(ButtonStyle.Secondary),
      );
      const sent = await message.channel.send({ embeds: [cmd === 'ahelp2' ? page2() : page1()], components: [row] });
      const collector = sent.createMessageComponentCollector({ filter: i => i.user.id === userId, time: 60_000 });
      collector.on('collect', async i => {
        if (i.customId === 'ahelp_p1') await i.update({ embeds: [page1()], components: [row] });
        if (i.customId === 'ahelp_p2') await i.update({ embeds: [page2()], components: [row] });
      });
      collector.on('end', (_, reason) => { if (reason === 'time') sent.edit({ components: [] }).catch(() => {}); });
      return;
    }

    // Allow approve/unapprove/listapprovals even on unapproved servers (owner only)
    const ownerOnlyCmds = ['approveauction','approvecg','unapproveauction','unapprovecg','listapprovals','sync'];
    if (!ownerOnlyCmds.includes(cmd) && !isAuctionApproved(guildId)) {
      await message.channel.send('⛔ This server is not approved for auction commands.\nContact **frenzy_guy** to get access.');
      return;
    }

    // .dmallow / .dmdeny / .dmlist — owner grants who may use .dm in this server
    if (cmd === 'dmallow' || cmd === 'dmdeny' || cmd === 'dmlist') {
      if (userId !== OWNER_ID) { await message.channel.send('❌ Owner only!'); return; }
      gd.dmAllowed = gd.dmAllowed || {};
      if (cmd === 'dmlist') {
        const entries = Object.values(gd.dmAllowed);
        await message.channel.send(entries.length
          ? `📨 **Users allowed to use \`${aucPfx}dm\`:**\n${entries.map(t => `• ${t}`).join('\n')}`
          : `📨 No one has \`${aucPfx}dm\` permission in this server yet. Grant with \`${aucPfx}dmallow @user\`.`);
        return;
      }
      const mentioned = message.mentions.members.first();
      if (!mentioned) { await message.channel.send(`❌ Usage: \`${aucPfx}${cmd} @user\``); return; }
      if (cmd === 'dmallow') {
        gd.dmAllowed[mentioned.id] = mentioned.user.tag;
        scheduleAuctionSave();
        await message.channel.send(`✅ **${mentioned.user.tag}** can now use \`${aucPfx}dm @role <message>\` in this server.`);
      } else {
        if (!gd.dmAllowed[mentioned.id]) { await message.channel.send(`❌ **${mentioned.user.tag}** doesn't have \`${aucPfx}dm\` permission.`); return; }
        delete gd.dmAllowed[mentioned.id];
        scheduleAuctionSave();
        await message.channel.send(`✅ \`${aucPfx}dm\` permission removed from **${mentioned.user.tag}**.`);
      }
      return;
    }

    // .dm / .gdm @role|@user|username <message> — DM a single user, or everyone with a role
    // (owner or dmallow'd users). .gdm is a "ghost" DM: just the raw message, no embed,
    // no sender, no server name.
    if (cmd === 'dm' || cmd === 'gdm') {
      const ghost = cmd === 'gdm';
      const canDm = userId === OWNER_ID || !!(gd.dmAllowed && gd.dmAllowed[userId]);
      if (!canDm) { await message.channel.send(`❌ You need permission from the owner to use this. (\`${aucPfx}dmallow\`)`); return; }

      // Target = first token after the command: <@&id> = role mention, <@id>/<@!id> = user mention,
      // anything else is treated as a username (the unique one, no @ needed)
      if (!parts[1]) { await message.channel.send(`❌ Usage: \`${aucPfx}${cmd} @role <message>\`, \`${aucPfx}${cmd} @user <message>\` or \`${aucPfx}${cmd} <username> <message>\``); return; }
      const mentionToken = parts[1];
      const msgText = aucRaw.slice(aucRaw.indexOf(mentionToken) + mentionToken.length).trim();
      if (!msgText) { await message.channel.send(`❌ No message given. Usage: \`${aucPfx}${cmd} @role|@user|<username> <message>\``); return; }

      const isRoleTarget = /^<@&\d+>$/.test(mentionToken);
      const isUserMention = /^<@!?\d+>$/.test(mentionToken);
      const role = isRoleTarget ? message.mentions.roles.first() : null;
      let member = isUserMention ? message.mentions.members.first() : null;
      if (isRoleTarget && !role) { await message.channel.send('❌ Could not resolve that role.'); return; }
      if (isUserMention && !member) { await message.channel.send('❌ Could not resolve that user.'); return; }

      // Plain text → look the member up by username (case-insensitive)
      if (!isRoleTarget && !member) {
        try { await message.guild.members.fetch(); } catch (_) {}
        const q = mentionToken.toLowerCase();
        member = message.guild.members.cache.find(m => m.user.username.toLowerCase() === q)
              || (/^\d{5,}$/.test(q) ? message.guild.members.cache.get(q) : null);
        if (!member) { await message.channel.send(`❌ No member found with the username **${mentionToken}**.`); return; }
      }

      let targets, targetLabel;
      if (isRoleTarget) {
        // Populate the member cache so role.members is complete
        try { await message.guild.members.fetch(); } catch (_) {}
        targets = role.members.filter(m => !m.user.bot);
        targetLabel = `@${role.name}`;
        if (targets.size === 0) { await message.channel.send(`❌ No (non-bot) members have the **${role.name}** role.`); return; }
      } else {
        if (member.user.bot) { await message.channel.send('❌ Cannot DM a bot.'); return; }
        targets = new Map([[member.id, member]]);
        targetLabel = member.user.tag;
      }

      const count = targets.size;
      const status = await message.channel.send(`📨 Sending ${ghost ? 'ghost ' : ''}DM to **${count}** member(s) — **${targetLabel}**...`);
      let payload;
      if (ghost) {
        payload = { content: msgText.slice(0, 2000) }; // bare message — no embed, no sender, no server
      } else {
        payload = { embeds: [new EmbedBuilder()
          .setTitle(`📨 Message for ${targetLabel}`)
          .setDescription(msgText.slice(0, 4096))
          .setColor((isRoleTarget && role.color) || 0x5865F2)
          .setFooter({ text: `Sent by ${message.author.tag} • ${message.guild.name}` })
          .setTimestamp()] };
      }

      let sent = 0, failed = 0;
      for (const m of targets.values()) {
        try { await m.send(payload); sent++; }
        catch (_) { failed++; } // DMs closed / blocked the bot
        if (count > 1) await new Promise(r => setTimeout(r, 350)); // stay under DM rate limits
      }
      await status.edit(`✅ ${ghost ? 'Ghost ' : ''}DM sent to **${sent}** member(s) — **${targetLabel}**.${failed ? ` ⚠️ ${failed} couldn't be reached (DMs closed).` : ''}`).catch(() => {});
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

    // .setlogchannel / .slc [type] #channel  — type: sold | unsold | trade | all (default)
    if (cmd === 'setlogchannel' || cmd === 'slc') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const chMention = (id) => (id ? `<#${id}>` : '*(falls back to general)*');

      // No channel mentioned → show current config
      if (!message.mentions.channels.first()) {
        const embed = new EmbedBuilder().setTitle('📋 Log Channels').setColor(0x0099FF)
          .addFields(
            { name: 'General (default)', value: gd.logChannel ? `<#${gd.logChannel}>` : '*(not set)*', inline: false },
            { name: '🔨 Sold',   value: chMention(gd.soldChannel),   inline: true },
            { name: '🔨 Unsold', value: chMention(gd.unsoldChannel), inline: true },
            { name: '🔄 Trade',  value: chMention(gd.tradeChannel),  inline: true },
            { name: '🏏 Draft',  value: chMention(gd.draftChannel),  inline: true },
            { name: '⏭️ Skip',   value: chMention(gd.skipChannel),   inline: true },
            { name: '💵 Pay',    value: chMention(gd.payChannel),    inline: true }
          ).setFooter({ text: `${aucPfx}slc [sold|unsold|trade|draft|skip|pay|all] #channel` });
        await message.channel.send({ embeds: [embed] }); return;
      }

      const ch    = message.mentions.channels.first();
      const types = ['sold', 'unsold', 'trade', 'draft', 'skip', 'pay', 'all', 'default', 'general'];
      const type  = types.includes((parts[1] || '').toLowerCase()) ? parts[1].toLowerCase() : 'all';
      let label;
      if (type === 'sold')        { gd.soldChannel   = ch.id; label = '🔨 SOLD logs'; }
      else if (type === 'unsold') { gd.unsoldChannel = ch.id; label = '🔨 UNSOLD logs'; }
      else if (type === 'trade')  { gd.tradeChannel  = ch.id; label = '🔄 Trade logs'; }
      else if (type === 'draft')  { gd.draftChannel  = ch.id; label = '🏏 Draft pick logs'; }
      else if (type === 'skip')   { gd.skipChannel   = ch.id; label = '⏭️ Draft skip logs'; }
      else if (type === 'pay')    { gd.payChannel    = ch.id; label = '💵 Staff payment logs'; }
      else                        { gd.logChannel    = ch.id; label = 'General logs (default for all types)'; }
      scheduleAuctionSave();
      const embed = new EmbedBuilder().setTitle('📋 Log Channel Set').setColor(0x0099FF)
        .setDescription(`**${label}** → ${ch}`);
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

    // .setsquadlimit / .ssl  — set min & max players per squad (0 = no limit)
    if (cmd === 'setsquadlimit' || cmd === 'ssl') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      // No args → show current limits
      if (!parts[1]) {
        const embed = new EmbedBuilder().setTitle('📐 Squad Limits').setColor(0x5865F2)
          .addFields(
            { name: 'Min Players', value: (gd.minSquad || 0) ? String(gd.minSquad) : 'None', inline: true },
            { name: 'Max Players', value: (gd.maxSquad || 0) ? String(gd.maxSquad) : 'None', inline: true }
          ).setFooter({ text: `Set with ${aucPfx}ssl <min> <max> — use 0 for no limit` });
        await message.channel.send({ embeds: [embed] }); return;
      }
      const min = parseInt(parts[1]);
      const max = parts[2] !== undefined ? parseInt(parts[2]) : (gd.maxSquad || 0);
      if (isNaN(min) || min < 0 || isNaN(max) || max < 0) {
        await message.channel.send(`❌ Usage: \`${aucPfx}ssl <min> <max>\` (use 0 for no limit)`); return;
      }
      if (max > 0 && min > max) { await message.channel.send('❌ Min cannot be greater than max.'); return; }
      gd.minSquad = min; gd.maxSquad = max; scheduleAuctionSave();
      const embed = new EmbedBuilder().setTitle('📐 Squad Limits Set').setColor(0xFF8800)
        .addFields(
          { name: 'Min Players', value: min ? String(min) : 'None', inline: true },
          { name: 'Max Players', value: max ? String(max) : 'None', inline: true }
        ).setFooter({ text: `Set by ${message.author.tag}` });
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .settimer / .st  — countdown after each bid (0 = off, max 300s)
    if (cmd === 'settimer' || cmd === 'st') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      if (!parts[1]) {
        const cur = gd.auctionTimer || 0;
        await message.channel.send(cur
          ? `⏱️ Auction timer is **${cur}s**. After each bid a countdown starts; a new bid resets it. Set to \`0\` to disable.`
          : `⏱️ Auction timer is **off**. Set with \`${aucPfx}st <seconds>\` (1–300).`);
        return;
      }
      const secs = parseInt(parts[1]);
      if (isNaN(secs) || secs < 0 || secs > 300) {
        await message.channel.send(`❌ Usage: \`${aucPfx}st <seconds>\` — 0 disables, max 300.`); return;
      }
      gd.auctionTimer = secs; scheduleAuctionSave();
      if (!secs) cancelAuctionTimer(guildId); // kill any running countdown
      const embed = new EmbedBuilder().setColor(0xFF8800)
        .setTitle(secs ? '⏱️ Auction Timer Set' : '⏱️ Auction Timer Disabled')
        .setDescription(secs
          ? `After each bid, a **${secs}s** countdown starts. A new bid resets it; if it hits zero the player is auto-sold (big **3 → 2 → 1** in the last seconds).`
          : 'No countdown will run after bids.')
        .setFooter({ text: `Set by ${message.author.tag}` });
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
      cancelPendingStart(guildId); // a manual sell overrides any scheduled .startin
      gd.auction = { player: playerName, base, current_bid: base, difference: diff, set: null,
        highest_bidder: null, highest_bidder_id: null, channel_id: String(message.channel.id) };
      scheduleAuctionSave();
      const embed = new EmbedBuilder().setTitle('🏏 AUCTION STARTED!').setColor(0xFF0000)
        .addFields(
          { name: 'Player',        value: `**${playerName}**`,  inline: true },
          { name: 'Base Price',    value: formatAmount(base),   inline: true },
          { name: 'Min Increment', value: formatAmount(diff),   inline: true },
          { name: 'How to bid',    value: `Use \`${aucPfx}bid <amount>\``, inline: false }
        ).setFooter({ text: `Started by ${message.author.tag}` }).setTimestamp();
      if (gd.auctionTimer) embed.addFields({ name: '⏱️ Timer', value: `${gd.auctionTimer}s — no bid before 0 = UNSOLD; each bid resets it.`, inline: false });
      await message.channel.send({ embeds: [embed] });
      startAuctionTimer(message.guild, message.channel, gd); // counts down even with no bids
      return;
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

      // Block bids from a full squad (max limit reached)
      const maxSquad  = gd.maxSquad || 0;
      const squadSize = (gd.squads[userId] || []).length;
      if (maxSquad > 0 && squadSize >= maxSquad) {
        await message.channel.send(`❌ Your squad is full (**${squadSize}/${maxSquad}**) — you can't bid for more players.`);
        return;
      }

      const userPurse = gd.purses[userId] || 0;
      // Increment-only bidding — no direct jumps. Any amount typed is ignored.
      // First bid opens at the base price; every bid after raises by the increment.
      const bidAmt = auction.highest_bidder_id ? auction.current_bid + auction.difference : auction.base;
      if (userPurse < bidAmt) { await message.channel.send(`❌ Insufficient funds! Your balance: **${formatAmount(userPurse)}**`); return; }
      auction.current_bid       = bidAmt;
      auction.highest_bidder    = message.member.displayName;
      auction.highest_bidder_id = userId;
      scheduleAuctionSave();
      // Reset the countdown NOW — before any await — so a near-expiry timer is
      // cancelled synchronously and can't auto-sell during the message send.
      startAuctionTimer(message.guild, message.channel, gd);
      const embed = new EmbedBuilder().setTitle('💸 New Bid Placed!').setColor(0x00CC00)
        .addFields(
          { name: 'Player', value: auction.player,                          inline: true },
          { name: 'Bid',    value: formatAmount(bidAmt),                    inline: true },
          { name: 'Bidder', value: teamOnly(gd, message.guild, userId),     inline: true }
        );
      if (gd.auctionTimer) embed.setFooter({ text: `⏱️ Timer reset to ${gd.auctionTimer}s.` });
      embed.setTimestamp();
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // .sold
    if (cmd === 'sold') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      await doSold(message.guild, message.channel, gd); return;
    }

    // .addqueue / .aq  — add one OR many (one per line / comma-separated), no set
    // .addqueueset / .aqs <set> — same but tag every player with a set name
    if (cmd === 'addqueue' || cmd === 'aq' || cmd === 'addqueueset' || cmd === 'aqs') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const isSet = (cmd === 'addqueueset' || cmd === 'aqs');
      let body = aucRaw.slice(parts[0].length).trim();
      let setName = null;
      if (isSet) {
        const m = body.match(/^(\S+)\s+([\s\S]+)$/); // first token = set name, rest = players
        if (!m) {
          await message.channel.send(`❌ Usage: \`${aucPfx}aqs <set> <player> <base> [inc]\` — set name is one word; add several players one per line or comma-separated.`);
          return;
        }
        setName = m[1]; body = m[2].trim();
      }
      if (!body) {
        await message.channel.send(
          `❌ Usage: \`${aucPfx}${isSet ? 'aqs <set> ' : ''}<player> <base> [increment]\`\nAdd several at once — one per line or comma-separated:\n\`\`\`\n${aucPfx}${isSet ? 'aqs Marquee\n' : 'aq '}Kohli 2000000\nRohit 1500000 100000\nMS Dhoni 1000000\n\`\`\``
        );
        return;
      }
      if (!Array.isArray(gd.queue)) gd.queue = [];

      const { items, failed } = parseQueueEntries(body, gd.difference || 500000);
      if (items.length === 0) {
        await message.channel.send(`❌ Couldn't parse any entries. Usage: \`${aucPfx}${isSet ? 'aqs <set> ' : ''}<player> <base> [increment]\` — one per line or comma-separated.`);
        return;
      }
      for (const it of items) gd.queue.push({ player: it.player, base: it.base, difference: it.diff, set: setName });
      scheduleAuctionSave();

      const startPos = gd.queue.length - items.length + 1;
      const lines = items.map((a, i) => `\`#${startPos + i}\` **${a.player}** — Base ${formatAmount(a.base)}, Inc ${formatAmount(a.diff)}`);
      const embed = new EmbedBuilder()
        .setTitle(items.length === 1 ? '📋 Player Added to Queue' : `📋 ${items.length} Players Added to Queue`)
        .setColor(0x5865F2)
        .setDescription((setName ? `**Set: ${setName}**\n` : '') + lines.join('\n').slice(0, 4000))
        .setFooter({ text: `Added by ${message.author.tag} • ${gd.queue.length} in queue` })
        .setTimestamp();
      if (failed.length) embed.addFields({ name: `⚠️ Skipped ${failed.length}`, value: failed.map(f => `• ${f}`).join('\n').slice(0, 1024) });
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .startqueue / .sq  — start (or resume) the queue from the front
    if (cmd === 'startqueue' || cmd === 'sq') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      if (gd.auction) { await message.channel.send(`❌ Auction already running! Use \`${aucPfx}sold\` first.`); return; }
      if (!gd.queue || gd.queue.length === 0) { await message.channel.send(`❌ Queue is empty. Add players with \`${aucPfx}aq\` first.`); return; }
      cancelPendingStart(guildId); // a manual start overrides any scheduled .startin
      await startNextFromQueue(message.guild, message.channel, gd, message.author.tag);
      return;
    }

    // .startin / .si <seconds>  — countdown before each auto-advanced player (0 = off)
    if (cmd === 'startin' || cmd === 'si') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      if (!parts[1]) {
        const cur = gd.nextDelay || 0;
        await message.channel.send(cur
          ? `⏳ Next-player countdown is **${cur}s** — after each sale the next queued player auto-starts after a ${cur}s countdown. Set \`${aucPfx}si 0\` to disable.`
          : `⏳ Next-player countdown is **off**. Set with \`${aucPfx}si <seconds>\` (1–3600).`);
        return;
      }
      const secs = parseInt(parts[1]);
      if (isNaN(secs) || secs < 0 || secs > 3600) { await message.channel.send(`❌ Usage: \`${aucPfx}si <seconds>\` — 0 disables, max 3600.`); return; }
      gd.nextDelay = secs; scheduleAuctionSave();
      if (!secs) cancelPendingStart(guildId); // kill any in-flight countdown
      const embed = new EmbedBuilder().setColor(0x00B0F4)
        .setTitle(secs ? '⏳ Next-Player Countdown Set' : '⏳ Next-Player Countdown Disabled')
        .setDescription(secs
          ? `After each sale, the next queued player comes up for bidding after a **${secs}s** countdown (big 3 → 2 → 1). Applies within a set; set boundaries still wait for \`${aucPfx}sq\`.`
          : 'The next queued player will start immediately after each sale.')
        .setFooter({ text: `Set by ${message.author.tag}` });
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .stopqueue / .stq  — stop auto-advance at any time (current auction stays live)
    if (cmd === 'stopqueue' || cmd === 'stq') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      cancelPendingStart(guildId); // also cancels a scheduled .startin
      gd.queuePaused = true; scheduleAuctionSave();
      const embed = new EmbedBuilder().setTitle('⏸️ Queue Stopped').setColor(0xAAAAAA)
        .setDescription(`The queue won't auto-advance after the next sale.${gd.auction ? ` The current auction (**${gd.auction.player}**) is still live.` : ''}\nUse \`${aucPfx}sq\` to start the next player when ready.`)
        .setFooter({ text: `Stopped by ${message.author.tag}` });
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .queue / .q  — one set per page, navigate with ◀ ▶ buttons
    if (cmd === 'queue' || cmd === 'q') {
      if (!gd.queue || gd.queue.length === 0) {
        const embed = new EmbedBuilder().setTitle('📋 Auction Queue').setColor(0x5865F2).setTimestamp();
        if (gd.auction) embed.addFields({ name: '🔴 Currently Auctioning',
          value: `**${gd.auction.player}**${gd.auction.set ? ` *(set: ${gd.auction.set})*` : ''} — Current Bid: ${formatAmount(gd.auction.current_bid)}`, inline: false });
        embed.setDescription(gd.queuePaused ? '⏸️ *Queue is stopped.*' : null);
        embed.addFields({ name: 'Queue', value: 'Queue is empty.', inline: false });
        await message.channel.send({ embeds: [embed] }); return;
      }

      const groups = queueGroups(gd);
      let page = 0;
      const makeRow = (p) => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('q_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
        new ButtonBuilder().setCustomId('q_set').setLabel(`Set ${p + 1}/${groups.length}`).setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('q_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(p === groups.length - 1)
      );
      const components = groups.length > 1 ? [makeRow(page)] : [];
      const sent = await message.channel.send({ embeds: [queuePageEmbed(gd, aucPfx, groups, page)], components });
      if (groups.length <= 1) return;

      const collector = sent.createMessageComponentCollector({ filter: i => i.user.id === userId, time: 120_000 });
      collector.on('collect', async i => {
        if (i.customId === 'q_prev' && page > 0) page--;
        if (i.customId === 'q_next' && page < groups.length - 1) page++;
        await i.update({ embeds: [queuePageEmbed(gd, aucPfx, groups, page)], components: [makeRow(page)] });
      });
      collector.on('end', (_, reason) => { if (reason === 'time') sent.edit({ components: [] }).catch(() => {}); });
      return;
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
      cancelPendingStart(guildId); // a scheduled .startin has nothing to start anymore
      const count = (gd.queue || []).length;
      gd.queue = []; scheduleAuctionSave();
      await message.channel.send(`🗑️ Cleared **${count}** player(s) from the queue.`); return;
    }

    // .team [@user] <name> — set a team name (self, or anyone if Admin/Auctioneer).
    // `clear` removes it. No name shows the current one.
    if (cmd === 'team' || cmd === 'setteam') {
      if (!gd.teams) gd.teams = {};
      const mentioned = message.mentions.members.first();
      const target = mentioned || message.member;
      if (target.id !== userId && !hasAuctionPermission(message.member)) {
        await message.channel.send("❌ You need **Administrator** or **Auctioneer** role to set someone else's team name."); return;
      }
      let nameRaw = aucRaw.slice(parts[0].length).replace(/<@!?\d+>/g, '').trim();
      if (!nameRaw) {
        const cur = gd.teams[target.id];
        await message.channel.send(cur
          ? `🏷️ **${target.displayName}**'s team name is **${cur}**.`
          : `🏷️ **${target.displayName}** has no team name yet. Set with \`${aucPfx}team ${target.id === userId ? '' : '@user '}<name>\`.`);
        return;
      }
      if (['clear', 'remove', 'none', 'reset'].includes(nameRaw.toLowerCase())) {
        delete gd.teams[target.id]; scheduleAuctionSave();
        await message.channel.send(`🏷️ Cleared **${target.displayName}**'s team name.`); return;
      }
      nameRaw = nameRaw.slice(0, 50);
      gd.teams[target.id] = nameRaw; scheduleAuctionSave();
      const embed = new EmbedBuilder().setTitle('🏷️ Team Name Set').setColor(0x00B0F4)
        .setDescription(`${target} is now **${nameRaw}**.`)
        .setFooter({ text: `Set by ${message.author.tag}` });
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .bal / .wallet [@user | teamname]
    if (cmd === 'bal' || cmd === 'wallet') {
      const argText  = aucRaw.slice(parts[0].length).trim();
      const resolved = resolveMemberTarget(gd, message, argText);
      if (!resolved) { await message.channel.send(`❌ No member or team named "${argText}" found.`); return; }
      const amount = gd.purses[resolved.id] || 0;
      const embed = new EmbedBuilder().setTitle(`💼 ${teamLabel(gd, message.guild, resolved.id)}'s Wallet`)
        .setDescription(`**Balance:** ${formatAmount(amount)}`).setColor(0xFFD700);
      if (resolved.member) embed.setThumbnail(resolved.member.user.displayAvatarURL());
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
          const name   = teamLabel(gd, message.guild, uid);
          const medal  = i < 3 ? medals[i] : `\`${i+1}.\``;
          return `${medal} **${name}** — ${formatAmount(amt)}`;
        });
        embed.setDescription(lines.join('\n'));
      }
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .squad [@user | teamname]
    if (cmd === 'squad') {
      const argText  = aucRaw.slice(parts[0].length).trim();
      const resolved = resolveMemberTarget(gd, message, argText);
      if (!resolved) { await message.channel.send(`❌ No member or team named "${argText}" found.`); return; }
      const players = (gd.squads && gd.squads[resolved.id]) || [];
      const embed   = new EmbedBuilder().setTitle(`🏏 ${teamLabel(gd, message.guild, resolved.id)}'s Squad`).setColor(0x0099FF).setTimestamp();
      if (resolved.member) embed.setThumbnail(resolved.member.user.displayAvatarURL());
      if (players.length === 0) {
        embed.setDescription('No players bought yet.');
      } else {
        // Drafted → round taken; bought → price; added with no price → retained
        const draftRoundOf = (name) => {
          const pk = ((gd.draft && gd.draft.picks) || []).find(x => x.userId === resolved.id && normPlayer(x.player) === normPlayer(name));
          return pk ? pk.round : null;
        };
        embed.setDescription(players.map((p, i) => {
          const r = p.round || draftRoundOf(p.player);
          const tag = r ? `Draft — Round ${r}` : (p.price > 0 ? formatAmount(p.price) : 'Retained');
          return `\`${i + 1}.\` **${p.player}** — ${tag}`;
        }).join('\n'));
      }
      const min = gd.minSquad || 0, max = gd.maxSquad || 0;
      if (min || max) {
        const n = players.length;
        let val = max ? `${n}/${max} players` : `${n} player(s)`;
        if (min) val += n >= min ? ` • min ${min} met ✅` : ` • need ${min - n} more to reach min ${min} ⚠️`;
        embed.addFields({ name: 'Squad Limit', value: val, inline: false });
      }
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .squadstatus / .ss  — overview of every squad vs the limits
    if (cmd === 'squadstatus' || cmd === 'ss') {
      const min = gd.minSquad || 0, max = gd.maxSquad || 0;
      const entries = Object.entries(gd.squads || {}).filter(([, arr]) => Array.isArray(arr) && arr.length > 0);
      const embed = new EmbedBuilder().setTitle('📐 Squad Status').setColor(0x0099FF).setTimestamp()
        .setDescription(`Min: **${min || 'None'}**  •  Max: **${max || 'None'}**`);
      if (entries.length === 0) {
        embed.addFields({ name: 'Teams', value: 'No squads yet.', inline: false });
      } else {
        const lines = entries.sort((a, b) => b[1].length - a[1].length).map(([uid, arr]) => {
          const name   = teamLabel(gd, message.guild, uid);
          const n      = arr.length;
          let mark = ' ✅';
          if (min && n < min)        mark = ` ⚠️ need ${min - n}`;
          else if (max && n >= max)  mark = ' 🔒 full';
          return `**${name}** — ${max ? `${n}/${max}` : n}${mark}`;
        });
        embed.addFields({ name: 'Teams', value: lines.join('\n'), inline: false });
      }
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .delete
    if (cmd === 'delete') {
      if (!hasAuctionPermission(message.member)) {
        await message.channel.send('❌ You need **Administrator** or **Auctioneer** role.'); return;
      }
      const target = message.mentions.members.first();
      if (!target) { await message.channel.send(`❌ Usage: \`${aucPfx}delete @user <index|player name|all>\``); return; }
      const indexArg = parts[2];
      if (!indexArg) { await message.channel.send('❌ Provide an index, a player name, or `all`.'); return; }
      if (!gd.squads) gd.squads = {};
      if (['all','everyone','max'].includes(indexArg.toLowerCase())) {
        gd.squads[target.id] = [];
        // Wipe their draft pick records too, so the players become draftable again
        if (gd.draft && gd.draft.picks) gd.draft.picks = gd.draft.picks.filter(p => p.userId !== target.id);
        scheduleAuctionSave();
        await message.channel.send(`🗑️ Cleared all players from **${target.displayName}**'s squad.`); return;
      }
      const squad = gd.squads[target.id] || [];
      let idx = parseInt(indexArg) - 1;
      if (isNaN(idx) || parts.length > 3) {
        // Not a number (or multiple words) → treat everything after the mention as a player name
        const nameArg = parts.slice(2).join(' ');
        idx = squad.findIndex(p => normPlayer(p.player) === normPlayer(nameArg));
        if (idx < 0) { await message.channel.send(`❌ **${nameArg}** is not in **${target.displayName}**'s squad.`); return; }
      }
      if (idx < 0 || idx >= squad.length) {
        await message.channel.send(`❌ Invalid index. Squad has ${squad.length} player(s).`); return;
      }
      const removed = squad.splice(idx, 1)[0];
      gd.squads[target.id] = squad;
      // Scrub the draft record — otherwise draftpicks still lists them
      if (gd.draft && gd.draft.picks) gd.draft.picks = gd.draft.picks.filter(p => !(p.userId === target.id && normPlayer(p.player) === normPlayer(removed.player)));
      scheduleAuctionSave();
      await message.channel.send(`🗑️ Removed **${removed.player}** from **${target.displayName}**'s squad — they're free to be picked/bought again.`); return;
    }

    // ── DRAFT MODE ─────────────────────────────────────────────────────────
    // .draftstart <rounds> [seconds-per-pick]
    if (cmd === 'draftstart' || cmd === 'ds') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      if (gd.draft && gd.draft.active) { await message.channel.send(`❌ A draft is already running — \`${aucPfx}draftstop\` first.`); return; }
      const rounds = parseInt(parts[1]);
      if (!rounds || rounds < 1) { await message.channel.send(`❌ Usage: \`${aucPfx}draftstart <rounds> [seconds-per-pick]\``); return; }
      const secs = Math.min(300, Math.max(10, parseInt(parts[2]) || 30));
      // Draft roster if the host built one with draftadd, else everyone with a team name
      const participants = (gd.draftTeams && gd.draftTeams.length) ? [...gd.draftTeams] : Object.keys(gd.teams || {});
      if (participants.length < 2) { await message.channel.send(`❌ Need at least 2 teams — add them with \`${aucPfx}draftadd @user\` or set team names with \`${aucPfx}team @user <name>\`.`); return; }
      gd.draft = {
        active: true, phase: 'rounds',
        round: 1, totalRounds: rounds,
        participants, order: shuffled(participants), idx: 0,
        pickSeconds: secs, channelId: message.channel.id,
        picks: [], skips: [], makeupIdx: 0, turnToken: 0
      };
      scheduleAuctionSave();
      const lines = gd.draft.order.map((uid, i) => `**${i + 1}.** ${teamOnly(gd, message.guild, uid)}`).join('\n');
      const embed = new EmbedBuilder().setTitle('🏏 Draft Started!').setColor(0x00B2FF)
        .setDescription(`**${rounds}** round(s) · **${secs}s** per pick · fresh random order every round\nPicks happen **in this channel** — when pinged, just type the player's name. Retained/taken players don't count.\n${gd.draftAuto ? 'Rounds start **automatically**.' : `After each round the draft **pauses** — start the next with \`${aucPfx}nextround\`.`}`)
        .addFields({ name: 'Round 1 order', value: lines.slice(0, 1024), inline: false });
      await message.channel.send({ embeds: [embed] });
      await sendLogText(message.guild, { embeds: [new EmbedBuilder().setTitle('🏏 Draft Started')
        .setDescription(`**${rounds}** round(s) · **${participants.length}** teams · **${secs}s** per pick.`)
        .setColor(0x00B2FF).setTimestamp()] }, 'draft');
      await announceDraftTurn(message.guild, gd);
      return;
    }

    // .draftstop — cancel the draft (picks already made stay in squads)
    if (cmd === 'draftstop' || cmd === 'dstop') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      if (!gd.draft || !gd.draft.active) { await message.channel.send('❌ No draft is running.'); return; }
      clearDraftTimer(guildId);
      gd.draft.active = false;
      scheduleAuctionSave();
      await message.channel.send(`🛑 Draft stopped — **${gd.draft.picks.length}** pick(s) already made stay in the squads.`);
      return;
    }

    // .resetall [full] confirm — wipe the server's draft data for a fresh season
    if (cmd === 'resetall') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const full = (parts[1] || '').toLowerCase() === 'full';
      const confirmed = parts.map(p => p.toLowerCase()).includes('confirm');
      if (!confirmed) {
        await message.channel.send(
          `⚠️ **This wipes for the whole server:** all squads, the draft (state, picks, roster), the player pool and every preset order.` +
          (full ? ' **Plus all team names and purses.**' : ` Team names & purses stay (\`${aucPfx}resetall full\` wipes those too).`) +
          `\nType \`${aucPfx}resetall ${full ? 'full ' : ''}confirm\` to do it.`);
        return;
      }
      clearDraftTimer(guildId);
      for (const [uid, p] of pendingSetorders) { if (p.guildId === guildId) pendingSetorders.delete(uid); }
      gd.squads = {}; gd.draft = null; gd.draftTeams = []; gd.draftPool = []; gd.draftPrefs = {};
      if (full) { gd.teams = {}; gd.purses = {}; }
      scheduleAuctionSave();
      await flushAuction(); // a wipe must hit JSONBin immediately
      await message.channel.send(`🧹 **Server reset complete** — squads, draft, pool and preset orders wiped${full ? ', plus team names and purses' : ''}. Fresh season!`);
      return;
    }

    // .draftresume — re-announce the current pick with a fresh timer (after a bot restart/stall)
    if (cmd === 'draftresume' || cmd === 'dr') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      if (!gd.draft || !gd.draft.active) { await message.channel.send('❌ No draft to resume.'); return; }
      if (gd.draft.waiting) { await message.channel.send(`⏸️ The draft is paused between rounds — use \`${aucPfx}nextround\` instead.`); return; }
      if (!message.guild.channels.cache.get(gd.draft.channelId)) gd.draft.channelId = message.channel.id; // original channel gone — re-home here
      await message.channel.send(`▶️ Resuming — the current pick restarts with a fresh timer in <#${gd.draft.channelId}>.`);
      await withDraftLock(guildId, () => announceDraftTurn(message.guild, gd))
        .catch(e => console.error('draftresume error:', e));
      return;
    }

    // .draftpool — load the player list (paste it or attach the cv pl .txt file).
    // When a pool is loaded, draft picks must be real players from it.
    if (cmd === 'draftpool' || cmd === 'dp') {
      // Whole command is host-only — members must not see the pool (they can only probe names via taken)
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const sub = (parts[1] || '').toLowerCase();
      const att = message.attachments.first();
      if (sub === 'clear') {
        gd.draftPool = []; scheduleAuctionSave();
        await message.channel.send('🗑️ Player pool cleared — draft picks can be any name again.');
        return;
      }
      // No paste and no file → status
      if (!att && parts.length < 2) {
        const pool = gd.draftPool || [];
        if (!pool.length) {
          await message.channel.send(`📋 No player pool loaded — any name is allowed in drafts.\nLoad one with \`${aucPfx}draftpool <pasted list>\` or attach the player-list .txt to \`${aucPfx}draftpool\`.`);
          return;
        }
        const sample = pool.slice(0, 10).join(', ');
        const availableCount = pool.filter(n => !findTakenPlayer(gd, n)).length;
        const embed = new EmbedBuilder().setTitle('📋 Player Pool').setColor(0x00B2FF)
          .setDescription(`**${pool.length}** players loaded, **${availableCount}** still available (retained/bought/drafted ones aren't) — draft picks must exist in this list.\nFirst few: ${sample}${pool.length > 10 ? ', …' : ''}`)
          .setFooter({ text: `${aucPfx}draftpool <paste|.txt attachment> appends · ${aucPfx}draftpool clear resets` });
        await message.channel.send({ embeds: [embed] });
        return;
      }
      let text = aucRaw.replace(/^\S+\s*/, '');
      if (att) {
        if (att.size > 2 * 1024 * 1024) { await message.channel.send('❌ File too big (max 2 MB).'); return; }
        try {
          text = await (await fetch(att.url)).text();
        } catch (e) {
          await message.channel.send('❌ Could not read the attached file — try again.'); return;
        }
      }
      const parsed = parsePlayerList(text);
      if (!parsed.length) { await message.channel.send('❌ No player names found in that.'); return; }
      gd.draftPool = gd.draftPool || [];
      const have = new Set(gd.draftPool.map(normPlayer));
      let added = 0;
      for (const name of parsed) {
        const key = normPlayer(name);
        if (have.has(key)) continue;
        have.add(key); gd.draftPool.push(name); added++;
        if (gd.draftPool.length >= 5000) break;
      }
      scheduleAuctionSave();
      await message.channel.send(`✅ Added **${added}** player(s)${parsed.length - added ? ` (${parsed.length - added} duplicates skipped)` : ''} — pool is now **${gd.draftPool.length}**. Draft picks must exist in it.`);
      return;
    }

    // .setorder — a team owner's preferred players; if their timer runs out the
    // bot auto-drafts the top one still available. Plain `.setorder` moves to
    // DMs so the order stays secret; `.myorder` DMs the saved list back.
    if (cmd === 'setorder' || cmd === 'so' || cmd === 'myorder' || cmd === 'mo') {
      if (!gd.setorderEnabled) {
        await message.channel.send(`❌ Preset draft orders are **disabled** here — an admin can turn them on with \`${aucPfx}autodraft on\`.`);
        return;
      }
      gd.draftPrefs = gd.draftPrefs || {};
      if ((parts[1] || '').toLowerCase() === 'clear') {
        delete gd.draftPrefs[userId]; scheduleAuctionSave();
        pendingSetorders.delete(userId);
        await message.channel.send('🗑️ Your draft order is cleared — timeouts will skip you now.');
        return;
      }
      if (cmd === 'myorder' || cmd === 'mo') {
        const list = gd.draftPrefs[userId] || [];
        if (!list.length) { await message.channel.send(`❌ No draft order set — run \`${aucPfx}setorder\` and I'll ask for it in DMs.`); return; }
        try {
          await message.author.send(`📜 **Your draft order (${list.length}):**\n${list.map((n, i) => `${i + 1}. ${n}`).join('\n')}`.slice(0, 1900));
          await message.channel.send('📬 Sent your draft order in DMs.');
        } catch (_) {
          await message.channel.send('❌ Could not DM you — enable DMs from server members and try again.');
        }
        return;
      }
      // `.setorder` with no list → ask for it in DMs
      if (parts.length < 2) {
        try {
          await message.author.send(
            `📝 **Draft order for ${message.guild.name}** — reply here with your preferred players, top choice first.\n` +
            `Comma-separated or one per line (a .txt attachment works too). You have 10 minutes.\n` +
            `If your pick timer runs out, I auto-draft your highest player still available. Short names are fine ("kohli" → Virat Kohli).`
          );
          pendingSetorders.set(userId, { guildId, expiresAt: Date.now() + SETORDER_DM_MS });
          await message.channel.send('📬 Check your DMs — send me your order there so nobody else sees it.');
        } catch (_) {
          await message.channel.send(`❌ Could not DM you — enable DMs from server members, or use \`${aucPfx}setorder <player1, player2, …>\` (I'll delete your message right after).`);
        }
        return;
      }
      // Inline form — still supported; the message is deleted to keep it secret
      const { cleaned, dropped } = saveDraftOrder(gd, userId, aucRaw.replace(/^\S+\s*/, ''));
      await message.delete().catch(() => {});
      await message.channel.send(`${draftOrderReply(cleaned, dropped).split('\n')[0]} *(tip: plain \`${aucPfx}setorder\` does this privately in DMs)*`);
      if (dropped.length) {
        await message.author.send(draftOrderReply(cleaned, dropped)).catch(() => {});
      }
      return;
    }

    // .draftadd @user [team name] — add an owner to the draft roster, optionally
    // naming their team in the same go (several @users at once works, without a name)
    if (cmd === 'draftadd' || cmd === 'da') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      if (gd.draft && gd.draft.active) { await message.channel.send('❌ Draft is running — roster is locked until it ends.'); return; }
      const mentioned = [...message.mentions.members.values()];
      if (!mentioned.length) { await message.channel.send(`❌ Usage: \`${aucPfx}draftadd @user [team name]\` — or several \`@users\` at once`); return; }
      const nameRaw = aucRaw.replace(/^\S+\s*/, '').replace(/<@!?\d+>/g, '').trim();
      if (nameRaw && mentioned.length > 1) { await message.channel.send('❌ Team name only works with a single @user at a time.'); return; }
      gd.draftTeams = gd.draftTeams || [];
      if (nameRaw) {
        gd.teams = gd.teams || {};
        gd.teams[mentioned[0].id] = nameRaw;
      }
      const added = [];
      for (const m of mentioned) {
        if (!gd.draftTeams.includes(m.id)) { gd.draftTeams.push(m.id); added.push(teamOnly(gd, message.guild, m.id)); }
      }
      scheduleAuctionSave();
      if (!added.length && nameRaw) {
        await message.channel.send(`✅ **${mentioned[0].displayName}** was already in the roster — team name updated to **${nameRaw}**.`);
      } else {
        await message.channel.send(added.length
          ? `✅ Added to the draft: **${added.join('**, **')}** — roster is now **${gd.draftTeams.length}** team(s).`
          : '❌ All of those are already in the draft roster.');
      }
      return;
    }

    // .nextround / .nr — start the next round (drafts pause between rounds unless draftauto is on)
    if (cmd === 'nextround' || cmd === 'nr') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      if (!gd.draft || !gd.draft.active) { await message.channel.send('❌ No draft is running.'); return; }
      if (!gd.draft.waiting) { await message.channel.send('❌ The draft is not paused — a pick is already live.'); return; }
      gd.draft.waiting = false;
      scheduleAuctionSave();
      await withDraftLock(guildId, () => announceDraftTurn(message.guild, gd))
        .catch(e => console.error('nextround error:', e));
      return;
    }

    // .autodraft on|off — allow preset orders + timeout auto-drafting (default: off)
    if (cmd === 'autodraft' || cmd === 'ad') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const sub = (parts[1] || '').toLowerCase();
      if (sub !== 'on' && sub !== 'off') {
        await message.channel.send(`⚙️ Preset draft orders are **${gd.setorderEnabled ? 'ON' : 'OFF'}** — \`${aucPfx}autodraft on|off\`. When on, owners can \`${aucPfx}setorder\` and timeouts auto-draft their top available player.`);
        return;
      }
      gd.setorderEnabled = (sub === 'on');
      scheduleAuctionSave();
      await message.channel.send(gd.setorderEnabled
        ? `✅ Preset orders **enabled** — owners can now \`${aucPfx}setorder\` (asked in DMs); timeouts auto-draft their top available player.`
        : '✅ Preset orders **disabled** — timeouts simply skip the pick again.');
      return;
    }

    // .draftauto on|off — auto-start each round instead of pausing (default: off)
    if (cmd === 'draftauto' || cmd === 'dauto') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const sub = (parts[1] || '').toLowerCase();
      if (sub !== 'on' && sub !== 'off') {
        await message.channel.send(`⚙️ Round auto-start is **${gd.draftAuto ? 'ON' : 'OFF'}** — \`${aucPfx}draftauto on|off\`. When off, each round waits for \`${aucPfx}nextround\`.`);
        return;
      }
      gd.draftAuto = (sub === 'on');
      scheduleAuctionSave();
      await message.channel.send(gd.draftAuto
        ? `✅ Rounds will now start **automatically**${gd.draft && gd.draft.active && gd.draft.waiting ? ` — the current pause still needs \`${aucPfx}nextround\`` : ''}.`
        : `✅ Rounds now **pause** — start each one with \`${aucPfx}nextround\`.`);
      return;
    }

    // .draftremove @user — drop a team from the roster (`all` clears it)
    if (cmd === 'draftremove' || cmd === 'drm') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      if (gd.draft && gd.draft.active) { await message.channel.send('❌ Draft is running — roster is locked until it ends.'); return; }
      if ((parts[1] || '').toLowerCase() === 'all') {
        gd.draftTeams = []; scheduleAuctionSave();
        await message.channel.send(`🗑️ Draft roster cleared — \`${aucPfx}draftstart\` will use everyone with a team name.`); return;
      }
      const m = message.mentions.members.first();
      if (!m) { await message.channel.send(`❌ Usage: \`${aucPfx}draftremove @user\` (or \`all\` to clear)`); return; }
      if (!gd.draftTeams || !gd.draftTeams.includes(m.id)) { await message.channel.send('❌ That team is not in the draft roster.'); return; }
      gd.draftTeams = gd.draftTeams.filter(id => id !== m.id);
      scheduleAuctionSave();
      await message.channel.send(`🗑️ **${teamOnly(gd, message.guild, m.id)}** removed — roster is now **${gd.draftTeams.length}** team(s).`);
      return;
    }

    // .draftteams — who's in the next draft, with squad sizes
    if (cmd === 'draftteams' || cmd === 'dt') {
      const roster = (gd.draftTeams && gd.draftTeams.length) ? gd.draftTeams : Object.keys(gd.teams || {});
      if (!roster.length) { await message.channel.send(`❌ No teams yet — \`${aucPfx}draftadd @user\` or \`${aucPfx}team @user <name>\`.`); return; }
      const src = (gd.draftTeams && gd.draftTeams.length) ? 'roster set by host' : 'all named teams (no roster set)';
      const lines = roster.map((uid, i) => `**${i + 1}.** ${teamLabel(gd, message.guild, uid)} — ${((gd.squads || {})[uid] || []).length} player(s)`).join('\n');
      const embed = new EmbedBuilder().setTitle('🏏 Draft Teams').setColor(0x00B2FF)
        .setDescription(lines.slice(0, 4096)).setFooter({ text: src });
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // .owners / .teams — every owner with a team name, and their squad size
    if (cmd === 'owners' || cmd === 'teams' || cmd === 'o') {
      const entries = Object.keys(gd.teams || {});
      if (!entries.length) { await message.channel.send(`❌ No owners yet — assign teams with \`${aucPfx}team @user <name>\` or \`${aucPfx}draftadd @user <name>\`.`); return; }
      const maxSquad = gd.maxSquad || 0;
      const lines = entries
        .map(uid => ({ uid, size: ((gd.squads || {})[uid] || []).length }))
        .sort((a, b) => b.size - a.size)
        .map(({ uid, size }, i) => `**${i + 1}.** ${teamLabel(gd, message.guild, uid)} — **${size}**${maxSquad ? `/${maxSquad}` : ''} player(s)`)
        .join('\n');
      const embed = new EmbedBuilder().setTitle('👥 Owners & Squad Sizes').setColor(0x00B2FF)
        .setDescription(lines.slice(0, 4096))
        .setFooter({ text: `${entries.length} owner(s) · ${aucPfx}squad @user for a full squad` });
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // .draftpicks — every draft pick so far, grouped by team
    if (cmd === 'draftpicks' || cmd === 'dpk') {
      const d = gd.draft;
      if (!d || !d.picks.length) { await message.channel.send('❌ No draft picks yet.'); return; }
      const byTeam = {};
      for (const p of d.picks) (byTeam[p.userId] = byTeam[p.userId] || []).push(p);
      const lines = d.participants
        .filter(uid => byTeam[uid])
        .map(uid => `**${teamOnly(gd, message.guild, uid)}** — ${byTeam[uid].map(p => `${p.player} (R${p.round}${p.makeup ? '·mk' : ''})`).join(', ')}`)
        .join('\n');
      const embed = new EmbedBuilder().setTitle('🏏 Draft Picks').setColor(0x00B2FF)
        .setDescription(lines.slice(0, 4096))
        .setFooter({ text: `${d.picks.length} pick(s) · full squads: ${aucPfx}squad @user` });
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // .draft / .draftstatus — round, order, skips, who's on the clock
    if (cmd === 'draft' || cmd === 'draftstatus' || cmd === 'd') {
      const d = gd.draft;
      if (!d) { await message.channel.send(`❌ No draft yet — start one with \`${aucPfx}draftstart <rounds>\`.`); return; }
      const slot = draftSlot(gd);
      const orderLines = d.order.map((uid, i) => {
        const mark = d.phase !== 'rounds' || !d.active ? '' : i < d.idx ? '✅ ' : i === d.idx ? '🎯 ' : '';
        return `**${i + 1}.** ${mark}${teamOnly(gd, message.guild, uid)}`;
      }).join('\n');
      const pending = d.skips.filter(s => !s.filled && !s.finalSkipped).length;
      const embed = new EmbedBuilder().setTitle('🏏 Draft Status').setColor(d.active ? 0x00B2FF : 0x888888)
        .addFields(
          { name: 'State', value: !d.active ? 'Finished / stopped'
              : d.waiting ? `⏸️ Paused — \`${aucPfx}nextround\``
              : (d.phase === 'makeup' ? 'Makeup picks' : `Round ${d.round}/${d.totalRounds}`), inline: true },
          { name: 'Picks made', value: String(d.picks.length), inline: true },
          { name: 'Skips pending', value: String(pending), inline: true },
          { name: d.phase === 'rounds' && d.active ? `Round ${d.round} order` : 'Last round order', value: orderLines.slice(0, 1024) || '*none*', inline: false }
        );
      if (slot) embed.addFields({ name: 'On the clock', value: `${teamOnly(gd, message.guild, slot.userId)} — Round ${slot.round}, ${pickOrdinal(slot.pick)} pick`, inline: false });
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // .taken <player> / .picked <player> — is a player taken, by whom, which round
    if (cmd === 'taken' || cmd === 'picked' || cmd === 's' || cmd === 'search') {
      const q = parts.slice(1).join(' ').trim();
      if (!q) { await message.channel.send(`❌ Usage: \`${aucPfx}taken <player>\``); return; }
      let hit = findTakenPlayer(gd, q);   // exact squad match first (covers off-pool retentions)
      if (!hit) {
        const r = poolResolve(gd, q);
        if (!r) { await message.channel.send(`⚠️ **${q}** doesn't exist in the player list at all — check the spelling.`); return; }
        if (r.ambiguous) { await message.channel.send(`🔎 **${q}** matches several players: ${r.ambiguous.map(n => `**${n}**`).join(', ')} — be more specific.`); return; }
        hit = findTakenPlayer(gd, r.name);
        if (!hit) { await message.channel.send(`🟢 **${r.name}** is not taken — free to pick!`); return; }
      }
      const by = teamLabel(gd, message.guild, hit.userId);
      if (hit.pickInfo) {
        await message.channel.send(`🔴 **${hit.entry.player}** was taken by **${by}** in Round ${hit.pickInfo.round} (${pickOrdinal(hit.pickInfo.pick)} pick${hit.pickInfo.makeup ? ', makeup' : ''}).`);
      } else {
        await message.channel.send(`🔴 **${hit.entry.player}** is with **${by}** (retained/bought — not a draft pick).`);
      }
      return;
    }

    // .setauctioneer / .sa  — grant/revoke Auctioneer role
    if (cmd === 'setauctioneer' || cmd === 'sa') {
      if (!hasAuctionPermission(message.member)) {
        await message.channel.send('❌ You need **Administrator** or **Auctioneer** role.'); return;
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

    // .sync [push|pull] — manual JSONBin sync (Admin only). Default: push.
    if (cmd === 'sync') {
      if (!hasAuctionPermission(message.member)) {
        await message.channel.send('❌ You need **Administrator** or **Auctioneer** role.'); return;
      }
      const mode = (parts[1] || 'push').toLowerCase();

      if (mode === 'pull' || mode === 'load' || mode === 'restore') {
        if (!auctionBinId) { await message.channel.send('❌ No auction bin to pull from yet.'); return; }
        await message.channel.send('⬇️ Pulling latest data from JSONBin...');
        const loaded = await loadBin(auctionBinId, 'auction');
        if (!loaded || !Object.keys(loaded).length) { await message.channel.send('❌ JSONBin returned no data — nothing pulled.'); return; }
        auctionData = { ...auctionData, ...loaded };
        saveLocalAuction();
        const gd2 = getGuildData(guildId);
        const embed = new EmbedBuilder().setTitle('⬇️ Data Pulled from JSONBin').setColor(0x57F287)
          .setDescription('In-memory state replaced with the JSONBin copy.')
          .addFields(
            { name: 'Guilds', value: String(Object.keys(auctionData.guilds || {}).length), inline: true },
            { name: 'This server — purses', value: String(Object.keys(gd2.purses || {}).length), inline: true },
            { name: 'This server — squads', value: String(Object.keys(gd2.squads || {}).length), inline: true },
            { name: 'Queue', value: String((gd2.queue || []).length), inline: true }
          ).setFooter({ text: `Pulled by ${message.author.tag}` }).setTimestamp();
        await message.channel.send({ embeds: [embed] }); return;
      }

      // push (default)
      await message.channel.send('⬆️ Pushing all data to JSONBin...');
      cgDirty = true;
      auctionDirty = true;
      await flushAuction(); // auction first so the bin-id pointer is captured before cg saves
      await flushCg();
      const gd2 = getGuildData(guildId);
      const embed = new EmbedBuilder().setTitle('✅ Data Synced to JSONBin').setColor(0x57F287)
        .addFields(
          { name: 'Guilds saved', value: String(Object.keys(auctionData.guilds || {}).length), inline: true },
          { name: 'This server — purses', value: String(Object.keys(gd2.purses || {}).length), inline: true },
          { name: 'This server — squads', value: String(Object.keys(gd2.squads || {}).length), inline: true },
          { name: 'AUCTION_BIN_ID (set this in env!)', value: `\`${auctionBinId || 'none'}\``, inline: false }
        ).setFooter({ text: `Synced by ${message.author.tag} • use ${aucPfx}sync pull to reload` }).setTimestamp();
      await message.channel.send({ embeds: [embed] }); return;
    }

    // .addsquad / .as
    if (cmd === 'addsquad' || cmd === 'as') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ No permission.'); return; }
      const target = message.mentions.members.first();
      const afterMention = aucRaw.replace(/^(addsquad|as)\s+/, '').replace(/<@!?\d+>\s*/, '').trim();
      const words = afterMention.split(/\s+/).filter(Boolean);
      if (!target || words.length === 0) {
        await message.channel.send(`❌ Usage: \`${aucPfx}addsquad @user <player> [price]\` — or several players comma-separated for bulk retention`); return;
      }
      // Bulk retention: comma/newline-separated names, all added price-less
      if (/[,\n]/.test(afterMention)) {
        const names = parsePlayerList(afterMention).slice(0, 100);
        if (!gd.squads) gd.squads = {};
        if (!gd.squads[target.id]) gd.squads[target.id] = [];
        const limit = gd.maxSquad || 0;
        const added = [], skipped = [];
        for (const n of names) {
          const r = poolResolve(gd, n);
          if (!r) { skipped.push(`${n} — not in the player list`); continue; }
          if (r.ambiguous) { skipped.push(`${n} — ambiguous (${r.ambiguous.slice(0, 3).join(', ')})`); continue; }
          const dup = findTakenPlayer(gd, r.name);
          if (dup) { skipped.push(`${r.name} — already with ${teamOnly(gd, message.guild, dup.userId)}`); continue; }
          if (limit > 0 && gd.squads[target.id].length >= limit) { skipped.push(`${r.name} — squad full (${limit})`); continue; }
          gd.squads[target.id].push({ player: r.name, price: 0 });
          added.push(r.name);
        }
        scheduleAuctionSave();
        const embed = new EmbedBuilder().setTitle('📥 Retention — Bulk Add').setColor(added.length ? 0x57F287 : 0xED4245)
          .setDescription(`**${teamLabel(gd, message.guild, target.id)}** — added **${added.length}**, skipped **${skipped.length}** (squad now ${gd.squads[target.id].length}${limit ? `/${limit}` : ''})`);
        if (added.length)   embed.addFields({ name: 'Added',   value: added.join(', ').slice(0, 1024),  inline: false });
        if (skipped.length) embed.addFields({ name: 'Skipped', value: skipped.join('\n').slice(0, 1024), inline: false });
        await message.channel.send({ embeds: [embed] });
        return;
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
      // Retention safety — use the pool's spelling, and never let two squads own the same player
      const poolR = gd.draftPool || [];
      if (poolR.length) {
        const canon = poolR.find(n => normPlayer(n) === normPlayer(playerName));
        if (canon) playerName = canon;
      }
      const already = findTakenPlayer(gd, playerName);
      if (already) {
        await message.channel.send(`❌ **${already.entry.player}** is already with **${teamOnly(gd, message.guild, already.userId)}** — remove them first with \`${aucPfx}delete\`.`); return;
      }
      if (!gd.squads) gd.squads = {};
      if (!gd.squads[target.id]) gd.squads[target.id] = [];
      const maxSquad = gd.maxSquad || 0;
      if (maxSquad > 0 && gd.squads[target.id].length >= maxSquad) {
        await message.channel.send(`❌ ${target.displayName}'s squad is already full (**${gd.squads[target.id].length}/${maxSquad}**). Raise the limit with \`${aucPfx}ssl\`.`); return;
      }
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

    // .swap @userA @userB — swap two members' entire auction state (purse + squad)
    if (cmd === 'swap') {
      if (!hasAuctionPermission(message.member)) { await message.channel.send('❌ You need **Administrator** or **Auctioneer** role.'); return; }
      const mentioned = [...message.mentions.members.values()];
      if (mentioned.length < 2 || mentioned[0].id === mentioned[1].id) {
        await message.channel.send(`❌ Usage: \`${aucPfx}swap @userA @userB\` — swaps purse, squad & team name between two members.`); return;
      }
      const [A, B] = mentioned;
      if (!gd.purses) gd.purses = {};
      if (!gd.squads) gd.squads = {};
      if (!gd.teams)  gd.teams  = {};
      // swap purses
      const pa = gd.purses[A.id] || 0, pb = gd.purses[B.id] || 0;
      gd.purses[A.id] = pb; gd.purses[B.id] = pa;
      // swap squads
      const sa = gd.squads[A.id] || [], sb = gd.squads[B.id] || [];
      gd.squads[A.id] = sb; gd.squads[B.id] = sa;
      // swap team names (delete the key when the other side had none)
      const ta = gd.teams[A.id], tb = gd.teams[B.id];
      if (tb !== undefined) gd.teams[A.id] = tb; else delete gd.teams[A.id];
      if (ta !== undefined) gd.teams[B.id] = ta; else delete gd.teams[B.id];
      // cancel any active trade involving either member (its references are now stale)
      if (gd.trade && [gd.trade.a, gd.trade.b].some(id => id === A.id || id === B.id)) gd.trade = null;
      scheduleAuctionSave();
      await flushAuction(); // persist this big change immediately
      const embed = new EmbedBuilder().setTitle('🔄 Swapped').setColor(0x00B0F4)
        .setDescription(`Swapped **purse, squad & team name** between ${A} and ${B}.`)
        .addFields(
          { name: A.displayName, value: `Team: **${gd.teams[A.id] || '—'}**\nBalance: **${formatAmount(gd.purses[A.id])}**\nSquad: **${(gd.squads[A.id] || []).length}** player(s)`, inline: true },
          { name: B.displayName, value: `Team: **${gd.teams[B.id] || '—'}**\nBalance: **${formatAmount(gd.purses[B.id])}**\nSquad: **${(gd.squads[B.id] || []).length}** player(s)`, inline: true }
        ).setFooter({ text: `By ${message.author.tag}` }).setTimestamp();
      await message.channel.send({ embeds: [embed] });
      await sendLog(message.guild, embed);
      return;
    }

    // ── STAFF PAYMENTS ─────────────────────────────────────────────────────
    // A ledger only — the bot never moves money. It tracks what each staff
    // member is still owed, who they collect it from, and every change to it.

    // Plain-name targets need the whole member list — the cache is partial until
    // it's fetched. Mentions and raw ids resolve without this.
    const PAY_CMDS = ['pay','mypay','paylog','payadd','payremove','payrem','payer','paydone','paypaid',
                      'paydeny','payreject','payundo','payadmin','payshare','payshares','paycut','shares'];
    if (PAY_CMDS.includes(cmd) && parts.length > 1 && !message.mentions.members.first()) {
      try { await message.guild.members.fetch(); } catch (_) {}
    }

    // .payhelp — the whole system on one page
    if (cmd === 'payhelp') {
      await message.channel.send({ embeds: [payHelpEmbed(aucPfx)] }); return;
    }

    // .payadmin [add|remove|default] @user — who may run the pay commands
    if (cmd === 'payadmin') {
      gd.payAdmins = gd.payAdmins || {};
      const sub = (parts[1] || '').toLowerCase();
      if (!sub || sub === 'list') {
        const entries = Object.entries(gd.payAdmins);
        const def = gd.payDefaultAdmin ? `\n**Default payer:** <@${gd.payDefaultAdmin}>` : '';
        await message.channel.send(entries.length
          ? `💵 **Pay admins:**\n${entries.map(([id, tag]) => `• <@${id}> (${tag})`).join('\n')}${def}`
          : `💵 No pay admins set yet — Admins/Auctioneers can run everything. Add one with \`${aucPfx}payadmin add @user\`.`);
        return;
      }
      if (!hasAuctionPermission(message.member)) {
        await message.channel.send('❌ You need **Administrator** or **Auctioneer** role.'); return;
      }
      const target = message.mentions.members.first() || resolvePayMember(message.guild, gd, parts.slice(2).join(' '));
      if (!['add', 'remove', 'default'].includes(sub) || !target) {
        await message.channel.send(`❌ Usage: \`${aucPfx}payadmin add|remove|default <@user|name>\``); return;
      }
      if (sub === 'add') {
        gd.payAdmins[target.id] = target.user.tag;
        if (!gd.payDefaultAdmin) gd.payDefaultAdmin = target.id;   // first one becomes the fallback payer
        scheduleAuctionSave();
        await message.channel.send(`✅ **${target.user.tag}** can now manage staff payments.${gd.payDefaultAdmin === target.id ? ' They are also the default payer.' : ''}`);
      } else if (sub === 'remove') {
        if (!gd.payAdmins[target.id]) { await message.channel.send(`❌ **${target.user.tag}** isn't a pay admin.`); return; }
        delete gd.payAdmins[target.id];
        if (gd.payDefaultAdmin === target.id) gd.payDefaultAdmin = Object.keys(gd.payAdmins)[0] || null;
        scheduleAuctionSave();
        await message.channel.send(`✅ Pay-admin rights removed from **${target.user.tag}**.`);
      } else {
        gd.payAdmins[target.id] = gd.payAdmins[target.id] || target.user.tag;
        gd.payDefaultAdmin = target.id;
        scheduleAuctionSave();
        await message.channel.send(`✅ **${target.user.tag}** is now the default payer — staff without their own payer claim from them.`);
      }
      return;
    }

    // .payadd / .payremove <user> <amount> [note] — log a payment, or take one back
    if (cmd === 'payadd' || cmd === 'payremove' || cmd === 'payrem') {
      if (!isPayAdmin(gd, message.member)) { await message.channel.send(`❌ Pay admins only — grant with \`${aucPfx}payadmin add @user\`.`); return; }
      const { target, amount, note } = parsePayArgs(message, gd, parts);
      if (!target || amount === null) { await message.channel.send(`❌ Usage: \`${aucPfx}${cmd} <@user|name> <amount> [note]\``); return; }
      if (amount < 0) { await message.channel.send('❌ Amount cannot be negative.'); return; }
      const e = payEntry(gd, target.id);
      const before = e.due;
      e.due = cmd === 'payadd' ? before + amount : Math.max(0, before - amount);
      const delta = e.due - before;
      // Nobody assigned yet → whoever logs the payment is the one they collect from
      if (!e.payer && !payerFor(gd, target.id)) e.payer = userId;
      payLog(e, cmd === 'payadd' ? 'add' : 'remove', delta, userId, note);
      scheduleAuctionSave();

      const embed = new EmbedBuilder()
        .setTitle(cmd === 'payadd' ? '💵 Payment Logged' : '💵 Payment Removed')
        .setColor(delta >= 0 ? 0x2ECC71 : 0xE67E22)
        .setDescription(`**${target.displayName}** — ${formatAmount(before)} → **${formatAmount(e.due)}**${delta ? ` (${delta > 0 ? '+' : '−'}${formatAmount(Math.abs(delta))})` : ''}`)
        .addFields({ name: 'Claim from', value: payerMention(gd, target.id) || `*not assigned — \`${aucPfx}payer @user @admin\`*`, inline: true })
        .setFooter({ text: `By ${message.author.tag}${note ? ` • ${note}` : ''}` })
        .setTimestamp();
      // Never ping — mentions inside an embed render as names without notifying
      await message.channel.send({ embeds: [embed] });
      await sendLogText(message.guild, { embeds: [embed] }, 'pay');
      return;
    }

    // .payer <staff> <admin> — who that staff member collects from
    // .payer default <admin> — fallback for everyone without their own
    if (cmd === 'payer') {
      if (!isPayAdmin(gd, message.member)) { await message.channel.send(`❌ Pay admins only — grant with \`${aucPfx}payadmin add @user\`.`); return; }
      gd.payAdmins = gd.payAdmins || {};
      // Walk the tokens in the order they were typed so mentions and plain
      // names can be mixed freely
      const isDefault = (parts[1] || '').toLowerCase() === 'default';
      const found = [];
      for (const tok of parts.slice(isDefault ? 2 : 1)) {
        if (found.length === 2) break;
        const m   = tok.match(/^<@!?(\d+)>$/);
        const mem = m ? message.guild.members.cache.get(m[1]) : resolvePayMember(message.guild, gd, tok);
        if (mem) found.push(mem);
      }
      if (isDefault) {
        const admin = found[0];
        if (!admin) { await message.channel.send(`❌ Usage: \`${aucPfx}payer default <@admin|name>\``); return; }
        gd.payAdmins[admin.id] = gd.payAdmins[admin.id] || admin.user.tag;
        gd.payDefaultAdmin = admin.id;
        scheduleAuctionSave();
        await message.channel.send(`✅ Staff without their own payer now claim from **${admin.displayName}**.`);
        return;
      }
      if (found.length < 2) { await message.channel.send(`❌ Usage: \`${aucPfx}payer <@staff|name> <@admin|name>\` (or \`${aucPfx}payer default <@admin|name>\`)`); return; }
      const [staff, admin] = found;
      const e = payEntry(gd, staff.id);
      e.payer = admin.id;
      gd.payAdmins[admin.id] = gd.payAdmins[admin.id] || admin.user.tag;
      payLog(e, 'note', 0, userId, `payer set to ${admin.user.tag}`);
      scheduleAuctionSave();
      await message.channel.send(`✅ **${staff.displayName}** now claims their payment from **${admin.displayName}**.`);
      return;
    }

    // .payticket <text|clear> — the instructions staff get when they claim
    if (cmd === 'payticket') {
      if (!isPayAdmin(gd, message.member)) { await message.channel.send(`❌ Pay admins only — grant with \`${aucPfx}payadmin add @user\`.`); return; }
      const text = aucRaw.slice(parts[0].length).trim();
      if (!text) { await message.channel.send(`🎫 Current claim instructions:\n> ${payTicketLine(gd)}\nChange with \`${aucPfx}payticket <text>\` or reset with \`${aucPfx}payticket clear\`.`); return; }
      if (text.toLowerCase() === 'clear') {
        gd.payTicket = null; scheduleAuctionSave();
        await message.channel.send('🎫 Claim instructions reset to the default.'); return;
      }
      gd.payTicket = text.slice(0, 400); scheduleAuctionSave();
      await message.channel.send(`🎫 Claim instructions set:\n> ${gd.payTicket}`); return;
    }

    // .pay [<@user|name>] — what's still owed and who to claim it from
    if (cmd === 'pay' || cmd === 'mypay') {
      const argText  = aucRaw.slice(parts[0].length).trim();
      const resolved = argText ? resolvePayMember(message.guild, gd, argText) : message.member;
      if (!resolved) { await message.channel.send(`❌ No member named "${argText}" found.`); return; }
      if (resolved.id !== userId && !isPayAdmin(gd, message.member)) {
        await message.channel.send('❌ You can only check your own payment — pay admins can check anyone.'); return;
      }
      if (!gd.staffPay || !gd.staffPay[resolved.id]) {
        await message.channel.send(resolved.id === userId
          ? '💵 Nothing logged for you — you have no pending payment.'
          : `💵 **${displayNameOf(message.guild, resolved.id)}** has nothing logged in the payment ledger.`);
        return;
      }
      await message.channel.send({ embeds: [payStatusEmbed(gd, message.guild, resolved.id, aucPfx)] });
      return;
    }

    // .paylog [<@user|name>] — the full history we kept
    if (cmd === 'paylog') {
      const argText  = aucRaw.slice(parts[0].length).trim();
      const resolved = argText ? resolvePayMember(message.guild, gd, argText) : message.member;
      if (!resolved) { await message.channel.send(`❌ No member named "${argText}" found.`); return; }
      if (resolved.id !== userId && !isPayAdmin(gd, message.member)) {
        await message.channel.send('❌ You can only check your own log — pay admins can check anyone.'); return;
      }
      const e = gd.staffPay && gd.staffPay[resolved.id];
      if (!e || !e.history || e.history.length === 0) { await message.channel.send('💵 No payment history logged yet.'); return; }
      const lines = payHistoryLines(e);
      const embed = new EmbedBuilder()
        .setTitle(`📒 Payment Log — ${displayNameOf(message.guild, resolved.id)}`)
        .setColor(0x9B59B6)
        .setDescription(`**Remaining:** ${formatAmount(e.due)}  •  **Claim from:** ${payerMention(gd, resolved.id) || '*not assigned*'}`)
        .setTimestamp();
      // 1024 chars per field — spill into extra fields rather than truncating
      let chunk = '';
      for (const line of lines) {
        if ((chunk + line).length > 1000) { embed.addFields({ name: '​', value: chunk, inline: false }); chunk = ''; }
        chunk += line + '\n';
      }
      if (chunk) embed.addFields({ name: '​', value: chunk, inline: false });
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // .paylist / .payall — everyone with an unclaimed balance or a pending claim
    if (cmd === 'paylist' || cmd === 'payall') {
      if (!isPayAdmin(gd, message.member)) { await message.channel.send(`❌ Pay admins only — grant with \`${aucPfx}payadmin add @user\`.`); return; }
      const entries = Object.entries(gd.staffPay || {}).filter(([, e]) => (e.due || 0) > 0 || (e.claims || []).length);
      const embed = new EmbedBuilder().setTitle('💵 Staff Payments Outstanding').setColor(0xFFA500).setTimestamp();
      if (entries.length === 0) {
        embed.setDescription('✅ Everyone is paid up — nothing outstanding.');
      } else {
        entries.sort((a, b) => ((b[1].due || 0) + payPending(b[1])) - ((a[1].due || 0) + payPending(a[1])));
        const lines = entries.map(([uid, e]) => {
          const pending = payPending(e);
          const payer   = payerMention(gd, uid) || '*unassigned*';
          return `${pending ? '📨' : '•'} **${displayNameOf(message.guild, uid)}** — ${formatAmount(e.due)} unclaimed${pending ? ` · **${formatAmount(pending)}** awaiting transfer` : ''} · from ${payer}`;
        });
        const totalDue = entries.reduce((s, [, e]) => s + (e.due || 0), 0);
        const totalPen = entries.reduce((s, [, e]) => s + payPending(e), 0);
        embed.setDescription(lines.join('\n').slice(0, 4000))
          .setFooter({ text: `${entries.length} staff • ${formatAmount(totalDue)} unclaimed • ${formatAmount(totalPen)} awaiting transfer (${aucPfx}payclaims)` });
      }
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // .payclaim [amount] [note] — takes the amount off the balance right away and
    // leaves it pending until an admin transfers the currency in the other bot
    if (cmd === 'payclaim') {
      const e = gd.staffPay && gd.staffPay[userId] ? payEntry(gd, userId) : null;
      if (!e || (e.due || 0) <= 0) { await message.channel.send('💵 You have nothing to claim — your unclaimed balance is **0**.'); return; }
      const rest    = parts.slice(1);
      const asked   = rest.length ? parsePayAmount(rest[0]) : null;
      const amount  = (asked === null || asked <= 0) ? e.due : Math.min(asked, e.due);
      const note    = (asked === null ? rest : rest.slice(1)).join(' ').trim();
      const payer   = payerFor(gd, userId);
      e.due -= amount;                                   // claimed money leaves the balance immediately
      e.claims.push({ amount, note, ts: Date.now() });
      payLog(e, 'claim', -amount, userId, `claimed${note ? ` — ${note}` : ''}`);
      scheduleAuctionSave();
      await flushAuction();   // the balance moved — don't risk losing it to a restart

      const embed = new EmbedBuilder()
        .setTitle('📨 Payment Claimed')
        .setColor(0x3498DB)
        .setDescription(`**${message.member.displayName}** claimed **${formatAmount(amount)}** — taken off their balance, now waiting to be transferred.`)
        .addFields(
          { name: 'Claim from', value: payer ? `<@${payer}>` : `*Nobody assigned — an admin must run \`${aucPfx}payer @you @admin\`*`, inline: true },
          { name: 'Unclaimed left', value: formatAmount(e.due), inline: true },
          { name: '🎫 How to collect', value: payTicketLine(gd), inline: false }
        )
        .setTimestamp();
      if (note) embed.addFields({ name: 'Note', value: note.slice(0, 1024), inline: false });
      await message.channel.send({ embeds: [embed] });
      await sendLogText(message.guild, { embeds: [embed] }, 'pay');
      // The claimer gets the ticket instructions in DMs — nobody else is pinged
      await message.author.send({ content:
        `🎫 **Open a ticket to collect your ${formatAmount(amount)}** — ${message.guild.name}\n` +
        `${payTicketLine(gd)}\n` +
        (payer ? `Ask for **${displayNameOf(message.guild, payer)}** — they send the currency.\n` : '') +
        `Unclaimed balance left: **${formatAmount(e.due)}**.`
      }).catch(async () => {
        await message.channel.send(`⚠️ ${message.member} your DMs are closed — 🎫 ${payTicketLine(gd)}`).catch(() => {});
      });
      return;
    }

    // .payclaims — everything claimed but not yet transferred
    if (cmd === 'payclaims' || cmd === 'paypending') {
      if (!isPayAdmin(gd, message.member)) { await message.channel.send(`❌ Pay admins only — grant with \`${aucPfx}payadmin add @user\`.`); return; }
      const waiting = Object.entries(gd.staffPay || {}).filter(([, e]) => (e.claims || []).length);
      const embed = new EmbedBuilder().setTitle('📨 Waiting To Be Transferred').setColor(0x3498DB).setTimestamp();
      if (waiting.length === 0) {
        embed.setDescription('Nothing pending — every claim has been transferred.');
      } else {
        waiting.sort((a, b) => a[1].claims[0].ts - b[1].claims[0].ts);
        embed.setDescription(waiting.map(([uid, e]) => {
          const rows = e.claims.map(c => `   • ${formatAmount(c.amount)} <t:${Math.floor(c.ts / 1000)}:R>${c.note ? ` — *${c.note}*` : ''}`).join('\n');
          return `📨 **${displayNameOf(message.guild, uid)}** — **${formatAmount(payPending(e))}** · from ${payerMention(gd, uid) || '*unassigned*'}\n${rows}`;
        }).join('\n').slice(0, 4000))
          .setFooter({ text: `Total ${formatAmount(waiting.reduce((s, [, e]) => s + payPending(e), 0))} · ${aucPfx}paydone <user> [all] once transferred · ${aucPfx}paydeny <user> to put it back` });
      }
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // .paydone <user> [all] [note] — currency sent in the other bot, so drop the
    // pending claim (the balance already came off when they claimed)
    if (cmd === 'paydone' || cmd === 'paypaid') {
      if (!isPayAdmin(gd, message.member)) { await message.channel.send(`❌ Pay admins only — grant with \`${aucPfx}payadmin add @user\`.`); return; }
      const pinged = message.mentions.members.first();
      const target = pinged || resolvePayMember(message.guild, gd, parts[1]);
      if (!target) { await message.channel.send(`❌ Usage: \`${aucPfx}paydone <@user|name> [all] [note]\``); return; }
      const e = payEntry(gd, target.id);
      if (!e.claims.length) { await message.channel.send(`❌ **${target.displayName}** has nothing waiting to be transferred.`); return; }
      const tail = parts.slice(1).filter((p, i) => !/^<@[!&]?\d+>$/.test(p) && !(!pinged && i === 0));
      const all  = (tail[0] || '').toLowerCase() === 'all';
      const note = (all ? tail.slice(1) : tail).join(' ').trim();
      const cleared = all ? e.claims.splice(0) : [e.claims.shift()];
      const total   = cleared.reduce((s, c) => s + c.amount, 0);
      payLog(e, 'paid', 0, userId, `transferred ${formatAmount(total)}${note ? ` — ${note}` : ''}`);
      scheduleAuctionSave();

      const embed = new EmbedBuilder()
        .setTitle('✅ Transfer Confirmed')
        .setColor(0x2ECC71)
        .setDescription(`**${formatAmount(total)}** transferred to **${target.displayName}** by ${message.author.tag}.`)
        .addFields(
          { name: 'Still waiting', value: formatAmount(payPending(e)), inline: true },
          { name: 'Unclaimed balance', value: formatAmount(e.due), inline: true }
        )
        .setFooter({ text: note || `Cleared ${cleared.length} claim(s)` })
        .setTimestamp();
      await message.channel.send({ embeds: [embed] });
      await sendLogText(message.guild, { embeds: [embed] }, 'pay');
      return;
    }

    // .paydeny <user> [reason] — cancel a pending claim and put the money back
    if (cmd === 'paydeny' || cmd === 'payreject' || cmd === 'payundo') {
      if (!isPayAdmin(gd, message.member)) { await message.channel.send(`❌ Pay admins only — grant with \`${aucPfx}payadmin add @user\`.`); return; }
      const pinged = message.mentions.members.first();
      const target = pinged || resolvePayMember(message.guild, gd, parts[1]);
      if (!target) { await message.channel.send(`❌ Usage: \`${aucPfx}paydeny <@user|name> [reason]\``); return; }
      const e = payEntry(gd, target.id);
      if (!e.claims.length) { await message.channel.send(`❌ **${target.displayName}** has no pending claim.`); return; }
      const tail   = parts.slice(1).filter((p, i) => !/^<@[!&]?\d+>$/.test(p) && !(!pinged && i === 0));
      const all    = (tail[0] || '').toLowerCase() === 'all';
      const reason = (all ? tail.slice(1) : tail).join(' ').trim();
      const undone = all ? e.claims.splice(0) : [e.claims.shift()];
      const total  = undone.reduce((s, c) => s + c.amount, 0);
      e.due += total;                                    // never transferred, so give it back
      payLog(e, 'add', total, userId, `claim cancelled${reason ? `: ${reason}` : ''}`);
      scheduleAuctionSave();
      await message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle('🚫 Claim Cancelled')
        .setColor(0xE74C3C)
        .setDescription(`**${target.displayName}**'s claim of **${formatAmount(total)}** was cancelled and put back on their balance.`)
        .addFields({ name: 'Unclaimed balance', value: `**${formatAmount(e.due)}**`, inline: true })
        .setFooter({ text: `By ${message.author.tag}${reason ? ` • ${reason}` : ''}` })
        .setTimestamp()] });
      return;
    }

    // .payshare — named percentage lists
    //   .payshare                              all lists
    //   .payshare <list>                       one list
    //   .payshare <list> add <user> <pct>      add/update a member (creates the list)
    //   .payshare <list> rem <user>            drop a member
    //   .payshare <list> delete                delete the list
    if (cmd === 'payshare' || cmd === 'payshares' || cmd === 'paycut' || cmd === 'shares') {
      const lists = payLists(gd);
      const names = Object.keys(lists);

      // No list named → show them all
      if (parts.length === 1) {
        const embed = new EmbedBuilder().setTitle('📊 Percentage Lists').setColor(0x1ABC9C).setTimestamp();
        if (names.length === 0) {
          embed.setDescription(`No lists yet. Make one with \`${aucPfx}payshare <list> add <@user|name> <percent>\` — e.g. \`${aucPfx}payshare tournament add jaiv 20\`.`);
        } else {
          embed.setDescription(names.map(n => {
            const t = payShareTotal(lists[n]);
            return `**${n}** — ${Object.keys(lists[n]).length} people, ${t}%${t > 100 ? ' ⚠️' : ''}`;
          }).join('\n'))
            .setFooter({ text: `${aucPfx}payshare <list> to see one · ${aucPfx}pay run <amount> <list> to pay it out` });
        }
        await message.channel.send({ embeds: [embed] });
        return;
      }

      const listName = parts[1];
      const sub      = (parts[2] || '').toLowerCase();
      const found    = payListFind(gd, listName);

      // Just the name → show that list
      if (!sub) {
        if (!found) { await message.channel.send(`❌ No list called **${listName}**. Existing: ${names.length ? names.join(', ') : 'none yet'}`); return; }
        const rows  = Object.entries(found.list).sort((a, b) => b[1] - a[1]);
        const total = payShareTotal(found.list);
        const embed = new EmbedBuilder()
          .setTitle(`📊 ${found.key}`)
          .setColor(0x1ABC9C)
          .setDescription(rows.length
            ? rows.map(([uid, p]) => `• **${displayNameOf(message.guild, uid)}** — ${p}%  *(${formatAmount(1000 * p)} per 100,000)*`).join('\n')
            : '*Empty — nobody in this list yet.*')
          .setFooter({ text: `${total}% allocated${total > 100 ? ' — over 100%!' : total < 100 ? ` · ${100 - total}% kept` : ''}` })
          .setTimestamp();
        await message.channel.send({ embeds: [embed] });
        return;
      }

      if (!isPayAdmin(gd, message.member)) { await message.channel.send(`❌ Pay admins only — grant with \`${aucPfx}payadmin add @user\`.`); return; }

      if (sub === 'delete' || sub === 'del') {
        if (!found) { await message.channel.send(`❌ No list called **${listName}**.`); return; }
        delete lists[found.key]; scheduleAuctionSave();
        await message.channel.send(`🗑️ List **${found.key}** deleted.`); return;
      }

      if (sub === 'rename') {
        if (!found) { await message.channel.send(`❌ No list called **${listName}**.`); return; }
        const newName = parts.slice(3).join(' ').trim();
        if (!newName) { await message.channel.send(`❌ Usage: \`${aucPfx}payshare <list> rename <new name>\``); return; }
        lists[newName] = found.list; delete lists[found.key]; scheduleAuctionSave();
        await message.channel.send(`✏️ **${found.key}** renamed to **${newName}**.`); return;
      }

      if (sub !== 'add' && sub !== 'set' && sub !== 'rem' && sub !== 'remove') {
        await message.channel.send(`❌ Usage: \`${aucPfx}payshare <list> add <@user|name> <percent>\` · \`rem <user>\` · \`delete\` · \`rename <new name>\``); return;
      }

      // add/rem read parts[3..] so the list name is never mistaken for the target
      const { target, amount } = parsePayArgs(message, gd, ['x', ...parts.slice(3)]);
      if (!target) { await message.channel.send(`❌ Who? Usage: \`${aucPfx}payshare ${listName} ${sub} <@user|name>${sub === 'add' || sub === 'set' ? ' <percent>' : ''}\``); return; }

      if (sub === 'rem' || sub === 'remove') {
        if (!found || !(target.id in found.list)) { await message.channel.send(`❌ **${target.displayName}** isn't in **${listName}**.`); return; }
        delete found.list[target.id]; scheduleAuctionSave();
        await message.channel.send(`✅ **${target.displayName}** removed from **${found.key}** — now ${payShareTotal(found.list)}% allocated.`); return;
      }

      if (amount === null) { await message.channel.send(`❌ Give a percentage: \`${aucPfx}payshare ${listName} add ${target.displayName} 20\``); return; }
      if (amount <= 0 || amount > 100) { await message.channel.send('❌ Percentage must be between 0 and 100 (use `rem` to drop someone).'); return; }
      const key = found ? found.key : listName;
      if (!found) lists[key] = {};
      lists[key][target.id] = amount;
      scheduleAuctionSave();
      const total = payShareTotal(lists[key]);
      await message.channel.send(`✅ **${target.displayName}** gets **${amount}%** of **${key}** — ${formatAmount(1000 * amount)} per 100,000.\nList now totals **${total}%**${total > 100 ? ' ⚠️ over 100%' : ''}.`);
      return;
    }

    // .purchase <amount> <list> [pending] [note] — pay a total out through a
    // percentage list. `pending` skips the claim step: each cut goes straight to
    // waiting-for-transfer instead of sitting on their balance.
    if (cmd === 'purchase' || cmd === 'payrun' || cmd === 'paysplit' || cmd === 'split' || cmd === 'sale') {
      if (!isPayAdmin(gd, message.member)) { await message.channel.send(`❌ Pay admins only — grant with \`${aucPfx}payadmin add @user\`.`); return; }
      const lists  = payLists(gd);
      const names  = Object.keys(lists);
      const amount = parsePayAmount(parts[1]);
      if (amount === null || amount <= 0) { await message.channel.send(`❌ Usage: \`${aucPfx}purchase <amount> <list> [note]\` — e.g. \`${aucPfx}purchase 200k tournament\``); return; }
      if (names.length === 0) { await message.channel.send(`❌ No percentage lists yet — make one with \`${aucPfx}payshare <list> add <@user|name> <percent>\`.`); return; }
      // One list on the server → the name is optional
      const found = payListFind(gd, parts[2]) || (names.length === 1 && !parts[2] ? { key: names[0], list: lists[names[0]] } : null);
      if (!found) { await message.channel.send(`❌ Which list? Available: **${names.join('**, **')}** — \`${aucPfx}purchase ${parts[1]} ${names[0]}\``); return; }
      if (payShareTotal(found.list) <= 0) { await message.channel.send(`❌ **${found.key}** is empty — add people with \`${aucPfx}payshare ${found.key} add <@user|name> <percent>\`.`); return; }
      const tail     = parts.slice(parts[2] ? 3 : 2);
      const straight = ['pending', 'pend', 'now', 'claimed'].includes((tail[0] || '').toLowerCase());
      const note     = (straight ? tail.slice(1) : tail).join(' ').trim();
      const { splits, paidOut, leftover } = recordPurchase(gd, found.key, amount, userId, note);
      if (straight) {
        // Nobody has to run payclaim — move each cut straight into pending
        for (const s of splits) {
          const e = payEntry(gd, s.uid);
          e.due -= s.cut;
          e.claims.push({ amount: s.cut, note: `${found.key}${note ? ` — ${note}` : ''}`, ts: Date.now() });
          payLog(e, 'claim', -s.cut, userId, `auto-claimed from ${found.key}`);
        }
      }
      scheduleAuctionSave();
      await flushAuction();   // several balances changed at once

      const embed = new EmbedBuilder()
        .setTitle(straight ? '🧾 Payout Logged — Pending Transfer' : '🧾 Payout Logged')
        .setColor(0x1ABC9C)
        .setDescription(`**${formatAmount(amount)}** through **${found.key}**${note ? ` — ${note}` : ''}${straight ? '\nStraight to **pending transfer** — no claim needed.' : ''}`)
        .addFields(
          { name: 'Split', value: splits.map(s => `• **${displayNameOf(message.guild, s.uid)}** — ${s.pct}% = **${formatAmount(s.cut)}** *(${straight ? `${formatAmount(payPending(payEntry(gd, s.uid)))} pending` : `now owed ${formatAmount(payEntry(gd, s.uid).due)}`})*`).join('\n').slice(0, 1024), inline: false },
          { name: 'Paid out', value: formatAmount(paidOut), inline: true },
          { name: leftover >= 0 ? 'Kept' : 'Over-committed', value: formatAmount(Math.abs(leftover)), inline: true }
        )
        .setFooter({ text: `Logged by ${message.author.tag}` })
        .setTimestamp();
      await message.channel.send({ embeds: [embed] });
      await sendLogText(message.guild, { embeds: [embed] }, 'pay');
      return;
    }

    // .purchases — recent payouts and how each was split
    if (cmd === 'purchases' || cmd === 'purchaselog' || cmd === 'payruns' || cmd === 'sales') {
      const log = Array.isArray(gd.payPurchases) ? gd.payPurchases : [];
      const embed = new EmbedBuilder().setTitle('🧾 Payout Log').setColor(0x1ABC9C).setTimestamp();
      if (log.length === 0) {
        embed.setDescription(`Nothing logged yet — run one with \`${aucPfx}purchase <amount> <list> [note]\`.`);
      } else {
        const recent = [...log].reverse().slice(0, 10);
        embed.setDescription(recent.map(p => {
          const who = p.splits.map(s => `${displayNameOf(message.guild, s.uid)} ${s.pct}% = ${formatAmount(s.cut)}`).join(', ');
          return `**${formatAmount(p.amount)}**${p.list ? ` · **${p.list}**` : ''} · <t:${Math.floor(p.ts / 1000)}:d>${p.note ? ` — *${p.note}*` : ''}\n   ${who || 'empty list at the time'}`;
        }).join('\n').slice(0, 4000))
          .setFooter({ text: `Showing ${recent.length} of ${log.length} kept · total logged ${formatAmount(log.reduce((s, p) => s + p.amount, 0))}` });
      }
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // .trade / .tr — player-to-player squad trade, balanced by player price
    if (cmd === 'trade' || cmd === 'tr') {
      if (!gd.squads) gd.squads = {};
      const sub = (parts[1] || '').toLowerCase();
      const knownSubs = ['view', 'v', 'add', 'rem', 'remove', 'cash', 'money', 'accept', 'ok', 'cancel'];

      // No active trade → must start one with a mention
      if (!gd.trade) {
        if (knownSubs.includes(sub)) { await message.channel.send(`❌ No active trade. Start one with \`${aucPfx}trade @user\`.`); return; }
        const target = message.mentions.members.first();
        if (!target) { await message.channel.send(`❌ Usage: \`${aucPfx}trade @user\` to start a trade, then \`${aucPfx}trade add <player>\`.`); return; }
        if (target.id === userId) { await message.channel.send("❌ You can't trade with yourself."); return; }
        if (target.user.bot)      { await message.channel.send("❌ You can't trade with a bot."); return; }
        gd.trade = { a: userId, b: target.id, offerA: [], offerB: [], cashA: 0, cashB: 0, acceptedA: false, acceptedB: false, channel_id: String(message.channel.id) };
        scheduleAuctionSave();
        await message.channel.send({ embeds: [new EmbedBuilder().setTitle('🔄 Trade Started').setColor(0x00B0F4)
          .setDescription(`**${message.member.displayName}** ↔ **${target.displayName}**\nEach side adds squad players with \`${aucPfx}trade add <player>\` and/or money with \`${aucPfx}trade cash <amount>\`. When both sides total the **same value**, both run \`${aucPfx}trade accept\`.`)] });
        return;
      }

      const t = gd.trade;
      const isParty = (userId === t.a || userId === t.b);

      // Anyone can view; unknown sub on an active trade just shows it
      if (sub === 'view' || sub === 'v' || (!knownSubs.includes(sub) && !isParty)) {
        await message.channel.send({ embeds: [tradeEmbed(gd, message.guild, aucPfx)] }); return;
      }
      if (!isParty) { await message.channel.send('❌ A trade is already in progress between two other members. Try again later.'); return; }

      if (sub === 'cancel') {
        gd.trade = null; scheduleAuctionSave();
        await message.channel.send('🚫 Trade cancelled.');
        return;
      }

      if (sub === 'add' || sub === 'rem' || sub === 'remove') {
        const playerName = parts.slice(2).join(' ').trim();
        if (!playerName) { await message.channel.send(`❌ Usage: \`${aucPfx}trade ${sub} <player>\``); return; }
        const mine  = (userId === t.a) ? t.offerA : t.offerB;
        const squad = gd.squads[userId] || [];
        const eq = (a, b) => a.toLowerCase() === b.toLowerCase();

        if (sub === 'add') {
          const inSquad = squad.find(p => eq(p.player, playerName));
          if (!inSquad) { await message.channel.send(`❌ **${playerName}** is not in your squad.`); return; }
          if (mine.find(p => eq(p.player, playerName))) { await message.channel.send(`❌ **${inSquad.player}** is already in your offer.`); return; }
          mine.push({ player: inSquad.player, price: inSquad.price || 0 });
        } else {
          const idx = mine.findIndex(p => eq(p.player, playerName));
          if (idx === -1) { await message.channel.send(`❌ **${playerName}** is not in your offer.`); return; }
          mine.splice(idx, 1);
        }
        t.acceptedA = false; t.acceptedB = false; // any change invalidates prior accepts
        scheduleAuctionSave();
        await message.channel.send({ embeds: [tradeEmbed(gd, message.guild, aucPfx)] }); return;
      }

      if (sub === 'cash' || sub === 'money') {
        const amt = parseAmount(parts[2]);
        if (amt === null || amt < 0) { await message.channel.send(`❌ Usage: \`${aucPfx}trade cash <amount>\` (use 0 to clear).`); return; }
        const myPurse = gd.purses[userId] || 0;
        if (amt > myPurse) { await message.channel.send(`❌ You only have **${formatAmount(myPurse)}** in your purse.`); return; }
        if (userId === t.a) t.cashA = amt; else t.cashB = amt;
        t.acceptedA = false; t.acceptedB = false;
        scheduleAuctionSave();
        await message.channel.send({ embeds: [tradeEmbed(gd, message.guild, aucPfx)] }); return;
      }

      if (sub === 'accept' || sub === 'ok') {
        const cashA = t.cashA || 0, cashB = t.cashB || 0;
        const totA = sumOffer(t.offerA) + cashA, totB = sumOffer(t.offerB) + cashB;
        if ((t.offerA.length + t.offerB.length) === 0) { await message.channel.send('❌ A trade needs at least one player.'); return; }
        if (!(totA > 0 && totB > 0)) { await message.channel.send('❌ Each side must offer players and/or cash.'); return; }
        if (totA !== totB) { await message.channel.send(`❌ Trade isn't balanced — **${formatAmount(totA)}** vs **${formatAmount(totB)}**. Adjust players or cash first.`); return; }
        if (userId === t.a) t.acceptedA = true; else t.acceptedB = true;
        scheduleAuctionSave();
        if (!(t.acceptedA && t.acceptedB)) {
          const e = tradeEmbed(gd, message.guild, aucPfx).setFooter({ text: `Waiting for the other party to ${aucPfx}trade accept...` });
          await message.channel.send({ embeds: [e] }); return;
        }

        // Both accepted & balanced → validate and execute
        const squadA = gd.squads[t.a] || [], squadB = gd.squads[t.b] || [];
        const findIdx = (squad, name) => squad.findIndex(p => p.player.toLowerCase() === name.toLowerCase());
        for (const p of t.offerA) if (findIdx(squadA, p.player) === -1) { gd.trade = null; scheduleAuctionSave(); await message.channel.send(`❌ Trade aborted — **${p.player}** is no longer in the offering squad.`); return; }
        for (const p of t.offerB) if (findIdx(squadB, p.player) === -1) { gd.trade = null; scheduleAuctionSave(); await message.channel.send(`❌ Trade aborted — **${p.player}** is no longer in the offering squad.`); return; }

        // Purses must still cover the cash each side is putting in
        const purseA = gd.purses[t.a] || 0, purseB = gd.purses[t.b] || 0;
        if (cashA > purseA || cashB > purseB) {
          gd.trade = null; scheduleAuctionSave();
          await message.channel.send('❌ Trade aborted — a party no longer has enough balance for the cash offered.'); return;
        }

        const maxSquad = gd.maxSquad || 0;
        const newA = squadA.length - t.offerA.length + t.offerB.length;
        const newB = squadB.length - t.offerB.length + t.offerA.length;
        if (maxSquad > 0 && (newA > maxSquad || newB > maxSquad)) {
          gd.trade = null; scheduleAuctionSave();
          await message.channel.send(`❌ Trade aborted — it would push a squad over the max size (**${maxSquad}**).`); return;
        }

        const pull = (squad, offer) => offer.map(o => squad.splice(findIdx(squad, o.player), 1)[0]);
        const movedAtoB = pull(squadA, t.offerA);
        const movedBtoA = pull(squadB, t.offerB);
        squadB.push(...movedAtoB);
        squadA.push(...movedBtoA);
        gd.squads[t.a] = squadA; gd.squads[t.b] = squadB;

        // Transfer cash: each side pays its own cash and receives the other's
        gd.purses[t.a] = purseA - cashA + cashB;
        gd.purses[t.b] = purseB - cashB + cashA;

        const nameOf = (uid) => teamLabel(gd, message.guild, uid);
        const recv = (players, cash) => {
          const lines = players.map(p => `**${p.player}** (${formatAmount(p.price)})`);
          if (cash > 0) lines.push(`💰 ${formatAmount(cash)} cash`);
          return lines.join('\n') || '—';
        };
        const embed = new EmbedBuilder().setTitle('✅ Trade Completed').setColor(0xFFD700)
          .addFields(
            { name: `${nameOf(t.a)} received`, value: recv(movedBtoA, cashB), inline: true },
            { name: `${nameOf(t.b)} received`, value: recv(movedAtoB, cashA), inline: true },
            { name: 'New balances', value: `${nameOf(t.a)}: ${formatAmount(gd.purses[t.a])}\n${nameOf(t.b)}: ${formatAmount(gd.purses[t.b])}`, inline: false }
          ).setTimestamp();
        // Detailed audit entry for the log channel
        const logEmbed = new EmbedBuilder().setTitle('🔄 Trade Completed').setColor(0xFFD700)
          .setDescription(`**${nameOf(t.a)}** ⇄ **${nameOf(t.b)}**  ·  value **${formatAmount(totA)}** each side`)
          .addFields(
            { name: `${nameOf(t.a)} → ${nameOf(t.b)}`, value: recv(movedAtoB, cashA), inline: true },
            { name: `${nameOf(t.b)} → ${nameOf(t.a)}`, value: recv(movedBtoA, cashB), inline: true },
            { name: 'New balances', value: `${nameOf(t.a)}: ${formatAmount(gd.purses[t.a])}\n${nameOf(t.b)}: ${formatAmount(gd.purses[t.b])}`, inline: false }
          )
          .setFooter({ text: `Confirmed by ${message.author.tag}` })
          .setTimestamp();
        gd.trade = null; scheduleAuctionSave();
        await flushAuction(); // persist the completed trade (squad ownership change)
        await message.channel.send({ embeds: [embed] });
        await sendLog(message.guild, logEmbed, 'trade');
        return;
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  DRAFT PICKS  (no prefix — the team on the clock just types a name)
  // ════════════════════════════════════════════════════════════════════════
  if (guildId && !usesCg && !usesAuc && auctionData.guilds[guildId]) {
    const gdd = auctionData.guilds[guildId];
    const slot = draftSlot(gdd);
    if (slot && gdd.draft.channelId === message.channel.id && slot.userId === userId) {
      await withDraftLock(guildId, () => handleDraftPickAttempt(message, gdd))
        .catch(e => console.error('Draft pick error:', e));
      return;
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
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });
process.on('exit', (code) => { console.log(`🛑 Process exiting with code ${code}`); });

// ── Graceful shutdown — flush everything before going offline ──────────────
async function shutdownFlush(signal) {
  console.log(`⚠️  Shutdown detected (${signal} — host asked the bot to stop) — flushing data to JSONBin...`);
  await flushAuction(); // auction first so the bin-id pointer is captured before cg saves
  await flushCg();
  console.log('✅ Flush complete. Exiting.');
  process.exit(0);
}
process.on('SIGTERM', () => shutdownFlush('SIGTERM'));
process.on('SIGINT',  () => shutdownFlush('SIGINT'));

// ══════════════════════════════════════════════════════════════════════════════
//  HTTP KEEPALIVE  (for Render / Railway / UptimeRobot)
// ══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot is running!')).listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

// ── Login with loud diagnostics — every outcome must leave a log line ────────
if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN env var is MISSING or empty — the bot cannot log in! Set it in Render → Environment.');
} else {
  console.log(`🔑 Logging in to Discord... (token present: ${DISCORD_TOKEN.length} chars)`);
}
client.on('error',      e => console.error('❌ Client error:', e));
client.on('shardError', e => console.error('❌ Shard error:', e));
client.on('warn',       w => console.warn('⚠️  Client warn:', w));
// Temporary: surface gateway/session debug lines (skips heartbeat spam)
client.on('debug', d => { if (/session|limit|gateway|identif|connect|429|rate/i.test(d)) console.log('🐛', d); });

// Boot-time check: ask Discord directly how many gateway sessions we have left.
// HTTP 401 = bad token · 429 = IP rate-banned · remaining 0 = session limit hit.
if (DISCORD_TOKEN) {
  (async () => {
    try {
      const res = await fetch('https://discord.com/api/v10/gateway/bot', {
        headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
      });
      const j = await res.json().catch(() => ({}));
      console.log(`🌐 /gateway/bot check → HTTP ${res.status} — session_start_limit: ${JSON.stringify(j.session_start_limit || j)}`);
    } catch (e) { console.error('🌐 /gateway/bot check failed (network?):', e.message); }
  })();
}
client.login(DISCORD_TOKEN)
  .then(() => console.log('🔑 Login accepted by Discord — waiting for ready event...'))
  .catch(err => console.error('❌ Discord LOGIN FAILED:', err));

// Watchdog: if we're still not connected 60s after boot, say so explicitly
setTimeout(() => {
  if (!client.isReady()) {
    console.error('⏰ 60s after boot and still NOT connected to Discord. If no LOGIN FAILED error above, the gateway connection is hanging (possible session-start limit — it resets within 24h — or network issue).');
  }
}, 60_000);

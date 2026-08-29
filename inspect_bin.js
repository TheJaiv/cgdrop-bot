// Read-only JSONBin inspector. Never writes. Usage:
//   JSONBIN_KEY=xxx AUCTION_BIN_ID=yyy node inspect_bin.js
//   JSONBIN_KEY=xxx AUCTION_BIN_ID=yyy node inspect_bin.js versions
//   JSONBIN_KEY=xxx AUCTION_BIN_ID=yyy node inspect_bin.js 12     (restore-check one version)
const KEY = process.env.JSONBIN_KEY;
const BIN = process.env.AUCTION_BIN_ID || process.env.BIN;
const arg = process.argv[2];

if (!KEY || !BIN) { console.error('Set JSONBIN_KEY and AUCTION_BIN_ID'); process.exit(1); }

const H = { 'X-Master-Key': KEY };

function summarise(data, label) {
  console.log(`\n──── ${label} ────`);
  if (!data || typeof data !== 'object') { console.log('  (no object)'); return; }
  console.log('  savedAt   :', data._savedAt ? new Date(data._savedAt).toISOString() : '(none)');
  const guilds = data.guilds || {};
  console.log('  guilds    :', Object.keys(guilds).length);
  for (const [gid, gd] of Object.entries(guilds)) {
    const squads = gd.squads || {}, purses = gd.purses || {}, teams = gd.teams || {};
    const players = Object.values(squads).reduce((s, a) => s + (a || []).length, 0);
    const open = gd.open || {};
    const pool = Object.keys(open.players || {}).length;
    const bids = Object.values(open.players || {}).filter(p => p.uid).length;
    console.log(`   • ${gid}`);
    console.log(`       teams ${Object.keys(teams).length} · purses ${Object.keys(purses).length} · squads ${Object.keys(squads).length} holding ${players} player(s)`);
    console.log(`       open auction: ${open.active ? 'LIVE' : open.settledAt ? 'settled' : 'idle'} · pool ${pool} · ${bids} with bids · results ${open.results ? (open.results.awards || []).length + ' awards' : 'none'}`);
  }
}

(async () => {
  if (arg === 'versions') {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/versions`, { headers: H });
    const json = await res.json().catch(() => null);
    console.log('versions endpoint says:');
    console.log(JSON.stringify(json, null, 2).slice(0, 4000));
    return;
  }

  const path = /^\d+$/.test(arg || '') ? `/${arg}` : '/latest';
  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN}${path}`, { headers: H });
  const json = await res.json().catch(() => null);
  if (!res.ok) { console.error('HTTP', res.status, JSON.stringify(json)); process.exit(1); }
  const data = json.record;
  summarise(data, `bin ${BIN}${path}`);
  console.log('\n  raw size  :', JSON.stringify(data).length, 'bytes');
})();

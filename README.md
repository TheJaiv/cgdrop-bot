# CGDrop Bot

A Discord bot for card-game servers that handles **drop reminders** and **player auctions**, from quick one-at-a-time sales to days-long open auctions where everyone bids at once.

## Features

- **Drop reminders:** pings players when their next drop is ready
- **Live auctions:** `/sell` puts a player up with a base price and minimum increment (amounts like `2m` or `500k`)
- **Open auctions:** a days-long mode with player pools, team purses, start, pause, extend and end controls, and a bid log
- **Bidding tools:** place bids, jump to the next valid bid, set a max autobid, search players, and see your active bids
- **Per-server prefixes:** separate, configurable prefixes for reminders (`!`), auctions (`.`) and open auctions (`$`), so commands never clash

## Tech

- Node.js with [discord.js](https://discord.js.org/), using slash commands, embeds and buttons
- Data stored in JSONBin, with a local JSON fallback for auction data

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Set these environment variables (never commit them):

   | Variable | Purpose |
   | --- | --- |
   | `DISCORD_TOKEN` | Bot token from the Discord Developer Portal |
   | `OWNER_ID` | Your Discord user ID (owner-only commands) |
   | `JSONBIN_KEY` | JSONBin API key |
   | `CGDROP_BIN_ID` | JSONBin bin for reminder data |
   | `AUCTION_BIN_ID` | JSONBin bin for auction data |
   | `PORT` | Port for the keep-alive HTTP server |

3. Start the bot:
   ```bash
   node bot.js
   ```

## Commands (examples)

| Command | What it does |
| --- | --- |
| `/sell player base [increment]` | Start an auction for a player |
| `.bid` / `.b` | Bid on the current player |
| `.autobid` / `.ab` | Set a maximum autobid |
| `.search` / `.s` | Find a player |
| `.mybids` / `.mb` | List your active bids |
| `$openstart`, `$openpause`, `$openend` | Run an open auction |
| `/setcgprefix`, `/setauctionprefix`, `/setopenprefix` | Change prefixes for this server |

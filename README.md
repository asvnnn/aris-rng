# A.R.I.S — Discord RNG Bot & Web OS

A Discord RNG game bot built with `discord.js` v14 and MySQL, paired with a browser-based **Web OS** (`>web`) that syncs directly with your Discord player profile.

## Features

- **RNG & Multi-Layer Luck System**: Roll numbers from `1` to `∞` (and negative rolls for `NULL`) with 4 luck layers (`Basic Luck`, `Multi Luck`, `Special Luck`, `FINAL LUCK`), pity mechanics, and active Discord frames.
- **Shop, Black Market & Crafting**: Buy and craft Potions, Modules, and Chips, with a timed Black Market (`>bshop`) offering discounted and exclusive endgame items.
- **Progression & Economy**: Daily rewards, Daily Quests & Token Shop, Achievements, Titles, Pray buffs, and global Leaderboards.
- **Interactive Web OS (`>web`)**: A desktop-style web interface served from `public/` with Discord OAuth2 / session login and real-time account sync.
- **Slash & Prefix Support**: Supports both prefix commands (default `>`) and Discord Slash Commands.

## Prerequisites

- **Node.js** v20+
- **MySQL** (create an empty database, e.g. `aris_db`)
- **Discord Bot Application** (`TOKEN`, `CLIENT_ID`, and **Message Content Intent** enabled for prefix commands)

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Key variables in `.env`:

| Variable | Description |
| --- | --- |
| `TOKEN` | Discord bot token |
| `CLIENT_ID` | Discord application client ID |
| `PREFIX` | Prefix for text commands (default: `>`) |
| `DEV_IDS` | Comma-separated Discord user IDs for developer commands |
| `DATABASE_URL` | MySQL connection string (or use `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`) |
| `PORT` | HTTP port for the Web OS & `/health` endpoint (default: `10000`) |
| `REGISTER_SLASH_COMMANDS` | Set `true` to register slash commands on startup |

> **Note for Web OS OAuth2:** If you enable Discord OAuth2 login on Web OS, also set `CLIENT_SECRET` (and `PUBLIC_WEB_URL` when hosting behind a public domain).

### 3. Run the bot

```bash
npm start
```

- **Windows**: You can also run `start_local.bat`.
- **Docker**:
  ```bash
  docker build -t aris-rng .
  docker run --env-file .env -p 10000:10000 aris-rng
  ```

## Commands

| Category | Command | Aliases | Description |
| --- | --- | --- | --- |
| **Core** | `>roll` | `>r` | Roll a number |
| | `>daily` | — | Claim daily rewards |
| | `>pray` | — | Pray for permanent luck |
| | `>quest` | `>q` | Daily quests & Token Shop |
| **Economy** | `>shop` | — | Buy & craft potions, modules, and chips |
| | `>bshop` | — | Black Market shop |
| | `>inv` | `>inventory` | Manage inventory & storage |
| | `>leaderboard` | `>l` | Global rankings |
| **Profile** | `>stat` | — | View player profile |
| | `>status` | `>s` | View active luck modifiers |
| | `>achieve` | — | View achievements |
| | `>title` | — | Equip unlocked titles |
| | `>setting` | `>settings` | Configure privacy, auto-sell, and alerts |
| **Extras** | `>code` | — | Redeem promotional codes |
| | `>web` | — | Launch A.R.I.S Web OS |
| | `>guild` | — | In-game guide |
| | `>help` | `>h`, `>cmds` | List all commands |

## Project Structure

```text
├── public/          # Web OS frontend (HTML, CSS, client JS, assets)
├── src/
│   ├── commands/    # Prefix & slash command handlers
│   ├── config/      # Environment & constant configuration
│   ├── data/        # Items, achievements, quests, and titles
│   ├── database/    # MySQL connection & user data model
│   ├── events/      # Discord gateway & component interaction handlers
│   ├── systems/     # RNG engine, economy, quests, Black Market, leaderboards
│   ├── utils/       # Math, catalog, and Discord frame helpers
│   └── web/         # Web OS HTTP router & service layer
├── Dockerfile
├── LICENSE
├── .env.example
├── package.json
└── start_local.bat
```

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** — see the [LICENSE](LICENSE) file for details. Any modified version hosted or run over a network must also release its corresponding source code under AGPL-3.0.

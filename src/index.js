const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

const http = require('http');
const { Client, GatewayIntentBits, Partials, Collection, Options } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { TOKEN, PORT } = require('./config/constants');
const pool = require('./database/connection');
const { initDB } = require('./database/userModel');
const { setMainClient } = require('./utils/discord');
const { handleWebRequest } = require('./web/router');

const server = http.createServer((req, res) => {
    handleWebRequest(req, res);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.warn(`⚠️ Port ${PORT} is already in use. Continuing Discord bot startup without HTTP health server...`);
    } else {
        console.error('❌ HTTP Server Error:', err.message);
    }
});

server.listen(PORT, () => {
    console.log(`🌐 Server active on port ${PORT}`);
});

function createBotClient() {
    const botClient = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages
        ],
        partials: [Partials.Channel, Partials.Message],
        makeCache: Options.cacheWithLimits({
            ...Options.DefaultMakeCacheSettings,
            MessageManager: 50,
            ReactionManager: 0,
            GuildMemberManager: {
                maxSize: 200,
                keepOverLimit: (member) => member.id === botClient.user?.id
            },
            ThreadManager: 25,
            PresenceManager: 0,
            VoiceStateManager: 0,
            BaseGuildEmojiManager: 0,
            GuildStickerManager: 0,
            GuildScheduledEventManager: 0,
            AutoModerationRuleManager: 0
        }),
        sweepers: {
            ...Options.DefaultSweeperSettings,
            messages: {
                interval: 300,
                lifetime: 600
            }
        }
    });
    botClient.commands = new Collection();
    return botClient;
}

const client = createBotClient();
setMainClient(client);

const loadCommands = (targetClient) => {
    const commandsPath = path.join(__dirname, 'commands');
    const commandFolders = fs.readdirSync(commandsPath);

    for (const folder of commandFolders) {
        const folderPath = path.join(commandsPath, folder);
        if (!fs.statSync(folderPath).isDirectory()) continue;
        const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));
        for (const file of commandFiles) {
            const command = require(path.join(folderPath, file));
            if (command.name) {
                targetClient.commands.set(command.name, command);
                if (command.aliases && Array.isArray(command.aliases)) {
                    command.aliases.forEach(alias => targetClient.commands.set(alias, command));
                }
            }
        }
    }
    console.log(`✅ Loaded ${targetClient.commands.size} commands/aliases.`);
};

const loadEvents = (targetClient) => {
    const eventsPath = path.join(__dirname, 'events');
    const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

    for (const file of eventFiles) {
        const event = require(path.join(eventsPath, file));
        if (event.once) {
            targetClient.once(event.name, (...args) => event.execute(...args, targetClient));
        } else {
            targetClient.on(event.name, (...args) => event.execute(...args, targetClient));
        }
    }
    console.log(`✅ Loaded ${eventFiles.length} events.`);
};

process.on('unhandledRejection', (r) => console.error('[Anti-Crash] Unhandled Rejection:', r));
process.on('uncaughtException', (e) => console.error('[Anti-Crash] Uncaught Exception:', e));
client.on('error', e => console.error('[Anti-Crash] Discord Client Error:', e));

let shuttingDown = false;
const gracefulShutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`🛑 Received ${signal}. Shutting down gracefully...`);
    try {
        server.close();
        client.destroy();
        if (typeof pool.closePool === 'function') {
            await pool.closePool();
        }
    } catch (err) {
        console.error('❌ Shutdown Error:', err.message);
    } finally {
        process.exit(0);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

loadCommands(client);
loadEvents(client);

(async () => {
    if (TOKEN) {
        await initDB();
        console.log("⏳ Logging into Discord Bot (.A.R.I.S)...");
        client.login(TOKEN).then(() => {
            console.log("✅ Discord Login successful!");
        }).catch(err => console.error("❌ Discord Login Error:", err));
    } else {
        console.warn("⚠️ No Discord TOKEN found in environment variables. Discord bot login skipped.");
    }
})();

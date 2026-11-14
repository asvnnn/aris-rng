const { ActivityType, REST, Routes, Events } = require('discord.js');
const { initDB } = require('../database/userModel');
const { TOKEN, CLIENT_ID, REGISTER_SLASH_COMMANDS } = require('../config/constants');
const { updateLeaderboard } = require('../systems/leaderboardSystem');

module.exports = {
    name: Events?.ClientReady || 'clientReady',
    once: true,
    async execute(client) {
        await initDB();

        console.log(`[A.R.I.S] Logged in as ${client.user.tag}!`);

        updateLeaderboard().catch(() => {});

        const setStatus = () => {
            client.user.setPresence({
                status: 'online',
                activities: [{ name: '>help | A.R.I.S', type: ActivityType.Playing }]
            });
        };
        setStatus();
        const statusTimer = setInterval(setStatus, 600000);
        if (typeof statusTimer.unref === 'function') statusTimer.unref();

        if (REGISTER_SLASH_COMMANDS && TOKEN) {
            try {
                const slashData = [];
                const seen = new Set();
                for (const [, cmd] of client.commands) {
                    if (!cmd.name || seen.has(cmd.name)) continue;
                    seen.add(cmd.name);
                    if (['control', 'ccode'].includes(cmd.name)) continue;
                    if (cmd.data && typeof cmd.data.toJSON === 'function') {
                        slashData.push(cmd.data.toJSON());
                    }
                }
                if (slashData.length > 0) {
                    const rest = new REST({ version: '10' }).setToken(TOKEN);
                    const appId = CLIENT_ID || client.user.id;
                    await rest.put(Routes.applicationCommands(appId), { body: slashData });
                    console.log(`✅ Registered ${slashData.length} global Slash Commands.`);
                }
            } catch (e) {
                console.error('⚠️ Slash Command Registration Warning:', e.message);
            }
        }

        console.log('✅ Bot is fully ready!');
    }
};

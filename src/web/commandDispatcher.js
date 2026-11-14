const fs = require('fs');
const path = require('path');
const { getUser } = require('../database/userModel');
const { DEV_IDS } = require('../config/constants');
const { acquireLock, releaseLock, FrameManager } = require('../utils/discord');

const commands = new Map();
const aliases = new Map();

function initCommands() {
    if (commands.size > 0) return;
    const baseDir = path.join(__dirname, '../commands');
    if (!fs.existsSync(baseDir)) return;

    function scanDir(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scanDir(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.js')) {
                try {
                    const cmd = require(fullPath);
                    if (cmd && cmd.name) {
                        commands.set(cmd.name.toLowerCase(), cmd);
                        if (Array.isArray(cmd.aliases)) {
                            for (const al of cmd.aliases) {
                                aliases.set(al.toLowerCase(), cmd.name.toLowerCase());
                            }
                        }
                    }
                } catch (e) {
                    console.error(`Failed to load command ${fullPath}:`, e.message);
                }
            }
        }
    }
    scanDir(baseDir);
}

const COMMAND_WINDOW_MAP = {
    roll: { winId: 'win-roll', tab: null },
    r: { winId: 'win-roll', tab: null },
    shop: { winId: 'win-shop', tab: 'potions' },
    bshop: { winId: 'win-shop', tab: 'bshop' },
    inv: { winId: 'win-inventory', tab: 'rolls' },
    inventory: { winId: 'win-inventory', tab: 'rolls' },
    status: { winId: 'win-taskmgr', tab: null },
    s: { winId: 'win-taskmgr', tab: null },
    stat: { winId: 'win-profile', tab: 'stat' },
    achieve: { winId: 'win-profile', tab: 'achieve' },
    title: { winId: 'win-profile', tab: 'titles' },
    daily: { winId: 'win-hub', tab: 'daily' },
    pray: { winId: 'win-hub', tab: 'pray' },
    quest: { winId: 'win-hub', tab: 'quests' },
    code: { winId: 'win-hub', tab: 'code' },
    leaderboard: { winId: 'win-leaderboard', tab: null },
    lb: { winId: 'win-leaderboard', tab: null },
    setting: { winId: 'win-settings', tab: null }
};

function getCommandWindowTarget(cmdName) {
    return COMMAND_WINDOW_MAP[cmdName] || null;
}

function cleanDiscordFormatting(text) {
    if (!text || typeof text !== 'string') return '';
    let out = text;
    out = out.replace(/\u001b\[[0-9;]*m/g, '');
    out = out.replace(/```[a-zA-Z]*\n?/g, '');
    out = out.replace(/```/g, '');
    out = out.replace(/<t:(\d+):[A-Za-z]>/g, (m, ts) => {
        const sec = Number(ts);
        const diff = sec - Math.floor(Date.now() / 1000);
        if (diff > 0) return `in ${diff}s`;
        if (diff < 0) return `${Math.abs(diff)}s ago`;
        return 'now';
    });
    out = out.replace(/\*\*(.*?)\*\*/g, '$1');
    out = out.replace(/__(.*?)__/g, '$1');
    out = out.replace(/\*(.*?)\*/g, '$1');
    out = out.replace(/`(.*?)`/g, '$1');
    return out.trim();
}

function formatPayload(payload) {
    const lines = [];
    if (typeof payload === 'string') {
        lines.push(cleanDiscordFormatting(payload));
    } else if (payload && typeof payload === 'object') {
        if (payload.content) {
            lines.push(cleanDiscordFormatting(payload.content));
        }
        if (Array.isArray(payload.embeds)) {
            for (const emb of payload.embeds) {
                const data = emb.data || emb;
                if (data.author && data.author.name) lines.push(`[${cleanDiscordFormatting(data.author.name)}]`);
                if (data.title) lines.push(`=== ${cleanDiscordFormatting(data.title)} ===`);
                if (data.description) lines.push(cleanDiscordFormatting(data.description));
                if (Array.isArray(data.fields)) {
                    for (const f of data.fields) {
                        lines.push(`• ${cleanDiscordFormatting(f.name)}: ${cleanDiscordFormatting(f.value)}`);
                    }
                }
                if (data.footer && data.footer.text) {
                    lines.push(`[${cleanDiscordFormatting(data.footer.text)}]`);
                }
            }
        }
    }
    return lines.filter(Boolean).join('\n');
}

async function dispatchTerminalCommand(userId, commandStr) {
    initCommands();
    const raw = (commandStr || '').trim();
    if (!raw) return { output: '', openWindow: null, openTab: null };

    const cleanInput = raw.replace(/^[>/]/, '').trim();
    const parts = cleanInput.split(/\s+/);
    const trigger = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (trigger === 'cls' || trigger === 'clear') {
        return { output: '__CLEAR__', openWindow: null, openTab: null };
    }

    if (trigger === 'logout') {
        return {
            output: '⚠️ Are you sure you want to log out of A.R.I.S Web OS? (Y/N)',
            openWindow: null,
            openTab: null
        };
    }

    if (trigger === 'shutdown') {
        return {
            output: '🛑 Are you sure you want to shut down A.R.I.S OS? (Y/N)',
            openWindow: null,
            openTab: null
        };
    }

    if (trigger === 'pshop') {
        return {
            output: `'${trigger}' is not recognized as a command. Type '>help' to view available commands.`,
            openWindow: null,
            openTab: null
        };
    }

    let cmdName = trigger;
    if (!commands.has(cmdName) && aliases.has(cmdName)) {
        cmdName = aliases.get(cmdName);
    }

    const command = commands.get(cmdName);
    if (!command || typeof command.executePrefix !== 'function') {
        return {
            output: `'${trigger}' is not recognized as a command. Type '>help' to view available commands.`,
            openWindow: null,
            openTab: null
        };
    }

    const winTarget = getCommandWindowTarget(cmdName);

    await acquireLock(userId);
    try {
        let userDb = await getUser(userId);
        if (!userDb) {
            return {
                output: 'User account not found in database.',
                openWindow: null,
                openTab: null
            };
        }

        if (userDb.is_banned === 1 && !DEV_IDS.includes(userId)) {
            return {
                output: '❌ Your account is currently suspended.',
                openWindow: null,
                openTab: null
            };
        }

        const outputs = [];
        const capture = (payload) => {
            const formatted = formatPayload(payload);
            if (formatted) outputs.push(formatted);
        };

        const avatarFn = () => 'https://cdn.discordapp.com/embed/avatars/0.png';
        const authorObj = {
            id: userDb.id,
            username: userDb.username || 'Player',
            globalName: userDb.username || 'Player',
            displayName: userDb.username || 'Player',
            bot: false,
            displayAvatarURL: avatarFn,
            send: async (payload) => {
                capture(payload);
                return mockMsg;
            }
        };

        const normalizedContent = raw.startsWith('>') || raw.startsWith('/') ? raw : `>${raw}`;

        const mockMsg = {
            id: 'web_msg_' + Date.now(),
            content: normalizedContent,
            author: authorObj,
            user: authorObj,
            member: {
                id: userDb.id,
                user: authorObj,
                displayName: userDb.username || 'Player',
                displayAvatarURL: avatarFn
            },
            mentions: {
                users: {
                    size: 0,
                    first: () => null
                },
                channels: {
                    size: 0,
                    first: () => null
                }
            },
            guild: null,
            channelId: 'web_channel_' + userDb.id,
            channel: {
                id: 'web_channel_' + userDb.id,
                send: async (payload) => {
                    capture(payload);
                    return mockMsg;
                }
            },
            reply: async (payload) => {
                capture(payload);
                return mockMsg;
            },
            edit: async (payload) => {
                capture(payload);
                return mockMsg;
            },
            deletable: true,
            delete: async () => {}
        };

        const mockClient = {
            commands,
            isSandbox: false,
            user: {
                id: 'bot_aris',
                username: 'A.R.I.S',
                displayAvatarURL: avatarFn
            },
            users: {
                fetch: async (targetId) => {
                    const targetDb = await getUser(targetId);
                    return {
                        id: targetId,
                        username: targetDb?.username || `User_${String(targetId).slice(0, 6)}`,
                        globalName: targetDb?.username || `User_${String(targetId).slice(0, 6)}`,
                        bot: false,
                        displayAvatarURL: avatarFn
                    };
                }
            }
        };

        FrameManager.removeFrame(userId);
        await command.executePrefix(mockMsg, args, userDb, mockClient);
        FrameManager.removeFrame(userId);
        return {
            output: outputs.length > 0 ? outputs.join('\n\n') : 'Command executed successfully.',
            openWindow: winTarget ? winTarget.winId : null,
            openTab: winTarget ? winTarget.tab : null,
            commandName: cmdName
        };
    } catch (err) {
        console.error('Command Execution Error:', err);
        return {
            output: `❌ Command Error (${trigger}): ${err.message}`,
            openWindow: winTarget ? winTarget.winId : null,
            openTab: winTarget ? winTarget.tab : null,
            commandName: cmdName
        };
    } finally {
        releaseLock(userId);
    }
}

module.exports = {
    initCommands,
    dispatchTerminalCommand,
    getCommandWindowTarget
};

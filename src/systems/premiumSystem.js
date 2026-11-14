const { pool, getUser, saveUser, giveItem, takeItem } = require('../database/userModel');
const { grantAchievement, clearAchievementCache } = require('./achievementSystem');
const { spawnBlackMarket } = require('./blackMarket');
const { acquireLock, releaseLock } = require('../utils/discord');
const { POTIONS, MODULES, CHIPS } = require('../data/items');
const TITLES = require('../data/titles');
const ACHIEVEMENTS = require('../data/achievements');

async function resolveTargetUser(client, rawInput) {
    if (!rawInput) return null;
    const clean = rawInput.replace(/[<@!>]/g, '').trim();
    if (!clean) return null;

    let targetId = null;
    let dbRow = null;

    const [rows] = await pool.execute(
        'SELECT id, username FROM users WHERE id = ? OR LOWER(username) = LOWER(?) LIMIT 1',
        [clean, clean]
    );
    if (rows.length > 0) {
        dbRow = rows[0];
        targetId = dbRow.id;
    } else if (/^\d{16,21}$/.test(clean)) {
        targetId = clean;
    }

    if (!targetId) return null;

    let discordUser = null;
    if (client && client.users) {
        try {
            discordUser = await client.users.fetch(targetId);
        } catch (e) {}
    }

    const userDb = await getUser(targetId, discordUser ? discordUser.username : (dbRow ? dbRow.username : null));
    const displayName = discordUser
        ? discordUser.username
        : (userDb.username || `User_${targetId}`);
    const username = discordUser ? discordUser.username : (userDb.username || 'Unknown');
    const avatarUrl = discordUser
        ? discordUser.displayAvatarURL({ extension: 'png', size: 256 })
        : 'https://cdn.discordapp.com/embed/avatars/0.png';

    return {
        id: targetId,
        userDb,
        discordUser,
        displayName,
        username,
        avatarUrl
    };
}

async function executeVerifiedControl(payload) {
    const { action, targetId, value, qty } = payload;

    if (action === 'wipealldata') {
        await pool.execute('DELETE FROM users');
        await pool.execute('DELETE FROM inventory');
        await pool.execute('DELETE FROM items');
        await pool.execute('DELETE FROM active_potions');
        await pool.execute('DELETE FROM achievements');
        clearAchievementCache();
        return `✅ **DATABASE WIPED.** All player tables and achievements cleared.`;
    }

    await acquireLock(targetId);
    try {
        if (action === 'deletedata') {
            await pool.execute('DELETE FROM users WHERE id = ?', [targetId]);
            await pool.execute('DELETE FROM inventory WHERE user_id = ?', [targetId]);
            await pool.execute('DELETE FROM items WHERE user_id = ?', [targetId]);
            await pool.execute('DELETE FROM active_potions WHERE user_id = ?', [targetId]);
            await pool.execute('DELETE FROM achievements WHERE user_id = ?', [targetId]);
            clearAchievementCache(targetId);
            return `✅ **Deleted all database records** for User ID \`${targetId}\`.`;
        }

        const u = await getUser(targetId);

        if (action === 'forcebshop') {
            spawnBlackMarket(targetId);
            return `✅ **Personal Black Market** spawned for **${u.username}** (Active for 10m).`;
        }
        if (action === 'ban' || action === 'banland') {
            u.is_banned = 1;
            await saveUser(u);
            return `🔨 **Banned** player **${u.username}** (\`${targetId}\`).`;
        }
        if (action === 'unban') {
            u.is_banned = 0;
            await saveUser(u);
            return `✅ **Unbanned** player **${u.username}** (\`${targetId}\`).`;
        }

        if (action === 'addcoin') u.coins = (BigInt(u.coins) + BigInt(value)).toString();
        else if (action === 'setcoin') u.coins = BigInt(value).toString();
        else if (action === 'addcrys') u.crystals = (BigInt(u.crystals) + BigInt(value)).toString();
        else if (action === 'setcrys') u.crystals = BigInt(value).toString();
        else if (action === 'addnull') u.nulls = (BigInt(u.nulls) + BigInt(value)).toString();
        else if (action === 'setnull') u.nulls = BigInt(value).toString();
        else if (action === 'addcc') u.cc_coins = (BigInt(u.cc_coins || 0) + BigInt(value)).toString();
        else if (action === 'setcc') u.cc_coins = BigInt(value || 0).toString();
        else if (action === 'addtoken') u.quest_tokens = (parseInt(u.quest_tokens, 10) || 0) + parseInt(value, 10);
        else if (action === 'settoken') u.quest_tokens = parseInt(value, 10) || 0;
        else if (action === 'addperm') u.permanent_basic_luck = (parseFloat(u.permanent_basic_luck) || 0) + parseFloat(value);
        else if (action === 'setperm') u.permanent_basic_luck = parseFloat(value) || 0;
        else if (action === 'fixedluck') u.fixed_luck = parseFloat(value) || 0;
        else if (action === 'additem') {
            const itemObj = POTIONS[value] || MODULES[value] || CHIPS[value];
            if (!itemObj) {
                return `❌ Unknown item ID \`${value}\`. Use \`>control itemlist\` to see valid IDs.`;
            }
            await giveItem(targetId, value, parseInt(qty, 10) || 1);
        }
        else if (action === 'removeitem') {
            await takeItem(targetId, value, parseInt(qty, 10) || 1);
            if (u.equipped_module === value || u.equipped_chip === value) {
                const [rem] = await pool.execute('SELECT quantity FROM items WHERE user_id=? AND item_id=?', [targetId, value]);
                const left = (rem && rem.length > 0) ? (Number(rem[0].quantity) || 0) : 0;
                if (left <= 0) {
                    if (u.equipped_module === value) u.equipped_module = null;
                    if (u.equipped_chip === value) u.equipped_chip = null;
                }
            }
        }
        else if (action === 'giveachieve') {
            if (!ACHIEVEMENTS[value]) {
                return `❌ Unknown achievement ID \`${value}\`. Use \`>control achievelist\` to see valid IDs.`;
            }
            await grantAchievement(u, value);
        }
        else if (action === 'givetitle') {
            if (!TITLES[value]) {
                return `❌ Unknown title ID \`${value}\`. Use \`>control titlelist\` to see valid IDs.`;
            }
            let unlocked = JSON.parse(u.unlocked_titles || '[]');
            if (!unlocked.includes(value)) {
                unlocked.push(value);
                u.unlocked_titles = JSON.stringify(unlocked);
            }
        } else if (action === 'removeeffect') {
            if (value === 'all') {
                await pool.execute('DELETE FROM active_potions WHERE user_id = ?', [targetId]);
            } else {
                await pool.execute('DELETE FROM active_potions WHERE user_id = ? AND potion_id = ?', [targetId, value]);
            }
        } else {
            return `❌ Unknown control action: \`${action}\`.`;
        }

        await saveUser(u);
        return `✅ **Executed!** \`${action}\` (\`${value || ''}${qty ? ` x${qty}` : ''}\`) on **${u.username}** (\`${targetId}\`).`;
    } finally {
        releaseLock(targetId);
    }
}

module.exports = {
    resolveTargetUser,
    executeVerifiedControl
};

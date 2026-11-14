const { pool, saveUser, giveItem } = require('../database/userModel');
const ACHIEVEMENTS = require('../data/achievements');

const unlockedCache = new Map();

function clearAchievementCache(userId = null) {
    if (!userId) {
        unlockedCache.clear();
        return;
    }
    unlockedCache.delete(String(userId));
}

const MAX_ACHIEVEMENT_CACHE_USERS = 5000;

async function grantAchievement(userDb, achieveId) {
    if (!userDb || !userDb.id) return null;

    const a = ACHIEVEMENTS[achieveId];
    if (!a) return null;

    const cacheKey = String(userDb.id);
    let userSet = unlockedCache.get(cacheKey);
    if (!userSet) {
        const [rows] = await pool.execute('SELECT achievement_id FROM achievements WHERE user_id=?', [userDb.id]);
        userSet = new Set((rows || []).map(r => r.achievement_id).filter(Boolean));
        if (unlockedCache.size >= MAX_ACHIEVEMENT_CACHE_USERS) {
            const oldestKey = unlockedCache.keys().next().value;
            if (oldestKey !== undefined) unlockedCache.delete(oldestKey);
        }
        unlockedCache.set(cacheKey, userSet);
    }

    if (userSet.has(achieveId)) {
        return null;
    }

    await pool.execute('INSERT IGNORE INTO achievements (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)', [userDb.id, achieveId, Date.now()]);
    userSet.add(achieveId);

    if (a.rewards) {
        if (a.rewards.coins) userDb.coins = (BigInt(userDb.coins) + BigInt(a.rewards.coins)).toString();
        if (a.rewards.crystals) { 
            if (userDb.crystals === '0') await grantAchievement(userDb, 'miner'); 
            userDb.crystals = (BigInt(userDb.crystals) + BigInt(a.rewards.crystals)).toString(); 
            if (BigInt(userDb.crystals) >= 100000n) await grantAchievement(userDb, 'geologist');
        }
        if (a.rewards.nulls) {
            userDb.nulls = (BigInt(userDb.nulls) + BigInt(a.rewards.nulls)).toString();
        }
        if (a.rewards.cc) userDb.cc_coins = (BigInt(userDb.cc_coins || 0) + BigInt(a.rewards.cc)).toString();
        
        if (a.rewards.items) { 
            for (let [itemId, qty] of Object.entries(a.rewards.items)) {
                await giveItem(userDb.id, itemId, qty);
            }
        }
        if (a.rewards.title) {
            let unlockedTitles = [];
            try { unlockedTitles = JSON.parse(userDb.unlocked_titles || '[]'); } catch (e) {}
            if (!unlockedTitles.includes(a.rewards.title)) {
                unlockedTitles.push(a.rewards.title);
                userDb.unlocked_titles = JSON.stringify(unlockedTitles);
            }
        }
    }

    if (achieveId === 'duplicate') { 
        let pots = Math.floor(userDb.total_rolls / 50); 
        if (pots > 0) await giveItem(userDb.id, 'pot_heavenly', pots); 
    }

    await saveUser(userDb); 
    return `🏆 **Achievement Unlocked:** ${a.name}`;
}

module.exports = { grantAchievement, clearAchievementCache };

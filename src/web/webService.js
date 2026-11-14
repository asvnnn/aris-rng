const crypto = require('crypto');
const { pool, getUser, saveUser, giveItem, takeItem } = require('../database/userModel');
const { calcStats, generateHighPrecisionRoll } = require('../utils/math');
const { POTIONS, MODULES, CHIPS } = require('../data/items');
const TITLES = require('../data/titles');
const ACHIEVEMENTS = require('../data/achievements');
const QUESTS = require('../data/quests');
const { doPurchase, doUse, resetModuleStacks, resetChipStacks } = require('../systems/economySystem');
const { grantAchievement } = require('../systems/achievementSystem');
const { ensureQuestDataInMemory, applyQuestProgressInMemory, getQuestGoal, claimQuest, rerollQuest } = require('../systems/questSystem');
const { getBlackMarketData, closeBlackMarket } = require('../systems/blackMarket');
const {
    resolveTargetUser,
    executeVerifiedControl
} = require('../systems/premiumSystem');
const { updateLeaderboard } = require('../systems/leaderboardSystem');
const { acquireLock, releaseLock, getMainClient } = require('../utils/discord');
const { notifyDiscord } = require('../utils/discordNotifier');

function formatBigInt(bi) {
    return BigInt(bi || 0).toLocaleString('en-US');
}

function getCurrentPeriods(now = Date.now()) {
    const dt = new Date(now);
    const utcWeek = Math.floor(now / (7 * 86400000));
    const utcMonth = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
    return { utcWeek, utcMonth };
}

function syncPeriodStats(u, now = Date.now()) {
    const { utcWeek, utcMonth } = getCurrentPeriods(now);
    if (u.utc_week !== utcWeek) {
        u.utc_week = utcWeek;
        u.weekly_rolls = 0;
        u.weekly_score = '0';
        u.weekly_pos = '0';
        u.weekly_neg = '0';
    }
    if (u.utc_month !== utcMonth) {
        u.utc_month = utcMonth;
        u.monthly_rolls = 0;
        u.monthly_score = '0';
        u.monthly_pos = '0';
        u.monthly_neg = '0';
    }
}

async function getUsersList() {
    try {
        const [rows] = await pool.execute('SELECT id, username, total_rolls, coins, crystals, is_banned FROM users ORDER BY total_rolls DESC LIMIT 50');
        return rows || [];
    } catch (e) {
        return [];
    }
}

async function getPlayerData(userId) {
    const u = await getUser(userId);
    const [[ap], [inv], [items], [achRows]] = await Promise.all([
        pool.execute('SELECT * FROM active_potions WHERE user_id = ?', [userId]),
        pool.execute('SELECT * FROM inventory WHERE user_id = ?', [userId]),
        pool.execute('SELECT * FROM items WHERE user_id = ? AND quantity > 0', [userId]),
        pool.execute('SELECT achievement_id FROM achievements WHERE user_id = ?', [userId])
    ]);

    if (inv && inv.length > 1) {
        inv.sort((a, b) => {
            const va = BigInt(a.roll_value || '0');
            const vb = BigInt(b.roll_value || '0');
            return vb > va ? 1 : (vb < va ? -1 : 0);
        });
    }

    const st = calcStats(u, ap);

    await grantAchievement(u, 'web_hi');

    let rawAdObj = {};
    try {
        if (u.ad_data) rawAdObj = JSON.parse(u.ad_data);
    } catch (e) { rawAdObj = {}; }

    const osPrefs = {
        theme: rawAdObj.theme === 'light' ? 'light' : 'dark',
        disable_welcome: Boolean(rawAdObj.disable_welcome),
        hide_watermark: Boolean(rawAdObj.hide_watermark)
    };

    const ownedMap = {};
    const ownedPotions = [];
    const ownedHardware = [];
    for (const it of items) {
        const id = it.item_id;
        const qty = it.quantity;
        ownedMap[id] = qty;
        if (POTIONS[id]) {
            ownedPotions.push({
                id,
                name: POTIONS[id].name || id,
                rank: POTIONS[id].rank,
                count: qty,
                effectText: POTIONS[id].effectText || '',
                dur: POTIONS[id].dur || 1
            });
        } else if (MODULES[id]) {
            ownedHardware.push({
                id,
                type: 'module',
                name: MODULES[id].name || id,
                count: qty,
                isEquipped: u.equipped_module === id,
                effectText: MODULES[id].effectText || ''
            });
        } else if (CHIPS[id]) {
            ownedHardware.push({
                id,
                type: 'chip',
                name: CHIPS[id].name || id,
                count: qty,
                isEquipped: u.equipped_chip === id,
                effectText: CHIPS[id].effectText || ''
            });
        }
    }

    const expandCost = (BigInt(2) ** BigInt(Math.max(0, (u.slots || 10) - 10))).toString();

    let unlockedTitles = [];
    try { unlockedTitles = JSON.parse(u.unlocked_titles || '[]'); } catch (e) { unlockedTitles = []; }
    const titleCounts = {};
    for (const tId of unlockedTitles) {
        titleCounts[tId] = (titleCounts[tId] || 0) + 1;
    }

    let customTitlesMap = {};
    try { customTitlesMap = JSON.parse(u.custom_titles || '{}'); } catch (e) { customTitlesMap = {}; }

    const unlockedAchIds = achRows.map(a => a.achievement_id);

    const now = Date.now();
    const curUtcDay = Math.floor(now / 86400000);
    const PRAY_CD_MS = 6 * 3600 * 1000;
    const nextResetUnix = Math.floor(((curUtcDay + 1) * 86400000) / 1000);
    const canClaimDaily = u.last_daily !== curUtcDay;
    const nextPrayMs = Number(u.last_pray || 0) + PRAY_CD_MS;
    const canPray = now >= nextPrayMs;

    const qData = ensureQuestDataInMemory(u);
    const activeQuests = (qData.quests || []).map((q, idx) => {
        const tmpl = QUESTS.find(x => x.id === q.id);
        const goal = getQuestGoal(tmpl);
        return {
            index: idx,
            id: q.id,
            desc: tmpl ? tmpl.desc : q.id,
            progress: q.progress || 0,
            goal,
            claimed: Boolean(q.claimed),
            reward: tmpl ? tmpl.reward : {}
        };
    });

    const bm = getBlackMarketData(userId);

    const titlesList = Object.entries(TITLES).map(([id, t]) => ({
        id,
        name: t.name,
        chance: t.rarity || 0,
        rarity: t.rarity || 0,
        count: titleCounts[id] || 0,
        unlocked: (titleCounts[id] || 0) > 0,
        isEquipped: u.equipped_title === id
    }));

    for (const [cName, cHex] of Object.entries(customTitlesMap)) {
        const cId = `custom_${cName}`;
        titlesList.unshift({
            id: cId,
            name: `${cName} (${cHex})`,
            chance: 0,
            rarity: 0,
            count: 1,
            unlocked: true,
            isEquipped: u.equipped_title === cId,
            isCustom: true
        });
    }

    const counters = {
        crystal_maker_pity: Number(u.crystal_maker_pity || 0),
        crystal_module_pity: Number(u.crystal_module_pity || 0),
        null_counter: Number(u.null_counter || 0)
    };

    return {
        user: {
            id: u.id,
            username: u.username,
            coins: u.coins || '0',
            crystals: u.crystals || '0',
            nulls: u.nulls || '0',
            cc_coins: u.cc_coins || 0,
            quest_tokens: u.quest_tokens || 0,
            permanent_basic_luck: Number(u.permanent_basic_luck || 0),
            pray_count: u.pray_count || 0,
            slots: u.slots || 10,
            total_rolls: u.total_rolls || 0,
            total_score: u.total_score || '0',
            best_roll: u.best_roll || '0',
            highest_pos: u.highest_pos || '0',
            lowest_neg: u.lowest_neg || '0',
            last_roll: Number(u.last_roll || 0),
            equipped_module: u.equipped_module || null,
            equipped_chip: u.equipped_chip || null,
            equipped_title: u.equipped_title || null,
            equipped_achieve: u.equipped_achieve || null,
            auto_sell_threshold: u.auto_sell_threshold || '0',
            auto_sell_threshold_neg: u.auto_sell_threshold_neg || '0',
            luck_toggle: u.luck_toggle !== 0,
            has_auto_chip: u.equipped_chip === 'chip_autoroll' || Boolean(st.auto_potion),
            daily_purchases: JSON.parse(u.daily_purchases || '{}'),
            counters
        },
        counters,
        settings: {
            auto_sell_threshold: u.auto_sell_threshold || '0',
            auto_sell_threshold_neg: u.auto_sell_threshold_neg || '0',
            stat_privacy: u.stat_privacy === 1,
            luck_toggle: u.luck_toggle !== 0,
            bshop_ping: u.bshop_ping !== 0,
            hide_equip: u.hide_equip === 1,
            custom_color: u.is_colorful === 1 ? (u.custom_color || '') : '',
            isColorful: u.is_colorful === 1,
            hasColorAccess: u.is_colorful === 1,
            customTitles: customTitlesMap,
            theme: osPrefs.theme,
            disable_welcome: osPrefs.disable_welcome,
            hide_watermark: osPrefs.hide_watermark
        },
        stats: {
            basic: st.basic,
            multi: st.multi,
            special: st.special,
            final: st.final,
            finalMult: ((1.0 + st.final) * (st.final_multiplier || 1)),
            finalLuck: st.finalLuck,
            finalCd: st.finalCd,
            end: Boolean(st.end)
        },
        activePotions: ap.map(p => ({
            id: p.potion_id,
            name: POTIONS[p.potion_id]?.name || p.potion_id,
            rank: p.rank,
            rolls_left: p.rolls_left,
            effectText: POTIONS[p.potion_id]?.effectText || ''
        })),
        inventory: inv.map(r => ({
            id: r.id,
            roll_value: r.roll_value,
            is_locked: r.is_locked === 1
        })),
        ownedItems: ownedMap,
        ownedPotions,
        ownedHardware,
        unlockedAchievements: unlockedAchIds,
        allAchievements: Object.entries(ACHIEVEMENTS).map(([id, ach]) => {
            const isUnlocked = unlockedAchIds.includes(id);
            const isSecret = Boolean(ach.secret || ach.hidden);
            const hideSecret = isSecret && !isUnlocked && u.equipped_achieve !== id;

            const rewardParts = [];
            if (ach.rewards) {
                if (ach.rewards.coins) rewardParts.push(`+${formatBigInt(ach.rewards.coins)} Coins`);
                if (ach.rewards.crystals) rewardParts.push(`+${formatBigInt(ach.rewards.crystals)} Crystals`);
                if (ach.rewards.nulls) rewardParts.push(`+${formatBigInt(ach.rewards.nulls)} NULL`);
                if (ach.rewards.cc) rewardParts.push(`+${ach.rewards.cc} CC`);
                if (ach.rewards.title) {
                    const tName = TITLES[ach.rewards.title]?.name || ach.rewards.title;
                    rewardParts.push(`[${tName}] Title`);
                }
                if (ach.rewards.items) {
                    for (const [iId, qty] of Object.entries(ach.rewards.items)) {
                        const iName = POTIONS[iId]?.name || MODULES[iId]?.name || CHIPS[iId]?.name || iId;
                        rewardParts.push(`+${qty}x ${iName}`);
                    }
                }
            }
            const rewardStr = rewardParts.length > 0 ? `Reward: ${rewardParts.join(', ')}` : '';

            return {
                id,
                name: ach.name,
                req: ach.req || 'Special Condition',
                rewardText: rewardStr,
                unlocked: isUnlocked,
                isEquipped: u.equipped_achieve === id
            };
        }),
        titles: titlesList,
        missionHub: {
            canClaimDaily,
            nextResetUnix,
            canPray,
            nextPrayUnix: Math.ceil(nextPrayMs / 1000),
            prayCount: u.pray_count || 0,
            permBasicLuck: Number(u.permanent_basic_luck || 0),
            questTokens: u.quest_tokens || 0,
            rerollsLeft: qData.rerolls || 0,
            tokenRerollUsed: Boolean(qData.token_reroll_used),
            quests: activeQuests
        },
        blackMarket: {
            active: Boolean(bm && bm.active),
            expiresAt: bm ? bm.expiresAt : 0,
            items: (bm && bm.active && bm.inventory) ? bm.inventory.items : [],
            ccStock: (bm && bm.active && bm.inventory) ? bm.inventory.ccStock : 0
        },
        expandCost
    };
}

async function executeWebRoll(userId, isAutoRequested = false) {
    await acquireLock(userId);
    try {
        let u = await getUser(userId);
        const now = Date.now();
        const [ap] = await pool.execute('SELECT * FROM active_potions WHERE user_id = ?', [userId]);
        let activePots = ap;

        const [invRows] = await pool.execute('SELECT * FROM inventory WHERE user_id = ?', [userId]);
        let pStats = calcStats(u, activePots, true);

        const cdMs = pStats.finalCd * 1000;
        const nxt = Number(u.last_roll) + cdMs;

        const hasAutoEntitlement = u.equipped_chip === 'chip_autoroll' || Boolean(pStats.auto_potion);
        if (isAutoRequested && !hasAutoEntitlement) {
            return {
                ok: false,
                error: 'PERMISSION_DENIED',
                message: 'Auto-Roll requires Auto-Roll Machine (chip_autoroll) or Automatic Potion!'
            };
        }

        if (now < nxt) {
            return {
                ok: false,
                cooldown: true,
                remainingMs: nxt - now,
                nextRollUnix: Math.ceil(nxt / 1000),
                message: `Cooldown active! Please wait ${((nxt - now) / 1000).toFixed(1)}s`
            };
        }

        u.last_roll = now;
        u.cmd_count_since_roll = 0;
        let tCo = 0n, tCr = 0n, tNu = 0n;
        let logs = [];
        let pendingAchievements = new Set();
        const qData = ensureQuestDataInMemory(u);
        let qUpdated = false;
        let unlockedTitlesArr = [];
        try { unlockedTitlesArr = JSON.parse(u.unlocked_titles || '[]'); } catch (e) { unlockedTitlesArr = []; }
        let titlesDirty = false;
        const canRollTitles = Boolean(pStats.spectrometer || u.equipped_module === 'mod_spectrometer');
        const sortedRollableTitles = canRollTitles
            ? Object.entries(TITLES).filter(([, tData]) => tData.rarity > 0).sort((a, b) => b[1].rarity - a[1].rarity)
            : [];

        let recentRollValues = [];
        try {
            const parsedRecent = JSON.parse(u.recent_rolls || '[]');
            if (Array.isArray(parsedRecent)) {
                recentRollValues = parsedRecent.slice(-100).map(v => BigInt(v));
            }
        } catch (e) {
            recentRollValues = [];
        }

        const count = pStats.magic ? 10 : 1;
        let mainRV = 0n;
        let maxAbsRolled = 0n;
        let minSignedRolled = null;

        for (let i = 0; i < count; i++) {
            let currentLuck = pStats.finalLuck;
            if (i > 0) currentLuck = Math.min(currentLuck, 20000);

            if (i === 0) {
                let cf = 0;
                if (pStats.cmaker_kit) { cf++; tCr += 1n; }
                if (pStats.cmaker) {
                    u.crystal_maker_pity = (u.crystal_maker_pity || 0) + 1;
                    if (Math.random() <= 0.02 || u.crystal_maker_pity >= 75) {
                        cf++;
                        tCr += 1n;
                        u.crystal_maker_pity = 0;
                    }
                }
                if (u.equipped_module === 'mod_crystal') {
                    u.crystal_module_pity = (u.crystal_module_pity || 0) + 1;
                    const rt = u.equipped_chip === 'chip_crystal' ? 0.035 : 0.03;
                    const py = u.equipped_chip === 'chip_crystal' ? 29 : 34;
                    if (Math.random() <= rt || u.crystal_module_pity >= py) {
                        cf++;
                        tCr += 1n;
                        u.crystal_module_pity = 0;
                    }
                }
                if (cf >= 2) pendingAchievements.add('crystal_hunter');
            }

            let rV = generateHighPrecisionRoll(currentLuck);
            if (currentLuck < 0) rV = -rV;
            if (pStats.force_negative && rV > 0n) rV = -rV;
            if (rV < 0n) pendingAchievements.add('inverted_world');

            if (mainRV === 0n) mainRV = rV;
            const absRV = rV < 0n ? -rV : rV;
            recentRollValues.push(absRV);

            if (absRV > maxAbsRolled) maxAbsRolled = absRV;
            if (minSignedRolled === null || rV < minSignedRolled) minSignedRolled = rV;

            if (canRollTitles) {
                let gotTitle = null;
                const titleLuck = pStats.title_luck_multi || 1;
                for (const [tId, tData] of sortedRollableTitles) {
                    if (tData.rarity <= 2) { gotTitle = tId; break; }
                    const tRoll = generateHighPrecisionRoll(titleLuck);
                    if (tRoll >= BigInt(tData.rarity)) { gotTitle = tId; break; }
                }

                if (gotTitle) {
                    u.titles_rolled = (u.titles_rolled || 0) + 1;
                    if (applyQuestProgressInMemory(qData, 'roll_title', 1, gotTitle)) qUpdated = true;

                    unlockedTitlesArr.push(gotTitle);
                    titlesDirty = true;
                    logs.push(`🏷️ Found Title: [${TITLES[gotTitle]?.name || gotTitle}]!`);
                }
            }

            u.null_counter = (parseInt(u.null_counter, 10) || 0) + 1;
            if (u.null_counter >= 19) {
                u.null_counter = 0;
                const nullRate = 0.01404;
                if (rV < 0n && Math.random() < nullRate) {
                    tNu += 1n;
                    logs.push(`⬛ Reality Void crystallized 1 NULL (${(nullRate * 100).toFixed(3)}% chance)!`);
                }
            }

            const lastV = BigInt(u.last_roll_val || '0');
            if (lastV >= 10000n && absRV >= lastV * 10n) pendingAchievements.add('jackpot');

            if (currentLuck >= 10000) {
                if (absRV < BigInt(Math.floor(currentLuck * 1.2))) {
                    u.cook_counter = (parseInt(u.cook_counter, 10) || 0) + 1;
                    if (u.cook_counter >= 2) pendingAchievements.add('cooked');
                } else u.cook_counter = 0;
            } else u.cook_counter = 0;

            if (u.total_rolls >= 1000 && rV === BigInt(u.total_rolls)) pendingAchievements.add('duplicate');

            if (absRV > BigInt(u.best_roll || '0')) u.best_roll = absRV.toString();
            if (rV > 0n && rV > BigInt(u.highest_pos || '0')) u.highest_pos = rV.toString();
            if (rV < 0n && (u.lowest_neg === '0' || !u.lowest_neg || rV < BigInt(u.lowest_neg || '0'))) {
                u.lowest_neg = rV.toString();
            }

            syncPeriodStats(u, now);
            if (rV > 0n && rV > BigInt(u.weekly_pos || '0')) u.weekly_pos = rV.toString();
            if (rV > 0n && rV > BigInt(u.monthly_pos || '0')) u.monthly_pos = rV.toString();
            if (rV < 0n && (u.weekly_neg === '0' || !u.weekly_neg || rV < BigInt(u.weekly_neg || '0'))) {
                u.weekly_neg = rV.toString();
            }
            if (rV < 0n && (u.monthly_neg === '0' || !u.monthly_neg || rV < BigInt(u.monthly_neg || '0'))) {
                u.monthly_neg = rV.toString();
            }

            u.last_roll_val = rV.toString();
            u.last_roll_luck = currentLuck;
        }

        if (recentRollValues.length > 100) {
            recentRollValues = recentRollValues.slice(-100);
        }
        if (recentRollValues.length >= 100) {
            const last100 = recentRollValues.slice(-100);
            let minR = last100[0], maxR = last100[0];
            for (const val of last100) {
                if (val < minR) minR = val;
                if (val > maxR) maxR = val;
            }
            if (minR > 0n && ((maxR - minR) * 100n / minR) <= 25n) {
                pendingAchievements.add('constant_numero');
            }
        }
        u.recent_rolls = JSON.stringify(recentRollValues.map(v => v.toString()));

        if (titlesDirty) {
            u.unlocked_titles = JSON.stringify(unlockedTitlesArr);
        }

        const rV = mainRV;
        const absRV = rV < 0n ? -rV : rV;
        u.last_roll_val = rV.toString();
        u.total_rolls = (parseInt(u.total_rolls, 10) || 0) + count;
        syncPeriodStats(u, now);
        u.weekly_rolls = (parseInt(u.weekly_rolls, 10) || 0) + count;
        u.monthly_rolls = (parseInt(u.monthly_rolls, 10) || 0) + count;

        if (applyQuestProgressInMemory(qData, 'roll', count)) qUpdated = true;
        if (applyQuestProgressInMemory(qData, 'roll_above', 1, Number(maxAbsRolled))) qUpdated = true;
        if (minSignedRolled !== null && applyQuestProgressInMemory(qData, 'roll_below', 1, Number(minSignedRolled))) qUpdated = true;
        if (qUpdated || !u.quest_data || u.quest_data === '{}') {
            u.quest_data = JSON.stringify(qData);
        }

        const thPos = BigInt(u.auto_sell_threshold || '0');
        const thNeg = BigInt(u.auto_sell_threshold_neg || '0');
        let isAutoSold = false;

        if (rV >= 0n && rV <= thPos) isAutoSold = true;
        else if (rV < 0n && absRV <= thNeg) isAutoSold = true;

        if (isAutoSold && absRV >= 1000000n) {
            pendingAchievements.add('foolhardy');
        }

        let actionStatus = '';

        if (isAutoSold) {
            tCo += absRV;
            actionStatus = '🪙 Auto-Sold';
        } else if (invRows.length < (u.slots || 10)) {
            await pool.execute('INSERT INTO inventory (user_id, roll_value, is_locked) VALUES (?, ?, 0)', [userId, rV.toString()]);
            u.total_score = (BigInt(u.total_score || '0') + absRV).toString();
            u.weekly_score = (BigInt(u.weekly_score || '0') + absRV).toString();
            u.monthly_score = (BigInt(u.monthly_score || '0') + absRV).toString();
            actionStatus = '📥 Saved to Inventory';
        } else {
            const unlocked = invRows.filter(x => x.is_locked === 0);
            if (!unlocked.length) {
                tCo += absRV;
                actionStatus = '🪙 Sold (All Slots Locked)';
            } else {
                let minIdx = 0;
                let minVal = BigInt(unlocked[0].roll_value);
                let minRarity = minVal < 0n ? -minVal : minVal;
                for (let i = 1; i < unlocked.length; i++) {
                    const v = BigInt(unlocked[i].roll_value);
                    const vRarity = v < 0n ? -v : v;
                    if (vRarity < minRarity) {
                        minRarity = vRarity;
                        minIdx = i;
                        minVal = v;
                    }
                }

                if (absRV <= minRarity) {
                    tCo += absRV;
                    actionStatus = '🪙 Sold (Lower than inventory)';
                } else {
                    tCo += minRarity;
                    await pool.execute('UPDATE inventory SET roll_value = ? WHERE id = ?', [rV.toString(), unlocked[minIdx].id]);
                    const scoreDiff = absRV - minRarity;
                    u.total_score = (BigInt(u.total_score || '0') + scoreDiff).toString();
                    u.weekly_score = (BigInt(u.weekly_score || '0') + scoreDiff).toString();
                    u.monthly_score = (BigInt(u.monthly_score || '0') + scoreDiff).toString();
                    actionStatus = `♻️ Replaced 1 in ${formatBigInt(minVal)}`;
                }
            }
        }

        for (const p of activePots) {
            if (u.equipped_chip === 'chip_autoroll' && POTIONS[p.potion_id]?.effects?.auto_potion) continue;
            p.rolls_left--;
        }
        const remainingPots = activePots.filter(p => p.rolls_left > 0);
        await pool.execute('DELETE FROM active_potions WHERE user_id = ?', [userId]);
        if (remainingPots.length > 0) {
            const potRows = remainingPots.map(p => [userId, p.potion_id, p.rank, p.rolls_left]);
            await pool.query('INSERT INTO active_potions (user_id, potion_id, `rank`, rolls_left) VALUES ?', [potRows]);
        }

        if (tCr > 0n) {
            if (u.crystals === '0') pendingAchievements.add('miner');
            u.crystals = (BigInt(u.crystals || '0') + tCr).toString();
            if (BigInt(u.crystals) >= 100000n) pendingAchievements.add('geologist');
        }
        if (tNu > 0n) {
            u.nulls = (BigInt(u.nulls || '0') + tNu).toString();
        }
        u.coins = (BigInt(u.coins || '0') + tCo).toString();

        if (u.total_rolls >= 1) pendingAchievements.add('started');
        if (u.total_rolls >= 100) pendingAchievements.add('rolls_100');
        if (u.total_rolls >= 1000) pendingAchievements.add('rolls_1k');
        if (u.total_rolls >= 10000) pendingAchievements.add('rolls_10k');
        if (u.total_rolls >= 50000) pendingAchievements.add('rolls_50k');
        if (u.total_rolls >= 100000) pendingAchievements.add('rolls_100k');
        if (u.total_rolls >= 250000) pendingAchievements.add('rolls_250k');
        if (u.total_rolls >= 500000) pendingAchievements.add('rolls_500k');
        if (u.total_rolls >= 1000000) pendingAchievements.add('rolls_1m');
        if (u.total_rolls >= 5000000) pendingAchievements.add('rolls_5m');
        if (u.total_rolls >= 10000000) pendingAchievements.add('rolls_10m');

        if (maxAbsRolled >= 1000n) pendingAchievements.add('find_1k');
        if (maxAbsRolled >= 10000n) pendingAchievements.add('find_10k');
        if (maxAbsRolled >= 100000n) pendingAchievements.add('find_100k');
        if (maxAbsRolled >= 1000000n) pendingAchievements.add('find_1m');
        if (maxAbsRolled >= 10000000n) pendingAchievements.add('find_10m');
        if (maxAbsRolled >= 100000000n) pendingAchievements.add('find_100m');
        if (maxAbsRolled >= 1000000000n) pendingAchievements.add('find_1b');
        if (maxAbsRolled >= 10000000000n) pendingAchievements.add('find_10b');
        if (maxAbsRolled >= 100000000000n) pendingAchievements.add('find_100b');
        if (maxAbsRolled >= 1000000000000n) pendingAchievements.add('find_1t');
        if (maxAbsRolled >= 10000000000000n) pendingAchievements.add('find_10t');
        if (maxAbsRolled >= 100000000000000n) pendingAchievements.add('find_100t');
        if (maxAbsRolled >= 1000000000000000n) pendingAchievements.add('find_1qa');
        if (maxAbsRolled >= 10000000000000000n) pendingAchievements.add('find_10qa');
        if (maxAbsRolled >= 100000000000000000n) pendingAchievements.add('find_100qa');

        if (maxAbsRolled >= 100000n && pStats.finalLuck === 1) {
            pendingAchievements.add('true_challenged');
        }

        await saveUser(u);

        let unlockedAchievements = [];
        for (const aId of pendingAchievements) {
            const res = await grantAchievement(u, aId);
            if (res) unlockedAchievements.push(res);
        }

        const nextStats = calcStats(u, remainingPots);
        const nextRollUnix = Math.ceil((now + nextStats.finalCd * 1000) / 1000);

        return {
            ok: true,
            roll: rV.toString(),
            formattedRoll: (rV < 0n ? '-' : '') + formatBigInt(absRV),
            isNegative: rV < 0n,
            actionStatus,
            gains: {
                coins: tCo.toString(),
                crystals: tCr.toString(),
                nulls: tNu.toString()
            },
            nextRollUnix,
            cooldownSeconds: nextStats.finalCd,
            unlockedAchievements,
            logs
        };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebLockRoll(userId, rollId) {
    await acquireLock(userId);
    try {
        const [rows] = await pool.execute('SELECT is_locked FROM inventory WHERE id = ? AND user_id = ?', [rollId, userId]);
        if (!rows || rows.length === 0) return { ok: false, message: 'Roll item not found.' };

        const newLock = rows[0].is_locked === 1 ? 0 : 1;
        await pool.execute('UPDATE inventory SET is_locked = ? WHERE id = ? AND user_id = ?', [newLock, rollId, userId]);
        return { ok: true, is_locked: newLock === 1 };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebSellRoll(userId, rollId) {
    await acquireLock(userId);
    try {
        const u = await getUser(userId);
        const [rows] = await pool.execute('SELECT roll_value, is_locked FROM inventory WHERE id = ? AND user_id = ?', [rollId, userId]);
        if (!rows || rows.length === 0) return { ok: false, message: 'Roll item not found.' };
        if (rows[0].is_locked === 1) return { ok: false, message: 'Cannot sell a locked number!' };

        const rVal = BigInt(rows[0].roll_value);
        const rarity = rVal < 0n ? -rVal : rVal;

        await pool.execute('DELETE FROM inventory WHERE id = ? AND user_id = ?', [rollId, userId]);
        u.coins = (BigInt(u.coins || '0') + rarity).toString();
        let newScore = BigInt(u.total_score || '0') - rarity;
        if (newScore < 0n) newScore = 0n;
        u.total_score = newScore.toString();

        await saveUser(u);
        return { ok: true, coinsEarned: rarity.toString(), newCoins: u.coins, achievement: null };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebSellAllUnlocked(userId) {
    await acquireLock(userId);
    try {
        const u = await getUser(userId);
        const [rows] = await pool.execute('SELECT id, roll_value FROM inventory WHERE user_id = ? AND is_locked = 0', [userId]);
        if (!rows || rows.length === 0) return { ok: false, message: 'No unlocked rolls to sell.' };

        let totalRarity = 0n;
        for (const r of rows) {
            const v = BigInt(r.roll_value);
            totalRarity += (v < 0n ? -v : v);
        }

        const idsToDelete = rows.map(r => r.id);
        const placeholders = idsToDelete.map(() => '?').join(',');
        await pool.execute(`DELETE FROM inventory WHERE id IN (${placeholders}) AND user_id = ?`, [...idsToDelete, userId]);
        u.coins = (BigInt(u.coins || '0') + totalRarity).toString();
        let newScore = BigInt(u.total_score || '0') - totalRarity;
        if (newScore < 0n) newScore = 0n;
        u.total_score = newScore.toString();

        await saveUser(u);
        return { ok: true, soldCount: rows.length, totalCoinsEarned: totalRarity.toString(), newCoins: u.coins, achievement: null };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebExpandStorage(userId) {
    await acquireLock(userId);
    try {
        const u = await getUser(userId);
        const currentSlots = u.slots || 10;
        const cost = BigInt(2) ** BigInt(Math.max(0, currentSlots - 10));

        if (BigInt(u.crystals || '0') < cost) {
            return { ok: false, message: `❌ Not enough crystals! Need 💎 ${formatBigInt(cost)} Crystals.` };
        }

        u.crystals = (BigInt(u.crystals || '0') - cost).toString();
        u.slots = currentSlots + 1;

        let achMsg = null;
        if (u.slots >= 17) {
            achMsg = await grantAchievement(u, 'slot_spec');
        }

        await saveUser(u);
        return { ok: true, newSlots: u.slots, remainingCrystals: u.crystals, achievement: achMsg };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebEquip(userId, itemId, type) {
    await acquireLock(userId);
    try {
        const u = await getUser(userId);
        const [items] = await pool.execute('SELECT quantity FROM items WHERE user_id = ? AND item_id = ? AND quantity > 0', [userId, itemId]);
        if (!items || items.length === 0) return { ok: false, message: 'You do not own this item!' };

        if (type === 'module') {
            if (!MODULES[itemId]) {
                return { ok: false, message: 'Invalid equipment: Selected item is not a Module!' };
            }
            if (u.equipped_module === itemId) {
                u.equipped_module = null;
                resetModuleStacks(u);
            } else {
                u.equipped_module = itemId;
                resetModuleStacks(u);
            }
        } else if (type === 'chip') {
            if (!CHIPS[itemId]) {
                return { ok: false, message: 'Invalid equipment: Selected item is not a Chip!' };
            }
            if (u.equipped_chip === itemId) {
                u.equipped_chip = null;
                resetChipStacks(u);
            } else {
                u.equipped_chip = itemId;
                resetChipStacks(u);
            }
        } else {
            return { ok: false, message: 'Invalid equipment slot type!' };
        }
        await saveUser(u);
        return { ok: true, equippedModule: u.equipped_module, equippedChip: u.equipped_chip };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebDaily(userId) {
    await acquireLock(userId);
    try {
        const u = await getUser(userId);
        const now = Date.now();
        const d = Math.floor(now / 86400000);
        const nextResetMs = (d + 1) * 86400000;
        const nextResetUnix = Math.floor(nextResetMs / 1000);

        if (u.last_daily === d) {
            return {
                ok: false,
                nextResetUnix,
                message: `You already claimed your daily reward today! Resets in ${Math.max(1, Math.ceil((nextResetMs - now) / 60000))}m.`
            };
        }

        u.last_daily = d;
        const tr = u.total_rolls || 0;
        const rw = [];
        let gainedCrystals = 0n;

        if (tr < 1000) {
            const c = BigInt(Math.floor(Math.random() * 901) + 100);
            u.coins = (BigInt(u.coins) + c).toString();
            rw.push(`🪙 ${formatBigInt(c)} Coins`);
            await giveItem(u.id, 'pot_luck', 1);
            rw.push(`🧪 1x Luck Potion`);
            if (Math.random() < 0.5) { await giveItem(u.id, 'pot_speed', 1); rw.push(`🧪 1x Speed Potion`); }
            if (Math.random() < 0.04) { gainedCrystals += 1n; rw.push(`💎 1x Crystal`); }
        } else if (tr < 10000) {
            const pct = Math.random() * 0.5 + 0.7;
            const c = BigInt(Math.floor(tr * pct));
            u.coins = (BigInt(u.coins) + c).toString();
            rw.push(`🪙 ${formatBigInt(c)} Coins`);

            const fRoll = Math.random() * 100;
            if (fRoll < 5) { await giveItem(u.id, 'pot_fortune_3', 1); rw.push(`🧪 1x Fortune III`); }
            else if (fRoll < 25) { await giveItem(u.id, 'pot_fortune_2', 1); rw.push(`🧪 1x Fortune II`); }
            else { await giveItem(u.id, 'pot_fortune_1', 1); rw.push(`🧪 1x Fortune I`); }

            const wRoll = Math.random() * 100;
            if (wRoll < 4) { await giveItem(u.id, 'pot_windy_3', 1); rw.push(`🧪 1x Windy III`); }
            else if (wRoll < 20) { await giveItem(u.id, 'pot_windy_2', 1); rw.push(`🧪 1x Windy II`); }
            else { await giveItem(u.id, 'pot_windy_1', 1); rw.push(`🧪 1x Windy I`); }

            const crysChance = 0.04 + (Math.floor(tr / 100) * 0.001);
            if (Math.random() < crysChance) { gainedCrystals += 1n; rw.push(`💎 1x Crystal`); }
        } else if (tr < 100000) {
            const pct = Math.random() * 0.45 + 0.8;
            const c = BigInt(Math.floor(tr * pct));
            u.coins = (BigInt(u.coins) + c).toString();
            rw.push(`🪙 ${formatBigInt(c)} Coins`);

            if (Math.random() < 0.6) { await giveItem(u.id, 'pot_fortune_2', 1); rw.push(`🧪 1x Fortune II`); }
            else { await giveItem(u.id, 'pot_fortune_3', 1); rw.push(`🧪 1x Fortune III`); }

            const wQty = Math.random() < 0.5 ? 2 : 1;
            await giveItem(u.id, 'pot_windy_3', wQty);
            rw.push(`🧪 ${wQty}x Windy III`);

            if (Math.random() < 0.5) { await giveItem(u.id, 'pot_pop', 1); rw.push(`🧪 1x Pop Potion`); }
            if (Math.random() < 0.15) { await giveItem(u.id, 'pot_heavenly', 1); rw.push(`🧪 1x Heavenly Potion`); }

            let crysChance = 0.05 + (Math.floor(tr / 100) * 0.001);
            while (crysChance > 0) {
                if (Math.random() < crysChance) gainedCrystals += 1n;
                crysChance -= 1.0;
            }
            if (gainedCrystals > 0n) rw.push(`💎 ${gainedCrystals}x Crystal`);
        } else if (tr < 1000000) {
            const pct = Math.random() * 0.5 + 0.9;
            const c = BigInt(Math.floor(tr * pct));
            u.coins = (BigInt(u.coins) + c).toString();
            rw.push(`🪙 ${formatBigInt(c)} Coins`);

            const wQty = Math.random() < 0.5 ? 2 : 3;
            await giveItem(u.id, 'pot_windy_3', wQty);
            rw.push(`🧪 ${wQty}x Windy III`);

            await giveItem(u.id, 'pot_pop', 1);
            rw.push(`🧪 1x Pop Potion`);

            if (Math.random() < 0.35) { await giveItem(u.id, 'pot_heavenly', 1); rw.push(`🧪 1x Heavenly Potion`); }
            if (Math.random() < 0.05) { await giveItem(u.id, 'pot_magic', 1); rw.push(`🧪 1x Magic Potion`); }

            let crysChance = 0.06 + (Math.floor(tr / 100) * 0.0025);
            while (crysChance > 0) {
                if (Math.random() < crysChance) gainedCrystals += 1n;
                crysChance -= 1.0;
            }
            if (gainedCrystals > 0n) rw.push(`💎 ${gainedCrystals}x Crystal`);
        } else {
            const pct = Math.random() * 0.6 + 1.0;
            const c = BigInt(Math.floor(tr * pct));
            u.coins = (BigInt(u.coins) + c).toString();
            rw.push(`🪙 ${formatBigInt(c)} Coins`);

            await giveItem(u.id, 'pot_windy_3', 5);
            rw.push(`🧪 5x Windy III`);

            await giveItem(u.id, 'pot_fortune_3', 2);
            rw.push(`🧪 2x Fortune III`);

            await giveItem(u.id, 'pot_heavenly', 1);
            rw.push(`🧪 1x Heavenly Potion`);

            if (Math.random() < 0.15) { await giveItem(u.id, 'pot_magic', 1); rw.push(`🧪 1x Magic Potion`); }
            if (Math.random() < 0.02) { await giveItem(u.id, 'pot_storm', 1); rw.push(`🧪 1x Storm Potion`); }

            let crysChance = 0.08 + (Math.floor(tr / 100) * 0.005);
            while (crysChance > 0) {
                if (Math.random() < crysChance) gainedCrystals += 1n;
                crysChance -= 1.0;
            }
            if (gainedCrystals > 0n) rw.push(`💎 ${gainedCrystals}x Crystal`);
        }

        const achMsgs = [];
        if (gainedCrystals > 0n) {
            if (u.crystals === '0') {
                const a1 = await grantAchievement(u, 'miner');
                if (a1) achMsgs.push(a1);
            }
            u.crystals = (BigInt(u.crystals) + gainedCrystals).toString();
            if (BigInt(u.crystals) >= 100000n) {
                const a2 = await grantAchievement(u, 'geologist');
                if (a2) achMsgs.push(a2);
            }
        }

        await saveUser(u);
        return {
            ok: true,
            rewards: rw,
            nextResetUnix,
            achievements: achMsgs,
            message: `🎁 Daily Claimed! Received: ${rw.join(', ')}`
        };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebPray(userId) {
    await acquireLock(userId);
    try {
        const u = await getUser(userId);
        const now = Date.now();
        const CD = 6 * 3600 * 1000;
        const nextReadyMs = Number(u.last_pray || 0) + CD;

        if (now < nextReadyMs) {
            u.pray_cd_attempts = (parseInt(u.pray_cd_attempts, 10) || 0) + 1;
            await saveUser(u);
            let achMsg = null;
            if (u.pray_cd_attempts >= 10) {
                achMsg = await grantAchievement(u, 'persistent');
            }
            const remMin = Math.max(1, Math.ceil((nextReadyMs - now) / 60000));
            return {
                ok: false,
                cooldown: true,
                nextPrayUnix: Math.ceil(nextReadyMs / 1000),
                achievement: achMsg,
                message: `⏳ You can pray again in ${Math.floor(remMin / 60)}h ${remMin % 60}m (6 hours cooldown).${achMsg ? ' ' + achMsg : ''}`
            };
        }

        const achMsgs = [];
        u.last_pray = now;
        u.pray_count = (parseInt(u.pray_count, 10) || 0) + 1;
        u.permanent_basic_luck = Math.round((parseFloat(u.permanent_basic_luck || 0) + 0.01) * 100) / 100;
        u.pray_cd_attempts = 0;

        if (u.pray_count >= 20) { const a = await grantAchievement(u, 'p2w'); if (a) achMsgs.push(a); }
        if (u.pray_count >= 200) { const a = await grantAchievement(u, 'make_a_wish'); if (a) achMsgs.push(a); }

        const qData = ensureQuestDataInMemory(u);
        if (applyQuestProgressInMemory(qData, 'pray', 1) || !u.quest_data || u.quest_data === '{}') {
            u.quest_data = JSON.stringify(qData);
        }

        await saveUser(u);
        return {
            ok: true,
            permBasicLuck: u.permanent_basic_luck,
            prayCount: u.pray_count,
            nextPrayUnix: Math.ceil((now + CD) / 1000),
            achievements: achMsgs,
            message: `🙏 You prayed and gained +0.01 Permanent Basic Luck! (Total: +${u.permanent_basic_luck.toFixed(2)} | Total Prays: ${u.pray_count})`
        };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebQuestClaim(userId, questIdx) {
    await acquireLock(userId);
    try {
        const resMsg = await claimQuest(userId, Number(questIdx));
        const isErr = typeof resMsg === 'string' && resMsg.startsWith('❌');
        return { ok: !isErr, message: resMsg };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebQuestReroll(userId, questIdx) {
    await acquireLock(userId);
    try {
        const resMsg = await rerollQuest(userId, Number(questIdx));
        const isErr = typeof resMsg === 'string' && resMsg.startsWith('❌');
        return { ok: !isErr, message: resMsg };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebQuestBuy(userId, shopIndex) {
    await acquireLock(userId);
    try {
        const userDb = await getUser(userId);
        const shopIdx = parseInt(shopIndex, 10);
        let cost = 1;
        let reward = null;
        let limitKey = null;
        let limitMax = 0;
        let label = '';

        if (shopIdx === 1) {
            cost = 2; reward = { item: 'pot_crystal_maker', qty: 1 }; limitKey = 'q_cmaker'; limitMax = 2; label = '1x Crystal Maker';
        } else if (shopIdx === 2) {
            cost = 1; reward = { item: 'pot_luck', qty: 5 }; label = '5x Luck Potion';
        } else if (shopIdx === 3) {
            cost = 1; reward = { item: 'pot_speed', qty: 3 }; label = '3x Speed Potion';
        } else if (shopIdx === 4) {
            cost = 1; reward = { coins: 400n }; label = '400 Coins';
        } else if (shopIdx === 5) {
            if ((userDb.total_rolls || 0) <= 10000) return { ok: false, message: '❌ Requires >10,000 total rolls.' };
            cost = 3; reward = { crystals: 1n }; limitKey = 'q_crys'; limitMax = 1; label = '1x Crystal';
        } else if (shopIdx === 6) {
            cost = 2; reward = { item: 'pot_fortune_3', qty: 1 }; limitKey = 'q_f3'; limitMax = 2; label = '1x Fortune III';
        } else if (shopIdx === 7) {
            cost = 2; reward = { item: 'pot_windy_2', qty: 2 }; limitKey = 'q_w2'; limitMax = 2; label = '2x Windy II';
        } else if (shopIdx === 8) {
            if ((userDb.total_rolls || 0) <= 5000) return { ok: false, message: '❌ Requires >5,000 total rolls.' };
            cost = 5; reward = { item: 'pot_pop', qty: 1 }; limitKey = 'q_pop'; limitMax = 1; label = '1x Pop Potion';
        } else if (shopIdx === 9) {
            if ((userDb.total_rolls || 0) <= 25000) return { ok: false, message: '❌ Requires >25,000 total rolls.' };
            const currentWeek = Math.floor(Date.now() / (7 * 86400000));
            if (userDb.quest_cc_week === currentWeek) return { ok: false, message: '❌ Weekly limit reached (1 CC per week).' };
            cost = 15; reward = { cc: 1 }; label = '1x Compressed Crystal (CC)';
        } else {
            return { ok: false, message: '❌ Invalid Token Shop selection.' };
        }

        if ((userDb.quest_tokens || 0) < cost) {
            return { ok: false, message: `❌ Not enough Quest Tokens! Need 🎫 ${cost} Tokens.` };
        }

        const qData = JSON.parse(userDb.quest_data || '{}');
        if (limitKey) {
            if ((qData[limitKey] || 0) >= limitMax) {
                return { ok: false, message: `❌ Daily limit reached (${limitMax}/day).` };
            }
            qData[limitKey] = (qData[limitKey] || 0) + 1;
        }

        userDb.quest_tokens -= cost;
        const achMsgs = [];
        if (reward.coins) userDb.coins = (BigInt(userDb.coins) + reward.coins).toString();
        if (reward.crystals) {
            if (userDb.crystals === '0') {
                const a1 = await grantAchievement(userDb, 'miner');
                if (a1) achMsgs.push(a1);
            }
            userDb.crystals = (BigInt(userDb.crystals) + reward.crystals).toString();
            if (BigInt(userDb.crystals) >= 100000n) {
                const a2 = await grantAchievement(userDb, 'geologist');
                if (a2) achMsgs.push(a2);
            }
        }
        if (reward.cc) {
            userDb.cc_coins = (BigInt(userDb.cc_coins || 0) + BigInt(reward.cc)).toString();
            userDb.quest_cc_week = Math.floor(Date.now() / (7 * 86400000));
        }
        if (reward.item) {
            await giveItem(userDb.id, reward.item, reward.qty);
        }

        userDb.quest_data = JSON.stringify(qData);
        await saveUser(userDb);
        return {
            ok: true,
            message: `✅ Purchased ${label} for 🎫 ${cost} Quest Token(s)!${achMsgs.length ? ' ' + achMsgs.join(' ') : ''}`
        };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebRedeemCode(userId, codeStr) {
    await acquireLock(userId);
    try {
        const cS = String(codeStr || '').trim();
        if (!cS) return { ok: false, message: '❌ Please enter a valid code.' };

        const u = await getUser(userId);

        const [cR] = await pool.execute('SELECT * FROM codes WHERE code = ?', [cS]);
        const c = cR && cR[0];
        if (!c) {
            return { ok: false, message: '❌ Invalid or non-existent code.' };
        }
        if (Number(c.expires_at) > 0 && Date.now() > Number(c.expires_at)) {
            return { ok: false, message: '❌ This code has expired.' };
        }
        if (Number(c.max_uses) > 0 && Number(c.current_uses) >= Number(c.max_uses)) {
            return { ok: false, message: '❌ This code has reached its maximum redemption limit.' };
        }

        const [insRedemp] = await pool.execute('INSERT IGNORE INTO code_redemptions (code, user_id) VALUES (?,?)', [cS, u.id]);
        if (insRedemp && insRedemp.affectedRows === 0) {
            return { ok: false, message: '❌ You have already redeemed this code.' };
        }

        const [updCode] = await pool.execute(
            'UPDATE codes SET current_uses = current_uses + 1 WHERE code = ? AND (max_uses = 0 OR current_uses < max_uses)',
            [cS]
        );
        if (updCode && updCode.affectedRows === 0) {
            await pool.execute('DELETE FROM code_redemptions WHERE code = ? AND user_id = ?', [cS, u.id]);
            return { ok: false, message: '❌ This code has reached its maximum redemption limit.' };
        }

        let rewards = {};
        try { rewards = JSON.parse(c.rewards || c.rewards_json || '{}'); } catch (e) {}

        const gained = [];
        if (rewards.coins && BigInt(rewards.coins) > 0n) {
            u.coins = (BigInt(u.coins) + BigInt(rewards.coins)).toString();
            gained.push(`🪙 ${formatBigInt(rewards.coins)} Coins`);
        }
        if (rewards.crystals && BigInt(rewards.crystals) > 0n) {
            if (u.crystals === '0') {
                const achMin = await grantAchievement(u, 'miner');
                if (achMin) gained.push(achMin);
            }
            u.crystals = (BigInt(u.crystals) + BigInt(rewards.crystals)).toString();
            gained.push(`💎 ${formatBigInt(rewards.crystals)} Crystals`);
            if (BigInt(u.crystals) >= 100000n) {
                const achGeo = await grantAchievement(u, 'geologist');
                if (achGeo) gained.push(achGeo);
            }
        }
        if (rewards.nulls && BigInt(rewards.nulls) > 0n) {
            u.nulls = (BigInt(u.nulls) + BigInt(rewards.nulls)).toString();
            gained.push(`⬛ ${formatBigInt(rewards.nulls)} NULL`);
        }
        if (rewards.cc && BigInt(rewards.cc) > 0n) {
            u.cc_coins = (BigInt(u.cc_coins || 0) + BigInt(rewards.cc)).toString();
            gained.push(`💠 ${rewards.cc} CC`);
        }
        if (rewards.tokens && Number(rewards.tokens) > 0) {
            u.quest_tokens = (parseInt(u.quest_tokens, 10) || 0) + Number(rewards.tokens);
            gained.push(`🎫 ${rewards.tokens} Quest Tokens`);
        }
        if (rewards.items) {
            for (const [id, qty] of Object.entries(rewards.items)) {
                await giveItem(u.id, id, qty);
                const iName = POTIONS[id]?.name || MODULES[id]?.name || CHIPS[id]?.name || id;
                gained.push(`📦 ${qty}x ${iName}`);
            }
        }
        if (Array.isArray(rewards.achievements)) {
            for (const achId of rewards.achievements) {
                const aMsg = await grantAchievement(u, achId);
                if (aMsg) gained.push(aMsg);
            }
        }

        await saveUser(u);
        return {
            ok: true,
            rewards: gained,
            message: `🎉 Redeemed Code [${cS}]! Received: ${gained.join(', ') || 'Nothing'}`
        };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebEquipAchievement(userId, achId) {
    await acquireLock(userId);
    try {
        const u = await getUser(userId);
        if (!achId || achId === 'none' || u.equipped_achieve === achId) {
            u.equipped_achieve = null;
            await saveUser(u);
            return { ok: true, equippedAchieve: null, message: 'Unequipped achievement.' };
        }
        const [rows] = await pool.execute('SELECT * FROM achievements WHERE user_id = ? AND achievement_id = ?', [userId, achId]);
        if (!rows || rows.length === 0) {
            return { ok: false, message: '❌ You have not unlocked this achievement yet!' };
        }
        u.equipped_achieve = achId;
        await saveUser(u);
        return { ok: true, equippedAchieve: achId, message: `✅ Equipped achievement [${ACHIEVEMENTS[achId]?.name || achId}]!` };
    } finally {
        releaseLock(userId);
    }
}

async function executeWebEquipTitle(userId, titleId) {
    await acquireLock(userId);
    try {
        const u = await getUser(userId);
        if (!titleId || titleId === 'none' || u.equipped_title === titleId) {
            u.equipped_title = null;
            await saveUser(u);
            return { ok: true, equippedTitle: null, message: 'Unequipped title.' };
        }
        let isOwned = false;
        let displayName = titleId;
        if (titleId.startsWith('custom_')) {
            const cName = titleId.slice(7);
            let customMap = {};
            try { customMap = JSON.parse(u.custom_titles || '{}'); } catch (e) { customMap = {}; }
            if (customMap[cName]) {
                isOwned = true;
                displayName = `${cName} (${customMap[cName]})`;
            }
        } else {
            let unlocked = [];
            try { unlocked = JSON.parse(u.unlocked_titles || '[]'); } catch (e) { unlocked = []; }
            if (unlocked.includes(titleId)) {
                isOwned = true;
                displayName = TITLES[titleId]?.name || titleId;
            }
        }
        if (!isOwned) {
            return { ok: false, message: '❌ You do not own this title!' };
        }
        u.equipped_title = titleId;
        await saveUser(u);
        return { ok: true, equippedTitle: titleId, message: `✅ Equipped title [${displayName}]!` };
    } finally {
        releaseLock(userId);
    }
}

async function getWebLeaderboard(type = 'rolls', period = 'all', page = 1) {
    const safePage = Math.max(1, Math.min(10, parseInt(page, 10) || 1));
    const offset = (safePage - 1) * 10;
    const { utcWeek, utcMonth } = getCurrentPeriods();
    let rows = [];

    if (period === 'all') {
        if (type === 'rolls') {
            [rows] = await pool.query(`SELECT id, username, stat_privacy, total_rolls as val, equipped_title, equipped_achieve FROM users WHERE is_banned = 0 AND total_rolls > 0 ORDER BY total_rolls DESC LIMIT 11 OFFSET ?`, [offset]);
        } else if (type === 'score') {
            [rows] = await pool.query(`SELECT id, username, stat_privacy, total_score as val, equipped_title, equipped_achieve FROM users WHERE is_banned = 0 AND CAST(total_score AS DECIMAL(65,0)) > 0 ORDER BY CAST(total_score AS DECIMAL(65,0)) DESC LIMIT 11 OFFSET ?`, [offset]);
        } else if (type === 'pos') {
            [rows] = await pool.query(`SELECT id, username, stat_privacy, highest_pos as val, equipped_title, equipped_achieve FROM users WHERE is_banned = 0 AND CAST(highest_pos AS DECIMAL(65,0)) > 0 ORDER BY CAST(highest_pos AS DECIMAL(65,0)) DESC LIMIT 11 OFFSET ?`, [offset]);
        } else if (type === 'neg') {
            [rows] = await pool.query(`SELECT id, username, stat_privacy, lowest_neg as val, equipped_title, equipped_achieve FROM users WHERE is_banned = 0 AND CAST(lowest_neg AS DECIMAL(65,0)) < 0 ORDER BY CAST(lowest_neg AS DECIMAL(65,0)) ASC LIMIT 11 OFFSET ?`, [offset]);
        }
    } else if (period === 'monthly') {
        if (type === 'rolls') {
            [rows] = await pool.query(`SELECT id, username, stat_privacy, monthly_rolls as val, equipped_title, equipped_achieve FROM users WHERE is_banned = 0 AND utc_month = ? AND monthly_rolls > 0 ORDER BY monthly_rolls DESC LIMIT 11 OFFSET ?`, [utcMonth, offset]);
        } else if (type === 'score') {
            [rows] = await pool.query(`SELECT id, username, stat_privacy, monthly_score as val, equipped_title, equipped_achieve FROM users WHERE is_banned = 0 AND utc_month = ? AND CAST(monthly_score AS DECIMAL(65,0)) > 0 ORDER BY CAST(monthly_score AS DECIMAL(65,0)) DESC LIMIT 11 OFFSET ?`, [utcMonth, offset]);
        } else if (type === 'pos') {
            [rows] = await pool.query(`SELECT id, username, stat_privacy, monthly_pos as val, equipped_title, equipped_achieve FROM users WHERE is_banned = 0 AND utc_month = ? AND CAST(monthly_pos AS DECIMAL(65,0)) > 0 ORDER BY CAST(monthly_pos AS DECIMAL(65,0)) DESC LIMIT 11 OFFSET ?`, [utcMonth, offset]);
        } else if (type === 'neg') {
            [rows] = await pool.query(`SELECT id, username, stat_privacy, monthly_neg as val, equipped_title, equipped_achieve FROM users WHERE is_banned = 0 AND utc_month = ? AND CAST(monthly_neg AS DECIMAL(65,0)) < 0 ORDER BY CAST(monthly_neg AS DECIMAL(65,0)) ASC LIMIT 11 OFFSET ?`, [utcMonth, offset]);
        }
    } else if (period === 'weekly') {
        if (type === 'rolls') {
            [rows] = await pool.query(`SELECT id, username, stat_privacy, weekly_rolls as val, equipped_title, equipped_achieve FROM users WHERE is_banned = 0 AND utc_week = ? AND weekly_rolls > 0 ORDER BY weekly_rolls DESC LIMIT 11 OFFSET ?`, [utcWeek, offset]);
        } else if (type === 'score') {
            [rows] = await pool.query(`SELECT id, username, stat_privacy, weekly_score as val, equipped_title, equipped_achieve FROM users WHERE is_banned = 0 AND utc_week = ? AND CAST(weekly_score AS DECIMAL(65,0)) > 0 ORDER BY CAST(weekly_score AS DECIMAL(65,0)) DESC LIMIT 11 OFFSET ?`, [utcWeek, offset]);
        } else if (type === 'pos') {
            [rows] = await pool.query(`SELECT id, username, stat_privacy, weekly_pos as val, equipped_title, equipped_achieve FROM users WHERE is_banned = 0 AND utc_week = ? AND CAST(weekly_pos AS DECIMAL(65,0)) > 0 ORDER BY CAST(weekly_pos AS DECIMAL(65,0)) DESC LIMIT 11 OFFSET ?`, [utcWeek, offset]);
        } else if (type === 'neg') {
            [rows] = await pool.query(`SELECT id, username, stat_privacy, weekly_neg as val, equipped_title, equipped_achieve FROM users WHERE is_banned = 0 AND utc_week = ? AND CAST(weekly_neg AS DECIMAL(65,0)) < 0 ORDER BY CAST(weekly_neg AS DECIMAL(65,0)) ASC LIMIT 11 OFFSET ?`, [utcWeek, offset]);
        }
    }

    const hasMore = (rows || []).length > 10 && safePage < 10;
    const pageRows = (rows || []).slice(0, 10);

    const entries = pageRows.map((r, idx) => {
        const isAnon = r.stat_privacy === 1;
        const displayName = isAnon ? `Player_${String(r.id).slice(0, 4)}` : (r.username || `Player_${String(r.id).slice(0, 4)}`);
        const titleName = (!isAnon && r.equipped_title && TITLES[r.equipped_title]) ? TITLES[r.equipped_title].name : null;
        const achName = (!isAnon && r.equipped_achieve && ACHIEVEMENTS[r.equipped_achieve]) ? ACHIEVEMENTS[r.equipped_achieve].name : null;

        let formattedVal = '0';
        try {
            const bi = BigInt(r.val || '0');
            if (type === 'pos' || type === 'neg') {
                const absBi = bi < 0n ? -bi : bi;
                formattedVal = `1 in ${bi < 0n ? '-' : ''}${absBi.toLocaleString('en-US')}`;
            } else {
                formattedVal = bi.toLocaleString('en-US');
            }
        } catch (e) {
            formattedVal = String(r.val || 0);
        }

        return {
            rank: offset + idx + 1,
            displayName,
            titleName,
            achName,
            value: String(r.val || '0'),
            formattedVal
        };
    });

    const nextRefreshUnix = Math.ceil((Math.floor(Date.now() / 300000) + 1) * 300);
    return { ok: true, type, period, page: safePage, hasMore, nextRefreshUnix, entries };
}

async function getPublicPlayerStat(queryStr, requesterId) {
    const q = String(queryStr || '').trim();
    if (!q) return { ok: false, message: 'Please enter a username or User ID.' };

    let rows = [];
    if (/^\d{15,22}$/.test(q)) {
        [rows] = await pool.execute('SELECT * FROM users WHERE id = ? LIMIT 1', [q]);
    }
    if (!rows || rows.length === 0) {
        [rows] = await pool.execute('SELECT * FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [q]);
    }
    if (!rows || rows.length === 0) {
        [rows] = await pool.execute('SELECT * FROM users WHERE LOWER(username) LIKE LOWER(?) LIMIT 1', [`%${q}%`]);
    }
    if (!rows || rows.length === 0) {
        return { ok: false, message: `Player "${q}" not found.` };
    }

    const u = rows[0];
    if (u.stat_privacy === 1 && u.id !== requesterId) {
        if (requesterId) {
            await acquireLock(requesterId);
            try {
                const reqUser = await getUser(requesterId);
                reqUser.stalker_counter = (parseInt(reqUser.stalker_counter, 10) || 0) + 1;
                if (reqUser.stalker_counter >= 10) {
                    await grantAchievement(reqUser, 'stalker');
                }
                await saveUser(reqUser);
            } finally {
                releaseLock(requesterId);
            }
        }
        return { ok: false, message: '🔒 This player has set their profile to Private.' };
    } else if (requesterId && u.id !== requesterId) {
        await acquireLock(requesterId);
        try {
            const reqUser = await getUser(requesterId);
            reqUser.stalker_counter = 0;
            await saveUser(reqUser);
        } finally {
            releaseLock(requesterId);
        }
    }

    return {
        ok: true,
        profile: {
            id: u.id,
            username: u.username,
            total_rolls: u.total_rolls || 0,
            total_score: u.total_score || '0',
            highest_pos: u.highest_pos || '0',
            lowest_neg: u.lowest_neg || '0',
            equipped_module: u.hide_equip === 1 && u.id !== requesterId ? 'Hidden' : (MODULES[u.equipped_module]?.name || 'None'),
            equipped_chip: u.hide_equip === 1 && u.id !== requesterId ? 'Hidden' : (CHIPS[u.equipped_chip]?.name || 'None'),
            equipped_title: TITLES[u.equipped_title]?.name || (u.equipped_title?.startsWith('custom_') ? u.equipped_title.slice(7) : 'None'),
            equipped_achieve: ACHIEVEMENTS[u.equipped_achieve]?.name || 'None'
        }
    };
}

async function getWebDevOverview() {
    const [users, [codes], [redemptions]] = await Promise.all([
        getUsersList(),
        pool.execute('SELECT * FROM codes'),
        pool.execute('SELECT cr.code, cr.user_id, u.username FROM code_redemptions cr LEFT JOIN users u ON cr.user_id = u.id')
    ]);

    const redempMap = {};
    for (const r of redemptions) {
        if (!redempMap[r.code]) redempMap[r.code] = [];
        redempMap[r.code].push(`${r.username || 'Unknown'} (${r.user_id})`);
    }

    const bm = getBlackMarketData();

    const mainClient = getMainClient();
    const serverMap = new Map();
    if (mainClient && mainClient.guilds && mainClient.guilds.cache) {
        for (const [gId, g] of mainClient.guilds.cache.entries()) {
            serverMap.set(gId, {
                guildId: gId,
                id: gId,
                ownerId: g.ownerId || null,
                name: g.name,
                memberCount: g.memberCount || 0,
                botType: 'Main Bot'
            });
        }
    }

    return {
        ok: true,
        users,
        codes: (codes || []).map(c => ({
            code: c.code,
            maxUses: c.max_uses,
            max_uses: c.max_uses,
            currentUses: c.current_uses,
            current_uses: c.current_uses,
            expiresAt: Number(c.expires_at || 0),
            rewards: JSON.parse(c.rewards || '{}'),
            redeemedBy: redempMap[c.code] || []
        })),
        blackMarket: {
            active: Boolean(bm && bm.active),
            expiresAt: bm ? bm.expiresAt : 0
        },
        allServers: Array.from(serverMap.values()),
        catalogIds: {
            potions: Object.entries(POTIONS).map(([id, v]) => ({ id, name: v.name })),
            modules: Object.entries(MODULES).map(([id, v]) => ({ id, name: v.name })),
            chips: Object.entries(CHIPS).map(([id, v]) => ({ id, name: v.name })),
            achievements: Object.entries(ACHIEVEMENTS).map(([id, v]) => ({ id, name: v.name })),
            titles: Object.entries(TITLES).map(([id, v]) => ({ id, name: v.name }))
        }
    };
}

async function executeWebDevControl(body) {
    const act = String(body.action || body.subType || '').toLowerCase().trim();

    if (act === 'currency' || act === 'luck') {
        const targetId = String(body.targetId || body.target || '').trim();
        if (!targetId) return { ok: false, message: '❌ Missing targetId.' };
        await acquireLock(targetId);
        try {
            const u = await getUser(targetId);
            const field = String(body.field || 'coins').toLowerCase();
            const op = String(body.op || 'add').toLowerCase();
            const rawAmt = String(body.amount || body.value || '0').trim();

            const bigMap = { coins: 'coins', crystals: 'crystals', nulls: 'nulls', cc: 'cc_coins' };
            const floatMap = {
                perm_basic: 'permanent_basic_luck',
                perm_multi: 'permanent_multi_luck',
                perm_special: 'permanent_special_luck',
                perm_final: 'permanent_final_luck'
            };

            const cleanAmt = rawAmt.replace(/[^0-9-]/g, '') || '0';

            if (bigMap[field]) {
                const col = bigMap[field];
                const cur = BigInt(u[col] || '0');
                const delta = BigInt(cleanAmt);
                let nextVal = cur;
                if (op === 'add') nextVal = cur + delta;
                else if (op === 'remove') nextVal = cur - delta < 0n ? 0n : cur - delta;
                else if (op === 'set') nextVal = delta < 0n ? 0n : delta;
                
                const MAX_BIGINT = 9007199254740991n;
                if (nextVal > MAX_BIGINT) nextVal = MAX_BIGINT;
                if (nextVal < 0n) nextVal = 0n;

                u[col] = nextVal.toString();
                await saveUser(u);
                return { ok: true, message: `✅ Updated ${field} (${op} ${rawAmt}) for ${u.username || targetId} -> ${u[col]}.` };
            } else if (floatMap[field]) {
                const col = floatMap[field];
                const cur = parseFloat(u[col] || 0);
                const delta = parseFloat(rawAmt) || 0;
                let nextVal = cur;
                if (op === 'add') nextVal = cur + delta;
                else if (op === 'remove') nextVal = cur - delta;
                else if (op === 'set') nextVal = delta;
                u[col] = Math.round(nextVal * 1000) / 1000;
                await saveUser(u);
                return { ok: true, message: `✅ Updated ${field} (${op} ${delta}) for ${u.username || targetId} -> ${u[col]}.` };
            }
            return { ok: false, message: `❌ Unknown field "${field}".` };
        } finally {
            releaseLock(targetId);
        }
    }

    if (act === 'give_item' || act === 'give_title' || act === 'give_achieve' || act === 'give_effect' || act === 'reset_player') {
        const targetId = String(body.targetId || body.target || '').trim();
        if (!targetId) return { ok: false, message: '❌ Missing targetId.' };
        await acquireLock(targetId);
        try {
            const u = await getUser(targetId);
            if (act === 'give_item') {
                const itemId = String(body.itemId || body.value || '').trim();
                const qty = Math.max(1, parseInt(body.qty, 10) || 1);
                if (!POTIONS[itemId] && !MODULES[itemId] && !CHIPS[itemId]) {
                    return { ok: false, message: `❌ Item ID "${itemId}" not found in catalog.` };
                }
                await giveItem(targetId, itemId, qty);
                return { ok: true, message: `✅ Granted ${qty}x ${itemId} to ${u.username || targetId}.` };
            }
            if (act === 'give_title') {
                const titleId = String(body.titleId || body.itemId || body.value || '').trim();
                if (!TITLES[titleId]) return { ok: false, message: `❌ Title "${titleId}" not found.` };
                let arr = [];
                try { arr = JSON.parse(u.unlocked_titles || '[]'); } catch (e) { arr = []; }
                if (!arr.includes(titleId)) arr.push(titleId);
                u.unlocked_titles = JSON.stringify(arr);
                await saveUser(u);
                return { ok: true, message: `✅ Granted Title [${TITLES[titleId].name}] to ${u.username || targetId}.` };
            }
            if (act === 'give_achieve') {
                const achId = String(body.achId || body.itemId || body.value || '').trim();
                if (!ACHIEVEMENTS[achId]) return { ok: false, message: `❌ Achievement "${achId}" not found.` };
                await grantAchievement(u, achId);
                await saveUser(u);
                return { ok: true, message: `✅ Unlocked Achievement [${ACHIEVEMENTS[achId].name}] for ${u.username || targetId}.` };
            }
            if (act === 'give_effect') {
                const potId = String(body.itemId || body.value || '').trim();
                const rolls = Math.max(1, parseInt(body.rolls || body.qty, 10) || 10);
                const pDef = POTIONS[potId];
                if (!pDef) return { ok: false, message: `❌ Potion "${potId}" not found.` };
                await pool.execute(
                    'INSERT INTO active_potions (user_id, potion_id, `rank`, rolls_left) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE rolls_left = rolls_left + VALUES(rolls_left)',
                    [targetId, potId, String(pDef.rank), rolls]
                );
                return { ok: true, message: `✅ Applied active effect ${pDef.name} (${rolls} rolls) to ${u.username || targetId}.` };
            }
            if (act === 'reset_player') {
                await pool.execute('DELETE FROM inventory WHERE user_id = ?', [targetId]);
                await pool.execute('DELETE FROM items WHERE user_id = ?', [targetId]);
                await pool.execute('DELETE FROM active_potions WHERE user_id = ?', [targetId]);
                u.coins = '0';
                u.crystals = '0';
                u.nulls = '0';
                u.cc_coins = 0;
                u.total_rolls = 0;
                u.total_score = '0';
                u.highest_pos = '0';
                u.lowest_neg = '0';
                u.permanent_basic_luck = 0;
                u.permanent_multi_luck = 0;
                u.permanent_special_luck = 0;
                u.permanent_final_luck = 0;
                u.crystal_maker_pity = 0;
                u.crystal_module_pity = 0;
                u.null_counter = 0;
                u.equipped_module = null;
                u.equipped_chip = null;
                u.equipped_title = null;
                u.equipped_achieve = null;
                await saveUser(u);
                return { ok: true, message: `✅ Reset player ${u.username || targetId}.` };
            }
        } finally {
            releaseLock(targetId);
        }
    }

    if (act === 'toggle_bshop') {
        const targetId = String(body.targetId || body.target || '').trim();
        if (!targetId) return { ok: false, message: '❌ Missing targetId.' };
        if (getBlackMarketData(targetId).active) {
            closeBlackMarket(targetId);
            return { ok: true, message: `🔴 Black Market closed (personal + global) for ${targetId}.` };
        }
        const msg = await executeVerifiedControl({ action: 'forcebshop', targetId });
        return { ok: !String(msg || '').startsWith('❌'), message: (msg || '✅ Black Market spawned.').replace(/\*\*/g, '') };
    }

    if (act === 'refresh_lb' || act === 'resetlb') {
        await updateLeaderboard(true);
        return { ok: true, message: '✅ Leaderboard cache forcefully refreshed!' };
    }

    if (act === 'create_code' || act === 'ccode_create') {
        let codeName = String(body.codeName || body.code || '').trim();
        if (!codeName) {
            codeName = `ARIS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        }
        const maxUses = Math.max(0, parseInt(body.maxUses, 10) || 0);
        const expireSecs = Math.max(0, parseInt(body.expireSecs, 10) || 0);
        const exp = expireSecs === 0 ? 0 : Date.now() + (expireSecs * 1000);

        const rewards = {
            coins: String(body.coins || '0').replace(/[^0-9]/g, '') || '0',
            crystals: String(body.crystals || '0').replace(/[^0-9]/g, '') || '0',
            nulls: String(body.nulls || '0').replace(/[^0-9]/g, '') || '0',
            cc: parseInt(body.cc, 10) || 0,
            tokens: parseInt(body.tokens, 10) || 0,
            items: {},
            achievements: []
        };

        if (body.rewardsText) {
            String(body.rewardsText).split(',').forEach(part => {
                const [rawK, rawV] = part.trim().split(':');
                if (!rawK || !rawV) return;
                const k = rawK.trim().toLowerCase();
                const v = rawV.trim();
                if (k === 'coin' || k === 'coins') rewards.coins = v.replace(/[^0-9]/g, '') || '0';
                else if (k === 'crystal' || k === 'crystals') rewards.crystals = v.replace(/[^0-9]/g, '') || '0';
                else if (k === 'null' || k === 'nulls') rewards.nulls = v.replace(/[^0-9]/g, '') || '0';
                else if (k === 'cc') rewards.cc = parseInt(v, 10) || 0;
                else if (k === 'token' || k === 'tokens') rewards.tokens = parseInt(v, 10) || 0;
                else rewards.items[rawK.trim()] = Math.max(1, parseInt(v, 10) || 1);
            });
        }
        if (body.itemsStr) {
            String(body.itemsStr).split(',').forEach(pair => {
                const [id, q] = pair.trim().split(':');
                if (id) rewards.items[id.trim()] = Math.max(1, parseInt(q, 10) || 1);
            });
        }
        if (body.achieveId) {
            rewards.achievements.push(String(body.achieveId).trim());
        }

        await pool.execute(
            'REPLACE INTO codes (code, max_uses, current_uses, rewards, expires_at) VALUES (?, ?, 0, ?, ?)',
            [codeName, maxUses, JSON.stringify(rewards), exp]
        );
        return { ok: true, message: `✅ Created Promo Code [${codeName}] (Max Uses: ${maxUses || '∞'})!` };
    }

    if (act === 'delete_code' || act === 'ccode_delete') {
        const code = String(body.codeName || body.code || '').trim();
        if (!code) return { ok: false, message: '❌ Missing code name.' };
        await pool.execute('DELETE FROM codes WHERE code = ?', [code]);
        await pool.execute('DELETE FROM code_redemptions WHERE code = ?', [code]);
        return { ok: true, message: `✅ Deleted Promo Code [${code}].` };
    }

    const targetQuery = String(body.target || body.targetId || '').trim();
    const action = String(body.action || '').toLowerCase().trim();
    const value = body.value !== undefined ? String(body.value).trim() : '';
    const qty = body.qty !== undefined ? String(body.qty).trim() : '';

    if (!targetQuery || !action) {
        return { ok: false, message: '❌ Please specify a target player and action.' };
    }

    const targetInfo = await resolveTargetUser(null, targetQuery);
    if (!targetInfo) {
        return { ok: false, message: `❌ Target player "${targetQuery}" not found.` };
    }

    const msg = await executeVerifiedControl({
        action,
        targetId: targetInfo.id,
        value,
        qty,
        extraArgs: body.extraArgs || []
    });
    const isErr = typeof msg === 'string' && msg.startsWith('❌');
    return { ok: !isErr, message: (msg || '').replace(/\*\*/g, '') };
}

async function updateUserSettings(userId, newSettings) {
    await acquireLock(userId);
    try {
        const u = await getUser(userId);
        if (newSettings.auto_sell_threshold !== undefined) {
            u.auto_sell_threshold = String(newSettings.auto_sell_threshold).replace(/[^0-9]/g, '') || '0';
        }
        if (newSettings.auto_sell_threshold_neg !== undefined) {
            u.auto_sell_threshold_neg = String(newSettings.auto_sell_threshold_neg).replace(/[^0-9]/g, '') || '0';
        }
        if (newSettings.stat_privacy !== undefined) {
            u.stat_privacy = newSettings.stat_privacy ? 1 : 0;
        }
        if (newSettings.luck_toggle !== undefined) {
            u.luck_toggle = newSettings.luck_toggle ? 1 : 0;
        }
        if (newSettings.bshop_ping !== undefined) {
            u.bshop_ping = newSettings.bshop_ping ? 1 : 0;
        }
        if (newSettings.hide_equip !== undefined) {
            u.hide_equip = newSettings.hide_equip ? 1 : 0;
        }
        if (newSettings.custom_color !== undefined) {
            const hex = String(newSettings.custom_color).trim();
            const hasColorAccess = u.is_colorful === 1;
            if (!hex) {
                u.custom_color = '';
            } else if (hasColorAccess && /^#[0-9A-Fa-f]{6}$/.test(hex)) {
                u.custom_color = hex;
            }
        }

        let rawAdObj = {};
        try {
            if (u.ad_data) rawAdObj = JSON.parse(u.ad_data);
        } catch (e) { rawAdObj = {}; }

        if (newSettings.theme !== undefined) {
            rawAdObj.theme = newSettings.theme === 'light' ? 'light' : 'dark';
        }
        if (newSettings.disable_welcome !== undefined) {
            rawAdObj.disable_welcome = Boolean(newSettings.disable_welcome);
        }
        if (newSettings.hide_watermark !== undefined) {
            rawAdObj.hide_watermark = Boolean(newSettings.hide_watermark);
        }
        u.ad_data = JSON.stringify(rawAdObj);

        await saveUser(u);
        return { ok: true, message: 'Settings saved successfully!' };
    } finally {
        releaseLock(userId);
    }
}

module.exports = {
    getUsersList,
    getPlayerData,
    executeWebRoll,
    executeWebLockRoll,
    executeWebSellRoll,
    executeWebSellAllUnlocked,
    executeWebExpandStorage,
    executeWebEquip,
    executeWebDaily,
    executeWebPray,
    executeWebQuestClaim,
    executeWebQuestReroll,
    executeWebQuestBuy,
    executeWebRedeemCode,
    executeWebEquipAchievement,
    executeWebEquipTitle,
    getWebLeaderboard,
    getPublicPlayerStat,
    getWebDevOverview,
    executeWebDevControl,
    updateUserSettings,
    doPurchase,
    doUse
};

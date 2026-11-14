const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { pool, saveUser, getUser } = require('../database/userModel');
const { calcStats, generateHighPrecisionRoll, formatBigIntSafe } = require('../utils/math');
const { FrameManager, autoDelete, sendCooldownMsg } = require('../utils/discord');
const { grantAchievement } = require('./achievementSystem');
const { ensureQuestDataInMemory, applyQuestProgressInMemory } = require('./questSystem');
const TITLES = require('../data/titles');
const { POTIONS } = require('../data/items');

const SORTED_ROLLABLE_TITLES = Object.entries(TITLES)
    .filter(([, tData]) => tData.rarity > 0)
    .sort((a, b) => b[1].rarity - a[1].rarity);

const activeRolls = new Set(); 

function formatBigInt(bi) { return formatBigIntSafe(bi); }

async function executeRoll(ctx, userDb = null) {
    const isBtn = typeof ctx.isButton === 'function' && ctx.isButton(); 
    const uId = ctx.user ? ctx.user.id : ctx.author.id;
    const username = ctx.user ? ctx.user.username : ctx.author.username;
    const rollLockKey = String(uId);
    
    if (activeRolls.has(rollLockKey)) {
        const msg = "⏳ Rolling in progress...";
        if (isBtn) {
            if (ctx.deferred || ctx.replied) ctx.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(()=>{});
            else ctx.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(()=>{});
        } else {
            ctx.channel.send(msg).then(m => autoDelete(m, 3000)).catch(()=>{});
        }
        return;
    }
    activeRolls.add(rollLockKey);

    try {
        if (isBtn && !ctx.deferred && !ctx.replied) await ctx.deferUpdate().catch(()=>{});
        let u = (userDb && userDb._dbSnapshot) ? userDb : await getUser(uId, username); 
        const now = Date.now();
        
        const [ap] = await pool.execute('SELECT * FROM active_potions WHERE user_id=?', [uId]);
        let activePots = ap; 
        const initialPotCount = activePots.length;
        const hadActivePots = initialPotCount > 0;
        let pStats = calcStats(u, activePots);
        
        let rolls = 1; 
        let cdMs = pStats.finalCd * 1000; 
        let nxt = Number(u.last_roll) + cdMs;

        let isAuto = false;
        let maxAutoRolls = 1;

        if (u.equipped_chip === 'chip_autoroll') {
            isAuto = true;
            maxAutoRolls = 1337;
        } else if (pStats.auto_potion) {
            isAuto = true;
            maxAutoRolls = 10000;
        }

        if (isAuto) {
            const el = now - Number(u.last_roll); 
            rolls = Math.floor(el / cdMs); 
            if (rolls > maxAutoRolls) rolls = maxAutoRolls; 
            
            if (pStats.auto_potion && u.equipped_chip !== 'chip_autoroll') {
                let autoPot = activePots.find(p => POTIONS[p.potion_id] && POTIONS[p.potion_id].effects.auto_potion);
                if (autoPot && rolls > autoPot.rolls_left) rolls = autoPot.rolls_left;
            }

            if (rolls < 1) {
                await sendCooldownMsg(ctx, nxt, "Auto-Roll generating... Next batch ready");
                return;
            }
            u.last_roll = now - (el % cdMs);
        } else {
            if (now < nxt) {
                await sendCooldownMsg(ctx, nxt, "Cooldown! Next roll ready");
                return;
            }
            u.last_roll = now;
        }

        let tCo = 0n, tCr = 0n, tNu = 0n; 
        let logs = [];
        let pendingAchievements = new Set();
        
        const [iRows] = await pool.execute('SELECT * FROM inventory WHERE user_id=?', [uId]); 
        let inv = iRows;
        let invChanged = false;

        let unlockedTitlesArr = [];
        try { unlockedTitlesArr = JSON.parse(u.unlocked_titles || '[]'); } catch (e) { unlockedTitlesArr = []; }
        let titlesChanged = false;

        let th = BigInt(u.auto_sell_threshold || '0');
        let th_neg = BigInt(u.auto_sell_threshold_neg || '0');

        let qData = ensureQuestDataInMemory(u);

        let recentRollValues = [];
        try {
            const parsedRecent = JSON.parse(u.recent_rolls || '[]');
            if (Array.isArray(parsedRecent)) {
                recentRollValues = parsedRecent.slice(-100).map(v => BigInt(v));
            }
        } catch (e) {
            recentRollValues = [];
        }

        let precomputedPots = null;
        if (rolls > 1 && activePots.length > 0) {
            let pb = 0, pm = 0, pcd = 0, ps = 0, pf = 0;
            let pflags = {};
            for (let p of activePots) {
                let pot = POTIONS[p.potion_id];
                if (!pot || (p.rolls_left !== undefined && p.rolls_left <= 0)) continue;
                if (pot.effects.basic) pb += pot.effects.basic;
                if (pot.effects.multi) pm += pot.effects.multi;
                if (pot.effects.cd) pcd += pot.effects.cd;
                if (pot.effects.special) ps += pot.effects.special;
                if (pot.effects.final) pf += pot.effects.final;
                if (pot.effects.magic) pflags.magic = true;
                if (pot.effects.cmaker) pflags.cmaker = true;
                if (pot.effects.storm) pflags.storm = true;
                if (pot.effects.cmaker_kit) pflags.cmaker_kit = true;
                if (pot.effects.reality) pflags.reality = true;
                if (pot.effects.auto_potion) pflags.auto_potion = true;
            }
            precomputedPots = { isPrecomputed: true, b: pb, m: pm, cd: pcd, s: ps, f: pf, flags: pflags };
        }

        const potsForStats = precomputedPots || activePots;

        for (let r = 0; r < rolls; r++) {
            let st = calcStats(u, potsForStats, true);

            let ga = st.magic ? 10 : 1; 
            
            for (let g = 0; g < ga; g++) {
                let cf = 0;
                if (g === 0) {
                    if (st.cmaker_kit) { cf++; tCr++; }
                    if (st.cmaker) { 
                        u.crystal_maker_pity = (u.crystal_maker_pity || 0) + 1; 
                        if (Math.random() <= 0.02 || u.crystal_maker_pity >= 75) { cf++; tCr++; u.crystal_maker_pity = 0; } 
                    }
                }
                if (u.equipped_module === 'mod_crystal') { 
                    u.crystal_module_pity = (u.crystal_module_pity || 0) + 1; 
                    let rt = u.equipped_chip === 'chip_crystal' ? 0.035 : 0.03; 
                    let py = u.equipped_chip === 'chip_crystal' ? 29 : 34; 
                    if (Math.random() <= rt || u.crystal_module_pity >= py) { cf++; tCr++; u.crystal_module_pity = 0; } 
                }
                if (cf >= 2) pendingAchievements.add('crystal_hunter');

                let currentLuck = st.finalLuck;
                if (st.magic && currentLuck > 20000 && g > 0) currentLuck = 20000; 

                let rV = generateHighPrecisionRoll(currentLuck);
                if (currentLuck < 0) rV = -rV; 
                if (st.force_negative && rV > 0n) rV = -rV; 
                if (rV < 0n) pendingAchievements.add('inverted_world');

                let absRV = rV < 0n ? -rV : rV; 
                if (recentRollValues.length >= 100) recentRollValues.shift();
                recentRollValues.push(absRV);

                applyQuestProgressInMemory(qData, 'roll', 1);
                if (rV > 0n) applyQuestProgressInMemory(qData, 'roll_above', 1, Number(absRV > 2000000000n ? 2000000000n : absRV));
                if (rV < 0n) applyQuestProgressInMemory(qData, 'roll_below', 1, Number(rV < -2000000000n ? -2000000000n : rV));

                u.null_counter = (parseInt(u.null_counter, 10) || 0) + 1;
                if (u.null_counter >= 19) {
                    u.null_counter = 0;
                    const nullRate = 0.01404;
                    if (rV < 0n && Math.random() < nullRate) {
                        tNu += 1n;
                        logs.push(`⬛ **Reality Void** crystallized **1 NULL** (${(nullRate * 100).toFixed(3)}% chance)!`);
                    }
                }
                
                if (absRV > BigInt(u.best_roll || '0')) u.best_roll = absRV.toString();
                if (rV > 0n && rV > BigInt(u.highest_pos || '0')) u.highest_pos = rV.toString();
                if (rV < 0n && (u.lowest_neg === '0' || !u.lowest_neg || rV < BigInt(u.lowest_neg || '0'))) u.lowest_neg = rV.toString();

                if (rV > 0n && rV > BigInt(u.weekly_pos || '0')) u.weekly_pos = rV.toString();
                if (rV > 0n && rV > BigInt(u.monthly_pos || '0')) u.monthly_pos = rV.toString();
                if (rV < 0n && (u.weekly_neg === '0' || !u.weekly_neg || rV < BigInt(u.weekly_neg || '0'))) u.weekly_neg = rV.toString();
                if (rV < 0n && (u.monthly_neg === '0' || !u.monthly_neg || rV < BigInt(u.monthly_neg || '0'))) u.monthly_neg = rV.toString();
            
                if (st.spectrometer || u.equipped_module === 'mod_spectrometer') {
                    let gotTitle = null;
                    let titleLuck = st.title_luck_multi || 1;
                    for (const [tId, tData] of SORTED_ROLLABLE_TITLES) {
                        if (tData.rarity <= 2) { gotTitle = tId; break; }
                        let tRoll = generateHighPrecisionRoll(titleLuck);
                        if (tRoll >= BigInt(tData.rarity)) { gotTitle = tId; break; }
                    }
                    
                    if (gotTitle) {
                        u.titles_rolled = (u.titles_rolled || 0) + 1;
                        applyQuestProgressInMemory(qData, 'roll_title', 1, gotTitle);

                        unlockedTitlesArr.push(gotTitle); 
                        titlesChanged = true;
                        logs.push(`🏷️ Found Title: **[${TITLES[gotTitle]?.name || gotTitle}]**!`);
                    }
                }

                if (currentLuck === 1 && absRV >= 100000n) pendingAchievements.add('true_challenged');

                let lastV = BigInt(u.last_roll_val || '0');
                if (lastV >= 10000n && absRV >= lastV * 10n) pendingAchievements.add('jackpot');

                if (currentLuck >= 10000) {
                    if (absRV < BigInt(Math.floor(currentLuck * 1.2))) {
                        u.cook_counter = (parseInt(u.cook_counter, 10) || 0) + 1;
                        if (u.cook_counter >= 2) pendingAchievements.add('cooked');
                    } else u.cook_counter = 0;
                } else u.cook_counter = 0;

                if (u.total_rolls >= 1000 && rV === BigInt(u.total_rolls)) pendingAchievements.add('duplicate');

                if (absRV >= 1000n) pendingAchievements.add('find_1k');
                if (absRV >= 10000n) pendingAchievements.add('find_10k');
                if (absRV >= 100000n) pendingAchievements.add('find_100k');
                if (absRV >= 1000000n) pendingAchievements.add('find_1m');
                if (absRV >= 10000000n) pendingAchievements.add('find_10m');
                if (absRV >= 100000000n) pendingAchievements.add('find_100m');
                if (absRV >= 1000000000n) pendingAchievements.add('find_1b');
                if (absRV >= 10000000000n) pendingAchievements.add('find_10b');
                if (absRV >= 100000000000n) pendingAchievements.add('find_100b');
                if (absRV >= 1000000000000n) pendingAchievements.add('find_1t');
                if (absRV >= 10000000000000n) pendingAchievements.add('find_10t');
                if (absRV >= 100000000000000n) pendingAchievements.add('find_100t');
                if (absRV >= 1000000000000000n) pendingAchievements.add('find_1qa');
                if (absRV >= 10000000000000000n) pendingAchievements.add('find_10qa');
                if (absRV >= 100000000000000000n) pendingAchievements.add('find_100qa');

                u.last_roll_val = rV.toString(); 
                u.total_rolls = (parseInt(u.total_rolls, 10) || 0) + 1;
                u.weekly_rolls = (parseInt(u.weekly_rolls, 10) || 0) + 1;
                u.monthly_rolls = (parseInt(u.monthly_rolls, 10) || 0) + 1;
                u.last_roll_luck = currentLuck;

                let ac = "";
                let isAutoSell = false;

                if (rV >= 0n && rV <= th) isAutoSell = true;
                else if (rV < 0n && absRV <= th_neg) isAutoSell = true;

                if (isAutoSell && absRV >= 1000000n && (th >= 1000000n || th_neg >= 1000000n)) pendingAchievements.add('foolhardy');

                if (isAutoSell) { 
                    tCo += absRV; 
                    ac = "🪙 Auto-Sold"; 
                } else if (inv.length < u.slots) { 
                    inv.push({ _new: true, user_id: uId, roll_value: rV.toString(), is_locked: 0 }); 
                    invChanged = true;
                    u.total_score = (BigInt(u.total_score || '0') + absRV).toString();
                    u.weekly_score = (BigInt(u.weekly_score || '0') + absRV).toString();
                    u.monthly_score = (BigInt(u.monthly_score || '0') + absRV).toString();
                    if (rV > 0n && rV > BigInt(u._max_inv_roll || '0')) u._max_inv_roll = rV.toString();
                    ac = "📥 Saved"; 
                } else {
                    let unlck = inv.filter(x => x.is_locked === 0);
                    if (!unlck.length) { 
                        tCo += absRV; 
                        ac = "🪙 Sold (Inv Locked)"; 
                    } else {
                        let mI = 0, mV = BigInt(unlck[0].roll_value);
                        let mVRarity = mV < 0n ? -mV : mV;
                        for (let i = 1; i < unlck.length; i++) { 
                            let v = BigInt(unlck[i].roll_value); 
                            let vRarity = v < 0n ? -v : v;
                            if (vRarity < mVRarity) { mVRarity = vRarity; mI = i; mV = v; } 
                        }
                        if (absRV <= mVRarity) { 
                            tCo += absRV; 
                            ac = "🪙 Sold"; 
                        } else { 
                            tCo += mVRarity; 
                            let gI = inv.indexOf(unlck[mI]); 
                            const existingId = inv[gI]?.id;
                            inv[gI] = {
                                ...(existingId !== undefined ? { id: existingId, _dirty: true } : { _new: true }),
                                user_id: uId,
                                roll_value: rV.toString(),
                                is_locked: 0
                            }; 
                            invChanged = true;
                            const scoreDiff = absRV - mVRarity;
                            u.total_score = (BigInt(u.total_score || '0') + scoreDiff).toString();
                            u.weekly_score = (BigInt(u.weekly_score || '0') + scoreDiff).toString();
                            u.monthly_score = (BigInt(u.monthly_score || '0') + scoreDiff).toString();
                            if (rV > 0n && rV > BigInt(u._max_inv_roll || '0')) u._max_inv_roll = rV.toString();
                            ac = `♻️ Saved (Sold 1 in ${formatBigInt(mV)})`; 
                        }
                    }
                }
                if (rolls * ga <= 20) logs.push(`🎲 1 in **${formatBigInt(rV)}** [${ac}]`);
            }
            activePots.forEach(p => {
                if (u.equipped_chip === 'chip_autoroll' && POTIONS[p.potion_id]?.effects?.auto_potion) return;
                p.rolls_left -= rolls;
            }); 
            activePots = activePots.filter(p => p.rolls_left > 0);
        }

        if (recentRollValues.length > 100) {
            recentRollValues = recentRollValues.slice(-100);
        }
        if (recentRollValues.length >= 100) {
            let last100 = recentRollValues.slice(-100);
            let minR = last100[0], maxR = last100[0];
            for (let val of last100) {
                if (val < minR) minR = val;
                if (val > maxR) maxR = val;
            }
            if (minR > 0n && ((maxR - minR) * 100n / minR) <= 25n) {
                pendingAchievements.add('constant_numero');
            }
        }
        u.recent_rolls = JSON.stringify(recentRollValues.map(v => v.toString()));
        delete u._max_inv_roll;

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

        if (tCr > 0n) {
            if (u.crystals === '0') pendingAchievements.add('miner');
            if (BigInt(u.crystals || '0') + tCr >= 100000n) pendingAchievements.add('geologist');
        }

        if (titlesChanged) {
            u.unlocked_titles = JSON.stringify(unlockedTitlesArr);
        }
        u.coins = (BigInt(u.coins || '0') + tCo).toString(); 
        u.crystals = (BigInt(u.crystals || '0') + tCr).toString(); 
        u.nulls = (BigInt(u.nulls || '0') + tNu).toString();
        u.quest_data = JSON.stringify(qData);

        if (hadActivePots || activePots.length > 0) {
            await pool.execute('DELETE FROM active_potions WHERE user_id=?', [uId]);
            if (activePots.length > 0) {
                const potRows = activePots.map(p => [uId, p.potion_id, p.rank, p.rolls_left]);
                await pool.query('INSERT INTO active_potions (user_id, potion_id, `rank`, rolls_left) VALUES ?', [potRows]);
            }
        }
        
        if (invChanged) {
            const dirtyExisting = inv.filter(i => i._dirty && i.id !== undefined);
            const newItems = inv.filter(i => i._new || i.id === undefined);

            for (const item of dirtyExisting) {
                await pool.execute(
                    'UPDATE inventory SET roll_value = ?, is_locked = ? WHERE id = ? AND user_id = ?',
                    [item.roll_value.toString(), item.is_locked ? 1 : 0, item.id, uId]
                );
            }
            if (newItems.length === 1) {
                await pool.execute(
                    'INSERT INTO inventory (user_id, roll_value, is_locked) VALUES (?, ?, ?)',
                    [uId, newItems[0].roll_value.toString(), newItems[0].is_locked ? 1 : 0]
                );
            } else if (newItems.length > 1) {
                const invRows = newItems.map(i => [uId, i.roll_value.toString(), i.is_locked ? 1 : 0]);
                await pool.query('INSERT INTO inventory (user_id, roll_value, is_locked) VALUES ?', [invRows]);
            }
        }

        await saveUser(u);

        let unl = [];
        for (let aId of pendingAchievements) {
            let res = await grantAchievement(u, aId);
            if (res) unl.push(res);
        }

        let nextStats = calcStats(u, activePots);
        let nextRollUnix = Math.ceil((Number(u.last_roll) + nextStats.finalCd * 1000) / 1000);

        let fd = logs.length ? logs.join('\n') : `⚡ **Auto-Generated ${rolls * (pStats.magic ? 10 : 1)} numbers!**\n*Check inventory.*`;
        let ea = [];
        if (tCo > 0n) ea.push(`💰 ${formatBigInt(tCo)}`); 
        if (tCr > 0n) ea.push(`💎 ${formatBigInt(tCr)}`); 
        if (tNu > 0n) ea.push(`⬛ ${formatBigInt(tNu)}`);
        if (ea.length) fd += `\n\n**Gained:** ${ea.join(' | ')}`;
        fd += `\n⏱️ **Next Roll:** <t:${nextRollUnix}:R>`;
        if (unl.length) fd += `\n\n${unl.join('\n')}`;

        let embedColor = 0x00FF00;
        if (u.custom_color && /^#[0-9A-Fa-f]{6}$/.test(u.custom_color)) {
            embedColor = parseInt(u.custom_color.replace('#', ''), 16);
        }

        const emb = new EmbedBuilder()
            .setColor(embedColor)
            .setAuthor({ name: `${username}'s Roll`, iconURL: ctx.user ? ctx.user.displayAvatarURL() : ctx.author.displayAvatarURL() })
            .setDescription(fd)
            .setFooter({ text: `Final Luck: ${pStats.finalLuck.toFixed(2)}x | Base CD: ${nextStats.finalCd.toFixed(2)}s` });
        
        const rw = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('roll_again').setLabel('🎲 Roll Again').setStyle(ButtonStyle.Success)
        );

        await FrameManager.sendFrame(ctx, { embeds: [emb], components: [rw] }, uId);

    } finally {
        activeRolls.delete(rollLockKey);
    }
}

module.exports = { executeRoll };

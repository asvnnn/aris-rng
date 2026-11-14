const { pool, getUser, saveUser, giveItem, takeItem } = require('../database/userModel');
const { POTIONS, MODULES, CHIPS } = require('../data/items');
const { grantAchievement } = require('./achievementSystem');
const { ensureQuestDataInMemory, applyQuestProgressInMemory } = require('./questSystem');

const MAX_SQL_INT = 2000000000;
const MAX_TX_QTY = 1000000n;

function formatBigInt(bi) { 
    return BigInt(bi).toLocaleString('en-US'); 
}

function resetModuleStacks(u) {
    u.glitch_counter = 0; u.glitch_basic = 0; u.glitch_cd = 0; u.glitch_multi = 0;
}

function resetChipStacks(u) {
    u.error_chip_counter = 0; u.error_chip_basic = 0; u.error_chip_cd = 0; u.error_chip_multi = 0;
}

async function consumeMaterialAndSyncEquip(u, userId, itemId, qty) {
    await takeItem(userId, itemId, qty);
    if (u.equipped_module === itemId || u.equipped_chip === itemId) {
        const [rem] = await pool.execute('SELECT quantity FROM items WHERE user_id=? AND item_id=?', [userId, itemId]);
        const left = (rem && rem.length > 0) ? (Number(rem[0].quantity) || 0) : 0;
        if (left <= 0) {
            if (u.equipped_module === itemId) {
                u.equipped_module = null;
                resetModuleStacks(u);
            }
            if (u.equipped_chip === itemId) {
                u.equipped_chip = null;
                resetChipStacks(u);
            }
        }
    }
}

async function doPurchase(userOrId, selId, qtyInput, isBShop = false) {
    let u = (userOrId && typeof userOrId === 'object') ? userOrId : await getUser(userOrId);
    const userId = u.id;
    
    let item;
    if (selId === 'item_cc') {
        item = { name: 'Compressed Crystal', cur: 'crystals', cost: 1000n, bshopOnly: true, noDiscount: true };
    } else {
        item = POTIONS[selId] || MODULES[selId] || CHIPS[selId];
    }
    
    if (!item || item.unbuyable) return "❌ Item not found or cannot be purchased.";

    let bShopData = null;
    if (isBShop) {
        const { getBlackMarketData } = require('./blackMarket');
        bShopData = getBlackMarketData(userId);
        if (!bShopData || !bShopData.active) {
            return `❌ The Black Market is currently closed.`;
        }
        if (item.bshopOnly && selId !== 'item_cc' && bShopData.inventory && Array.isArray(bShopData.inventory.items) && bShopData.inventory.items.length > 0) {
            if (!bShopData.inventory.items.includes(selId)) {
                return `❌ This item is not in stock in the current Black Market!`;
            }
        }
    }

    let costMultiplier = (isBShop && !item.noDiscount && !item.bshopOnly && !item.craft) ? 75n : 100n;
    let actualCost = (BigInt(item.cost || 0) * costMultiplier) / 100n;

    if (Array.isArray(qtyInput) || (typeof qtyInput === 'object' && qtyInput !== null)) {
        return "❌ Invalid quantity.";
    }

    let qty = 1n;
    const rawQtyStr = String(qtyInput ?? '1').trim().toLowerCase();
    
    if (rawQtyStr === 'max') {
        let max = MAX_TX_QTY; 
        
        if (actualCost > 0n) {
            let bal = item.cur === 'crystals' ? BigInt(u.crystals) : item.cur === 'nulls' ? BigInt(u.nulls) : item.cur === 'cc' ? BigInt(u.cc_coins) : BigInt(u.coins);
            let affordable = bal / actualCost;
            if (affordable < max) max = affordable;
        }
        
        let limit = item.limit;
        if (isBShop && !limit && !item.craft && POTIONS[selId]) limit = 100; 
        
        if (limit) { 
            let trackKey = selId;
            let cur = JSON.parse(u.daily_purchases || '{}')[trackKey] || 0; 
            let rem = BigInt(Math.max(0, limit - cur));
            if (rem < max) max = rem; 
        }

        if (isBShop && selId === 'item_cc' && bShopData?.inventory) {
            let stockRem = BigInt(Math.max(0, bShopData.inventory.ccStock || 0));
            if (stockRem < max) max = stockRem;
        }
        
        if (item.craft) {
            if (item.reqCoins) { let c = BigInt(u.coins) / BigInt(item.reqCoins); if (c < max) max = c; }
            if (item.reqCrys) { let c = BigInt(u.crystals) / BigInt(item.reqCrys); if (c < max) max = c; }
            if (item.reqNulls) { let c = BigInt(u.nulls) / BigInt(item.reqNulls); if (c < max) max = c; }
            if (item.reqCC) { let c = BigInt(u.cc_coins) / BigInt(item.reqCC); if (c < max) max = c; }
            
            const checkInvMax = async (reqId, reqQty) => {
                if (!reqId) return max;
                const [r] = await pool.execute('SELECT quantity FROM items WHERE user_id=? AND item_id=?', [userId, reqId]);
                let invQty = (r && r.length) ? BigInt(r[0].quantity) : 0n;
                return invQty / BigInt(reqQty || 1);
            };

            if (item.reqMod) { let c = await checkInvMax(item.reqMod, item.reqModQty); if (c < max) max = c; }
            if (item.reqMod2) { let c = await checkInvMax(item.reqMod2, item.reqMod2Qty); if (c < max) max = c; }
            if (item.reqMod3) { let c = await checkInvMax(item.reqMod3, item.reqMod3Qty); if (c < max) max = c; }
            if (item.reqChip) { let c = await checkInvMax(item.reqChip, item.reqChipQty); if (c < max) max = c; }
            if (item.reqChip2) { let c = await checkInvMax(item.reqChip2, item.reqChip2Qty); if (c < max) max = c; }
            if (item.reqPot) { let c = await checkInvMax(item.reqPot, item.reqPotQty); if (c < max) max = c; }
            if (item.reqPot2) { let c = await checkInvMax(item.reqPot2, item.reqPot2Qty); if (c < max) max = c; }
            if (item.reqTitle) {
                let unlockedTitlesArr = [];
                try { unlockedTitlesArr = JSON.parse(u.unlocked_titles || '[]'); } catch (e) { unlockedTitlesArr = []; }
                let titleCount = unlockedTitlesArr.filter(t => t === item.reqTitle).length;
                let c = BigInt(titleCount) / BigInt(item.reqTitleQty || 1);
                if (c < max) max = c;
            }
            if (item.reqModOr && Array.isArray(item.reqModOr)) {
                let totalOr = 0n;
                for (const mId of item.reqModOr) {
                    const [r] = await pool.execute('SELECT quantity FROM items WHERE user_id=? AND item_id=?', [userId, mId]);
                    if (r && r.length) totalOr += BigInt(r[0].quantity);
                }
                if (totalOr < max) max = totalOr;
            }
        }
        
        if (selId !== 'item_cc' && !POTIONS[selId] && !['mod_glitch', 'chip_error', 'chip_luck', 'mod_luck'].includes(selId) && max > 1n) {
            max = 1n;
        }
        qty = max;
    } else {
        if (!/^\d+$/.test(rawQtyStr) || rawQtyStr.length > 9) {
            return "❌ Invalid quantity.";
        }
        qty = BigInt(rawQtyStr);
        if (qty > MAX_TX_QTY) qty = MAX_TX_QTY;
    }

    if (item.failChance && qty > 100n) {
        qty = 100n;
    }

    if (qty < 1n) return "❌ Invalid quantity or cannot afford.";

    if (isBShop && selId === 'item_cc') {
        if (bShopData && bShopData.inventory) {
            let currentStock = bShopData.inventory.ccStock || 0;
            if (Number(qty) > currentStock) {
                return `❌ Black Market does not have enough stock! (Available: ${currentStock})`;
            }
            bShopData.inventory.ccStock -= Number(qty);
        } else {
             return `❌ The Black Market is currently closed.`;
        }
    }

    let limit = item.limit;
    if (isBShop && !limit && !item.craft && POTIONS[selId]) limit = 100;
    
    if (limit) {
        let dict = JSON.parse(u.daily_purchases || '{}'); 
        let trackKey = selId;
        let cur = dict[trackKey] || 0;
        if (cur + Number(qty) > limit) return `❌ Daily limit reached! You can only buy ${limit - cur} more today.`;
        dict[trackKey] = cur + Number(qty); 
        u.daily_purchases = JSON.stringify(dict);
    }

    let totalCoinsSpent = 0n;

    if (item.craft) {
        if (item.reqCoins && BigInt(u.coins) < BigInt(item.reqCoins) * qty) return "❌ Not enough coins.";
        if (item.reqCrys && BigInt(u.crystals) < BigInt(item.reqCrys) * qty) return "❌ Not enough crystals.";
        if (item.reqNulls && BigInt(u.nulls) < BigInt(item.reqNulls) * qty) return "❌ Not enough nulls.";
        if (item.reqCC && BigInt(u.cc_coins) < BigInt(item.reqCC) * qty) return "❌ Not enough Compressed Crystals (CC).";

        const checkMat = async (reqId, reqQty) => {
            if (!reqId) return true;
            const [r] = await pool.execute('SELECT quantity FROM items WHERE user_id=? AND item_id=?', [userId, reqId]);
            return r.length > 0 && BigInt(r[0].quantity) >= BigInt(reqQty || 1) * qty;
        };

        if (!(await checkMat(item.reqMod, item.reqModQty))) return "❌ Not enough required Modules.";
        if (!(await checkMat(item.reqMod2, item.reqMod2Qty))) return "❌ Not enough required Modules.";
        if (item.reqMod3 && !(await checkMat(item.reqMod3, item.reqMod3Qty))) return "❌ Not enough required Modules.";
        if (!(await checkMat(item.reqChip, item.reqChipQty))) return "❌ Not enough required Chips.";
        if (!(await checkMat(item.reqChip2, item.reqChip2Qty))) return "❌ Not enough required Chips.";
        if (!(await checkMat(item.reqPot, item.reqPotQty))) return "❌ Not enough required Potions.";
        if (!(await checkMat(item.reqPot2, item.reqPot2Qty))) return "❌ Not enough required Potions.";
        if (item.reqTitle) {
            let unlockedTitlesArr = [];
            try { unlockedTitlesArr = JSON.parse(u.unlocked_titles || '[]'); } catch (e) { unlockedTitlesArr = []; }
            let titleCount = unlockedTitlesArr.filter(t => t === item.reqTitle).length;
            if (titleCount < (item.reqTitleQty || 1) * Number(qty)) {
                return `❌ Not enough required Titles (Need ${(item.reqTitleQty || 1) * Number(qty)}x [${item.reqTitle}]).`;
            }
        }

        let chosenOrMods = [];
        if (item.reqModOr && Array.isArray(item.reqModOr)) {
            let needed = Number(qty);
            for (const mId of item.reqModOr) {
                if (needed <= 0) break;
                const [r] = await pool.execute('SELECT quantity FROM items WHERE user_id=? AND item_id=?', [userId, mId]);
                let avail = r.length ? r[0].quantity : 0;
                if (avail > 0) {
                    let takeAmt = Math.min(needed, avail);
                    chosenOrMods.push({ id: mId, qty: takeAmt });
                    needed -= takeAmt;
                }
            }
            if (needed > 0) {
                let names = item.reqModOr.map(id => MODULES[id]?.name || id).join(' OR ');
                return `❌ Not enough required Modules (Need ${names}).`;
            }
        }

        if (item.reqCoins) {
            let costCoins = BigInt(item.reqCoins) * qty;
            u.coins = (BigInt(u.coins) - costCoins).toString();
            totalCoinsSpent += costCoins;
        }
        if (item.reqCrys) u.crystals = (BigInt(u.crystals) - BigInt(item.reqCrys) * qty).toString();
        if (item.reqNulls) u.nulls = (BigInt(u.nulls) - BigInt(item.reqNulls) * qty).toString();
        if (item.reqCC) {
            let nextCC = BigInt(u.cc_coins || 0) - (BigInt(item.reqCC) * qty);
            u.cc_coins = (nextCC < 0n ? 0n : nextCC).toString();
        }
        
        if (item.reqMod) await consumeMaterialAndSyncEquip(u, userId, item.reqMod, (item.reqModQty || 1) * Number(qty));
        if (item.reqMod2) await consumeMaterialAndSyncEquip(u, userId, item.reqMod2, (item.reqMod2Qty || 1) * Number(qty));
        if (item.reqMod3) await consumeMaterialAndSyncEquip(u, userId, item.reqMod3, (item.reqMod3Qty || 1) * Number(qty));
        if (item.reqChip) await consumeMaterialAndSyncEquip(u, userId, item.reqChip, (item.reqChipQty || 1) * Number(qty));
        if (item.reqChip2) await consumeMaterialAndSyncEquip(u, userId, item.reqChip2, (item.reqChip2Qty || 1) * Number(qty));
        if (item.reqPot) await consumeMaterialAndSyncEquip(u, userId, item.reqPot, (item.reqPotQty || 1) * Number(qty));
        if (item.reqPot2) await consumeMaterialAndSyncEquip(u, userId, item.reqPot2, (item.reqPot2Qty || 1) * Number(qty));
        if (item.reqTitle) {
            let unlockedTitlesArr = [];
            try { unlockedTitlesArr = JSON.parse(u.unlocked_titles || '[]'); } catch (e) { unlockedTitlesArr = []; }
            let toRemove = (item.reqTitleQty || 1) * Number(qty);
            for (let i = unlockedTitlesArr.length - 1; i >= 0 && toRemove > 0; i--) {
                if (unlockedTitlesArr[i] === item.reqTitle) {
                    unlockedTitlesArr.splice(i, 1);
                    toRemove--;
                }
            }
            u.unlocked_titles = JSON.stringify(unlockedTitlesArr);
            if (u.equipped_title === item.reqTitle && !unlockedTitlesArr.includes(item.reqTitle)) {
                u.equipped_title = null;
            }
        }
        for (const orItem of chosenOrMods) {
            await consumeMaterialAndSyncEquip(u, userId, orItem.id, orItem.qty);
        }
    } 
    else {
        let tc = actualCost * qty;
        if (item.cur === 'crystals' && BigInt(u.crystals) < tc) return "❌ Not enough crystals.";
        if (item.cur === 'coins' && BigInt(u.coins) < tc) return "❌ Not enough coins.";
        if (item.cur === 'nulls' && BigInt(u.nulls) < tc) return "❌ Not enough nulls.";
        if (item.cur === 'cc' && BigInt(u.cc_coins) < tc) return "❌ Not enough Compressed Crystals (CC).";
        
        if (item.cur === 'crystals') u.crystals = (BigInt(u.crystals) - tc).toString();
        else if (item.cur === 'nulls') u.nulls = (BigInt(u.nulls) - tc).toString();
        else if (item.cur === 'cc') u.cc_coins = (BigInt(u.cc_coins || 0) - tc).toString();
        else {
            u.coins = (BigInt(u.coins) - tc).toString();
            totalCoinsSpent += tc;
        }
    }
    
    if (selId === 'item_cc') {
        u.cc_coins = (BigInt(u.cc_coins || 0) + qty).toString();
    } else {
        await giveItem(userId, selId, Number(qty)); 
    }

    if (totalCoinsSpent > 0n) {
        let safeSpend = totalCoinsSpent > 2000000000n ? 2000000000 : Number(totalCoinsSpent);
        const qData = ensureQuestDataInMemory(u);
        if (applyQuestProgressInMemory(qData, 'spend', safeSpend) || !u.quest_data || u.quest_data === '{}') {
            u.quest_data = JSON.stringify(qData);
        }
    }
    
    await saveUser(u);
    
    let m = `✅ ${item.craft ? 'Crafted' : 'Bought'} **${qty}x ${item.name}**!`;
    if (selId === 'mod_spectrometer') { let a = await grantAchievement(u, 'spectrophotometer'); if (a) m += `\n${a}`; }
    return m;
}

async function doUse(userOrId, selId, qtyInput) {
    let u = (userOrId && typeof userOrId === 'object') ? userOrId : await getUser(userOrId);
    const userId = u.id;
    const p = POTIONS[selId];
    if (!p) return "❌ Only potions can be used.";
    
    const [r] = await pool.execute('SELECT quantity FROM items WHERE user_id=? AND item_id=?', [userId, selId]);
    if (!r.length || r[0].quantity < 1) return "❌ You don't own this potion.";

    if (Array.isArray(qtyInput) || (typeof qtyInput === 'object' && qtyInput !== null)) {
        return "❌ Invalid amount.";
    }

    const rawUseStr = String(qtyInput ?? '1').trim().toLowerCase();
    let qty;
    if (rawUseStr === 'all') {
        qty = r[0].quantity;
    } else {
        if (!/^\d+$/.test(rawUseStr) || rawUseStr.length > 9) return `❌ Invalid amount.`;
        qty = parseInt(rawUseStr, 10);
    }
    if (isNaN(qty) || qty < 1 || qty > r[0].quantity) return `❌ Invalid amount.`;

    if (p.rank !== 'Special') {
        const [act] = await pool.execute('SELECT * FROM active_potions WHERE user_id=? AND `rank`=?', [userId, p.rank]);
        if (act.length > 0 && act[0].potion_id !== selId) {
            let activeName = POTIONS[act[0].potion_id]?.name || act[0].potion_id;
            return `❌ A different Rank ${p.rank} potion (**${activeName}**) is already active! Wait for it to expire or use the same potion.`;
        }
    }

    const [ePot] = await pool.execute('SELECT rolls_left FROM active_potions WHERE user_id=? AND potion_id=?', [userId, selId]);
    const currentRollsLeft = ePot.length ? (Number(ePot[0].rolls_left) || 0) : 0;
    const durPerPot = Math.max(1, Number(p.dur) || 1);
    const maxAdditionalPots = Math.floor((MAX_SQL_INT - currentRollsLeft) / durPerPot);

    if (maxAdditionalPots < 1) {
        return `❌ Maximum active roll duration reached for **${p.name}**!`;
    }
    if (qty > maxAdditionalPots) {
        qty = maxAdditionalPots;
    }
    
    const taken = await takeItem(userId, selId, qty);
    if (!taken) return "❌ You don't own enough of this potion.";
    
    if (ePot.length) {
        await pool.execute('UPDATE active_potions SET rolls_left = rolls_left + ? WHERE user_id=? AND potion_id=?', [durPerPot * qty, userId, selId]);
    } else {
        await pool.execute('INSERT INTO active_potions (user_id, potion_id, `rank`, rolls_left) VALUES (?, ?, ?, ?)', [userId, selId, p.rank, durPerPot * qty]);
    }

    u.total_potions_consumed = (parseInt(u.total_potions_consumed) || 0) + qty; 
    let aMsgs = [];
    
    if (selId === 'pot_magic') { let a = await grantAchievement(u, 'magical'); if (a) aMsgs.push(a); }
    if (selId === 'pot_storm') { let a = await grantAchievement(u, 'just_wind'); if (a) aMsgs.push(a); }
    if (selId === 'pot_undefine') { let a = await grantAchievement(u, 'define_undefine'); if (a) aMsgs.push(a); }

    await saveUser(u);
    return `✅ Consumed **${qty}x ${p.name}**! (+${p.dur * qty} rolls)${aMsgs.length ? '\n' + aMsgs.join('\n') : ''}`;
}

module.exports = {
    doPurchase,
    doUse,
    resetModuleStacks,
    resetChipStacks
};

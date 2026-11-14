const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { FrameManager, acquireLock, releaseLock, createVerification, consumeVerification } = require('../../utils/discord');
const { pool, saveUser, giveItem } = require('../../database/userModel');
const { doPurchase, doUse, resetModuleStacks, resetChipStacks } = require('../../systems/economySystem');
const { POTIONS, MODULES, CHIPS } = require('../../data/items');
const { claimQuest, rerollQuest } = require('../../systems/questSystem');
const { grantAchievement } = require('../../systems/achievementSystem');
const { executeVerifiedControl } = require('../../systems/premiumSystem');

async function handleButton(interaction, userDb, client) {
    const customId = interaction.customId;

    if (customId.startsWith('verify_confirm_')) {
        const token = customId.replace('verify_confirm_', '');
        const payload = consumeVerification(token, interaction.user.id);
        if (!payload) {
            const expiredEmbed = new EmbedBuilder()
                .setTitle('⏱️ Verification Expired')
                .setColor(0x95A5A6)
                .setDescription('❌ This verification prompt has expired or was already processed.');
            await FrameManager.sendFrame(interaction, { embeds: [expiredEmbed], components: [] }, interaction.user.id);
            return;
        }

        releaseLock(interaction.user.id);
        let resultEmbed;
        let resultComponents = [];
        try {
            if (payload.source === 'control') {
                const msg = await executeVerifiedControl(payload);
                resultEmbed = new EmbedBuilder()
                    .setTitle('✅ Operation Executed')
                    .setColor(0x2ECC71)
                    .setDescription(msg);
            } else if (payload.source === 'shop') {
                const result = await doPurchase(userDb, payload.sId, payload.qty, payload.isBShop);
                await interaction.followUp({ content: result, flags: MessageFlags.Ephemeral }).catch(() => {});
                const shopCmd = client.commands.get('shop');
                if (shopCmd) {
                    await shopCmd.renderShop(interaction, userDb, payload.isBShop, payload.sId);
                }
                return;
            }
        } finally {
            await acquireLock(interaction.user.id);
        }

        if (resultEmbed) {
            await FrameManager.sendFrame(interaction, { embeds: [resultEmbed], components: resultComponents }, interaction.user.id);
        }
        return;
    }

    if (customId.startsWith('verify_cancel_')) {
        const token = customId.replace('verify_cancel_', '');
        const payload = consumeVerification(token, interaction.user.id);
        if (payload && payload.source === 'shop') {
            const shopCmd = client.commands.get('shop');
            if (shopCmd) {
                await shopCmd.renderShop(interaction, userDb, payload.isBShop, payload.sId);
                return;
            }
        }
        const cancelEmbed = new EmbedBuilder()
            .setTitle('Cancelled')
            .setColor(0xE74C3C)
            .setDescription('Operation was cancelled.');
        await FrameManager.sendFrame(interaction, { embeds: [cancelEmbed], components: [] }, interaction.user.id);
        return;
    }

    if (customId === 'btn_delete_frame') {
        FrameManager.removeFrame(interaction.user.id);
        if (typeof interaction.message?.delete === 'function') {
            await interaction.message.delete().catch(() => {});
        } else if (typeof interaction.deleteReply === 'function') {
            await interaction.deleteReply().catch(() => {});
        }
        return;
    }

    if (customId === 'roll_again') {
        const { executeRoll } = require('../../systems/rollEngine');
        await executeRoll(interaction, userDb);
    }
    else if (customId.startsWith('shop_tab_')) {
        const tab = customId.replace('shop_tab_', '');
        const isBShop = interaction.message.embeds[0]?.data?.title?.includes('Black Market') || false;
        const shopCmd = client.commands.get('shop');
        await shopCmd.renderShop(interaction, userDb, isBShop, null, tab);
    }
    else if (customId.startsWith('buy_')) {
        const parts = customId.split('_');
        const action = parts[1];
        const isBShop = parts.pop() === 'true';
        const sId = parts.slice(2).join('_');

        if (action === 'custom') {
            const modal = new ModalBuilder().setCustomId(`modal_buy_${sId}_${isBShop}`).setTitle('Enter Quantity');
            const qtyInput = new TextInputBuilder().setCustomId('qty').setLabel('Amount or type "max"').setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
            await interaction.showModal(modal);
        } else {
            const itemObj = sId === 'item_cc'
                ? { name: 'Compressed Crystal (CC)', craft: false }
                : (POTIONS[sId] || MODULES[sId] || CHIPS[sId] || { name: sId });
            const token = createVerification(interaction.user.id, {
                source: 'shop',
                sId,
                qty: action,
                isBShop
            });
            const confirmEmbed = new EmbedBuilder()
                .setTitle(`🛒 Confirm ${itemObj.craft ? 'Crafting' : 'Purchase'}`)
                .setColor(0xF1C40F)
                .setDescription(
                    `Are you sure you want to ${itemObj.craft ? 'craft' : 'buy'} **${action === 'max' ? 'MAX' : `${action}x`} ${itemObj.name}**${isBShop ? ' from the **Black Market**' : ''}?\n\n` +
                    `⏱️ *Please click Confirm within 60 seconds to complete this transaction.*`
                );
            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`verify_confirm_${token}`).setLabel('✅ Confirm').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`verify_cancel_${token}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger)
            );
            await FrameManager.sendFrame(interaction, { embeds: [confirmEmbed], components: [confirmRow] }, interaction.user.id);
        }
    }
    else if (customId.startsWith('use_p_custom_')) {
        const sId = customId.replace('use_p_custom_', '');
        const modal = new ModalBuilder().setCustomId(`modal_use_${sId}`).setTitle('Enter Quantity to Use');
        const qtyInput = new TextInputBuilder().setCustomId('qty').setLabel('Amount').setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
        await interaction.showModal(modal);
    }
    else if (customId.startsWith('use_p_')) {
        const parts = customId.split('_');
        const action = parts[2];
        const sId = parts.slice(3).join('_');
        const result = await doUse(userDb, sId, action);
        await interaction.followUp({ content: result, flags: MessageFlags.Ephemeral });

        const [checkItem] = await pool.execute('SELECT quantity FROM items WHERE user_id=? AND item_id=?', [userDb.id, sId]);
        const nextSelectId = (checkItem.length > 0 && checkItem[0].quantity > 0) ? sId : null;

        const invCmd = client.commands.get('inv');
        await invCmd.renderInv(interaction, userDb, nextSelectId);
    }
    else if (customId === 'inv_exp') {
        let cost = BigInt(2) ** BigInt(Math.max(0, userDb.slots - 10));
        if (BigInt(userDb.crystals) < cost) return interaction.followUp({ content: `❌ Need 💎 ${cost.toLocaleString('en-US')} to expand.`, flags: MessageFlags.Ephemeral });
        userDb.crystals = (BigInt(userDb.crystals) - cost).toString();
        userDb.slots++;
        let achMsg = null;
        if (userDb.slots >= 17) {
            achMsg = await grantAchievement(userDb, 'slot_spec');
        }
        await saveUser(userDb);
        await interaction.followUp({
            content: `✅ Expanded inventory to **${userDb.slots}** slots!${achMsg ? `\n${achMsg}` : ''}`,
            flags: MessageFlags.Ephemeral
        });
        const invCmd = client.commands.get('inv');
        await invCmd.renderInv(interaction, userDb);
    }
    else if (customId === 'inv_sell_all') {
        const [rRows] = await pool.execute('SELECT * FROM inventory WHERE user_id = ? AND is_locked = 0', [userDb.id]);
        if (rRows.length === 0) return interaction.followUp({ content: '❌ No unlocked rolls to sell.', flags: MessageFlags.Ephemeral });

        let totalSell = 0n;
        for (let r of rRows) {
            let v = BigInt(r.roll_value);
            totalSell += (v < 0n ? -v : v);
        }

        userDb.coins = (BigInt(userDb.coins) + totalSell).toString();
        let nextScore = BigInt(userDb.total_score || '0') - totalSell;
        userDb.total_score = (nextScore < 0n ? 0n : nextScore).toString();
        await pool.execute('DELETE FROM inventory WHERE user_id = ? AND is_locked = 0', [userDb.id]);
        await saveUser(userDb);

        await interaction.followUp({
            content: `✅ Sold all unlocked rolls for 🪙 **${totalSell.toLocaleString('en-US')}**!`,
            flags: MessageFlags.Ephemeral
        });
        const invCmd = client.commands.get('inv');
        await invCmd.renderInv(interaction, userDb);
    }
    else if (customId.startsWith('inv_sell_r_')) {
        const rId = customId.replace('inv_sell_r_', '');
        const [rRows] = await pool.execute('SELECT * FROM inventory WHERE id = ? AND user_id = ?', [rId, userDb.id]);
        if (rRows.length === 0) return interaction.followUp({ content: '❌ Roll not found.', flags: MessageFlags.Ephemeral });
        if (rRows[0].is_locked === 1) return interaction.followUp({ content: '❌ Unlock this roll before selling.', flags: MessageFlags.Ephemeral });

        let v = BigInt(rRows[0].roll_value);
        let sellVal = v < 0n ? -v : v;

        userDb.coins = (BigInt(userDb.coins) + sellVal).toString();
        let nextScore = BigInt(userDb.total_score || '0') - sellVal;
        userDb.total_score = (nextScore < 0n ? 0n : nextScore).toString();
        await pool.execute('DELETE FROM inventory WHERE id = ?', [rId]);
        await saveUser(userDb);

        await interaction.followUp({
            content: `✅ Sold roll for 🪙 **${sellVal.toLocaleString('en-US')}**!`,
            flags: MessageFlags.Ephemeral
        });
        const invCmd = client.commands.get('inv');
        await invCmd.renderInv(interaction, userDb);
    }
    else if (customId.startsWith('inv_lock_r_')) {
        const rId = customId.replace('inv_lock_r_', '');
        await pool.execute('UPDATE inventory SET is_locked = 1 - is_locked WHERE id = ? AND user_id = ?', [rId, userDb.id]);
        const invCmd = client.commands.get('inv');
        await invCmd.renderInv(interaction, userDb, `r_${rId}`);
    }
    else if (customId.startsWith('eq_m_')) {
        const mId = customId.replace('eq_m_', '');
        if (!MODULES[mId]) {
            await interaction.followUp({ content: '❌ Invalid equipment: Item is not a Module!', flags: MessageFlags.Ephemeral });
            return;
        }
        const [ownCheck] = await pool.execute('SELECT quantity FROM items WHERE user_id = ? AND item_id = ?', [userDb.id, mId]);
        if (!ownCheck.length || ownCheck[0].quantity < 1) {
            await interaction.followUp({ content: '❌ You no longer own this Module!', flags: MessageFlags.Ephemeral });
            const invCmd = client.commands.get('inv');
            await invCmd.renderInv(interaction, userDb, null);
            return;
        }
        userDb.equipped_module = mId;
        resetModuleStacks(userDb);
        await saveUser(userDb);
        let respMsg = `✅ Equipped Module & Reset Accumulated Stacks!`;
        await interaction.followUp({ content: respMsg, flags: MessageFlags.Ephemeral });
        const invCmd = client.commands.get('inv');
        await invCmd.renderInv(interaction, userDb, mId);
    }
    else if (customId.startsWith('uneq_m_')) {
        const mId = customId.replace('uneq_m_', '');
        userDb.equipped_module = null;
        resetModuleStacks(userDb);
        await saveUser(userDb);
        await interaction.followUp({ content: `✅ Unequipped Module & Reset Accumulated Stacks!`, flags: MessageFlags.Ephemeral });
        const invCmd = client.commands.get('inv');
        await invCmd.renderInv(interaction, userDb, mId);
    }
    else if (customId.startsWith('eq_c_')) {
        const cId = customId.replace('eq_c_', '');
        if (!CHIPS[cId]) {
            await interaction.followUp({ content: '❌ Invalid equipment: Item is not a Chip!', flags: MessageFlags.Ephemeral });
            return;
        }
        const [ownCheck] = await pool.execute('SELECT quantity FROM items WHERE user_id = ? AND item_id = ?', [userDb.id, cId]);
        if (!ownCheck.length || ownCheck[0].quantity < 1) {
            await interaction.followUp({ content: '❌ You no longer own this Chip!', flags: MessageFlags.Ephemeral });
            const invCmd = client.commands.get('inv');
            await invCmd.renderInv(interaction, userDb, null);
            return;
        }
        userDb.equipped_chip = cId;
        resetChipStacks(userDb);
        await saveUser(userDb);
        let respMsg = `✅ Equipped Chip & Reset Accumulated Stacks!`;
        await interaction.followUp({ content: respMsg, flags: MessageFlags.Ephemeral });
        const invCmd = client.commands.get('inv');
        await invCmd.renderInv(interaction, userDb, cId);
    }
    else if (customId.startsWith('uneq_c_')) {
        const cId = customId.replace('uneq_c_', '');
        userDb.equipped_chip = null;
        resetChipStacks(userDb);
        await saveUser(userDb);
        await interaction.followUp({ content: `✅ Unequipped Chip & Reset Accumulated Stacks!`, flags: MessageFlags.Ephemeral });
        const invCmd = client.commands.get('inv');
        await invCmd.renderInv(interaction, userDb, cId);
    }
    else if (customId === 'set_p' || customId === 'set_l' || customId === 'set_bshop' || customId === 'set_equip') {
        if (customId === 'set_p') userDb.stat_privacy = 1 - userDb.stat_privacy;
        if (customId === 'set_l') userDb.luck_toggle = 1 - userDb.luck_toggle;
        if (customId === 'set_bshop') userDb.bshop_ping = 1 - userDb.bshop_ping;
        if (customId === 'set_equip') userDb.hide_equip = 1 - (userDb.hide_equip || 0);
        await saveUser(userDb);
        const setCmd = client.commands.get('setting');
        await setCmd.renderSetting(interaction, userDb);
    }
    else if (customId === 'set_color') {
        const isDm = !interaction.guild;
        const hasColorAccess = isDm || userDb.is_colorful === 1;
        if (!hasColorAccess) {
            return interaction.reply({
                content: '❌ You need to unlock Custom Color first! (Or use `>setting` in DMs for free)',
                flags: MessageFlags.Ephemeral
            });
        }
        const modal = new ModalBuilder().setCustomId('modal_color').setTitle('Set Custom Color');
        const input = new TextInputBuilder().setCustomId('hex').setLabel('Hex Code (e.g. #FF0000)').setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    }
    else if (customId.startsWith('ctrl_cat_')) {
        const parts = customId.split('_');
        let cat = 'potions';
        let page = 0;
        if (parts[2] === 'tab') {
            cat = parts[3] || 'potions';
            page = 0;
        } else if (parts[2] === 'pg') {
            cat = parts[3] || 'potions';
            page = parseInt(parts[4], 10) || 0;
        } else {
            cat = parts[2] || 'potions';
            page = parseInt(parts[3], 10) || 0;
        }
        const ctrlCmd = client.commands.get('control');
        if (ctrlCmd && typeof ctrlCmd.renderControlCatalog === 'function') {
            await ctrlCmd.renderControlCatalog(interaction, interaction.user.id, cat, page);
        }
    }
    else if (customId === 'set_as_pos' || customId === 'set_as_neg') {
        const isPos = customId === 'set_as_pos';
        const modal = new ModalBuilder().setCustomId(`modal_as_${isPos ? 'pos' : 'neg'}`).setTitle(`Set Auto-Sell ${isPos ? '(+)' : '(-)'}`);
        const input = new TextInputBuilder()
            .setCustomId('val')
            .setLabel(isPos ? 'Ngưỡng tự bán số dương (>= 0)' : 'Ngưỡng bán số âm (từ -1 đến -X)')
            .setPlaceholder(isPos ? 'Ví dụ: 1000 (tự bán từ 1 đến 1000)' : 'Ví dụ: 5000 (tự bán từ -1 đến -5000)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    }
    else if (customId.startsWith('lb_')) {
        const parts = customId.split('_');
        let type = 'rolls';
        let page = 0;
        let period = 'all';
        if (parts[1] === 't' || parts[1] === 'p') {
            type = parts[2] || 'rolls';
            page = 0;
            period = parts[3] || 'all';
        } else if (parts[1] === 'n') {
            type = parts[2] || 'rolls';
            page = parseInt(parts[3], 10) || 0;
            period = parts[4] || 'all';
        } else {
            type = parts[1] || 'rolls';
            page = parseInt(parts[2], 10) || 0;
            period = parts[3] || 'all';
        }
        const lbCmd = client.commands.get('leaderboard');
        await lbCmd.renderLeaderboard(interaction, userDb, type, page, period);
    }
    else if (customId.startsWith('ach_')) {
        const achCmd = client.commands.get('achieve');
        await achCmd.renderAchieve(interaction, userDb, parseInt(customId.split('_')[2], 10));
    }
    else if (customId.startsWith('q_claim_')) {
        const result = await claimQuest(userDb, parseInt(customId.split('_')[2], 10));
        await interaction.followUp({ content: result, flags: MessageFlags.Ephemeral });
        const qCmd = client.commands.get('quest');
        await qCmd.renderQuest(interaction, userDb);
    }
    else if (customId.startsWith('q_reroll_')) {
        const result = await rerollQuest(userDb, parseInt(customId.split('_')[2], 10));
        await interaction.followUp({ content: result, flags: MessageFlags.Ephemeral });
        const qCmd = client.commands.get('quest');
        await qCmd.renderQuest(interaction, userDb);
    }
    else if (customId.startsWith('q_buy_')) {
        const shopIdx = parseInt(customId.split('_')[2], 10);
        let cost = 1; let reward = null; let limitKey = null; let limitMax = 0;

        if (shopIdx === 1) { cost = 2; reward = { item: 'pot_crystal_maker', qty: 1 }; limitKey = 'q_cmaker'; limitMax = 2; }
        else if (shopIdx === 2) { cost = 1; reward = { item: 'pot_luck', qty: 5 }; }
        else if (shopIdx === 3) { cost = 1; reward = { item: 'pot_speed', qty: 3 }; }
        else if (shopIdx === 4) { cost = 1; reward = { coins: 400n }; }
        else if (shopIdx === 5) {
            if (userDb.total_rolls <= 10000) return interaction.followUp({ content: '❌ Requires >10,000 rolls.', flags: MessageFlags.Ephemeral });
            cost = 3; reward = { crystals: 1n }; limitKey = 'q_crys'; limitMax = 1;
        }
        else if (shopIdx === 6) { cost = 2; reward = { item: 'pot_fortune_3', qty: 1 }; limitKey = 'q_f3'; limitMax = 2; }
        else if (shopIdx === 7) { cost = 2; reward = { item: 'pot_windy_2', qty: 2 }; limitKey = 'q_w2'; limitMax = 2; }
        else if (shopIdx === 8) {
            if (userDb.total_rolls <= 5000) return interaction.followUp({ content: '❌ Requires >5,000 rolls.', flags: MessageFlags.Ephemeral });
            cost = 5; reward = { item: 'pot_pop', qty: 1 }; limitKey = 'q_pop'; limitMax = 1;
        }
        else if (shopIdx === 9) {
            if (userDb.total_rolls <= 25000) return interaction.followUp({ content: '❌ Requires >25,000 rolls.', flags: MessageFlags.Ephemeral });
            const currentWeek = Math.floor(Date.now() / (7 * 86400000));
            if (userDb.quest_cc_week === currentWeek) return interaction.followUp({ content: '❌ Weekly limit reached (1 CC per week).', flags: MessageFlags.Ephemeral });
            cost = 15; reward = { cc: 1 };
        }

        if (!reward) return;
        if (userDb.quest_tokens < cost) return interaction.followUp({ content: '❌ Not enough Quest Tokens.', flags: MessageFlags.Ephemeral });

        let qData = JSON.parse(userDb.quest_data || '{}');
        if (limitKey) {
            if ((qData[limitKey] || 0) >= limitMax) return interaction.followUp({ content: '❌ Daily limit reached.', flags: MessageFlags.Ephemeral });
            qData[limitKey] = (qData[limitKey] || 0) + 1;
        }

        userDb.quest_tokens -= cost;
        let achMsgs = [];
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
            userDb.cc_coins = (parseInt(userDb.cc_coins, 10) || 0) + reward.cc;
            userDb.quest_cc_week = Math.floor(Date.now() / (7 * 86400000));
        }
        if (reward.item) {
            await giveItem(userDb.id, reward.item, reward.qty);
        }

        userDb.quest_data = JSON.stringify(qData);
        await saveUser(userDb);
        await interaction.followUp({ content: `✅ Purchase successful!${achMsgs.length ? '\n' + achMsgs.join('\n') : ''}`, flags: MessageFlags.Ephemeral });
        const qCmd = client.commands.get('quest');
        await qCmd.renderQuest(interaction, userDb);
    }
}

module.exports = { handleButton };

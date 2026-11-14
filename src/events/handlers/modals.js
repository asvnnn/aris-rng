const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { pool, saveUser } = require('../../database/userModel');
const { doPurchase, doUse } = require('../../systems/economySystem');
const { FrameManager, createVerification } = require('../../utils/discord');
const { POTIONS, MODULES, CHIPS } = require('../../data/items');

async function handleModalSubmit(interaction, userDb, client) {
    if (interaction.customId.startsWith('modal_buy_')) {
        const qty = interaction.fields.getTextInputValue('qty').trim();
        const parts = interaction.customId.split('_');
        const isBShop = parts.pop() === 'true';
        const sId = parts.slice(2).join('_');

        const itemObj = sId === 'item_cc'
            ? { name: 'Compressed Crystal (CC)', craft: false }
            : (POTIONS[sId] || MODULES[sId] || CHIPS[sId] || { name: sId });
        const token = createVerification(interaction.user.id, {
            source: 'shop',
            sId,
            qty,
            isBShop
        });
        const confirmEmbed = new EmbedBuilder()
            .setTitle(`🛒 Confirm ${itemObj.craft ? 'Crafting' : 'Purchase'}`)
            .setColor(0xF1C40F)
            .setDescription(
                `Are you sure you want to ${itemObj.craft ? 'craft' : 'buy'} **${qty.toLowerCase() === 'max' ? 'MAX' : `${qty}x`} ${itemObj.name}**${isBShop ? ' from the **Black Market**' : ''}?\n\n` +
                `⏱️ *Please click Confirm within 60 seconds to complete this transaction.*`
            );
        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`verify_confirm_${token}`).setLabel('✅ Confirm').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`verify_cancel_${token}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger)
        );
        await FrameManager.sendFrame(interaction, { embeds: [confirmEmbed], components: [confirmRow] }, interaction.user.id);
    }
    else if (interaction.customId.startsWith('modal_use_')) {
        const qty = interaction.fields.getTextInputValue('qty');
        const sId = interaction.customId.replace('modal_use_', '');
        const result = await doUse(userDb, sId, qty);
        await interaction.followUp({ content: result, flags: MessageFlags.Ephemeral });

        const [checkItem] = await pool.execute('SELECT quantity FROM items WHERE user_id=? AND item_id=?', [userDb.id, sId]);
        const nextSelectId = (checkItem.length > 0 && checkItem[0].quantity > 0) ? sId : null;

        const invCmd = client.commands.get('inv');
        await invCmd.renderInv(interaction, userDb, nextSelectId);
    }
    else if (interaction.customId.startsWith('modal_as_')) {
        const rawVal = interaction.fields.getTextInputValue('val').trim();
        const cleanVal = rawVal.replace(/^[+-]/, '').trim();
        if (!/^\d+$/.test(cleanVal)) return interaction.followUp({ content: '❌ Giá trị không hợp lệ. Vui lòng nhập số nguyên (ví dụ: 1000 hoặc 5000).', flags: MessageFlags.Ephemeral });

        if (interaction.customId === 'modal_as_pos') userDb.auto_sell_threshold = cleanVal;
        else userDb.auto_sell_threshold_neg = cleanVal;

        await saveUser(userDb);
        const isPos = interaction.customId === 'modal_as_pos';
        const msg = isPos
            ? `✅ Đã cập nhật Auto-Sell (+): Tự bán các số dương ≤ **${BigInt(cleanVal).toLocaleString('en-US')}**!`
            : `✅ Đã cập nhật Auto-Sell (-): Tự bán các số âm từ **-1** đến **-${BigInt(cleanVal).toLocaleString('en-US')}** (Độ hiếm ≤ ${BigInt(cleanVal).toLocaleString('en-US')})!`;
        await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
        const setCmd = client.commands.get('setting');
        await setCmd.renderSetting(interaction, userDb);
    }
    else if (interaction.customId === 'modal_color') {
        const hex = interaction.fields.getTextInputValue('hex').trim();
        if (!/^#[0-9A-Fa-f]{6}$/i.test(hex)) return interaction.followUp({ content: '❌ Invalid Hex Code. Example: #FF0000', flags: MessageFlags.Ephemeral });

        userDb.custom_color = hex;
        await saveUser(userDb);
        await interaction.followUp({ content: `✅ Custom color updated to **${hex}**!`, flags: MessageFlags.Ephemeral });
        const setCmd = client.commands.get('setting');
        await setCmd.renderSetting(interaction, userDb);
    }
}

module.exports = { handleModalSubmit };

const { MessageFlags } = require('discord.js');
const { saveUser } = require('../../database/userModel');
const { grantAchievement } = require('../../systems/achievementSystem');
const ACHIEVEMENTS = require('../../data/achievements');
const TITLES = require('../../data/titles');

async function handleSelectMenu(interaction, userDb, client, frameAgeBeforeAction) {
    const customId = interaction.customId;

    if (customId.startsWith('sel_pot') || customId.startsWith('sel_mod') || customId.startsWith('sel_chip')) {
        if (frameAgeBeforeAction >= 290000 && frameAgeBeforeAction <= 300000) {
            const pmMsg = await grantAchievement(userDb, 'patience_master');
            await saveUser(userDb);
            if (pmMsg) await interaction.followUp({ content: pmMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        const sId = interaction.values[0].replace('s_', '');
        const isBShop = interaction.message.embeds[0]?.data?.title?.includes('Black Market') || false;
        const shopCmd = client.commands.get('shop');
        await shopCmd.renderShop(interaction, userDb, isBShop, sId);
    }
    else if (customId.startsWith('sel_inv_') || customId === 'sel_rls') {
        if (frameAgeBeforeAction >= 290000 && frameAgeBeforeAction <= 300000) {
            const pmMsg = await grantAchievement(userDb, 'patience_master');
            await saveUser(userDb);
            if (pmMsg) await interaction.followUp({ content: pmMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        const sId = interaction.values[0];
        const invCmd = client.commands.get('inv');
        await invCmd.renderInv(interaction, userDb, sId);
    }
    else if (customId.startsWith('sel_achieve')) {
        const aId = interaction.values[0];
        userDb.equipped_achieve = aId;
        await saveUser(userDb);
        const achDisplay = ACHIEVEMENTS[aId]?.name || aId;
        await interaction.followUp({ content: `✅ Equipped Achievement: **${achDisplay}**`, flags: MessageFlags.Ephemeral });
        const achCmd = client.commands.get('achieve');
        await achCmd.renderAchieve(interaction, userDb, 0);
    }
    else if (customId.startsWith('sel_title')) {
        const tId = interaction.values[0];
        userDb.equipped_title = tId;
        await saveUser(userDb);
        const rawTitle = TITLES[tId]?.name || tId.replace('custom_', '');
        const formattedTitle = (rawTitle.startsWith('『') && rawTitle.endsWith('』')) ? rawTitle : `[${rawTitle}]`;
        await interaction.followUp({
            content: `✅ Equipped Title: **${formattedTitle}**`,
            flags: MessageFlags.Ephemeral
        });
        const titleCmd = client.commands.get('title');
        await titleCmd.renderTitle(interaction, userDb);
    }
}

module.exports = { handleSelectMenu };

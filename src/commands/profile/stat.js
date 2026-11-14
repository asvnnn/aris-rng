const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { pool, getUser, saveUser } = require('../../database/userModel');
const { grantAchievement } = require('../../systems/achievementSystem');
const ACHIEVEMENTS = require('../../data/achievements');
const TITLES = require('../../data/titles');
const { MODULES, CHIPS } = require('../../data/items');
const { DEV_IDS, ANSI } = require('../../config/constants');
const { FrameManager, autoDelete } = require('../../utils/discord');
const { formatBigIntSafe } = require('../../utils/math');

function formatBigInt(bi) { return formatBigIntSafe(bi); }

module.exports = {
    name: 'stat',
    description: 'View player profile',
    data: new SlashCommandBuilder()
        .setName('stat')
        .setDescription('View your profile or another player\'s profile')
        .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(false)),

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        const targetUser = interaction.options.getUser('user') || interaction.user;
        await this.renderStat(interaction, userDb, targetUser.id, targetUser, false);
    },

    async executePrefix(message, args, userDb, client) {
        let targetId = message.author.id;
        let targetUserObj = message.author;
        let isSearchByUsername = false;

        if (message.mentions.users.size > 0) {
            targetUserObj = message.mentions.users.first();
            targetId = targetUserObj.id;
        } else if (args[0]) {
            let searchArg = args[0].replace(/[<@!>]/g, '');
            try {
                targetUserObj = await client.users.fetch(searchArg);
                targetId = targetUserObj.id;
            } catch (e) {
                const [rows] = await pool.execute('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [searchArg]);
                if (rows.length > 0) {
                    targetId = rows[0].id;
                    isSearchByUsername = true;
                } else {
                    let m = await message.channel.send("❌ User not found.");
                    autoDelete(m, 10000);
                    return;
                }
            }
        }
        await this.renderStat(message, userDb, targetId, targetUserObj, isSearchByUsername);
    },

    async renderStat(ctx, authorDb, targetId, targetUserObj, isSearchByUsername = false) {
        const aId = authorDb.id;
        let u = (targetId === aId && authorDb.coins !== undefined) ? authorDb : await getUser(targetId);

        if (targetId !== aId && u.stat_privacy === 1 && !DEV_IDS.includes(aId)) {
            authorDb.stalker_counter = (parseInt(authorDb.stalker_counter, 10) || 0) + 1;
            let aM = "";
            if (authorDb.stalker_counter >= 10) {
                let a = await grantAchievement(authorDb, 'stalker');
                if (a) aM = "\n" + a;
            }
            await saveUser(authorDb);
            const msgContent = `🔒 This player's profile is set to Private.${aM}`;
            let m;
            if (typeof ctx.editReply === 'function' && (ctx.deferred || ctx.replied)) {
                m = await ctx.editReply({ content: msgContent });
            } else if (ctx.channel) {
                m = await ctx.channel.send(msgContent);
            }
            autoDelete(m, 30000);
            return;
        } else if (targetId !== aId) {
            authorDb.stalker_counter = 0;
            await saveUser(authorDb);
        }

        let avatarUrl = isSearchByUsername || !targetUserObj
            ? 'https://cdn.discordapp.com/embed/avatars/0.png'
            : targetUserObj.displayAvatarURL();

        let titleDisplay = 'No title equipped';
        let titleColorHex = null;
        if (u.equipped_title) {
            if (u.equipped_title.startsWith('custom_')) {
                let tName = u.equipped_title.replace('custom_', '');
                let cTitles = {};
                try { cTitles = JSON.parse(u.custom_titles || '{}'); } catch (e) {}
                titleColorHex = cTitles[tName] || null;
                titleDisplay = `**[${tName}]** *(Custom${titleColorHex ? ` ${titleColorHex}` : ''})*`;
            } else {
                const tObj = TITLES[u.equipped_title];
                const rawName = tObj ? tObj.name : u.equipped_title;
                if (rawName.startsWith('『') && rawName.endsWith('』')) {
                    titleDisplay = `**${rawName}**`;
                } else {
                    titleDisplay = `**[${rawName}]**`;
                }
            }
        }

        let embedColor = 0x3498DB;
        if (u.custom_color && /^#[0-9A-Fa-f]{6}$/.test(u.custom_color)) {
            embedColor = parseInt(u.custom_color.replace('#', ''), 16);
        } else if (titleColorHex && /^#[0-9A-Fa-f]{6}$/.test(titleColorHex)) {
            embedColor = parseInt(titleColorHex.replace('#', ''), 16);
        }

        const bestPos = u.highest_pos && u.highest_pos !== '0' ? `1 in ${formatBigInt(u.highest_pos)}` : 'None';
        const bestNeg = u.lowest_neg && u.lowest_neg !== '0' ? `1 in ${formatBigInt(u.lowest_neg)}` : 'None';
        const hideEquip = (u.hide_equip || 0) === 1 && !DEV_IDS.includes(aId) && targetId !== aId;
        const modName = hideEquip
            ? '🔒 Hidden'
            : (u.equipped_module ? (MODULES[u.equipped_module]?.name || u.equipped_module) : 'None');
        const chipName = hideEquip
            ? '🔒 Hidden'
            : (u.equipped_chip ? (CHIPS[u.equipped_chip]?.name || u.equipped_chip) : 'None');

        const e = new EmbedBuilder()
            .setTitle(`📊 ${u.username}'s Profile`)
            .setColor(embedColor)
            .setThumbnail(avatarUrl)
            .addFields(
                { name: 'Title', value: titleDisplay, inline: true },
                { name: 'Achievement', value: u.equipped_achieve ? `**${ACHIEVEMENTS[u.equipped_achieve]?.name || u.equipped_achieve}**` : 'None', inline: true },
                { name: '⚙️ Equipped Items', value: hideEquip ? '🔒 *Hidden by Player*' : `Mod: **${modName}**\nChip: **${chipName}**`, inline: true },
                { name: '🪙 Coins', value: formatBigInt(u.coins), inline: true },
                { name: '💎 Crystals', value: formatBigInt(u.crystals), inline: true },
                { name: '⬛ NULLs', value: formatBigInt(u.nulls), inline: true },
                { name: '💠 CC', value: formatBigInt(u.cc_coins), inline: true },
                { name: '🎲 Total Rolls', value: formatBigInt(u.total_rolls || 0), inline: true },
                { name: '📦 Total Score', value: formatBigInt(u.total_score), inline: true },
                { name: '📈 Best Positive (+)', value: bestPos, inline: true },
                { name: '📉 Best Negative (-)', value: bestNeg, inline: true },
                { name: '🏆 Absolute Best Roll', value: `1 in ${formatBigInt(u.best_roll)}`, inline: true }
            );

        await FrameManager.sendFrame(ctx, { embeds: [e], components: [] }, aId);
    }
};

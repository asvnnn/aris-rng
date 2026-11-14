const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getUser } = require('../../database/userModel');
const { FrameManager } = require('../../utils/discord');
const { formatBigIntSafe } = require('../../utils/math');

function formatBigInt(bi) { return formatBigIntSafe(bi); }

module.exports = {
    name: 'setting',
    aliases: ['settings'],
    description: 'Privacy, Auto-Sell, Colors & Notifications',
    data: new SlashCommandBuilder()
        .setName('setting')
        .setDescription('Configure Privacy, Auto-Sell, Custom Colors, and Notifications'),

    async executePrefix(message, args, userDb) {
        await this.renderSetting(message, userDb);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        await this.renderSetting(interaction, userDb);
    },

    async renderSetting(ctx, userDb) {
        const uId = userDb.id;

        const genUI = async () => {
            let u = userDb || await getUser(uId);
            const isDm = !ctx.guild;
            const hasColorAccess = isDm || u.is_colorful === 1;

            let embedColor = 0x2C3E50;
            if (u.custom_color && /^#[0-9A-Fa-f]{6}$/.test(u.custom_color)) {
                embedColor = parseInt(u.custom_color.replace('#', ''), 16);
            }

            const colorStatus = hasColorAccess
                ? `${u.custom_color || 'Default'} (${u.is_colorful ? 'Permanent' : 'Free in DM'})`
                : '🔒 Locked (Use >setting in DM for free)';

            const e = new EmbedBuilder()
                .setTitle('⚙️ Player Settings')
                .setColor(embedColor)
                .addFields(
                    { name: 'Auto-Sell (+)', value: `**≤ ${formatBigInt(u.auto_sell_threshold)}**`, inline: true },
                    { name: 'Auto-Sell (-)', value: `**từ -1 đến -${formatBigInt(u.auto_sell_threshold_neg)}** (Độ hiếm ≤ ${formatBigInt(u.auto_sell_threshold_neg)})`, inline: true },
                    { name: 'Stat Privacy', value: u.stat_privacy === 1 ? '🔒 Private (Anon on LB)' : '🔓 Public', inline: false },
                    { name: 'Luck Buffs', value: u.luck_toggle === 1 ? '🟢 ON' : '🔴 OFF', inline: true },
                    { name: 'BShop Ping', value: u.bshop_ping === 1 ? '🔔 ON' : '🔕 OFF', inline: true },
                    { name: 'Equipped Items on Profile', value: (u.hide_equip || 0) === 0 ? '👁️ Visible' : '🙈 Hidden', inline: true },
                    { name: 'Custom Color', value: colorStatus, inline: false }
                );

            const r1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('set_p').setLabel('Toggle Privacy').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('set_l').setLabel('Toggle Luck').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('set_bshop').setLabel('Toggle BShop Ping').setStyle(ButtonStyle.Primary)
            );
            const r2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('set_as_pos').setLabel('Set Auto-Sell (+)').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('set_as_neg').setLabel('Set Auto-Sell (-)').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('set_equip').setLabel('Toggle Equip Display').setStyle(ButtonStyle.Secondary)
            );
            const r3 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('set_color').setLabel('Change Custom Color').setStyle(ButtonStyle.Success)
            );
            return { embeds: [e], components: [r1, r2, r3] };
        };

        const ui = await genUI();
        await FrameManager.sendFrame(ctx, ui, uId);
    }
};

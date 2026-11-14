const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getLeaderboardCache, updateLeaderboard } = require('../../systems/leaderboardSystem');
const { FrameManager } = require('../../utils/discord');
const { formatBigIntSafe } = require('../../utils/math');

function formatBigInt(bi) { 
    return formatBigIntSafe(bi); 
}

module.exports = {
    name: 'leaderboard',
    aliases: ['l', 'lb'],
    description: 'View global rankings',
    
    async executePrefix(message, args, userDb) {
        await this.renderLeaderboard(message, userDb, 'rolls', 0);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        await this.renderLeaderboard(interaction, userDb, 'rolls', 0);
    },

    async renderLeaderboard(ctx, userDb, type = 'rolls', page = 0, period = 'all') {
        let cache = getLeaderboardCache();
        if (cache.lastUpdate === 0) {
            await updateLeaderboard();
            cache = getLeaderboardCache();
        }

        const bucket = (period === 'weekly' && cache.weekly)
            ? cache.weekly
            : (period === 'monthly' && cache.monthly)
                ? cache.monthly
                : cache;

        let data = [];
        let title = '';

        if (type === 'rolls') { data = bucket.rolls || []; title = '🎲 Top Rolls'; }
        else if (type === 'score') { data = bucket.score || []; title = '📦 Top Score'; }
        else if (type === 'pos') { data = bucket.pos || []; title = '📈 Highest Positive Roll'; }
        else if (type === 'neg') { data = bucket.neg || []; title = '📉 Lowest Negative Roll'; }

        const periodLabel = period === 'weekly' ? 'Weekly' : period === 'monthly' ? 'Monthly' : 'All-Time';

        const totalPages = Math.max(1, Math.ceil(data.length / 10));
        if (page >= totalPages) page = totalPages - 1;
        if (page < 0) page = 0;

        let desc = data.slice(page * 10, (page + 1) * 10).map((u, i) => {
            let val = '';
            if (type === 'rolls') val = `${formatBigInt(u.total_rolls)} rolls`;
            else if (type === 'score') val = `${formatBigInt(u.total_score)} score`;
            else if (type === 'pos') val = `1 in ${formatBigInt(u.highest_pos)}`;
            else if (type === 'neg') val = `1 in ${formatBigInt(u.lowest_neg)}`;

            let displayName = (u.stat_privacy === 1) ? `Player_${u.id.substring(0, 4)}` : u.username;

            return `**${page * 10 + i + 1}.** ${displayName} - ${val}`;
        }).join('\n');

        if (!desc) desc = '*No data yet. Check back in a few minutes!*';

        let embedColor = 0xFFD700;
        if (userDb.custom_color && /^#[0-9A-Fa-f]{6}$/.test(userDb.custom_color)) {
            embedColor = parseInt(userDb.custom_color.replace('#', ''), 16);
        }

        const e = new EmbedBuilder()
            .setTitle(`🏆 Leaderboard (${periodLabel}) | ${title}`)
            .setColor(embedColor)
            .setDescription(desc)
            .setFooter({ text: `Page ${page + 1}/${totalPages} | ${periodLabel} | Updates every 5 mins` });

        const r1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`lb_t_rolls_${period}`).setLabel('Rolls').setStyle(type === 'rolls' ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`lb_t_score_${period}`).setLabel('Score').setStyle(type === 'score' ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`lb_t_pos_${period}`).setLabel('Highest (+)').setStyle(type === 'pos' ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`lb_t_neg_${period}`).setLabel('Lowest (-)').setStyle(type === 'neg' ? ButtonStyle.Success : ButtonStyle.Secondary)
        );

        const r2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`lb_p_${type}_all`).setLabel('🌍 All-Time').setStyle(period === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`lb_p_${type}_monthly`).setLabel('📅 Monthly').setStyle(period === 'monthly' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`lb_p_${type}_weekly`).setLabel('📆 Weekly').setStyle(period === 'weekly' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`lb_n_${type}_${page - 1}_${period}`).setLabel('◀').setStyle(ButtonStyle.Primary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId(`lb_n_${type}_${page + 1}_${period}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages - 1)
        );

        await FrameManager.sendFrame(ctx, { embeds: [e], components: [r1, r2] }, userDb.id);
    }
};

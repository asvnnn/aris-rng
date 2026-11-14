const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { pool, getUser } = require('../../database/userModel');
const { calcStats } = require('../../utils/math');
const { MODULES, CHIPS } = require('../../data/items');
const { ANSI } = require('../../config/constants');
const { FrameManager } = require('../../utils/discord');

module.exports = {
    name: 'status',
    aliases: ['s'],
    description: 'View Luck stats',
    data: new SlashCommandBuilder()
        .setName('status')
        .setDescription('View your detailed Luck multipliers and active module stacks'),

    async executePrefix(message, args, userDb) {
        await this.renderStatus(message, userDb);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        await this.renderStatus(interaction, userDb);
    },

    async renderStatus(ctx, userDb) {
        const uId = userDb.id;
        const u = userDb || await getUser(uId);
        const [ap] = await pool.execute('SELECT * FROM active_potions WHERE user_id = ?', [uId]);
        let st = calcStats(u, ap);
        let md = `Module: **${u.equipped_module ? (MODULES[u.equipped_module]?.name || u.equipped_module) : 'None'}**\nChip: **${u.equipped_chip ? (CHIPS[u.equipped_chip]?.name || u.equipped_chip) : 'None'}**\n`;

        if (u.equipped_module === 'mod_glitch') md += `• Glitch Stack: ${u.glitch_counter || 0}/10\n`;
        if (u.equipped_chip === 'chip_error') md += `• Error Chip Stack: ${u.error_chip_counter || 0}/10\n`;

        const finalMultDisplay = ((1.0 + st.final) * (st.final_multiplier || 1)).toFixed(2);
        const ac =
            `\`\`\`ansi\n` +
            `${ANSI.GREEN}Basic Luck: +${st.basic.toFixed(2)} (+1 Base)${ANSI.RESET}\n` +
            `${ANSI.BLUE}Multi Luck: x${st.multi.toFixed(2)}${ANSI.RESET}\n` +
            `${ANSI.PINK}Special Luck: ${st.special >= 0 ? '+' : ''}${st.special}${ANSI.RESET}\n` +
            `${ANSI.YELLOW}FINAL LUCK: x${finalMultDisplay}${ANSI.RESET}\n` +
            `----------------------------------\n` +
            `${ANSI.YELLOW}TOTAL LUCK: ${st.end ? 'ERR_OVERFLOW' : st.finalLuck.toFixed(2)}${ANSI.RESET}\n` +
            `\`\`\``;

        let embedColor = 0x3498DB;
        if (u.custom_color && /^#[0-9A-Fa-f]{6}$/.test(u.custom_color)) {
            embedColor = parseInt(u.custom_color.replace('#', ''), 16);
        }

        const e = new EmbedBuilder()
            .setTitle('📈 Luck Status & Modifiers')
            .setColor(embedColor)
            .addFields(
                { name: 'Luck Breakdown', value: ac, inline: false },
                { name: 'Roll Cooldown', value: `**${st.finalCd.toFixed(2)}s**`, inline: true },
                { name: 'Luck Buffs Toggle', value: u.luck_toggle === 1 ? '🟢 Active' : '🔴 Disabled (1.0x)', inline: true },
                { name: 'Equipment & Counters', value: md, inline: false }
            );

        await FrameManager.sendFrame(ctx, { embeds: [e], components: [] }, uId);
    }
};

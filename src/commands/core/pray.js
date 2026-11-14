const { SlashCommandBuilder } = require('discord.js');
const { saveUser } = require('../../database/userModel');
const { grantAchievement } = require('../../systems/achievementSystem');
const { updateQuestProgress } = require('../../systems/questSystem');
const { autoDelete, sendCooldownMsg } = require('../../utils/discord');

module.exports = {
    name: 'pray',
    description: '+0.01 Perm Luck (6h cd)',
    data: new SlashCommandBuilder()
        .setName('pray')
        .setDescription('Pray for +0.01 Permanent Basic Luck (6h cooldown)'),

    async executePrefix(message, args, userDb) {
        await this.handlePray(message, userDb);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        await this.handlePray(interaction, userDb);
    },

    async handlePray(ctx, userDb) {
        let u = userDb;
        const CD = 6 * 3600 * 1000;
        const now = Date.now();
        const nextReadyMs = Number(u.last_pray) + CD;

        if (now < nextReadyMs) {
            u.pray_cd_attempts = (parseInt(u.pray_cd_attempts, 10) || 0) + 1;
            await saveUser(u);
            if (u.pray_cd_attempts >= 10) await grantAchievement(u, 'persistent');

            await sendCooldownMsg(ctx, nextReadyMs, "You can pray again");
            return;
        }

        u.last_pray = now;
        u.pray_count = (parseInt(u.pray_count, 10) || 0) + 1;
        u.permanent_basic_luck = Math.round((parseFloat(u.permanent_basic_luck || 0) + 0.01) * 100) / 100;
        u.pray_cd_attempts = 0;

        let aM = "";
        if (u.pray_count >= 20) { let a = await grantAchievement(u, 'p2w'); if (a) aM += `\n${a}`; }
        if (u.pray_count >= 200) { let a = await grantAchievement(u, 'make_a_wish'); if (a) aM += `\n${a}`; }

        await saveUser(u);
        await updateQuestProgress(u.id, 'pray', 1);

        const nextUnix = Math.floor((now + CD) / 1000);
        let successMsg = `🙏 You prayed and gained **+0.01 Permanent Basic Luck**! (Total: **+${u.permanent_basic_luck.toFixed(2)}**)\n⏱️ Next pray available <t:${nextUnix}:R>.${aM}`;

        let m;
        if (ctx.channel) {
            m = await ctx.channel.send(successMsg);
        } else if (typeof ctx.followUp === 'function') {
            m = await ctx.followUp({ content: successMsg });
        } else if (typeof ctx.reply === 'function') {
            m = await ctx.reply({ content: successMsg, fetchReply: true });
        }

        autoDelete(m, 30000);
    }
};

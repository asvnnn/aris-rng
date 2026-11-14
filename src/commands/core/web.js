const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { PORT } = require('../../config/constants');
const { createAuthOtp } = require('../../web/sessionLock');
const { saveUser } = require('../../database/userModel');

module.exports = {
    name: 'web',
    aliases: ['login', 'os'],
    description: 'Generate a 1-Click Magic Sign-In Link & 6-Digit OTP for A.R.I.S Web OS',
    data: new SlashCommandBuilder()
        .setName('web')
        .setDescription('Generate a 1-Click Magic Sign-In Link & 6-Digit OTP for A.R.I.S Web OS'),

    async executePrefix(message, args, userDb) {
        await this.handleWebLogin(message, userDb, false);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply({ ephemeral: true });
        await this.handleWebLogin(interaction, userDb, true);
    },

    async handleWebLogin(ctx, userDb, isSlash) {
        const userObj = isSlash ? ctx.user : ctx.author;
        const dName = userObj.username;
        if (dName && userDb.username !== dName) {
            userDb.username = dName;
            await saveUser(userDb);
        }

        const otpRecord = createAuthOtp(userObj.id, dName);
        const baseUrl = process.env.PUBLIC_WEB_URL || global.LAST_KNOWN_WEB_ORIGIN || `http://localhost:${PORT}`;
        const magicUrl = `${baseUrl.replace(/\/$/, '')}/?magic_token=${otpRecord.magicToken}`;

        const dmEmbed = new EmbedBuilder()
            .setTitle('🖥️ A.R.I.S Web OS — 1-Click Instant Sign-In')
            .setColor(0x0078D7)
            .setDescription(
                `Click the link below to sign in to **A.R.I.S Web OS** instantly:\n\n` +
                `🔗 **[Click Here for 1-Click Instant Sign-In](${magicUrl})**\n` +
                `*(Or copy: \`${magicUrl}\`)*\n\n` +
                `⏳ *Valid for 5 minutes (single-use).*`
            )
            .setFooter({ text: 'Never share this link with anyone else.' });

        if (isSlash) {
            return ctx.editReply({ embeds: [dmEmbed] });
        }

        if (!ctx.guild) {
            return ctx.channel.send({ embeds: [dmEmbed] });
        }

        try {
            await userObj.send({ embeds: [dmEmbed] });
            const notice = await ctx.channel.send(`🔐 <@${userObj.id}> Sent your **A.R.I.S Web OS** 1-Click Magic Sign-In link to your DMs!`);
            setTimeout(() => notice.delete().catch(() => {}), 15000);
        } catch (err) {
            const warn = await ctx.channel.send(`⚠️ <@${userObj.id}> Could not send you a DM! Please enable Direct Messages from server members or run \`>web\` directly in a DM with me.`);
            setTimeout(() => warn.delete().catch(() => {}), 15000);
        }
    }
};

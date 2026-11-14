const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getUser, saveUser } = require('../../database/userModel');
const { generateQuests, getQuestGoal } = require('../../systems/questSystem');
const QUESTS = require('../../data/quests');
const { FrameManager } = require('../../utils/discord');

module.exports = {
    name: 'quest',
    aliases: ['q'],
    description: 'Daily quests and Token Shop',
    data: new SlashCommandBuilder()
        .setName('quest')
        .setDescription('View Daily Quests and the Quest Token Shop'),

    async executePrefix(message, args, userDb) {
        await this.renderQuest(message, userDb);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        await this.renderQuest(interaction, userDb);
    },

    async renderQuest(ctx, userDb) {
        let u = userDb || await getUser(userDb.id);
        let qData = JSON.parse(u.quest_data || '{}');

        let needsRegen = false;
        if (!qData.quests || !Array.isArray(qData.quests) || qData.quests.length < 3) {
            needsRegen = true;
        } else {
            for (let q of qData.quests) {
                if (!QUESTS.find(x => x.id === q.id)) needsRegen = true;
            }
        }

        const now = Date.now();

        if (needsRegen) {
            qData.quests = generateQuests(u);
            qData.rerolls = 1;
            qData.token_reroll_used = false;
            u.quest_data = JSON.stringify(qData);
            await saveUser(u);
        }

        const nextResetUnix = (Math.floor(now / 86400000) + 1) * 86400;
        const rerollInfo = `Free Rerolls: **${qData.rerolls || 0}** | Token Reroll: **${qData.token_reroll_used ? 'Used' : 'Available (Cost: 3 Tokens)'}**`;

        let embedColor = 0x3498DB;
        if (u.custom_color && /^#[0-9A-Fa-f]{6}$/.test(u.custom_color)) {
            embedColor = parseInt(u.custom_color.replace('#', ''), 16);
        }

        const e = new EmbedBuilder()
            .setTitle('📜 Daily Quests & Token Shop')
            .setColor(embedColor)
            .setDescription(`You have **🎫 ${u.quest_tokens || 0} Quest Tokens**.\n⏱️ Quests reset <t:${nextResetUnix}:R>.\n${rerollInfo}`);

        let qText = qData.quests.map((q, idx) => {
            let qTemplate = QUESTS.find(x => x.id === q.id);
            const goal = getQuestGoal(qTemplate);
            let status = q.claimed ? '✅ Claimed' : `(${q.progress}/${goal})`;
            return `**Q${idx + 1}. ${qTemplate.desc}**\nStatus: ${status}`;
        }).join('\n\n');

        e.addFields(
            { name: 'Your Quests', value: qText },
            { name: '🛒 Token Shop', value: 
                `1️⃣ Crystal Maker (2 Tokens) [Limit: 2/d]\n` +
                `2️⃣ 5x Luck Potion (1 Token)\n` +
                `3️⃣ 3x Speed Potion (1 Token)\n` +
                `4️⃣ 400 Coins (1 Token)\n` +
                `5️⃣ 1x Crystal (3 Tokens) [Limit: 1/d, Req: >10k rolls]\n` +
                `6️⃣ 1x Fortune III (2 Tokens) [Limit: 2/d]\n` +
                `7️⃣ 2x Windy II (2 Tokens) [Limit: 2/d]\n` +
                `8️⃣ 1x Pop Potion (5 Tokens) [Limit: 1/d, Req: >5k rolls]\n` +
                `9️⃣ 1x CC (15 Tokens) [Limit: 1/week, Req: >25k rolls]`
            }
        );

        const r1 = new ActionRowBuilder();
        const r2 = new ActionRowBuilder();

        qData.quests.forEach((q, idx) => {
            if (idx >= 3) return;
            let qTemplate = QUESTS.find(x => x.id === q.id);
            const goal = getQuestGoal(qTemplate);
            let isClaimDisabled = q.claimed || q.progress < goal;
            let isRerollDisabled = q.claimed || (qData.rerolls <= 0 && (qData.token_reroll_used || u.quest_tokens < 3));

            r1.addComponents(
                new ButtonBuilder().setCustomId(`q_claim_${idx}`).setLabel(`Claim Q${idx + 1}`).setStyle(ButtonStyle.Success).setDisabled(isClaimDisabled)
            );
            r2.addComponents(
                new ButtonBuilder().setCustomId(`q_reroll_${idx}`).setLabel(`🔄 Reroll Q${idx + 1}`).setStyle(ButtonStyle.Secondary).setDisabled(isRerollDisabled)
            );
        });

        const r3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('q_buy_1').setLabel('Buy 1️⃣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('q_buy_2').setLabel('Buy 2️⃣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('q_buy_3').setLabel('Buy 3️⃣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('q_buy_4').setLabel('Buy 4️⃣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('q_buy_5').setLabel('Buy 5️⃣').setStyle(ButtonStyle.Primary)
        );

        const r4 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('q_buy_6').setLabel('Buy 6️⃣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('q_buy_7').setLabel('Buy 7️⃣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('q_buy_8').setLabel('Buy 8️⃣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('q_buy_9').setLabel('Buy 9️⃣').setStyle(ButtonStyle.Primary)
        );

        await FrameManager.sendFrame(ctx, { embeds: [e], components: [r1, r2, r3, r4] }, u.id);
    }
};

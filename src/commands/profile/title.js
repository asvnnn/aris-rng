const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { getUser } = require('../../database/userModel');
const TITLES = require('../../data/titles');
const { FrameManager } = require('../../utils/discord');

module.exports = {
    name: 'title',
    aliases: ['titles'],
    description: 'View & equip titles',
    data: new SlashCommandBuilder()
        .setName('title')
        .setDescription('View and equip your unlocked titles'),

    async executePrefix(message, args, userDb) {
        await this.renderTitle(message, userDb);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        await this.renderTitle(interaction, userDb);
    },

    async renderTitle(ctx, userDb) {
        const uId = userDb.id;

        const genUI = async () => {
            let u = userDb || await getUser(uId);
            let unlocked = JSON.parse(u.unlocked_titles || '[]');
            let customTitles = JSON.parse(u.custom_titles || '{}');
            let lT = [];
            let o = [];

            for (const [k, t] of Object.entries(TITLES)) {
                const count = unlocked.filter(id => id === k).length;
                const h = count > 0;
                if (t.rarity === 0 && !h) continue;
                const tFormatted = (t.name.startsWith('『') && t.name.endsWith('』')) ? t.name : `[${t.name}]`;
                const countStr = count > 1 ? ` *(x${count})*` : '';
                lT.push(`${h ? '✅' : '❌'} **${tFormatted}**${countStr} ${t.rarity > 0 ? `(1 in ${t.rarity.toLocaleString('en-US')})` : '*(Special / Achievement)*'}`);
                if (h) o.push({ label: `Equip: ${tFormatted}${countStr}`.substring(0, 100), value: k });
            }

            for (const [tName, tHex] of Object.entries(customTitles)) {
                const k = `custom_${tName}`;
                const h = unlocked.includes(k);
                lT.push(`${h ? '✅' : '❌'} **[${tName}]** *(Custom ${tHex})*`);
                if (h) o.push({ label: `Equip: [${tName}] (Custom)`.substring(0, 100), value: k });
            }

            let titleDisplay = u.equipped_title || 'None';
            if (titleDisplay.startsWith('custom_')) titleDisplay = titleDisplay.replace('custom_', '');
            else if (TITLES[titleDisplay]) titleDisplay = TITLES[titleDisplay].name;

            let embedColor = 0x1ABC9C;
            if (u.custom_color && /^#[0-9A-Fa-f]{6}$/.test(u.custom_color)) {
                embedColor = parseInt(u.custom_color.replace('#', ''), 16);
            }

            const formattedFooterTitle = (titleDisplay.startsWith('『') && titleDisplay.endsWith('』')) ? titleDisplay : `[${titleDisplay}]`;
            const e = new EmbedBuilder()
                .setTitle(`🏷️ Titles`)
                .setColor(embedColor)
                .setDescription(lT.join('\n') || '*No titles unlocked yet.*')
                .setFooter({ text: `Equipped Title: ${formattedFooterTitle} | Total Titles Rolled: ${u.titles_rolled || 0}` });

            let c = [];
            for (let i = 0; i < o.length; i += 25) {
                if (c.length >= 4) break;
                c.push(new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`sel_title_${i}`)
                        .setPlaceholder(`Equip a Title ${o.length > 25 ? `(${Math.floor(i / 25) + 1})` : ''}...`)
                        .addOptions(o.slice(i, i + 25))
                ));
            }
            return { embeds: [e], components: c };
        };

        const ui = await genUI();
        await FrameManager.sendFrame(ctx, ui, uId);
    }
};

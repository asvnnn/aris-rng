const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getUser } = require('../../database/userModel');
const ACHIEVEMENTS = require('../../data/achievements');
const TITLES = require('../../data/titles');
const { FrameManager } = require('../../utils/discord');

module.exports = {
    name: 'achieve',
    aliases: ['achievement', 'achievements'],
    description: 'View and equip achievements',
    
    async executePrefix(message, args, userDb) {
        await this.renderAchieve(message, userDb);
    },

    async renderAchieve(ctx, userDb, page = 0) {
        const uId = userDb.id;
        let u = userDb || await getUser(uId);
        let unlocked = [];
        
        const { pool } = require('../../database/userModel');
        const [rows] = await pool.execute('SELECT achievement_id FROM achievements WHERE user_id = ?', [uId]);
        unlocked = rows.map(r => r.achievement_id);

        const achieveList = Object.entries(ACHIEVEMENTS);
        const totalPages = Math.max(1, Math.ceil(achieveList.length / 10));
        
        if (page < 0) page = 0;
        if (page >= totalPages) page = totalPages - 1;
        
        let desc = achieveList.slice(page * 10, (page + 1) * 10).map(([id, data]) => {
            const isUnlocked = unlocked.includes(id);
            
            let rewardStr = [];
            if (data.rewards) {
                if (data.rewards.coins) rewardStr.push(`${data.rewards.coins} Coins`);
                if (data.rewards.crystals) rewardStr.push(`${data.rewards.crystals} Crystals`);
                if (data.rewards.nulls) rewardStr.push(`${data.rewards.nulls} Nulls`);
                if (data.rewards.cc) rewardStr.push(`${data.rewards.cc} CC`);
                if (data.rewards.title) {
                    const tName = TITLES[data.rewards.title]?.name || data.rewards.title;
                    const formattedTitle = (tName.startsWith('『') && tName.endsWith('』')) ? tName : `[${tName}]`;
                    rewardStr.push(`${formattedTitle} Title`);
                }
                if (data.rewards.items) {
                    for (let [iId, qty] of Object.entries(data.rewards.items)) {
                        rewardStr.push(`${qty}x ${iId.replace('pot_', '').replace('mod_', '').replace('chip_', '')}`);
                    }
                }
            }
            let rText = rewardStr.length > 0 ? ` | Reward: ${rewardStr.join(', ')}` : '';

            if (data.secret && !isUnlocked) {
                return `🔒 **[???]**\n*Hidden Achievement*`;
            }
            
            const formattedAchName = (data.name.startsWith('『') && data.name.endsWith('』')) ? data.name : `[${data.name}]`;
            const reqText = data.req ? ` (${data.req})` : '';
            return `${isUnlocked ? '✅' : '❌'} **${formattedAchName}**${reqText}${rText}`;
        }).join('\n\n');

        let embedColor = 0xFFD700;
        if (u.custom_color && /^#[0-9A-Fa-f]{6}$/.test(u.custom_color)) embedColor = parseInt(u.custom_color.replace('#', ''), 16);

        const e = new EmbedBuilder()
            .setTitle('🏆 Achievements')
            .setColor(embedColor)
            .setDescription(desc || '*No achievements found.*')
            .setFooter({ text: `Page ${page + 1}/${totalPages} | Equipped: ${u.equipped_achieve ? ACHIEVEMENTS[u.equipped_achieve]?.name : 'None'}` });

        const r1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`ach_prev_${page - 1}`).setLabel('◀').setStyle(ButtonStyle.Primary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId(`ach_next_${page + 1}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages - 1)
        );

        const pageUnlockedIds = achieveList
            .slice(page * 10, (page + 1) * 10)
            .map(([id]) => id)
            .filter(id => unlocked.includes(id));
        const otherUnlockedIds = unlocked.filter(id => !pageUnlockedIds.includes(id));
        const orderedUnlocked = [...pageUnlockedIds, ...otherUnlockedIds];

        let options = orderedUnlocked.map(id => ({
            label: (ACHIEVEMENTS[id]?.name || id).substring(0, 100),
            value: id
        }));

        let components = [r1];
        for (let i = 0; i < options.length; i += 25) {
            if (components.length >= 4) break;
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`sel_achieve_${i}`)
                    .setPlaceholder(`Equip an achievement ${options.length > 25 ? `(${Math.floor(i / 25) + 1})` : ''}...`)
                    .addOptions(options.slice(i, i + 25))
            ));
        }

        await FrameManager.sendFrame(ctx, { embeds: [e], components }, uId);
    }
};

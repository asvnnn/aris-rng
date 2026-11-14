const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { pool, getUser } = require('../../database/userModel');
const { POTIONS, MODULES, CHIPS } = require('../../data/items');
const { FrameManager } = require('../../utils/discord');
const { formatAnsiPreview, formatBigIntSafe } = require('../../utils/math');

function formatBigInt(bi) { return formatBigIntSafe(bi); }

module.exports = {
    name: 'inv',
    aliases: ['inventory'],
    description: 'Manage inventory & equip items',
    data: new SlashCommandBuilder()
        .setName('inv')
        .setDescription('Manage your inventory, potions, modules, chips, and saved rolls'),

    async executePrefix(message, args, userDb) {
        await this.renderInv(message, userDb);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        await this.renderInv(interaction, userDb);
    },

    async renderInv(ctx, userDb, selectedId = null) {
        const uId = userDb.id;
        let sId = selectedId;

        const genUI = async () => {
            let u = userDb || await getUser(uId);
            
            const [[iRows], [aRows], [rRows]] = await Promise.all([
                pool.execute('SELECT * FROM items WHERE user_id = ? AND quantity > 0', [uId]),
                pool.execute('SELECT * FROM active_potions WHERE user_id = ?', [uId]),
                pool.execute('SELECT * FROM inventory WHERE user_id = ? ORDER BY CAST(roll_value AS DECIMAL(65, 0)) DESC', [uId])
            ]);

            if (sId) {
                if (sId.startsWith('r_')) {
                    const rExists = rRows.some(x => x.id.toString() === sId.split('_')[1]);
                    if (!rExists) sId = null;
                } else {
                    const iExists = iRows.some(x => x.item_id === sId && x.quantity > 0);
                    if (!iExists) sId = null;
                }
            }

            const expCost = BigInt(2) ** BigInt(Math.max(0, u.slots - 10));

            let embedColor = 0x8A2BE2;
            if (u.custom_color && /^#[0-9A-Fa-f]{6}$/.test(u.custom_color)) {
                embedColor = parseInt(u.custom_color.replace('#', ''), 16);
            }

            const e = new EmbedBuilder()
                .setTitle('📦 Inventory & Storage')
                .setColor(embedColor)
                .setDescription(
                    `**Storage:** ${rRows.length}/${u.slots} Slots\n` +
                    `**Equipped Module:** ${u.equipped_module ? (MODULES[u.equipped_module]?.name || u.equipped_module) : 'None'}\n` +
                    `**Equipped Chip:** ${u.equipped_chip ? (CHIPS[u.equipped_chip]?.name || u.equipped_chip) : 'None'}`
                )
                .addFields({
                    name: 'Active Buffs',
                    value: aRows.length > 0
                        ? aRows.map(p => `• ${POTIONS[p.potion_id]?.name || 'Unknown'} (${p.rolls_left} rolls)`).join('\n')
                        : 'None'
                });

            let cs = [];
            let pO = iRows.filter(i => POTIONS[i.item_id]).map(i => ({
                label: `${POTIONS[i.item_id].name} (x${i.quantity})`.substring(0, 100),
                description: `Rank ${POTIONS[i.item_id].rank}`,
                value: i.item_id
            }));
            let mO = iRows.filter(i => MODULES[i.item_id] || CHIPS[i.item_id]).map(i => ({
                label: `${(MODULES[i.item_id] || CHIPS[i.item_id]).name} (x${i.quantity})`.substring(0, 100),
                description: MODULES[i.item_id] ? 'Module' : 'Chip',
                value: i.item_id
            }));

            for (let i = 0; i < pO.length; i += 25) {
                if (cs.length >= 3) break;
                cs.push(new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`sel_inv_p_${i}`)
                        .setPlaceholder(`Potions ${pO.length > 25 ? `(${Math.floor(i / 25) + 1})` : ''}...`)
                        .addOptions(pO.slice(i, i + 25))
                ));
            }
            for (let i = 0; i < mO.length; i += 25) {
                if (cs.length >= 3) break;
                cs.push(new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`sel_inv_m_${i}`)
                        .setPlaceholder(`Modules & Chips ${mO.length > 25 ? `(${Math.floor(i / 25) + 1})` : ''}...`)
                        .addOptions(mO.slice(i, i + 25))
                ));
            }

            if (rRows.length > 0 && cs.length < 4) {
                cs.push(new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`sel_rls`)
                        .setPlaceholder('Saved Rolls...')
                        .addOptions(rRows.slice(0, 25).map(r => ({
                            label: `${r.is_locked ? '🔒' : '🔓'} 1 in ${formatBigInt(r.roll_value)}`.substring(0, 100),
                            value: `r_${r.id}`
                        })))
                ));
            }

            const r = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('inv_exp').setLabel(`Expand (+1 Slot / 💎 ${formatBigInt(expCost)})`).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('inv_sell_all').setLabel(`💰 Sell Unlocked`).setStyle(ButtonStyle.Danger)
            );

            if (sId) {
                if (sId.startsWith('r_')) {
                    const rD = rRows.find(x => x.id.toString() === sId.split('_')[1]);
                    if (rD) {
                        e.addFields({
                            name: `Inspecting Roll`,
                            value: `**1 in ${formatBigInt(rD.roll_value)}**\nStatus: ${rD.is_locked ? '🔒 Locked' : '🔓 Unlocked'}`
                        });
                        r.addComponents(
                            new ButtonBuilder().setCustomId(`inv_sell_r_${rD.id}`).setLabel('💰 Sell').setStyle(ButtonStyle.Success).setDisabled(rD.is_locked === 1),
                            new ButtonBuilder().setCustomId(`inv_lock_r_${rD.id}`).setLabel(rD.is_locked ? '🔓 Unlock' : '🔒 Lock').setStyle(ButtonStyle.Primary)
                        );
                    }
                } else {
                    const rf = POTIONS[sId] || MODULES[sId] || CHIPS[sId];
                    const itemRow = iRows.find(x => x.item_id === sId);
                    if (rf && itemRow) {
                        let dName = rf.name;
                        let dDesc = rf.desc || 'No description';
                        let ansiEffect = `\`\`\`ansi\n${formatAnsiPreview(rf.effectText || 'Unknown')}\n\`\`\``;
                        e.addFields({
                            name: `Inspecting: ${dName} (Owned: x${itemRow.quantity})`,
                            value: `*${dDesc}*\n**Effect:**\n${ansiEffect}`
                        });

                        if (POTIONS[sId]) {
                            r.addComponents(
                                new ButtonBuilder().setCustomId(`use_p_1_${sId}`).setLabel('🧪 Use 1').setStyle(ButtonStyle.Success),
                                new ButtonBuilder().setCustomId(`use_p_custom_${sId}`).setLabel('🧪 Custom').setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder().setCustomId(`use_p_all_${sId}`).setLabel('⚡ Use All').setStyle(ButtonStyle.Primary)
                            );
                        } else if (MODULES[sId]) {
                            const isEq = u.equipped_module === sId;
                            r.addComponents(
                                new ButtonBuilder().setCustomId(isEq ? `uneq_m_${sId}` : `eq_m_${sId}`).setLabel(isEq ? '⚙️ Unequip' : '⚙️ Equip').setStyle(isEq ? ButtonStyle.Danger : ButtonStyle.Primary)
                            );
                        } else if (CHIPS[sId]) {
                            const isEq = u.equipped_chip === sId;
                            r.addComponents(
                                new ButtonBuilder().setCustomId(isEq ? `uneq_c_${sId}` : `eq_c_${sId}`).setLabel(isEq ? '🔌 Unequip' : '🔌 Equip').setStyle(isEq ? ButtonStyle.Danger : ButtonStyle.Primary)
                            );
                        }
                    }
                }
            }
            cs.push(r);
            return { embeds: [e], components: cs };
        };

        const ui = await genUI();
        await FrameManager.sendFrame(ctx, ui, uId);
    }
};

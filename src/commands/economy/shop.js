const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { pool, getUser, saveUser } = require('../../database/userModel');
const { POTIONS, MODULES, CHIPS } = require('../../data/items');
const { getBlackMarketData } = require('../../systems/blackMarket');
const { FrameManager, autoDelete } = require('../../utils/discord');
const { formatAnsiPreview, formatBigIntSafe } = require('../../utils/math');

function formatBigInt(bi) { return formatBigIntSafe(bi); }
function getCurrencyIcon(c) { return c === 'crystals' ? '💎' : c === 'nulls' ? '⬛' : c === 'cc' ? '💠' : '🪙'; }

module.exports = {
    name: 'shop',
    aliases: ['bshop'],
    description: 'Buy & craft items or access the Black Market',
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('Buy & craft Potions, Modules, and Chips'),

    async executePrefix(message, args, userDb) {
        const isBShop = message.content.toLowerCase().startsWith('>bshop');
        await this.renderShop(message, userDb, isBShop);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        const isBShop = interaction.commandName === 'bshop';
        await this.renderShop(interaction, userDb, isBShop);
    },

    async renderShop(ctx, userDb, isBShop, selectedId = null, tabOverride = null) {
        const uId = userDb.id;
        let sId = selectedId;
        let currentTab = tabOverride;
        if (!currentTab) {
            if (sId) {
                if (MODULES[sId]) currentTab = 'modules';
                else if (CHIPS[sId]) currentTab = 'chips';
                else currentTab = 'potions';
            } else {
                currentTab = 'potions';
            }
        }

        let bShopData = getBlackMarketData(uId);
        if (isBShop && !bShopData.active) {
            const msgText = "❌ The Black Market is currently closed.";
            let m;
            if (typeof ctx.editReply === 'function' && (ctx.deferred || ctx.replied)) {
                m = await ctx.editReply({ content: msgText, embeds: [], components: [] }).catch(() => null);
            } else if (ctx.channel) {
                m = await ctx.channel.send(msgText).catch(() => null);
            }
            autoDelete(m, 15000);
            return;
        }

        const genUI = async () => {
            let u = userDb || await getUser(uId);
            const [userItems] = await pool.execute('SELECT item_id, quantity FROM items WHERE user_id = ?', [uId]);
            const ownedMap = {};
            for (const row of userItems) ownedMap[row.item_id] = row.quantity;

            const curNow = Date.now();
            const nextUtcResetUnix = (Math.floor(curNow / 86400000) + 1) * 86400;
            const bShopExpUnix = bShopData.expiresAt ? Math.floor(bShopData.expiresAt / 1000) : 0;

            let embedColor = isBShop ? 0x000000 : 0xFFA500;
            if (!isBShop && u.custom_color && /^#[0-9A-Fa-f]{6}$/.test(u.custom_color)) {
                embedColor = parseInt(u.custom_color.replace('#', ''), 16);
            }

            const timerLine = isBShop
                ? `*25% OFF standard potions! Closes <t:${bShopExpUnix}:R>.*`
                : `*Daily limits reset <t:${nextUtcResetUnix}:R>.*`;

            const e = new EmbedBuilder()
                .setTitle(isBShop ? '🌑 Black Market' : '🛒 Shop & Crafting')
                .setColor(embedColor)
                .setDescription(`**🪙 ${formatBigInt(u.coins)}** | **💎 ${formatBigInt(u.crystals)}** | **⬛ ${formatBigInt(u.nulls)}** | **💠 ${u.cc_coins} CC**\n${timerLine}`);

            let allItems = {};
            if (isBShop) {
                allItems['item_cc'] = {
                    rank: 'Currency',
                    name: 'Compressed Crystal',
                    cur: 'crystals',
                    cost: 1000n,
                    bshopOnly: true,
                    noDiscount: true,
                    effectText: 'Endgame currency'
                };
                for (const [k, p] of Object.entries(POTIONS)) {
                    if (p.bshopOnly) allItems[k] = p;
                }
                for (const [k, p] of Object.entries(POTIONS)) {
                    if (!p.bshopOnly) allItems[k] = p;
                }
            } else {
                allItems = { ...POTIONS };
            }

            let dailyDict = JSON.parse(u.daily_purchases || '{}');

            let pO = Object.entries(allItems).filter(([, p]) => !p.unbuyable && (!p.bshopOnly || isBShop)).map(([k, p]) => {
                if (isBShop && !bShopData.inventory.items.includes(k) && p.bshopOnly) return null;

                let cost = (isBShop && !p.craft && !p.noDiscount && !p.bshopOnly)
                    ? (BigInt(p.cost || 0) * 75n) / 100n
                    : (p.cost || 0n);
                let dName = p.name;
                let owned = k === 'item_cc' ? u.cc_coins : (ownedMap[k] || 0);

                let limit = p.limit || (isBShop && !p.craft && POTIONS[k] ? 100 : null);
                let trackKey = k;
                let boughtToday = dailyDict[trackKey] || 0;

                let limitText = limit ? `Limit: ${Math.max(0, limit - boughtToday)}/${limit}` : `Dur: ${p.dur || 0} rolls`;
                if (isBShop && k === 'item_cc') limitText = `Stock: ${bShopData.inventory.ccStock}`;

                return {
                    label: `${dName} - ${p.craft ? 'Craft' : `${getCurrencyIcon(p.cur)} ${formatBigInt(cost)}`}`.substring(0, 100),
                    description: `Rank ${p.rank} | ${limitText} | Owned: ${owned}`.substring(0, 100),
                    value: `s_${k}`
                };
            }).filter(Boolean);

            let mO = isBShop ? [] : Object.entries(MODULES).filter(([, m]) => !m.unbuyable).map(([k, m]) => {
                let dName = m.name;
                let owned = ownedMap[k] || 0;
                return {
                    label: `${dName} - ${m.craft ? 'Craft' : `${getCurrencyIcon(m.cur)} ${formatBigInt(m.cost || 0)}`}`.substring(0, 100),
                    description: `Module | Owned: ${owned}`,
                    value: `s_${k}`
                };
            });

            let cO = isBShop ? [] : Object.entries(CHIPS).filter(([, c]) => !c.unbuyable).map(([k, c]) => {
                let dName = c.name;
                let owned = ownedMap[k] || 0;
                return {
                    label: `${dName} - ${c.craft ? 'Craft' : `${getCurrencyIcon(c.cur)} ${formatBigInt(c.cost || 0)}`}`.substring(0, 100),
                    description: `Chip | Owned: ${owned}`,
                    value: `s_${k}`
                };
            });

            let cs = [];

            if (!isBShop) {
                const tabRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('shop_tab_potions')
                        .setLabel(`🧪 Potions (${pO.length})`)
                        .setStyle(currentTab === 'potions' ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('shop_tab_modules')
                        .setLabel(`⚙️ Modules (${mO.length})`)
                        .setStyle(currentTab === 'modules' ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('shop_tab_chips')
                        .setLabel(`🔌 Chips (${cO.length})`)
                        .setStyle(currentTab === 'chips' ? ButtonStyle.Success : ButtonStyle.Secondary)
                );
                cs.push(tabRow);

                let activeOptions = [];
                let placeholderPrefix = '';
                let customIdPrefix = '';

                if (currentTab === 'modules') {
                    activeOptions = mO;
                    placeholderPrefix = 'Modules';
                    customIdPrefix = 'sel_mod';
                } else if (currentTab === 'chips') {
                    activeOptions = cO;
                    placeholderPrefix = 'Chips';
                    customIdPrefix = 'sel_chip';
                } else {
                    activeOptions = pO;
                    placeholderPrefix = 'Potions';
                    customIdPrefix = 'sel_pot';
                }

                for (let i = 0; i < activeOptions.length; i += 25) {
                    if (cs.length >= 3) break;
                    const pageNum = Math.floor(i / 25) + 1;
                    const totalPages = Math.ceil(activeOptions.length / 25);
                    const pageStr = totalPages > 1 ? ` (${pageNum}/${totalPages})` : '';
                    cs.push(new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`${customIdPrefix}_${i}`)
                            .setPlaceholder(`${placeholderPrefix}${pageStr}...`)
                            .addOptions(activeOptions.slice(i, i + 25))
                    ));
                }
            } else {
                for (let i = 0; i < pO.length; i += 25) {
                    if (cs.length >= 3) break;
                    const pageNum = Math.floor(i / 25) + 1;
                    const totalPages = Math.ceil(pO.length / 25);
                    const pageStr = totalPages > 1 ? ` (${pageNum}/${totalPages})` : '';
                    cs.push(new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`sel_pot_${i}`)
                            .setPlaceholder(`Black Market Items${pageStr}...`)
                            .addOptions(pO.slice(i, i + 25))
                    ));
                }
            }

            if (sId) {
                const i = allItems[sId] || MODULES[sId] || CHIPS[sId];
                if (i && !i.unbuyable) {
                    let cost = (isBShop && !i.craft && !i.noDiscount && !i.bshopOnly)
                        ? (BigInt(i.cost || 0) * 75n) / 100n
                        : (i.cost || 0n);
                    let ownedQty = sId === 'item_cc' ? u.cc_coins : (ownedMap[sId] || 0);
                    let cD = i.craft ? "**Crafting Requirements:**\n" : `**Cost:** ${getCurrencyIcon(i.cur)} ${formatBigInt(cost)}`;

                    if (i.craft) {
                        if (i.reqCoins) cD += `- 🪙 ${formatBigInt(i.reqCoins)}\n`;
                        if (i.reqCrys) cD += `- 💎 ${formatBigInt(i.reqCrys)}\n`;
                        if (i.reqNulls) cD += `- ⬛ ${formatBigInt(i.reqNulls)}\n`;
                        if (i.reqCC) cD += `- 💠 ${i.reqCC} CC\n`;
                        if (i.reqMod) cD += `- ⚙️ ${MODULES[i.reqMod]?.name || i.reqMod} (x${i.reqModQty || 1})\n`;
                        if (i.reqMod2) cD += `- ⚙️ ${MODULES[i.reqMod2]?.name || i.reqMod2} (x${i.reqMod2Qty || 1})\n`;
                        if (i.reqMod3) cD += `- ⚙️ ${MODULES[i.reqMod3]?.name || i.reqMod3} (x${i.reqMod3Qty || 1})\n`;
                        if (i.reqModOr && Array.isArray(i.reqModOr)) {
                            let orNames = i.reqModOr.map(mKey => MODULES[mKey]?.name || mKey).join(' **OR** ');
                            cD += `- ⚙️ ${orNames} (x1)\n`;
                        }
                        if (i.reqChip) cD += `- 🔌 ${CHIPS[i.reqChip]?.name || i.reqChip} (x${i.reqChipQty || 1})\n`;
                        if (i.reqChip2) cD += `- 🔌 ${CHIPS[i.reqChip2]?.name || i.reqChip2} (x${i.reqChip2Qty || 1})\n`;
                        if (i.reqPot) cD += `- 🧪 ${POTIONS[i.reqPot]?.name || i.reqPot} (x${i.reqPotQty || 1})\n`;
                        if (i.reqPot2) cD += `- 🧪 ${POTIONS[i.reqPot2]?.name || i.reqPot2} (x${i.reqPot2Qty || 1})\n`;
                        if (i.reqTitle) {
                            const TITLES = require('../../data/titles');
                            cD += `- 🏷️ [${TITLES[i.reqTitle]?.name || i.reqTitle}] (x${i.reqTitleQty || 1})\n`;
                        }
                        if (i.failChance) {
                            cD += `⚠️ **Failure Rate:** ${(i.failChance * 100).toFixed(2)}% (Penalty: 🪙 ${formatBigInt(i.failCoins)}, 💎 ${formatBigInt(i.failCrys)}, 💠 ${i.failCC} CC, ${i.failModQty}x ${MODULES[i.failMod]?.name})\n`;
                        }
                    }

                    let dName = i.name;
                    let dDesc = i.desc || 'No description';
                    let ansiEffect = `\`\`\`ansi\n${formatAnsiPreview(i.effectText || 'Unknown')}\n\`\`\``;

                    e.addFields({
                        name: `Preview: ${dName} (Owned: x${ownedQty})`,
                        value: `*${dDesc}*\n${cD}\n**Effect:**\n${ansiEffect}`
                    });

                    const r = new ActionRowBuilder();
                    if (i.craft) {
                        r.addComponents(
                            new ButtonBuilder().setCustomId(`buy_1_${sId}_${isBShop}`).setLabel(`🔨 Craft 1`).setStyle(ButtonStyle.Success),
                            new ButtonBuilder().setCustomId(`buy_custom_${sId}_${isBShop}`).setLabel(`🔨 Custom`).setStyle(ButtonStyle.Secondary)
                        );
                    } else {
                        r.addComponents(new ButtonBuilder().setCustomId(`buy_1_${sId}_${isBShop}`).setLabel(`🛒 Buy 1`).setStyle(ButtonStyle.Success));
                        if (!i.limit && !MODULES[sId] && !CHIPS[sId] && sId !== 'item_cc') {
                            r.addComponents(new ButtonBuilder().setCustomId(`buy_10_${sId}_${isBShop}`).setLabel(`🛒 Buy 10`).setStyle(ButtonStyle.Primary));
                        }
                        if (allItems[sId] || ['mod_glitch', 'chip_error', 'chip_luck', 'mod_luck'].includes(sId)) {
                            r.addComponents(
                                new ButtonBuilder().setCustomId(`buy_max_${sId}_${isBShop}`).setLabel(`🚀 Buy Max`).setStyle(ButtonStyle.Danger),
                                new ButtonBuilder().setCustomId(`buy_custom_${sId}_${isBShop}`).setLabel(`✏️ Custom`).setStyle(ButtonStyle.Secondary)
                            );
                        }
                    }
                    cs.push(r);
                }
            }
            return { embeds: [e], components: cs };
        };

        const ui = await genUI();
        await FrameManager.sendFrame(ctx, ui, uId);
    }
};

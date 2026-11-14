const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { POTIONS, MODULES, CHIPS } = require('../data/items');
const ACHIEVEMENTS = require('../data/achievements');
const TITLES = require('../data/titles');
const { FrameManager } = require('./discord');

const CATALOG_PAGE_SIZE = 12;

function getCatalogEntries(category) {
    const cat = (category || 'potions').toLowerCase();

    if (cat === 'potions' || cat === 'pot') {
        return {
            key: 'potions',
            label: '🧪 Potions (IDs: pot_*)',
            usageHint: '`>control <user> additem <pot_id> [qty]`',
            items: Object.entries(POTIONS).map(([id, p]) => `• \`${id}\` — **${p.name}** *(Rank ${p.rank})*`)
        };
    }
    if (cat === 'modules' || cat === 'mod') {
        return {
            key: 'modules',
            label: '⚙️ Modules (IDs: mod_*)',
            usageHint: '`>control <user> additem <mod_id> [qty]`',
            items: Object.entries(MODULES).map(([id, m]) => `• \`${id}\` — **${m.name}**`)
        };
    }
    if (cat === 'chips' || cat === 'chip') {
        return {
            key: 'chips',
            label: '💾 Chips (IDs: chip_*)',
            usageHint: '`>control <user> additem <chip_id> [qty]`',
            items: Object.entries(CHIPS).map(([id, c]) => `• \`${id}\` — **${c.name}**`)
        };
    }
    if (cat === 'achievements' || cat === 'achieve' || cat === 'ach') {
        return {
            key: 'achievements',
            label: '🏆 Achievements',
            usageHint: '`>control <user> giveachieve <achieve_id>`',
            items: Object.entries(ACHIEVEMENTS).map(([id, a]) => `• \`${id}\` — **${a.name}**`)
        };
    }
    if (cat === 'titles' || cat === 'title') {
        return {
            key: 'titles',
            label: '👑 Titles',
            usageHint: '`>control <user> givetitle <title_id>`',
            items: Object.entries(TITLES).map(([id, t]) => `• \`${id}\` — **[${t.name}]** *(Rarity: ${t.rarity || 'Special'})*`)
        };
    }
    return getCatalogEntries('potions');
}

async function renderCatalog(ctx, userId, category = 'potions', page = 0) {
    const prefix = 'ctrl_cat';
    const catalog = getCatalogEntries(category);
    const totalItems = catalog.items.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / CATALOG_PAGE_SIZE));
    const safePage = Math.max(0, Math.min(totalPages - 1, Number(page) || 0));
    const slice = catalog.items.slice(safePage * CATALOG_PAGE_SIZE, (safePage + 1) * CATALOG_PAGE_SIZE);

    const embed = new EmbedBuilder()
        .setTitle(`📋 Control Catalog — ${catalog.label}`)
        .setColor(0x3498DB)
        .setDescription(
            `**Usage:** ${catalog.usageHint}\n\n` +
            (slice.join('\n') || 'No entries found.')
        )
        .setFooter({
            text: `Page ${safePage + 1} / ${totalPages} • Total: ${totalItems} entries`
        });

    const tabRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${prefix}_tab_potions`)
            .setLabel('Potions')
            .setStyle(catalog.key === 'potions' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${prefix}_tab_modules`)
            .setLabel('Modules')
            .setStyle(catalog.key === 'modules' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${prefix}_tab_chips`)
            .setLabel('Chips')
            .setStyle(catalog.key === 'chips' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${prefix}_tab_achievements`)
            .setLabel('Achievements')
            .setStyle(catalog.key === 'achievements' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${prefix}_tab_titles`)
            .setLabel('Titles')
            .setStyle(catalog.key === 'titles' ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );

    const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${prefix}_pg_${catalog.key}_${safePage - 1}`)
            .setLabel('◀ Prev')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage <= 0),
        new ButtonBuilder()
            .setCustomId(`${prefix}_pg_${catalog.key}_${safePage + 1}`)
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage >= totalPages - 1)
    );

    return FrameManager.sendFrame(ctx, { embeds: [embed], components: [tabRow, navRow] }, userId);
}

module.exports = {
    getCatalogEntries,
    renderCatalog
};

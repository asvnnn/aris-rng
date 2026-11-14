const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { FrameManager } = require('../../utils/discord');

module.exports = {
    name: 'guild',
    aliases: ['guide'],
    description: 'Game Guide',
    data: new SlashCommandBuilder()
        .setName('guild')
        .setDescription('View the A.R.I.S Game Guide'),

    async executePrefix(message, args, userDb) {
        await this.renderGuide(message, userDb);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        await this.renderGuide(interaction, userDb);
    },

    async renderGuide(ctx, userDb) {
        let embedColor = 0x3498DB;
        if (userDb?.custom_color && /^#[0-9A-Fa-f]{6}$/.test(userDb.custom_color)) {
            embedColor = parseInt(userDb.custom_color.replace('#', ''), 16);
        }

        const e = new EmbedBuilder()
            .setTitle('📘 .A.R.I.S — Official Simulation & Game Guide')
            .setColor(embedColor)
            .addFields(
                {
                    name: '💰 1. Currencies & Economy',
                    value:
                        '• **Coins (🪙):** Earned by selling rolled numbers (`1 Rarity = 1 Coin`; negative numbers also sell for positive Coins) and `>daily`.\n' +
                        '• **Crystals (💎):** Obtained via `>daily`, Achievements, **Crystal Maker** (2% / 75 pity), and **Crystal Module** (3% / 34 pity, or 3.5% / 29 pity with **Crystal Chip**).\n' +
                        '• **NULL (⬛):** `0.404%` chance to drop when rolling a **negative number**.\n' +
                        '• **Compressed Crystal (💠 CC):** Endgame currency sold in `>bshop` (`1,000 Crystals`) or the `>quest` Token Shop (`15 Tokens`, 1/week, requires >25k rolls).'
                },
                {
                    name: '🎲 2. Luck Formula & Potion Ranks',
                    value:
                        '**Formula:** `Luck = (((1 + Basic Luck) * Multi Luck) + Special Luck) * FINAL MULTIPLIER`\n' +
                        '• **Rank Rule:** Only 1 potion per numeric Rank (e.g. Rank `1.0`) can be active at a time. Consuming the **exact same** potion extends its roll duration. **Special Rank** potions stack freely with everything!'
                },
                {
                    name: '⚙️ 3. Hardware (Modules & Chips) & Storage',
                    value:
                        '• Equip **1 Module** and **1 Chip** in `>inv`. *(Note: Unequipping a module/chip resets its accumulated roll counter to 0.)*\n' +
                        '• You start with **10 inventory slots** (expandable with Crystals: cost = `2^(slots - 10)`). Lock rare numbers so they are never auto-replaced!'
                },
                {
                    name: '👑 4. Rolling Titles & Independent Rates',
                    value:
                        '• Equip **Spectrometer Module** to unlock rolling Titles alongside your numbers!\n' +
                        '• Unlock Titles from `[Sol]` (`1 in 1`) up to `[S p e c t r u m]` (`1 in 10,000`).'
                },
                {
                    name: '🌍 5. Daily Loop & Black Market',
                    value:
                        '• `>daily` & `>quest`: Reset daily at **00:00 UTC**. Complete 3 daily quests to earn **Quest Tokens (🎫)**.\n' +
                        '• `>pray`: Pray every **6 hours** to gain **+0.01 Permanent Basic Luck**.\n' +
                        '• `>bshop`: Spawns randomly every 60s (`0.1%` chance) for **10 minutes** with a **25% discount** on regular items and exclusive endgame stock.'
                }
            )
            .setFooter({ text: 'Use >help for all commands • Use >web to play on A.R.I.S Desktop OS' });

        await FrameManager.sendFrame(ctx, { embeds: [e], components: [] }, userDb.id);
    }
};

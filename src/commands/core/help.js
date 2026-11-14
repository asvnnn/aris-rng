const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { FrameManager } = require('../../utils/discord');

module.exports = {
    name: 'help',
    aliases: ['h', 'cmds'],
    description: 'List all commands',
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('List all available commands in A.R.I.S'),

    async executePrefix(message, args, userDb) {
        await this.renderHelp(message, userDb);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        await this.renderHelp(interaction, userDb);
    },

    async renderHelp(ctx, userDb) {
        let embedColor = 0x2ECC71;
        if (userDb?.custom_color && /^#[0-9A-Fa-f]{6}$/.test(userDb.custom_color)) {
            embedColor = parseInt(userDb.custom_color.replace('#', ''), 16);
        }

        const embed = new EmbedBuilder()
            .setTitle('🤖 A.R.I.S Command List')
            .setColor(embedColor)
            .setDescription('Here are the commands you can use in A.R.I.S:')
            .addFields(
                { name: '🎲 Core', value: '`>roll` (`>r`) - Roll a number\n`>daily` - Claim daily rewards\n`>pray` - Pray for permanent luck\n`>quest` (`>q`) - Daily quests & Token Shop' },
                { name: '👤 Profile', value: '`>stat` - View player profile\n`>status` (`>s`) - View luck modifiers\n`>achieve` - View achievements\n`>title` - Equip titles\n`>setting` - Game settings' },
                { name: '🛒 Economy', value: '`>shop` - Buy & craft items\n`>bshop` - Black Market\n`>inv` (`>inventory`) - Inventory & Storage\n`>leaderboard` (`>l`) - Global rankings' },
                { name: '🛠️ Extras', value: '`>code` - Redeem codes\n`>web` - Launch A.R.I.S Web OS\n`>guild` - Game Guide' }
            )
            .setFooter({ text: 'Tip: Use >guild to learn how to play!' });

        await FrameManager.sendFrame(ctx, { embeds: [embed], components: [] }, userDb.id);
    }
};

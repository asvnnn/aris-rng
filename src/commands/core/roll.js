const { SlashCommandBuilder } = require('discord.js');
const { executeRoll } = require('../../systems/rollEngine');

module.exports = {
    name: 'roll',
    aliases: ['r'],
    description: 'Roll a random number',
    
    data: new SlashCommandBuilder()
        .setName('roll')
        .setDescription('Roll a random number'),

    async executePrefix(message, args, userDb) {
        await executeRoll(message, userDb);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        await executeRoll(interaction, userDb);
    }
};
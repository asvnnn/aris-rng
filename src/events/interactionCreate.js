const { MessageFlags } = require('discord.js');
const {
    FrameManager,
    checkCooldown,
    acquireLock,
    releaseLock,
    messageOwners
} = require('../utils/discord');
const { DEV_IDS } = require('../config/constants');
const { getUser, saveUser } = require('../database/userModel');
const { grantAchievement } = require('../systems/achievementSystem');
const { isUserOnlineOnWeb } = require('../web/sessionLock');
const { handleSelectMenu } = require('./handlers/selects');
const { handleButton } = require('./handlers/buttons');
const { handleModalSubmit } = require('./handlers/modals');

module.exports = {
    name: 'interactionCreate',
    once: false,
    async execute(interaction, client) {
        const runInteraction = async () => {
            if (isUserOnlineOnWeb(interaction.user.id)) {
                return interaction.reply({
                    content: '🔒 **Web OS Session Active!** Your account is currently online on **A.R.I.S Web OS**. Please sign out or close the Web OS tab before using Discord commands to prevent data desynchronization.',
                    flags: MessageFlags.Ephemeral
                }).catch(() => {});
            }

            if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
                let ownerId = interaction.message ? messageOwners.get(interaction.message.id) : null;
                if (!ownerId && interaction.message?.interaction) ownerId = interaction.message.interaction.user.id;
                if (!ownerId) {
                    return interaction.reply({ content: "❌ This frame has expired. Please run the command again.", flags: MessageFlags.Ephemeral }).catch(() => {});
                }
                if (ownerId !== interaction.user.id) {
                    return interaction.reply({ content: "❌ You cannot interact with someone else's frame!", flags: MessageFlags.Ephemeral }).catch(() => {});
                }
            }

            if (checkCooldown(interaction.user.id)) {
                if (
                    ((typeof interaction.isMessageComponent === 'function' && interaction.isMessageComponent()) ||
                     (typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit())) &&
                    typeof interaction.deferUpdate === 'function'
                ) {
                    await interaction.deferUpdate().catch(() => {});
                } else if (
                    typeof interaction.isChatInputCommand === 'function' &&
                    interaction.isChatInputCommand() &&
                    typeof interaction.deferReply === 'function'
                ) {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
                        .then(() => typeof interaction.deleteReply === 'function' ? interaction.deleteReply() : null)
                        .catch(() => {});
                }
                return;
            }

            const modalTriggerButtons = ['set_color', 'set_as_pos', 'set_as_neg'];
            const isModalButton = interaction.isButton() && (
                interaction.customId.startsWith('buy_custom_') ||
                interaction.customId.startsWith('use_p_custom_') ||
                modalTriggerButtons.includes(interaction.customId)
            );

            if (
                ((interaction.isButton() && !isModalButton) ||
                 interaction.isStringSelectMenu() ||
                 interaction.isModalSubmit()) &&
                typeof interaction.deferUpdate === 'function'
            ) {
                await interaction.deferUpdate().catch(() => {});
            }

            await acquireLock(interaction.user.id);
            try {
                const frameAgeBeforeAction = typeof FrameManager.getFrameAge === 'function'
                    ? FrameManager.getFrameAge(interaction.user.id)
                    : 0;

                let userDb = await getUser(interaction.user.id, interaction.user.username);

                if (userDb.is_banned === 1 && !DEV_IDS.includes(interaction.user.id)) {
                    const banMsg = { content: "🔨 Your account has been suspended from A.R.I.S.", flags: MessageFlags.Ephemeral };
                    if (interaction.deferred || interaction.replied) await interaction.followUp(banMsg).catch(() => {});
                    else await interaction.reply(banMsg).catch(() => {});
                    return;
                }

                if (interaction.isChatInputCommand()) {
                    const command = client.commands.get(interaction.commandName);
                    if (!command) return;

                    if (command.executeSlash) await command.executeSlash(interaction, userDb, client);
                }
                else if (interaction.isStringSelectMenu()) {
                    await handleSelectMenu(interaction, userDb, client, frameAgeBeforeAction);
                }
                else if (interaction.isButton()) {
                    await handleButton(interaction, userDb, client, false);
                }
                else if (interaction.isModalSubmit()) {
                    await handleModalSubmit(interaction, userDb, client);
                }
            } catch (error) {
                console.error(`❌ Interaction Error:`, error);
                const errReply = { content: "❌ **Error:** Something went wrong.", flags: MessageFlags.Ephemeral };
                if (interaction.deferred || interaction.replied) await interaction.followUp(errReply).catch(() => {});
                else await interaction.reply(errReply).catch(() => {});
            } finally {
                releaseLock(interaction.user.id);
            }
        };

        return runInteraction();
    }
};

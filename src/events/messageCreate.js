const { PREFIX, DEV_IDS } = require('../config/constants');
const { getUser, saveUser } = require('../database/userModel');
const { checkCooldown, acquireLock, releaseLock, autoDelete } = require('../utils/discord');
const { grantAchievement } = require('../systems/achievementSystem');
const { isUserOnlineOnWeb } = require('../web/sessionLock');

module.exports = {
    name: 'messageCreate',
    once: false,
    async execute(message, client) {
        if (message.author.bot) return;
        if (!message.content.startsWith(PREFIX)) return;

        const args = message.content.slice(PREFIX.length).trim().split(/ +/);
        const commandName = args.shift().toLowerCase();

        const command = client.commands.get(commandName);
        if (!command) return;

        const executeHandler = async () => {
            if (command.name !== 'web' && isUserOnlineOnWeb(message.author.id)) {
                const warnMsg = await message.channel.send(
                    `🔒 **Web OS Session Active!** Your account is currently online on **A.R.I.S Web OS**. Please sign out or close the Web OS tab before using Discord commands to prevent data desynchronization.`
                ).catch(() => null);
                autoDelete(warnMsg, 10000);
                if (message.deletable && typeof message.delete === 'function') {
                    Promise.resolve(message.delete()).catch(() => {});
                }
                return;
            }

            if (checkCooldown(message.author.id)) {
                if (command.name !== 'control' && message.deletable && typeof message.delete === 'function') {
                    Promise.resolve(message.delete()).catch(() => {});
                }
                return;
            }

            await acquireLock(message.author.id);
            try {
                let userDb = await getUser(message.author.id, message.author.username);

                if (userDb.is_banned === 1 && !DEV_IDS.includes(message.author.id)) {
                    return;
                }

                if (command.executePrefix) {
                    const shouldDelete = await command.executePrefix(message, args, userDb, client);
                    if (shouldDelete !== false && message.deletable && typeof message.delete === 'function') {
                        Promise.resolve(message.delete()).catch(() => {});
                    }
                }
            } catch (error) {
                console.error(`❌ Command Error (${commandName}):`, error);
                message.channel.send("❌ **Error:** Something went wrong while executing this command.").catch(() => {});
            } finally {
                releaseLock(message.author.id);
            }
        };

        return executeHandler();
    }
};

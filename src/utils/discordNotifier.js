const { EmbedBuilder } = require('discord.js');
const { getMainClient } = require('./discord');

async function notifyDiscord({ title, description, color = 0x0078D7, fields = [], userId = null, pingUser = false, onlyDm = false }) {
    try {
        const mainClient = getMainClient();
        if (!mainClient || !mainClient.isReady()) return;

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setTimestamp()
            .setFooter({ text: 'A.R.I.S Engine • Web & Discord Unified Services' });

        if (Array.isArray(fields) && fields.length > 0) {
            embed.addFields(fields);
        }

        if (userId) {
            try {
                const user = await mainClient.users.fetch(userId).catch(() => null);
                if (user) {
                    await user.send({ embeds: [embed] }).catch(() => null);
                }
            } catch (e) {
            }
        }

        const isBShopNotification = (title && /black market|bshop/i.test(title)) || (description && /black market|bshop/i.test(description));
        if (onlyDm || isBShopNotification) {
            return;
        }

        for (const guild of mainClient.guilds.cache.values()) {
            try {
                const me = guild.members.me;
                if (!me) continue;

                let channel = guild.systemChannel;
                if (!channel || !channel.permissionsFor(me)?.has('SendMessages')) {
                    channel = guild.channels.cache.find(c => 
                        c.isTextBased() && 
                        c.permissionsFor(me)?.has('SendMessages')
                    );
                }

                if (channel) {
                    const content = (pingUser && userId) ? `<@${userId}>` : undefined;
                    await channel.send({ content, embeds: [embed] }).catch(() => null);
                }
            } catch (e) {
            }
        }
    } catch (err) {
        console.error('[DiscordNotifier Error]:', err.message);
    }
}

async function notifyBlackMarketDMs(userIds = [], customOptions = {}) {
    try {
        const mainClient = getMainClient();
        const isClientReady = mainClient && (typeof mainClient.isReady === 'function' ? mainClient.isReady() : Boolean(mainClient.readyAt));
        if (!isClientReady || !Array.isArray(userIds) || userIds.length === 0) {
            return { sent: 0, failed: 0 };
        }

        const uniqueUserIds = [...new Set(userIds.map(id => String(id)).filter(Boolean))];
        if (uniqueUserIds.length === 0) return { sent: 0, failed: 0 };

        const title = customOptions.title || '🌑 The Black Market has Opened!';
        const description = customOptions.description ||
            'The Black Market has surfaced from the void! It will remain open for **10 minutes**.\nUse `>bshop` in Discord or visit the **A.R.I.S Store** on Web OS to check exclusive stock!';
        const color = customOptions.color !== undefined ? customOptions.color : 0x1a1a24;
        const footerText = customOptions.footer || 'You received this because BShop Ping is enabled in >setting.';

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setTimestamp()
            .setFooter({ text: footerText });

        const BATCH_SIZE = 5;
        let sentCount = 0;
        let failCount = 0;

        for (let i = 0; i < uniqueUserIds.length; i += BATCH_SIZE) {
            const batch = uniqueUserIds.slice(i, i + BATCH_SIZE);
            await Promise.allSettled(
                batch.map(async (uId) => {
                    try {
                        const user = await mainClient.users.fetch(String(uId)).catch(() => null);
                        if (user && typeof user.send === 'function') {
                            try {
                                await user.send({ embeds: [embed] });
                                sentCount++;
                            } catch (sendErr) {
                                failCount++;
                            }
                        } else {
                            failCount++;
                        }
                    } catch (e) {
                        failCount++;
                    }
                })
            );
            if (i + BATCH_SIZE < uniqueUserIds.length) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }

        return { sent: sentCount, failed: failCount };
    } catch (err) {
        return { sent: 0, failed: 0 };
    }
}

module.exports = {
    notifyDiscord,
    notifyBlackMarketDMs
};

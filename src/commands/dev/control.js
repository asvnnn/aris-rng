
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { DEV_IDS } = require('../../config/constants');
const { pool, getUser, saveUser } = require('../../database/userModel');
const { updateLeaderboard } = require('../../systems/leaderboardSystem');
const { FrameManager, createVerification, consumeLatestVerificationForUser } = require('../../utils/discord');
const { resolveTargetUser, executeVerifiedControl } = require('../../systems/premiumSystem');
const { POTIONS, MODULES, CHIPS } = require('../../data/items');
const ACHIEVEMENTS = require('../../data/achievements');
const TITLES = require('../../data/titles');
const { getCatalogEntries, renderCatalog } = require('../../utils/catalog');

const BIGINT_ACTIONS = ['addcoin', 'setcoin', 'addcrys', 'setcrys', 'addnull', 'setnull', 'addcc', 'setcc'];
const INT_ACTIONS = ['addtoken', 'settoken'];
const FLOAT_ACTIONS = ['addperm', 'setperm', 'fixedluck'];
function validateControlNumber(action, value) {
    const v = String(value ?? '').trim();
    if (BIGINT_ACTIONS.includes(action) && !/^-?\d+$/.test(v)) return `❌ \`${action}\` requires a whole number (got \`${v}\`).`;
    if (INT_ACTIONS.includes(action) && !/^-?\d+$/.test(v)) return `❌ \`${action}\` requires a whole number (got \`${v}\`).`;
    if (FLOAT_ACTIONS.includes(action) && (v === '' || !Number.isFinite(Number(v)))) return `❌ \`${action}\` requires a valid number (got \`${v}\`).`;
    return null;
}
function safeBigIntArg(v) {
    const t = String(v).trim();
    if (!/^-?\d+$/.test(t)) throw new Error(`Invalid whole number: ${t}`);
    return BigInt(t);
}

function getControlCatalogEntries(category) {
    return getCatalogEntries(category);
}

async function renderControlCatalog(ctx, userId, category = 'potions', page = 0) {
    return renderCatalog(ctx, userId, category, page);
}

module.exports = {
    name: 'control',
    aliases: ['ccode'],
    description: 'Developer Control Panel (DM Only)',
    renderControlCatalog,
    getControlCatalogEntries,

    async executePrefix(message, args, userDb, client) {
        if (!DEV_IDS.includes(message.author.id)) return false;

        if (message.guild) {
            message.author.send("⚠️ You used `>control` in a public server! Execution was blocked for security. Please run `>control` directly here in DMs.").catch(() => {});
            return false;
        }

        const invokedAlias = message.content.slice(1).trim().split(/ +/)[0].toLowerCase();
        if (invokedAlias === 'ccode') {
            args.unshift('ccode');
        }

        const action = args[0]?.toLowerCase();

        if (!action || action === 'help') {
            return message.channel.send(
                `🛠️ **A.R.I.S Developer Panel:**\n` +
                `• \`>control list [potions/modules/chips/achievements/titles] [page]\` — Browse item, achievement & title IDs\n` +
                `  *(Shortcuts: \`>control itemlist\`, \`>control potlist\`, \`>control modlist\`, \`>control chiplist\`, \`>control achievelist\`, \`>control titlelist\`)*\n` +
                `• \`>control <user> view\` — View player profile & inventory\n` +
                `• \`>control <user> <action> [value] [qty]\` — Adjust player stats / grant items\n` +
                `  **Stats & Currencies:** \`addcoin\`, \`setcoin\`, \`addcrys\`, \`setcrys\`, \`addnull\`, \`setnull\`, \`addcc\`, \`setcc\`, \`addtoken\`, \`settoken\`, \`addperm\`, \`setperm\`, \`fixedluck\`\n` +
                `  **Items & Effects:** \`additem\`, \`removeitem\`, \`giveachieve\`, \`givetitle\`, \`removeeffect\`, \`forcebshop\`\n` +
                `  **Admin:** \`ban\`, \`unban\`, \`deletedata\`, \`wipealldata\`\n` +
                `• \`>control ccode create ...\` — Create giftcode\n` +
                `• \`>control viewcode\` — View active codes\n` +
                `• \`>control resetlb\` — Force refresh leaderboards`
            );
        }

        const catalogActionMap = {
            list: null,
            catalog: null,
            itemlist: 'potions',
            items: 'potions',
            potlist: 'potions',
            modlist: 'modules',
            chiplist: 'chips',
            achievelist: 'achievements',
            achlist: 'achievements',
            titlelist: 'titles'
        };
        if (Object.prototype.hasOwnProperty.call(catalogActionMap, action)) {
            let cat = catalogActionMap[action];
            let pageArg = args[1];
            if (!cat) {
                const maybeCat = (args[1] || 'potions').toLowerCase();
                if (/^\d+$/.test(maybeCat)) {
                    cat = 'potions';
                    pageArg = maybeCat;
                } else {
                    cat = maybeCat;
                    pageArg = args[2];
                }
            }
            const pageNum = Math.max(0, (parseInt(pageArg, 10) || 1) - 1);
            return renderControlCatalog(message, message.author.id, cat, pageNum);
        }

        if (action === 'confirm') {
            const payload = consumeLatestVerificationForUser(message.author.id, 'control');
            if (!payload) return message.channel.send('❌ No pending `>control` action found or verification expired.');
            const resultMsg = await executeVerifiedControl(payload);
            return message.channel.send(resultMsg);
        }
        if (action === 'cancel') {
            const payload = consumeLatestVerificationForUser(message.author.id, 'control');
            if (!payload) return message.channel.send('❌ No pending `>control` action to cancel.');
            return message.channel.send('🚫 Aborted pending `>control` operation.');
        }

        if (action === 'resetlb') {
            await updateLeaderboard(true);
            return message.channel.send('✅ **Leaderboard cache forcefully updated.**');
        }

        if (action === 'wipealldata') {
            const token = createVerification(message.author.id, {
                source: 'control',
                action: 'wipealldata',
                targetId: 'ALL_USERS'
            }, 60000);
            const expUnix = Math.floor((Date.now() + 60000) / 1000);
            const embed = new EmbedBuilder()
                .setTitle('⚠️ Warning: FULL DATABASE WIPE')
                .setColor(0xE74C3C)
                .setDescription(
                    `You are about to **PERMANENTLY WIPE ALL DATA** in the database!\n` +
                    `• Confirmation Expires: <t:${expUnix}:R>`
                );
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`verify_confirm_${token}`).setLabel('CONFIRM FULL WIPE').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`verify_cancel_${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
            );
            return FrameManager.sendFrame(message, { embeds: [embed], components: [row] }, message.author.id);
        }

        if (action === 'delcode' || action === 'deletecode') {
            const cd = args[1];
            if (!cd) return message.channel.send('❌ Usage: `>control delcode <code>`');
            await pool.execute('DELETE FROM codes WHERE code = ?', [cd]);
            await pool.execute('DELETE FROM code_redemptions WHERE code = ?', [cd]);
            return message.channel.send(`✅ **Deleted Code:** \`${cd}\``);
        }

        if (action === 'viewcode' || (action === 'ccode' && ['view', 'list'].includes(args[1]?.toLowerCase()))) {
            const [rows] = await pool.execute('SELECT * FROM codes');
            if (!rows.length) return message.channel.send('📜 No active codes found.');

            const [redemptions] = await pool.execute(
                'SELECT cr.code, cr.user_id, u.username FROM code_redemptions cr LEFT JOIN users u ON cr.user_id = u.id'
            );
            const redempMap = {};
            for (const r of redemptions) {
                if (!redempMap[r.code]) redempMap[r.code] = [];
                redempMap[r.code].push(`${r.username || 'Unknown'} (\`${r.user_id}\`)`);
            }

            let desc = rows.map(c => {
                const now = Date.now();
                const isExpired = c.expires_at > 0 && now > c.expires_at;
                let exp = c.expires_at > 0 ? `<t:${Math.floor(c.expires_at / 1000)}:R>` : 'Never';
                if (isExpired) exp += ' **[EXPIRED]**';

                let claimers = redempMap[c.code] ? redempMap[c.code].slice(0, 10).join(', ') : 'None';
                if (redempMap[c.code] && redempMap[c.code].length > 10) {
                    claimers += ` (+${redempMap[c.code].length - 10} more)`;
                }

                let rewardsObj = {};
                try { rewardsObj = JSON.parse(c.rewards || '{}'); } catch (e) {}
                let rewParts = [];
                if (rewardsObj.coins && rewardsObj.coins !== '0') rewParts.push(`🪙 ${BigInt(rewardsObj.coins).toLocaleString('en-US')}`);
                if (rewardsObj.crystals && rewardsObj.crystals !== '0') rewParts.push(`💎 ${BigInt(rewardsObj.crystals).toLocaleString('en-US')}`);
                if (rewardsObj.nulls && rewardsObj.nulls !== '0') rewParts.push(`⬛ ${BigInt(rewardsObj.nulls).toLocaleString('en-US')}`);
                if (rewardsObj.cc) rewParts.push(`💠 ${rewardsObj.cc} CC`);
                if (rewardsObj.tokens) rewParts.push(`🎫 ${rewardsObj.tokens} Tokens`);
                if (rewardsObj.items && Object.keys(rewardsObj.items).length) {
                    rewParts.push(`📦 ${Object.entries(rewardsObj.items).map(([id, q]) => `${q}x ${id}`).join(', ')}`);
                }
                if (rewardsObj.achievements && rewardsObj.achievements.length) {
                    rewParts.push(`🏆 ${rewardsObj.achievements.join(', ')}`);
                }

                return `**\`${c.code}\`** | Uses: ${c.current_uses}/${c.max_uses === 0 ? '∞' : c.max_uses} | Exp: ${exp}\n🎁 Rewards: ${rewParts.join(' | ') || 'None'}\n↳ Redeemed by: ${claimers}`;
            }).join('\n\n');

            const embed = new EmbedBuilder().setTitle('🎟️ Active Codes & Redemptions').setColor(0x3498DB).setDescription(desc.substring(0, 4000));
            return message.channel.send({ embeds: [embed] });
        }

        if (action === 'ccode') {
            const subAction = args[1]?.toLowerCase();
            if (subAction === 'delete' || subAction === 'del') {
                const cd = args[2];
                if (!cd) return message.channel.send('❌ Usage: `>control ccode delete <code>`');
                await pool.execute('DELETE FROM codes WHERE code = ?', [cd]);
                await pool.execute('DELETE FROM code_redemptions WHERE code = ?', [cd]);
                return message.channel.send(`✅ **Deleted Code:** \`${cd}\``);
            }

            if (subAction === 'create') {
                const cd = args[2]; const mx = parseInt(args[3], 10) || 0; const exS = parseInt(args[4], 10) || 0;
                const coins = args[5] || '0'; const crys = args[6] || '0'; const nulls = args[7] || '0'; const cc = args[8] || '0';
                const tokens = args[9] || '0';
                const itemsStr = args[10] || '';

                if (!cd) return message.channel.send('❌ Usage: `>control ccode create <code> <uses> <expire_secs> <coins> <crys> <nulls> <cc> <tokens> [item1:qty,item2:qty]`');

                let rewards = { coins, crystals: crys, nulls, cc: parseInt(cc, 10), tokens: parseInt(tokens, 10) };
                if (itemsStr) {
                    rewards.items = {};
                    itemsStr.split(',').forEach(pair => {
                        let [id, q] = pair.split(':');
                        if (id && q) rewards.items[id] = parseInt(q, 10);
                    });
                }

                const exp = exS === 0 ? 0 : Date.now() + (exS * 1000);
                try {
                    await pool.execute(`REPLACE INTO codes (code, max_uses, current_uses, rewards, expires_at) VALUES (?, ?, 0, ?, ?)`, [cd, mx, JSON.stringify(rewards), exp]);
                    return message.channel.send(`✅ **Created Code:** \`${cd}\`\nUses: ${mx === 0 ? '∞' : mx} | Exp: ${exp > 0 ? `<t:${Math.floor(exp / 1000)}:R>` : 'Never'}\nRewards: \`${JSON.stringify(rewards)}\``);
                } catch (err) { return message.channel.send(`❌ **DB Error:** ${err.message}`); }
            }

            let codeName;
            let maxUses = 0;
            let expireSecs = 0;
            let rewardPairs = [];

            if (/^\d+$/.test(args[1]) && /^\d+$/.test(args[2])) {
                const crypto = require('crypto');
                codeName = `ARIS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
                maxUses = parseInt(args[1], 10) || 0;
                expireSecs = parseInt(args[2], 10) || 0;
                rewardPairs = args.slice(3);
            } else {
                codeName = args[1];
                maxUses = parseInt(args[2], 10) || 0;
                expireSecs = parseInt(args[3], 10) || 0;
                rewardPairs = args.slice(4);
            }

            if (!codeName || rewardPairs.length < 2) {
                return message.channel.send(
                    '❌ **Usage:**\n' +
                    '• `>control ccode <code> <uses> <expire_secs> <addcoin/addcrys/addnull/addcc/additem/achieve> <value> ...`\n' +
                    '• Or auto-ID: `>control ccode <uses> <expire_secs> <addcoin/addcrys/addnull/addcc/additem/achieve> <value> ...`'
                );
            }

            let rewards = { coins: '0', crystals: '0', nulls: '0', cc: 0, tokens: 0, items: {}, achievements: [] };
            let pIdx = 0;
            try {
            while (pIdx < rewardPairs.length) {
                const k = rewardPairs[pIdx]?.toLowerCase();
                if (!k) break;
                pIdx++;
                if (k === 'addcoin') {
                    const v = rewardPairs[pIdx++];
                    if (v) rewards.coins = (BigInt(rewards.coins) + safeBigIntArg(v)).toString();
                } else if (k === 'addcrys') {
                    const v = rewardPairs[pIdx++];
                    if (v) rewards.crystals = (BigInt(rewards.crystals) + safeBigIntArg(v)).toString();
                } else if (k === 'addnull') {
                    const v = rewardPairs[pIdx++];
                    if (v) rewards.nulls = (BigInt(rewards.nulls) + safeBigIntArg(v)).toString();
                } else if (k === 'addcc') {
                    const v = rewardPairs[pIdx++];
                    if (v) rewards.cc += parseInt(v, 10) || 0;
                } else if (k === 'addtoken') {
                    const v = rewardPairs[pIdx++];
                    if (v) rewards.tokens += parseInt(v, 10) || 0;
                } else if (k === 'additem') {
                    const itemArg = rewardPairs[pIdx++];
                    if (itemArg) {
                        let itemId = itemArg;
                        let itemQty = 1;
                        if (itemArg.includes(':')) {
                            const parts = itemArg.split(':');
                            itemId = parts[0];
                            itemQty = parseInt(parts[1], 10) || 1;
                        } else if (pIdx < rewardPairs.length && /^\d+$/.test(rewardPairs[pIdx])) {
                            itemQty = parseInt(rewardPairs[pIdx++], 10) || 1;
                        }
                        rewards.items[itemId] = (rewards.items[itemId] || 0) + itemQty;
                    }
                } else if (k === 'achieve') {
                    const achId = rewardPairs[pIdx++];
                    if (achId) rewards.achievements.push(achId);
                }
            }
            } catch (err) {
                return message.channel.send(`❌ **Invalid reward value:** ${err.message}`);
            }

            const exp = expireSecs === 0 ? 0 : Date.now() + (expireSecs * 1000);
            try {
                await pool.execute(`REPLACE INTO codes (code, max_uses, current_uses, rewards, expires_at) VALUES (?, ?, 0, ?, ?)`, [codeName, maxUses, JSON.stringify(rewards), exp]);
                return message.channel.send(`✅ **Created Code:** \`${codeName}\`\nUses: ${maxUses === 0 ? '∞' : maxUses} | Exp: ${exp > 0 ? `<t:${Math.floor(exp / 1000)}:R>` : 'Never'}\nRewards: \`${JSON.stringify(rewards)}\``);
            } catch (err) {
                return message.channel.send(`❌ **DB Error:** ${err.message}`);
            }
        }

        let targetArg = args[0];
        let userAction = args[1]?.toLowerCase();
        let value = args[2];
        let qty = args[3];
        let extraArgs = args.slice(3);

        if (!targetArg || !userAction) {
            return message.channel.send('❌ Missing arguments. Use `>control help`.');
        }

        try {
            const targetInfo = await resolveTargetUser(client, targetArg);
            if (!targetInfo) {
                return message.channel.send(`❌ User \`${targetArg}\` was not found in the database or Discord.`);
            }

            const u = targetInfo.userDb;

            if (userAction === 'view') {
                const [iRows] = await pool.execute('SELECT * FROM items WHERE user_id = ? AND quantity > 0', [targetInfo.id]);
                const [aRows] = await pool.execute('SELECT * FROM active_potions WHERE user_id = ?', [targetInfo.id]);

                let itemStr = iRows.map(i => `${i.item_id}: x${i.quantity}`).join(', ') || 'None';
                let potStr = aRows.map(p => `${p.potion_id} (${p.rolls_left} rolls)`).join(', ') || 'None';

                const embed = new EmbedBuilder()
                    .setTitle(`🔍 Developer Inspection: ${targetInfo.displayName} (@${targetInfo.username})`)
                    .setColor(0x9B59B6)
                    .setThumbnail(targetInfo.avatarUrl)
                    .addFields(
                        { name: 'User ID', value: `\`${targetInfo.id}\``, inline: true },
                        { name: 'Privacy / Banned', value: `Privacy: \`${u.stat_privacy}\` | Banned: \`${u.is_banned || 0}\``, inline: true },
                        { name: '🪙 Coins', value: u.coins, inline: true },
                        { name: '💎 Crystals', value: u.crystals, inline: true },
                        { name: '⬛ Nulls', value: u.nulls, inline: true },
                        { name: '💠 CC', value: (u.cc_coins || 0).toString(), inline: true },
                        { name: '🎫 Quest Tokens', value: (u.quest_tokens || 0).toString(), inline: true },
                        { name: 'Perm / Fixed Luck', value: `+${u.permanent_basic_luck} / Fixed: ${u.fixed_luck || 0}`, inline: true },
                        { name: 'Total Rolls', value: (u.total_rolls || 0).toString(), inline: true },
                        { name: 'Equipped', value: `Mod: \`${u.equipped_module || 'None'}\` | Chip: \`${u.equipped_chip || 'None'}\``, inline: true },
                        { name: 'Active Potions', value: potStr.substring(0, 1024), inline: false },
                        { name: 'Owned Items', value: itemStr.substring(0, 1024), inline: false }
                    );
                return FrameManager.sendFrame(message, { embeds: [embed], components: [] }, message.author.id);
            }

            const validActions = [
                'addcoin', 'setcoin', 'addcrys', 'setcrys', 'addnull', 'setnull',
                'addcc', 'setcc', 'addtoken', 'settoken',
                'addperm', 'setperm', 'fixedluck', 'additem', 'removeitem',
                'giveachieve', 'givetitle', 'removeeffect', 'forcebshop',
                'deletedata',
                'ban', 'banland', 'unban'
            ];

            if (!validActions.includes(userAction)) {
                return message.channel.send(`❌ Invalid control action \`${userAction}\`. Type \`>control help\` for list.`);
            }

            const actionsWithoutValue = [
                'deletedata', 'forcebshop',
                'ban', 'banland', 'unban'
            ];
            if (!value && !actionsWithoutValue.includes(userAction)) {
                return message.channel.send(`❌ Missing value parameter for \`${userAction}\`.`);
            }

            const numErr = validateControlNumber(userAction, value);
            if (numErr) return message.channel.send(numErr);

            if (userAction === 'additem' || userAction === 'removeitem') {
                if (!POTIONS[value] && !MODULES[value] && !CHIPS[value]) {
                    return message.channel.send(`❌ Unknown item ID \`${value}\`. Use \`>control itemlist\` to see valid IDs.`);
                }
            } else if (userAction === 'giveachieve') {
                if (!ACHIEVEMENTS[value]) {
                    return message.channel.send(`❌ Unknown achievement ID \`${value}\`. Use \`>control achievelist\` to see valid IDs.`);
                }
            } else if (userAction === 'givetitle') {
                if (!TITLES[value]) {
                    return message.channel.send(`❌ Unknown title ID \`${value}\`. Use \`>control titlelist\` to see valid IDs.`);
                }
            }

            const token = createVerification(message.author.id, {
                source: 'control',
                action: userAction,
                targetId: targetInfo.id,
                value,
                qty,
                extraArgs
            }, 60000);

            const expUnix = Math.floor((Date.now() + 60000) / 1000);
            const verifyEmbed = new EmbedBuilder()
                .setTitle(`🛠️ Confirm: ${userAction}`)
                .setColor(0xE67E22)
                .setThumbnail(targetInfo.avatarUrl)
                .setDescription(
                    `Check details carefully before confirming:\n` +
                    `⏱️ Expires: <t:${expUnix}:R>`
                )
                .addFields(
                    {
                        name: 'Player',
                        value: `${targetInfo.displayName} (\`@${targetInfo.username}\`)\nID: \`${targetInfo.id}\``,
                        inline: true
                    },
                    {
                        name: 'Current Balance',
                        value:
                            `💠 ${u.cc_coins || 0} CC\n` +
                            `🪙 ${u.coins} | 💎 ${u.crystals} | ⬛ ${u.nulls}`,
                        inline: true
                    },
                    {
                        name: 'Operation',
                        value:
                            `Action: \`${userAction}\`\n` +
                            `Args: \`${[value, qty, ...(extraArgs?.slice(1) || [])].filter(Boolean).join(' ') || 'Default'}\``,
                        inline: false
                    }
                )
                .setFooter({ text: 'Click Confirm below or type >control confirm (60s)' });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`verify_confirm_${token}`)
                    .setLabel(`Confirm: ${userAction}`)
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`verify_cancel_${token}`)
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Danger)
            );

            await FrameManager.sendFrame(message, { embeds: [verifyEmbed], components: [row] }, message.author.id);
        } catch (e) {
            message.channel.send(`❌ **Error:** ${e.message}`);
        }
    }
};

const { SlashCommandBuilder } = require('discord.js');
const { saveUser, giveItem } = require('../../database/userModel');
const { grantAchievement } = require('../../systems/achievementSystem');
const { autoDelete, sendCooldownMsg } = require('../../utils/discord');

module.exports = {
    name: 'daily',
    description: 'Claim daily freebies',
    data: new SlashCommandBuilder()
        .setName('daily')
        .setDescription('Claim daily freebies'),

    async executePrefix(message, args, userDb) {
        await this.handleDaily(message, userDb);
    },

    async executeSlash(interaction, userDb) {
        await interaction.deferReply();
        await this.handleDaily(interaction, userDb);
    },

    async handleDaily(ctx, userDb) {
        let u = userDb;
        const now = Date.now();
        let d = Math.floor(now / 86400000);
        const nextResetMs = (d + 1) * 86400000;
        const nextResetUnix = Math.floor(nextResetMs / 1000);

        if (u.last_daily === d) {
            await sendCooldownMsg(ctx, nextResetMs, "You already claimed your daily today! Next daily resets");
            return;
        }

        u.last_daily = d;
        let tr = u.total_rolls;
        let rw = [];
        let gainedCrystals = 0n;

        if (tr < 1000) {
            let c = BigInt(Math.floor(Math.random() * 901) + 100);
            u.coins = (BigInt(u.coins) + c).toString();
            rw.push(`🪙 **${c.toLocaleString('en-US')} Coins**`);
            await giveItem(u.id, 'pot_luck', 1);
            rw.push(`🧪 **1x Luck Potion**`);
            if (Math.random() < 0.5) { await giveItem(u.id, 'pot_speed', 1); rw.push(`🧪 **1x Speed Potion**`); }
            if (Math.random() < 0.04) { gainedCrystals += 1n; rw.push(`💎 **1x Crystal**`); }
        }
        else if (tr < 10000) {
            let pct = Math.random() * 0.5 + 0.7;
            let c = BigInt(Math.floor(tr * pct));
            u.coins = (BigInt(u.coins) + c).toString();
            rw.push(`🪙 **${c.toLocaleString('en-US')} Coins**`);

            let fRoll = Math.random() * 100;
            if (fRoll < 5) { await giveItem(u.id, 'pot_fortune_3', 1); rw.push(`🧪 **1x Fortune III**`); }
            else if (fRoll < 25) { await giveItem(u.id, 'pot_fortune_2', 1); rw.push(`🧪 **1x Fortune II**`); }
            else { await giveItem(u.id, 'pot_fortune_1', 1); rw.push(`🧪 **1x Fortune I**`); }

            let wRoll = Math.random() * 100;
            if (wRoll < 4) { await giveItem(u.id, 'pot_windy_3', 1); rw.push(`🧪 **1x Windy III**`); }
            else if (wRoll < 20) { await giveItem(u.id, 'pot_windy_2', 1); rw.push(`🧪 **1x Windy II**`); }
            else { await giveItem(u.id, 'pot_windy_1', 1); rw.push(`🧪 **1x Windy I**`); }

            let crysChance = 0.04 + (Math.floor(tr / 100) * 0.001);
            if (Math.random() < crysChance) { gainedCrystals += 1n; rw.push(`💎 **1x Crystal**`); }
        }
        else if (tr < 100000) {
            let pct = Math.random() * 0.45 + 0.8;
            let c = BigInt(Math.floor(tr * pct));
            u.coins = (BigInt(u.coins) + c).toString();
            rw.push(`🪙 **${c.toLocaleString('en-US')} Coins**`);

            if (Math.random() < 0.6) { await giveItem(u.id, 'pot_fortune_2', 1); rw.push(`🧪 **1x Fortune II**`); }
            else { await giveItem(u.id, 'pot_fortune_3', 1); rw.push(`🧪 **1x Fortune III**`); }

            let wQty = Math.random() < 0.5 ? 2 : 1;
            await giveItem(u.id, 'pot_windy_3', wQty);
            rw.push(`🧪 **${wQty}x Windy III**`);

            if (Math.random() < 0.5) { await giveItem(u.id, 'pot_pop', 1); rw.push(`🧪 **1x Pop Potion**`); }
            if (Math.random() < 0.15) { await giveItem(u.id, 'pot_heavenly', 1); rw.push(`🧪 **1x Heavenly Potion**`); }

            let crysChance = 0.05 + (Math.floor(tr / 100) * 0.001);
            while (crysChance > 0) {
                if (Math.random() < crysChance) { gainedCrystals += 1n; }
                crysChance -= 1.0;
            }
            if (gainedCrystals > 0n) rw.push(`💎 **${gainedCrystals}x Crystal**`);
        }
        else if (tr < 1000000) {
            let pct = Math.random() * 0.5 + 0.9;
            let c = BigInt(Math.floor(tr * pct));
            u.coins = (BigInt(u.coins) + c).toString();
            rw.push(`🪙 **${c.toLocaleString('en-US')} Coins**`);

            let wQty = Math.random() < 0.5 ? 2 : 3;
            await giveItem(u.id, 'pot_windy_3', wQty);
            rw.push(`🧪 **${wQty}x Windy III**`);

            await giveItem(u.id, 'pot_pop', 1);
            rw.push(`🧪 **1x Pop Potion**`);

            if (Math.random() < 0.35) { await giveItem(u.id, 'pot_heavenly', 1); rw.push(`🧪 **1x Heavenly Potion**`); }
            if (Math.random() < 0.05) { await giveItem(u.id, 'pot_magic', 1); rw.push(`🧪 **1x Magic Potion**`); }

            let crysChance = 0.06 + (Math.floor(tr / 100) * 0.0025);
            while (crysChance > 0) {
                if (Math.random() < crysChance) { gainedCrystals += 1n; }
                crysChance -= 1.0;
            }
            if (gainedCrystals > 0n) rw.push(`💎 **${gainedCrystals}x Crystal**`);
        }
        else {
            let pct = Math.random() * 0.6 + 1.0;
            let c = BigInt(Math.floor(tr * pct));
            u.coins = (BigInt(u.coins) + c).toString();
            rw.push(`🪙 **${c.toLocaleString('en-US')} Coins**`);

            await giveItem(u.id, 'pot_windy_3', 5);
            rw.push(`🧪 **5x Windy III**`);

            await giveItem(u.id, 'pot_fortune_3', 2);
            rw.push(`🧪 **2x Fortune III**`);

            await giveItem(u.id, 'pot_heavenly', 1);
            rw.push(`🧪 **1x Heavenly Potion**`);

            if (Math.random() < 0.15) { await giveItem(u.id, 'pot_magic', 1); rw.push(`🧪 **1x Magic Potion**`); }
            if (Math.random() < 0.02) { await giveItem(u.id, 'pot_storm', 1); rw.push(`🧪 **1x Storm Potion**`); }

            let crysChance = 0.08 + (Math.floor(tr / 100) * 0.005);
            while (crysChance > 0) {
                if (Math.random() < crysChance) { gainedCrystals += 1n; }
                crysChance -= 1.0;
            }
            if (gainedCrystals > 0n) rw.push(`💎 **${gainedCrystals}x Crystal**`);
        }

        let achMsgs = [];
        if (gainedCrystals > 0n) {
            if (u.crystals === '0') {
                const a1 = await grantAchievement(u, 'miner');
                if (a1) achMsgs.push(a1);
            }
            u.crystals = (BigInt(u.crystals) + gainedCrystals).toString();
            if (BigInt(u.crystals) >= 100000n) {
                const a2 = await grantAchievement(u, 'geologist');
                if (a2) achMsgs.push(a2);
            }
        }

        await saveUser(u);
        const content = `🎁 **Daily Claimed!** You got:\n${rw.join('\n')}\n⏱️ Next daily available <t:${nextResetUnix}:R>.${achMsgs.length ? '\n' + achMsgs.join('\n') : ''}`;

        let m;
        if (typeof ctx.editReply === 'function' && (ctx.deferred || ctx.replied)) {
            m = await ctx.editReply({ content });
        } else if (ctx.channel) {
            m = await ctx.channel.send(content);
        }
        autoDelete(m, 30000);
    }
};

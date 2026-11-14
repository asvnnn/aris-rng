const { pool, saveUser, giveItem } = require('../../database/userModel');
const { grantAchievement } = require('../../systems/achievementSystem');
const { POTIONS, MODULES, CHIPS } = require('../../data/items');
const { autoDelete } = require('../../utils/discord');

module.exports = {
    name: 'code',
    description: 'Redeem a code',
    async executePrefix(message, args, userDb) {
        let cS = args[0];
        if (!cS) {
            const m = await message.channel.send("❌ Please provide a code to redeem.");
            autoDelete(m, 15000);
            return;
        }

        let u = userDb;

        const [cR] = await pool.execute('SELECT * FROM codes WHERE code = ?', [cS]);
        const c = cR[0];
        if (!c) {
            const m = await message.channel.send("❌ Invalid code.");
            autoDelete(m, 15000);
            return;
        }
        if (c.expires_at > 0 && Date.now() > c.expires_at) {
            const m = await message.channel.send(`❌ This code expired <t:${Math.floor(c.expires_at / 1000)}:R>.`);
            autoDelete(m, 15000);
            return;
        }
        if (c.max_uses > 0 && c.current_uses >= c.max_uses) {
            const m = await message.channel.send("❌ This code has reached its maximum redemption limit.");
            autoDelete(m, 15000);
            return;
        }

        const [insRedemp] = await pool.execute('INSERT IGNORE INTO code_redemptions (code, user_id) VALUES (?,?)', [cS, u.id]);
        if (insRedemp && insRedemp.affectedRows === 0) {
            const m = await message.channel.send("❌ You have already redeemed this code.");
            autoDelete(m, 15000);
            return;
        }

        const [updCode] = await pool.execute(
            'UPDATE codes SET current_uses = current_uses + 1 WHERE code = ? AND (max_uses = 0 OR current_uses < max_uses)',
            [cS]
        );
        if (updCode && updCode.affectedRows === 0) {
            await pool.execute('DELETE FROM code_redemptions WHERE code = ? AND user_id = ?', [cS, u.id]);
            const m = await message.channel.send("❌ This code has reached its maximum redemption limit.");
            autoDelete(m, 15000);
            return;
        }

        let rewards = {};
        try { rewards = JSON.parse(c.rewards || '{}'); } catch (err) {}

        let gained = [];
        if (rewards.coins && BigInt(rewards.coins) > 0n) { u.coins = (BigInt(u.coins) + BigInt(rewards.coins)).toString(); gained.push(`🪙 **${rewards.coins} Coins**`); }
        if (rewards.crystals && BigInt(rewards.crystals) > 0n) {
            if (u.crystals === '0') {
                const achMin = await grantAchievement(u, 'miner');
                if (achMin) gained.push(achMin);
            }
            u.crystals = (BigInt(u.crystals) + BigInt(rewards.crystals)).toString();
            gained.push(`💎 **${rewards.crystals} Crystals**`);
            if (BigInt(u.crystals) >= 100000n) {
                const achGeo = await grantAchievement(u, 'geologist');
                if (achGeo) gained.push(achGeo);
            }
        }
        if (rewards.nulls && BigInt(rewards.nulls) > 0n) { u.nulls = (BigInt(u.nulls) + BigInt(rewards.nulls)).toString(); gained.push(`⬛ **${rewards.nulls} Nulls**`); }
        if (rewards.cc && Number(rewards.cc) > 0) { u.cc_coins += Number(rewards.cc); gained.push(`💠 **${rewards.cc} CC**`); }
        if (rewards.tokens && Number(rewards.tokens) > 0) { u.quest_tokens = (parseInt(u.quest_tokens, 10) || 0) + parseInt(rewards.tokens, 10); gained.push(`🎫 **${rewards.tokens} Quest Tokens**`); }

        if (rewards.items) {
            for (let [iId, qty] of Object.entries(rewards.items)) {
                await giveItem(u.id, iId, qty);
                let iName = POTIONS[iId]?.name || MODULES[iId]?.name || CHIPS[iId]?.name || iId;
                gained.push(`📦 **${qty}x ${iName}**`);
            }
        }

        if (Array.isArray(rewards.achievements)) {
            for (const achId of rewards.achievements) {
                const aMsg = await grantAchievement(u, achId);
                if (aMsg) gained.push(aMsg);
            }
        }

        await saveUser(u);
        const m = await message.channel.send(`✅ Redeemed Code **${cS}**! Gained:\n${gained.join('\n') || 'Nothing'}`);
        autoDelete(m, 30000);
    }
};

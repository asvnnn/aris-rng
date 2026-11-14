const { getUser, saveUser, giveItem } = require('../database/userModel');
const QUESTS = require('../data/quests');
const { grantAchievement } = require('./achievementSystem');

function checkQuestCondition(q, userDb) {
    if (q.reqMod && userDb.equipped_module !== q.reqMod) {
        return false;
    }
    if (!q.condition) return true;
    const rolls = parseInt(userDb.total_rolls, 10) || 0;
    const cond = q.condition;
    if (cond === 'rolls < 150') return rolls < 150;
    if (cond === 'rolls >= 150 AND rolls <= 1000') return rolls >= 150 && rolls <= 1000;
    if (cond === 'rolls > 1000 AND rolls <= 7500') return rolls > 1000 && rolls <= 7500;
    if (cond === 'rolls > 7500') return rolls > 7500;
    if (cond === 'rolls > 100000') return rolls > 100000;
    if (cond === 'rolls < 250') return rolls < 250;
    if (cond === 'rolls >= 250 AND rolls <= 1000') return rolls >= 250 && rolls <= 1000;
    return true;
}

function generateQuests(userDb) {
    let availableQuests = QUESTS.filter(q => checkQuestCondition(q, userDb));

    let selected = [];
    while (selected.length < 3 && availableQuests.length > 0) {
        let idx = Math.floor(Math.random() * availableQuests.length);
        selected.push({ id: availableQuests[idx].id, progress: 0, claimed: false });
        availableQuests.splice(idx, 1);
    }
    
    if (selected.length < 3) {
        const fallbacks = ['q_roll_100', 'q_roll_200', 'q_pray_1'];
        for (let fb of fallbacks) {
            if (selected.length >= 3) break;
            if (!selected.find(x => x.id === fb)) selected.push({ id: fb, progress: 0, claimed: false });
        }
    }
    return selected;
}

async function rerollQuest(userOrId, questIndex) {
    let u = (userOrId && typeof userOrId === 'object') ? userOrId : await getUser(userOrId);
    let qData = JSON.parse(u.quest_data || '{}');

    if (!qData.quests || !qData.quests[questIndex]) return "❌ Quest not found.";
    if (qData.quests[questIndex].claimed) return "❌ Cannot reroll a claimed quest.";

    let costTokens = false;

    if (qData.rerolls > 0) {
        qData.rerolls--;
    } else {
        if (qData.token_reroll_used) return "❌ You already used your Token Reroll today.";
        if (u.quest_tokens < 3) return "❌ Not enough Quest Tokens (Need 3) to reroll.";
        costTokens = true;
    }

    let activeIds = qData.quests.map(q => q.id);
    let availableQuests = QUESTS.filter(q => {
        if (activeIds.includes(q.id)) return false;
        return checkQuestCondition(q, u);
    });

    if (availableQuests.length === 0) return "❌ No more quests available to reroll into.";

    let newQ = availableQuests[Math.floor(Math.random() * availableQuests.length)];
    qData.quests[questIndex] = { id: newQ.id, progress: 0, claimed: false };

    if (costTokens) {
        u.quest_tokens -= 3;
        qData.token_reroll_used = true;
    }

    u.quest_data = JSON.stringify(qData);
    await saveUser(u);
    return `✅ Quest rerolled successfully!`;
}

function ensureQuestDataInMemory(u) {
    let qData;
    try { qData = JSON.parse(u.quest_data || '{}'); } catch (e) { qData = {}; }
    let needsRegen = false;
    if (!qData.quests || !Array.isArray(qData.quests) || qData.quests.length < 3) needsRegen = true;
    else for (let q of qData.quests) if (!QUESTS.find(x => x.id === q.id)) needsRegen = true;

    if (needsRegen) {
        qData.quests = generateQuests(u);
        qData.rerolls = 1;
        qData.completed_today = 0;
        qData.token_reroll_used = false;
    }
    return qData;
}

function getQuestGoal(qTemplate) {
    if (!qTemplate) return 1;
    if (['roll_above', 'roll_below', 'roll_title'].includes(qTemplate.type)) {
        return 1;
    }
    return Number(qTemplate.target) || 1;
}

function applyQuestProgressInMemory(qData, type, amount = 1, extraData = null) {
    let updated = false;
    for (let q of qData.quests) {
        if (q.claimed) continue;
        let qTemplate = QUESTS.find(x => x.id === q.id);
        if (!qTemplate) continue;

        if (qTemplate.type === type) {
            const goal = getQuestGoal(qTemplate);
            if (type === 'roll_above' && extraData > qTemplate.target) { q.progress++; updated = true; }
            else if (type === 'roll_below' && extraData < qTemplate.target) { q.progress++; updated = true; }
            else if (type === 'roll_title' && extraData === qTemplate.target) { q.progress++; updated = true; }
            else if (type === 'roll' || type === 'pray' || type === 'spend') { q.progress += amount; updated = true; }

            if (q.progress > goal) q.progress = goal;
        }
    }
    return updated;
}

async function updateQuestProgress(userId, type, amount = 1, extraData = null) {
    let u = await getUser(userId);
    let qData = ensureQuestDataInMemory(u);
    const updated = applyQuestProgressInMemory(qData, type, amount, extraData);
    if (updated || !u.quest_data || u.quest_data === '{}') {
        u.quest_data = JSON.stringify(qData);
        await saveUser(u);
    }
}

async function claimQuest(userOrId, questIndex) {
    let u = (userOrId && typeof userOrId === 'object') ? userOrId : await getUser(userOrId);
    const userId = u.id;
    let qData = JSON.parse(u.quest_data || '{}');
    
    if (!qData.quests || !qData.quests[questIndex]) return "❌ Quest not found.";
    let q = qData.quests[questIndex];
    let qTemplate = QUESTS.find(x => x.id === q.id);
    
    if (!qTemplate) return "❌ Quest data is corrupted. Please reroll or wait for daily reset.";
    if (q.claimed) return "❌ Already claimed.";
    const goal = getQuestGoal(qTemplate);
    if (q.progress < goal) return "❌ Quest not completed yet.";

    q.claimed = true;
    u.quest_tokens = (parseInt(u.quest_tokens) || 0) + 1; 
    qData.completed_today = (qData.completed_today || 0) + 1;
    
    let rewardText = [];
    if (qTemplate.reward.coins) { u.coins = (BigInt(u.coins) + BigInt(qTemplate.reward.coins)).toString(); rewardText.push(`🪙 ${qTemplate.reward.coins}`); }
    if (qTemplate.reward.nulls) { u.nulls = (BigInt(u.nulls) + BigInt(qTemplate.reward.nulls)).toString(); rewardText.push(`⬛ ${qTemplate.reward.nulls}`); }
    if (qTemplate.reward.items) {
        for (let [iId, qty] of Object.entries(qTemplate.reward.items)) {
            await giveItem(userId, iId, qty);
            rewardText.push(`📦 ${qty}x ${iId}`);
        }
    }

    u.total_quests_completed = (parseInt(u.total_quests_completed) || 0) + 1;
    let aMsgs = [];
    if (qData.completed_today === 3) { let a = await grantAchievement(u, 'finished_work'); if(a) aMsgs.push(a); }
    if (u.total_quests_completed >= 21) { let a = await grantAchievement(u, 'good_job'); if(a) aMsgs.push(a); }
    if (u.total_quests_completed >= 42) { let a = await grantAchievement(u, 'two_full_weeks'); if(a) aMsgs.push(a); }
    if (u.total_quests_completed >= 90) { let a = await grantAchievement(u, 'my_pay'); if(a) aMsgs.push(a); }
    if (u.total_quests_completed >= 300) { let a = await grantAchievement(u, 'exploitative_capitalism'); if(a) aMsgs.push(a); }

    u.quest_data = JSON.stringify(qData);
    await saveUser(u);
    
    return `✅ Quest Completed! Gained: **1x 🎫 Quest Token** & ${rewardText.join(', ')}.${aMsgs.length ? '\n'+aMsgs.join('\n') : ''}`;
}

module.exports = {
    generateQuests,
    getQuestGoal,
    ensureQuestDataInMemory,
    applyQuestProgressInMemory,
    updateQuestProgress,
    claimQuest,
    rerollQuest
};

const { pool, getUser } = require('../database/userModel');
const { grantAchievement } = require('./achievementSystem');
const { acquireLock, releaseLock } = require('../utils/discord');

function createEmptyLbCache() {
    return {
        rolls: [], score: [], pos: [], neg: [],
        weekly: { rolls: [], score: [], pos: [], neg: [] },
        monthly: { rolls: [], score: [], pos: [], neg: [] },
        lastUpdate: 0
    };
}

const lbCache = createEmptyLbCache();
let isUpdating = false;

async function updateLeaderboard(force = false) {
    if (isUpdating) return;
    isUpdating = true;

    try {
        const now = Date.now();
        if (!force && now - lbCache.lastUpdate < 300000 && lbCache.lastUpdate !== 0) return;

        const [r] = await pool.execute('SELECT id, username, total_rolls, stat_privacy FROM users ORDER BY total_rolls DESC LIMIT 100');
        lbCache.rolls = r;

        const [s] = await pool.execute('SELECT id, username, total_score, stat_privacy FROM users ORDER BY CAST(total_score AS DECIMAL(65, 0)) DESC LIMIT 100');
        lbCache.score = s;

        const [p] = await pool.execute('SELECT id, username, highest_pos, stat_privacy FROM users ORDER BY CAST(highest_pos AS DECIMAL(65, 0)) DESC LIMIT 100');
        lbCache.pos = p;

        const [n] = await pool.execute('SELECT id, username, lowest_neg, stat_privacy FROM users WHERE CAST(lowest_neg AS DECIMAL(65, 0)) < 0 ORDER BY CAST(lowest_neg AS DECIMAL(65, 0)) ASC LIMIT 100');
        lbCache.neg = n;

        try {
            const curWeek = Math.floor(now / (7 * 86400000));
            const dt = new Date(now);
            const curMonth = dt.getUTCFullYear() * 12 + dt.getUTCMonth();

            const wR = await pool.execute('SELECT id, username, weekly_rolls AS total_rolls, stat_privacy FROM users WHERE utc_week = ? AND weekly_rolls > 0 ORDER BY weekly_rolls DESC LIMIT 100', [curWeek]);
            const wP = await pool.execute('SELECT id, username, weekly_pos AS highest_pos, stat_privacy FROM users WHERE utc_week = ? AND CAST(weekly_pos AS DECIMAL(65, 0)) > 0 ORDER BY CAST(weekly_pos AS DECIMAL(65, 0)) DESC LIMIT 100', [curWeek]);
            const wN = await pool.execute('SELECT id, username, weekly_neg AS lowest_neg, stat_privacy FROM users WHERE utc_week = ? AND CAST(weekly_neg AS DECIMAL(65, 0)) < 0 ORDER BY CAST(weekly_neg AS DECIMAL(65, 0)) ASC LIMIT 100', [curWeek]);

            lbCache.weekly = {
                rolls: (wR && wR[0]) ? wR[0] : lbCache.rolls,
                score: lbCache.score,
                pos: (wP && wP[0]) ? wP[0] : lbCache.pos,
                neg: (wN && wN[0]) ? wN[0] : lbCache.neg
            };

            const mR = await pool.execute('SELECT id, username, monthly_rolls AS total_rolls, stat_privacy FROM users WHERE utc_month = ? AND monthly_rolls > 0 ORDER BY monthly_rolls DESC LIMIT 100', [curMonth]);
            const mP = await pool.execute('SELECT id, username, monthly_pos AS highest_pos, stat_privacy FROM users WHERE utc_month = ? AND CAST(monthly_pos AS DECIMAL(65, 0)) > 0 ORDER BY CAST(monthly_pos AS DECIMAL(65, 0)) DESC LIMIT 100', [curMonth]);
            const mN = await pool.execute('SELECT id, username, monthly_neg AS lowest_neg, stat_privacy FROM users WHERE utc_month = ? AND CAST(monthly_neg AS DECIMAL(65, 0)) < 0 ORDER BY CAST(monthly_neg AS DECIMAL(65, 0)) ASC LIMIT 100', [curMonth]);

            lbCache.monthly = {
                rolls: (mR && mR[0]) ? mR[0] : lbCache.rolls,
                score: lbCache.score,
                pos: (mP && mP[0]) ? mP[0] : lbCache.pos,
                neg: (mN && mN[0]) ? mN[0] : lbCache.neg
            };
        } catch (e) {
            lbCache.weekly = { rolls: lbCache.rolls, score: lbCache.score, pos: lbCache.pos, neg: lbCache.neg };
            lbCache.monthly = { rolls: lbCache.rolls, score: lbCache.score, pos: lbCache.pos, neg: lbCache.neg };
        }

        if (lbCache.rolls[0] && lbCache.score[0] && lbCache.pos[0] && lbCache.neg[0]) {
            let topR = lbCache.rolls[0].id;
            if (topR === lbCache.score[0].id && topR === lbCache.pos[0].id && topR === lbCache.neg[0].id) {
                await acquireLock(topR);
                try {
                    let uTop = await getUser(topR);
                    await grantAchievement(uTop, 'king_of_kings');
                } finally {
                    releaseLock(topR);
                }
            }
        }

        lbCache.lastUpdate = now;
    } catch (e) {
        console.error("❌ Leaderboard Update Error:", e.message);
    } finally {
        isUpdating = false;
    }
}

function getLeaderboardCache() {
    return lbCache;
}

const lbTimer = setInterval(() => updateLeaderboard(false), 300000);
if (typeof lbTimer.unref === 'function') lbTimer.unref();

module.exports = { updateLeaderboard, getLeaderboardCache };

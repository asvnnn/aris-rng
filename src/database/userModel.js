const pool = require('./connection');

const reqUserCols = {
    username: "VARCHAR(64)", coins: "VARCHAR(64) DEFAULT '0'", crystals: "VARCHAR(64) DEFAULT '0'", nulls: "VARCHAR(64) DEFAULT '0'",
    cc_coins: "BIGINT DEFAULT 0", cg_coins: "BIGINT DEFAULT 0", 
    slots: "INT DEFAULT 10", best_roll: "VARCHAR(64) DEFAULT '0'", last_daily: "BIGINT DEFAULT 0",
    last_roll: "BIGINT DEFAULT 0", equipped_module: "VARCHAR(64)", equipped_title: "VARCHAR(64)", equipped_chip: "VARCHAR(64)",
    equipped_achieve: "VARCHAR(64)", glitch_counter: "INT DEFAULT 0", godly_counter: "INT DEFAULT 0",
    glitch_basic: "DOUBLE DEFAULT 0", glitch_cd: "DOUBLE DEFAULT 0", glitch_multi: "DOUBLE DEFAULT 0",
    total_rolls: "INT DEFAULT 0", utc_day: "INT DEFAULT 0",
    auto_sell_threshold: "VARCHAR(64) DEFAULT '0'", auto_sell_threshold_neg: "VARCHAR(64) DEFAULT '0'", 
    stat_privacy: "INT DEFAULT 0", luck_toggle: "INT DEFAULT 1", null_counter: "INT DEFAULT 0",
    crystal_maker_pity: "INT DEFAULT 0", crystal_module_pity: "INT DEFAULT 0",
    stalker_counter: "INT DEFAULT 0", total_potions_consumed: "INT DEFAULT 0",
    cook_counter: "INT DEFAULT 0", permanent_basic_luck: "DOUBLE DEFAULT 0.0",
    last_pray: "BIGINT DEFAULT 0", pray_count: "INT DEFAULT 0", pray_cd_attempts: "INT DEFAULT 0",
    last_roll_val: "VARCHAR(64) DEFAULT '0'", low_roll_streak: "INT DEFAULT 0",
    error_chip_counter: "INT DEFAULT 0", error_chip_basic: "DOUBLE DEFAULT 0",
    error_chip_cd: "DOUBLE DEFAULT 0", error_chip_multi: "DOUBLE DEFAULT 0",
    luminous_proc: "INT DEFAULT 0", daily_purchases: "TEXT",
    total_score: "VARCHAR(64) DEFAULT '0'", highest_pos: "VARCHAR(64) DEFAULT '0'", lowest_neg: "VARCHAR(64) DEFAULT '0'",
    unlocked_titles: "TEXT", cmd_count_since_roll: "INT DEFAULT 0",
    is_colorful: "INT DEFAULT 0", custom_color: "VARCHAR(64) DEFAULT ''",
    custom_titles: "TEXT",
    quest_data: "TEXT", quest_tokens: "INT DEFAULT 0",
    evanescent_counter: "INT DEFAULT 0", sognare_counter: "INT DEFAULT 0",
    crystallized_counter: "INT DEFAULT 0",
    titles_rolled: "INT DEFAULT 0",
    custom_banner: "VARCHAR(255) DEFAULT ''",
    bshop_ping: "INT DEFAULT 1",
    total_quests_completed: "INT DEFAULT 0",
    fixed_luck: "DOUBLE DEFAULT 0",
    eh_counter: "INT DEFAULT 0",
    eh_basic_acc: "INT DEFAULT 0",
    eh_singularity_active: "INT DEFAULT 0",
    purgatori_counter: "INT DEFAULT 0",
    purgatori_stack: "DOUBLE DEFAULT 0",
    last_roll_luck: "DOUBLE DEFAULT 1",
    dd_counter: "INT DEFAULT 0",
    duality_counter: "INT DEFAULT 0",
    circulation_stack: "INT DEFAULT 0",
    supernova_chk_counter: "INT DEFAULT 0",
    tnt_counter: "INT DEFAULT 0",
    eon_streak: "INT DEFAULT 0",
    is_banned: "INT DEFAULT 0",
    artistry_unlocked: "INT DEFAULT 0",
    bz_roll_window: "INT DEFAULT 0",
    bz_727_count: "INT DEFAULT 0",
    roll_streak_days: "INT DEFAULT 0",
    last_roll_day: "INT DEFAULT 0",
    crash_state: "TEXT",
    quest_cc_week: "INT DEFAULT 0",
    kisaragi_counter: "INT DEFAULT 0",
    equinox_state: "INT DEFAULT 0",
    equinox_pos_charge: "INT DEFAULT 0",
    equinox_boost_active: "INT DEFAULT 0",
    equinox_dual_pending: "INT DEFAULT 0",
    pixelation_roll_count: "INT DEFAULT 0",
    pixelation_n: "INT DEFAULT 0",
    pixelation_detonation: "INT DEFAULT 0",
    pixelation_title_count: "INT DEFAULT 0",
    pixelation_boost_active: "INT DEFAULT 0",
    hide_equip: "INT DEFAULT 0",
    recent_rolls: "TEXT",
    weekly_rolls: "INT DEFAULT 0",
    monthly_rolls: "INT DEFAULT 0",
    weekly_score: "VARCHAR(64) DEFAULT '0'",
    monthly_score: "VARCHAR(64) DEFAULT '0'",
    weekly_pos: "VARCHAR(64) DEFAULT '0'",
    monthly_pos: "VARCHAR(64) DEFAULT '0'",
    weekly_neg: "VARCHAR(64) DEFAULT '0'",
    monthly_neg: "VARCHAR(64) DEFAULT '0'",
    utc_week: "INT DEFAULT 0",
    utc_month: "INT DEFAULT 0",
    ad_data: "TEXT"
};

async function initSchemaOnPool(targetPool, includeLicensesTable = false) {
    await targetPool.execute(`CREATE TABLE IF NOT EXISTS users (id VARCHAR(64) PRIMARY KEY)`);
    await targetPool.execute(`CREATE TABLE IF NOT EXISTS inventory (id INT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(64), roll_value VARCHAR(64), is_locked INT DEFAULT 0)`);
    await targetPool.execute(`CREATE TABLE IF NOT EXISTS items (user_id VARCHAR(64), item_id VARCHAR(64), quantity INT, PRIMARY KEY (user_id, item_id))`);
    await targetPool.execute(`CREATE TABLE IF NOT EXISTS active_potions (user_id VARCHAR(64), potion_id VARCHAR(64), \`rank\` VARCHAR(64), rolls_left INT, PRIMARY KEY (user_id, potion_id))`);
    await targetPool.execute(`CREATE TABLE IF NOT EXISTS achievements (user_id VARCHAR(64), achievement_id VARCHAR(64), unlocked_at BIGINT, PRIMARY KEY (user_id, achievement_id))`);
    await targetPool.execute(`CREATE TABLE IF NOT EXISTS codes (code VARCHAR(64) PRIMARY KEY, max_uses INT, current_uses INT DEFAULT 0, rewards TEXT, expires_at BIGINT)`);
    await targetPool.execute(`CREATE TABLE IF NOT EXISTS code_redemptions (code VARCHAR(64), user_id VARCHAR(64), PRIMARY KEY (code, user_id))`);

    if (includeLicensesTable) {
        await targetPool.execute(
            `CREATE TABLE IF NOT EXISTS bot_settings (
                setting_key VARCHAR(64) PRIMARY KEY,
                setting_val VARCHAR(255)
            )`
        );
    }

    const [cols] = await targetPool.execute('SHOW COLUMNS FROM users');
    const existing = cols.map(c => c.Field);
    for (const [cName, cDef] of Object.entries(reqUserCols)) {
        if (!existing.includes(cName)) {
            try { await targetPool.execute(`ALTER TABLE users ADD COLUMN ${cName} ${cDef}`); } catch (e) {}
        }
    }
    try { await targetPool.execute('ALTER TABLE users MODIFY COLUMN cc_coins BIGINT DEFAULT 0'); } catch (e) {}
    try { await targetPool.execute('ALTER TABLE users MODIFY COLUMN cg_coins BIGINT DEFAULT 0'); } catch (e) {}

    const indexQueries = [
        `CREATE INDEX idx_inv_user ON inventory (user_id)`,
        `CREATE INDEX idx_items_user ON items (user_id)`,
        `CREATE INDEX idx_active_pots_user ON active_potions (user_id)`,
        `CREATE INDEX idx_ach_user ON achievements (user_id)`,
        `CREATE INDEX idx_users_username ON users (username)`
    ];
    for (const idxSql of indexQueries) {
        try { await targetPool.execute(idxSql); } catch (e) {}
    }
}

let initPromise = null;

async function initDB() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        try {
            if (typeof pool.ensureLocalDatabaseExists === 'function') {
                await pool.ensureLocalDatabaseExists();
            }
            await initSchemaOnPool(pool, true);
        } catch (e) {
            initPromise = null;
            console.error("❌ DB Error:", e.message);
        }
    })();
    return initPromise;
}

async function getUser(userId, username = null) {
    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    let u = rows[0];
    let needsSave = false;

    if (!u) {
        await pool.execute('INSERT INTO users (id, username, daily_purchases, unlocked_titles, custom_titles, quest_data) VALUES (?, ?, ?, ?, ?, ?)', 
            [userId, username || 'Unknown', '{}', '[]', '{}', '{}']);
        const [n] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]); 
        u = n[0];
    }

    const snap = {};
    for (const k of Object.keys(reqUserCols)) {
        if (u[k] !== undefined) snap[k] = u[k];
    }
    Object.defineProperty(u, '_dbSnapshot', { value: snap, enumerable: false, writable: true, configurable: true });

    if (username && u.username !== username) {
        u.username = username;
        needsSave = true;
    }
    
    u.daily_purchases = u.daily_purchases || '{}'; 
    u.unlocked_titles = u.unlocked_titles || '[]';
    u.custom_titles = u.custom_titles || '{}';
    u.quest_data = u.quest_data || '{}';
    u.crash_state = u.crash_state || '{}';
    u.recent_rolls = u.recent_rolls || '[]';
    
    const now = Date.now();
    const d = Math.floor(now / 86400000);
    if (u.utc_day !== d) { 
        u.utc_day = d;
        u.daily_purchases = '{}';
        u.quest_data = '{}'; 
        needsSave = true;
    }

    const curWeek = Math.floor(now / (7 * 86400000));
    if (u.utc_week !== undefined && u.utc_week !== curWeek) {
        u.utc_week = curWeek;
        u.weekly_rolls = 0;
        u.weekly_score = '0';
        u.weekly_pos = '0';
        u.weekly_neg = '0';
        needsSave = true;
    }

    const dt = new Date(now);
    const curMonth = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
    if (u.utc_month !== undefined && u.utc_month !== curMonth) {
        u.utc_month = curMonth;
        u.monthly_rolls = 0;
        u.monthly_score = '0';
        u.monthly_pos = '0';
        u.monthly_neg = '0';
        needsSave = true;
    }

    if (needsSave) {
        await saveUser(u);
    }
    return u;
}

async function saveUser(u) {
    if (!u || !u.id) return;
    const allKeys = Object.keys(u).filter(k => reqUserCols[k]);
    let keysToUpdate = allKeys;

    if (u._dbSnapshot) {
        keysToUpdate = allKeys.filter(k => u[k] !== u._dbSnapshot[k]);
        if (keysToUpdate.length === 0) return;
    }

    const sets = keysToUpdate.map(k => `\`${k}\` = ?`).join(', ');
    const vals = keysToUpdate.map(k => u[k] !== undefined ? u[k] : null);
    vals.push(u.id);
    await pool.execute(`UPDATE users SET ${sets} WHERE id = ?`, vals);

    if (u._dbSnapshot) {
        for (const k of keysToUpdate) {
            u._dbSnapshot[k] = u[k];
        }
    }
}

const MAX_SQL_INT = 2147483647;

async function giveItem(uId, iId, qty) {
    const safeAdd = Math.max(0, Math.min(MAX_SQL_INT, Math.floor(Number(qty) || 0)));
    if (safeAdd <= 0) return;
    await pool.execute(
        'INSERT INTO items (user_id, item_id, quantity) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE quantity = LEAST(quantity + VALUES(quantity), ?)',
        [uId, iId, safeAdd, MAX_SQL_INT]
    );
}

async function takeItem(uId, iId, qty) {
    const safeTake = Math.max(0, Math.floor(Number(qty) || 0));
    if (safeTake <= 0) return false;
    const [res] = await pool.execute(
        'UPDATE items SET quantity = quantity - ? WHERE user_id=? AND item_id=? AND quantity >= ?',
        [safeTake, uId, iId, safeTake]
    );
    if (!res || !res.affectedRows) return false;
    await pool.execute('DELETE FROM items WHERE user_id=? AND item_id=? AND quantity <= 0', [uId, iId]);
    return true;
}

async function getBShopOptedInUsers(maxInactiveDays = 7) {
    try {
        const cutoff = Date.now() - (maxInactiveDays * 24 * 60 * 60 * 1000);
        const [rows] = await pool.execute(
            `SELECT id FROM users 
             WHERE (bshop_ping = 1 OR (bshop_ping IS NOT NULL AND bshop_ping != 0))
               AND (is_banned = 0 OR is_banned IS NULL)
               AND (
                   last_roll >= ? 
                   OR last_daily >= ? 
                   OR last_pray >= ?
               )`,
            [cutoff, cutoff, cutoff]
        );
        if (!Array.isArray(rows)) return [];
        return rows.map(r => String(r.id)).filter(Boolean);
    } catch (e) {
        return [];
    }
}

module.exports = { initDB, getUser, saveUser, giveItem, takeItem, pool, reqUserCols, getBShopOptedInUsers };

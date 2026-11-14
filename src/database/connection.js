const mysql = require('mysql2/promise');
const {
    DATABASE_URL,
    DB_HOST,
    DB_PORT,
    DB_USER,
    DB_PASSWORD,
    DB_NAME,
    DB_CONNECTION_LIMIT,
    DB_SSL
} = require('../config/constants');

function sanitizeDbUrl(rawUrl) {
    let url = (rawUrl || '').trim();
    if (url.includes('ssl-mode=REQUIRED')) {
        url = url.replace(/([?&])ssl-mode=REQUIRED(&?)/, (match, p1, p2) => (p1 === '?' && p2 === '&' ? '?' : ''));
    }
    return url;
}

const mainDbUrl = sanitizeDbUrl(DATABASE_URL);

const isLocalMain = !mainDbUrl || mainDbUrl.includes('localhost') || mainDbUrl.includes('127.0.0.1');
const useSslMain = (DB_SSL || (DATABASE_URL && DATABASE_URL.includes('ssl-mode=REQUIRED'))) && !isLocalMain;

const isTestEnv = process.env.NODE_ENV === 'test';

const basePoolConfig = {
    waitForConnections: true,
    connectionLimit: DB_CONNECTION_LIMIT || 10,
    maxIdle: isTestEnv ? (DB_CONNECTION_LIMIT || 10) : Math.min(4, DB_CONNECTION_LIMIT || 10),
    idleTimeout: isTestEnv ? 0 : 60000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 10000
};

const mainPoolConfig = mainDbUrl
    ? { uri: mainDbUrl, ...basePoolConfig, ssl: useSslMain ? { rejectUnauthorized: false } : undefined }
    : {
        host: DB_HOST || '127.0.0.1',
        port: DB_PORT || 3306,
        user: DB_USER || 'root',
        password: DB_PASSWORD || '',
        database: DB_NAME || 'aris_db',
        ...basePoolConfig
    };

async function ensureLocalDatabaseExists() {
    let targetHost = DB_HOST || '127.0.0.1';
    let targetPort = DB_PORT || 3306;
    let targetUser = DB_USER || 'root';
    let targetPass = DB_PASSWORD || '';
    let targetMainDb = DB_NAME || 'aris_db';

    if (mainDbUrl && isLocalMain) {
        try {
            const parsed = new URL(mainDbUrl);
            targetHost = parsed.hostname || targetHost;
            targetPort = parseInt(parsed.port, 10) || targetPort;
            targetUser = decodeURIComponent(parsed.username || targetUser);
            targetPass = decodeURIComponent(parsed.password || targetPass);
            const pathDb = parsed.pathname.replace(/^\//, '').trim();
            if (pathDb) targetMainDb = pathDb;
        } catch (e) {}
    } else if (mainDbUrl && !isLocalMain) {
        return;
    }

    try {
        const tempConn = await mysql.createConnection({
            host: targetHost,
            port: targetPort,
            user: targetUser,
            password: targetPass,
            connectTimeout: 5000
        });
        if (/^[a-zA-Z0-9_]+$/.test(targetMainDb)) {
            await tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${targetMainDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        }
        await tempConn.end();
    } catch (e) {
    }
}

const pool = mysql.createPool(mainPoolConfig);

function unrefPoolIdleTimer(p) {
    const rawPool = p.pool;
    if (!rawPool) return;
    const origRemove = rawPool._removeIdleTimeoutConnections;
    if (typeof origRemove === 'function') {
        rawPool._removeIdleTimeoutConnections = function (...args) {
            origRemove.apply(this, args);
            if (this._removeIdleTimeoutConnectionsTimer?.unref) {
                this._removeIdleTimeoutConnectionsTimer.unref();
            }
        };
    }
    if (rawPool._removeIdleTimeoutConnectionsTimer?.unref) {
        rawPool._removeIdleTimeoutConnectionsTimer.unref();
    }
}

unrefPoolIdleTimer(pool);

pool.ensureLocalDatabaseExists = ensureLocalDatabaseExists;

pool.on('error', (err) => console.error('❌ Main MySQL Pool Error:', err));

pool.closePool = async () => {
    try {
        await pool.end();
        console.log('🛑 MySQL Connection Pool closed cleanly.');
    } catch (err) {
        console.error('❌ Error closing MySQL Pool:', err.message);
    }
};

module.exports = pool;

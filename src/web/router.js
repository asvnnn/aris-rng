const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const webService = require('./webService');
const { POTIONS, MODULES, CHIPS } = require('../data/items');
const { DEV_IDS, CLIENT_ID, TOKEN } = require('../config/constants');
const { pool, getUser, saveUser } = require('../database/userModel');
const { dispatchTerminalCommand } = require('./commandDispatcher');
const {
    createSession,
    getSessionByToken,
    destroySession,
    touchWebPresence,
    checkWebRateLimit,
    createAuthOtp,
    verifyAndConsumeAuthOtp,
    verifyAndConsumeMagicToken
} = require('./sessionLock');
const { getMainClient, acquireLock, releaseLock } = require('../utils/discord');

const PUBLIC_DIR = path.join(__dirname, '../../public');

const lastOtpSentTimes = new Map();

const SECURITY_HEADERS = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: https: blob:",
        "media-src 'self' data: blob: https:",
        "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com",
        "connect-src 'self' https://discord.com https://generativelanguage.googleapis.com"
    ].join('; ')
};

function getDiscordClientId() {
    if (CLIENT_ID && /^\d+$/.test(CLIENT_ID)) return CLIENT_ID;
    if (TOKEN && typeof TOKEN === 'string' && TOKEN.includes('.')) {
        try {
            const decoded = Buffer.from(TOKEN.split('.')[0], 'base64').toString('utf8');
            if (/^\d+$/.test(decoded)) return decoded;
        } catch (e) {}
    }
    return '';
}

function parseCookies(req) {
    const raw = req.headers['cookie'] || '';
    const out = {};
    if (!raw) return out;
    for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx > 0) {
            const k = part.slice(0, idx).trim();
            const v = part.slice(idx + 1).trim();
            out[k] = decodeURIComponent(v);
        }
    }
    return out;
}

function getSessionFromReq(req, parsedUrl) {
    const authHeader = req.headers['authorization'] || '';
    let token = '';
    if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
    } else if (req.headers['x-session-token']) {
        token = String(req.headers['x-session-token']).trim();
    } else if (parsedUrl && parsedUrl.searchParams && parsedUrl.searchParams.get('token')) {
        token = parsedUrl.searchParams.get('token').trim();
    } else {
        const cookies = parseCookies(req);
        if (cookies.aris_session) {
            token = cookies.aris_session.trim();
        }
    }
    const sess = getSessionByToken(token);
    if (sess) {
        touchWebPresence(sess.userId);
    }
    return sess;
}

function resolveAuthorizedUser(req, parsedUrl, requestedUserId) {
    const sess = getSessionFromReq(req, parsedUrl);
    if (sess) {
        if (requestedUserId && String(requestedUserId) !== String(sess.userId)) {
            if (!sess.isDev) {
                return {
                    ok: false,
                    status: 403,
                    error: 'Forbidden: You are not authorized to access or modify another player account.'
                };
            }
            return { ok: true, userId: String(requestedUserId), session: sess };
        }
        return { ok: true, userId: String(sess.userId), session: sess };
    }

    if (process.env.NODE_ENV === 'test' && requestedUserId) {
        if (!/^\d{15,22}$/.test(String(requestedUserId).trim())) {
            return {
                ok: false,
                status: 400,
                error: 'Invalid Discord User ID format.'
            };
        }
        touchWebPresence(String(requestedUserId));
        return { ok: true, userId: String(requestedUserId), session: null };
    }

    return {
        ok: false,
        status: 401,
        error: 'Authentication required. Please sign in with Discord OAuth2.'
    };
}

function fetchDiscordUserByAccessToken(accessToken) {
    return new Promise((resolve, reject) => {
        const req = https.request('https://discord.com/api/v10/users/@me', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': 'ARIS-Web-OS/2.0'
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Discord API returned ${res.statusCode}`));
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function exchangeDiscordOAuthCode(code, redirectUri) {
    return new Promise((resolve, reject) => {
        const clientId = getDiscordClientId();
        const clientSecret = process.env.CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET || '';
        if (!clientId || !clientSecret) {
            return reject(new Error('CLIENT_SECRET is not configured in .env for OAuth2 code exchange.'));
        }
        const postData = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: String(redirectUri)
        }).toString();

        const req = https.request('https://discord.com/api/v10/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'ARIS-Web-OS/2.0'
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body || '{}');
                    if (res.statusCode !== 200 || !parsed.access_token) {
                        return reject(new Error(parsed.error_description || parsed.error || `OAuth2 token exchange failed (${res.statusCode})`));
                    }
                    resolve(parsed);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function discordBotRest(method, apiPath, payload = null) {
    return new Promise((resolve, reject) => {
        if (!TOKEN) return reject(new Error('Bot TOKEN not configured in .env'));
        const bodyStr = payload ? JSON.stringify(payload) : '';
        const headers = {
            'Authorization': `Bot ${TOKEN}`,
            'User-Agent': 'ARIS-Web-OS/2.0'
        };
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }
        const req = https.request(`https://discord.com/api/v10${apiPath}`, {
            method,
            headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = {};
                try { parsed = JSON.parse(data || '{}'); } catch (e) {}
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(parsed);
                } else {
                    reject(new Error(parsed.message || `Discord REST ${res.statusCode}`));
                }
            });
        });
        req.on('error', reject);
        if (payload) req.write(bodyStr);
        req.end();
    });
}

async function sendDiscordOtpDm(userId, otp, magicUrl) {
    const contentMsg =
        `🔐 **A.R.I.S Web OS — Security Verification**\n` +
        `Your 6-digit security code is: **\`${otp}\`** *(valid for 5 minutes)*\n\n` +
        `Enter this code on the Web OS login screen to sign in immediately.\n` +
        `🔗 *Or sign in with 1-click instant link:*\n${magicUrl}\n\n` +
        `⚠️ *Never share this code or link with anyone.*`;

    try {
        const mainClient = getMainClient();
        if (mainClient && typeof mainClient.isReady === 'function' && mainClient.isReady()) {
            const discordUser = await mainClient.users.fetch(String(userId));
            if (discordUser) {
                await discordUser.send({ content: contentMsg });
                return { ok: true, username: discordUser.username };
            }
        }
    } catch (e) {
    }

    const dmChannel = await discordBotRest('POST', '/users/@me/channels', { recipient_id: String(userId) });
    if (!dmChannel || !dmChannel.id) {
        throw new Error('Could not open a DM channel with your Discord account.');
    }
    await discordBotRest('POST', `/channels/${dmChannel.id}/messages`, { content: contentMsg });
    const recipient = dmChannel.recipients && dmChannel.recipients[0];
    return {
        ok: true,
        username: recipient ? recipient.username : null
    };
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const STATIC_CACHE = new Map();
const COMPRESSIBLE_EXTS = new Set(['.html', '.css', '.js', '.json', '.md', '.txt', '.svg']);

function getCachedStatic(filePath, contentType, stats) {
    const cached = STATIC_CACHE.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs) {
        return cached;
    }
    try {
        const raw = fs.readFileSync(filePath);
        const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
        const ext = path.extname(filePath).toLowerCase();
        let gzipped = null;
        if (COMPRESSIBLE_EXTS.has(ext)) {
            try {
                gzipped = zlib.gzipSync(raw, { level: 6 });
            } catch (e) {
                gzipped = null;
            }
        }
        const entry = {
            raw,
            gzipped,
            mtimeMs: stats.mtimeMs,
            etag,
            contentType
        };
        if (STATIC_CACHE.size > 50) STATIC_CACHE.clear();
        STATIC_CACHE.set(filePath, entry);
        return entry;
    } catch (e) {
        return null;
    }
}

function safeBigIntJsonReplacer(key, value) {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
    res.writeHead(statusCode, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Token, X-User-Id',
        ...extraHeaders
    });
    res.end(JSON.stringify(data, safeBigIntJsonReplacer));
}

function sendText(res, statusCode, text) {
    res.writeHead(statusCode, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(text);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let tooLarge = false;
        req.on('data', chunk => {
            if (tooLarge) return;
            body += chunk;
            if (body.length > 1e6) {
                tooLarge = true;
                req.resume();
                const err = new Error('Payload Too Large: Maximum request body size is 1MB.');
                err.statusCode = 413;
                return reject(err);
            }
        });
        req.on('end', () => {
            if (tooLarge) return;
            if (!body) return resolve({});
            try {
                const parsed = JSON.parse(body);
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    return resolve({ raw: parsed });
                }
                resolve(parsed);
            } catch (e) {
                resolve({ raw: body });
            }
        });
        req.on('error', err => {
            if (!tooLarge) reject(err);
        });
    });
}

function getCatalog() {
    const serializeItems = (obj) => {
        const out = {};
        for (const [id, item] of Object.entries(obj)) {
            const copy = { ...item };
            for (const [k, v] of Object.entries(copy)) {
                if (typeof v === 'bigint') copy[k] = v.toString();
            }
            out[id] = copy;
        }
        return out;
    };

    return {
        potions: serializeItems(POTIONS),
        modules: serializeItems(MODULES),
        chips: serializeItems(CHIPS)
    };
}

async function handleWebRequest(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            ...SECURITY_HEADERS,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Token, X-User-Id'
        });
        res.end();
        return;
    }

    const host = req.headers.host || 'localhost:3000';
    const protocol = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
    const parsedUrl = new URL(req.url, `${protocol}://${host}`);
    const pathname = parsedUrl.pathname;

    const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
    if (hostHeader && !hostHeader.includes('127.0.0.1:0')) {
        global.LAST_KNOWN_WEB_ORIGIN = `${protocol}://${hostHeader}`;
    }

    if (pathname === '/health') {
        const mem = process.memoryUsage();
        return sendJson(res, 200, {
            status: 'ok',
            uptime: Math.floor(process.uptime()),
            rssMb: Math.round(mem.rss / 1048576),
            heapUsedMb: Math.round(mem.heapUsed / 1048576)
        });
    }

    if (pathname.startsWith('/api/')) {
        try {
            const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local';
            if (process.env.NODE_ENV !== 'test') {
                const rl = checkWebRateLimit(`ip:${clientIp}`, 120, 10000);
                if (!rl || !rl.allowed) {
                    return sendJson(res, 429, { ok: false, error: 'Too many requests. Please slow down.' });
                }
            }

            if (pathname === '/api/auth/oauth-url' && req.method === 'GET') {
                const clientId = getDiscordClientId();
                const clientSecret = process.env.CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET || '';
                const rawRedirect = process.env.OAUTH_REDIRECT_URI ||
                    parsedUrl.searchParams.get('redirectUri') ||
                    `${protocol}://${host}/`;
                const redirectUri = rawRedirect.replace('://127.0.0.1:', '://localhost:');
                if (!clientId) {
                    return sendJson(res, 200, { ok: false, error: 'Discord Client ID not configured in environment.' });
                }
                const responseType = clientSecret ? 'code' : 'token';
                const oauthUrl = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=${responseType}&scope=identify`;
                return sendJson(res, 200, {
                    ok: true,
                    url: oauthUrl,
                    clientId,
                    redirectUri,
                    responseType,
                    portalUrl: `https://discord.com/developers/applications/${clientId}/oauth2`
                });
            }

            if (pathname === '/api/auth/callback' && req.method === 'GET') {
                const code = parsedUrl.searchParams.get('code');
                const error = parsedUrl.searchParams.get('error');
                if (code) {
                    res.writeHead(302, { 'Location': `/?code=${encodeURIComponent(code)}&from_callback=1` });
                    res.end();
                    return;
                }
                if (error) {
                    res.writeHead(302, { 'Location': `/?oauth_error=${encodeURIComponent(error)}` });
                    res.end();
                    return;
                }
                res.writeHead(302, { 'Location': '/' });
                res.end();
                return;
            }

            if (pathname === '/api/auth/discord-code' && req.method === 'POST') {
                const body = await readBody(req);
                const { code, redirectUri } = body;
                if (!code) return sendJson(res, 400, { ok: false, error: 'Missing OAuth2 authorization code.' });
                const normalizedRedirect = (process.env.OAUTH_REDIRECT_URI || redirectUri || `${protocol}://${host}/`)
                    .replace('://127.0.0.1:', '://localhost:');
                const tokenData = await exchangeDiscordOAuthCode(code, normalizedRedirect);
                const discordUser = await fetchDiscordUserByAccessToken(tokenData.access_token);
                if (!discordUser || !discordUser.id) {
                    return sendJson(res, 401, { ok: false, error: 'Invalid Discord user from OAuth2 code.' });
                }
                const u = await getUser(discordUser.id);
                const dName = discordUser.username;
                if (dName && u.username !== dName) {
                    u.username = dName;
                    await saveUser(u);
                }
                const sess = createSession(u);
                return sendJson(res, 200, {
                    ok: true,
                    token: sess.token,
                    user: {
                        id: sess.userId,
                        username: sess.username,
                        isDev: sess.isDev
                    }
                }, {
                    'Set-Cookie': `aris_session=${sess.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800`
                });
            }

            if (pathname === '/api/auth/request-otp' && req.method === 'POST') {
                const body = await readBody(req);
                const rawInput = String(body.identifier || '').trim();
                if (!rawInput) {
                    return sendJson(res, 400, { ok: false, error: 'Please enter your Discord Username or Discord ID.' });
                }

                let targetUserId = null;
                let targetUsername = null;
                if (/^\d{15,22}$/.test(rawInput)) {
                    targetUserId = rawInput;
                    const [rows] = await pool.execute('SELECT id, username FROM users WHERE id = ? LIMIT 1', [rawInput]);
                    if (rows && rows.length > 0) targetUsername = rows[0].username;
                } else {
                    const cleanName = rawInput.replace(/^@/, '');
                    const [rows] = await pool.execute('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [cleanName]);
                    if (rows && rows.length > 0) {
                        targetUserId = String(rows[0].id);
                        targetUsername = rows[0].username;
                    }
                }

                if (!targetUserId) {
                    const mainClient = getMainClient();
                    if (mainClient && mainClient.users) {
                        const cleanName = rawInput.replace(/^@/, '').toLowerCase();
                        const found = mainClient.users.cache.find(u => u.username.toLowerCase() === cleanName || (u.tag && u.tag.toLowerCase() === cleanName));
                        if (found) {
                            targetUserId = found.id;
                            targetUsername = found.username;
                        }
                    }
                }

                if (!targetUserId) {
                    return sendJson(res, 404, {
                        ok: false,
                        error: 'Username not found in database yet. Please enter your numeric Discord User ID (or type >web in Discord).'
                    });
                }

                const now = Date.now();
                const lastSentUser = lastOtpSentTimes.get(`u:${targetUserId}`) || 0;
                const lastSentIp = lastOtpSentTimes.get(`ip:${clientIp}`) || 0;
                const lastSent = Math.max(lastSentUser, lastSentIp);
                if (now - lastSent < 60000 && process.env.NODE_ENV !== 'test') {
                    const waitSec = Math.ceil((60000 - (now - lastSent)) / 1000);
                    return sendJson(res, 429, {
                        ok: false,
                        error: `Please wait ${waitSec}s before requesting another verification code.`,
                        retryAfter: waitSec
                    });
                }

                const otpRecord = createAuthOtp(targetUserId, targetUsername);
                lastOtpSentTimes.set(`u:${targetUserId}`, now);
                lastOtpSentTimes.set(`ip:${clientIp}`, now);

                const originUrl = (`${protocol}://${host}`).replace('://127.0.0.1:', '://localhost:');
                const magicUrl = `${originUrl}/?magic_token=${otpRecord.magicToken}`;

                try {
                    const dmRes = await sendDiscordOtpDm(targetUserId, otpRecord.otp, magicUrl);
                    if (dmRes && dmRes.username && dmRes.username !== targetUsername) {
                        const u = await getUser(targetUserId);
                        u.username = dmRes.username;
                        await saveUser(u);
                        targetUsername = dmRes.username;
                    }
                    return sendJson(res, 200, {
                        ok: true,
                        userId: targetUserId,
                        username: targetUsername || `Player_${targetUserId.slice(0, 4)}`,
                        cooldown: 60,
                        message: `✅ Sent a 6-digit verification code & 1-click sign-in link to your Discord DM!`
                    });
                } catch (dmErr) {
                    return sendJson(res, 400, {
                        ok: false,
                        error: `Could not send Discord DM (${dmErr.message}). Make sure you share a server with .A.R.I.S and have DMs enabled, or type >web in Discord!`
                    });
                }
            }

            if (pathname === '/api/auth/verify-otp' && req.method === 'POST') {
                const body = await readBody(req);
                const { userId, otp, magicToken } = body;

                let verifiedResult;
                if (magicToken) {
                    verifiedResult = verifyAndConsumeMagicToken(magicToken);
                } else {
                    let targetUserId = String(userId || '').trim();
                    if (targetUserId && !/^\d{15,22}$/.test(targetUserId)) {
                        const cleanName = targetUserId.replace(/^@/, '');
                        const [rows] = await pool.execute('SELECT id FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [cleanName]);
                        if (rows && rows.length > 0) {
                            targetUserId = String(rows[0].id);
                        }
                    }
                    const cleanOtp = String(otp || '').replace(/\D/g, '').trim();
                    verifiedResult = verifyAndConsumeAuthOtp(targetUserId, cleanOtp);
                }

                if (!verifiedResult || !verifiedResult.ok) {
                    return sendJson(res, 401, {
                        ok: false,
                        error: (verifiedResult && verifiedResult.error) || 'Invalid or expired verification code.'
                    });
                }

                const u = await getUser(verifiedResult.userId);
                const sess = createSession(u);
                return sendJson(res, 200, {
                    ok: true,
                    token: sess.token,
                    user: {
                        id: sess.userId,
                        username: sess.username,
                        isDev: sess.isDev
                    }
                }, {
                    'Set-Cookie': `aris_session=${sess.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800`
                });
            }

            if (pathname === '/api/auth/discord-token' && req.method === 'POST') {
                const body = await readBody(req);
                const { accessToken } = body;
                if (!accessToken) return sendJson(res, 400, { ok: false, error: 'Missing accessToken' });

                const discordUser = await fetchDiscordUserByAccessToken(accessToken);
                if (!discordUser || !discordUser.id) {
                    return sendJson(res, 401, { ok: false, error: 'Invalid Discord token' });
                }

                const u = await getUser(discordUser.id);
                const dName = discordUser.username;
                if (dName && u.username !== dName) {
                    u.username = dName;
                    await saveUser(u);
                }

                const sess = createSession(u);
                return sendJson(res, 200, {
                    ok: true,
                    token: sess.token,
                    user: {
                        id: sess.userId,
                        username: sess.username,
                        isDev: sess.isDev
                    }
                }, {
                    'Set-Cookie': `aris_session=${sess.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800`
                });
            }

            if (pathname === '/api/auth/login' && req.method === 'POST') {
                const body = await readBody(req);
                if (process.env.NODE_ENV !== 'test' || body.enforceOAuthOnly) {
                    return sendJson(res, 403, {
                        ok: false,
                        error: 'Direct Discord ID login is disabled for security. Please sign in via Discord OAuth2.'
                    });
                }

                const rawInput = String(body.userId || body.identifier || '').trim();
                if (!rawInput) return sendJson(res, 400, { ok: false, error: 'Missing user identifier.' });

                let targetUser = null;
                if (/^\d{15,22}$/.test(rawInput)) {
                    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ? LIMIT 1', [rawInput]);
                    if (rows && rows.length > 0) {
                        targetUser = rows[0];
                    } else {
                        targetUser = await getUser(rawInput);
                    }
                } else {
                    const [rows] = await pool.execute('SELECT * FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [rawInput]);
                    if (rows && rows.length > 0) {
                        targetUser = rows[0];
                    }
                }

                if (!targetUser) {
                    return sendJson(res, 404, { ok: false, error: 'Account not found in database.' });
                }

                const sess = createSession(targetUser);
                return sendJson(res, 200, {
                    ok: true,
                    token: sess.token,
                    user: {
                        id: sess.userId,
                        username: sess.username,
                        isDev: sess.isDev
                    }
                }, {
                    'Set-Cookie': `aris_session=${sess.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800`
                });
            }

            if (pathname === '/api/auth/me' && req.method === 'GET') {
                const sess = getSessionFromReq(req, parsedUrl);
                if (!sess) {
                    return sendJson(res, 200, { ok: false, authenticated: false });
                }
                return sendJson(res, 200, {
                    ok: true,
                    authenticated: true,
                    user: {
                        id: sess.userId,
                        username: sess.username,
                        isDev: sess.isDev
                    }
                });
            }

            if (pathname === '/api/auth/heartbeat' && req.method === 'POST') {
                const sess = getSessionFromReq(req, parsedUrl);
                if (!sess) {
                    return sendJson(res, 401, { ok: false, online: false });
                }
                touchWebPresence(sess.userId);
                return sendJson(res, 200, { ok: true, online: true, userId: sess.userId });
            }

            if (pathname === '/api/auth/logout' && req.method === 'POST') {
                const sess = getSessionFromReq(req, parsedUrl);
                if (sess) {
                    destroySession(sess.token);
                }
                return sendJson(res, 200, { ok: true, message: 'Signed out successfully.' }, {
                    'Set-Cookie': 'aris_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0'
                });
            }

            if (pathname === '/api/users' && req.method === 'GET') {
                const sess = getSessionFromReq(req, parsedUrl);
                const callerId = sess ? sess.userId : (process.env.NODE_ENV === 'test' ? (parsedUrl.searchParams.get('callerId') || req.headers['x-user-id']) : null);
                const isDev = Boolean(callerId && DEV_IDS.includes(String(callerId)));
                if (!isDev) {
                    return sendJson(res, 403, {
                        ok: false,
                        users: [],
                        isDev: false,
                        error: 'Forbidden: Switch User is restricted to Developer & Owner authorities only.'
                    });
                }
                const users = await webService.getUsersList();
                return sendJson(res, 200, { ok: true, users, isDev: true });
            }

            if (pathname === '/api/dev/overview' && req.method === 'GET') {
                const sess = getSessionFromReq(req, parsedUrl);
                const callerId = sess ? sess.userId : (process.env.NODE_ENV === 'test' ? parsedUrl.searchParams.get('callerId') : null);
                const isDev = Boolean(callerId && DEV_IDS.includes(String(callerId)));
                if (!isDev) {
                    return sendJson(res, 403, { ok: false, error: 'Forbidden: Developer authority required.' });
                }
                const overview = await webService.getWebDevOverview();
                return sendJson(res, 200, overview);
            }

            if (pathname === '/api/dev/control' && req.method === 'POST') {
                const body = await readBody(req);
                const sess = getSessionFromReq(req, parsedUrl);
                const callerId = sess ? sess.userId : (process.env.NODE_ENV === 'test' ? body.callerId : null);
                const isDev = Boolean(callerId && DEV_IDS.includes(String(callerId)));
                if (!isDev) {
                    return sendJson(res, 403, { ok: false, error: 'Forbidden: Developer authority required.' });
                }
                const result = await webService.executeWebDevControl(body);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/leaderboard' && req.method === 'GET') {
                const type = parsedUrl.searchParams.get('type') || 'rolls';
                const period = parsedUrl.searchParams.get('period') || 'all';
                const page = parsedUrl.searchParams.get('page') || '1';
                const result = await webService.getWebLeaderboard(type, period, page);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/shop/catalog' && req.method === 'GET') {
                return sendJson(res, 200, { ok: true, catalog: getCatalog() });
            }

            if (pathname === '/api/stat/lookup' && req.method === 'GET') {
                const query = parsedUrl.searchParams.get('query');
                const sess = getSessionFromReq(req, parsedUrl);
                const requesterId = sess ? sess.userId : parsedUrl.searchParams.get('requesterId');
                const result = await webService.getPublicPlayerStat(query, requesterId);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/player' && req.method === 'GET') {
                const reqUserId = parsedUrl.searchParams.get('userId');
                const auth = resolveAuthorizedUser(req, parsedUrl, reqUserId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                const data = await webService.getPlayerData(auth.userId);
                return sendJson(res, 200, { ok: true, data });
            }

            if (pathname === '/api/settings/save' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) return sendJson(res, 400, { ok: false, error: 'Missing or invalid settings' });
                const result = await webService.updateUserSettings(auth.userId, body.settings);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/roll' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

                const result = await webService.executeWebRoll(auth.userId, Boolean(body.isAuto));
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/daily' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                const result = await webService.executeWebDaily(auth.userId);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/pray' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                const result = await webService.executeWebPray(auth.userId);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/quest/claim' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                if (body.questIndex === undefined || isNaN(Number(body.questIndex)) || Number(body.questIndex) < 0) return sendJson(res, 400, { ok: false, error: 'Missing or invalid questIndex' });
                const result = await webService.executeWebQuestClaim(auth.userId, body.questIndex);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/quest/reroll' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                if (body.questIndex === undefined || isNaN(Number(body.questIndex)) || Number(body.questIndex) < 0) return sendJson(res, 400, { ok: false, error: 'Missing or invalid questIndex' });
                const result = await webService.executeWebQuestReroll(auth.userId, body.questIndex);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/quest/buy' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                if (body.shopIndex === undefined || isNaN(Number(body.shopIndex)) || Number(body.shopIndex) < 0) return sendJson(res, 400, { ok: false, error: 'Missing or invalid shopIndex' });
                const result = await webService.executeWebQuestBuy(auth.userId, body.shopIndex);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/code' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                if (!body.code || typeof body.code !== 'string') return sendJson(res, 400, { ok: false, error: 'Missing or invalid code' });
                const result = await webService.executeWebRedeemCode(auth.userId, body.code);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/achieve/equip' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                const result = await webService.executeWebEquipAchievement(auth.userId, body.achId);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/title/equip' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                const result = await webService.executeWebEquipTitle(auth.userId, body.titleId);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/inventory/lock' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                if (!body.rollId || (typeof body.rollId !== 'string' && typeof body.rollId !== 'number')) return sendJson(res, 400, { ok: false, error: 'Missing or invalid rollId' });
                const result = await webService.executeWebLockRoll(auth.userId, body.rollId);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/inventory/sell' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                if (!body.rollId || (typeof body.rollId !== 'string' && typeof body.rollId !== 'number')) return sendJson(res, 400, { ok: false, error: 'Missing or invalid rollId' });
                const result = await webService.executeWebSellRoll(auth.userId, body.rollId);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/inventory/sell-all' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                const result = await webService.executeWebSellAllUnlocked(auth.userId);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/inventory/expand' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                const result = await webService.executeWebExpandStorage(auth.userId);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/inventory/equip' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                if (!body.itemId || typeof body.itemId !== 'string' || !body.type || typeof body.type !== 'string') return sendJson(res, 400, { ok: false, error: 'Missing or invalid parameters' });
                const result = await webService.executeWebEquip(auth.userId, body.itemId, body.type);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/shop/buy' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                if (!body.itemId || typeof body.itemId !== 'string') return sendJson(res, 400, { ok: false, error: 'Missing or invalid itemId' });
                if (body.qty !== undefined && typeof body.qty !== 'number' && typeof body.qty !== 'string') return sendJson(res, 400, { ok: false, error: 'Invalid quantity format' });

                await acquireLock(auth.userId);
                try {
                    const msg = await webService.doPurchase(auth.userId, body.itemId, body.qty !== undefined ? body.qty : 1, Boolean(body.isBShop));
                    const isError = typeof msg === 'string' && msg.startsWith('❌');
                    return sendJson(res, 200, { ok: !isError, message: msg });
                } finally {
                    releaseLock(auth.userId);
                }
            }

            if (pathname === '/api/shop/use' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                if (!body.itemId || typeof body.itemId !== 'string') return sendJson(res, 400, { ok: false, error: 'Missing or invalid itemId' });
                if (body.qty !== undefined && typeof body.qty !== 'number' && typeof body.qty !== 'string') return sendJson(res, 400, { ok: false, error: 'Invalid quantity format' });

                await acquireLock(auth.userId);
                try {
                    const msg = await webService.doUse(auth.userId, body.itemId, body.qty !== undefined ? body.qty : 1);
                    const isError = typeof msg === 'string' && msg.startsWith('❌');
                    return sendJson(res, 200, { ok: !isError, message: msg });
                } finally {
                    releaseLock(auth.userId);
                }
            }

            if (pathname === '/api/terminal' && req.method === 'POST') {
                const body = await readBody(req);
                const auth = resolveAuthorizedUser(req, parsedUrl, body.userId);
                if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
                const resObj = await dispatchTerminalCommand(auth.userId, body.command);
                if (typeof resObj === 'string') {
                    return sendJson(res, 200, { ok: true, output: resObj, openWindow: null, openTab: null });
                }
                return sendJson(res, 200, {
                    ok: true,
                    output: resObj.output,
                    openWindow: resObj.openWindow || null,
                    openTab: resObj.openTab || null,
                    commandName: resObj.commandName || null
                });
            }

            return sendJson(res, 404, { ok: false, error: 'API endpoint not found' });
        } catch (err) {
            const status = err.statusCode || 500;
            if (status !== 413) {
                console.error('Web API Error:', err);
            }
            return sendJson(res, status, { ok: false, error: err.message || 'Internal server error' });
        }
    }

    let reqPath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (!filePath.startsWith(PUBLIC_DIR)) {
        return sendText(res, 403, 'Forbidden');
    }

    const serveFromEntry = (entry) => {
        if (!entry) return sendText(res, 500, 'Internal Server Error');

        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === entry.etag) {
            res.writeHead(304, {
                ...SECURITY_HEADERS,
                'ETag': entry.etag,
                'Cache-Control': 'public, max-age=3600'
            });
            res.end();
            return;
        }

        const acceptEncoding = req.headers['accept-encoding'] || '';
        const canGzip = entry.gzipped && acceptEncoding.includes('gzip');

        const headers = {
            ...SECURITY_HEADERS,
            'Content-Type': entry.contentType,
            'ETag': entry.etag,
            'Cache-Control': 'public, max-age=3600'
        };

        if (canGzip) {
            headers['Content-Encoding'] = 'gzip';
            headers['Vary'] = 'Accept-Encoding';
            res.writeHead(200, headers);
            res.end(entry.gzipped);
        } else {
            res.writeHead(200, headers);
            res.end(entry.raw);
        }
    };

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            const indexPath = path.join(PUBLIC_DIR, 'index.html');
            fs.stat(indexPath, (indexStatErr, indexStats) => {
                if (indexStatErr || !indexStats.isFile()) {
                    return sendText(res, 404, 'File Not Found');
                }
                const entry = getCachedStatic(indexPath, 'text/html; charset=utf-8', indexStats);
                serveFromEntry(entry);
            });
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const entry = getCachedStatic(filePath, contentType, stats);
        serveFromEntry(entry);
    });
}

module.exports = {
    handleWebRequest
};

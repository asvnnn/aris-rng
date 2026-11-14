
const crypto = require('crypto');
const { DEV_IDS } = require('../config/constants');

const sessions = new Map();

const webPresence = new Map();
const WEB_PRESENCE_TTL_MS = 45000;

const authOtps = new Map();
const magicTokens = new Map();
const recentlyConsumedTokens = new Map();
const OTP_TTL_MS = 5 * 60 * 1000;
const CONSUMED_GRACE_TTL_MS = 30 * 1000;

const rateLimits = new Map();

function createAuthOtp(userId, username = null) {
    const uid = String(userId).trim();
    const prev = authOtps.get(uid);
    if (prev && prev.magicToken) {
        magicTokens.delete(prev.magicToken);
    }
    const otp = String(crypto.randomInt(100000, 1000000));
    const magicToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + OTP_TTL_MS;
    const record = { userId: uid, username: username ? String(username) : null, otp, magicToken, expiresAt, attempts: 0 };
    authOtps.set(uid, record);
    magicTokens.set(magicToken, uid);
    return record;
}

function verifyAndConsumeAuthOtp(userId, otpCode) {
    const uid = String(userId || '').trim();
    const code = String(otpCode || '').replace(/\D/g, '').trim();

    if (!code || code.length < 6) {
        return { ok: false, error: 'Please enter a valid 6-digit verification code.' };
    }

    let record = null;
    let targetUid = uid;

    if (targetUid && authOtps.has(targetUid)) {
        record = authOtps.get(targetUid);
    }

    if (!record) {
        for (const [idKey, r] of authOtps.entries()) {
            if (r.otp === code) {
                record = r;
                targetUid = idKey;
                break;
            }
        }
    }

    if (!record && targetUid) {
        const cleanName = targetUid.replace(/^@/, '').toLowerCase();
        for (const [idKey, r] of authOtps.entries()) {
            if (r.username && r.username.toLowerCase() === cleanName) {
                record = r;
                targetUid = idKey;
                break;
            }
        }
    }

    if (!record) {
        return { ok: false, error: 'No active verification code found. Please request a new code.' };
    }

    if (Date.now() > record.expiresAt) {
        authOtps.delete(targetUid);
        magicTokens.delete(record.magicToken);
        return { ok: false, error: 'Verification code has expired. Please request a new code.' };
    }

    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts > 5) {
        authOtps.delete(targetUid);
        magicTokens.delete(record.magicToken);
        return { ok: false, error: 'Too many invalid attempts. Please request a new code.' };
    }

    if (record.otp !== code) {
        return { ok: false, error: 'Invalid 6-digit verification code.' };
    }

    authOtps.delete(targetUid);
    magicTokens.delete(record.magicToken);

    return { ok: true, userId: targetUid };
}

function verifyAndConsumeMagicToken(magicToken) {
    const tok = String(magicToken || '').trim();
    if (!tok) {
        return { ok: false, error: 'Invalid or missing Magic Sign-In link.' };
    }

    if (recentlyConsumedTokens.has(tok)) {
        const cRec = recentlyConsumedTokens.get(tok);
        if (Date.now() - cRec.consumedAt < CONSUMED_GRACE_TTL_MS) {
            return { ok: true, userId: cRec.userId };
        }
        recentlyConsumedTokens.delete(tok);
    }

    if (!magicTokens.has(tok)) {
        return { ok: false, error: 'Invalid or expired Magic Sign-In link.' };
    }

    const uid = magicTokens.get(tok);
    const record = authOtps.get(uid);

    magicTokens.delete(tok);
    authOtps.delete(uid);
    recentlyConsumedTokens.set(tok, { userId: uid, consumedAt: Date.now() });

    if (!record || Date.now() > record.expiresAt) {
        return { ok: false, error: 'Magic Sign-In link has expired. Please generate a new one.' };
    }

    return { ok: true, userId: uid };
}

function createSession(u) {
    const token = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(16).toString('hex');
    const userId = String(u.id);
    const isDev = DEV_IDS.includes(userId);
    const now = Date.now();
    const sess = {
        token,
        csrfToken,
        userId,
        username: u.username || `Player_${userId.slice(0, 4)}`,
        isDev,
        createdAt: now,
        lastSeenAt: now
    };
    sessions.set(token, sess);
    touchWebPresence(userId);
    return sess;
}

function getSessionByToken(token) {
    if (!token || !sessions.has(token)) return null;
    const sess = sessions.get(token);
    sess.lastSeenAt = Date.now();
    touchWebPresence(sess.userId);
    return sess;
}

function destroySession(token) {
    if (!token || !sessions.has(token)) return;
    const sess = sessions.get(token);
    const targetUserId = sess.userId;
    for (const [k, s] of sessions.entries()) {
        if (s.userId === targetUserId) {
            sessions.delete(k);
        }
    }
    webPresence.delete(targetUserId);
}

function touchWebPresence(userId) {
    if (!userId) return;
    webPresence.set(String(userId), Date.now());
}

function clearWebPresence(userId) {
    if (!userId) return;
    webPresence.delete(String(userId));
}

function isUserOnlineOnWeb(userId) {
    if (!userId) return false;
    const key = String(userId);
    const lastSeen = webPresence.get(key);
    if (!lastSeen) return false;
    if (Date.now() - lastSeen > WEB_PRESENCE_TTL_MS) {
        webPresence.delete(key);
        return false;
    }
    return true;
}

function checkWebRateLimit(key, maxReqs = 60, windowMs = 10000) {
    if (process.env.NODE_ENV === 'test' && !String(key || '').startsWith('test_rl:')) {
        return { allowed: true, count: 0 };
    }
    const now = Date.now();
    const entry = rateLimits.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
        rateLimits.set(key, { count: 1, windowStart: now });
        return { allowed: true, count: 1 };
    }
    entry.count += 1;
    return {
        allowed: entry.count <= maxReqs,
        count: entry.count
    };
}

const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [uId, ts] of webPresence.entries()) {
        if (now - ts > WEB_PRESENCE_TTL_MS) webPresence.delete(uId);
    }
    for (const [k, rl] of rateLimits.entries()) {
        if (now - rl.windowStart > 60000) rateLimits.delete(k);
    }
    for (const [uid, rec] of authOtps.entries()) {
        if (now > rec.expiresAt) {
            authOtps.delete(uid);
            if (rec.magicToken) magicTokens.delete(rec.magicToken);
        }
    }
}, 30000);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

module.exports = {
    sessions,
    createSession,
    getSessionByToken,
    destroySession,
    touchWebPresence,
    clearWebPresence,
    isUserOnlineOnWeb,
    checkWebRateLimit,
    createAuthOtp,
    verifyAndConsumeAuthOtp,
    verifyAndConsumeMagicToken
};

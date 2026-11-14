const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { GLOBAL_COOLDOWN_MS, FRAME_TIMEOUT_MS, COOLDOWN_DELETE_MS } = require('../config/constants');

let mainClientRef = null;
function setMainClient(client) { mainClientRef = client; }
function getMainClient() { return mainClientRef; }

const activeFrames = new Map();
const frameTimeouts = new Map();
const frameCreatedAt = new Map();
const patienceEligible = new Set();
const globalCooldowns = new Map();
const userLocks = new Map();
const messageOwners = new Map();
const pendingVerifications = new Map();

function getContextKey(userId) {
    return String(userId);
}

function ensureUniqueComponentIds(ui) {
    if (!ui || !Array.isArray(ui.components)) return [];
    const seen = new Set();
    const duplicates = [];
    for (let rIdx = 0; rIdx < ui.components.length; rIdx++) {
        const row = ui.components[rIdx];
        const comps = row?.components;
        if (!Array.isArray(comps)) continue;
        for (let cIdx = 0; cIdx < comps.length; cIdx++) {
            const comp = comps[cIdx];
            const data = comp?.data || comp;
            const cid = data?.custom_id;
            if (!cid) continue;
            if (seen.has(cid)) {
                duplicates.push(cid);
                const fallbackId = `${cid}__dup_${rIdx}_${cIdx}`.slice(0, 100);
                const frameTitle = ui.embeds?.[0]?.data?.title || ui.embeds?.[0]?.title || 'Untitled Frame';
                console.warn(`[FrameManager] Duplicate custom_id "${cid}" in frame "${frameTitle}"; sanitized to "${fallbackId}".`);
                if (typeof comp.setCustomId === 'function') {
                    comp.setCustomId(fallbackId);
                } else {
                    data.custom_id = fallbackId;
                }
                seen.add(fallbackId);
            } else {
                seen.add(cid);
            }
        }
    }
    return duplicates;
}

function attachDeleteFrameButton(ui) {
    if (!ui || !Array.isArray(ui.components) || ui.components.length === 0) return;

    for (const row of ui.components) {
        const comps = row?.components || [];
        for (const comp of comps) {
            const cid = comp?.data?.custom_id || comp?.customId;
            if (cid === 'btn_delete_frame') return;
        }
    }

    const delBtn = new ButtonBuilder()
        .setCustomId('btn_delete_frame')
        .setLabel('🗑️ Delete Frame')
        .setStyle(ButtonStyle.Danger);

    let added = false;
    for (const row of ui.components) {
        const comps = row?.components;
        if (!Array.isArray(comps)) continue;
        const isButtonRow = comps.every(c => {
            const t = c?.data?.type ?? c?.type;
            return t === 2 || typeof c?.setStyle === 'function';
        });
        if (isButtonRow && comps.length < 5) {
            if (typeof row.addComponents === 'function') {
                row.addComponents(delBtn);
            } else {
                comps.push(delBtn);
            }
            added = true;
            break;
        }
    }

    if (!added && ui.components.length < 5) {
        ui.components.push(new ActionRowBuilder().addComponents(delBtn));
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [userId, time] of globalCooldowns.entries()) {
        if (now - time > 10000) globalCooldowns.delete(userId);
    }
    for (const [userId, mutex] of userLocks.entries()) {
        if (!mutex.locked && mutex.queue.length === 0) userLocks.delete(userId);
    }
    for (const [token, data] of pendingVerifications.entries()) {
        if (now > data.expiresAt) pendingVerifications.delete(token);
    }
    if (messageOwners.size > 2000) {
        const excess = messageOwners.size - 2000;
        let count = 0;
        for (const k of messageOwners.keys()) {
            messageOwners.delete(k);
            if (++count >= excess) break;
        }
    }
}, 300000).unref();

class Mutex {
    constructor() {
        this.queue = [];
        this.locked = false;
    }
    lock() {
        return new Promise(resolve => {
            if (!this.locked) {
                this.locked = true;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    }
    unlock() {
        if (this.queue.length > 0) {
            const resolve = this.queue.shift();
            resolve();
        } else {
            this.locked = false;
        }
    }
}

async function acquireLock(userId) {
    const key = getContextKey(userId);
    if (!userLocks.has(key)) userLocks.set(key, new Mutex());
    await userLocks.get(key).lock();
}

function releaseLock(userId) {
    const key = getContextKey(userId);
    if (userLocks.has(key)) userLocks.get(key).unlock();
}

async function cleanupOldMessage(oldMsg) {
    if (!oldMsg) return;
    messageOwners.delete(oldMsg.id);
    if (typeof oldMsg.edit === 'function') {
        try {
            await oldMsg.edit({ components: [] });
        } catch (e) {}
    }
}

class FrameManager {
    static getFrameAge(userId) {
        const key = getContextKey(userId);
        const created = frameCreatedAt.get(key);
        if (!created) return 0;
        return Math.max(0, Date.now() - created);
    }

    static async registerFrame(userId, newMsg) {
        if (!newMsg) return;
        const key = getContextKey(userId);
        if (activeFrames.has(key)) {
            const oldMsg = activeFrames.get(key);
            if (oldMsg && oldMsg.id !== newMsg.id) {
                activeFrames.delete(key);
                await cleanupOldMessage(oldMsg);
            }
        }
        activeFrames.set(key, newMsg);
        messageOwners.set(newMsg.id, String(userId));
        frameCreatedAt.set(key, Date.now());

        if (frameTimeouts.has(key)) clearTimeout(frameTimeouts.get(key));
        const timeout = setTimeout(async () => {
            const msg = activeFrames.get(key);
            if (msg) await cleanupOldMessage(msg);
            activeFrames.delete(key);
            frameTimeouts.delete(key);
            frameCreatedAt.delete(key);
        }, FRAME_TIMEOUT_MS);
        if (typeof timeout.unref === 'function') timeout.unref();
        frameTimeouts.set(key, timeout);
    }

    static removeFrame(userId) {
        const key = getContextKey(userId);
        const msg = activeFrames.get(key);
        if (msg) messageOwners.delete(msg.id);
        activeFrames.delete(key);
        frameCreatedAt.delete(key);
        if (frameTimeouts.has(key)) {
            clearTimeout(frameTimeouts.get(key));
            frameTimeouts.delete(key);
        }
    }

    static async sendFrame(ctx, ui, userId) {
        let msg;
        try {
            attachDeleteFrameButton(ui);
            ensureUniqueComponentIds(ui);
            const key = getContextKey(userId);
            const isInteraction = typeof ctx.editReply === 'function';
            const currentInteractionMsgId = isInteraction && ctx.message ? ctx.message.id : null;

            let oldMsgToReuse = null;
            let cleanupPromise = Promise.resolve();

            if (activeFrames.has(key)) {
                const oldMsg = activeFrames.get(key);
                if (oldMsg && (!currentInteractionMsgId || currentInteractionMsgId !== oldMsg.id)) {
                    activeFrames.delete(key);
                    frameCreatedAt.delete(key);
                    if (frameTimeouts.has(key)) {
                        clearTimeout(frameTimeouts.get(key));
                        frameTimeouts.delete(key);
                    }

                    const oldChanId = oldMsg.channelId || oldMsg.channel?.id || null;
                    const newChanId = ctx.channelId || ctx.channel?.id || null;
                    if (!isInteraction && typeof oldMsg.edit === 'function' && oldChanId === newChanId) {
                        oldMsgToReuse = oldMsg;
                    } else {
                        cleanupPromise = cleanupOldMessage(oldMsg);
                    }
                }
            }

            if (isInteraction) {
                if (ctx.deferred || ctx.replied) {
                    msg = await ctx.editReply(ui);
                } else if (typeof ctx.update === 'function') {
                    await ctx.update(ui).catch(() => {});
                    msg = ctx.message || (await ctx.fetchReply().catch(() => null));
                } else {
                    msg = await ctx.reply({ ...ui, fetchReply: true });
                }
            } else if (oldMsgToReuse) {
                try {
                    const editPayload = {
                        content: ui.content !== undefined ? ui.content : null,
                        embeds: ui.embeds || [],
                        components: ui.components || []
                    };
                    msg = (await oldMsgToReuse.edit(editPayload)) || oldMsgToReuse;
                } catch (err) {
                    if (ctx.channel) {
                        msg = await ctx.channel.send(ui);
                    }
                }
            } else if (ctx.channel) {
                msg = await ctx.channel.send(ui);
            }

            await cleanupPromise;
            if (msg) await this.registerFrame(userId, msg);
            return msg;
        } catch (e) {
            console.error("Frame Update Error:", e.message);
            return null;
        }
    }
}

function checkCooldown(userId) {
    const key = getContextKey(userId);
    const now = Date.now();
    const last = globalCooldowns.get(key);
    if (last && (now - last < GLOBAL_COOLDOWN_MS)) {
        return true;
    }
    globalCooldowns.set(key, now);
    return false;
}

function getCooldownExpiry(userId) {
    const key = getContextKey(userId);
    const last = globalCooldowns.get(key);
    return last ? last + GLOBAL_COOLDOWN_MS : Date.now() + GLOBAL_COOLDOWN_MS;
}

async function sendCooldownMsg(ctx, timestampMs, messageText) {
    const unixTime = Math.ceil(timestampMs / 1000);
    const content = `⏳ ${messageText} <t:${unixTime}:R>.`;
    const deleteDelay = Math.min(Math.max(1000, timestampMs - Date.now()), COOLDOWN_DELETE_MS);

    try {
        if (typeof ctx.isMessageComponent === 'function' && (ctx.isMessageComponent() || ctx.isModalSubmit())) {
            if (ctx.deferred || ctx.replied) {
                await ctx.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
            } else {
                await ctx.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            return;
        }

        let msg = null;
        if (typeof ctx.isChatInputCommand === 'function' && ctx.isChatInputCommand()) {
            if (ctx.deferred || ctx.replied) {
                msg = await ctx.editReply({ content }).catch(() => null);
            } else {
                msg = await ctx.reply({ content, fetchReply: true }).catch(() => null);
            }
        } else if (ctx.channel) {
            msg = await ctx.channel.send({ content }).catch(() => null);
        }

        if (msg && typeof msg.delete === 'function') {
            const t = setTimeout(() => Promise.resolve(msg.delete()).catch(() => {}), deleteDelay);
            if (typeof t.unref === 'function') t.unref();
        }
    } catch (e) {}
}

function autoDelete(msg, ms = FRAME_TIMEOUT_MS) {
    if (msg && typeof msg.delete === 'function') {
        const t = setTimeout(() => Promise.resolve(msg.delete()).catch(() => {}), Math.max(1000, ms));
        if (typeof t.unref === 'function') t.unref();
    }
}

function autoDeleteCooldown(msg, targetTimestampMs) {
    if (msg && typeof msg.delete === 'function') {
        const remaining = Math.max(1000, targetTimestampMs - Date.now());
        const delay = Math.min(remaining, COOLDOWN_DELETE_MS);
        const t = setTimeout(() => Promise.resolve(msg.delete()).catch(() => {}), delay);
        if (typeof t.unref === 'function') t.unref();
    }
}

function createVerification(operatorId, payload, ttlMs = 60000) {
    const token = `${operatorId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    pendingVerifications.set(token, {
        operatorId,
        payload,
        expiresAt: Date.now() + ttlMs
    });
    return token;
}

function getVerification(token) {
    const entry = pendingVerifications.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        pendingVerifications.delete(token);
        return null;
    }
    return entry;
}

function consumeVerification(token, operatorId) {
    const entry = getVerification(token);
    if (!entry || entry.operatorId !== operatorId) return null;
    pendingVerifications.delete(token);
    return entry.payload;
}

function consumeLatestVerificationForUser(operatorId, sourceType = null) {
    let foundToken = null;
    let foundEntry = null;
    for (const [token, entry] of pendingVerifications.entries()) {
        if (entry.operatorId === operatorId && Date.now() <= entry.expiresAt) {
            if (!sourceType || entry.payload.source === sourceType) {
                foundToken = token;
                foundEntry = entry;
            }
        }
    }
    if (foundToken && foundEntry) {
        pendingVerifications.delete(foundToken);
        return foundEntry.payload;
    }
    return null;
}

module.exports = {
    FrameManager,
    setMainClient,
    getMainClient,
    getContextKey,
    ensureUniqueComponentIds,
    checkCooldown,
    getCooldownExpiry,
    sendCooldownMsg,
    autoDelete,
    autoDeleteCooldown,
    acquireLock,
    releaseLock,
    messageOwners,
    createVerification,
    getVerification,
    consumeVerification,
    consumeLatestVerificationForUser
};

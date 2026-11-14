const { getMainClient } = require('../utils/discord');
const { notifyBlackMarketDMs } = require('../utils/discordNotifier');
const { getBShopOptedInUsers } = require('../database/userModel');

const globalBShop = { active: false, expiresAt: 0, inventory: { items: [], ccStock: 0 } };
const personalBShops = new Map();

function getPersonalKey(userId) {
    return userId ? String(userId) : null;
}

function generateBShopInventory() {
    let items = [];
    if (Math.random() < 0.50) items.push('pot_crystal_maker_kit');
    if (Math.random() < 0.15) items.push('pot_oblivion');
    if (Math.random() < 0.075) items.push('pot_reality');

    let ccRoll = Math.random();
    let ccStock = 0;
    if (ccRoll < 0.05) ccStock = 50;
    else if (ccRoll < 0.15) ccStock = 20;
    else if (ccRoll < 0.45) ccStock = 10;
    else if (ccRoll < 0.95) ccStock = 5;

    if (ccStock > 0) items.push('item_cc');

    return { items, ccStock };
}

function spawnBlackMarket(targetId = null) {
    const inv = generateBShopInventory();
    const expiresAt = Date.now() + 600000;

    let dispatchPromise = Promise.resolve();

    if (targetId) {
        const pKey = getPersonalKey(targetId);
        personalBShops.set(pKey, { active: true, expiresAt, inventory: inv });

        dispatchPromise = notifyBlackMarketDMs([String(targetId)], {
            title: '🌑 Personal Black Market Appeared!',
            description: 'A Personal Black Market has opened for you! It will remain open for **10 minutes**.\nUse `>bshop` in Discord or visit the **A.R.I.S Store** on Web OS to check exclusive stock!',
            color: 0x1a1a24,
            footer: 'You received this because a Personal Black Market spawned for you.'
        }).catch(() => null);
    } else {
        globalBShop.active = true;
        globalBShop.expiresAt = expiresAt;
        globalBShop.inventory = inv;

        const mainClient = getMainClient();
        const isClientReady = mainClient && (typeof mainClient.isReady === 'function' ? mainClient.isReady() : Boolean(mainClient.readyAt));

        if (isClientReady) {
            dispatchPromise = getBShopOptedInUsers(7)
                .then(optedInUserIds => {
                    if (Array.isArray(optedInUserIds) && optedInUserIds.length > 0) {
                        return notifyBlackMarketDMs(optedInUserIds, {
                            title: '🌑 The Black Market has Opened!',
                            description: 'The Black Market has surfaced from the void! It will remain open for **10 minutes**.\nUse `>bshop` in Discord or visit the **A.R.I.S Store** on Web OS to check exclusive stock!',
                            color: 0x1a1a24,
                            footer: 'You received this because BShop Ping is enabled in >setting.'
                        });
                    }
                })
                .catch(() => null);
        }
    }

    return dispatchPromise;
}

function getBlackMarketData(userId) {
    const pKey = getPersonalKey(userId);
    if (pKey) {
        const personal = personalBShops.get(pKey);
        if (personal) {
            if (personal.active && Date.now() < personal.expiresAt) return personal;
            personalBShops.delete(pKey);
        }
    }
    if (globalBShop.active && Date.now() < globalBShop.expiresAt) return globalBShop;
    return { active: false, expiresAt: 0, inventory: { items: [], ccStock: 0 } };
}

const bmTimer = setInterval(() => {
    const now = Date.now();
    if (!globalBShop.active && Math.random() < 0.001) {
        spawnBlackMarket(null);
        console.log("🌑 Black Market has spawned!");
    } else if (globalBShop.active && now > globalBShop.expiresAt) {
        globalBShop.active = false;
    }
    for (const [uId, pShop] of personalBShops.entries()) {
        if (now > pShop.expiresAt) personalBShops.delete(uId);
    }
}, 60000);
if (typeof bmTimer.unref === 'function') bmTimer.unref();

function closeBlackMarket(userId = null) {
    const pKey = getPersonalKey(userId);
    if (pKey) personalBShops.delete(pKey);
    globalBShop.active = false;
    globalBShop.expiresAt = 0;
    globalBShop.inventory = { items: [], ccStock: 0 };
}

module.exports = { spawnBlackMarket, getBlackMarketData, closeBlackMarket };

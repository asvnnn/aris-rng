const { POTIONS, MODULES, CHIPS } = require('../data/items');
const { ANSI } = require('../config/constants');

function generateHighPrecisionRoll(luck) {
    if (typeof luck !== 'number' || isNaN(luck)) luck = 1;
    if (luck === 0) luck = 1;

    let absLuck = Math.abs(luck);
    if (!isFinite(absLuck)) {
        absLuck = Number.MAX_VALUE;
    }

    let rand = Math.random();
    if (rand < 0.1) rand *= Math.random();
    if (rand < 0.01) rand *= Math.random();
    if (rand < 0.001) rand *= Math.random();
    if (rand === 0) rand = 1e-30; 
    
    let raw = absLuck / rand;

    if (!isFinite(raw)) {
        let logLuck = Math.log10(absLuck);
        let logRand = Math.log10(rand);
        let logRaw = logLuck - logRand;
        let exponent = Math.floor(logRaw);
        let mantissa = Math.pow(10, logRaw - exponent);

        let safeExp = BigInt(Math.max(0, exponent - 10));
        let baseStr = Math.floor(mantissa * 1e10).toString();
        let val = BigInt(baseStr) * (10n ** safeExp);
        return val < 1n ? 1n : val;
    }
    
    if (raw > 1e15) {
        let exponent = Math.floor(Math.log10(raw));
        if (exponent < 10) exponent = 10;
        let baseStr = (raw / Math.pow(10, exponent)).toFixed(10).replace('.', '');
        let safeExp = BigInt(Math.max(0, exponent - 10));
        let val = BigInt(baseStr) * (10n ** safeExp);
        return val < 1n ? 1n : val;
    }
    let val = BigInt(Math.floor(raw));
    return val < 1n ? 1n : val;
}

function calcStats(u, activePots, isRolling = false) {
    let b = Number(u.permanent_basic_luck) || 0; 
    let m = 1.0; 
    let s = 0; 
    let f = 0; 
    let cd = 0;
    let flags = { 
        magic: false, storm: false, cmaker: false,
        cmaker_kit: false, reality: false, force_negative: false,
        title_luck_multi: 1, auto_potion: false, fixed_speed: null, final_multiplier: 1
    };
    
    if (activePots && activePots.isPrecomputed) {
        b += activePots.b;
        m += activePots.m;
        cd += activePots.cd;
        s += activePots.s;
        f += activePots.f;
        Object.assign(flags, activePots.flags);
    } else if (Array.isArray(activePots)) {
        for (let p of activePots) {
            let pot = POTIONS[p.potion_id]; 
            if (!pot || (p.rolls_left !== undefined && p.rolls_left <= 0)) continue;
            if (pot.effects.basic) b += pot.effects.basic; 
            if (pot.effects.multi) m += pot.effects.multi;
            if (pot.effects.cd) cd += pot.effects.cd; 
            if (pot.effects.special) s += pot.effects.special;
            if (pot.effects.final) f += pot.effects.final;
            if (pot.effects.magic) flags.magic = true; 
            if (pot.effects.cmaker) flags.cmaker = true; 
            if (pot.effects.storm) flags.storm = true; 
            if (pot.effects.cmaker_kit) flags.cmaker_kit = true; 
            if (pot.effects.reality) flags.reality = true;
            if (pot.effects.auto_potion) flags.auto_potion = true;
        }
    }
    
    let mod = u.equipped_module ? MODULES[u.equipped_module] : null;
    if (mod) {
        if (mod.effects.basic) b += mod.effects.basic; 
        if (mod.effects.multi) m += mod.effects.multi;
        if (mod.effects.cd) cd += mod.effects.cd; 
        if (mod.effects.final) f += mod.effects.final; 
        if (mod.effects.special) s += mod.effects.special;
        if (mod.effects.force_negative) flags.force_negative = true;
        if (mod.effects.spectrometer) flags.spectrometer = true;
        if (mod.effects.title_luck) flags.title_luck_multi = mod.effects.title_luck;

        if (mod.effects.glitch) { 
            if (isRolling) {
                u.glitch_counter = (u.glitch_counter || 0) + 1;
                u.glitch_basic = Math.random() * 4 + 1; 
                u.glitch_cd = Math.random() * 2 - 1; 
                if (u.glitch_counter >= 10) {
                    u.glitch_counter = 0;
                    u.glitch_multi = Math.random() * 5.5 + 0.5;
                } else {
                    u.glitch_multi = 0;
                }
            } else {
                if (u.glitch_basic === undefined && u.glitch_cd === undefined) {
                    u.glitch_basic = Math.random() * 4 + 1;
                    u.glitch_cd = Math.random() * 2 - 1;
                }
            }
            b += u.glitch_basic || 0; 
            m += u.glitch_multi || 0; 
            cd += u.glitch_cd || 0; 
        }
    }
    
    if (u.equipped_chip) {
        let chip = CHIPS[u.equipped_chip];
        if (chip) {
            if (chip.effects.basic) { 
                if (chip.effects.flame && u.equipped_module === 'mod_hell') b += 2; 
                else b += chip.effects.basic; 
            } 
            if (chip.effects.cd) cd += chip.effects.cd; 
            if (chip.effects.final) f += chip.effects.final; 
            if (chip.effects.special) s += chip.effects.special;
            if (chip.effects.multi) m += chip.effects.multi;

            if (chip.effects.error) { 
                if (isRolling) {
                    u.error_chip_counter = (u.error_chip_counter || 0) + 1;
                    u.error_chip_basic = Math.random() * 2 + 1; 
                    u.error_chip_cd = Math.random() * 1 - 0.5; 
                    if (u.error_chip_counter >= 10) {
                        u.error_chip_counter = 0;
                        u.error_chip_multi = Math.random() * 3.5 + 0.5;
                    } else {
                        u.error_chip_multi = 0;
                    }
                } else {
                    if (u.error_chip_basic === undefined && u.error_chip_cd === undefined) {
                        u.error_chip_basic = Math.random() * 2 + 1;
                        u.error_chip_cd = Math.random() * 1 - 0.5;
                    }
                }
                b += u.error_chip_basic || 0; 
                m += u.error_chip_multi || 0; 
                cd += u.error_chip_cd || 0; 
            }
        }
    }
    
    let finalCd = flags.fixed_speed !== null ? flags.fixed_speed : (flags.storm ? 1.0 : Math.max(10.0 + cd, 1.0)); 
    let finalLuck = u.luck_toggle === 0 ? 1.0 : (((1.0 + b) * m) + s) * (1.0 + f) * flags.final_multiplier; 

    if (finalLuck < -1000000000) {
        finalLuck = -1000000000;
    }

    if (flags.reality) finalLuck = Math.abs(finalLuck);
    
    if (u.fixed_luck !== undefined && u.fixed_luck !== 0) {
        finalLuck = u.fixed_luck;
    }
    
    return { basic: b, multi: m, special: s, final: f, finalCd, finalLuck, ...flags };
}

function formatAnsiPreview(text) {
    if (!text) return '';
    return text
        .replace(/basic luck/gi, `\u001b[4;38;2;3;252;32m$&\u001b[0m`)
        .replace(/multi luck/gi, `\u001b[4;38;2;3;78;252m$&\u001b[0m`)
        .replace(/special luck/gi, `\u001b[4;38;2;255;38;179m$&\u001b[0m`)
        .replace(/final luck/gi, `\u001b[4;38;2;252;255;97m$&\u001b[0m`);
}

function formatBigIntSafe(val) {
    if (val === undefined || val === null) return '0';
    if (typeof val === 'number' && !isFinite(val)) return '0';
    if (typeof val === 'bigint') {
        const absVal = val < 0n ? -val : val;
        const sign = val < 0n ? '-' : '';
        const s = absVal.toString();
        if (s.length > 27) {
            const exp = s.length - 1;
            const mantissa = s.slice(0, 4);
            const formatted = `${mantissa[0]}.${mantissa.slice(1)}`;
            return `${sign}${formatted}e+${exp}`;
        }
        return `${sign}${absVal.toLocaleString('en-US')}`;
    }
    const str = String(val).trim();
    if (!str || str === 'NaN' || str === 'Infinity' || str === '-Infinity') return '0';
    const isNeg = str.startsWith('-');
    const clean = str.replace(/^[+-]/, '');
    if (!clean) return '0';
    if (clean.includes('.')) {
        const num = parseFloat(str);
        if (!isFinite(num)) return '0';
        return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    try {
        const bi = BigInt(clean);
        const sign = isNeg ? '-' : '';
        if (clean.length > 27) {
            const exp = clean.length - 1;
            const mantissa = clean.slice(0, 4);
            const formatted = `${mantissa[0]}.${mantissa.slice(1)}`;
            return `${sign}${formatted}e+${exp}`;
        }
        return `${sign}${bi.toLocaleString('en-US')}`;
    } catch (e) {
        return '0';
    }
}

module.exports = { generateHighPrecisionRoll, calcStats, formatAnsiPreview, formatBigIntSafe };

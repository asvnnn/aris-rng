
const POTIONS = {
    'pot_luck': { rank: '0.0', name: 'Luck Potion', cur: 'coins', cost: 100n, dur: 10, effects: { basic: 1 }, effectText: '+1 Basic Luck for Next 10 Roll' },
    'pot_speed': { rank: '0.1', name: 'Speed Potion', cur: 'coins', cost: 200n, dur: 10, effects: { cd: -0.25 }, effectText: '-0.25s Cooldown for Next 10 Roll' },
    'pot_fortune_1': { rank: '1.0', name: 'Fortune I', cur: 'coins', cost: 1000n, dur: 10, effects: { basic: 2 }, effectText: '+2 Basic Luck for Next 10 Roll' },
    'pot_fortune_2': { rank: '1.0', name: 'Fortune II', cur: 'coins', cost: 3500n, dur: 15, effects: { basic: 3 }, effectText: '+3 Basic Luck for Next 15 Roll' },
    'pot_fortune_3': { rank: '1.0', name: 'Fortune III', cur: 'coins', cost: 5000n, dur: 15, effects: { basic: 5 }, effectText: '+5 Basic Luck for Next 15 Roll' },
    'pot_windy_1': { rank: '1.1', name: 'Windy I', cur: 'coins', cost: 2000n, dur: 10, effects: { cd: -0.5 }, effectText: '-0.5s Cooldown for Next 10 Roll' },
    'pot_windy_2': { rank: '1.1', name: 'Windy II', cur: 'coins', cost: 6000n, dur: 10, effects: { cd: -0.75 }, effectText: '-0.75s Cooldown for Next 10 Roll' },
    'pot_windy_3': { rank: '1.1', name: 'Windy III', cur: 'coins', cost: 20000n, dur: 10, effects: { cd: -1.0 }, effectText: '-1s Cooldown for Next 10 Roll' },
    'pot_pop': { rank: '2.0', name: 'Pop Potion', cur: 'coins', cost: 10000n, dur: 1, limit: 10, effects: { special: 2000 }, effectText: '+2000 Special Luck for Next 1 Roll' },
    'pot_heavenly': { rank: '3.0', name: 'Heavenly Potion', cur: 'coins', cost: 100000n, dur: 1, limit: 5, effects: { special: 15000 }, effectText: '+15000 Special Luck for Next 1 Roll' },
    'pot_magic': { rank: '3.1', name: 'Magic Potion', cur: 'coins', cost: 1000000n, dur: 1, limit: 1, effects: { magic: true }, effectText: 'Clone current luck effects for next 9 Rolls (capped at 20000 Luck per clone roll)' },
    'pot_crystal_maker': { rank: 'Special', name: 'Crystal Maker', cur: 'coins', cost: 1000n, dur: 1, effects: { cmaker: true }, effectText: '2% Chance to drop a Crystal on Next 1 Roll (Guaranteed every 75 rolls)' },
    'pot_quick_roll': { rank: '2.1', name: 'Quick Roll', cur: 'coins', cost: 10000n, dur: 100, effects: { cd: -3.0 }, effectText: '-3s Cooldown for Next 100 Roll' },
    'pot_storm': { rank: 'Special', name: 'Storm Potion', cur: 'crystals', cost: 100n, dur: 4500, limit: 1, effects: { storm: true }, effectText: 'Set Cooldown to 1s for Next 4500 Roll' },
    'pot_undefine': { rank: '-1.0', name: 'Undefine Potion', cur: 'nulls', cost: 1n, dur: 1, effects: { special: -200000 }, effectText: '-200000 Special Luck for Next 1 Roll' },

    'pot_crystal_maker_kit': { rank: 'Special', name: 'Crystal Maker-Kit', cur: 'coins', cost: 60000n, dur: 1, limit: 5, bshopOnly: true, effects: { cmaker_kit: true }, effectText: 'Guaranteed 1 Crystal on Next 1 Roll' },
    'pot_oblivion': { rank: '-2.0', name: 'Oblivion Potion', cur: 'nulls', cost: 35n, dur: 1, limit: 1, bshopOnly: true, effects: { special: -11000000 }, effectText: '-11000000 Special Luck for Next 1 Roll' },
    'pot_reality': { rank: 'Special', name: 'Reality Potion', craft: true, reqNulls: 11n, reqCrys: 111n, dur: 1, bshopOnly: true, effects: { reality: true }, effectText: 'Converts total Luck into an absolute positive value for Next 1 Roll' }
};

const MODULES = {
    'mod_luck': { name: 'Luck Module', cur: 'coins', cost: 1000n, effects: { basic: 1 }, effectText: '+1 Basic Luck' },
    'mod_water': { name: 'Water Module', cur: 'coins', cost: 3500n, effects: { cd: -0.25 }, effectText: '-0.25s Cooldown' },
    'mod_hell': { name: 'Hell Module', cur: 'coins', cost: 10000n, effects: { basic: 2.5, cd: 0.5 }, effectText: '+2.5 Basic Luck and +0.5s Cooldown' },
    'mod_cyber': { name: 'Cyber Module', cur: 'coins', cost: 50000n, effects: { basic: 2, cd: -0.25, multi: 0.5 }, effectText: '+2 Basic Luck and -0.25s Cooldown +0.5 Multi luck' },
    'mod_glitch': { name: 'Glitch Module', cur: 'coins', cost: 133337n, effects: { glitch: true }, effectText: '+Random (1 to 5) Basic Luck, +Random (-1s to 1s) Cooldown and +Random (0.5 to 6) Multi Luck every 10 Rolls' },
    'mod_multi': { name: 'Multi Module', cur: 'coins', cost: 500000n, effects: { multi: 1 }, effectText: '+1 Multi Luck' },
    'mod_crystal': { name: 'Crystal Module', cur: 'crystals', cost: 100n, effects: { basic: 20, cd: -1.0, multi: 0.1, cmod: true }, effectText: '3% Chance to drop 1 Crystal per roll (Pity at 34th roll); +20 Basic Luck, -1s Cooldown, +0.1 Multi Luck' },
    'mod_dream': { name: 'Dream Module', craft: true, reqCrys: 200n, reqCoins: 1000000n, effects: { final: 0.5 }, effectText: '+0.5 FINAL LUCK' },
    'mod_malfunction': { name: 'Malfunction Module', craft: true, reqMod: 'mod_glitch', reqModQty: 11, reqChip: 'chip_error', reqChipQty: 11, reqCrys: 1111n, effects: { final: -2, nullChance: 0.0025 }, effectText: '-2 FINAL LUCK' },
    'mod_spectrometer': { name: 'Spectrometer Module', cur: 'crystals', cost: 10000n, effects: { spectrometer: true }, effectText: 'Unlocks the ability to roll Titles alongside numbers' }
};

const CHIPS = {
    'chip_luck': { name: 'Luck Chip', cur: 'coins', cost: 750n, effects: { basic: 0.5 }, effectText: '+0.5 Basic Luck' },
    'chip_flame': { name: 'Flame Chip', cur: 'coins', cost: 7500n, effects: { basic: 1, flame: true }, effectText: '+1 Basic Luck (+2 Basic Luck if equipped with Hell Module)' },
    'chip_electric': { name: 'Electric Chip', cur: 'coins', cost: 22500n, effects: { cd: -0.5 }, effectText: '-0.5s Cooldown' },
    'chip_error': { name: 'Error Chip', cur: 'coins', cost: 80100n, effects: { error: true }, effectText: '+Random (1 to 3) Basic Luck, +Random (-0.5s to 0.5s) Cooldown, +Random (0.5 to 4) Multi Luck every 10 Rolls' },
    'chip_crystal': { name: 'Crystal Chip', cur: 'crystals', cost: 40n, effects: { crystal: true }, effectText: 'Increases Crystal Module drop rate from 3% to 3.5% and lowers Pity threshold from 34 to 29' },
    'chip_autoroll': { name: 'Auto-Roll Machine', cur: 'crystals', cost: 1337n, effects: { auto: true }, effectText: 'Automates rolling; requires manual >r every 1337 rolls to resume' }
};

module.exports = { POTIONS, MODULES, CHIPS };

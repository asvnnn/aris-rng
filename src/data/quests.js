const QUESTS = [
    { id: 'q_roll_100', type: 'roll', target: 100, desc: 'Roll 100 times', reward: { items: { 'pot_windy_1': 1 } } },
    { id: 'q_roll_200', type: 'roll', target: 200, desc: 'Roll 200 times', reward: { items: { 'pot_windy_1': 2 } } },
    { id: 'q_roll_300', type: 'roll', target: 300, desc: 'Roll 300 times', reward: { items: { 'pot_windy_1': 3 } } },
    { id: 'q_pray_1', type: 'pray', target: 1, desc: 'Pray 1 time', reward: { items: { 'pot_luck': 2 } } },
    { id: 'q_roll_above_35', type: 'roll_above', target: 35, condition: 'rolls < 150', desc: 'Roll a number > 35', reward: { items: { 'pot_luck': 1 } } },
    { id: 'q_roll_above_100', type: 'roll_above', target: 100, condition: 'rolls >= 150 AND rolls <= 1000', desc: 'Roll a number > 100', reward: { items: { 'pot_fortune_1': 1 } } },
    { id: 'q_roll_above_1000', type: 'roll_above', target: 1000, condition: 'rolls > 1000 AND rolls <= 7500', desc: 'Roll a number > 1000', reward: { items: { 'pot_fortune_2': 1 } } },
    { id: 'q_roll_above_7500', type: 'roll_above', target: 7500, condition: 'rolls > 7500', desc: 'Roll a number > 7500', reward: { items: { 'pot_pop': 1 } } },
    { id: 'q_roll_2500', type: 'roll', target: 2500, condition: 'rolls > 100000', desc: 'Roll 2500 times', reward: { items: { 'pot_windy_3': 5 } } },
    { id: 'q_spend_200', type: 'spend', target: 200, condition: 'rolls < 250', desc: 'Spend 200 coins', reward: { coins: 50n } },
    { id: 'q_spend_2000', type: 'spend', target: 2000, condition: 'rolls >= 250 AND rolls <= 1000', desc: 'Spend 2000 coins', reward: { coins: 200n } },
    { id: 'q_roll_below_100k', type: 'roll_below', target: -100000, reqMod: 'mod_malfunction', desc: 'Roll a number < -100,000', reward: { nulls: 1n } },
    { id: 'q_roll_below_10k', type: 'roll_below', target: -10000, reqMod: 'mod_malfunction', desc: 'Roll a number < -10,000', reward: { coins: 100000n } },
    { id: 'q_roll_tuff', type: 'roll_title', target: 'tuff', reqMod: 'mod_spectrometer', desc: 'Roll the [Tuff] title', reward: { coins: 50000n } }
];

module.exports = QUESTS;
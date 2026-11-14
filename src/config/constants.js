require('dotenv').config({ quiet: true });

const defaultDevIds = [];
const envDevIds = process.env.DEV_IDS
    ? process.env.DEV_IDS.split(',').map(id => id.trim()).filter(Boolean)
    : [];
const mergedDevIds = Array.from(new Set([...defaultDevIds, ...envDevIds]));

module.exports = {
    TOKEN: process.env.TOKEN || process.env.DISCORD_TOKEN || '',
    CLIENT_ID: process.env.CLIENT_ID || '',
    DATABASE_URL: process.env.DATABASE_URL || '',
    DB_HOST: process.env.DB_HOST || '127.0.0.1',
    DB_PORT: parseInt(process.env.DB_PORT, 10) || 3306,
    DB_USER: process.env.DB_USER || 'root',
    DB_PASSWORD: process.env.DB_PASSWORD || '',
    DB_NAME: process.env.DB_NAME || 'aris_db',
    DB_CONNECTION_LIMIT: parseInt(process.env.DB_CONNECTION_LIMIT, 10) || 10,
    DB_SSL: process.env.DB_SSL === 'true',
    PORT: parseInt(process.env.PORT, 10) || 10000,
    NODE_ENV: process.env.NODE_ENV || 'production',
    REGISTER_SLASH_COMMANDS: process.env.REGISTER_SLASH_COMMANDS !== 'false',
    DEV_IDS: mergedDevIds,
    PREFIX: process.env.PREFIX || '>',
    GLOBAL_COOLDOWN_MS: parseInt(process.env.GLOBAL_COOLDOWN_MS, 10) || 2000,
    FRAME_TIMEOUT_MS: parseInt(process.env.FRAME_TIMEOUT_MS, 10) || 300000,
    COOLDOWN_DELETE_MS: parseInt(process.env.COOLDOWN_DELETE_MS, 10) || 30000,
    ANSI: { 
        GREEN: "\u001b[38;2;3;252;32m",
        BLUE: "\u001b[38;2;3;78;252m",
        PINK: "\u001b[38;2;255;38;179m",
        YELLOW: "\u001b[38;2;252;255;97m",
        RESET: "\u001b[0m" 
    }
};

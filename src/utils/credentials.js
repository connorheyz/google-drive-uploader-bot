const fs = require('fs').promises;
const path = require('path');
const fsSync = require('fs');

// Store credentials outside the compiled code but inside the repo folder
const CREDENTIALS_FILE = path.join(__dirname, '..', '..', 'config', 'google-credentials.json');

async function loadCredentials() {
    try {
        const raw = await fs.readFile(CREDENTIALS_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') {
            // File doesn't exist - return empty object
            return {};
        }
        throw err;
    }
}

async function saveCredentials(creds) {
    await fs.writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), 'utf8');
}

async function getRefreshToken() {
    const creds = await loadCredentials();
    return creds.refresh_token;
}

async function setRefreshToken(token) {
    const creds = await loadCredentials();
    creds.refresh_token = token;
    await saveCredentials(creds);
}

function getRefreshTokenSync() {
    try {
        const raw = fsSync.readFileSync(CREDENTIALS_FILE, 'utf8');
        return JSON.parse(raw).refresh_token;
    } catch (err) {
        return undefined;
    }
}

module.exports = {
    loadCredentials,
    saveCredentials,
    getRefreshToken,
    setRefreshToken,
    getRefreshTokenSync,
    CREDENTIALS_FILE
}; 
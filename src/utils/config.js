const fs = require('fs').promises;
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', '..', 'config', 'config.json');

// Default configuration
const DEFAULT_CONFIG = {
    uploadChannels: [],
    defaultApprovalChannelId: "",
    approvalMappings: {}, // uploadChannelId -> approvalChannelId
    uploadEmoji: "⬆️",
    officerPermission: "ManageMessages",
    rootFolderId: "",
    cacheRefreshInterval: 3600000 // 1 hour in milliseconds
};

let currentConfig = { ...DEFAULT_CONFIG };

/**
 * Load configuration from JSON file
 */
async function loadConfig() {
    try {
        const configData = await fs.readFile(CONFIG_FILE, 'utf8');
        const parsedConfig = JSON.parse(configData);
        
        // Merge with defaults to ensure all properties exist
        currentConfig = { ...DEFAULT_CONFIG, ...parsedConfig };
        
        console.log('✅ Configuration loaded successfully');
        return currentConfig;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('⚠️ Config file not found, creating with defaults...');
            await saveConfig();
            return currentConfig;
        } else {
            console.error('❌ Error loading config:', error);
            console.log('📄 Using default configuration');
            return currentConfig;
        }
    }
}

/**
 * Save configuration to JSON file
 */
async function saveConfig() {
    try {
        // Ensure config directory exists
        const configDir = path.dirname(CONFIG_FILE);
        await fs.mkdir(configDir, { recursive: true });
        
        await fs.writeFile(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf8');
        console.log('✅ Configuration saved successfully');
        return true;
    } catch (error) {
        console.error('❌ Error saving config:', error);
        return false;
    }
}

/**
 * Get current configuration
 */
function getConfig() {
    return { ...currentConfig };
}

/**
 * Update configuration values
 */
async function updateConfig(updates) {
    currentConfig = { ...currentConfig, ...updates };
    return await saveConfig();
}

/**
 * Get specific config value
 */
function get(key) {
    return currentConfig[key];
}

/**
 * Set specific config value
 */
async function set(key, value) {
    currentConfig[key] = value;
    return await saveConfig();
}

/**
 * Add item to array config
 */
async function addToArray(key, value) {
    if (!Array.isArray(currentConfig[key])) {
        currentConfig[key] = [];
    }
    if (!currentConfig[key].includes(value)) {
        currentConfig[key].push(value);
        return await saveConfig();
    }
    return true; // Already exists
}

/**
 * Remove item from array config
 */
async function removeFromArray(key, value) {
    if (!Array.isArray(currentConfig[key])) {
        return true;
    }
    const index = currentConfig[key].indexOf(value);
    if (index > -1) {
        currentConfig[key].splice(index, 1);
        return await saveConfig();
    }
    return true; // Didn't exist
}

/**
 * Set approval mapping for an upload channel
 */
async function setApprovalMapping(uploadChannelId, approvalChannelId) {
    if (!currentConfig.approvalMappings) currentConfig.approvalMappings = {};
    currentConfig.approvalMappings[uploadChannelId] = approvalChannelId;
    return await saveConfig();
}

/**
 * Remove approval mapping
 */
async function removeApprovalMapping(uploadChannelId) {
    if (currentConfig.approvalMappings && currentConfig.approvalMappings[uploadChannelId]) {
        delete currentConfig.approvalMappings[uploadChannelId];
        return await saveConfig();
    }
    return true;
}

function getApprovalChannelFor(uploadChannelId) {
    if (currentConfig.approvalMappings && currentConfig.approvalMappings[uploadChannelId]) {
        return currentConfig.approvalMappings[uploadChannelId];
    }
    return currentConfig.defaultApprovalChannelId;
}

module.exports = {
    loadConfig,
    saveConfig,
    getConfig,
    updateConfig,
    get,
    set,
    addToArray,
    removeFromArray,
    setApprovalMapping,
    removeApprovalMapping,
    getApprovalChannelFor,
    DEFAULT_CONFIG
}; 
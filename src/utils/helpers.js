const { PermissionsBitField } = require('discord.js');

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Convert file size string back to bytes
 */
function parseFileSize(fileSizeStr) {
    const sizeMatch = fileSizeStr?.match(/^([\d.]+)\s*(Bytes|KB|MB|GB)$/);
    if (!sizeMatch) return 0;
    
    const value = parseFloat(sizeMatch[1]);
    const unit = sizeMatch[2];
    
    switch (unit) {
        case 'Bytes': return value;
        case 'KB': return value * 1024;
        case 'MB': return value * 1024 * 1024;
        case 'GB': return value * 1024 * 1024 * 1024;
        default: return 0;
    }
}

/**
 * Extract filename from Discord CDN URL
 */
function getFileNameFromUrl(url) {
    try {
        const urlParts = url.split('/');
        const fileName = urlParts[urlParts.length - 1].split('?')[0];
        return fileName || 'attachment';
    } catch {
        return 'attachment';
    }
}

/**
 * Helper to extract field values from Discord embeds (eliminates code duplication)
 */
function getFieldValue(embed, fieldName) {
    return embed.fields.find(f => f.name === fieldName)?.value;
}

/**
 * Safe user DM with error handling
 */
async function safeDM(user, content) {
    try {
        await user.send(content);
        return true;
    } catch (error) {
        console.log(`Could not DM user ${user.tag}: ${error.message}`);
        return false;
    }
}

/**
 * Check if user can trigger upload requests (original author or officer)
 */
async function canTriggerUpload(user, message) {
    // Check if user is the original message author
    if (user.id === message.author.id) {
        return { canUpload: true, reason: 'original_author' };
    }

    // Check officer permissions
    try {
        const guild = message.guild;
        if (!guild) return { canUpload: false, reason: 'no_guild' };

        const member = await guild.members.fetch(user.id);

        // Check Discord permission using config
        const config = require('./config');
        const officerPermission = config.get('officerPermission');
        if (officerPermission && member.permissions.has(PermissionsBitField.Flags[officerPermission])) {
            return { canUpload: true, reason: 'officer_permission' };
        }

    } catch (error) {
        console.error('❌ Error checking user permissions:', error);
    }

    return { canUpload: false, reason: 'no_permission' };
}

/**
 * Delete original DM message when request is processed (clean UX)
 */
async function deleteOriginalDM(client, userId, dmMessageId, requestId) {
    try {
        const user = client.users.cache.get(userId);
        if (!user) return;

        const dmChannel = await user.createDM();
        
        if (!dmMessageId) {
            console.log('⚠️ No DM message ID provided for request:', requestId);
            return;
        }

        const originalMessage = await dmChannel.messages.fetch(dmMessageId);
        await originalMessage.delete();
        console.log(`🗑️ Deleted original DM for request ${requestId}`);
        
    } catch (error) {
        console.error('❌ Could not delete original DM:', error);
        // Don't throw - the notification will still be sent
    }
}

module.exports = {
    formatFileSize,
    parseFileSize,
    getFileNameFromUrl,
    getFieldValue,
    safeDM,
    canTriggerUpload,
    deleteOriginalDM
}; 
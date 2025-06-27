require('dotenv').config();
const { Client, GatewayIntentBits, Events, PermissionsBitField, Partials } = require('discord.js');
const GoogleDriveService = require('./google-drive');

// Import our modular handlers
const { canTriggerUpload, getFileNameFromUrl, safeDM } = require('./utils/helpers');
const { sendAttachmentSelectionMessage, handleAttachmentSelection } = require('./handlers/attachments');
const { sendFolderSelectionMessage, extractRequestFromDMEmbed } = require('./handlers/upload-workflow');
const { createApprovalEmbed, createApprovalButtons } = require('./handlers/approval');

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions
    ],
    partials: [
        Partials.Message,
        Partials.Reaction,
        Partials.User
    ]
});

// Initialize Google Drive service
const driveService = new GoogleDriveService();

// Configuration
const UPLOAD_CHANNELS = process.env.UPLOAD_CHANNELS?.split(',') || [];
const APPROVAL_CHANNEL_ID = process.env.APPROVAL_CHANNEL_ID;
const UPLOAD_EMOJI = process.env.UPLOAD_EMOJI || '⬆️';
const OFFICER_PERMISSION = process.env.OFFICER_PERMISSION || 'ManageMessages';
const CACHE_REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour

// In-memory storage for upload requests (only needed for modal submissions due to Discord API limitations)
// Main workflow is now fully stateless using DM message IDs as request IDs
const uploadRequests = new Map();

// Wrapper function to maintain compatibility with upload workflow module
async function sendFolderSelectionMessageWrapper(user, requestId, interaction = null) {
    return await sendFolderSelectionMessage(user, requestId, interaction, uploadRequests, driveService);
}

// ================================
// EVENT HANDLERS
// ================================

client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Discord Art Upload Bot is ready!`);
    console.log(`Logged in as ${readyClient.user.tag}`);
    console.log(`Upload channels: ${UPLOAD_CHANNELS.length}`);
    console.log(`Approval channel: ${APPROVAL_CHANNEL_ID || 'Not configured'}`);
    console.log(`Upload emoji: ${UPLOAD_EMOJI}`);
    console.log(`Officer permission: ${OFFICER_PERMISSION || 'None configured'}`);
    
    // Validate officer permission
    if (OFFICER_PERMISSION && !PermissionsBitField.Flags[OFFICER_PERMISSION]) {
        console.error(`❌ Invalid OFFICER_PERMISSION: ${OFFICER_PERMISSION}`);
        console.log('Valid permissions include: ManageMessages, ManageChannels, ModerateMembers, Administrator, etc.');
        console.log('See Discord.js documentation for full list of permission flags.');
    }
    
    if (!OFFICER_PERMISSION) {
        console.log('⚠️ No officer permission configured - only original authors can trigger uploads');
    }
    
    // Build initial folder cache
    try {
        await driveService.buildFolderCache();
        
        // Set up periodic cache refresh
        setInterval(async () => {
            try {
                console.log('🔄 Refreshing folder cache...');
                await driveService.buildFolderCache();
            } catch (error) {
                console.error('⚠️ Failed to refresh folder cache:', error.message);
            }
        }, CACHE_REFRESH_INTERVAL);
        
    } catch (error) {
        console.error('❌ Failed to build initial folder cache:', error);
        console.log('The bot will continue running, but folder navigation may not work properly.');
    }
});

// Handle message reactions (upload requests)
client.on(Events.MessageReactionAdd, async (reaction, user) => {
    // Ignore bot reactions
    if (user.bot) return;

    // Handle partial reactions and messages
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('❌ Error fetching partial reaction:', error);
            return;
        }
    }

    if (reaction.message.partial) {
        try {
            await reaction.message.fetch();
        } catch (error) {
            console.error('❌ Error fetching partial message:', error);
            return;
        }
    }

    // Check if it's the upload emoji
    if (reaction.emoji.name !== UPLOAD_EMOJI && reaction.emoji.id !== UPLOAD_EMOJI) {
        return;
    }

    // Validation checks
    if (!UPLOAD_CHANNELS.includes(reaction.message.channel.id)) {
        await safeDM(user, '❌ Upload requests are only allowed in designated art channels.');
        return;
    }

    // Check if user has permission to trigger upload requests
    const permissionCheck = await canTriggerUpload(user, reaction.message);
    if (!permissionCheck.canUpload) {
        console.log(`⚠️ Upload reaction ignored: ${user.tag} (${permissionCheck.reason}) on message ${reaction.message.id}`);
        return;
    }

    console.log(`✅ Upload request initiated by ${user.tag} (${permissionCheck.reason}) on message ${reaction.message.id}`);

    if (reaction.message.attachments.size === 0) {
        await safeDM(user, '❌ You can only upload messages that contain image attachments.');
        return;
    }

    // Get all image attachments
    const imageAttachments = Array.from(reaction.message.attachments.values()).filter(att => 
        att.contentType && att.contentType.startsWith('image/')
    );

    if (imageAttachments.length === 0) {
        await safeDM(user, '❌ No image attachments found in that message.');
        return;
    }

    // Handle single attachment - direct to upload flow
    if (imageAttachments.length === 1) {
        const attachment = imageAttachments[0];
        const originalFileName = getFileNameFromUrl(attachment.url);
        const request = {
            userId: user.id,
            messageId: reaction.message.id,
            channelId: reaction.message.channel.id,
            attachmentUrl: attachment.url,
            originalFileName: originalFileName,
            fileSize: attachment.size,
            contentType: attachment.contentType,
            timestamp: Date.now(),
            currentPath: '',
            fileName: originalFileName,
            description: ''
        };

        try {
            const requestId = Date.now().toString() + '_' + user.id;
            request.requestId = requestId;
            uploadRequests.set(requestId, request);
            
            await sendFolderSelectionMessageWrapper(user, requestId);
        } catch (error) {
            console.error('❌ Error sending upload request to user:', error);
        }
        return;
    }

    // Handle multiple attachments - show selection menu
    try {
        await sendAttachmentSelectionMessage(user, reaction.message, imageAttachments);
    } catch (error) {
        console.error('❌ Error sending attachment selection to user:', error);
    }
});

// Load and configure the interaction handlers
require('./handlers/interactions')(client, uploadRequests, driveService, {
    sendFolderSelectionMessage: sendFolderSelectionMessageWrapper,
    extractRequestFromDMEmbed,
    createApprovalEmbed,
    createApprovalButtons,
    handleAttachmentSelection
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
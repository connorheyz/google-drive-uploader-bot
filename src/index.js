require('dotenv').config({ override: true });
const { Client, GatewayIntentBits, Events, PermissionsBitField, Partials, REST, Routes } = require('discord.js');
const GoogleDriveService = require('./services/googleDrive');

// Import config and handlers
const config = require('./utils/config');
const { canTriggerUpload, getFileNameFromUrl, safeDM } = require('./utils/helpers');
const { sendAttachmentSelectionMessage, handleAttachmentSelection } = require('./interactions/attachments');
const { sendFolderSelectionMessage, extractRequestFromDMEmbed } = require('./interactions/uploadWorkflow');
const { createApprovalEmbed, createApprovalButtons } = require('./interactions/approval');
const { createAdminCommands, handleAdminCommand } = require('./commands/admin');

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

// Configuration will be loaded from config.json

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
    // Load configuration
    await config.loadConfig();
    
    // Register slash commands (only if they don't exist or need updates)
    try {
        const commands = createAdminCommands();
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        
        console.log('Checking admin slash commands...');
        
        await rest.put(
            Routes.applicationCommands(readyClient.user.id),
            { body: commands }
        );
        
        console.log('✅ Global admin slash commands refreshed successfully!');
    } catch (error) {
        console.error('❌ Error managing admin slash commands:', error);
    }
    
    // Set up Google Drive with root folder if configured
    const rootFolderId = config.get('rootFolderId');
    if (rootFolderId) {
        try {
            await driveService.setRootFolder(rootFolderId);
            console.log(`📁 Using root folder ID: ${config.get('rootFolderId')}`);
        } catch (error) {
            console.error('❌ Error setting root folder:', error);
        }
    }
    
    // Build initial folder cache
    try {
        await driveService.buildFolderCache();
        
        // Set up periodic cache refresh
        const cacheInterval = config.get('cacheRefreshInterval');
        setInterval(async () => {
            try {
                console.log('🔄 Refreshing folder cache...');
                await driveService.buildFolderCache();
            } catch (error) {
                console.error('⚠️ Failed to refresh folder cache:', error.message);
            }
        }, cacheInterval);
        
    } catch (error) {
        console.error('❌ Failed to build initial folder cache:', error);
        console.log('The bot will continue running, but folder navigation may not work properly.');
    }
    
    console.log(`Discord Art Upload Bot is ready!`);
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
    const uploadEmoji = config.get('uploadEmoji');
    if (reaction.emoji.name !== uploadEmoji && reaction.emoji.id !== uploadEmoji) {
        return;
    }

    // Validation checks
    const uploadChannels = config.get('uploadChannels');
    if (!uploadChannels.includes(reaction.message.channel.id)) {
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
        await safeDM(user, '❌ You can only upload messages that contain file attachments.');
        return;
    }

    // Get all attachments
    const attachments = Array.from(reaction.message.attachments.values());

    if (attachments.length === 0) {
        await safeDM(user, '❌ No file attachments found in that message.');
        return;
    }

    // Handle single attachment - direct to upload flow
    if (attachments.length === 1) {
        const attachment = attachments[0];
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
        await sendAttachmentSelectionMessage(user, reaction.message, attachments);
    } catch (error) {
        console.error('❌ Error sending attachment selection to user:', error);
    }
});

// Handle slash commands
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    
    const adminCommands = [
        'set-upload-emoji', 'add-upload-channel', 'remove-upload-channel',
        'set-default-approval-channel', 'map-approval-channel', 'refresh-folders', 'set-root-folder', 'show-config', 'google-auth-start', 'google-auth-finish', 'set-officer-permission'
    ];
    
    if (adminCommands.includes(interaction.commandName)) {
        await handleAdminCommand(interaction, driveService);
    }
});

// Load and configure the interaction handlers
require('./interactions/interactions')(client, uploadRequests, driveService, {
    sendFolderSelectionMessage: sendFolderSelectionMessageWrapper,
    extractRequestFromDMEmbed,
    createApprovalEmbed,
    createApprovalButtons,
    handleAttachmentSelection
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
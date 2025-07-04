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

// Utility function to clean up duplicate commands
async function cleanupDuplicateCommands(rest, clientId, guildId = null) {
    try {
        console.log(`🔍 Checking for duplicate commands... (Guild: ${guildId || 'Global'})`);
        
        let existingCommands;
        if (guildId) {
            existingCommands = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
        } else {
            existingCommands = await rest.get(Routes.applicationCommands(clientId));
        }

        console.log(`📋 Found ${existingCommands.length} existing commands:`);
        existingCommands.forEach(cmd => {
            console.log(`   - ${cmd.name} (ID: ${cmd.id})`);
        });

        // Group commands by name to find duplicates
        const commandGroups = existingCommands.reduce((groups, cmd) => {
            if (!groups[cmd.name]) groups[cmd.name] = [];
            groups[cmd.name].push(cmd);
            return groups;
        }, {});

        // Delete duplicates (keep the first one of each name)
        let duplicatesFound = false;
        for (const [name, commands] of Object.entries(commandGroups)) {
            if (commands.length > 1) {
                duplicatesFound = true;
                console.log(`🧹 Found ${commands.length} duplicate commands for "${name}", cleaning up...`);
                // Delete all but the first one
                for (let i = 1; i < commands.length; i++) {
                    console.log(`🗑️ Deleting duplicate command "${name}" (ID: ${commands[i].id})`);
                    if (guildId) {
                        await rest.delete(Routes.applicationGuildCommand(clientId, guildId, commands[i].id));
                    } else {
                        await rest.delete(Routes.applicationCommand(clientId, commands[i].id));
                    }
                    console.log(`✅ Deleted duplicate command "${name}"`);
                }
            }
        }
        
        if (duplicatesFound) {
            console.log('✅ All duplicate commands cleaned up successfully');
        } else {
            console.log('✅ No duplicate commands found');
        }
    } catch (error) {
        console.error('❌ Error cleaning up duplicate commands:', error);
        console.error('Full error details:', error.stack);
    }
}

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
    
    console.log(`Discord Art Upload Bot is ready!`);
    console.log(`Logged in as ${readyClient.user.tag}`);
    console.log(`Upload channels: ${config.get('uploadChannels').length}`);
    console.log(`Approval channel: ${config.get('approvalChannelId') || 'Not configured'}`);
    console.log(`Upload emoji: ${config.get('uploadEmoji')}`);
    console.log(`Officer permission: ${config.get('officerPermission')}`);
    console.log(`Root folder: ${config.get('rootFolderName') || 'Not configured'}`);
    
    // Validate officer permission
    const officerPermission = config.get('officerPermission');
    if (officerPermission && !PermissionsBitField.Flags[officerPermission]) {
        console.error(`❌ Invalid officer permission: ${officerPermission}`);
        console.log('Valid permissions include: ManageMessages, ManageChannels, ModerateMembers, Administrator, etc.');
    }
    
    // Register slash commands (only if they don't exist or need updates)
    try {
        const commands = createAdminCommands();
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        
        console.log('🔄 Checking admin slash commands...');
        
        // Always use global commands for better compatibility
        console.log('📝 Refreshing global admin slash commands...');
        console.log('⏳ Note: Global commands may take up to 1 hour to update across all servers');
        
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
            console.log(`📁 Using root folder: ${config.get('rootFolderName')}`);
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

// Handle slash commands
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    
    const adminCommands = [
        'set-upload-emoji', 'add-upload-channel', 'remove-upload-channel',
        'set-approval-channel', 'refresh-folders', 'set-root-folder', 'show-config'
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
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const config = require('../utils/config');
const { google } = require('googleapis');
const crypto = require('crypto');

// Map to track pending auth states
const googleAuthStates = new Map();

/**
 * Check if user has officer permissions
 */
function hasOfficerPermissions(member) {
    const requiredPermission = config.get('officerPermission');
    return member.permissions.has(PermissionFlagsBits[requiredPermission]);
}

/**
 * Check if user has admin permissions (highest level)
 */
function hasAdminPermissions(member) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
}

/**
 * Create admin slash commands
 */
function createAdminCommands() {
    const commands = [];

    // Upload emoji command
    commands.push(
        new SlashCommandBuilder()
            .setName('set-upload-emoji')
            .setDescription('Set the emoji used for upload reactions')
            .addStringOption(option =>
                option.setName('emoji')
                    .setDescription('The emoji to use (Unicode emoji or custom emoji)')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    );

    // Add upload channel
    commands.push(
        new SlashCommandBuilder()
            .setName('add-upload-channel')
            .setDescription('Add a channel where users can react to upload assets')
            .addChannelOption(option =>
                option.setName('channel')
                    .setDescription('The channel to add')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    );

    // Remove upload channel
    commands.push(
        new SlashCommandBuilder()
            .setName('remove-upload-channel')
            .setDescription('Remove a channel from the upload channels list')
            .addChannelOption(option =>
                option.setName('channel')
                    .setDescription('The channel to remove')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    );

    // Set default approval channel
    commands.push(
        new SlashCommandBuilder()
            .setName('set-default-approval-channel')
            .setDescription('Set the channel where upload requests are sent when no custom mapping is defined')
            .addChannelOption(option =>
                option.setName('channel')
                    .setDescription('The default approval channel')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    );

    // Map upload channel -> approval channel
    commands.push(
        new SlashCommandBuilder()
            .setName('map-approval-channel')
            .setDescription('Map a specific upload channel to its own approval channel')
            .addChannelOption(option =>
                option.setName('upload_channel')
                    .setDescription('Channel where users react to upload')
                    .setRequired(true))
            .addChannelOption(option =>
                option.setName('approval_channel')
                    .setDescription('Channel where requests from this upload channel go')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    );

    // Force cache refresh
    commands.push(
        new SlashCommandBuilder()
            .setName('refresh-folders')
            .setDescription('Force update the Google Drive folder structure cache')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    );

    // Set root folder (admin only)
    commands.push(
        new SlashCommandBuilder()
            .setName('set-root-folder')
            .setDescription('Set the root Google Drive folder via share link (ADMIN ONLY)')
            .addStringOption(option =>
                option.setName('link')
                    .setDescription('Google Drive folder share link')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    );

    // Google OAuth start (admin only)
    commands.push(
        new SlashCommandBuilder()
            .setName('google-auth-start')
            .setDescription('Start Google Drive OAuth flow (ADMIN ONLY)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    );

    // Google OAuth finish
    commands.push(
        new SlashCommandBuilder()
            .setName('google-auth-finish')
            .setDescription('Complete Google OAuth flow with authorization code (ADMIN ONLY)')
            .addStringOption(option =>
                option.setName('code')
                    .setDescription('Authorization code returned by Google')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    );

    // Set officer permission (admin only)
    commands.push(
        new SlashCommandBuilder()
            .setName('set-officer-permission')
            .setDescription('Set the Discord permission required for officers (ADMIN ONLY)')
            .addStringOption(option =>
                option.setName('permission')
                    .setDescription('Discord permission name (e.g., ManageMessages, ModerateMembers, Administrator)')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Manage Messages', value: 'ManageMessages' },
                        { name: 'Manage Channels', value: 'ManageChannels' },
                        { name: 'Moderate Members', value: 'ModerateMembers' },
                        { name: 'Manage Roles', value: 'ManageRoles' },
                        { name: 'Manage Guild', value: 'ManageGuild' },
                        { name: 'Administrator', value: 'Administrator' },
                        { name: 'View Audit Log', value: 'ViewAuditLog' },
                        { name: 'Manage Webhooks', value: 'ManageWebhooks' },
                        { name: 'Manage Emojis and Stickers', value: 'ManageEmojisAndStickers' }
                    ))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    );

    // Show config
    commands.push(
        new SlashCommandBuilder()
            .setName('show-config')
            .setDescription('Display current bot configuration')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    );

    // Disable commands in direct messages
    commands.forEach(cmd => cmd.setDMPermission(false));

    return commands;
}

/**
 * Handle admin command interactions
 */
async function handleAdminCommand(interaction, driveService) {
    const { commandName, member } = interaction;

    // Check permissions
    if (['set-root-folder', 'google-auth-start', 'google-auth-finish', 'set-officer-permission'].includes(commandName)) {
        if (!hasAdminPermissions(member)) {
            await interaction.reply({ content: '❌ This command requires Administrator permissions.', flags: MessageFlags.Ephemeral });
            return;
        }
    } else {
        if (!hasOfficerPermissions(member)) {
            await interaction.reply({ content: '❌ You don\'t have permission to use this command.', flags: MessageFlags.Ephemeral });
            return;
        }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        switch (commandName) {
            case 'set-upload-emoji':
                await handleSetUploadEmoji(interaction);
                break;
            case 'add-upload-channel':
                await handleAddUploadChannel(interaction);
                break;
            case 'remove-upload-channel':
                await handleRemoveUploadChannel(interaction);
                break;
            case 'set-default-approval-channel':
                await handleSetDefaultApprovalChannel(interaction);
                break;
            case 'map-approval-channel':
                await handleMapApprovalChannel(interaction);
                break;
            case 'refresh-folders':
                await handleRefreshFolders(interaction, driveService);
                break;
            case 'set-root-folder':
                await handleSetRootFolder(interaction, driveService);
                break;
            case 'google-auth-start':
                await handleGoogleAuthStart(interaction);
                break;
            case 'google-auth-finish':
                await handleGoogleAuthFinish(interaction, driveService);
                break;
            case 'set-officer-permission':
                await handleSetOfficerPermission(interaction);
                break;
            case 'show-config':
                await handleShowConfig(interaction);
                break;
            default:
                await interaction.editReply('❌ Unknown command.');
        }
    } catch (error) {
        console.error(`❌ Error handling admin command ${commandName}:`, error);
        await interaction.editReply('❌ An error occurred while processing the command.');
    }
}

async function handleSetUploadEmoji(interaction) {
    const emoji = interaction.options.getString('emoji');
    
    await config.set('uploadEmoji', emoji);
    
    await interaction.editReply(`✅ Upload emoji updated to: ${emoji}`);
}

async function handleAddUploadChannel(interaction) {
    const channel = interaction.options.getChannel('channel');
    
    const success = await config.addToArray('uploadChannels', channel.id);
    
    if (success) {
        await interaction.editReply(`✅ Added ${channel} to upload channels list.`);
    } else {
        await interaction.editReply(`❌ Failed to update configuration.`);
    }
}

async function handleRemoveUploadChannel(interaction) {
    const channel = interaction.options.getChannel('channel');
    
    const success = await config.removeFromArray('uploadChannels', channel.id);
    
    if (success) {
        await interaction.editReply(`✅ Removed ${channel} from upload channels list.`);
    } else {
        await interaction.editReply(`❌ Failed to update configuration.`);
    }
}

async function handleSetDefaultApprovalChannel(interaction) {
    const channel = interaction.options.getChannel('channel');
    await config.set('defaultApprovalChannelId', channel.id);
    await interaction.editReply(`✅ Default approval channel set to: ${channel}`);
}

async function handleMapApprovalChannel(interaction) {
    const uploadChannel = interaction.options.getChannel('upload_channel');
    const approvalChannel = interaction.options.getChannel('approval_channel');
    await config.setApprovalMapping(uploadChannel.id, approvalChannel.id);
    await interaction.editReply(`✅ Mapped ${uploadChannel} → ${approvalChannel} for approvals.`);
}

async function handleRefreshFolders(interaction, driveService) {
    try {
        await driveService.refreshFolderCache();
        await interaction.editReply('✅ Google Drive folder cache refreshed successfully!');
    } catch (error) {
        console.error('❌ Error refreshing folder cache:', error);
        await interaction.editReply('❌ Failed to refresh folder cache. Check console for details.');
    }
}

async function handleSetRootFolder(interaction, driveService) {
    const link = interaction.options.getString('link');
    
    // Extract folder ID from Google Drive link
    const folderIdMatch = link.match(/\/folders\/([a-zA-Z0-9-_]+)/);
    if (!folderIdMatch) {
        await interaction.editReply('❌ Invalid Google Drive folder link. Please provide a valid share link.');
        return;
    }
    
    const folderId = folderIdMatch[1];
    
    try {
        // Verify the folder exists and get its name
        const folderInfo = await driveService.getFolderInfo(folderId);
        
        if (!folderInfo) {
            await interaction.editReply('❌ Could not access the specified folder. Make sure the bot has permission to access it.');
            return;
        }
        
        // Update configuration (only ID)
        await config.set('rootFolderId', folderId);
        
        // Refresh folder cache with new root
        await driveService.setRootFolder(folderId);
        await driveService.refreshFolderCache();
        
        await interaction.editReply(`✅ Root folder set to: **${folderInfo.name}**\nFolder cache refreshed with new root.`);
        
    } catch (error) {
        console.error('❌ Error setting root folder:', error);
        await interaction.editReply('❌ Failed to set root folder. Make sure the folder exists and the bot has access.');
    }
}

async function handleGoogleAuthStart(interaction) {
    // Generate random state string
    const state = crypto.randomBytes(16).toString('hex');

    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob'
    );

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline', // ensures refresh token
        scope: ['https://www.googleapis.com/auth/drive'],
        prompt: 'consent',
        state
    });

    // Store state -> user mapping (expires in 10 min)
    googleAuthStates.set(state, { userId: interaction.user.id, created: Date.now() });
    setTimeout(() => googleAuthStates.delete(state), 10 * 60 * 1000);

    const embed = new EmbedBuilder()
        .setTitle('Google Drive Authorization')
        .setDescription('Click the button below to authorize the bot. After allowing access you will get an **authorization code** – run `/google-auth-finish` with that code to complete setup.')
        .setColor(0x4285F4); // Google blue

    const button = new ButtonBuilder()
        .setLabel('Authorize Google')
        .setStyle(ButtonStyle.Link)
        .setURL(authUrl)
        .setEmoji('🔗');

    const row = new ActionRowBuilder().addComponents(button);

    await interaction.editReply({ embeds: [embed], components: [row] });
}

async function handleGoogleAuthFinish(interaction, driveService) {
    const code = interaction.options.getString('code');

    // Create OAuth client
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob'
    );

    try {
        const { tokens } = await oauth2Client.getToken(code);
        if (!tokens.refresh_token) {
            await interaction.editReply('❌ Google did not return a refresh token. Make sure you checked "Consent" during authorization and that you used the link from /google-auth-start.');
            return;
        }

        await driveService.applyNewRefreshToken(tokens.refresh_token);

        await interaction.editReply('✅ Google account linked successfully! The bot can now access Google Drive.');
    } catch (err) {
        console.error('❌ Error completing OAuth flow:', err);
        await interaction.editReply('❌ Failed to complete OAuth flow. Check the authorization code and try again.');
    }
}

async function handleSetOfficerPermission(interaction) {
    const permission = interaction.options.getString('permission');
    
    // Validate permission exists in Discord's PermissionFlagsBits
    if (!PermissionFlagsBits[permission]) {
        await interaction.editReply(`❌ Invalid permission: ${permission}. Please use a valid Discord permission.`);
        return;
    }
    
    try {
        // Update config
        await config.set('officerPermission', permission);
        
        const embed = new EmbedBuilder()
            .setTitle('✅ Officer Permission Updated')
            .setDescription(`Officer permission has been set to **${permission}**`)
            .addFields(
                { name: '💡 What this means', value: `Users with the "${permission}" permission can now trigger uploads on any message by reacting with the upload emoji.`, inline: false },
                { name: '🔧 How to use', value: '1. Go to Server Settings → Roles\n2. Create or edit a role\n3. Enable the "' + permission + '" permission\n4. Assign the role to users who should be officers', inline: false }
            )
            .setColor(0x27ae60)
            .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
        
        console.log(`✅ Officer permission updated to: ${permission} by ${interaction.user.tag}`);
        
    } catch (error) {
        console.error('❌ Error updating officer permission:', error);
        await interaction.editReply('❌ Failed to update officer permission. Check console for details.');
    }
}

async function handleShowConfig(interaction) {
    const currentConfig = config.getConfig();
    
    const embed = new EmbedBuilder()
        .setTitle('🔧 Bot Configuration')
        .setColor(0x3498db)
        .addFields(
            { name: '📤 Upload Emoji', value: currentConfig.uploadEmoji || '*(not set)*', inline: true },
            { name: '📋 Upload Channels', value: currentConfig.uploadChannels.length > 0 ? currentConfig.uploadChannels.map(id => `<#${id}>`).join('\n') : '*(none)*', inline: true },
            { name: '✅ Default Approval', value: currentConfig.defaultApprovalChannelId ? `<#${currentConfig.defaultApprovalChannelId}>` : '*(not set)*', inline: true },
            { name: '📑 Channel Mappings', value: Object.keys(currentConfig.approvalMappings||{}).length > 0 ? Object.entries(currentConfig.approvalMappings).map(([u,a])=>`<#${u}> → <#${a}>`).join('\n') : '*(none)*', inline: false },
            { name: '👮 Officer Permission', value: currentConfig.officerPermission, inline: true },
            { name: '📁 Root Folder ID', value: currentConfig.rootFolderId || '*(not set)*', inline: true },
            { name: '🔄 Cache Refresh Interval', value: `${Math.round(currentConfig.cacheRefreshInterval / 60000)} minutes`, inline: true }
        )
        .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
}

module.exports = {
    createAdminCommands,
    handleAdminCommand,
    hasOfficerPermissions,
    hasAdminPermissions
}; 
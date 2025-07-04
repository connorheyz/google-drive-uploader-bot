const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const config = require('../utils/config');

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
            .setDescription('Add a channel where users can react to upload images')
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

    // Set approval channel
    commands.push(
        new SlashCommandBuilder()
            .setName('set-approval-channel')
            .setDescription('Set the channel where upload requests are sent for approval')
            .addChannelOption(option =>
                option.setName('channel')
                    .setDescription('The approval channel')
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

    // Show config
    commands.push(
        new SlashCommandBuilder()
            .setName('show-config')
            .setDescription('Display current bot configuration')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    );

    return commands;
}

/**
 * Handle admin command interactions
 */
async function handleAdminCommand(interaction, driveService) {
    const { commandName, member } = interaction;

    // Check permissions
    if (commandName === 'set-root-folder') {
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
            case 'set-approval-channel':
                await handleSetApprovalChannel(interaction);
                break;
            case 'refresh-folders':
                await handleRefreshFolders(interaction, driveService);
                break;
            case 'set-root-folder':
                await handleSetRootFolder(interaction, driveService);
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

async function handleSetApprovalChannel(interaction) {
    const channel = interaction.options.getChannel('channel');
    
    await config.set('approvalChannelId', channel.id);
    
    await interaction.editReply(`✅ Approval channel set to: ${channel}`);
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
        
        // Update configuration
        await config.updateConfig({
            rootFolderId: folderId,
            rootFolderName: folderInfo.name
        });
        
        // Refresh folder cache with new root
        await driveService.setRootFolder(folderId);
        await driveService.refreshFolderCache();
        
        await interaction.editReply(`✅ Root folder set to: **${folderInfo.name}**\nFolder cache refreshed with new root.`);
        
    } catch (error) {
        console.error('❌ Error setting root folder:', error);
        await interaction.editReply('❌ Failed to set root folder. Make sure the folder exists and the bot has access.');
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
            { name: '✅ Approval Channel', value: currentConfig.approvalChannelId ? `<#${currentConfig.approvalChannelId}>` : '*(not set)*', inline: true },
            { name: '👮 Officer Permission', value: currentConfig.officerPermission, inline: true },
            { name: '📁 Root Folder', value: currentConfig.rootFolderName || '*(not set)*', inline: true },
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
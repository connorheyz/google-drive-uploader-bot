const { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { formatFileSize, getFieldValue, parseFileSize } = require('../utils/helpers');

/**
 * Send or update folder selection message for upload workflow
 */
async function sendFolderSelectionMessage(user, requestId, interaction = null, uploadRequests, driveService) {
    const request = uploadRequests.get(requestId);
    if (!request) return;

    // Get folders for current path
    const folders = driveService.getFoldersForSelectMenu(request.currentPath);
    
    const embed = new EmbedBuilder()
        .setTitle('📤 Upload to Google Drive')
        .setDescription(`**File:** [${request.originalFileName}](${request.attachmentUrl}) (${formatFileSize(request.fileSize)})`)
        .addFields(
            { name: '📁 Current Location', value: request.currentPath || '*(Root)*', inline: true },
            { name: '📝 File Name', value: request.fileName, inline: true },
            { name: '📋 Description', value: request.description || '*(none)*', inline: false }
        )
        .setColor(0x3498db)
        .setTimestamp();

    const components = [];

    // Folder selection dropdown (if folders exist)
    if (folders.length > 0) {
        // Contextual placeholder text based on current location
        const placeholderText = request.currentPath 
            ? '📁 Choose a subfolder to navigate into...'
            : '📁 Choose a folder to navigate into...';

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`dm_folder_select_${requestId}`)
            .setPlaceholder(placeholderText)
            .addOptions(folders);

        components.push(new ActionRowBuilder().addComponents(selectMenu));
    }

    // Navigation and action buttons
    const buttonRow = new ActionRowBuilder();

    // Back button (if not at root)
    if (request.currentPath) {
        buttonRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`dm_folder_back_${requestId}`)
                .setLabel('Back')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('⬅️')
        );
    }

    // Edit file details button
    buttonRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`dm_edit_details_${requestId}`)
            .setLabel('Edit Details')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('✏️')
    );

    // Confirm upload button
    buttonRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`dm_confirm_upload_${requestId}`)
            .setLabel('Upload Here')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅')
    );

    // Cancel button (always available)
    buttonRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`dm_cancel_${requestId}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
    );

    components.push(buttonRow);

    // Add folder status info
    if (folders.length === 0 && !request.currentPath) {
        embed.addFields({ name: '⚠️ No Folders', value: 'No subfolders found. You can upload to the root location.', inline: false });
    } else if (folders.length === 0) {
        embed.addFields({ name: '📁 End of Path', value: 'No subfolders here. Choose "Upload Here" to upload to this location.', inline: false });
    }

    const messageData = { embeds: [embed], components };

    // Send or edit message
    if (interaction) {
        await interaction.editReply(messageData);
    } else {
        await user.send(messageData);
    }
}

/**
 * Extract upload request data from DM embed (stateless recovery)
 */
function extractRequestFromDMEmbed(embed, interaction) {
    if (!embed || embed.title !== '📤 Upload to Google Drive') return null;
    
    // Extract data from visible fields
    const currentPath = getFieldValue(embed, '📁 Current Location')?.replace('*(Root)*', '') || '';
    const fileName = getFieldValue(embed, '📝 File Name');
    const description = getFieldValue(embed, '📋 Description')?.replace('*(none)*', '') || '';
    
    // Parse original filename, URL, and file size from description
    // Format: "**File:** [filename.ext](url) (X.X MB)"
    const descMatch = embed.description?.match(/\*\*File:\*\* \[(.+?)\]\((.+?)\) \((.+?)\)/);
    if (!descMatch) return null;
    
    const originalFileName = descMatch[1];
    const attachmentUrl = descMatch[2];
    const fileSize = parseFileSize(descMatch[3]);
    
    if (!attachmentUrl || !originalFileName) return null;
    
    return {
        attachmentUrl,
        fileSize,
        userId: interaction.user.id,
        originalFileName,
        fileName,
        description,
        currentPath,
        requestId: null // Will be set by caller
    };
}

module.exports = {
    sendFolderSelectionMessage,
    extractRequestFromDMEmbed
}; 
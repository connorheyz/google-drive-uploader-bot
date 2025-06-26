require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, Partials, StringSelectMenuBuilder } = require('discord.js');
const GoogleDriveService = require('./google-drive');

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
const UPLOAD_EMOJI = process.env.UPLOAD_EMOJI || '📤';
const CACHE_REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour

// In-memory storage for upload requests (only needed for modal submissions due to Discord API limitations)
// Main workflow is now fully stateless using DM message IDs as request IDs
const uploadRequests = new Map();

// ================================
// UTILITY FUNCTIONS
// ================================

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

// ================================
// CORE FUNCTIONS
// ================================

/**
 * Send or update folder selection message for upload workflow
 */
async function sendFolderSelectionMessage(user, requestId, interaction = null) {
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
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`dm_folder_select_${requestId}`)
            .setPlaceholder('📁 Choose a folder to navigate into...')
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
 * Delete original DM message when request is processed (clean UX)
 */
async function deleteOriginalDM(userId, dmMessageId, requestId) {
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

/**
 * Create approval embed for officer channel
 */
function createApprovalEmbed(user, request, dmMessageId) {
    return new EmbedBuilder()
        .setTitle('📤 Upload Request for Approval')
        .setDescription(`**${user.displayName}** wants to upload a file to Google Drive`)
        .addFields(
            { name: '👤 Requested by', value: `<@${user.id}>`, inline: true },
            { name: '📁 File Name', value: request.fileName, inline: true },
            { name: '📊 File Size', value: formatFileSize(request.fileSize), inline: true },
            { name: '📂 Upload Path', value: request.currentPath || '*(root folder)*', inline: true },
            { name: '🔗 Original File', value: request.attachmentUrl, inline: true },
            { name: '📋 Description', value: request.description || '*(no description)*', inline: false }
        )
        .setColor(0xf39c12)
        .setTimestamp()
        .setFooter({ text: `Request ID: ${dmMessageId}` });
}

/**
 * Create approval action buttons
 */
function createApprovalButtons(dmMessageId) {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`approve_${dmMessageId}`)
                .setLabel('Approve')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId(`deny_${dmMessageId}`)
                .setLabel('Deny')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌'),
            new ButtonBuilder()
                .setCustomId(`officer_edit_${dmMessageId}`)
                .setLabel('Edit Details')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('✏️')
        );
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
        console.error('⚠️ Failed to build initial folder cache:', error.message);
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

    if (reaction.message.attachments.size === 0) {
        await safeDM(user, '❌ You can only upload messages that contain image attachments.');
        return;
    }

    // Get the first image attachment
    const attachment = reaction.message.attachments.find(att => 
        att.contentType && att.contentType.startsWith('image/')
    );

    if (!attachment) {
        await safeDM(user, '❌ No image attachments found in that message.');
        return;
    }

    // Prepare request data
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

    // Send folder selection message
    try {
        // Use timestamp + user ID as temporary request ID
        const requestId = Date.now().toString() + '_' + user.id;
        request.requestId = requestId;
        uploadRequests.set(requestId, request);
        
        await sendFolderSelectionMessage(user, requestId);
    } catch (error) {
        console.error('❌ Error sending upload request to user:', error);
    }
});

// ================================
// INTERACTION HANDLERS
// ================================

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isStringSelectMenu()) return;

    // ================================
    // DM WORKFLOW INTERACTIONS
    // ================================

    // Handle folder selection (select menu)
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('dm_folder_select_')) {
        const requestId = interaction.customId.replace('dm_folder_select_', '');
        
        const request = extractRequestFromDMEmbed(interaction.message.embeds[0], interaction);
        if (!request) {
            await interaction.reply({ content: '❌ Upload request expired or not found.', ephemeral: true });
            return;
        }

        request.requestId = requestId;
        request.currentPath = interaction.values[0];
        uploadRequests.set(requestId, request);

        await interaction.deferUpdate();
        try {
            await sendFolderSelectionMessage(interaction.user, requestId, interaction);
        } catch (error) {
            console.error('❌ Error updating folder navigation:', error);
            await interaction.followUp({ content: '❌ Error updating folder navigation.', ephemeral: true });
        }
    }

    // Handle back navigation
    if (interaction.isButton() && interaction.customId.startsWith('dm_folder_back_')) {
        const requestId = interaction.customId.replace('dm_folder_back_', '');
        
        const request = extractRequestFromDMEmbed(interaction.message.embeds[0], interaction);
        if (!request) {
            await interaction.reply({ content: '❌ Upload request expired or not found.', ephemeral: true });
            return;
        }

        request.requestId = requestId;
        const pathParts = request.currentPath.split('/');
        pathParts.pop();
        request.currentPath = pathParts.join('/');
        uploadRequests.set(requestId, request);

        await interaction.deferUpdate();
        try {
            await sendFolderSelectionMessage(interaction.user, requestId, interaction);
        } catch (error) {
            console.error('❌ Error navigating back:', error);
            await interaction.followUp({ content: '❌ Error navigating back.', ephemeral: true });
        }
    }

    // Handle edit details button
    if (interaction.isButton() && interaction.customId.startsWith('dm_edit_details_')) {
        const requestId = interaction.customId.replace('dm_edit_details_', '');
        
        const request = extractRequestFromDMEmbed(interaction.message.embeds[0], interaction);
        if (!request) {
            await interaction.reply({ content: '❌ Upload request expired or not found.', ephemeral: true });
            return;
        }
        
        request.requestId = requestId;
        uploadRequests.set(requestId, request);

        const modal = new ModalBuilder()
            .setCustomId(`dm_details_modal_${requestId}`)
            .setTitle('✏️ Edit Upload Details');

        const fileNameInput = new TextInputBuilder()
            .setCustomId('filename')
            .setLabel('File Name')
            .setStyle(TextInputStyle.Short)
            .setValue(request.fileName)
            .setRequired(true)
            .setMaxLength(100);

        const descriptionInput = new TextInputBuilder()
            .setCustomId('description')
            .setLabel('Description (optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(request.description || '')
            .setPlaceholder('Brief description of the artwork...')
            .setRequired(false)
            .setMaxLength(500);

        modal.addComponents(
            new ActionRowBuilder().addComponents(fileNameInput),
            new ActionRowBuilder().addComponents(descriptionInput)
        );

        await interaction.showModal(modal);
    }

    // Handle confirm upload button
    if (interaction.isButton() && interaction.customId.startsWith('dm_confirm_upload_')) {
        const requestId = interaction.customId.replace('dm_confirm_upload_', '');
        
        const request = extractRequestFromDMEmbed(interaction.message.embeds[0], interaction);
        if (!request) {
            await interaction.reply({ content: '❌ Upload request expired or not found.', ephemeral: true });
            return;
        }
        
        request.requestId = requestId;
        uploadRequests.set(requestId, request);

        await interaction.deferReply({ ephemeral: true });

        // Validate approval channel configuration
        if (!APPROVAL_CHANNEL_ID) {
            await interaction.editReply('❌ Approval channel not configured. Contact an administrator.');
            return;
        }

        const approvalChannel = client.channels.cache.get(APPROVAL_CHANNEL_ID);
        if (!approvalChannel) {
            await interaction.editReply('❌ Could not find approval channel. Contact an administrator.');
            return;
        }

        // Use DM message ID as the request ID for stateless operation
        const dmMessageId = interaction.message.id;
        
        try {
            // Send approval request
            const approvalEmbed = createApprovalEmbed(interaction.user, request, dmMessageId);
            const approvalButtons = createApprovalButtons(dmMessageId);
            
            await approvalChannel.send({ 
                embeds: [approvalEmbed], 
                components: [approvalButtons] 
            });
            
            console.log(`📤 Upload request ${dmMessageId} sent for approval`);

            // Update original DM to show submission status
            const submittedEmbed = new EmbedBuilder()
                .setTitle('📤 Upload Request Submitted ✅')
                .setDescription(`**File:** [${request.originalFileName}](${request.attachmentUrl}) (${formatFileSize(request.fileSize)})`)
                .addFields(
                    { name: '📂 Upload Location', value: request.currentPath || '*(Root)*', inline: true },
                    { name: '📝 File Name', value: request.fileName, inline: true },
                    { name: '🆔 Request ID', value: dmMessageId, inline: true },
                    { name: '📋 Description', value: request.description || '*(none)*', inline: false },
                    { name: '⏳ Status', value: 'Sent to officers for approval. You\'ll be notified when processed.', inline: false }
                )
                .setColor(0xf39c12)
                .setTimestamp();

            try {
                await interaction.message.edit({ 
                    embeds: [submittedEmbed], 
                    components: [] // Remove buttons to prevent spam
                });
            } catch (error) {
                console.error('❌ Could not edit original DM:', error);
            }

            await interaction.editReply('✅ Upload request submitted for approval! The message above has been updated.');
        } catch (error) {
            console.error('❌ Error sending approval request:', error);
            await interaction.editReply('❌ Error submitting request for approval. Contact an administrator.');
        }
    }

    // Handle details modal submission
    if (interaction.isModalSubmit() && interaction.customId.startsWith('dm_details_modal_')) {
        const requestId = interaction.customId.replace('dm_details_modal_', '');
        
        const request = uploadRequests.get(requestId);
        if (!request) {
            await interaction.reply({ content: '❌ Upload session expired. Please start a new upload request.', ephemeral: true });
            return;
        }

        const fileName = interaction.fields.getTextInputValue('filename').trim();
        const description = interaction.fields.getTextInputValue('description').trim();

        request.fileName = fileName;
        request.description = description;
        uploadRequests.set(requestId, request);

        await interaction.deferUpdate();
        try {
            await sendFolderSelectionMessage(interaction.user, requestId, interaction);
        } catch (error) {
            console.error('❌ Error updating details:', error);
            await interaction.followUp({ content: '❌ Error updating details.', ephemeral: true });
        }
    }

    // ================================
    // APPROVAL WORKFLOW INTERACTIONS
    // ================================

    // Handle approval/denial buttons
    if (interaction.isButton() && (interaction.customId.startsWith('approve_') || interaction.customId.startsWith('deny_'))) {
        const [action, requestId] = interaction.customId.split('_');
        
        const embed = interaction.message.embeds[0];
        if (!embed) {
            await interaction.reply({ content: '❌ Could not find request information in message.', ephemeral: true });
            return;
        }

        // Check if already processed
        if (embed.title.includes('APPROVED') || embed.title.includes('DENIED')) {
            await interaction.reply({ content: '❌ This request has already been processed.', ephemeral: true });
            return;
        }

        // Extract request data from embed
        const userId = getFieldValue(embed, '👤 Requested by')?.match(/<@(\d+)>/)?.[1];
        const fileName = getFieldValue(embed, '📁 File Name');
        const uploadPath = getFieldValue(embed, '📂 Upload Path')?.replace('*(root folder)*', '');
        const description = getFieldValue(embed, '📋 Description')?.replace('*(no description)*', '');
        const attachmentUrl = getFieldValue(embed, '🔗 Original File');
        const fileSizeStr = getFieldValue(embed, '📊 File Size');
        
        const dmMessageId = requestId; // Request ID is the DM message ID
        const originalFileName = getFileNameFromUrl(attachmentUrl);
        const fileSize = parseFileSize(fileSizeStr);

        if (!userId || !fileName || !attachmentUrl) {
            await interaction.reply({ content: '❌ Missing required information in approval message.', ephemeral: true });
            return;
        }

        if (action === 'approve') {
            await interaction.deferReply({ ephemeral: true });
            
            try {
                // Download and upload file
                const downloadResult = await driveService.downloadFile(attachmentUrl);
                if (!downloadResult.success) {
                    throw new Error(downloadResult.error);
                }

                const folderId = driveService.getCachedFolderIdByPath(uploadPath);
                const uploadResult = await driveService.uploadFile(
                    downloadResult.buffer,
                    fileName,
                    downloadResult.mimeType,
                    folderId,
                    {
                        description: description,
                        uploader: userId,
                        approver: interaction.user.id
                    }
                );

                if (!uploadResult.success) {
                    throw new Error(uploadResult.error);
                }

                // Update approval message
                const updatedEmbed = EmbedBuilder.from(embed)
                    .setColor(0x27ae60)
                    .setTitle('✅ Upload Request APPROVED')
                    .addFields({ name: '👨‍💼 Approved by', value: `<@${interaction.user.id}>`, inline: true });

                await interaction.message.edit({ 
                    embeds: [updatedEmbed], 
                    components: []
                });

                // Clean up: delete original DM and send notification
                await deleteOriginalDM(userId, dmMessageId, dmMessageId);

                const requester = client.users.cache.get(userId);
                if (requester) {
                    const successEmbed = new EmbedBuilder()
                        .setTitle('✅ Upload Approved!')
                        .setDescription(`Your file **${fileName}** has been uploaded to Google Drive`)
                        .addFields(
                            { name: '📁 File Name', value: fileName, inline: true },
                            { name: '📂 Location', value: uploadPath || '*(root folder)*', inline: true },
                            { name: '👨‍💼 Approved by', value: interaction.user.displayName, inline: true },
                            { name: '🔗 View File', value: `[Open in Google Drive](${uploadResult.webViewLink})`, inline: false }
                        )
                        .setColor(0x27ae60)
                        .setTimestamp();

                    await safeDM(requester, { embeds: [successEmbed] });
                }

                await interaction.editReply('✅ Upload approved and completed successfully!');
                
            } catch (error) {
                console.error('❌ Error during upload approval:', error);
                
                const errorEmbed = EmbedBuilder.from(embed)
                    .setColor(0xe74c3c)
                    .setTitle('❌ Upload Request FAILED')
                    .addFields({ name: '❌ Error', value: error.message, inline: false });

                await interaction.message.edit({ 
                    embeds: [errorEmbed], 
                    components: []
                });

                await interaction.editReply(`❌ Error during upload: ${error.message}`);
            }

        } else if (action === 'deny') {
            await interaction.deferReply({ ephemeral: true });
            
            // Update approval message
            const updatedEmbed = EmbedBuilder.from(embed)
                .setColor(0xe74c3c)
                .setTitle('❌ Upload Request DENIED')
                .addFields({ name: '👨‍💼 Denied by', value: `<@${interaction.user.id}>`, inline: true });

            await interaction.message.edit({ 
                embeds: [updatedEmbed], 
                components: []
            });

            // Clean up: delete original DM and send notification
            await deleteOriginalDM(userId, dmMessageId, dmMessageId);

            const requester = client.users.cache.get(userId);
            if (requester) {
                const deniedEmbed = new EmbedBuilder()
                    .setTitle('❌ Upload Request Denied')
                    .setDescription(`Your upload request for **${fileName}** has been denied.`)
                    .addFields({ name: '👨‍💼 Denied by', value: interaction.user.displayName, inline: true })
                    .setColor(0xe74c3c)
                    .setTimestamp();

                await safeDM(requester, { embeds: [deniedEmbed] });
            }

            await interaction.editReply('❌ Upload request denied.');
        }
    }

    // Handle officer edit button (legacy - still uses Map storage)
    if (interaction.isButton() && interaction.customId.startsWith('officer_edit_')) {
        const requestId = interaction.customId.replace('officer_edit_', '');
        const request = uploadRequests.get(requestId);
        
        if (!request) {
            await interaction.reply({ content: '❌ Upload request expired or not found.', ephemeral: true });
            return;
        }

        const modal = new ModalBuilder()
            .setCustomId(`edit_modal_${requestId}`)
            .setTitle('✏️ Edit Upload Details');

        const fileNameInput = new TextInputBuilder()
            .setCustomId('filename')
            .setLabel('File Name')
            .setStyle(TextInputStyle.Short)
            .setValue(request.fileName)
            .setRequired(true)
            .setMaxLength(100);

        const pathInput = new TextInputBuilder()
            .setCustomId('path')
            .setLabel('Upload Path')
            .setStyle(TextInputStyle.Short)
            .setValue(request.uploadPath || '')
            .setRequired(false)
            .setMaxLength(200);

        const descriptionInput = new TextInputBuilder()
            .setCustomId('description')
            .setLabel('Description')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(request.description || '')
            .setRequired(false)
            .setMaxLength(500);

        modal.addComponents(
            new ActionRowBuilder().addComponents(fileNameInput),
            new ActionRowBuilder().addComponents(pathInput),
            new ActionRowBuilder().addComponents(descriptionInput)
        );

        await interaction.showModal(modal);
    }

    // Handle officer edit modal submission (legacy - still uses Map storage)
    if (interaction.isModalSubmit() && interaction.customId.startsWith('edit_modal_')) {
        const requestId = interaction.customId.replace('edit_modal_', '');
        const request = uploadRequests.get(requestId);
        
        if (!request) {
            await interaction.reply({ content: '❌ Upload request expired or not found.', ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const fileName = interaction.fields.getTextInputValue('filename').trim();
        const uploadPath = interaction.fields.getTextInputValue('path').trim();
        const description = interaction.fields.getTextInputValue('description').trim();

        request.fileName = fileName;
        request.uploadPath = uploadPath;
        request.description = description;
        uploadRequests.set(requestId, request);

        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
            .setFields(
                { name: '👤 Requested by', value: `<@${request.userId}>`, inline: true },
                { name: '📁 File Name', value: fileName, inline: true },
                { name: '📊 File Size', value: formatFileSize(request.fileSize), inline: true },
                { name: '📂 Upload Path', value: uploadPath || '*(root folder)*', inline: true },
                { name: '🔗 Original File', value: request.attachmentUrl, inline: true },
                { name: '📋 Description', value: description || '*(no description)*', inline: false },
                { name: '✏️ Last edited by', value: `<@${interaction.user.id}>`, inline: true }
            );

        await interaction.message.edit({ embeds: [updatedEmbed] });
        await interaction.editReply('✅ Upload details updated successfully!');
    }
});

// ================================
// ERROR HANDLING & STARTUP
// ================================

client.on(Events.Error, error => {
    console.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('❌ Unhandled promise rejection:', error);
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN); 
const { Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { safeDM, deleteOriginalDM, formatFileSize } = require('../utils/helpers');

// Constants
const COLORS = {
    SUCCESS: 0x27ae60,
    ERROR: 0xe74c3c,
    WARNING: 0xf39c12
};

const CUSTOM_IDS = {
    ATTACHMENT_SELECT: 'attachment_select_stateless',
    DM_FOLDER_SELECT: 'dm_folder_select_',
    DM_FOLDER_BACK: 'dm_folder_back_',
    DM_EDIT_DETAILS: 'dm_edit_details_',
    DM_CONFIRM_UPLOAD: 'dm_confirm_upload_',
    DM_DETAILS_MODAL: 'dm_details_modal_',
    DM_CANCEL: 'dm_cancel_',
    DM_CANCEL_ATTACHMENTS: 'dm_cancel_attachments',
    APPROVE: 'approve_',
    DENY: 'deny_',
    OFFICER_EDIT: 'officer_edit_',
    EDIT_MODAL: 'edit_modal_'
};

const ERROR_MESSAGES = {
    REQUEST_EXPIRED: '❌ Upload request expired or not found.',
    ALREADY_PROCESSED: '❌ This request has already been processed.',
    MISSING_INFO: '❌ Could not find request information in message.',
    MISSING_APPROVAL_INFO: '❌ Missing required approval information.',
    APPROVAL_CHANNEL_NOT_CONFIGURED: '❌ Approval channel not configured. Please contact an administrator.'
};

module.exports = (client, uploadRequests, driveService, handlers) => {
    const { 
        sendFolderSelectionMessage, 
        extractRequestFromDMEmbed, 
        createApprovalEmbed, 
        createApprovalButtons, 
        handleAttachmentSelection 
    } = handlers;

    // ================================
    // HELPER FUNCTIONS
    // ================================

    /**
     * Common request validation for DM workflow
     */
    const validateDMRequest = async (interaction, requestId) => {
        const request = extractRequestFromDMEmbed(interaction.message.embeds[0], interaction);
        if (!request) {
            await interaction.reply({ content: ERROR_MESSAGES.REQUEST_EXPIRED, flags: MessageFlags.Ephemeral });
            return null;
        }
        request.requestId = requestId;
        uploadRequests.set(requestId, request);
        return request;
    };

    /**
     * Extract field value from approval embed
     */
    const getFieldValue = (embed, fieldName) => {
        return embed.fields.find(f => f.name === fieldName)?.value;
    };

    /**
     * Check if approval request is already processed
     */
    const isAlreadyProcessed = (embed) => {
        return embed.title.includes('APPROVED') || embed.title.includes('DENIED') || embed.title.includes('FAILED');
    };

    /**
     * Common approval validation
     */
    const validateApprovalRequest = async (interaction) => {
        const embed = interaction.message.embeds[0];
        if (!embed) {
            await interaction.reply({ content: ERROR_MESSAGES.MISSING_INFO, flags: MessageFlags.Ephemeral });
            return null;
        }

        if (isAlreadyProcessed(embed)) {
            await interaction.reply({ content: ERROR_MESSAGES.ALREADY_PROCESSED, flags: MessageFlags.Ephemeral });
            return null;
        }

        return embed;
    };

    /**
     * Create common error handler for DM workflow
     */
    const createDMErrorHandler = (operation) => {
        return async (error, interaction) => {
            console.error(`❌ Error ${operation}:`, error);
            await interaction.followUp({ content: `❌ Error ${operation}.`, flags: MessageFlags.Ephemeral });
        };
    };

    // ================================
    // INTERACTION HANDLERS
    // ================================

    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isStringSelectMenu()) return;

        // ================================
        // DM WORKFLOW INTERACTIONS
        // ================================

        // Attachment Selection
        if (interaction.isStringSelectMenu() && interaction.customId === CUSTOM_IDS.ATTACHMENT_SELECT) {
            await handleAttachmentSelection(interaction, client, uploadRequests, sendFolderSelectionMessage);
            return;
        }

        // Folder Navigation
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith(CUSTOM_IDS.DM_FOLDER_SELECT)) {
            const requestId = interaction.customId.replace(CUSTOM_IDS.DM_FOLDER_SELECT, '');
            
            const request = await validateDMRequest(interaction, requestId);
            if (!request) return;

            request.currentPath = interaction.values[0];
            uploadRequests.set(requestId, request);

            await interaction.deferUpdate();
            try {
                await sendFolderSelectionMessage(interaction.user, requestId, interaction);
            } catch (error) {
                await createDMErrorHandler('updating folder navigation')(error, interaction);
            }
        }

        // Back Navigation
        if (interaction.isButton() && interaction.customId.startsWith(CUSTOM_IDS.DM_FOLDER_BACK)) {
            const requestId = interaction.customId.replace(CUSTOM_IDS.DM_FOLDER_BACK, '');
            
            const request = await validateDMRequest(interaction, requestId);
            if (!request) return;

            const pathParts = request.currentPath.split('/');
            pathParts.pop();
            request.currentPath = pathParts.join('/');
            uploadRequests.set(requestId, request);

            await interaction.deferUpdate();
            try {
                await sendFolderSelectionMessage(interaction.user, requestId, interaction);
            } catch (error) {
                await createDMErrorHandler('navigating back')(error, interaction);
            }
            return;
        }

        // Edit Details
        if (interaction.isButton() && interaction.customId.startsWith(CUSTOM_IDS.DM_EDIT_DETAILS)) {
            const requestId = interaction.customId.replace(CUSTOM_IDS.DM_EDIT_DETAILS, '');
            
            const request = await validateDMRequest(interaction, requestId);
            if (!request) return;

            const modal = new ModalBuilder()
                .setCustomId(`${CUSTOM_IDS.DM_DETAILS_MODAL}${requestId}`)
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
            return;
        }

        // Confirm Upload
        if (interaction.isButton() && interaction.customId.startsWith(CUSTOM_IDS.DM_CONFIRM_UPLOAD)) {
            const requestId = interaction.customId.replace(CUSTOM_IDS.DM_CONFIRM_UPLOAD, '');
            
            const request = await validateDMRequest(interaction, requestId);
            if (!request) return;

            try {
                // Send approval request to officer channel
                const config = require('../utils/config');
                const { getApprovalChannelFor } = config;
                const approvalId = getApprovalChannelFor(request.channelId || interaction.channelId);
                const approvalChannel = approvalId ? client.channels.cache.get(approvalId) : null;
                if (!approvalChannel) {
                    await interaction.reply({ content: ERROR_MESSAGES.APPROVAL_CHANNEL_NOT_CONFIGURED, flags: MessageFlags.Ephemeral });
                    return;
                }

                const approvalEmbed = createApprovalEmbed(interaction.user, request, interaction.message.id);
                const approvalButtons = createApprovalButtons(interaction.message.id);
                
                await approvalChannel.send({
                    embeds: [approvalEmbed],
                    components: [approvalButtons]
                });

                console.log(`📤 Upload request ${interaction.message.id} sent for approval`);

                // Update original DM to show submission status
                const submittedEmbed = new EmbedBuilder()
                    .setTitle('📤 Upload Request Submitted ✅')
                    .setDescription(`**File:** [${request.originalFileName}](${request.attachmentUrl}) (${formatFileSize(request.fileSize)})`)
                    .addFields(
                        { name: '📂 Upload Location', value: request.currentPath || '*(Root)*', inline: true },
                        { name: '📝 File Name', value: request.fileName, inline: true },
                        { name: '🆔 Request ID', value: interaction.message.id, inline: true },
                        { name: '📋 Description', value: request.description || '*(none)*', inline: false },
                        { name: '⏳ Status', value: 'Sent to officers for approval. You\'ll be notified when processed.', inline: false }
                    )
                    .setColor(COLORS.WARNING)
                    .setTimestamp();

                try {
                    // Ensure we have the DM channel context (fixes post-restart cache issues)
                    const dmChannel = await interaction.user.createDM();
                    const message = await dmChannel.messages.fetch(interaction.message.id);
                    await message.edit({ 
                        embeds: [submittedEmbed], 
                        components: [] // Remove buttons to prevent spam
                    });
                } catch (error) {
                    console.error('❌ Could not edit original DM:', error);
                }

                // Send a temporary success message that gets deleted
                const tempMessage = await interaction.reply({ 
                    content: '✅ Upload request submitted for approval! The message above has been updated.'
                });
                
                // Delete the temporary message after 2 seconds to reduce clutter
                setTimeout(async () => {
                    try {
                        await tempMessage.delete();
                    } catch (error) {
                        // Ignore errors if message is already deleted or can't be deleted
                    }
                }, 2000);
                
            } catch (error) {
                console.error('❌ Error submitting approval request:', error);
                await interaction.reply({ content: '❌ Error submitting request for approval. Contact an administrator.', flags: MessageFlags.Ephemeral });
            }
            return;
        }

        // Modal Submissions - Edit Details
        if (interaction.isModalSubmit() && interaction.customId.startsWith(CUSTOM_IDS.DM_DETAILS_MODAL)) {
            const requestId = interaction.customId.replace(CUSTOM_IDS.DM_DETAILS_MODAL, '');
            
            const request = uploadRequests.get(requestId);
            if (!request) {
                await interaction.reply({ content: ERROR_MESSAGES.REQUEST_EXPIRED, flags: MessageFlags.Ephemeral });
                return;
            }

            // Update request with new details
            request.fileName = interaction.fields.getTextInputValue('filename');
            request.description = interaction.fields.getTextInputValue('description');
            uploadRequests.set(requestId, request);

            await interaction.deferUpdate();
            try {
                await sendFolderSelectionMessage(interaction.user, requestId, interaction);
            } catch (error) {
                await createDMErrorHandler('updating details')(error, interaction);
            }
            return;
        }

        // ================================
        // APPROVAL WORKFLOW INTERACTIONS
        // ================================

        // Approval Actions
        if (interaction.isButton() && interaction.customId.startsWith(CUSTOM_IDS.APPROVE)) {
            const dmMessageId = interaction.customId.replace(CUSTOM_IDS.APPROVE, '');
            
            const embed = await validateApprovalRequest(interaction);
            if (!embed) return;

            const userId = getFieldValue(embed, '👤 Requested by')?.match(/<@(\d+)>/)?.[1];
            const fileName = getFieldValue(embed, '📁 File Name');
            const uploadPath = getFieldValue(embed, '📂 Upload Path')?.replace('*(root folder)*', '') || '';
            const attachmentUrl = getFieldValue(embed, '🔗 Original File');
            const description = getFieldValue(embed, '📋 Description')?.replace('*(no description)*', '') || '';

            if (!userId || !fileName || !attachmentUrl) {
                await interaction.reply({ content: ERROR_MESSAGES.MISSING_APPROVAL_INFO, flags: MessageFlags.Ephemeral });
                return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                // Download and upload file
                const result = await driveService.uploadFromUrl(attachmentUrl, fileName, uploadPath, description);
                
                // Update approval message
                const updatedEmbed = EmbedBuilder.from(embed)
                    .setColor(COLORS.SUCCESS)
                    .setTitle('✅ Upload Request APPROVED')
                    .addFields({ name: '👨‍💼 Approved by', value: `<@${interaction.user.id}>`, inline: true });

                await interaction.message.edit({ 
                    embeds: [updatedEmbed], 
                    components: []
                });

                // Notify user of success
                const requester = await client.users.fetch(userId);
                if (requester) {
                    const successEmbed = new EmbedBuilder()
                        .setTitle('✅ Upload Approved!')
                        .setDescription(`Your file **${fileName}** has been uploaded to Google Drive`)
                        .addFields(
                            { name: '📁 File Name', value: fileName, inline: true },
                            { name: '📂 Location', value: uploadPath || '*(root folder)*', inline: true },
                            { name: '👨‍💼 Approved by', value: interaction.user.displayName, inline: true },
                            { name: '🔗 View File', value: `[Open in Google Drive](${result.webViewLink})`, inline: false }
                        )
                        .setColor(COLORS.SUCCESS)
                        .setTimestamp();

                    await safeDM(requester, { embeds: [successEmbed] });
                }

                await interaction.editReply('✅ Upload approved and completed successfully!');

                // Clean up user's DM
                await deleteOriginalDM(client, userId, dmMessageId, 'approved');

                         } catch (error) {
                 console.error('❌ Error during upload approval:', error);
                 
                 const errorEmbed = EmbedBuilder.from(embed)
                     .setColor(COLORS.ERROR)
                     .setTitle('❌ Upload Request FAILED')
                     .addFields({ name: '❌ Error', value: error.message, inline: false });

                 await interaction.message.edit({ 
                     embeds: [errorEmbed], 
                     components: []
                 });

                 await interaction.editReply(`❌ Error during upload: ${error.message}`);
             }
             return;
        }

        // Denial Actions
        if (interaction.isButton() && interaction.customId.startsWith(CUSTOM_IDS.DENY)) {
            const dmMessageId = interaction.customId.replace(CUSTOM_IDS.DENY, '');
            
            // Get user ID from embed
            const embed = interaction.message.embeds[0];
            if (!embed) {
                await interaction.reply({ content: ERROR_MESSAGES.MISSING_INFO, flags: MessageFlags.Ephemeral });
                return;
            }

            // Check if already processed
            if (embed.title.includes('APPROVED') || embed.title.includes('DENIED') || embed.title.includes('FAILED')) {
                await interaction.reply({ content: '❌ This request has already been processed.', flags: MessageFlags.Ephemeral });
                return;
            }

            const getFieldValue = (fieldName) => embed.fields.find(f => f.name === fieldName)?.value;
            const userId = getFieldValue('👤 Requested by')?.match(/<@(\d+)>/)?.[1];
            const fileName = getFieldValue('📁 File Name');

            if (!userId || !fileName) {
                await interaction.reply({ content: '❌ Missing user information in approval request.', flags: MessageFlags.Ephemeral });
                return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                // Update approval message
                const updatedEmbed = EmbedBuilder.from(embed)
                    .setColor(COLORS.ERROR)
                    .setTitle('❌ Upload Request DENIED')
                    .addFields({ name: '👨‍💼 Denied by', value: `<@${interaction.user.id}>`, inline: true });

                await interaction.message.edit({ 
                    embeds: [updatedEmbed], 
                    components: []
                });

                // Notify user of denial
                const requester = await client.users.fetch(userId);
                if (requester) {
                    const deniedEmbed = new EmbedBuilder()
                        .setTitle('❌ Upload Request Denied')
                        .setDescription(`Your upload request for **${fileName}** has been denied.`)
                        .addFields({ name: '👨‍💼 Denied by', value: interaction.user.displayName, inline: true })
                        .setColor(COLORS.ERROR)
                        .setTimestamp();

                    await safeDM(requester, { embeds: [deniedEmbed] });
                }

                await interaction.editReply('❌ Upload request denied.');

                // Clean up user's DM
                await deleteOriginalDM(client, userId, dmMessageId, 'denied');

            } catch (error) {
                console.error('❌ Error processing denial:', error);
                await interaction.editReply(`❌ Error processing denial: ${error.message}`);
            }
            return;
        }

        // Officer Edit Actions
        if (interaction.isButton() && interaction.customId.startsWith(CUSTOM_IDS.OFFICER_EDIT)) {
            const requestId = interaction.customId.replace(CUSTOM_IDS.OFFICER_EDIT, '');
            
            // Extract current data from approval embed (stateless)
            const embed = interaction.message.embeds[0];
            if (!embed) {
                await interaction.reply({ content: ERROR_MESSAGES.MISSING_INFO, flags: MessageFlags.Ephemeral });
                return;
            }

            const getFieldValue = (fieldName) => embed.fields.find(f => f.name === fieldName)?.value;
            const fileName = getFieldValue('📁 File Name');
            const uploadPath = getFieldValue('📂 Upload Path')?.replace('*(root folder)*', '') || '';
            const description = getFieldValue('📋 Description')?.replace('*(no description)*', '') || '';

            if (!fileName) {
                await interaction.reply({ content: '❌ Missing file information in approval request.', flags: MessageFlags.Ephemeral });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`edit_modal_${requestId}`)
                .setTitle('✏️ Edit Upload Details');

            const fileNameInput = new TextInputBuilder()
                .setCustomId('filename')
                .setLabel('File Name')
                .setStyle(TextInputStyle.Short)
                .setValue(fileName)
                .setRequired(true)
                .setMaxLength(100);

            const pathInput = new TextInputBuilder()
                .setCustomId('path')
                .setLabel('Upload Path')
                .setStyle(TextInputStyle.Short)
                .setValue(uploadPath)
                .setRequired(false)
                .setMaxLength(200);

            const descriptionInput = new TextInputBuilder()
                .setCustomId('description')
                .setLabel('Description')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(description)
                .setRequired(false)
                .setMaxLength(500);

            modal.addComponents(
                new ActionRowBuilder().addComponents(fileNameInput),
                new ActionRowBuilder().addComponents(pathInput),
                new ActionRowBuilder().addComponents(descriptionInput)
            );

            await interaction.showModal(modal);
            return;
        }

        // Modal Submissions - Officer Edit
        if (interaction.isModalSubmit() && interaction.customId.startsWith(CUSTOM_IDS.EDIT_MODAL)) {
            
            // Extract original data from embed (stateless)
            const embed = interaction.message.embeds[0];
            if (!embed) {
                await interaction.reply({ content: ERROR_MESSAGES.MISSING_INFO, flags: MessageFlags.Ephemeral });
                return;
            }

            const userId = getFieldValue(embed, '👤 Requested by')?.match(/<@(\d+)>/)?.[1];
            const fileSizeStr = getFieldValue(embed, '📊 File Size');
            const attachmentUrl = getFieldValue(embed, '🔗 Original File');

            if (!userId || !attachmentUrl) {
                await interaction.reply({ content: ERROR_MESSAGES.MISSING_APPROVAL_INFO, flags: MessageFlags.Ephemeral });
                return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const fileName = interaction.fields.getTextInputValue('filename').trim();
            const uploadPath = interaction.fields.getTextInputValue('path').trim();
            const description = interaction.fields.getTextInputValue('description').trim();

            const updatedEmbed = EmbedBuilder.from(embed)
                .setFields(
                    { name: '👤 Requested by', value: `<@${userId}>`, inline: true },
                    { name: '📁 File Name', value: fileName, inline: true },
                    { name: '📊 File Size', value: fileSizeStr, inline: true },
                    { name: '📂 Upload Path', value: uploadPath || '*(root folder)*', inline: true },
                    { name: '🔗 Original File', value: attachmentUrl, inline: true },
                    { name: '📋 Description', value: description || '*(no description)*', inline: false },
                    { name: '✏️ Last edited by', value: `<@${interaction.user.id}>`, inline: true }
                );

            await interaction.message.edit({ embeds: [updatedEmbed] });
            await interaction.editReply('✅ Upload details updated successfully!');
            return;
        }

        // Cancel Actions - Individual Upload
        if (interaction.isButton() && interaction.customId.startsWith(CUSTOM_IDS.DM_CANCEL)) {
            const requestId = interaction.customId.replace(CUSTOM_IDS.DM_CANCEL, '');
            
            // Clean up the upload request from memory
            uploadRequests.delete(requestId);

            // Update message to show cancellation
            const cancelledEmbed = new EmbedBuilder()
                .setTitle('❌ Upload Cancelled')
                .setDescription('Upload request has been cancelled. You can start a new upload by reacting to an asset with ⬆️.')
                .setColor(COLORS.ERROR)
                .setTimestamp();

            await interaction.update({ embeds: [cancelledEmbed], components: [] });
            return;
        }

        // Cancel Actions - Attachment Selection
        if (interaction.isButton() && interaction.customId === CUSTOM_IDS.DM_CANCEL_ATTACHMENTS) {
            const cancelledEmbed = new EmbedBuilder()
                .setTitle('❌ Upload Cancelled')
                .setDescription('Attachment selection cancelled. You can start a new upload by reacting to an asset with ⬆️.')
                .setColor(COLORS.ERROR)
                .setTimestamp();

            await interaction.update({ embeds: [cancelledEmbed], components: [] });
        }
    });
}; 
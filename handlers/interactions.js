const { Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const { safeDM, deleteOriginalDM, formatFileSize } = require('../utils/helpers');

module.exports = (client, uploadRequests, driveService, handlers) => {
    const { 
        sendFolderSelectionMessage, 
        extractRequestFromDMEmbed, 
        createApprovalEmbed, 
        createApprovalButtons, 
        handleAttachmentSelection 
    } = handlers;

    // ================================
    // INTERACTION HANDLERS
    // ================================

    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isStringSelectMenu()) return;

        // ================================
        // DM WORKFLOW INTERACTIONS
        // ================================

        // Handle attachment selection for multiple attachments (stateless)
        if (interaction.isStringSelectMenu() && interaction.customId === 'attachment_select_stateless') {
            await handleAttachmentSelection(interaction, client, uploadRequests, sendFolderSelectionMessage);
            return;
        }

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
            return;
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
            return;
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

            try {
                // Send approval request to officer channel
                const approvalChannel = client.channels.cache.get(process.env.APPROVAL_CHANNEL_ID);
                if (!approvalChannel) {
                    await interaction.reply({ content: '❌ Approval channel not configured. Please contact an administrator.', ephemeral: true });
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
                    .setColor(0xf39c12)
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
                await interaction.reply({ content: '❌ Error submitting request for approval. Contact an administrator.', ephemeral: true });
            }
            return;
        }

        // Handle modal submissions for editing details
        if (interaction.isModalSubmit() && interaction.customId.startsWith('dm_details_modal_')) {
            const requestId = interaction.customId.replace('dm_details_modal_', '');
            
            const request = uploadRequests.get(requestId);
            if (!request) {
                await interaction.reply({ content: '❌ Upload request expired or not found.', ephemeral: true });
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
                console.error('❌ Error updating details:', error);
                await interaction.followUp({ content: '❌ Error updating details.', ephemeral: true });
            }
            return;
        }

        // ================================
        // APPROVAL WORKFLOW INTERACTIONS
        // ================================

        // Handle approval button
        if (interaction.isButton() && interaction.customId.startsWith('approve_')) {
            const dmMessageId = interaction.customId.replace('approve_', '');
            
            // Get approval info from embed
            const embed = interaction.message.embeds[0];
            if (!embed) {
                await interaction.reply({ content: '❌ Could not find request information in message.', ephemeral: true });
                return;
            }

            // Check if already processed
            if (embed.title.includes('APPROVED') || embed.title.includes('DENIED') || embed.title.includes('FAILED')) {
                await interaction.reply({ content: '❌ This request has already been processed.', ephemeral: true });
                return;
            }

            const getFieldValue = (fieldName) => embed.fields.find(f => f.name === fieldName)?.value;
            const userId = getFieldValue('👤 Requested by')?.match(/<@(\d+)>/)?.[1];
            const fileName = getFieldValue('📁 File Name');
            const uploadPath = getFieldValue('📂 Upload Path')?.replace('*(root folder)*', '') || '';
            const attachmentUrl = getFieldValue('🔗 Original File');
            const description = getFieldValue('📋 Description')?.replace('*(no description)*', '') || '';

            if (!userId || !fileName || !attachmentUrl) {
                await interaction.reply({ content: '❌ Missing required approval information.', ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                // Download and upload file
                const result = await driveService.uploadFromUrl(attachmentUrl, fileName, uploadPath, description);
                
                // Update approval message
                const updatedEmbed = EmbedBuilder.from(embed)
                    .setColor(0x27ae60)
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
                        .setColor(0x27ae60)
                        .setTimestamp();

                    await safeDM(requester, { embeds: [successEmbed] });
                }

                await interaction.editReply('✅ Upload approved and completed successfully!');

                // Clean up user's DM
                await deleteOriginalDM(client, userId, dmMessageId, 'approved');

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
             return;
        }

        // Handle denial button
        if (interaction.isButton() && interaction.customId.startsWith('deny_')) {
            const dmMessageId = interaction.customId.replace('deny_', '');
            
            // Get user ID from embed
            const embed = interaction.message.embeds[0];
            if (!embed) {
                await interaction.reply({ content: '❌ Could not find request information in message.', ephemeral: true });
                return;
            }

            // Check if already processed
            if (embed.title.includes('APPROVED') || embed.title.includes('DENIED') || embed.title.includes('FAILED')) {
                await interaction.reply({ content: '❌ This request has already been processed.', ephemeral: true });
                return;
            }

            const getFieldValue = (fieldName) => embed.fields.find(f => f.name === fieldName)?.value;
            const userId = getFieldValue('👤 Requested by')?.match(/<@(\d+)>/)?.[1];
            const fileName = getFieldValue('📁 File Name');

            if (!userId || !fileName) {
                await interaction.reply({ content: '❌ Missing user information in approval request.', ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                // Update approval message
                const updatedEmbed = EmbedBuilder.from(embed)
                    .setColor(0xe74c3c)
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
                        .setColor(0xe74c3c)
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

        // Handle officer edit button
        if (interaction.isButton() && interaction.customId.startsWith('officer_edit_')) {
            const requestId = interaction.customId.replace('officer_edit_', '');
            
            // Extract current data from approval embed (stateless)
            const embed = interaction.message.embeds[0];
            if (!embed) {
                await interaction.reply({ content: '❌ Could not find request information in message.', ephemeral: true });
                return;
            }

            const getFieldValue = (fieldName) => embed.fields.find(f => f.name === fieldName)?.value;
            const fileName = getFieldValue('📁 File Name');
            const uploadPath = getFieldValue('📂 Upload Path')?.replace('*(root folder)*', '') || '';
            const description = getFieldValue('📋 Description')?.replace('*(no description)*', '') || '';

            if (!fileName) {
                await interaction.reply({ content: '❌ Missing file information in approval request.', ephemeral: true });
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

        // Handle officer edit modal submission
        if (interaction.isModalSubmit() && interaction.customId.startsWith('edit_modal_')) {
            const requestId = interaction.customId.replace('edit_modal_', '');
            
            // Extract original data from embed (stateless)
            const embed = interaction.message.embeds[0];
            if (!embed) {
                await interaction.reply({ content: '❌ Could not find request information in message.', ephemeral: true });
                return;
            }

            const getFieldValue = (fieldName) => embed.fields.find(f => f.name === fieldName)?.value;
            const userId = getFieldValue('👤 Requested by')?.match(/<@(\d+)>/)?.[1];
            const fileSizeStr = getFieldValue('📊 File Size');
            const attachmentUrl = getFieldValue('🔗 Original File');

            if (!userId || !attachmentUrl) {
                await interaction.reply({ content: '❌ Missing required information in approval request.', ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

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

        // Handle cancel button for individual upload workflow
        if (interaction.isButton() && interaction.customId.startsWith('dm_cancel_')) {
            const requestId = interaction.customId.replace('dm_cancel_', '');
            
            // Clean up the upload request from memory
            uploadRequests.delete(requestId);

            // Update message to show cancellation
            const cancelledEmbed = new EmbedBuilder()
                .setTitle('❌ Upload Cancelled')
                .setDescription('Upload request has been cancelled. You can start a new upload by reacting to an image with ⬆️.')
                .setColor(0xe74c3c)
                .setTimestamp();

            await interaction.update({ embeds: [cancelledEmbed], components: [] });
            return;
        }

        // Handle cancel button for attachment selection
        if (interaction.isButton() && interaction.customId === 'dm_cancel_attachments') {
            const cancelledEmbed = new EmbedBuilder()
                .setTitle('❌ Upload Cancelled')
                .setDescription('Attachment selection cancelled. You can start a new upload by reacting to an image with ⬆️.')
                .setColor(0xe74c3c)
                .setTimestamp();

            await interaction.update({ embeds: [cancelledEmbed], components: [] });
            return;
        }
    });
}; 
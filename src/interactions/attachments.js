const { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { formatFileSize, getFileNameFromUrl } = require('../utils/helpers');

/**
 * Send attachment selection message for multiple attachments
 */
async function sendAttachmentSelectionMessage(user, message, attachments) {
    const embed = new EmbedBuilder()
        .setTitle('🖼️ Multiple Attachments Found')
        .setDescription(`This message contains **${attachments.length}** files. Select which ones you'd like to upload to Google Drive.\n\n*You can select multiple attachments and each will go through the upload process individually.*${attachments.length > 25 ? '\n\n⚠️ **Note:** Only the first 25 attachments are shown due to Discord limits.' : ''}`)
        .setColor(0x3498db)
        .setTimestamp()
        .setFooter({ 
            text: `${message.id}|${message.channel.id}` 
        });

    // Create options for select menu (max 25 options due to Discord limits)
    const options = attachments.slice(0, 25).map((attachment, index) => {
        const fileName = getFileNameFromUrl(attachment.url);
        const fileSize = formatFileSize(attachment.size);
        
        return {
            label: fileName.length > 100 ? fileName.substring(0, 97) + '...' : fileName,
            description: `${fileSize} • Click to select for upload`,
            value: `attachment_${index}`,
            emoji: '🖼️'
        };
    });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`attachment_select_stateless`)
        .setPlaceholder('📂 Choose attachments to upload...')
        .setMinValues(1)
        .setMaxValues(Math.min(attachments.length, 25))
        .addOptions(options);

    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    // Cancel button
    const cancelButton = new ButtonBuilder()
        .setCustomId('dm_cancel_attachments')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌');

    const buttonRow = new ActionRowBuilder().addComponents(cancelButton);

    try {
        await user.send({ embeds: [embed], components: [selectRow, buttonRow] });
    } catch (error) {
        console.error('❌ Error sending attachment selection message:', error);
        throw error;
    }
}

/**
 * Handle attachment selection interaction
 */
async function handleAttachmentSelection(interaction, client, uploadRequests, sendFolderSelectionMessage) {
    await interaction.deferReply();

    try {
        const embed = interaction.message.embeds[0];
        if (!embed || !embed.footer) {
            await interaction.editReply('❌ Attachment selection message malformed.');
            return;
        }

        // Extract source message info from footer
        const footerText = embed.footer.text;
        const [originalMessageId, originalChannelId] = footerText.split('|');

        if (!originalMessageId || !originalChannelId) {
            await interaction.editReply('❌ Source message information not found.');
            return;
        }

        // Fetch the original message to get current attachments
        let originalMessage = null;
        try {
            const channel = await client.channels.fetch(originalChannelId);
            if (channel) {
                originalMessage = await channel.messages.fetch(originalMessageId);
            }
        } catch (error) {
            console.log('❌ Could not fetch original message:', error.message);
        }

        if (!originalMessage) {
            await interaction.editReply('❌ Original message not found or was deleted. Attachment data is no longer available.');
            return;
        }

        // Get current attachments
        const currentAttachments = Array.from(originalMessage.attachments.values());

        if (currentAttachments.length === 0) {
            await interaction.editReply('❌ No file attachments found in the original message.');
            return;
        }

        // Map attachments to expected format
        const attachments = currentAttachments.slice(0, 25).map((attachment, index) => ({
            index,
            fileName: getFileNameFromUrl(attachment.url),
            url: attachment.url,
            size: attachment.size,
            contentType: attachment.contentType
        }));

        // Process selected attachments
        const selectedIndices = interaction.values.map(value => parseInt(value.replace('attachment_', '')));
        const selectedAttachments = selectedIndices.map(index => attachments[index]).filter(Boolean);

        if (selectedAttachments.length === 0) {
            await interaction.editReply('❌ No valid attachments selected.');
            return;
        }

        await interaction.editReply(`✅ Processing ${selectedAttachments.length} attachment(s). You'll receive a separate message for each upload.`);

        // Disable the original selection message to prevent duplicate requests
        try {
            const processedEmbed = new EmbedBuilder()
                .setTitle('✅ Attachments Processed')
                .setDescription(`Successfully processed **${selectedAttachments.length}** attachment(s). Each will go through the individual upload workflow.`)
                .setColor(0x2ecc71)
                .setTimestamp();

            // Ensure we have the DM channel context (fixes post-restart cache issues)
            const dmChannel = await interaction.user.createDM();
            const message = await dmChannel.messages.fetch(interaction.message.id);
            await message.edit({ embeds: [processedEmbed], components: [] });
        } catch (error) {
            console.log('❌ Could not update original selection message:', error.message);
            // Not critical - user still gets confirmation via the reply
        }

        // Create upload request for each selected attachment
        for (let i = 0; i < selectedAttachments.length; i++) {
            const attachment = selectedAttachments[i];
            
            const request = {
                userId: interaction.user.id,
                messageId: originalMessage.id,
                channelId: originalMessage.channel.id,
                attachmentUrl: attachment.url,
                originalFileName: attachment.fileName,
                fileSize: attachment.size,
                contentType: attachment.contentType,
                timestamp: Date.now(),
                currentPath: '',
                fileName: attachment.fileName,
                description: ''
            };

            // Small delay between messages to avoid rate limits
            if (i > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            const requestId = (Date.now() + i).toString() + '_' + interaction.user.id;
            request.requestId = requestId;
            uploadRequests.set(requestId, request);
            
            await sendFolderSelectionMessage(interaction.user, requestId);
        }

    } catch (error) {
        console.error('❌ Error processing attachment selection:', error);
        await interaction.editReply('❌ Error processing attachment selection.');
    }
}

module.exports = {
    sendAttachmentSelectionMessage,
    handleAttachmentSelection
}; 
require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder } = require('discord.js');
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
    ]
});

// Initialize Google Drive service
const driveService = new GoogleDriveService();

// Configuration
const UPLOAD_CHANNELS = process.env.UPLOAD_CHANNELS?.split(',') || [];
const APPROVAL_CHANNEL_ID = process.env.APPROVAL_CHANNEL_ID;
const UPLOAD_EMOJI = process.env.UPLOAD_EMOJI || '📤';

// In-memory storage for upload requests
const uploadRequests = new Map();

// Helper function to format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper function to generate unique request ID
function generateRequestId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Helper function to extract filename from URL
function getFileNameFromUrl(url) {
    try {
        const urlParts = url.split('/');
        const fileName = urlParts[urlParts.length - 1].split('?')[0];
        return fileName || 'attachment';
    } catch {
        return 'attachment';
    }
}

client.once(Events.ClientReady, (readyClient) => {
    console.log(`🤖 Discord Art Upload Bot is ready!`);
    console.log(`👤 Logged in as ${readyClient.user.tag}`);
    console.log(`📋 Upload channels: ${UPLOAD_CHANNELS.length}`);
    console.log(`📝 Approval channel: ${APPROVAL_CHANNEL_ID || 'Not configured'}`);
    console.log(`📤 Upload emoji: ${UPLOAD_EMOJI}`);
});

// Handle message reactions (upload requests)
client.on(Events.MessageReactionAdd, async (reaction, user) => {
    // DEBUG: Log all reactions
    console.log(`🔍 DEBUG: Reaction detected!`);
    console.log(`   👤 User: ${user.tag} (${user.id})`);
    console.log(`   📝 Channel: ${reaction.message.channel.id}`);
    console.log(`   📱 Emoji: ${reaction.emoji.name} (ID: ${reaction.emoji.id || 'N/A'})`);
    console.log(`   🤖 Is Bot: ${user.bot}`);
    
    // Ignore bot reactions
    if (user.bot) {
        console.log(`   ⏭️ Skipping: Bot reaction`);
        return;
    }

    // Partial reaction handling
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('❌ Error fetching reaction:', error);
            return;
        }
    }

    // Check if it's the upload emoji
    console.log(`   🎯 Checking emoji: "${reaction.emoji.name}" vs "${UPLOAD_EMOJI}"`);
    if (reaction.emoji.name !== UPLOAD_EMOJI && reaction.emoji.id !== UPLOAD_EMOJI) {
        console.log(`   ❌ Emoji mismatch: Not the upload emoji`);
        return;
    }
    console.log(`   ✅ Emoji match: This is the upload emoji!`);

    // Check if it's in an allowed upload channel
    console.log(`   📋 Checking channel: "${reaction.message.channel.id}" in [${UPLOAD_CHANNELS.join(', ')}]`);
    if (!UPLOAD_CHANNELS.includes(reaction.message.channel.id)) {
        console.log(`   ❌ Channel not allowed for uploads`);
        try {
            await user.send('❌ Upload requests are only allowed in designated art channels.');
        } catch (error) {
            console.log(`Could not DM user ${user.tag}`);
        }
        return;
    }
    console.log(`   ✅ Channel allowed for uploads!`);

    // Check if message has attachments
    if (reaction.message.attachments.size === 0) {
        try {
            await user.send('❌ You can only upload messages that contain image attachments.');
        } catch (error) {
            console.log(`Could not DM user ${user.tag}`);
        }
        return;
    }

    // Get the first image attachment
    const attachment = reaction.message.attachments.find(att => 
        att.contentType && att.contentType.startsWith('image/')
    );

    if (!attachment) {
        try {
            await user.send('❌ No image attachments found in that message.');
        } catch (error) {
            console.log(`Could not DM user ${user.tag}`);
        }
        return;
    }

    // Generate request ID and store basic info
    const requestId = generateRequestId();
    const originalFileName = getFileNameFromUrl(attachment.url);
    
    uploadRequests.set(requestId, {
        userId: user.id,
        messageId: reaction.message.id,
        channelId: reaction.message.channel.id,
        attachmentUrl: attachment.url,
        originalFileName: originalFileName,
        fileSize: attachment.size,
        contentType: attachment.contentType,
        timestamp: Date.now()
    });

    // Create and send modal for upload details
    const modal = new ModalBuilder()
        .setCustomId(`upload_modal_${requestId}`)
        .setTitle('📤 Upload to Google Drive');

    const fileNameInput = new TextInputBuilder()
        .setCustomId('filename')
        .setLabel('File Name')
        .setStyle(TextInputStyle.Short)
        .setValue(originalFileName)
        .setRequired(true)
        .setMaxLength(100);

    const pathInput = new TextInputBuilder()
        .setCustomId('path')
        .setLabel('Upload Path')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., projects/game-art/characters')
        .setRequired(false)
        .setMaxLength(200);

    const descriptionInput = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Description (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Brief description of the artwork...')
        .setRequired(false)
        .setMaxLength(500);

    modal.addComponents(
        new ActionRowBuilder().addComponents(fileNameInput),
        new ActionRowBuilder().addComponents(pathInput),
        new ActionRowBuilder().addComponents(descriptionInput)
    );

    // Send modal to user
    try {
        // We need to create an interaction-like object to show the modal
        // Since this is from a reaction, we'll send a message with buttons instead
        const embed = new EmbedBuilder()
            .setTitle('📤 Upload Request Started')
            .setDescription(`You've requested to upload **${originalFileName}** (${formatFileSize(attachment.size)})`)
            .addFields(
                { name: '📁 Original File', value: originalFileName, inline: true },
                { name: '📊 File Size', value: formatFileSize(attachment.size), inline: true },
                { name: '🔗 Action Required', value: 'Click the button below to set upload details', inline: false }
            )
            .setColor(0x3498db)
            .setTimestamp();

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`upload_details_${requestId}`)
                    .setLabel('Set Upload Details')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('⚙️')
            );

        await user.send({ embeds: [embed], components: [row] });
        
    } catch (error) {
        console.error('❌ Error sending upload request to user:', error);
        uploadRequests.delete(requestId);
    }
});

// Handle button interactions (for upload details)
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;

    // Handle upload details button
    if (interaction.isButton() && interaction.customId.startsWith('upload_details_')) {
        const requestId = interaction.customId.replace('upload_details_', '');
        const request = uploadRequests.get(requestId);
        
        if (!request) {
            await interaction.reply({ content: '❌ Upload request expired or not found.', ephemeral: true });
            return;
        }

        const modal = new ModalBuilder()
            .setCustomId(`upload_modal_${requestId}`)
            .setTitle('📤 Upload to Google Drive');

        const fileNameInput = new TextInputBuilder()
            .setCustomId('filename')
            .setLabel('File Name')
            .setStyle(TextInputStyle.Short)
            .setValue(request.originalFileName)
            .setRequired(true)
            .setMaxLength(100);

        const pathInput = new TextInputBuilder()
            .setCustomId('path')
            .setLabel('Upload Path')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., projects/game-art/characters')
            .setRequired(false)
            .setMaxLength(200);

        const descriptionInput = new TextInputBuilder()
            .setCustomId('description')
            .setLabel('Description (optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Brief description of the artwork...')
            .setRequired(false)
            .setMaxLength(500);

        modal.addComponents(
            new ActionRowBuilder().addComponents(fileNameInput),
            new ActionRowBuilder().addComponents(pathInput),
            new ActionRowBuilder().addComponents(descriptionInput)
        );

        await interaction.showModal(modal);
    }

    // Handle modal submission
    if (interaction.isModalSubmit() && interaction.customId.startsWith('upload_modal_')) {
        const requestId = interaction.customId.replace('upload_modal_', '');
        const request = uploadRequests.get(requestId);
        
        if (!request) {
            await interaction.reply({ content: '❌ Upload request expired or not found.', ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const fileName = interaction.fields.getTextInputValue('filename').trim();
        const uploadPath = interaction.fields.getTextInputValue('path').trim();
        const description = interaction.fields.getTextInputValue('description').trim();

        // Update request with form data
        request.fileName = fileName;
        request.uploadPath = uploadPath;
        request.description = description;
        uploadRequests.set(requestId, request);

        // Send approval request to approval channel
        if (!APPROVAL_CHANNEL_ID) {
            await interaction.editReply('❌ Approval channel not configured. Contact an administrator.');
            return;
        }

        const approvalChannel = client.channels.cache.get(APPROVAL_CHANNEL_ID);
        if (!approvalChannel) {
            await interaction.editReply('❌ Could not find approval channel. Contact an administrator.');
            return;
        }

        const approvalEmbed = new EmbedBuilder()
            .setTitle('📤 Upload Request for Approval')
            .setDescription(`**${interaction.user.displayName}** wants to upload a file to Google Drive`)
            .addFields(
                { name: '👤 Requested by', value: `<@${interaction.user.id}>`, inline: true },
                { name: '📁 File Name', value: fileName, inline: true },
                { name: '📊 File Size', value: formatFileSize(request.fileSize), inline: true },
                { name: '📂 Upload Path', value: uploadPath || '*(root folder)*', inline: true },
                { name: '🔗 Original File', value: request.originalFileName, inline: true },
                { name: '📋 Description', value: description || '*(no description)*', inline: false }
            )
            .setColor(0xf39c12)
            .setTimestamp()
            .setFooter({ text: `Request ID: ${requestId}` });

        const approvalRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`approve_${requestId}`)
                    .setLabel('Approve')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✅'),
                new ButtonBuilder()
                    .setCustomId(`deny_${requestId}`)
                    .setLabel('Deny')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('❌'),
                new ButtonBuilder()
                    .setCustomId(`edit_${requestId}`)
                    .setLabel('Edit Details')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        try {
            const approvalMessage = await approvalChannel.send({ 
                embeds: [approvalEmbed], 
                components: [approvalRow] 
            });
            
            request.approvalMessageId = approvalMessage.id;
            uploadRequests.set(requestId, request);

            await interaction.editReply('✅ Upload request submitted for approval! You\'ll be notified when it\'s processed.');
        } catch (error) {
            console.error('❌ Error sending approval request:', error);
            await interaction.editReply('❌ Error submitting request for approval. Contact an administrator.');
        }
    }

    // Handle approval/denial buttons
    if (interaction.isButton() && (interaction.customId.startsWith('approve_') || interaction.customId.startsWith('deny_') || interaction.customId.startsWith('edit_'))) {
        const [action, requestId] = interaction.customId.split('_');
        const request = uploadRequests.get(requestId);
        
        if (!request) {
            await interaction.reply({ content: '❌ Upload request expired or not found.', ephemeral: true });
            return;
        }

        if (action === 'approve') {
            await interaction.deferReply({ ephemeral: true });
            
            try {
                // Download file from Discord
                const downloadResult = await driveService.downloadFile(request.attachmentUrl);
                if (!downloadResult.success) {
                    throw new Error(downloadResult.error);
                }

                // Get folder ID for upload path
                const folderId = await driveService.getFolderIdByPath(request.uploadPath);

                // Upload to Google Drive
                const uploadResult = await driveService.uploadFile(
                    downloadResult.buffer,
                    request.fileName,
                    downloadResult.mimeType,
                    folderId,
                    {
                        description: request.description,
                        uploader: request.userId,
                        approver: interaction.user.id
                    }
                );

                if (!uploadResult.success) {
                    throw new Error(uploadResult.error);
                }

                // Update approval message
                const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                    .setColor(0x27ae60)
                    .setTitle('✅ Upload Request APPROVED')
                    .addFields({ name: '👨‍💼 Approved by', value: `<@${interaction.user.id}>`, inline: true });

                await interaction.message.edit({ 
                    embeds: [updatedEmbed], 
                    components: [] 
                });

                // Notify requester
                const requester = client.users.cache.get(request.userId);
                if (requester) {
                    const successEmbed = new EmbedBuilder()
                        .setTitle('✅ Upload Approved!')
                        .setDescription(`Your file **${request.fileName}** has been uploaded to Google Drive`)
                        .addFields(
                            { name: '📁 File Name', value: request.fileName, inline: true },
                            { name: '📂 Location', value: request.uploadPath || '*(root folder)*', inline: true },
                            { name: '👨‍💼 Approved by', value: interaction.user.displayName, inline: true },
                            { name: '🔗 View File', value: `[Open in Google Drive](${uploadResult.webViewLink})`, inline: false }
                        )
                        .setColor(0x27ae60)
                        .setTimestamp();

                    await requester.send({ embeds: [successEmbed] });
                }

                await interaction.editReply('✅ Upload approved and completed successfully!');
                
            } catch (error) {
                console.error('❌ Error during upload approval:', error);
                
                const errorEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                    .setColor(0xe74c3c)
                    .setTitle('❌ Upload Request FAILED')
                    .addFields({ name: '❌ Error', value: error.message, inline: false });

                await interaction.message.edit({ 
                    embeds: [errorEmbed], 
                    components: [] 
                });

                await interaction.editReply(`❌ Error during upload: ${error.message}`);
            } finally {
                uploadRequests.delete(requestId);
            }

        } else if (action === 'deny') {
            await interaction.deferReply({ ephemeral: true });
            
            // Update approval message
            const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                .setColor(0xe74c3c)
                .setTitle('❌ Upload Request DENIED')
                .addFields({ name: '👨‍💼 Denied by', value: `<@${interaction.user.id}>`, inline: true });

            await interaction.message.edit({ 
                embeds: [updatedEmbed], 
                components: [] 
            });

            // Notify requester
            const requester = client.users.cache.get(request.userId);
            if (requester) {
                const deniedEmbed = new EmbedBuilder()
                    .setTitle('❌ Upload Request Denied')
                    .setDescription(`Your upload request for **${request.fileName}** has been denied.`)
                    .addFields({ name: '👨‍💼 Denied by', value: interaction.user.displayName, inline: true })
                    .setColor(0xe74c3c)
                    .setTimestamp();

                await requester.send({ embeds: [deniedEmbed] });
            }

            await interaction.editReply('❌ Upload request denied.');
            uploadRequests.delete(requestId);

        } else if (action === 'edit') {
            // Show modal for editing upload details
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
    }

    // Handle edit modal submission
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

        // Update request
        request.fileName = fileName;
        request.uploadPath = uploadPath;
        request.description = description;
        uploadRequests.set(requestId, request);

        // Update approval message
        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
            .setFields(
                { name: '👤 Requested by', value: `<@${request.userId}>`, inline: true },
                { name: '📁 File Name', value: fileName, inline: true },
                { name: '📊 File Size', value: formatFileSize(request.fileSize), inline: true },
                { name: '📂 Upload Path', value: uploadPath || '*(root folder)*', inline: true },
                { name: '🔗 Original File', value: request.originalFileName, inline: true },
                { name: '📋 Description', value: description || '*(no description)*', inline: false },
                { name: '✏️ Last edited by', value: `<@${interaction.user.id}>`, inline: true }
            );

        await interaction.message.edit({ embeds: [updatedEmbed] });
        await interaction.editReply('✅ Upload details updated successfully!');
    }
});

// Error handling
client.on(Events.Error, error => {
    console.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('❌ Unhandled promise rejection:', error);
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN); 
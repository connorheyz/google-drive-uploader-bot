const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const { formatFileSize } = require('../utils/helpers');

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

module.exports = {
    createApprovalEmbed,
    createApprovalButtons
}; 
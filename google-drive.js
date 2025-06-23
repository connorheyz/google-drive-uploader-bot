const { google } = require('googleapis');
const axios = require('axios');

class GoogleDriveService {
    constructor() {
        // Debug logging for credentials
        console.log('🔧 Initializing Google Drive Service...');
        console.log(`   Client ID: ${process.env.GOOGLE_CLIENT_ID?.substring(0, 20)}...`);
        console.log(`   Client Secret: ${process.env.GOOGLE_CLIENT_SECRET?.substring(0, 10)}...`);
        console.log(`   Refresh Token: ${process.env.GOOGLE_REFRESH_TOKEN?.substring(0, 20)}...`);
        
        this.oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );

        this.oauth2Client.setCredentials({
            refresh_token: process.env.GOOGLE_REFRESH_TOKEN
        });

        this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
    }

    /**
     * Upload a file to Google Drive
     * @param {Buffer} fileBuffer - File content as buffer
     * @param {string} fileName - Name for the file
     * @param {string} mimeType - MIME type of the file
     * @param {string} folderId - Google Drive folder ID (optional)
     * @param {Object} metadata - Additional metadata for the file
     * @returns {Promise<Object>} - Upload result with file details
     */
    async uploadFile(fileBuffer, fileName, mimeType, folderId = null, metadata = {}) {
        try {
            const fileMetadata = {
                name: fileName,
                parents: folderId ? [folderId] : undefined,
                description: metadata.description || 'Uploaded via Discord Art Bot'
            };

            const media = {
                mimeType: mimeType,
                body: require('stream').Readable.from(fileBuffer)
            };

            console.log(`📤 Uploading ${fileName} to Google Drive...`);
            
            const response = await this.drive.files.create({
                resource: fileMetadata,
                media: media,
                fields: 'id, name, webViewLink, size'
            });

            // Add custom properties for tracking
            if (metadata.uploader || metadata.approver) {
                await this.drive.files.update({
                    fileId: response.data.id,
                    resource: {
                        properties: {
                            uploader: metadata.uploader || 'Unknown',
                            approver: metadata.approver || 'Unknown',
                            uploadDate: new Date().toISOString(),
                            uploadedVia: 'Discord Art Bot'
                        }
                    }
                });
            }

            console.log(`✅ Successfully uploaded ${fileName} (ID: ${response.data.id})`);
            return {
                success: true,
                fileId: response.data.id,
                fileName: response.data.name,
                webViewLink: response.data.webViewLink,
                size: response.data.size
            };
        } catch (error) {
            console.error('❌ Google Drive upload error:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Download file from URL (Discord attachment)
     * @param {string} url - Discord attachment URL
     * @returns {Promise<Object>} - File buffer and metadata
     */
    async downloadFile(url) {
        try {
            console.log('📥 Downloading file from Discord...');
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': 'Discord Art Bot/1.0'
                }
            });

            const buffer = Buffer.from(response.data);
            const contentType = response.headers['content-type'] || 'application/octet-stream';
            
            console.log(`✅ Downloaded file (${buffer.length} bytes, ${contentType})`);
            
            return {
                success: true,
                buffer: buffer,
                mimeType: contentType,
                size: buffer.length
            };
        } catch (error) {
            console.error('❌ File download error:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get folder ID by path (creates folders if they don't exist)
     * @param {string} folderPath - Path like "projects/game-art/characters"
     * @param {string} parentId - Parent folder ID (optional)
     * @returns {Promise<string>} - Folder ID
     */
    async getFolderIdByPath(folderPath, parentId = null) {
        if (!folderPath || folderPath === '/') {
            return parentId || process.env.DEFAULT_DRIVE_FOLDER_ID || 'root';
        }

        const pathParts = folderPath.split('/').filter(part => part.length > 0);
        let currentParentId = parentId || process.env.DEFAULT_DRIVE_FOLDER_ID || 'root';

        for (const folderName of pathParts) {
            try {
                // Search for existing folder
                const searchResponse = await this.drive.files.list({
                    q: `name='${folderName}' and '${currentParentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                    fields: 'files(id, name)'
                });

                if (searchResponse.data.files.length > 0) {
                    currentParentId = searchResponse.data.files[0].id;
                } else {
                    // Create folder if it doesn't exist
                    const createResponse = await this.drive.files.create({
                        resource: {
                            name: folderName,
                            mimeType: 'application/vnd.google-apps.folder',
                            parents: [currentParentId]
                        },
                        fields: 'id'
                    });
                    currentParentId = createResponse.data.id;
                    console.log(`📁 Created folder: ${folderName} (ID: ${currentParentId})`);
                }
            } catch (error) {
                console.error(`❌ Error processing folder ${folderName}:`, error.message);
                throw error;
            }
        }

        return currentParentId;
    }
}

module.exports = GoogleDriveService; 
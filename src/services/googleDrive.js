const { google } = require('googleapis');
const axios = require('axios');
const config = require('../utils/config');
const credentials = require('../utils/credentials');

class GoogleDriveService {
    constructor() {
        // Debug logging for credentials
        console.log('🔧 Initializing Google Drive Service...');
        console.log(`   Client ID: ${process.env.GOOGLE_CLIENT_ID?.substring(0, 20)}...`);
        console.log(`   Client Secret: ${process.env.GOOGLE_CLIENT_SECRET?.substring(0, 10)}...`);
        
        // Always load refresh token from credentials file (env var is ignored)
        const savedToken = credentials.getRefreshTokenSync();
        if (savedToken) {
            console.log('🔑 Loaded refresh token from credentials file');
        } else {
            console.log('⚠️ No refresh token found in credentials file. Google Drive features will be disabled until admin completes /google-auth-start & /google-auth-finish');
        }

        this.oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );

        // Apply credentials (may be undefined)
        this.oauth2Client.setCredentials({ refresh_token: savedToken });

        this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
        
        // Folder cache for navigation
        this.folderCache = {
            tree: {},
            flat: new Map(), // id -> {name, path, parentId}
            lastUpdated: null,
            refreshInterval: 60 * 60 * 1000 // 1 hour
        };
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
     * Upload file from URL to Google Drive (combines download and upload)
     * @param {string} url - URL to download file from (Discord attachment)
     * @param {string} fileName - Name for the file in Google Drive
     * @param {string} folderPath - Path where to upload (e.g., "projects/game-art")
     * @param {string} description - File description
     * @param {Object} metadata - Additional metadata
     * @returns {Promise<Object>} - Upload result
     */
    async uploadFromUrl(url, fileName, folderPath = '', description = '', metadata = {}) {
        try {
            // Download file from URL
            const downloadResult = await this.downloadFile(url);
            if (!downloadResult.success) {
                throw new Error(`Failed to download file: ${downloadResult.error}`);
            }

            // Get folder ID for the specified path
            const folderId = await this.getFolderIdByPath(folderPath);

            // Prepare metadata
            const fileMetadata = {
                description: description,
                ...metadata
            };

            // Upload to Google Drive
            const uploadResult = await this.uploadFile(
                downloadResult.buffer,
                fileName,
                downloadResult.mimeType,
                folderId,
                fileMetadata
            );

            if (!uploadResult.success) {
                throw new Error(`Failed to upload file: ${uploadResult.error}`);
            }

            console.log(`✅ Successfully uploaded ${fileName} from URL to folder: ${folderPath || '(root)'}`);
            return uploadResult;

        } catch (error) {
            console.error('❌ uploadFromUrl error:', error.message);
            throw error;
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

    /**
     * Build folder cache from Google Drive
     * @param {string} rootFolderId - Root folder to start from (optional)
     * @returns {Promise<Object>} - Folder tree structure
     */
    async buildFolderCache(rootFolderId = null) {
        try {
            // Use config root folder if set, otherwise fall back to env or 'root'
            const config = require('../utils/config');
            const rootId = rootFolderId || config.get('rootFolderId') || process.env.DEFAULT_DRIVE_FOLDER_ID || 'root';
            console.log('📁 Building folder cache from Google Drive...');
            console.log(`🔒 Restricting to root folder: ${rootId}`);
            
            const startTime = Date.now();
            
            // Validate root folder exists and get its name
            let rootFolderName = 'Root';
            if (rootId !== 'root') {
                try {
                    const rootFolder = await this.drive.files.get({
                        fileId: rootId,
                        fields: 'name, mimeType'
                    });
                    rootFolderName = rootFolder.data.name;
                    console.log(`📂 Root folder name: "${rootFolderName}"`);
                    
                    if (rootFolder.data.mimeType !== 'application/vnd.google-apps.folder') {
                        throw new Error('Root ID is not a folder');
                    }
                } catch (error) {
                    console.error(`❌ Cannot access root folder ${rootId}:`, error.message);
                    throw new Error(`Invalid root folder: ${rootId}`);
                }
            }
            
            // Clear existing cache
            this.folderCache.tree = {};
            this.folderCache.flat.clear();
            
            // Get all folders from Drive (within root scope only)
            const allFolders = await this.getAllFolders(rootId);
            
            // Build tree structure
            const tree = this.buildFolderTree(allFolders, rootId);
            
            // Update cache
            this.folderCache.tree = tree;
            this.folderCache.lastUpdated = Date.now();
            
            const duration = Date.now() - startTime;
            console.log(`✅ Folder cache built successfully (${allFolders.length} folders, ${duration}ms)`);
            
            return tree;
        } catch (error) {
            console.error('❌ Error building folder cache:', error.message);
            throw error;
        }
    }

    /**
     * Get all folders from Google Drive recursively (within root folder only)
     * @param {string} rootId - Root folder ID to scope the search
     * @returns {Promise<Array>} - Array of folder objects within the root
     */
    async getAllFolders(rootId) {
        console.log(`🔍 Scanning folders within root: ${rootId}`);
        const folders = [];
        const processedFolders = new Set();
        const foldersToProcess = [rootId];

        // Recursively get all folders within the root folder
        while (foldersToProcess.length > 0) {
            const parentId = foldersToProcess.shift();
            
            if (processedFolders.has(parentId)) {
                continue; // Avoid infinite loops
            }
            processedFolders.add(parentId);

            let pageToken = null;
            do {
                // Query only for folders that are children of the current parent
                const query = `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
                
                try {
                    const response = await this.drive.files.list({
                        q: query,
                        fields: 'nextPageToken, files(id, name, parents)',
                        pageSize: 1000,
                        pageToken: pageToken
                    });

                    const childFolders = response.data.files || [];
                    folders.push(...childFolders);
                    
                    // Add child folders to processing queue for recursive scanning
                    childFolders.forEach(folder => {
                        if (!processedFolders.has(folder.id)) {
                            foldersToProcess.push(folder.id);
                        }
                    });

                    pageToken = response.data.nextPageToken;
                } catch (error) {
                    console.error(`❌ Error scanning folder ${parentId}:`, error.message);
                    break;
                }
            } while (pageToken);
        }

        console.log(`✅ Found ${folders.length} folders within root scope`);
        return folders;
    }

    /**
     * Build hierarchical folder tree from flat folder list
     * @param {Array} folders - Flat array of folders
     * @param {string} rootId - Root folder ID
     * @returns {Object} - Hierarchical tree structure
     */
    buildFolderTree(folders, rootId) {
        const folderMap = new Map();
        const tree = {};

        // First pass: create folder map and flat cache
        folders.forEach(folder => {
            const folderObj = {
                id: folder.id,
                name: folder.name,
                parentId: folder.parents ? folder.parents[0] : null,
                children: {},
                path: '' // Will be calculated
            };
            
            folderMap.set(folder.id, folderObj);
            this.folderCache.flat.set(folder.id, folderObj);
        });

        // Second pass: build tree structure and calculate paths
        const calculatePath = (folderId, visited = new Set()) => {
            if (visited.has(folderId)) return ''; // Prevent circular references
            visited.add(folderId);
            
            const folder = folderMap.get(folderId);
            if (!folder) return '';
            
            // If parent is the root folder or no parent, this is a top-level folder
            if (folder.parentId === rootId || !folder.parentId) {
                folder.path = folder.name;
                return folder.name;
            }
            
            // Only calculate parent path if parent exists in our folder map (within scope)
            const parent = folderMap.get(folder.parentId);
            if (!parent) {
                // Parent not in scope, treat as top-level
                folder.path = folder.name;
                return folder.name;
            }
            
            const parentPath = calculatePath(folder.parentId, visited);
            folder.path = parentPath ? `${parentPath}/${folder.name}` : folder.name;
            return folder.path;
        };

        // Calculate paths for all folders
        folders.forEach(folder => {
            calculatePath(folder.id);
        });

        // Build tree structure (only within root scope)
        folders.forEach(folder => {
            const folderObj = folderMap.get(folder.id);
            
            if (folder.parents && folder.parents[0] !== rootId) {
                // Has parent - add to parent's children (only if parent is in scope)
                const parent = folderMap.get(folder.parents[0]);
                if (parent) {
                    parent.children[folder.name] = folderObj;
                }
                // If parent not in scope, this folder is effectively orphaned and won't appear in tree
            } else {
                // Root level folder (direct child of our root folder)
                tree[folder.name] = folderObj;
            }
        });

        return tree;
    }

    /**
     * Get cached folder structure (refresh if needed)
     * @param {boolean} forceRefresh - Force cache refresh
     * @returns {Promise<Object>} - Folder tree structure
     */
    async getFolderStructure(forceRefresh = false) {
        const now = Date.now();
        const needsRefresh = forceRefresh || 
            !this.folderCache.lastUpdated || 
            (now - this.folderCache.lastUpdated) > this.folderCache.refreshInterval;

        if (needsRefresh) {
            await this.buildFolderCache();
        }

        return this.folderCache.tree;
    }

    /**
     * Get folders for Discord select menu (max 25 options)
     * @param {string} parentPath - Parent folder path (empty for root)
     * @returns {Array} - Array of folder options for Discord select menu
     */
    getFoldersForSelectMenu(parentPath = '') {
        const folders = [];
        let currentLevel = this.folderCache.tree;

        // Navigate to the specified path
        if (parentPath) {
            const pathParts = parentPath.split('/');
            for (const part of pathParts) {
                if (currentLevel[part] && currentLevel[part].children) {
                    currentLevel = currentLevel[part].children;
                } else {
                    return []; // Path not found
                }
            }
        }

        // Convert to Discord select menu format
        Object.keys(currentLevel).forEach(folderName => {
            const folder = currentLevel[folderName];
            const fullPath = parentPath ? `${parentPath}/${folderName}` : folderName;
            
            folders.push({
                label: folderName,
                value: fullPath,
                description: `Upload to ${fullPath}`,
                emoji: '📁'
            });
        });

        // Sort folders alphabetically and limit to 25 (Discord limit)
        return folders
            .sort((a, b) => a.label.localeCompare(b.label))
            .slice(0, 25);
    }

    /**
     * Get folder ID by path using cache
     * @param {string} folderPath - Path like "projects/game-art/characters"
     * @returns {string} - Folder ID
     */
    getCachedFolderIdByPath(folderPath) {
        if (!folderPath || folderPath === '/') {
            // Use config root folder if set, otherwise fall back to env or 'root'
            const config = require('../utils/config');
            return config.get('rootFolderId') || process.env.DEFAULT_DRIVE_FOLDER_ID || 'root';
        }

        // Find folder in flat cache by path
        for (const [id, folder] of this.folderCache.flat) {
            if (folder.path === folderPath) {
                return id;
            }
        }

        // Fallback to original method if not found in cache
        console.log(`⚠️ Folder not found in cache: ${folderPath}, using fallback method`);
        return this.getFolderIdByPath(folderPath);
    }

    /**
     * Set the root folder for the bot
     */
    async setRootFolder(folderId) {
        this.rootFolderId = folderId;
        console.log(`📁 Root folder set to: ${folderId}`);
    }

    /**
     * Get folder information by ID
     */
    async getFolderInfo(folderId) {
        try {
            const response = await this.drive.files.get({
                fileId: folderId,
                fields: 'id, name, mimeType'
            });

            if (response.data.mimeType !== 'application/vnd.google-apps.folder') {
                return null; // Not a folder
            }

            return {
                id: response.data.id,
                name: response.data.name
            };
        } catch (error) {
            console.error('❌ Error getting folder info:', error);
            return null;
        }
    }

    /**
     * Force refresh the folder cache
     */
    async refreshFolderCache() {
        console.log('🔄 Refreshing folder cache...');
        await this.buildFolderCache();
        console.log('✅ Folder cache refreshed successfully');
    }

    /**
     * Apply a newly obtained refresh token at runtime
     */
    async applyNewRefreshToken(token) {
        this.oauth2Client.setCredentials({ refresh_token: token });
        try {
            await credentials.setRefreshToken(token);
            console.log('✅ New refresh token persisted to credentials file');
        } catch (err) {
            console.error('❌ Failed to persist new refresh token:', err.message);
        }
    }
}

module.exports = GoogleDriveService; 
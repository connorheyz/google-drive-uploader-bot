# Discord Art Uploader Bot

A Discord bot that allows users to upload art from Discord directly to Google Drive with an approval workflow.

## Setup Instructions

### 1. Prerequisites

- Node.js 16+ installed
- Discord Developer Application and Bot Token
- Google Cloud Project with Drive API enabled

### 2. Discord Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section and create a bot
4. Copy the bot token for later
5. Enable these bot permissions:
   - Send Messages
   - Use Slash Commands
   - Read Message History
   - Add Reactions
   - Use External Emojis
   - Embed Links
   - Attach Files
   - Read Messages/View Channels
6. Invite bot to your server with these permissions

### 3. Google Drive Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable the Google Drive API
4. Create credentials (OAuth 2.0 Client ID) of type 'Web Application'
5. Add `https://developers.google.com/oauthplayground/` as a valid URI
6. Download the credentials JSON file
7. Add the `https://www.googleapis.com/auth/drive` scope
8. Use the Google OAuth playground or a setup script to get refresh token

**Getting Google Refresh Token:**
```bash
# You'll need to implement OAuth flow or use tools like:
# https://developers.google.com/oauthplayground/
# Set scope to: https://www.googleapis.com/auth/drive
```

### 4. Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd discord-bot

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

### 5. Configuration

Edit `.env` file with your credentials:

```env
# Discord Configuration
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_CLIENT_ID=your_discord_application_id_here

# Channel IDs (Enable Developer Mode in Discord, right-click channels, Copy ID)
UPLOAD_CHANNELS=123456789012345678,987654321098765432
APPROVAL_CHANNEL_ID=555666777888999000

# Upload emoji (Unicode or custom emoji ID)
UPLOAD_EMOJI=⬆️

# Officer Permission System
# Any user with this Discord permission can trigger uploads on any message
# Common options: ManageMessages, ManageChannels, ModerateMembers, Administrator
# Full list: https://discord.js.org/#/docs/discord.js/stable/class/PermissionsBitField?scrollTo=s-Flags
OFFICER_PERMISSION=ManageMessages

# Google Drive Configuration
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
GOOGLE_REDIRECT_URI=urn:ietf:wg:oauth:2.0:oob
GOOGLE_REFRESH_TOKEN=your_google_refresh_token_here

# Default upload folder ID in Google Drive
DEFAULT_DRIVE_FOLDER_ID=your_default_folder_id_here
```

### 6. Permission System

The bot implements smart permission checking to prevent spam and unintended upload requests:

- **Original Authors**: Users can always trigger uploads on their own messages
- **Officers**: Users with officer permissions can trigger uploads on any message
- **Other Users**: Reactions from other users are silently ignored (no DM spam)

**Officer Permission System:**

Set `OFFICER_PERMISSION` to any Discord permission like:
- `ManageMessages` - Users who can manage messages
- `ManageChannels` - Users who can manage channels  
- `ModerateMembers` - Users who can moderate members
- `Administrator` - Server administrators

Just assign the chosen permission to any role in your Discord server settings, and users with that role will automatically be able to trigger uploads.

This allows people to react freely with the upload emoji without creating unwanted upload requests.

**Setting up Officer Permissions:**
1. In your Discord server, go to Server Settings → Roles
2. Create a new role (e.g., "Art Officers") or select an existing role
3. Enable the permission you configured (e.g., "Manage Messages")
4. Assign this role to users who should be able to trigger uploads on any message
5. No need to copy role IDs or modify the bot configuration!

### 7. Running the Bot

```bash
# Development (with auto-restart)
npm run dev

# Production
npm start
```

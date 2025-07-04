require('dotenv').config();
const { REST, Routes } = require('discord.js');

async function cleanupDuplicateCommands() {
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const clientId = process.env.DISCORD_CLIENT_ID;
        const guildId = process.env.GUILD_ID;

        console.log('🔍 Fetching existing commands...');
        
        // Clean up BOTH global and guild commands
        let globalCommands = [];
        let guildCommands = [];
        
        try {
            console.log('🌍 Checking global commands...');
            globalCommands = await rest.get(Routes.applicationCommands(clientId));
            console.log(`📋 Found ${globalCommands.length} global commands:`);
            globalCommands.forEach(cmd => {
                console.log(`   - ${cmd.name} (ID: ${cmd.id}) [GLOBAL]`);
            });
        } catch (error) {
            console.log('⚠️ Could not fetch global commands:', error.message);
        }

        if (guildId) {
            try {
                console.log(`📍 Checking guild commands for server: ${guildId}...`);
                guildCommands = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
                console.log(`📋 Found ${guildCommands.length} guild commands:`);
                guildCommands.forEach(cmd => {
                    console.log(`   - ${cmd.name} (ID: ${cmd.id}) [GUILD]`);
                });
            } catch (error) {
                console.log('⚠️ Could not fetch guild commands:', error.message);
            }
        }

        const totalCommands = globalCommands.length + guildCommands.length;
        if (totalCommands === 0) {
            console.log('✅ No commands found to clean up');
            return;
        }

        // Ask for confirmation
        console.log(`\n⚠️  This will DELETE ALL ${totalCommands} existing slash commands!`);
        console.log('Are you sure you want to continue? (y/N)');
        
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const answer = await new Promise(resolve => {
            readline.question('', resolve);
        });
        readline.close();

        if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
            console.log('❌ Cleanup cancelled');
            return;
        }

        // Delete global commands
        if (globalCommands.length > 0) {
            console.log('\n🗑️ Deleting global commands...');
            for (const command of globalCommands) {
                console.log(`   Deleting: ${command.name} (${command.id}) [GLOBAL]`);
                await rest.delete(Routes.applicationCommand(clientId, command.id));
            }
        }

        // Delete guild commands
        if (guildCommands.length > 0) {
            console.log('\n🗑️ Deleting guild commands...');
            for (const command of guildCommands) {
                console.log(`   Deleting: ${command.name} (${command.id}) [GUILD]`);
                await rest.delete(Routes.applicationGuildCommand(clientId, guildId, command.id));
            }
        }

        console.log('✅ All commands deleted successfully!');
        console.log('🔄 Restart your bot to re-register the commands');

    } catch (error) {
        console.error('❌ Error cleaning up commands:', error);
    }
}

// Run the cleanup
cleanupDuplicateCommands(); 
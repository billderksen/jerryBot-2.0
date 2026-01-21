import { Client, Events, GatewayIntentBits, Collection, MessageFlags, ActivityType } from 'discord.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get directory path for .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables with explicit path
dotenv.config({ path: join(__dirname, '..', '.env') });

import { readdirSync } from 'fs';
import { startWebServer, updateState, setCommandHandler, setAddSongHandler, setBotInfo, setActivityLogger, broadcastListeners } from './web/server.js';
import { getQueue, createQueue, setWebUpdateCallback, setActivityLoggerCallback, setDiscordClient as setMusicQueueClient, is24_7Enabled, setPresenceCallback, triggerStateBroadcast } from './utils/musicQueue.js';
import { setDiscordClient as setActivityLoggerClient, logCommandAction, logWebAction, logNowPlaying, resetLastLoggedSong } from './utils/activityLogger.js';

// Store the last used voice channel for web dashboard
let lastVoiceChannel = null;
let lastGuildId = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ]
});

// Setup commands collection
client.commands = new Collection();

// Load commands
const commandsPath = join(__dirname, 'commands');
const commandFiles = readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = join(commandsPath, file);
  const command = await import(`file://${filePath}`);
  
  if ('data' in command.default && 'execute' in command.default) {
    client.commands.set(command.default.data.name, command.default);
  } else {
    console.log(`[WARNING] The command at ${filePath} is missing required "data" or "execute" property.`);
  }
}

// Setup web dashboard callbacks
setWebUpdateCallback(updateState);

// Setup activity logger callbacks
setActivityLoggerCallback(logNowPlaying, resetLastLoggedSong);

// Handle commands from web dashboard
setCommandHandler((command, guildId) => {
  const queueGuildId = guildId || lastGuildId;
  const queue = getQueue(queueGuildId);
  if (!queue) return;
  
  if (command === 'pause') {
    queue.pause();
  } else if (command === 'resume') {
    queue.resume();
  } else if (command === 'skip') {
    queue.skip();
  } else if (command === 'previous') {
    queue.playPrevious();
  } else if (command === 'stop') {
    queue.stop();
    queue.leave();
  } else if (command.startsWith('volume:')) {
    const level = parseInt(command.split(':')[1]);
    queue.setVolume(level / 100);
  } else if (command.startsWith('skipto:')) {
    const index = parseInt(command.split(':')[1]);
    queue.skipTo(index);
  } else if (command.startsWith('remove:')) {
    const index = parseInt(command.split(':')[1]);
    queue.removeFromQueue(index);
  } else if (command.startsWith('seek:')) {
    const seconds = parseFloat(command.split(':')[1]);
    queue.seek(seconds);
  } else if (command === 'shuffle') {
    queue.shuffle();
  } else if (command.startsWith('reorder:')) {
    const parts = command.split(':');
    const fromIndex = parseInt(parts[1]);
    const toIndex = parseInt(parts[2]);
    queue.reorder(fromIndex, toIndex);
  } else if (command === 'loop') {
    queue.cycleLoopMode();
  } else if (command === '24/7') {
    queue.toggle24_7();
  }
});

// Handle adding songs from web dashboard
setAddSongHandler(async (song, guildId) => {
  console.log('Add song handler called:', { songTitle: song.title, guildId });
  
  // Use provided guildId, last known, or fallback to env GUILD_ID
  const targetGuildId = guildId || lastGuildId || process.env.GUILD_ID;
  console.log('Target guild ID:', targetGuildId, 'Last guild ID:', lastGuildId);
  
  // Check if we have an existing queue with a connection
  let queue = getQueue(targetGuildId);
  const hasActiveConnection = queue?.connection;
  console.log('Existing queue:', !!queue, 'Has connection:', hasActiveConnection);
  
  // If no active connection and no last voice channel, find the most populated voice channel
  if (!hasActiveConnection && !lastVoiceChannel) {
    if (!targetGuildId) {
      console.log('No guild specified');
      return { success: false, error: 'No guild specified. Play a song from Discord first.' };
    }
    
    const guild = client.guilds.cache.get(targetGuildId);
    if (!guild) {
      console.log('Guild not found:', targetGuildId);
      return { success: false, error: 'Guild not found.' };
    }
    
    console.log('Finding voice channels in guild:', guild.name);
    
    // Find the most populated voice channel (excluding AFK channel)
    const voiceChannels = guild.channels.cache
      .filter(channel => 
        channel.isVoiceBased() && 
        channel.id !== guild.afkChannelId &&
        channel.members.size > 0
      )
      .sort((a, b) => b.members.size - a.members.size);
    
    console.log('Voice channels with users:', voiceChannels.size);
    
    if (voiceChannels.size === 0) {
      return { success: false, error: 'No users in any voice channel. Someone needs to be in a voice channel first.' };
    }
    
    // Get the most populated channel
    lastVoiceChannel = voiceChannels.first();
    lastGuildId = targetGuildId;
    console.log('Selected voice channel:', lastVoiceChannel.name);
  }
  
  if (!lastGuildId || !lastVoiceChannel) {
    return { success: false, error: 'No active voice session. Play a song from Discord first.' };
  }
  
  if (!queue) {
    // Get guild info for the web dashboard
    const guild = client.guilds.cache.get(lastGuildId);
    const guildInfo = guild ? {
      name: guild.name,
      icon: guild.iconURL({ size: 128 })
    } : null;
    
    queue = createQueue(lastGuildId, guildInfo);
    await queue.join(lastVoiceChannel);
  }
  
  queue.addSong(song);
  
  if (!queue.isPlaying) {
    await queue.play();
    return { success: true, message: 'Now playing' };
  }
  
  return { success: true, message: 'Added to queue' };
});

// Track voice channel usage
let emptyChannelTimeout = null;

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  // Track when bot joins or is moved to a voice channel
  if (newState.member?.id === client.user?.id && newState.channel) {
    const wasMoved = oldState.channel && oldState.channelId !== newState.channelId;
    lastVoiceChannel = newState.channel;
    lastGuildId = newState.guild.id;

    // Update the queue's voice channel reference when bot is moved
    const queue = getQueue(lastGuildId);
    if (queue) {
      queue.voiceChannel = newState.channel;
      queue.voiceChannelName = newState.channel.name;
      // Broadcast state to update UI with new channel name
      if (wasMoved) {
        console.log(`Bot moved to channel: ${newState.channel.name}`);
        triggerStateBroadcast();
        broadcastListeners();
      }
    }

    // Clear any pending leave timeout when bot joins/moves
    if (emptyChannelTimeout) {
      clearTimeout(emptyChannelTimeout);
      emptyChannelTimeout = null;
    }
  }

  // Track when bot leaves/is disconnected from a voice channel
  if (oldState.member?.id === client.user?.id && !newState.channel) {
    lastVoiceChannel = null;
    lastGuildId = null;
    if (emptyChannelTimeout) {
      clearTimeout(emptyChannelTimeout);
      emptyChannelTimeout = null;
    }
  }

  // Update listeners when someone joins/leaves the bot's voice channel
  const botVoiceChannel = lastVoiceChannel;
  if (botVoiceChannel) {
    const isRelevantChannel =
      oldState.channelId === botVoiceChannel.id ||
      newState.channelId === botVoiceChannel.id;

    if (isRelevantChannel) {
      // Broadcast updated listeners list
      broadcastListeners();

      // Check if someone left the bot's channel (not the bot itself)
      if (oldState.channelId === botVoiceChannel.id && oldState.member?.id !== client.user?.id) {
        // Get fresh channel data to check member count
        const freshChannel = client.channels.cache.get(botVoiceChannel.id);
        if (freshChannel) {
          // Count non-bot members
          const humanMembers = freshChannel.members.filter(m => !m.user.bot).size;

          if (humanMembers === 0 && !is24_7Enabled()) {
            // Channel is empty (only bot), start leave timeout if not in 24/7 mode
            console.log('Voice channel empty, will leave in 30 seconds if no one joins...');

            // Clear any existing timeout
            if (emptyChannelTimeout) {
              clearTimeout(emptyChannelTimeout);
            }

            emptyChannelTimeout = setTimeout(() => {
              // Re-check before leaving
              const recheckChannel = client.channels.cache.get(botVoiceChannel.id);
              const recheckHumans = recheckChannel?.members.filter(m => !m.user.bot).size || 0;

              if (recheckHumans === 0 && !is24_7Enabled()) {
                console.log('Voice channel still empty, leaving...');
                const queue = getQueue(lastGuildId);
                if (queue) {
                  queue.leave();
                }
                lastVoiceChannel = null;
                lastGuildId = null;
              }
              emptyChannelTimeout = null;
            }, 30000); // 30 seconds
          }
        }
      }

      // Cancel leave timeout if someone joins
      if (newState.channelId === botVoiceChannel.id && newState.member?.id !== client.user?.id) {
        if (emptyChannelTimeout) {
          console.log('Someone joined, cancelling leave timeout');
          clearTimeout(emptyChannelTimeout);
          emptyChannelTimeout = null;
        }
      }
    }
  }
});

// Update listeners when a guild member's nickname changes
client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  // Check if display name changed
  if (oldMember.displayName !== newMember.displayName) {
    // Broadcast updated listeners to refresh nicknames
    broadcastListeners();
  }
});

// Ready event
client.once(Events.ClientReady, readyClient => {
  console.log(`✅ Ready! Logged in as ${readyClient.user.tag}`);
  
  // Set Discord client for musicQueue (for voice channel member tracking)
  setMusicQueueClient(readyClient);

  // Set presence callback for now playing status
  setPresenceCallback((songTitle) => {
    if (songTitle) {
      // Truncate title if too long (Discord has a limit)
      const displayTitle = songTitle.length > 100 ? songTitle.substring(0, 97) + '...' : songTitle;
      readyClient.user.setActivity(displayTitle, { type: ActivityType.Listening });
    } else {
      readyClient.user.setActivity(null);
    }
  });

  // Set bot info for web dashboard
  setBotInfo({
    username: readyClient.user.username,
    avatar: readyClient.user.displayAvatarURL({ size: 256 }),
    id: readyClient.user.id
  });
  
  // Set Discord client for activity logger
  setActivityLoggerClient(readyClient);
  
  // Pass logger to web server for web dashboard actions
  setActivityLogger({ logCommandAction, logWebAction, logNowPlaying, resetLastLoggedSong });
  
  startWebServer();
  
  // Periodically refresh listeners to catch any nickname changes (every 30 seconds)
  setInterval(() => {
    broadcastListeners();
  }, 30000);
});

// Interaction handler
client.on(Events.InteractionCreate, async interaction => {
  // Handle autocomplete interactions
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command || !command.autocomplete) return;
    
    try {
      await command.autocomplete(interaction);
    } catch (error) {
      console.error(error);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);

  if (!command) {
    console.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      console.error('Could not send error message:', replyError.message);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

import { Client, Events, GatewayIntentBits, Partials, Collection, MessageFlags, ActivityType, Options, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get directory path for .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables with explicit path
dotenv.config({ path: join(__dirname, '..', '.env') });

import { readdirSync, appendFileSync } from 'fs';
import { loadJsonSync, saveJsonSync } from './utils/jsonStore.js';
import { chatWithAI } from './utils/openrouter.js';
import { startWebServer, updateState, setCommandHandler, setAddSongHandler, setBotInfo, setActivityLogger, setMemberFetcher, setDiscordClient as setWebDiscordClient, broadcastListeners } from './web/server.js';
import { getQueue, createQueue, setWebUpdateCallback, setActivityLoggerCallback, setDiscordClient as setMusicQueueClient, is24_7Enabled, setPresenceCallback, triggerStateBroadcast } from './utils/musicQueue.js';
import { setDiscordClient as setActivityLoggerClient, logCommandAction, logWebAction, logNowPlaying, resetLastLoggedSong } from './utils/activityLogger.js';
import { initTracker } from './utils/osrsTracker.js';
import { initTwitchTracker } from './utils/twitchTracker.js';
import { initWeeklyRecap } from './utils/weeklyRecap.js';
import { initDiscordTracker } from './utils/discordTracker.js';
import { initLevelSystem } from './utils/levelSystem.js';
import { initBirthdayTracker } from './utils/birthdayTracker.js';
import { initReminderTracker } from './utils/reminderTracker.js';
import { getAntiOfflineState } from './commands/antioffline.js';
import { updateLastSeen } from './utils/lastSeenTracker.js';
import { initTeamspeakStatus } from './utils/teamspeakStatus.js';

// Store the last used voice channel for web dashboard
let lastVoiceChannel = null;
let lastGuildId = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Message],
  makeCache: Options.cacheWithLimits({
    MessageManager: 1000,
  }),
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
  } else if (command === 'radio') {
    queue.toggleRadio();
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

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  // Track last seen when a user joins or changes voice channels
  if (newState.channel && newState.member && !newState.member.user.bot) {
    updateLastSeen(newState.member.user.id, newState.member.displayName, 'voice');
  }

  // Anti-offline: kick users showing offline from voice channels
  if (!oldState.channel && newState.channel && newState.member && !newState.member.user.bot) {
    const antiOffline = getAntiOfflineState(newState.guild.id);
    if (antiOffline.enabled) {
      const presence = newState.member.presence;
      if (!presence || presence.status === 'offline') {
        try {
          await newState.disconnect();
          const generalChannel = newState.guild.channels.cache.get('1419789649873735680');
          if (generalChannel) {
            generalChannel.send(`<@${newState.member.id}> is gekickt uit het voice kanaal — anti-offline modus staat aan, aangezet door <@183235848794406914>.`);
          }
        } catch (e) {
          console.error('[AntiOffline] Voice kick error:', e.message);
        }
      }
    }
  }

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

// Presence tracking + Anti-offline
client.on(Events.PresenceUpdate, async (oldPresence, newPresence) => {
  if (!newPresence?.guild || newPresence.member?.user?.bot) return;

  // Track last seen when user goes offline
  const newStatus = newPresence.status;
  const wasOnline = oldPresence?.status && oldPresence.status !== 'offline';
  if (newStatus === 'offline' && wasOnline) {
    const member = newPresence.member;
    updateLastSeen(member.user.id, member.displayName, 'presence');
  }

  // Anti-offline: kick users who go offline while in a voice channel
  const antiOffline = getAntiOfflineState(newPresence.guild.id);
  if (!antiOffline.enabled) return;

  if (newStatus === 'offline' && wasOnline) {
    const member = newPresence.member;
    if (member?.voice?.channel) {
      try {
        await member.voice.disconnect();
        const generalChannel = newPresence.guild.channels.cache.get('1419789649873735680');
        if (generalChannel) {
          generalChannel.send(`<@${member.id}> is gekickt uit het voice kanaal — anti-offline modus staat aan, aangezet door <@183235848794406914>.`);
        }
      } catch (e) {
        console.error('[AntiOffline] Presence kick error:', e.message);
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

  // Set Discord client for web server (channel listing)
  setWebDiscordClient(readyClient);
  
  // Pass logger to web server for web dashboard actions
  setActivityLogger({ logCommandAction, logWebAction, logNowPlaying, resetLastLoggedSong });

  // Set member fetcher for getting fresh nicknames
  const targetGuildId = process.env.GUILD_ID || '918554414220972032';
  setMemberFetcher(async (userId) => {
    try {
      const guild = readyClient.guilds.cache.get(targetGuildId);
      if (!guild) return null;
      const member = await guild.members.fetch(userId);
      if (!member) return null;
      return {
        nickname: member.nickname,
        globalName: member.user.globalName,
        username: member.user.username,
        roles: [...member.roles.cache.keys()]
      };
    } catch (error) {
      return null;
    }
  });

  // Initialize OSRS tracker auto-refresh
  initTracker();

  // Initialize Twitch stream tracker
  initTwitchTracker(readyClient);

  // Initialize Discord activity tracker (messages + voice time)
  initDiscordTracker(readyClient);

  // Initialize level/XP system
  initLevelSystem(readyClient);

  // Initialize weekly recap scheduler
  initWeeklyRecap(readyClient);

  // Initialize birthday tracker
  initBirthdayTracker(readyClient);

  // Initialize reminder tracker
  initReminderTracker(readyClient);

  // Initialize TeamSpeak 6 status channel
  initTeamspeakStatus(readyClient);

  startWebServer();


  // Periodically refresh listeners to catch any nickname changes (every 30 seconds)
  setInterval(() => {
    broadcastListeners();
  }, 30000);
});

// Word filter
const kekwFile = join(__dirname, '..', 'data', 'kekwCounts.json');
let kekwCounts = loadJsonSync(kekwFile, {});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild) return;

  // Track last seen
  updateLastSeen(message.author.id, message.member?.displayName || message.author.username, 'message');

  // Anti-offline mode: delete messages from users with offline/invisible status
  const antiOffline = getAntiOfflineState(message.guild.id);
  if (antiOffline.enabled) {
    const presence = message.member?.presence;
    // No presence or status 'offline' means the user is offline/invisible
    if (!presence || presence.status === 'offline') {
      try {
        await message.delete();
        await message.channel.send(`<@${message.author.id}> De Discord staat in anti offline modus, aangezet door <@183235848794406914>.`);
      } catch (e) {
        console.error('[AntiOffline] Error:', e.message);
      }
      return;
    }
  }

  if (/kekw/i.test(message.content)) {
    const userId = message.author.id;
    kekwCounts[userId] = (kekwCounts[userId] || 0) + 1;
    saveJsonSync(kekwFile, kekwCounts);
    try {
      await message.delete();
      await message.channel.send(`<@${userId}> Dat zeggen we hier niet. Je hebt dit al ${kekwCounts[userId]} keer proberen te zeggen.`);
    } catch (e) {
      console.error('[WordFilter] Error:', e.message);
    }
    return;
  }

  // Multi-turn AI chat: detect replies to bot chat messages
  if (message.reference?.messageId) {
    try {
      const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
      if (repliedTo.author.id !== client.user.id) return;
      if (!repliedTo.content.includes('**Question:**') && !repliedTo.content.includes('**Answer (model:')) return;

      // Walk the reply chain to build conversation history (max 10 turns)
      const MAX_TURNS = 10;
      const history = [];
      let current = repliedTo;

      while (current && history.length < MAX_TURNS * 2) {
        if (current.author.id === client.user.id) {
          // Bot message — extract the answer text
          let answer = current.content;
          const answerMatch = answer.match(/\*\*Answer \(model: [^)]+\):\*\*\n([\s\S]*?)(\n\n_Tokens:.*)?$/);
          if (answerMatch) {
            answer = answerMatch[1].trim();
          }
          history.unshift({ role: 'assistant', content: answer });

          // Extract the question from the same message if present
          const questionMatch = current.content.match(/\*\*Question:\*\*\n([\s\S]*?)\n\n\*\*Answer/);
          if (questionMatch) {
            history.unshift({ role: 'user', content: questionMatch[1].trim() });
          }
        } else {
          // User message in reply chain
          history.unshift({ role: 'user', content: current.content });
        }

        // Walk up the chain
        if (current.reference?.messageId) {
          try {
            current = await message.channel.messages.fetch(current.reference.messageId);
          } catch {
            break;
          }
        } else {
          break;
        }
      }

      // Send the follow-up question with conversation context
      const GROK_MODEL = 'x-ai/grok-4.1-fast';
      const followUpQuestion = message.content;

      console.log(`\n[${new Date().toISOString()}] Follow-up from ${message.author.tag} (${message.author.id}):`);
      console.log(`Model: ${GROK_MODEL}`);
      console.log(`Question: ${followUpQuestion}`);
      console.log(`Conversation history: ${history.length} messages`);

      // Show typing indicator while waiting for AI
      await message.channel.sendTyping();

      const { content: aiResponse, modelUsed, usage } = await chatWithAI(
        followUpQuestion,
        process.env.OPENROUTER_API_KEY,
        GROK_MODEL,
        history
      );

      const questionPrefix = `**Question:**\n${followUpQuestion}\n\n**Answer (model: ${modelUsed}):**\n`;
      const tokensLine = (() => {
        const total = usage?.totalTokens;
        const prompt = usage?.promptTokens;
        const completion = usage?.completionTokens;
        if (!total && !prompt && !completion) return '';
        const parts = [];
        if (typeof total === 'number') parts.push(`total ${total}`);
        if (typeof prompt === 'number') parts.push(`prompt ${prompt}`);
        if (typeof completion === 'number') parts.push(`completion ${completion}`);
        return `\n\n_Tokens: ${parts.join(', ')}_`;
      })();

      const fullResponse = `${questionPrefix}${aiResponse}${tokensLine}`;

      if (fullResponse.length <= 2000) {
        await message.reply({ content: fullResponse });
      } else {
        // Split long responses
        const followUpSuffix = `\n\n_(model: ${modelUsed})_`;
        const maxFirst = 2000 - questionPrefix.length - tokensLine.length;
        const maxFollowUp = 2000 - followUpSuffix.length;

        const makeChunk = (text, limit) => {
          if (text.length <= limit) return { chunk: text, rest: '' };
          const separators = ['. ', '? ', '! ', '\n'];
          let cut = -1;
          for (const sep of separators) {
            const idx = text.lastIndexOf(sep, limit - 1);
            if (idx > cut) cut = idx + (sep === '\n' ? 0 : sep.length);
          }
          if (cut <= 0) cut = limit;
          return { chunk: text.slice(0, cut).trim(), rest: text.slice(cut).trim() };
        };

        const chunks = [];
        let remaining = aiResponse.trim();
        const first = makeChunk(remaining, maxFirst);
        chunks.push(first.chunk);
        remaining = first.rest;
        while (remaining.length > 0) {
          const next = makeChunk(remaining, maxFollowUp);
          chunks.push(next.chunk);
          remaining = next.rest;
        }

        await message.reply({ content: `${questionPrefix}${chunks[0]}${tokensLine}` });
        for (let i = 1; i < chunks.length; i++) {
          await message.channel.send(`${chunks[i]}${followUpSuffix}`);
        }
      }
    } catch (error) {
      console.error('[Chat Follow-up] Error:', error);
      await message.reply({ content: `❌ **Error:** ${error.message}` }).catch(() => {});
    }
  }
});

// Log deleted messages to file
const deletedMessagesFile = join(__dirname, '..', 'data', 'deletedMessages.log');
client.on(Events.MessageDelete, async message => {
  if (message.partial || !message.guild) return;
  if (message.author?.bot) return;
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] #${message.channel.name} | ${message.author.tag} (${message.author.id}): ${message.content || '[no text content]'}\n`;
  try { appendFileSync(deletedMessagesFile, line); } catch (e) { console.error('[DeleteLog] Error:', e.message); }

  // Send embed to delete-log channel
  try {
    const deleteLogChannel = message.guild.channels.cache.find(ch => ch.name === 'delete-log');
    if (deleteLogChannel) {
      const embed = new EmbedBuilder()
        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
        .setDescription(`Message deleted in <#${message.channel.id}>`)
        .addFields({ name: 'Content', value: (message.content || '[no text content]').slice(0, 1024) })
        .setTimestamp()
        .setColor(0xFF4444);
      await deleteLogChannel.send({ embeds: [embed] });
    }
  } catch (e) {
    console.error('[DeleteLog] Discord error:', e.message);
  }
});

// Word filter + edit log for edited messages
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  // Fetch full message if partial (uncached)
  if (newMessage.partial) {
    try { newMessage = await newMessage.fetch(); } catch { return; }
  }
  if (newMessage.author?.bot || !newMessage.guild) return;
  // Ignore embed-only updates (e.g. link previews loading)
  if (oldMessage.content === newMessage.content) return;

  const oldContent = oldMessage.partial ? '_[not cached]_' : (oldMessage.content || '_[empty]_');
  const newContent = newMessage.content || '_[empty]_';

  // Log edit to the edit-log channel
  try {
    const editLogChannel = newMessage.guild.channels.cache.find(ch => ch.name === 'edit-log');
    if (editLogChannel) {
      const embed = new EmbedBuilder()
        .setAuthor({ name: newMessage.author.tag, iconURL: newMessage.author.displayAvatarURL() })
        .setDescription(`Message edited in <#${newMessage.channel.id}> [Jump to message](${newMessage.url})`)
        .addFields(
          { name: 'Before', value: oldContent.slice(0, 1024) },
          { name: 'After', value: newContent.slice(0, 1024) },
        )
        .setTimestamp()
        .setColor(0xFFA500);
      await editLogChannel.send({ embeds: [embed] });
    }
  } catch (e) {
    console.error('[EditLog] Error:', e.message);
  }

  // Word filter
  if (/kekw/i.test(newMessage.content)) {
    const userId = newMessage.author.id;
    kekwCounts[userId] = (kekwCounts[userId] || 0) + 1;
    saveJsonSync(kekwFile, kekwCounts);
    try {
      await newMessage.delete();
      await newMessage.channel.send(`<@${userId}> Sneaky edit? Dat zeggen we hier niet. Je hebt dit al ${kekwCounts[userId]} keer proberen te zeggen.`);
    } catch (e) {
      console.error('[WordFilter Edit] Error:', e.message);
    }
  }
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

  // Log command usage to file
  try {
    const cmdLogFile = join(__dirname, '..', 'data', 'commandLog.txt');
    const timestamp = new Date().toISOString();
    const user = interaction.user.tag;
    const userId = interaction.user.id;
    const cmdName = interaction.commandName;
    const subCmd = interaction.options.getSubcommand?.(false) || '';
    const options = interaction.options.data.map(o =>
      o.options ? o.options.map(s => `${s.name}=${s.value}`).join(' ') : `${o.name}=${o.value}`
    ).join(' ');
    const logLine = `[${timestamp}] ${user} (${userId}): /${cmdName}${subCmd ? ' ' + subCmd : ''}${options ? ' ' + options : ''}\n`;
    appendFileSync(cmdLogFile, logLine);
  } catch (e) { /* ignore logging errors */ }

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

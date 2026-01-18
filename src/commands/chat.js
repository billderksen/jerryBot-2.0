import { SlashCommandBuilder } from 'discord.js';
import { chatWithAI } from '../utils/openrouter.js';

export default {
  data: new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Ask a question to the AI')
    .addStringOption(option =>
      option
        .setName('question')
        .setDescription('Your question for the AI')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('model')
        .setDescription('Choose a model (optional)')
        .setRequired(false)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused().toLowerCase();
    const choices = [
      { name: 'x-ai/grok-4.1-fast', value: 'x-ai/grok-4.1-fast' },
      { name: 'xiaomi/mimo-v2-flash:free', value: 'xiaomi/mimo-v2-flash:free' },
      { name: 'google/gemini-2.5-flash', value: 'google/gemini-2.5-flash' },
      { name: 'openai/gpt-4o-mini', value: 'openai/gpt-4o-mini' }
    ];
    const filtered = choices.filter(choice => 
      choice.name.toLowerCase().includes(focusedValue)
    );
    await interaction.respond(filtered.slice(0, 25));
  },
  
  async execute(interaction) {
    const question = interaction.options.getString('question');
    const selectedModel = interaction.options.getString('model') || process.env.OPENROUTER_MODEL || 'openai/gpt-4o';

    // Log question to terminal
    console.log(`\n[${new Date().toISOString()}] Question from ${interaction.user.tag} (${interaction.user.id}):`);
    console.log(`Model: ${selectedModel}`);
    console.log(`Question: ${question}\n`);

    // Defer reply since AI might take a moment
    await interaction.deferReply();

    try {
      // Get AI response using selected model or default
      const { content: aiResponse, modelUsed, usage } = await chatWithAI(
        question,
        process.env.OPENROUTER_API_KEY,
        selectedModel
      );

      // Discord has a 2000 character limit for messages
      const questionPrefix = `**Question:**\n${question}\n\n**Answer (model: ${modelUsed}):**\n`;
      const followUpSuffix = `\n\n_(model: ${modelUsed})_`;

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

      const maxFirstMessage = 2000 - questionPrefix.length - tokensLine.length;
      const maxFollowUp = 2000 - followUpSuffix.length;

      // Helper to split on sentence/line boundaries without cutting words
      const makeChunk = (text, limit) => {
        if (text.length <= limit) return { chunk: text, rest: '' };
        const separators = ['. ', '? ', '! ', '\n'];
        let cut = -1;
        for (const sep of separators) {
          const idx = text.lastIndexOf(sep, limit - 1);
          if (idx > cut) cut = idx + (sep === '\n' ? 0 : sep.length);
        }
        if (cut <= 0) cut = limit;
        const chunk = text.slice(0, cut).trim();
        const rest = text.slice(cut).trim();
        return { chunk, rest };
      };
      
      // Split response into chunks if needed
      if (aiResponse.length <= maxFirstMessage) {
        // Response fits in one message
        await interaction.editReply({
          content: `${questionPrefix}${aiResponse}${tokensLine}`
        });
      } else {
        // Split into multiple messages with sentence-aware chunking
        const chunks = [];
        let remainingText = aiResponse.trim();
        
        // First chunk (with question prefix)
        const first = makeChunk(remainingText, maxFirstMessage);
        chunks.push(first.chunk);
        remainingText = first.rest;
        
        // Remaining chunks
        while (remainingText.length > 0) {
          const next = makeChunk(remainingText, maxFollowUp);
          chunks.push(next.chunk);
          remainingText = next.rest;
        }
        
        // Send first message
        await interaction.editReply({
          content: `${questionPrefix}${chunks[0]}${tokensLine}`
        });
        
        // Send follow-up messages
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({
            content: `${chunks[i]}${followUpSuffix}`
          });
        }
      }

    } catch (error) {
      console.error('Error in chat command:', error);
      
      // Build error message with details
      let errorMessage = '❌ **Error occurred:**\n';
      
      if (error.code) {
        errorMessage += `**Code:** ${error.code}\n`;
      }
      
      errorMessage += `**Message:** ${error.message}`;
      
      await interaction.editReply({
        content: errorMessage
      });
    }
  }
};

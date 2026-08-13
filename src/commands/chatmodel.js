import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } from 'discord.js';
import { fetch } from 'undici';
import { getChatConfig, getVoiceConfig, setChatModel } from '../utils/openrouter.js';

const MODELS_API_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 10 * 60 * 1000;

// In-memory only - a stale list just means autocomplete lags OpenRouter's
// catalog for up to 10 minutes, which is fine for a picker.
let modelCache = { ids: null, fetchedAt: 0 };

async function fetchModelIds() {
  const now = Date.now();
  if (modelCache.ids && now - modelCache.fetchedAt < CACHE_TTL_MS) {
    return modelCache.ids;
  }

  const response = await fetch(MODELS_API_URL, {
    headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter models fetch failed: ${response.status}`);
  }

  const data = await response.json();
  const ids = (data.data || []).map(m => m.id).filter(Boolean);
  modelCache = { ids, fetchedAt: now };
  return ids;
}

export default {
  data: new SlashCommandBuilder()
    .setName('chatmodel')
    .setDescription('View or change the AI chat model (requires Manage Server)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub.setName('show').setDescription('Show the current /chat and Hey Jerry models'))
    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Change the /chat model')
        .addStringOption(opt =>
          opt.setName('model')
            .setDescription('OpenRouter model id, e.g. google/gemini-2.5-flash')
            .setRequired(true)
            .setAutocomplete(true))),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();

    let ids;
    try {
      ids = await fetchModelIds();
    } catch (e) {
      // Fetch failed (missing key, network, timeout) - no suggestions to offer,
      // but /chatmodel set still accepts a raw id typed by hand.
      try { await interaction.respond([]); } catch { /* interaction may have expired */ }
      return;
    }

    const choices = ids
      .filter(id => id.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(id => ({ name: id, value: id }));

    try {
      await interaction.respond(choices);
    } catch (e) {
      // Interaction may have expired
    }
  },

  async execute(interaction) {
    // Defense in depth: setDefaultMemberPermissions hides the command from members without
    // Manage Server in Discord's UI, but doesn't stop it being invoked if that gets misconfigured.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: 'You need the **Manage Server** permission to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'show') {
      const chatConfig = getChatConfig();
      const voiceConfig = getVoiceConfig();

      const embed = new EmbedBuilder()
        .setTitle('🤖 AI Model Configuration')
        .setColor(0x5865f2)
        .addFields(
          { name: '/chat model', value: `\`${chatConfig.model}\``, inline: false },
          { name: 'Hey Jerry (voice intent) model', value: `\`${voiceConfig.model}\``, inline: false },
        )
        .setFooter({ text: 'Use /chatmodel set to change the /chat model.' });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // set
    const requested = interaction.options.getString('model', true);
    const previous = getChatConfig().model;

    let warning = '';
    try {
      const ids = await fetchModelIds();
      if (!ids.includes(requested)) {
        return interaction.reply({
          content: `❌ \`${requested}\` isn't a recognized OpenRouter model id. Pick one from the autocomplete list, or check https://openrouter.ai/models.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (e) {
      // Can't verify against OpenRouter's catalog - set it anyway. Whether the
      // id actually works is OpenRouter's call at request time, not ours.
      warning = "\n\n⚠️ Couldn't verify this id against OpenRouter's model list (fetch failed) — set anyway.";
    }

    setChatModel(requested);

    return interaction.reply({
      content: `✅ \`/chat\` model changed: \`${previous}\` → \`${requested}\`${warning}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

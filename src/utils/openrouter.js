import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadJsonSync, saveJsonSync } from './jsonStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const AI_SETTINGS_FILE = join(__dirname, '..', '..', 'data', 'aiSettings.json');

// In-code defaults - used as the fallback when data/aiSettings.json doesn't exist yet.
// Matches the model chat.js/index.js used to hardcode before they deferred to this
// config, so switching to persisted config doesn't silently change the live model.
const DEFAULT_MODEL = 'x-ai/grok-4.1-fast';
const DEFAULT_SYSTEM_PROMPT = 'You are a concise assistant for a Discord bot. Keep answers brief and under 1800 characters so they fit in one reply. Use tight bullet points when helpful. Only go long if the user explicitly asks for a long or detailed answer.';
const DEFAULT_MAX_TOKENS = 800;

// Voice assistant (Hey Jerry) intent-parsing model - separate from the /chat
// model above since it needs to be fast/cheap and support JSON mode. Verified
// present on OpenRouter (GET /api/v1/models) as of 2026-08-13.
const DEFAULT_VOICE_MODEL = 'google/gemini-2.5-flash-lite';
const DEFAULT_VOICE_MAX_TOKENS = 200;
// Jerry answers in the activity-log embed only. Speaking every reply out loud
// ducks the music for each one, which the owner did not want; the wake beep
// stays as the audible acknowledgement.
const DEFAULT_VOICE_SPOKEN_REPLIES = false;

function loadAiSettings() {
  const data = loadJsonSync(AI_SETTINGS_FILE, {
    model: DEFAULT_MODEL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    maxTokens: DEFAULT_MAX_TOKENS,
    voice: {
      model: DEFAULT_VOICE_MODEL,
      maxTokens: DEFAULT_VOICE_MAX_TOKENS,
      spokenReplies: DEFAULT_VOICE_SPOKEN_REPLIES
    }
  });
  return {
    model: data.model || DEFAULT_MODEL,
    systemPrompt: data.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    maxTokens: data.maxTokens || DEFAULT_MAX_TOKENS,
    // Merged key by key, not wholesale: a file written before any one of these
    // fields existed has a voice section that is missing it, and must still come
    // back with the default rather than undefined.
    voice: {
      model: data.voice?.model || DEFAULT_VOICE_MODEL,
      maxTokens: data.voice?.maxTokens || DEFAULT_VOICE_MAX_TOKENS,
      // Booleans can't use `||`: it would rewrite a deliberate `false` back to
      // the default, which for a true default would silently re-enable speech.
      spokenReplies: typeof data.voice?.spokenReplies === 'boolean'
        ? data.voice.spokenReplies
        : DEFAULT_VOICE_SPOKEN_REPLIES
    }
  };
}

function saveAiSettings() {
  saveJsonSync(AI_SETTINGS_FILE, {
    model: defaultModel,
    systemPrompt,
    maxTokens,
    voice: { model: voiceModel, maxTokens: voiceMaxTokens, spokenReplies: voiceSpokenReplies }
  });
}

// Configurable runtime settings, persisted to data/aiSettings.json so admin-panel
// changes (server.js /api/admin/chat/*) survive a restart
const initialSettings = loadAiSettings();
let defaultModel = initialSettings.model;
let systemPrompt = initialSettings.systemPrompt;
let maxTokens = initialSettings.maxTokens;
let voiceModel = initialSettings.voice.model;
let voiceMaxTokens = initialSettings.voice.maxTokens;
let voiceSpokenReplies = initialSettings.voice.spokenReplies;

/**
 * Get current chat configuration
 * @returns {{model: string, systemPrompt: string, maxTokens: number}}
 */
export function getChatConfig() {
  return { model: defaultModel, systemPrompt, maxTokens };
}

/**
 * Get current voice-assistant (Hey Jerry) configuration.
 * `spokenReplies` false means Jerry acts on commands and reports in the
 * activity-log embed without saying anything out loud.
 * @returns {{model: string, maxTokens: number, spokenReplies: boolean}}
 */
export function getVoiceConfig() {
  return { model: voiceModel, maxTokens: voiceMaxTokens, spokenReplies: voiceSpokenReplies };
}

/**
 * Set the default model
 * @param {string} model - Model identifier
 */
export function setChatModel(model) {
  defaultModel = model;
  saveAiSettings();
}

/**
 * Set the system prompt
 * @param {string} prompt - System prompt text
 */
export function setChatSystemPrompt(prompt) {
  systemPrompt = prompt;
  saveAiSettings();
}

/**
 * Set max tokens
 * @param {number} tokens - Maximum tokens for response
 */
export function setChatMaxTokens(tokens) {
  maxTokens = tokens;
  saveAiSettings();
}

/**
 * Set whether the voice assistant speaks its replies out loud, vs. only
 * reporting in the activity-log embed.
 * @param {boolean} spoken
 */
export function setVoiceSpokenReplies(spoken) {
  voiceSpokenReplies = spoken;
  saveAiSettings();
}

/**
 * Send a chat message to OpenRouter API
 * @param {string} message - The user's message
 * @param {string} apiKey - OpenRouter API key
 * @param {string} model - Model to use (default: uses defaultModel)
 * @param {Array<{role: string, content: string}>} [conversationHistory] - Previous conversation turns for multi-turn chat
 * @returns {Promise<string>} - The AI's response
 */
export async function chatWithAI(message, apiKey, model = null, conversationHistory = null) {
  try {
    const messages = [
      {
        role: 'system',
        content: systemPrompt
      }
    ];

    if (conversationHistory && conversationHistory.length > 0) {
      messages.push(...conversationHistory);
    }

    messages.push({ role: 'user', content: message });

    const response = await axios.post(
      OPENROUTER_API_URL,
      {
        model: model || defaultModel,
        max_tokens: maxTokens,
        messages
      },
      {
        timeout: 60_000,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/billderksen/jerryBot-2.0', // Optional: Your site URL
          'X-Title': 'Discord Bot' // Optional: Your app name
        }
      }
    );

    const content = response.data.choices?.[0]?.message?.content;
    const modelUsed = response.data.model || model;

    const usage = {
      promptTokens: response.data.usage?.prompt_tokens,
      completionTokens: response.data.usage?.completion_tokens,
      totalTokens: response.data.usage?.total_tokens,
    };

    return { content, modelUsed, usage };
  } catch (error) {
    console.error('OpenRouter API Error:', error.response?.data || error.message);
    
    // Extract error details from OpenRouter API response
    if (error.response?.data?.error) {
      const apiError = error.response.data.error;
      const errorObj = new Error(apiError.message || 'Failed to get response from AI');
      errorObj.code = apiError.code;
      throw errorObj;
    }
    
    throw new Error('Failed to get response from AI');
  }
}

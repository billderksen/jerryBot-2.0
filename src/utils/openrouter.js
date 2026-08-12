import axios from 'axios';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Configurable runtime settings
let defaultModel = 'openai/gpt-4o';
let systemPrompt = 'You are a concise assistant for a Discord bot. Keep answers brief and under 1800 characters so they fit in one reply. Use tight bullet points when helpful. Only go long if the user explicitly asks for a long or detailed answer.';
let maxTokens = 800;

/**
 * Get current chat configuration
 * @returns {{model: string, systemPrompt: string, maxTokens: number}}
 */
export function getChatConfig() {
  return { model: defaultModel, systemPrompt, maxTokens };
}

/**
 * Set the default model
 * @param {string} model - Model identifier
 */
export function setChatModel(model) {
  defaultModel = model;
}

/**
 * Set the system prompt
 * @param {string} prompt - System prompt text
 */
export function setChatSystemPrompt(prompt) {
  systemPrompt = prompt;
}

/**
 * Set max tokens
 * @param {number} tokens - Maximum tokens for response
 */
export function setChatMaxTokens(tokens) {
  maxTokens = tokens;
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
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/your-repo', // Optional: Your site URL
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

import axios from 'axios';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Send a chat message to OpenRouter API
 * @param {string} message - The user's message
 * @param {string} apiKey - OpenRouter API key
 * @param {string} model - Model to use (default: openai/gpt-4o)
 * @returns {Promise<string>} - The AI's response
 */
export async function chatWithAI(message, apiKey, model = 'openai/gpt-4o') {
  try {
    const response = await axios.post(
      OPENROUTER_API_URL,
      {
        model: model,
        // Nudge the model to keep answers short enough for one Discord message
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content: 'You are a concise assistant for a Discord bot. Keep answers brief and under 1800 characters so they fit in one reply. Use tight bullet points when helpful. Only go long if the user explicitly asks for a long or detailed answer.'
          },
          {
            role: 'user',
            content: message
          }
        ]
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

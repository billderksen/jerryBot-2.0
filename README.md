# Discord.js Bot with OpenRouter API

A Discord bot that uses the OpenRouter API to provide AI-powered chat responses. Users can interact with the bot using the `/chat` command to ask questions and receive intelligent answers.

## Features

- 🤖 Slash command integration (`/chat`)
- 🧠 OpenRouter API integration (supports GPT-5 and other models)
- ⚡ Fast and responsive
- 🔒 Environment-based configuration

## Prerequisites

- Node.js 18.x or higher
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- An OpenRouter API key ([OpenRouter](https://openrouter.ai/))

## Setup Instructions

### 1. Clone and Install

```bash
# Navigate to project directory
cd "c:\Scripts\jerryBot 2.0"

# Install dependencies (already done)
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
Copy-Item .env.example .env
```

Edit `.env` with your actual values:
```env
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_client_id_here
OPENROUTER_API_KEY=your_openrouter_api_key_here
OPENROUTER_MODEL=openai/gpt-4o
```

**To enable GPT-5:** Update `OPENROUTER_MODEL` to the GPT-5 model identifier (e.g., `openai/gpt-5` or similar, check [OpenRouter docs](https://openrouter.ai/docs) for the exact model name).

### 3. Get Your Discord Bot Token and Client ID

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application or select an existing one
3. Go to the "Bot" section and copy the token → This is your `DISCORD_TOKEN`
4. Go to "OAuth2" → "General" and copy the "Client ID" → This is your `CLIENT_ID`
5. In "OAuth2" → "URL Generator":
   - Select scopes: `bot`, `applications.commands`
   - Select bot permissions: `Send Messages`, `Use Slash Commands`
   - Copy the generated URL and open it in your browser to invite the bot to your server

### 4. Get Your OpenRouter API Key

1. Go to [OpenRouter](https://openrouter.ai/)
2. Sign up or log in
3. Navigate to your API keys section
4. Generate a new API key → This is your `OPENROUTER_API_KEY`

### 5. Deploy Slash Commands

Before running the bot, deploy the slash commands to Discord:

```bash
npm run deploy
```

You should see: `✅ Successfully reloaded 1 application (/) commands.`

### 6. Run the Bot

```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

When the bot is ready, you'll see: `✅ Ready! Logged in as YourBotName#1234`

## Usage

In any Discord channel where the bot has access:

```
/chat question: What is the meaning of life?
```

The bot will respond with an AI-generated answer using the configured model.

## Project Structure

```
jerryBot 2.0/
├── src/
│   ├── commands/
│   │   └── chat.js          # /chat command implementation
│   ├── utils/
│   │   └── openrouter.js    # OpenRouter API client
│   ├── index.js             # Main bot entry point
│   └── deploy-commands.js   # Command deployment script
├── .env.example             # Environment variables template
├── .gitignore
├── package.json
└── README.md
```

## Available Scripts

- `npm start` - Start the bot
- `npm run dev` - Start the bot with auto-reload (Node 18+ required)
- `npm run deploy` - Deploy slash commands to Discord

## Troubleshooting

**Bot doesn't respond to commands:**
- Make sure you ran `npm run deploy` to register the slash commands
- Check that the bot has the necessary permissions in your Discord server
- Verify your `DISCORD_TOKEN` and `CLIENT_ID` are correct

**OpenRouter API errors:**
- Verify your `OPENROUTER_API_KEY` is valid
- Check that you have credits in your OpenRouter account
- Ensure the `OPENROUTER_MODEL` value is a valid model name

**Dependencies warnings:**
- The low severity vulnerabilities are in development dependencies and don't affect bot functionality

## License

MIT

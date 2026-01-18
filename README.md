# Discord.js Bot with OpenRouter API

A Discord bot that uses the OpenRouter API to provide AI-powered chat responses. Users can interact with the bot using the `/chat` command to ask questions and receive intelligent answers.

## Features

- 🤖 Slash command integration (`/chat`)
- 🧠 OpenRouter API integration (supports GPT-5 and other models)
- 🎵 Music player with web dashboard
- 🌐 Web interface with Discord OAuth2
- ⚡ Fast and responsive
- 🔒 Environment-based configuration
- 🐧 Linux/Windows compatible

## Prerequisites

- Node.js 18.x or higher
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- An OpenRouter API key ([OpenRouter](https://openrouter.ai/))
- FFmpeg (auto-installed on Linux, bundled on Windows)
- yt-dlp (auto-installed on Linux)

## Setup Instructions

### Windows Setup

```bash
# Navigate to project directory
cd "c:\Scripts\jerryBot 2.0"

# Install dependencies
npm install
```

### Linux Setup (Debian/Ubuntu)

```bash
# Make the setup script executable
chmod +x setup-linux.sh

# Run the setup script (installs Node.js, FFmpeg, yt-dlp, dependencies)
./setup-linux.sh
```

Or manually:
```bash
# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install FFmpeg
sudo apt install -y ffmpeg

# Install yt-dlp
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# Install build tools for native modules
sudo apt install -y build-essential python3

# Install npm dependencies
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

## Linux Production Deployment

### 1. Create Systemd Service

```bash
sudo nano /etc/systemd/system/jerrybot.service
```

```ini
[Unit]
Description=JerryBot Discord Music Player
After=network.target

[Service]
Type=simple
User=your_username
WorkingDirectory=/path/to/jerrybot
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable jerrybot
sudo systemctl start jerrybot
```

### 2. Set Up Nginx Reverse Proxy (for HTTPS)

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

sudo nano /etc/nginx/sites-available/jerrybot
```

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/jerrybot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# Get SSL certificate
sudo certbot --nginx -d yourdomain.com
```

### 3. Update Discord OAuth Settings

Update your `.env`:
```env
OAUTH_REDIRECT_URI=https://yourdomain.com/auth/discord/callback
```

Update Discord Developer Portal OAuth2 redirect URL to match.

## Troubleshooting

**Bot doesn't respond to commands:**
- Make sure you ran `npm run deploy` to register the slash commands
- Check that the bot has the necessary permissions in your Discord server
- Verify your `DISCORD_TOKEN` and `CLIENT_ID` are correct

**OpenRouter API errors:**
- Verify your `OPENROUTER_API_KEY` is valid
- Check that you have credits in your OpenRouter account
- Ensure the `OPENROUTER_MODEL` value is a valid model name

**Music not playing (Linux):**
- Make sure FFmpeg is installed: `ffmpeg -version`
- Make sure yt-dlp is installed: `yt-dlp --version`
- Update yt-dlp: `sudo yt-dlp -U`
- Check audio permissions

**Native module errors on Linux:**
- Install build tools: `sudo apt install build-essential python3`
- Rebuild native modules: `npm rebuild`

**Port 3000 already in use:**
- Find what's using it: `sudo lsof -i :3000`
- Kill the process or change `WEB_PORT` in `.env`

**Dependencies warnings:**
- The low severity vulnerabilities are in development dependencies and don't affect bot functionality

## License

MIT

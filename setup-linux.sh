#!/bin/bash

# JerryBot 2.0 - Linux Setup Script
# Run this script on a fresh Debian/Ubuntu server

set -e

echo "================================"
echo "JerryBot 2.0 - Linux Setup"
echo "================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -eq 0 ]; then
  echo -e "${YELLOW}Warning: Running as root. Consider using a non-root user.${NC}"
fi

echo ""
echo -e "${GREEN}[1/6] Updating system packages...${NC}"
sudo apt update && sudo apt upgrade -y

echo ""
echo -e "${GREEN}[2/6] Installing Node.js 20.x LTS...${NC}"
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
else
  echo "Node.js already installed: $(node --version)"
fi

echo ""
echo -e "${GREEN}[3/6] Installing FFmpeg...${NC}"
if ! command -v ffmpeg &> /dev/null; then
  sudo apt install -y ffmpeg
else
  echo "FFmpeg already installed: $(ffmpeg -version 2>&1 | head -n1)"
fi

echo ""
echo -e "${GREEN}[4/6] Installing yt-dlp...${NC}"
if ! command -v yt-dlp &> /dev/null; then
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
else
  echo "yt-dlp already installed: $(yt-dlp --version)"
fi

echo ""
echo -e "${GREEN}[5/6] Installing build tools (for native modules)...${NC}"
sudo apt install -y build-essential python3 libtool autoconf automake

echo ""
echo -e "${GREEN}[6/6] Installing npm dependencies...${NC}"
npm install

echo ""
echo "================================"
echo -e "${GREEN}Setup complete!${NC}"
echo "================================"
echo ""
echo "Next steps:"
echo "1. Create/edit the .env file with your configuration"
echo "2. Run: npm run deploy  (to register Discord slash commands)"
echo "3. Run: npm start       (to start the bot)"
echo ""
echo "For production, set up systemd service and nginx."
echo "See README.md for detailed instructions."

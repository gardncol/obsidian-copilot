#!/bin/bash
# Wrapper for upstream-sync.py that handles git authentication
set -e

cd /home/colin/obsidian-agent

# Set up git remote with token for push
TOKEN_FILE=/home/colin/.hermes/scripts/.gh_token

# The token is stored in a file managed by the cron job's context
if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE")
    git remote set-url origin "https://gardncol:${TOKEN}@github.com/gardncol/obsidian-copilot.git" 2>/dev/null || true
fi

# Run the sync script
python3 /home/colin/obsidian-agent/scripts/upstream-sync.py

# Clean up token from remote URL
git remote set-url origin "https://github.com/gardncol/obsidian-copilot.git" 2>/dev/null || true

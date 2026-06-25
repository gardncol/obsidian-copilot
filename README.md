# Obsidian Agent

> **Fork of [Copilot for Obsidian](https://github.com/logancyang/obsidian-copilot) by Logan Yang** — customized for personal use.

**TL;DR:** Copilot for Obsidian with the Plus license requirement removed. Agent mode and all tools work with your own API key
## What's Changed

| Change                                                                                                                          | File(s)                                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Agent mode works with BYOK** — Plus license check replaced with API key check. Any configured provider key unlocks all tools. | `toolExecution.ts`, `CopilotPlusChainRunner.ts` |
| **YouTube transcription ungate** — YouTube script tool no longer requires a Plus license.                                       | `commands/index.ts`                             |
| **Unique plugin ID** — Installs as `obsidian-agent` to coexist with the original Copilot plugin.                                | `manifest.json`                                 |

## Why This Exists

Copilot for Obsidian is MIT-licensed (frontend) and excellent, but the agent mode and certain tools require a paid Plus subscription ($11.67/mo). 

This is a personal fork for my own use. 

## Install

**From BRAT (recommended):**

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Add `gardncol/obsidian-copilot` as a beta plugin
3. Enable **Obsidian Agent** from Community Plugins

**Manual install:**

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/gardncol/obsidian-copilot/releases)
2. Place them in `VaultFolder/.obsidian/plugins/obsidian-agent/`
3. Enable the plugin in Settings → Community Plugins

## Setup

1. Open Settings → Copilot → Basic
2. Enter your API key (OpenRouter, OpenAI, Anthropic, etc.)
3. Switch to **Copilot Plus (Beta)** mode in the chat dropdown
4. All agent tools now work with your key

## Upstream

All credit for the plugin itself goes to **Logan Yang** and the Copilot contributors. This fork tracks the upstream `master` branch with minimal personal patches on top.

Upstream: https://github.com/logancyang/obsidian-copilot


<h1 align="center">GrowthForce</h1>

<p align="center">
  <strong>AI-Powered Multi-Account Content Operations Workspace</strong><br/>
  One-click install. Zero config. No Codex required.
</p>

<p align="center">
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" />
  </a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg" alt="Platform" />
  <img src="https://img.shields.io/badge/version-0.1.10-green.svg" alt="Version" />
</p>

<p align="center">
  <a href="./README.md">中文</a> · <a href="#quick-start">Quick Start</a> · <a href="#product-screenshots">Product Screenshots</a> · <a href="#core-advantages">Core Advantages</a> · <a href="#vision--collaboration">Vision & Collaboration</a>
</p>

---

## Why GrowthForce

Most AI writing tools only solve one problem: "generate a piece of content." But the real challenges in content operations are:

- Managing multiple accounts simultaneously, each with different positioning
- Repeating the same daily loop: find trends → write → publish → check data
- No way to accumulate experience — every creation starts from scratch

GrowthForce is not another AI writing assistant. It's a **complete content operations OS** — from multi-account management to automated publishing, from data collection to AI-powered review, all in one desktop app.

---

## Core Advantages

### Multi-Account Matrix Management

Operate multiple Xiaohongshu and WeChat Official Accounts simultaneously. Each account maintains its own positioning, persona, content strategy, and operational playbook. No more switching between browser windows.

### Fully Automated Operations Loop

```
Account Positioning → Trend Research → Topic Planning → Content Generation → Platform Adaptation → Publishing → Data Collection → AI Review → Strategy Update
```

Once you set up account positioning, GrowthForce automatically executes the full operations pipeline. Scheduled tasks drive data collection and review — every publish's performance automatically feeds into the next creation cycle.

### AI-Powered Review

More than a data dashboard. The AI Agent automatically analyzes each post's performance (reads, likes, saves, comments), compares drafts vs. final versions, identifies effective patterns, and updates the account's long-term operational playbook. Single-post noise won't distort judgment — only patterns validated across multiple posts get promoted to active rules.

### One-Click Install, Ready to Use

Download the installer from [GitHub Releases](https://github.com/veloforce/GrowthForce/releases/) and choose the package for your platform:

- **macOS**: download the DMG (choose Apple Silicon or Intel based on your device)
- **Windows**: download the EXE

After downloading, double-click to install, then open and go.

- **No Codex installation needed** — Agent runtime is built-in
- **No workflow configuration needed** — Pre-built content operations Skills and Tools included
- **No environment setup needed** — Xiaohongshu connector, browser engine, database all bundled
- **No programming experience needed** — Conversational interface, just talk naturally

---

## Quick Start

After opening the app, setup only takes two steps:

### 1. Configure Your AI Model

Enter the Claude Code-compatible model and API configuration, such as model name, API key, and base URL.

### 2. Connect Your Account

Connect the platform account you want to operate (Xiaohongshu / WeChat Official Account), then start using GrowthForce.

### Start Operating

Just tell the AI what you want to do:

> "Research the latest Xiaohongshu trends about AI tools and give me 3 topic ideas"

> "Write a Xiaohongshu post based on the second topic, keep it casual with engagement hooks"

> "Publish to my Xiaohongshu account, schedule for 6pm tomorrow"

> "How did last week's content perform? Which post did best?"

---

## Product Screenshots

![GrowthForce home conversation workspace](https://cdn.jsdelivr.net/gh/veloforce/GrowthForce@main/docs/image/home.png)

![GrowthForce content publishing conversation](https://cdn.jsdelivr.net/gh/veloforce/GrowthForce@main/docs/image/chat.png)

![GrowthForce connector settings](https://cdn.jsdelivr.net/gh/veloforce/GrowthForce@main/docs/image/connector.png)

![GrowthForce plugins and skills management](https://cdn.jsdelivr.net/gh/veloforce/GrowthForce@main/docs/image/skill.jpg)

![GrowthForce automation task configuration](https://cdn.jsdelivr.net/gh/veloforce/GrowthForce@main/docs/image/automation.png)

---

## Feature Overview

| Stage | Capability | Status |
|-------|-----------|--------|
| Account Positioning | Multi-account management, persona, strategy differentiation | ✅ |
| Trend Research | Platform trend tracking, competitor analysis, actionable angles | ✅ |
| Content Creation | Xiaohongshu posts, WeChat long-form articles, multi-platform adaptation | ✅ |
| Visual Packaging | Cover copy, image direction, layout optimization | ✅ |
| Publish Management | One-click publish, scheduled publish, multi-account distribution | ✅ |
| Data Collection | Auto-scheduled collection of reads/likes/saves/comments | ✅ |
| AI Review | Performance attribution, pattern recognition, playbook accumulation | ✅ |
| Engagement Ops | Comment replies, likes, saves | ✅ |
| Automation Tasks | Scheduled collection, scheduled review, scheduled publishing | ✅ |
| WeChat Connector | Draft box push, article formatting | ✅ |
| Xiaohongshu Connector | Post publishing, data collection, engagement | ✅ |

---

## Architecture

```
GrowthForce Desktop
├─ Renderer          UI · Conversation workspace · Task management
├─ Main Process      Windows · Sessions · Data · Scheduling
├─ Agent Runtime     AI Agent execution · Skill orchestration
│   ├─ Skills        Research / Creation / Publishing / Collection / Review
│   └─ Tools         File · Image · Browser · Automation · Data
└─ Connectors        Xiaohongshu · WeChat (extensible)
```

**Design Principles:**
- **Local-first** — Data stored locally, privacy under your control
- **Agent architecture** — Three-layer decoupling: Agent understands goals → Skill defines SOP → Tool executes atomic operations
- **Human-in-the-loop** — External publishing and engagement require user confirmation, suitable for teams that need quality control

---

## Vision & Collaboration

### Our Vision

**Give every content creator their own AI operations team.**

Content operations shouldn't be repetitive labor. Research, writing, publishing, reviewing data, summarizing learnings — 80% of this work can be handled by AI Agents, while creators focus on decisions and quality control.

GrowthForce aims to become the infrastructure for content operations: open-source, extensible, community-driven.

### Collaboration Opportunities

We welcome collaboration in the following areas: youzai8913@gmail.com

| Area | Description |
|------|-------------|
| **Platform Connectors** | Integrate more content platforms (Douyin, Bilibili, Twitter/X, LinkedIn, etc.) |
| **Skill Contributions** | Contribute domain-specific operations methodologies (e-commerce, knowledge products, local business, etc.) |
| **AI Enhancement** | Better content understanding, data analysis, trend prediction |
| **Business Partnerships** | MCN agencies, operations service providers, SaaS platform integrations |
| **Internationalization** | Multi-language support, international platform adaptation |

### Why Open Source

- Content operations methodologies should be co-built and shared, not locked inside a single product
- Open source lets users audit Agent behavior, ensuring transparency and control
- Community-contributed connectors and Skills benefit all users

---

## Development

```bash
# Clone the repo
git clone https://github.com/veloforce/GrowthForce.git
cd GrowthForce

# Install dependencies
npm install

# Start dev environment
npm run dev


# Build
npm run build

# Package
npm run package:mac        # macOS universal
npm run package:mac:arm64  # Apple Silicon
npm run package:win        # Windows
```

### Project Structure

```
src/
├── main/          Electron main process
├── renderer/      React renderer process
├── agent/         Agent runtime
├── preload/       Preload scripts
└── shared/        Shared types and utilities

resources/
├── agents/        Agent definitions
├── skills/        Skill definitions (SOP and orchestration)
├── tools/         Tool implementations (atomic capabilities)
├── connectors/    Platform connectors
└── prompts/       Prompt templates
```

### Tech Stack

- **Desktop Framework**: Electron
- **Frontend**: React + Vite + TypeScript
- **AI Runtime**: Claude Agent SDK
- **Data Storage**: sql.js (SQLite in WASM)
- **Automation**: Built-in browser engine + CDP
- **Platform Connection**: Python sidecar (Xiaohongshu)

---

## Roadmap

- [ ] More platform connectors (Douyin, Bilibili)
- [ ] Multi-account parallel operations dashboard
- [ ] Content calendar and scheduling visualization
- [ ] Skill marketplace (community-contributed operations methodologies)
- [ ] Team collaboration mode
- [ ] Mobile companion app (approval, quick publish)

---

## License

[Apache License 2.0](./LICENSE)

---

<p align="center">
  <strong>Turn content operations from repetitive labor into creative decision-making with AI.</strong>
</p>

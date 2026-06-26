# GrowthForce

> 中文版: [README.md](./README.md)

GrowthForce is a local-first AI content operations workspace for creators, content teams, and partners who want to use AI to improve content production, publishing workflows, and performance review.

It is not just a writing assistant, and it is not a single-purpose automation script. GrowthForce turns content operations into an extensible Agent workflow: research, topic strategy, content creation, platform adaptation, publishing assistance, data collection, and long-term learning.

## Core Capabilities

- **Research and topic strategy**: Use account positioning, trends, competitors, and user materials to generate platform-aware content directions.
- **Multi-platform content production**: Support workflows for Xiaohongshu, WeChat Official Accounts, and similar content platforms, including drafts, publishing packages, cover ideas, image directions, and platform-specific formatting.
- **Operational learning loop**: Build a repeatable loop around `profile → content production → data collection → review`, so historical performance and user preferences can become reusable playbooks.
- **Human-in-the-loop publishing**: Keep external publishing and real interaction actions reviewable and user-confirmed, which is important for stable operational workflows.
- **Local-first workspace**: Keep user materials, settings, conversations, and runtime data on the local machine by default.
- **Extensible Agent architecture**: Use Skills, Tools, and Connectors to extend new platforms, operational stages, and team-specific workflows.

## Who It Is For

- Individual creators who want AI to support daily content operations.
- Content teams producing Xiaohongshu, WeChat Official Account, or similar platform content.
- Partners exploring AI Agent workflows, content automation, and review systems.
- Teams that need a desktop workspace for materials, conversations, tasks, and platform workflows.

## What Makes GrowthForce Different

### From Content Generation To Operational Loops

Most AI writing tools stop at one-off output. GrowthForce focuses on the full content operations loop: research, creation, publishing assistance, collection, review, and reusable learning. Each content run can become context for the next one.

### From Chat To Executable Workspace

GrowthForce packages Agents, browser capabilities, platform connectors, local data, and scheduled tasks into one desktop application. Users can prepare content, adapt it for platforms, and review performance in the same workspace.

### From Fixed Flow To Extensible Capability System

GrowthForce organizes capabilities into three layers:

- **Agent**: Understands user goals and coordinates work.
- **Skill**: Defines the SOP, boundaries, and collaboration rules for each stage.
- **Tool / Connector**: Provides atomic capabilities and platform workflow integration.

This structure lets GrowthForce keep the core experience stable while gradually adding more platforms, internal tools, and operational methods.

## Architecture Overview

GrowthForce is a cross-platform desktop application with a local-first multi-process architecture:

```text
Desktop App
├─ Renderer: UI, conversation workspace, tasks, and result display
├─ Main Process: windows, sessions, data, scheduling, and platform runtimes
├─ Agent Process: AI Agent execution, Skill orchestration, and tool calls
├─ Skills: research, creation, publishing, collection, review, and other stages
├─ Tools: file, content analysis, image, browser, automation, and other atomic capabilities
└─ Connectors: platform workflows such as Xiaohongshu and WeChat Official Accounts
```

The goal is to keep long-running work from blocking the desktop app while maintaining clear boundaries between platform capabilities, content capabilities, and local data.

## Platforms And Distribution

GrowthForce targets:

- macOS
- Windows

Installers can be distributed through a public Release page. If the source code is not public, a separate public release repository is recommended for installers, changelogs, and product documentation instead of exposing a private source repository.

Platform capabilities may evolve by version. Refer to the current release notes for the exact supported feature set.

## Usage Boundaries

GrowthForce is designed to help users operate content more efficiently. It does not replace user judgment about content quality, compliance, or platform rules.

When using GrowthForce:

- Review content before publishing externally.
- Follow the rules of each platform for publishing and interactions.
- Do not use AI to fabricate data, cases, policies, sources, or personal experiences.
- Manage account, material, and configuration data responsibly.

## Current Status

GrowthForce is under active development, with ongoing work focused on:

- A more complete content operations loop.
- More stable platform connectors.
- Stronger Skill extensibility.
- Clearer scheduled task and review workflows.
- A better desktop workspace for individual creators and teams.


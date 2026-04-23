# ⚓ Anchor

**Crash-safe context and file guardian for Google Antigravity IDE**

> *Built for developers where power is unreliable but ambition is not.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-1.75+-orange.svg)](https://rustup.rs)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://typescriptlang.org)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)]()

---

## The Problem

Google Antigravity IDE does not use Write-Ahead Logging (WAL) for its conversation index or file edit operations. If power is interrupted mid-edit — even for a fraction of a second — you lose:

- The conversation you were working in (invisible in sidebar after restart)
- The file being edited by the agent (partial write, corrupt state)
- All context built up during the session

This is not a user error. It is an architectural gap in a paid product. Anchor fills it.

---

## What Anchor Does

Anchor intercepts **only the broken storage layer** of Antigravity. It does not touch AI models (Gemini, Claude, GPT), agents, or any other functionality.

```
Without Anchor:
  Agent edits 300 lines → power cut → file corrupt → conversation gone

With Anchor:
  Agent edits 300 lines → WAL logs before state → power cut
  → Power returns → Anchor replays WAL → file restored → conversation restored
  → Sidebar shows all conversations → you continue where you left off
```

### Protection at Every Layer

| Layer | What Anchor Does |
|-------|-----------------|
| **File Edits** | WAL snapshot before every agent write via MCP tools |
| **Conversations** | Continuous backup of `.pb` conversation files to SQLite |
| **Sidebar Index** | Rebuilds `state.vscdb` `trajectorySummaries` after crash |
| **Code History** | Auto git commit every 2 minutes + pre-AI-edit snapshots |
| **Agent Behavior** | AGENTS.md skill file makes agent use WAL tools automatically |

---

## Architecture

Anchor is two components that work together:

```
┌─────────────────────────────────────────────────────┐
│                  Antigravity IDE                     │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │           anchor-extension (TypeScript)       │   │
│  │                                              │   │
│  │  • Conversation watcher (.pb files)          │   │
│  │  • File state watcher + auto git commit      │   │
│  │  • .pb decryptor (Linux/Windows/macOS)       │   │
│  │  • state.vscdb repair engine                 │   │
│  │  • MCP auto-registration                     │   │
│  │  • Recovery dashboard (Svelte WebView)       │   │
│  └──────────────┬───────────────────────────────┘   │
│                 │ IPC (Unix socket / Named pipe)     │
└─────────────────┼───────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────┐
│              anchor-core (Rust daemon)               │
│                                                     │
│  • WAL engine (writer / reader / checkpoint)        │
│  • SQLite storage (conversations + snapshots)       │
│  • File system watcher (notify crate)               │
│  • Crash recovery engine                            │
│  • MCP tool server (anchor_write_file etc.)         │
└─────────────────────────────────────────────────────┘
```

**Why two components?**

The Rust daemon runs continuously and owns the WAL. If the extension crashes, the daemon keeps writing. If power cuts, the daemon's SQLite WAL mode ensures no corruption. The extension is stateless — it reconnects and recovers.

---

## MCP Tools

Anchor registers three WAL-protected file tools with Antigravity via MCP. The agent uses these automatically instead of Antigravity's unprotected built-in tools.

### `anchor_write_file`

```
Write content to a file with WAL protection.
Automatically creates a recovery snapshot before writing.
```

Internal sequence on every call:
1. Read current file content → compute SHA256 checksum
2. WAL write: `FileEditBefore { path, content, checksum, edit_id }` → **flush to disk**
3. `fs::write(path, new_content)`
4. WAL write: `FileEditAfter { edit_id, success: true }` → flush
5. SQLite snapshot save

If power cuts between steps 2 and 3: WAL has the before state. Full restore on next boot.

### `anchor_edit_file`

```
Apply targeted old/new string replacement with WAL protection.
Logs only the diff — preferred for large files.
```

### `anchor_read_file`

```
Read a file. WAL-aware — returns latest version including
any in-progress edits not yet checkpointed.
```

---

## Recovery

### Automatic (on every startup)

When Anchor starts, it automatically:

1. Checks if `context_state/` is empty but `.pb` files exist on disk → detects corruption
2. Replays WAL entries for any incomplete file edits → restores pre-edit state
3. Scans all `.pb` files → finds conversations missing from `state.vscdb` index
4. Rebuilds `trajectorySummaries` → injects into `state.vscdb` atomically
5. Shows notification: *"Anchor restored 5 conversation(s) to your sidebar"*

### Manual (Recovery Dashboard)

Open via: `Ctrl+Shift+P` → **Anchor: Show Conversation History**

- Browse all recovered conversations with timestamps
- View pre-AI-edit code snapshots with before/after diff
- Export conversations to Markdown / JSON
- Restore specific file versions

---

## Installation

### Requirements

- Google Antigravity IDE (v1.20.x or later)
- Rust 1.75+ (for building anchor-core)
- Node.js 18+ (for building anchor-extension)

### Install

```bash
# Clone
git clone https://github.com/ZacKXSnydeR/Anchor.git
cd Anchor

# Build everything
./scripts/build.sh        # Linux / macOS
scripts\build.ps1         # Windows

# Install extension in Antigravity
# Extensions → Install from VSIX → anchor-extension/anchor-0.1.0.vsix
```

### First Launch

1. Open any project in Antigravity
2. Extension activates → spawns anchor-core daemon
3. Status bar shows: **Anchor: Protected ✓**
4. Notification: *"Restart Antigravity to activate WAL tools"*
5. Restart → agent now uses `anchor_write_file` automatically

---

## AGENTS.md Integration

Anchor deploys a skill file to your workspace on first install:

```
your-project/
├── AGENTS.md                              ← Anchor safety rules appended here
└── .agents/
    ├── skills/
    │   └── anchor-safe-edit/
    │       └── SKILL.md                   ← Loaded when agent edits files
    └── workflows/
  ├── anchor-checkpoint.md           ← Workflow template for checkpoint steps
  └── anchor-recover.md              ← Workflow template for recovery steps
```

The skill instructs the agent to:
- Use `anchor_write_file` instead of direct writes
- Break large refactors into smaller `anchor_edit_file` calls (max ~100 lines)
- Call `anchor_read_file` during active editing sessions

Anchor **appends** to your existing `AGENTS.md` — it never overwrites your content.

---

## Repository Structure

```
anchor/
├── anchor-core/                    Rust daemon (~2,800 LOC)
│   └── src/
│       ├── main.rs                 Entry point, --mcp-mode / --daemon routing
│       ├── wal/                    Write-Ahead Log engine
│       │   ├── writer.rs           Atomic WAL writes with SHA256 checksums
│       │   ├── reader.rs           WAL replay and verification
│       │   └── checkpoint.rs       WAL → SQLite compaction
│       ├── storage/                SQLite persistence
│       │   ├── db.rs               conversations + snapshots tables
│       │   └── snapshot.rs         File snapshot management
│       ├── watcher/
│       │   └── fs.rs               notify crate, 500ms debounce
│       ├── recovery/
│       │   └── engine.rs           Crash detection + index rebuild
│       ├── tools/                  MCP tool server
│       │   ├── mcp_server.rs       JSON-RPC stdio server
│       │   ├── write_file.rs       WAL-protected write
│       │   ├── edit_file.rs        WAL-protected diff edit
│       │   ├── read_file.rs        WAL-aware read
│       │   └── tool_registry.rs    Tool JSON schemas
│       └── api/
│           └── ipc.rs              Unix socket / named pipe server
│
├── anchor-extension/               TypeScript extension (~3,500 LOC)
│   └── src/
│       ├── extension.ts            Activation, daemon spawn, startup sequence
│       ├── cdp/bridge.ts           CDP connection to Antigravity LS API
│       ├── watchers/               File system watchers
│       │   ├── conversation.ts     .pb file watcher
│       │   └── filestate.ts        Editor buffer + heartbeat
│       ├── git/autocommit.ts       2-min auto commits + pre-edit snapshots
│       ├── ipc/daemon-client.ts    IPC client with exponential backoff
│       ├── mcp/registrar.ts        mcp_config.json auto-registration
│       ├── recovery/
│       │   ├── pb-decryptor.ts     Cross-platform .pb decryption
│       │   ├── pb-reader.ts        Protobuf wire walking + content extraction
│       │   ├── state-repair.ts     state.vscdb index rebuilder
│       │   └── restore-ui.ts       Recovery WebView controller
│       └── ui/
│           ├── statusbar.ts        "Anchor: Protected ✓" status bar
│           └── panel.ts            Sidebar conversation history
│
├── anchor-ui/                      Svelte recovery dashboard (~800 LOC)
│   └── src/
│       ├── App.svelte
│       ├── ConversationList.svelte
│       ├── SnapshotBrowser.svelte
│       └── RecoveryWizard.svelte
│
└── docs/
    ├── architecture.md
    └── ipc-protocol.md
```

---

## Privacy

Anchor is **100% local**. It makes no network requests.

| Anchor does NOT | Anchor ONLY |
|-----------------|-------------|
| Send data to external servers | Watch filesystem events for `.pb` and `context_state/` files |
| Log conversation content | Save conversation metadata (timestamps, IDs) to local SQLite |
| Modify AI model behavior | Create local git commits in your workspace |
| Intercept API calls | Rebuild broken index files from existing `.pb` files |
| Require cloud accounts | Run entirely on your machine |

Conversation content is accessed only when you explicitly trigger recovery and only to rebuild the sidebar index. Nothing leaves your machine.

---

## Platform Support

| Platform | Daemon | Extension | .pb Decryption | Status |
|----------|--------|-----------|----------------|--------|
| Windows 11/10 | ✅ Named pipe | ✅ | DPAPI | Supported |
| macOS 13+ | ✅ Unix socket | ✅ | Keychain | Supported |
| Linux (with secret store) | ✅ Unix socket | ✅ | gnome-libsecret / kwallet | Supported |
| Linux (no secret store) | ✅ Unix socket | ✅ | basic_text fallback | **Best support** |

> **Linux note:** Most Linux installs without a desktop keychain use Electron's `basic_text` fallback — meaning `.pb` files are not truly encrypted. Anchor achieves ~95% conversation recovery on these systems.

---

## Commands

| Command | Description |
|---------|-------------|
| `Anchor: Recover Lost Conversations` | Run full recovery scan + sidebar repair |
| `Anchor: Show Conversation History` | Open recovery dashboard |
| `Anchor: Export Current Conversation` | Save active conversation to Markdown |
| `Anchor: Verify MCP Tools` | Confirm agent is using WAL-protected tools |
| `Anchor: Unregister MCP Tools` | Remove Anchor MCP registration from Antigravity config |
| `Anchor: Repair Sidebar Index` | Rebuild missing `trajectorySummaries` entries from `.pb` files |

---

## Building from Source

```bash
# Rust daemon
cd anchor-core
cargo build --release
cargo test

# TypeScript extension
cd anchor-extension
npm install
npm run compile
npm test

# Svelte UI
cd anchor-ui
npm install
npm run build

# Package extension (.vsix)
cd anchor-extension
npm run package
```

---

## Contributing

Anchor was built to solve a real problem affecting developers across Bangladesh, India, Africa, and anywhere power infrastructure is unreliable. Contributions are welcome.

**High-priority areas:**
- Windows DPAPI decryption improvements
- Protobuf schema reverse engineering for higher-fidelity `.pb` parsing
- macOS Keychain access from extension host context
- Performance: WAL checkpoint tuning for large workspaces

Please open an issue before starting large changes.

---

## Why Anchor Exists

Google Antigravity's developers work in Silicon Valley offices with UPS-protected infrastructure and MacBooks with built-in batteries. Power interruption is not in their test matrix.

For developers in the rest of the world — where a karent (power cut) can happen at any moment mid-refactor — this gap is not theoretical. It is a daily source of lost work.

VS Code solves this with WAL. Antigravity does not, yet. Anchor fills the gap until they do.

---

## License

MIT — free to use, modify, and distribute.

---

*⚓ Keep your work grounded, no matter what.*
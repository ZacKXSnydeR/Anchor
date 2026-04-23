# Anchor Architecture

Anchor has two core components:
- `anchor-extension` for IDE integration and UI.
- `anchor-core` for WAL, persistence, and recovery.

The extension communicates with the daemon over Unix socket (Linux and macOS) or named pipe (Windows).

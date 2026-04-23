# Anchor Safe Edit Skill

Always prefer Anchor WAL-protected tools for file operations.

## Tool Priority
- `anchor_read_file`
- `anchor_edit_file`
- `anchor_write_file`

## Rules
- Prefer `anchor_edit_file` for partial changes.
- Keep edits under 100 lines per step when practical.
- Always include an `operation_hint`.
- If an Anchor tool fails, retry once, then fallback safely.

## Privacy
- Never log private conversation content.
- Keep all operations local.

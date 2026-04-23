use serde_json::{json, Value};

pub fn list_tools_result() -> Value {
    json!({
        "tools": [
            {
                "name": "anchor_read_file",
                "description": "Read a file from the workspace. WAL-aware - returns latest content including in-progress edits.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute or workspace-relative file path"
                        },
                        "encoding": {
                            "type": "string",
                            "enum": ["utf8", "base64"],
                            "default": "utf8"
                        }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "anchor_write_file",
                "description": "Write content to a file with WAL protection. Creates a recovery snapshot before writing.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File path to write"
                        },
                        "content": {
                            "type": "string",
                            "description": "New file content"
                        },
                        "operation_hint": {
                            "type": "string",
                            "description": "Brief description of the edit",
                            "default": "agent_edit"
                        }
                    },
                    "required": ["path", "content"]
                }
            },
            {
                "name": "anchor_edit_file",
                "description": "Apply targeted old/new replacement with WAL protection. Preferred for partial edits.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "old_str": {
                            "type": "string",
                            "description": "Exact string to replace"
                        },
                        "new_str": {
                            "type": "string",
                            "description": "Replacement string"
                        },
                        "operation_hint": {
                            "type": "string",
                            "default": "agent_edit"
                        }
                    },
                    "required": ["path", "old_str", "new_str"]
                }
            }
        ]
    })
}

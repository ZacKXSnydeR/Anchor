use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::daemon_client::call_daemon;
use crate::tools::{resolve_tool_path, ToolResult};

#[derive(Deserialize)]
struct EditFileParams {
    path: String,
    old_str: String,
    new_str: String,
    #[serde(default = "default_operation_hint")]
    operation_hint: String,
}

fn default_operation_hint() -> String {
    "agent_edit".to_string()
}

pub async fn handle(params: Value, workspace: &Option<PathBuf>) -> ToolResult<Value> {
    let parsed: EditFileParams = serde_json::from_value(params)?;
    let resolved = resolve_tool_path(&parsed.path, workspace)?;

    let daemon_payload = call_daemon(&json!({
        "type": "EditFile",
        "payload": {
            "path": resolved.to_string_lossy().to_string(),
            "old_str": parsed.old_str,
            "new_str": parsed.new_str,
            "operation_hint": parsed.operation_hint
        }
    }))
    .await?;

    let message = daemon_payload
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Edited successfully. Snapshot saved.");

    Ok(json!({
        "content": [{
            "type": "text",
            "text": message
        }]
    }))
}

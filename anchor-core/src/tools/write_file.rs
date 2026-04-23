use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::daemon_client::call_daemon;
use crate::tools::{resolve_tool_path, ToolResult};

#[derive(Deserialize)]
struct WriteFileParams {
    path: String,
    content: String,
    #[serde(default = "default_operation_hint")]
    operation_hint: String,
}

fn default_operation_hint() -> String {
    "agent_edit".to_string()
}

pub async fn handle(params: Value, workspace: &Option<PathBuf>) -> ToolResult<Value> {
    let parsed: WriteFileParams = serde_json::from_value(params)?;
    let resolved = resolve_tool_path(&parsed.path, workspace)?;

    let daemon_payload = call_daemon(&json!({
        "type": "WriteFile",
        "payload": {
            "path": resolved.to_string_lossy().to_string(),
            "content": parsed.content,
            "operation_hint": parsed.operation_hint
        }
    }))
    .await?;

    let message = daemon_payload
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Written successfully. Snapshot saved.");

    Ok(json!({
        "content": [{
            "type": "text",
            "text": message
        }]
    }))
}

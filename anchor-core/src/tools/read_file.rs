use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::daemon_client::call_daemon;
use crate::tools::{resolve_tool_path, ToolResult};

#[derive(Deserialize)]
struct ReadFileParams {
    path: String,
    #[serde(default = "default_encoding")]
    encoding: String,
}

fn default_encoding() -> String {
    "utf8".to_string()
}

pub async fn handle(params: Value, workspace: &Option<PathBuf>) -> ToolResult<Value> {
    let parsed: ReadFileParams = serde_json::from_value(params)?;
    if parsed.encoding != "utf8" && parsed.encoding != "base64" {
        return Err(format!("Unsupported encoding '{}'", parsed.encoding).into());
    }

    let resolved = resolve_tool_path(&parsed.path, workspace)?;
    let daemon_payload = call_daemon(&json!({
        "type": "ReadFile",
        "payload": {
            "path": resolved.to_string_lossy().to_string(),
            "encoding": parsed.encoding
        }
    }))
    .await?;

    let text = daemon_payload
        .get("content")
        .and_then(Value::as_str)
        .ok_or("Read response missing content")?;

    Ok(json!({
        "content": [{
            "type": "text",
            "text": text
        }]
    }))
}

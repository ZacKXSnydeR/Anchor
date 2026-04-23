use std::path::PathBuf;

use log::error;
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::tools::{edit_file, read_file, tool_registry, write_file, ToolResult};

#[derive(Clone)]
pub struct AnchorMcpServer {
    workspace: Option<PathBuf>,
}

#[derive(Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

#[derive(Deserialize)]
struct ToolCallParams {
    name: String,
    #[serde(default)]
    arguments: Value,
}

impl AnchorMcpServer {
    pub fn new(workspace: Option<PathBuf>) -> Self {
        Self { workspace }
    }

    pub async fn run(&self) -> ToolResult<()> {
        let stdin = tokio::io::stdin();
        let mut lines = BufReader::new(stdin).lines();
        let mut stdout = tokio::io::stdout();

        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }

            let response = match serde_json::from_str::<JsonRpcRequest>(&line) {
                Ok(request) => self.handle_request(request).await,
                Err(err) => JsonRpcResponse::error(
                    Value::Null,
                    -32700,
                    format!("Invalid JSON-RPC request: {}", err),
                ),
            };

            let serialized = serde_json::to_string(&response)?;
            stdout.write_all(serialized.as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }

        Ok(())
    }

    pub async fn run_test(&self) -> ToolResult<()> {
        let mut stdout = tokio::io::stdout();
        let response = JsonRpcResponse::success(json!(1), self.initialize_result());
        let serialized = serde_json::to_string(&response)?;
        stdout.write_all(serialized.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
        Ok(())
    }

    async fn handle_request(&self, request: JsonRpcRequest) -> JsonRpcResponse {
        let id = request.id.unwrap_or(Value::Null);

        let result = match request.method.as_str() {
            "initialize" => Ok(self.initialize_result()),
            "tools/list" => Ok(tool_registry::list_tools_result()),
            "tools/call" => self.handle_tool_call(request.params).await,
            other => Err(JsonRpcError {
                code: -32601,
                message: format!("Unsupported MCP method: {}", other),
            }),
        };

        match result {
            Ok(value) => JsonRpcResponse::success(id, value),
            Err(err) => {
                error!("MCP request failed: {}", err.message);
                JsonRpcResponse::error(id, err.code, err.message)
            }
        }
    }

    fn initialize_result(&self) -> Value {
        json!({
            "protocolVersion": "2024-11-05",
            "serverInfo": {
                "name": "anchor",
                "version": "0.1.0"
            },
            "capabilities": {
                "tools": {}
            }
        })
    }

    async fn handle_tool_call(&self, params: Option<Value>) -> Result<Value, JsonRpcError> {
        let payload = params.ok_or_else(|| JsonRpcError {
            code: -32602,
            message: "tools/call requires params".to_string(),
        })?;

        let parsed: ToolCallParams =
            serde_json::from_value(payload).map_err(|err| JsonRpcError {
                code: -32602,
                message: format!("Invalid tools/call params: {}", err),
            })?;

        let tool_result = match parsed.name.as_str() {
            "anchor_read_file" => read_file::handle(parsed.arguments, &self.workspace).await,
            "anchor_write_file" => write_file::handle(parsed.arguments, &self.workspace).await,
            "anchor_edit_file" => edit_file::handle(parsed.arguments, &self.workspace).await,
            _ => {
                return Err(JsonRpcError {
                    code: -32601,
                    message: format!("Unknown tool: {}", parsed.name),
                })
            }
        };

        tool_result.map_err(|err| JsonRpcError {
            code: -32000,
            message: err.to_string(),
        })
    }
}

impl JsonRpcResponse {
    fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Value, code: i64, message: String) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError { code, message }),
        }
    }
}

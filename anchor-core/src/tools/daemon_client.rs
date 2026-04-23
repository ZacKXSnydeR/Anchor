use std::io;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::tools::ToolResult;

#[cfg(windows)]
use tokio::net::windows::named_pipe::ClientOptions;
#[cfg(unix)]
use tokio::net::UnixStream;

pub async fn call_daemon(message: &Value) -> ToolResult<Value> {
    #[cfg(unix)]
    {
        let mut stream = UnixStream::connect("/tmp/anchor.sock")
            .await
            .map_err(|err| {
                io::Error::new(
                    err.kind(),
                    format!("Could not connect to Anchor daemon socket: {}", err),
                )
            })?;

        let serialized = serde_json::to_string(message)?;
        stream.write_all(serialized.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        stream.flush().await?;

        let mut lines = BufReader::new(stream).lines();
        let line = lines.next_line().await?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Daemon closed socket before sending a response",
            )
        })?;

        return parse_response(&line);
    }

    #[cfg(windows)]
    {
        let mut stream = ClientOptions::new()
            .open(r"\\.\pipe\anchor")
            .map_err(|err| {
                io::Error::new(
                    err.kind(),
                    format!("Could not connect to Anchor daemon pipe: {}", err),
                )
            })?;

        let serialized = serde_json::to_string(message)?;
        stream.write_all(serialized.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        stream.flush().await?;

        let mut lines = BufReader::new(stream).lines();
        let line = lines.next_line().await?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Daemon closed pipe before sending a response",
            )
        })?;

        return parse_response(&line);
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = message;
        Err(io::Error::new(io::ErrorKind::Unsupported, "Unsupported operating system").into())
    }
}

fn parse_response(line: &str) -> ToolResult<Value> {
    let response: Value = serde_json::from_str(line)?;
    let response_type = response
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Daemon response is missing type",
            )
        })?;

    match response_type {
        "Data" => Ok(response.get("payload").cloned().unwrap_or(Value::Null)),
        "Ok" | "Pong" => Ok(Value::Null),
        "Error" => {
            let message = response
                .get("payload")
                .and_then(Value::as_str)
                .unwrap_or("Daemon returned an unknown error");
            Err(io::Error::other(message.to_string()).into())
        }
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Unexpected daemon response type: {}", other),
        )
        .into()),
    }
}

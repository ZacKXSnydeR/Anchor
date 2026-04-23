use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::Utc;
use log::{error, info};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::broadcast;
use uuid::Uuid;

#[cfg(windows)]
use tokio::net::windows::named_pipe::ServerOptions;
#[cfg(unix)]
use tokio::net::UnixListener;

use crate::recovery::engine::RecoveryEngine;
use crate::storage::db::AnchorDb;
use crate::storage::snapshot::Snapshot;
use crate::wal::reader::WalReader;
use crate::wal::writer::{
    checksum_for_payload, WalEntry, WalEntryType, WalWriter, WAL_TABLE_SCHEMA,
};

type IpcResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum Message {
    Ping,
    SaveConversation {
        conversation_id: String,
        data: Value,
    },
    SaveSnapshot {
        snapshot_id: String,
        conversation_id: Option<String>,
        data: Value,
    },
    GetConversations,
    Recover {
        conversation_id: String,
    },
    RunStateRepair,
    ReadFile {
        path: String,
        encoding: Option<String>,
    },
    WriteFile {
        path: String,
        content: String,
        operation_hint: Option<String>,
    },
    EditFile {
        path: String,
        old_str: String,
        new_str: String,
        operation_hint: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", content = "payload")]
pub enum Response {
    Pong,
    Ok,
    Error(String),
    Data(Value),
}

pub struct IpcServer {
    db_path: PathBuf,
    #[cfg(unix)]
    socket_path: PathBuf,
    #[cfg(windows)]
    pipe_name: String,
}

impl IpcServer {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            #[cfg(unix)]
            socket_path: PathBuf::from("/tmp/anchor.sock"),
            #[cfg(windows)]
            pipe_name: String::from(r"\\.\pipe\anchor"),
        }
    }

    pub async fn run(&self, shutdown: broadcast::Receiver<()>) -> IpcResult<()> {
        #[cfg(unix)]
        {
            return self.run_unix(shutdown).await;
        }

        #[cfg(windows)]
        {
            return self.run_windows(shutdown).await;
        }

        #[cfg(not(any(unix, windows)))]
        {
            let _ = shutdown;
            Err(io::Error::new(io::ErrorKind::Unsupported, "Unsupported operating system").into())
        }
    }

    #[cfg(unix)]
    async fn run_unix(&self, mut shutdown: broadcast::Receiver<()>) -> IpcResult<()> {
        if self.socket_path.exists() {
            match fs::remove_file(&self.socket_path) {
                Ok(()) => info!("Removed stale socket at {}", self.socket_path.display()),
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(Box::new(err)),
            }
        }

        let listener = UnixListener::bind(&self.socket_path)?;
        info!(
            "IPC listening on Unix socket {}",
            self.socket_path.display()
        );

        loop {
            tokio::select! {
                _ = shutdown.recv() => {
                    info!("Unix socket server shutdown requested");
                    break;
                }
                accept_result = listener.accept() => {
                    let (stream, _) = accept_result?;
                    info!("IPC client connected over Unix socket");

                    if let Err(err) = self.handle_client(stream).await {
                        error!("Unix socket client handler failed: {}", err);
                    }
                }
            }
        }

        if self.socket_path.exists() {
            if let Err(err) = fs::remove_file(&self.socket_path) {
                error!(
                    "Failed to remove Unix socket file {}: {}",
                    self.socket_path.display(),
                    err
                );
            }
        }

        Ok(())
    }

    #[cfg(windows)]
    async fn run_windows(&self, mut shutdown: broadcast::Receiver<()>) -> IpcResult<()> {
        info!("IPC listening on named pipe {}", self.pipe_name);

        loop {
            let pipe = ServerOptions::new().create(&self.pipe_name)?;

            tokio::select! {
                _ = shutdown.recv() => {
                    info!("Named pipe server shutdown requested");
                    break;
                }
                connect_result = pipe.connect() => {
                    connect_result?;
                    info!("IPC client connected over named pipe");

                    if let Err(err) = self.handle_client(pipe).await {
                        error!("Named pipe client handler failed: {}", err);
                    }
                }
            }
        }

        Ok(())
    }

    async fn handle_client<T>(&self, stream: T) -> IpcResult<()>
    where
        T: AsyncRead + AsyncWrite + Unpin,
    {
        let (reader, mut writer) = tokio::io::split(stream);
        let mut lines = BufReader::new(reader).lines();

        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }

            let message = match serde_json::from_str::<Message>(&line) {
                Ok(msg) => msg,
                Err(err) => {
                    let response = Response::Error(format!("Invalid JSON message: {}", err));
                    write_response(&mut writer, &response).await?;
                    continue;
                }
            };

            info!("Received message: {:?}", message);

            let response = match handle_message(&self.db_path, message) {
                Ok(response) => response,
                Err(err) => Response::Error(err.to_string()),
            };

            write_response(&mut writer, &response).await?;
        }

        Ok(())
    }
}

pub fn handle_message(db_path: &Path, message: Message) -> IpcResult<Response> {
    match message {
        Message::Ping => Ok(Response::Pong),
        Message::SaveConversation {
            conversation_id,
            data,
        } => {
            save_conversation(db_path, &conversation_id, &data)?;
            Ok(Response::Ok)
        }
        Message::SaveSnapshot {
            snapshot_id,
            conversation_id,
            data,
        } => {
            save_snapshot(db_path, &snapshot_id, conversation_id.as_deref(), &data)?;
            Ok(Response::Ok)
        }
        Message::GetConversations => {
            let payload = get_conversations(db_path)?;
            Ok(Response::Data(payload))
        }
        Message::Recover { conversation_id } => {
            let payload = recover_conversation(db_path, &conversation_id)?;
            Ok(Response::Data(payload))
        }
        Message::RunStateRepair => {
            let engine = RecoveryEngine::new(db_path.to_path_buf())?;
            let report = engine.check_and_recover()?;
            Ok(Response::Data(serde_json::to_value(report)?))
        }
        Message::ReadFile { path, encoding } => {
            let payload =
                read_file_with_wal(db_path, &path, encoding.as_deref().unwrap_or("utf8"))?;
            Ok(Response::Data(payload))
        }
        Message::WriteFile {
            path,
            content,
            operation_hint,
        } => {
            let payload = write_file_with_wal(
                db_path,
                &path,
                &content,
                operation_hint.as_deref().unwrap_or("agent_edit"),
            )?;
            Ok(Response::Data(payload))
        }
        Message::EditFile {
            path,
            old_str,
            new_str,
            operation_hint,
        } => {
            let payload = edit_file_with_wal(
                db_path,
                &path,
                &old_str,
                &new_str,
                operation_hint.as_deref().unwrap_or("agent_edit"),
            )?;
            Ok(Response::Data(payload))
        }
    }
}

async fn write_response<T>(writer: &mut T, response: &Response) -> IpcResult<()>
where
    T: AsyncWrite + Unpin,
{
    let serialized = serde_json::to_string(response)?;
    writer.write_all(serialized.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}

fn open_connection(db_path: &Path) -> IpcResult<Connection> {
    let connection = Connection::open(db_path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS snapshots (
            id TEXT PRIMARY KEY,
            conversation_id TEXT,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(conversation_id) REFERENCES conversations(id)
        );
        ",
    )?;

    Ok(connection)
}

fn save_conversation(db_path: &Path, conversation_id: &str, data: &Value) -> IpcResult<()> {
    let connection = open_connection(db_path)?;
    let payload = serde_json::to_string(data)?;

    connection.execute(
        "
        INSERT INTO conversations (id, payload, updated_at)
        VALUES (?1, ?2, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            payload = excluded.payload,
            updated_at = CURRENT_TIMESTAMP
        ",
        params![conversation_id, payload],
    )?;

    Ok(())
}

fn save_snapshot(
    db_path: &Path,
    snapshot_id: &str,
    conversation_id: Option<&str>,
    data: &Value,
) -> IpcResult<()> {
    let connection = open_connection(db_path)?;
    let payload = serde_json::to_string(data)?;

    connection.execute(
        "
        INSERT INTO snapshots (id, conversation_id, payload, created_at)
        VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            payload = excluded.payload,
            created_at = CURRENT_TIMESTAMP
        ",
        params![snapshot_id, conversation_id, payload],
    )?;

    Ok(())
}

fn get_conversations(db_path: &Path) -> IpcResult<Value> {
    let connection = open_connection(db_path)?;
    let mut statement = connection.prepare(
        "
        SELECT id, payload, updated_at
        FROM conversations
        ORDER BY updated_at DESC
        ",
    )?;

    let rows = statement.query_map([], |row| {
        let id: String = row.get(0)?;
        let payload_raw: String = row.get(1)?;
        let updated_at: String = row.get(2)?;
        Ok((id, payload_raw, updated_at))
    })?;

    let mut items = Vec::new();
    for row in rows {
        let (id, payload_raw, updated_at) = row?;
        let payload = match serde_json::from_str::<Value>(&payload_raw) {
            Ok(value) => value,
            Err(_) => Value::String(payload_raw),
        };

        items.push(json!({
            "id": id,
            "payload": payload,
            "updated_at": updated_at,
        }));
    }

    Ok(Value::Array(items))
}

fn recover_conversation(db_path: &Path, conversation_id: &str) -> IpcResult<Value> {
    let connection = open_connection(db_path)?;

    let conversation_payload: Option<String> = connection
        .query_row(
            "SELECT payload FROM conversations WHERE id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )
        .optional()?;

    let conversation = match conversation_payload {
        Some(payload_raw) => Some(match serde_json::from_str::<Value>(&payload_raw) {
            Ok(value) => value,
            Err(_) => Value::String(payload_raw),
        }),
        None => None,
    };

    let mut statement = connection.prepare(
        "
        SELECT id, payload, created_at
        FROM snapshots
        WHERE conversation_id = ?1
        ORDER BY created_at DESC
        ",
    )?;

    let rows = statement.query_map(params![conversation_id], |row| {
        let snapshot_id: String = row.get(0)?;
        let payload_raw: String = row.get(1)?;
        let created_at: String = row.get(2)?;
        Ok((snapshot_id, payload_raw, created_at))
    })?;

    let mut snapshots = Vec::new();
    for row in rows {
        let (snapshot_id, payload_raw, created_at) = row?;
        let payload = match serde_json::from_str::<Value>(&payload_raw) {
            Ok(value) => value,
            Err(_) => Value::String(payload_raw),
        };

        snapshots.push(json!({
            "id": snapshot_id,
            "payload": payload,
            "created_at": created_at,
        }));
    }

    Ok(json!({
        "conversation_id": conversation_id,
        "conversation": conversation,
        "snapshots": snapshots,
    }))
}

fn read_file_with_wal(db_path: &Path, path: &str, encoding: &str) -> IpcResult<Value> {
    let resolved_path = PathBuf::from(path);
    let path_text = resolved_path.to_string_lossy().to_string();

    let content = match latest_uncommitted_before_content(db_path, &path_text)? {
        Some(value) => value,
        None => read_text_with_not_found_empty(&resolved_path)?,
    };

    let encoded = match encoding {
        "utf8" => content,
        "base64" => BASE64_STANDARD.encode(content.as_bytes()),
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("Unsupported encoding '{}' for read file", encoding),
            )
            .into())
        }
    };

    Ok(json!({
        "path": path_text,
        "encoding": encoding,
        "content": encoded
    }))
}

fn write_file_with_wal(
    db_path: &Path,
    path: &str,
    content: &str,
    operation_hint: &str,
) -> IpcResult<Value> {
    let resolved_path = PathBuf::from(path);
    let path_text = resolved_path.to_string_lossy().to_string();
    let before_content = read_text_with_not_found_empty(&resolved_path)?;
    let before_checksum = checksum_for_payload(&before_content);
    let edit_id = Uuid::new_v4().to_string();
    let timestamp = Utc::now().timestamp_millis();

    let mut writer = WalWriter::from_path(db_path)?;
    let before_entry_id = next_wal_entry_id(db_path)?;
    writer.write_entry(WalEntry {
        id: before_entry_id,
        timestamp,
        entry_type: WalEntryType::FileEditBefore,
        payload: json!({
            "path": path_text,
            "content": before_content.clone(),
            "checksum": before_checksum,
            "operation": operation_hint,
            "edit_id": edit_id.clone(),
        }),
    })?;
    writer.flush()?;

    if let Some(parent) = resolved_path.parent() {
        fs::create_dir_all(parent)?;
    }

    if let Err(err) = fs::write(&resolved_path, content.as_bytes()) {
        return Err(io::Error::new(
            err.kind(),
            format!(
                "Write failed - WAL snapshot available for recovery ({})",
                err
            ),
        )
        .into());
    }

    let after_checksum = checksum_for_payload(content);
    writer.write_entry(WalEntry {
        id: before_entry_id + 1,
        timestamp: Utc::now().timestamp_millis(),
        entry_type: WalEntryType::FileEditAfter,
        payload: json!({
            "path": resolved_path.to_string_lossy().to_string(),
            "checksum": after_checksum,
            "edit_id": edit_id.clone(),
            "success": true,
        }),
    })?;
    writer.flush()?;

    let db = AnchorDb::initialize(db_path)?;
    db.save_snapshot(&Snapshot {
        id: format!("snap-{}", Uuid::new_v4()),
        conversation_id: None,
        file_path: resolved_path.to_string_lossy().to_string(),
        content_before: Some(before_content),
        content_after: Some(content.to_string()),
        created_at: Utc::now().timestamp_millis(),
        operation: operation_hint.to_string(),
    })?;

    Ok(json!({
        "message": "Written successfully. Snapshot saved.",
        "path": resolved_path.to_string_lossy().to_string(),
        "edit_id": edit_id
    }))
}

fn edit_file_with_wal(
    db_path: &Path,
    path: &str,
    old_str: &str,
    new_str: &str,
    operation_hint: &str,
) -> IpcResult<Value> {
    let resolved_path = PathBuf::from(path);
    let path_text = resolved_path.to_string_lossy().to_string();
    let before_content = fs::read_to_string(&resolved_path).map_err(|err| {
        io::Error::new(
            err.kind(),
            format!("Could not read UTF-8 content from {}: {}", path_text, err),
        )
    })?;

    let byte_offset = before_content.find(old_str).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "old_str not found in file - file may have changed",
        )
    })?;

    let after_content = before_content.replacen(old_str, new_str, 1);
    let edit_id = Uuid::new_v4().to_string();
    let timestamp = Utc::now().timestamp_millis();

    let mut writer = WalWriter::from_path(db_path)?;
    let before_entry_id = next_wal_entry_id(db_path)?;
    writer.write_entry(WalEntry {
        id: before_entry_id,
        timestamp,
        entry_type: WalEntryType::FileEditBefore,
        payload: json!({
            "path": path_text,
            "before_str": old_str,
            "after_str": new_str,
            "byte_offset": byte_offset,
            "operation": operation_hint,
            "content": before_content.clone(),
            "edit_id": edit_id.clone(),
        }),
    })?;
    writer.flush()?;

    fs::write(&resolved_path, after_content.as_bytes()).map_err(|err| {
        io::Error::new(
            err.kind(),
            format!(
                "Write failed - WAL snapshot available for recovery ({})",
                err
            ),
        )
    })?;

    let read_back = fs::read_to_string(&resolved_path).map_err(|err| {
        io::Error::new(
            err.kind(),
            format!("Failed to verify UTF-8 content in {}: {}", path_text, err),
        )
    })?;

    if !read_back.contains(new_str) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Edit verification failed - replacement not found after write",
        )
        .into());
    }

    writer.write_entry(WalEntry {
        id: before_entry_id + 1,
        timestamp: Utc::now().timestamp_millis(),
        entry_type: WalEntryType::FileEditAfter,
        payload: json!({
            "path": resolved_path.to_string_lossy().to_string(),
            "edit_id": edit_id.clone(),
            "before_str": old_str,
            "after_str": new_str,
            "byte_offset": byte_offset,
            "checksum": checksum_for_payload(&read_back),
            "success": true,
        }),
    })?;
    writer.flush()?;

    let db = AnchorDb::initialize(db_path)?;
    db.save_snapshot(&Snapshot {
        id: format!("snap-{}", Uuid::new_v4()),
        conversation_id: None,
        file_path: resolved_path.to_string_lossy().to_string(),
        content_before: Some(before_content),
        content_after: Some(read_back),
        created_at: Utc::now().timestamp_millis(),
        operation: operation_hint.to_string(),
    })?;

    Ok(json!({
        "message": "Edited successfully. Snapshot saved.",
        "path": resolved_path.to_string_lossy().to_string(),
        "edit_id": edit_id
    }))
}

fn latest_uncommitted_before_content(db_path: &Path, path: &str) -> IpcResult<Option<String>> {
    let mut reader = WalReader::from_path(db_path)?;
    let entries = reader.read_all()?;

    let mut before_entries: HashMap<String, (i64, String)> = HashMap::new();
    let mut completed_edit_ids: HashSet<String> = HashSet::new();

    for entry in entries {
        if entry.entry_type == WalEntryType::FileEditBefore {
            let entry_path = entry.payload.get("path").and_then(Value::as_str);
            let edit_id = entry.payload.get("edit_id").and_then(Value::as_str);
            let content = entry.payload.get("content").and_then(Value::as_str);

            if entry_path == Some(path) {
                if let (Some(valid_edit_id), Some(valid_content)) = (edit_id, content) {
                    before_entries.insert(
                        valid_edit_id.to_string(),
                        (entry.timestamp, valid_content.to_string()),
                    );
                }
            }
            continue;
        }

        if entry.entry_type == WalEntryType::FileEditAfter {
            if let Some(edit_id) = entry.payload.get("edit_id").and_then(Value::as_str) {
                completed_edit_ids.insert(edit_id.to_string());
            }
        }
    }

    let mut latest: Option<(i64, String)> = None;
    for (edit_id, (timestamp, content)) in before_entries {
        if completed_edit_ids.contains(&edit_id) {
            continue;
        }

        match &latest {
            Some((latest_ts, _)) if timestamp <= *latest_ts => {}
            _ => {
                latest = Some((timestamp, content));
            }
        }
    }

    Ok(latest.map(|(_, content)| content))
}

fn next_wal_entry_id(db_path: &Path) -> IpcResult<i64> {
    let connection = Connection::open(db_path)?;
    connection.execute_batch(WAL_TABLE_SCHEMA)?;
    let next_id: i64 =
        connection.query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM wal_log", [], |row| {
            row.get(0)
        })?;
    Ok(next_id)
}

fn read_text_with_not_found_empty(path: &Path) -> IpcResult<String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(io::Error::new(
            err.kind(),
            format!(
                "Could not read UTF-8 content from {}: {}",
                path.display(),
                err
            ),
        )
        .into()),
    }
}

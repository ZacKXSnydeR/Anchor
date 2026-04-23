use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use log::{error, info};
use rusqlite::{params, Connection};
use serde_json::Value;
use tokio::sync::broadcast;
use tokio::time::{interval, Duration};

use crate::wal::writer::{checksum_for_payload, WalEntry, WalEntryType, WAL_TABLE_SCHEMA};

type WalResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

pub const CHECKPOINT_INTERVAL_SECS: i64 = 300;
pub const CHECKPOINT_ENTRY_THRESHOLD: i64 = 100;
const CHECK_LOOP_TICK_SECS: u64 = 15;

pub async fn run_checkpoint_loop(
    db_path: PathBuf,
    mut shutdown: broadcast::Receiver<()>,
) -> WalResult<()> {
    let mut ticker = interval(Duration::from_secs(CHECK_LOOP_TICK_SECS));
    let mut last_checkpoint_ts = current_unix_ts()?;

    loop {
        tokio::select! {
            _ = shutdown.recv() => {
                info!("Checkpoint loop shutdown requested");
                break;
            }
            _ = ticker.tick() => {
                match open_connection(&db_path) {
                    Ok(connection) => {
                        match should_checkpoint(&connection, last_checkpoint_ts) {
                            Ok(true) => {
                                checkpoint(&connection)?;
                                last_checkpoint_ts = current_unix_ts()?;
                                info!("WAL checkpoint completed");
                            }
                            Ok(false) => {}
                            Err(err) => error!("Checkpoint condition check failed: {}", err),
                        }
                    }
                    Err(err) => error!("Checkpoint DB open failed: {}", err),
                }
            }
        }
    }

    Ok(())
}

pub fn checkpoint(db: &Connection) -> WalResult<()> {
    let tx = db.unchecked_transaction()?;

    tx.execute_batch(&format!(
        "
            {wal_schema}

            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ",
        wal_schema = WAL_TABLE_SCHEMA
    ))?;

    let entries = {
        let mut statement = tx.prepare(
            "
            SELECT id, ts, entry_type, payload, checksum
            FROM wal_log
            ORDER BY ts ASC, id ASC
            ",
        )?;

        let rows = statement.query_map([], |row| {
            let id: i64 = row.get(0)?;
            let ts: i64 = row.get(1)?;
            let entry_type_raw: String = row.get(2)?;
            let payload_raw: String = row.get(3)?;
            let checksum: String = row.get(4)?;
            Ok((id, ts, entry_type_raw, payload_raw, checksum))
        })?;

        let mut items = Vec::new();
        for row in rows {
            let (id, ts, entry_type_raw, payload_raw, checksum) = row?;
            let computed = checksum_for_payload(&payload_raw);
            if computed != checksum {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("WAL checksum mismatch for entry id {}", id),
                )
                .into());
            }

            let entry_type = parse_entry_type(&entry_type_raw)?;
            let payload: Value = serde_json::from_str(&payload_raw)?;
            items.push(WalEntry {
                id,
                timestamp: ts,
                entry_type,
                payload,
            });
        }

        items
    };

    for entry in &entries {
        apply_entry_to_conversations(&tx, entry)?;
    }

    if !entries.is_empty() {
        tx.execute("DELETE FROM wal_log", [])?;
    }

    tx.commit()?;
    Ok(())
}

pub fn should_checkpoint(db: &Connection, last_checkpoint_ts: i64) -> WalResult<bool> {
    let tx = db.unchecked_transaction()?;
    tx.execute_batch(WAL_TABLE_SCHEMA)?;

    let entry_count: i64 = tx.query_row("SELECT COUNT(*) FROM wal_log", [], |row| row.get(0))?;
    tx.commit()?;

    let now = current_unix_ts()?;
    Ok(entry_count > CHECKPOINT_ENTRY_THRESHOLD
        || now - last_checkpoint_ts >= CHECKPOINT_INTERVAL_SECS)
}

fn apply_entry_to_conversations(tx: &rusqlite::Transaction<'_>, entry: &WalEntry) -> WalResult<()> {
    if matches!(
        entry.entry_type,
        WalEntryType::FileEdit | WalEntryType::FileEditBefore | WalEntryType::FileEditAfter
    ) {
        return Ok(());
    }

    let conversation_id = conversation_id_for_entry(entry);
    let payload = serde_json::to_string(&entry.payload)?;

    tx.execute(
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

fn conversation_id_for_entry(entry: &WalEntry) -> String {
    let payload = &entry.payload;

    if let Some(value) = payload.get("conversation_id").and_then(|v| v.as_str()) {
        return value.to_string();
    }

    if let Some(value) = payload.get("id").and_then(|v| v.as_str()) {
        return value.to_string();
    }

    format!("wal-{}", entry.id)
}

fn parse_entry_type(value: &str) -> WalResult<WalEntryType> {
    WalEntryType::from_str(value).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Unsupported WAL entry_type value: {}", value),
        )
        .into()
    })
}

fn current_unix_ts() -> WalResult<i64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    Ok(duration.as_secs() as i64)
}

fn open_connection(db_path: &Path) -> WalResult<Connection> {
    let connection = Connection::open(db_path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(connection)
}

use std::error::Error;
use std::path::Path;

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

type WalResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

pub(crate) const WAL_TABLE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS wal_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    entry_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    checksum TEXT NOT NULL
);
";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum WalEntryType {
    Conversation,
    Snapshot,
    FileEdit,
    FileEditBefore,
    FileEditAfter,
}

impl WalEntryType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Conversation => "Conversation",
            Self::Snapshot => "Snapshot",
            Self::FileEdit => "FileEdit",
            Self::FileEditBefore => "FileEditBefore",
            Self::FileEditAfter => "FileEditAfter",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "Conversation" => Some(Self::Conversation),
            "Snapshot" => Some(Self::Snapshot),
            "FileEdit" => Some(Self::FileEdit),
            "FileEditBefore" => Some(Self::FileEditBefore),
            "FileEditAfter" => Some(Self::FileEditAfter),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalEntry {
    pub id: i64,
    pub timestamp: i64,
    pub entry_type: WalEntryType,
    pub payload: Value,
}

pub struct WalWriter {
    connection: Connection,
}

impl WalWriter {
    pub fn new(connection: Connection) -> WalResult<Self> {
        ensure_wal_table(&connection)?;
        Ok(Self { connection })
    }

    pub fn from_path<P: AsRef<Path>>(db_path: P) -> WalResult<Self> {
        let connection = open_connection(db_path.as_ref())?;
        Self::new(connection)
    }

    pub fn write_entry(&mut self, entry: WalEntry) -> WalResult<()> {
        let payload = serde_json::to_string(&entry.payload)?;
        let checksum = checksum_for_payload(&payload);

        // BEGIN IMMEDIATE -> INSERT -> COMMIT for crash-safe atomicity.
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        tx.execute_batch(WAL_TABLE_SCHEMA)?;
        tx.execute(
            "
            INSERT INTO wal_log (id, ts, entry_type, payload, checksum)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(id) DO UPDATE SET
                ts = excluded.ts,
                entry_type = excluded.entry_type,
                payload = excluded.payload,
                checksum = excluded.checksum
            ",
            params![
                entry.id,
                entry.timestamp,
                entry.entry_type.as_str(),
                payload,
                checksum
            ],
        )?;
        tx.commit()?;

        Ok(())
    }

    pub fn flush(&self) -> WalResult<()> {
        self.connection
            .execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
        Ok(())
    }
}

pub(crate) fn ensure_wal_table(connection: &Connection) -> WalResult<()> {
    connection.execute_batch(WAL_TABLE_SCHEMA)?;
    Ok(())
}

fn open_connection(db_path: &Path) -> WalResult<Connection> {
    let connection = Connection::open(db_path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(connection)
}

pub(crate) fn checksum_for_payload(payload: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::Connection;
    use serde_json::json;

    use super::{WalEntry, WalEntryType, WalWriter};
    use crate::wal::checkpoint::checkpoint;
    use crate::wal::reader::WalReader;

    /// Verifies that entries written into the WAL can be read back and validated.
    #[test]
    fn test_wal_write_and_read() -> Result<(), Box<dyn Error + Send + Sync>> {
        let db_path = temp_db_path("wal-write-read")?;

        let mut writer = WalWriter::from_path(&db_path)?;
        for idx in 1..=10 {
            writer.write_entry(build_entry(idx))?;
        }

        let mut reader = WalReader::from_path(&db_path)?;
        let entries = reader.read_all()?;

        assert_eq!(entries.len(), 10);
        for entry in &entries {
            assert!(reader.verify_checksum(entry));
        }

        cleanup_db_file(&db_path);
        Ok(())
    }

    /// Verifies that uncheckpointed WAL entries are durable across process restarts.
    #[test]
    fn test_wal_survives_simulated_crash() -> Result<(), Box<dyn Error + Send + Sync>> {
        let db_path = temp_db_path("wal-crash-survival")?;

        {
            let mut writer = WalWriter::from_path(&db_path)?;
            for idx in 1..=10 {
                writer.write_entry(build_entry(idx))?;
            }
            // Dropping the writer simulates abrupt process termination before checkpoint.
        }

        let mut reader = WalReader::from_path(&db_path)?;
        let entries = reader.read_all()?;
        assert_eq!(entries.len(), 10);

        cleanup_db_file(&db_path);
        Ok(())
    }

    /// Verifies that checkpointing replays WAL entries and clears wal_log.
    #[test]
    fn test_checkpoint_clears_wal() -> Result<(), Box<dyn Error + Send + Sync>> {
        let db_path = temp_db_path("wal-checkpoint-clear")?;

        let mut writer = WalWriter::from_path(&db_path)?;
        for idx in 1..=100 {
            writer.write_entry(build_entry(idx))?;
        }

        let connection = Connection::open(&db_path)?;
        checkpoint(&connection)?;

        let wal_count: i64 =
            connection.query_row("SELECT COUNT(*) FROM wal_log", [], |row| row.get(0))?;
        assert_eq!(wal_count, 0);

        cleanup_db_file(&db_path);
        Ok(())
    }

    /// Builds a deterministic WAL entry for tests.
    fn build_entry(id: i64) -> WalEntry {
        WalEntry {
            id,
            timestamp: 1_700_000_000 + id,
            entry_type: WalEntryType::Conversation,
            payload: json!({
                "conversation_id": format!("conv-{}", id),
                "id": format!("conv-{}", id),
                "messages": [format!("message-{}", id)],
            }),
        }
    }

    /// Creates a unique temporary sqlite path for test isolation.
    fn temp_db_path(prefix: &str) -> Result<PathBuf, Box<dyn Error + Send + Sync>> {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let file_name = format!("anchor-{}-{}-{}.db", prefix, std::process::id(), nanos);
        Ok(std::env::temp_dir().join(file_name))
    }

    /// Removes a temporary DB file and ignores cleanup failures in tests.
    fn cleanup_db_file(path: &PathBuf) {
        let _ = fs::remove_file(path);
    }
}

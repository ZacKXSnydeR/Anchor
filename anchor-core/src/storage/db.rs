use std::error::Error;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

type DbError = Box<dyn Error + Send + Sync>;
pub type DbResult<T> = Result<T, DbError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub workspace: Option<String>,
    pub messages: Value,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationMeta {
    pub id: String,
    pub title: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub workspace: Option<String>,
}

pub struct AnchorDb {
    pub(crate) connection: Connection,
}

impl AnchorDb {
    pub fn initialize(path: &Path) -> DbResult<AnchorDb> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;

        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT,
                created_at INTEGER,
                updated_at INTEGER,
                workspace TEXT,
                messages TEXT,
                metadata TEXT
            );

            CREATE TABLE IF NOT EXISTS wal_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                entry_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                checksum TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS snapshots (
                id TEXT PRIMARY KEY,
                conversation_id TEXT,
                file_path TEXT,
                content_before TEXT,
                content_after TEXT,
                created_at INTEGER,
                operation TEXT
            );
            ",
        )?;

        Ok(AnchorDb { connection })
    }

    pub fn save_conversation(&self, conv: &Conversation) -> DbResult<()> {
        let tx = self.connection.unchecked_transaction()?;

        tx.execute(
            "
            INSERT OR REPLACE INTO conversations (
                id,
                title,
                created_at,
                updated_at,
                workspace,
                messages,
                metadata
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ",
            params![
                &conv.id,
                &conv.title,
                conv.created_at,
                conv.updated_at,
                &conv.workspace,
                serde_json::to_string(&conv.messages)?,
                serde_json::to_string(&conv.metadata)?,
            ],
        )?;

        tx.commit()?;
        Ok(())
    }

    pub fn get_conversation(&self, id: &str) -> DbResult<Option<Conversation>> {
        let tx = self.connection.unchecked_transaction()?;

        let row_data = tx
            .query_row(
                "
                SELECT id, title, created_at, updated_at, workspace, messages, metadata
                FROM conversations
                WHERE id = ?1
                ",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()?;

        let conversation = match row_data {
            Some((
                conv_id,
                title,
                created_at,
                updated_at,
                workspace,
                messages_raw,
                metadata_raw,
            )) => {
                let messages: Value = serde_json::from_str(&messages_raw)?;
                let metadata: Value = serde_json::from_str(&metadata_raw)?;

                Some(Conversation {
                    id: conv_id,
                    title,
                    created_at,
                    updated_at,
                    workspace,
                    messages,
                    metadata,
                })
            }
            None => None,
        };

        tx.commit()?;
        Ok(conversation)
    }

    pub fn list_conversations(&self) -> DbResult<Vec<ConversationMeta>> {
        let tx = self.connection.unchecked_transaction()?;

        let conversations = {
            let mut statement = tx.prepare(
                "
                SELECT id, title, created_at, updated_at, workspace
                FROM conversations
                ORDER BY updated_at DESC
                ",
            )?;

            let rows = statement.query_map([], |row| {
                Ok(ConversationMeta {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    workspace: row.get(4)?,
                })
            })?;

            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            items
        };

        tx.commit()?;
        Ok(conversations)
    }

    pub fn delete_conversation(&self, id: &str) -> DbResult<()> {
        let tx = self.connection.unchecked_transaction()?;

        tx.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM snapshots WHERE conversation_id = ?1",
            params![id],
        )?;

        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::{json, Value};

    use super::{AnchorDb, Conversation};
    use crate::wal::reader::WalReader;
    use crate::wal::writer::{WalEntry, WalEntryType, WalWriter};

    /// Verifies conversation persistence through save and fetch operations.
    #[test]
    fn test_save_and_retrieve_conversation() -> Result<(), Box<dyn Error + Send + Sync>> {
        let db_path = temp_db_path("storage-save-retrieve")?;
        let db = AnchorDb::initialize(&db_path)?;

        let conversation = build_conversation("conv-a", 100, 200);
        db.save_conversation(&conversation)?;

        let loaded = db.get_conversation("conv-a")?;
        assert!(loaded.is_some());

        let loaded = loaded.ok_or_else(|| io::Error::other("Conversation not found"))?;
        assert_eq!(loaded.id, "conv-a");
        assert_eq!(loaded.updated_at, 200);

        cleanup_db_file(&db_path);
        Ok(())
    }

    /// Verifies list ordering by updated_at in descending order.
    #[test]
    fn test_list_conversations_sorted_by_updated_at() -> Result<(), Box<dyn Error + Send + Sync>> {
        let db_path = temp_db_path("storage-sort")?;
        let db = AnchorDb::initialize(&db_path)?;

        db.save_conversation(&build_conversation("older", 100, 150))?;
        db.save_conversation(&build_conversation("newer", 100, 250))?;

        let listed = db.list_conversations()?;
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "newer");
        assert_eq!(listed[1].id, "older");

        cleanup_db_file(&db_path);
        Ok(())
    }

    /// Verifies that conversation data can be restored after a WAL-based replay pass.
    #[test]
    fn test_conversation_survives_wal_replay() -> Result<(), Box<dyn Error + Send + Sync>> {
        let db_path = temp_db_path("storage-wal-replay")?;
        let db = AnchorDb::initialize(&db_path)?;

        let wal_payload = json!({
            "conversation": {
                "id": "replayed-conv",
                "title": "Replayed",
                "created_at": 10,
                "updated_at": 20,
                "workspace": "workspace-a",
                "messages": ["hello from wal"],
                "metadata": {"source": "wal"}
            }
        });

        let mut writer = WalWriter::from_path(&db_path)?;
        writer.write_entry(WalEntry {
            id: 1,
            timestamp: 1_700_000_001,
            entry_type: WalEntryType::Conversation,
            payload: wal_payload,
        })?;

        let mut reader = WalReader::from_path(&db_path)?;
        let entries = reader.read_all()?;
        for entry in entries {
            let conversation_json = entry
                .payload
                .get("conversation")
                .ok_or_else(|| io::Error::other("Missing conversation payload"))?
                .clone();

            let conversation: Conversation = serde_json::from_value(conversation_json)?;
            db.save_conversation(&conversation)?;
        }

        let restored = db.get_conversation("replayed-conv")?;
        assert!(restored.is_some());

        let restored = restored.ok_or_else(|| io::Error::other("Restored conversation not found"))?;
        assert_eq!(restored.title.as_deref(), Some("Replayed"));
        assert_eq!(
            restored.messages,
            Value::Array(vec![Value::String("hello from wal".to_string())])
        );

        cleanup_db_file(&db_path);
        Ok(())
    }

    /// Builds a deterministic conversation for test assertions.
    fn build_conversation(id: &str, created_at: i64, updated_at: i64) -> Conversation {
        Conversation {
            id: id.to_string(),
            title: Some(format!("Title-{}", id)),
            created_at,
            updated_at,
            workspace: Some("workspace".to_string()),
            messages: json!(["msg"]),
            metadata: json!({"kind": "test"}),
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

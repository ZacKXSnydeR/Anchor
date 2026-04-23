use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::storage::db::{AnchorDb, DbResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: String,
    pub conversation_id: Option<String>,
    pub file_path: String,
    pub content_before: Option<String>,
    pub content_after: Option<String>,
    pub created_at: i64,
    pub operation: String,
}

impl AnchorDb {
    pub fn save_snapshot(&self, snap: &Snapshot) -> DbResult<()> {
        let tx = self.connection.unchecked_transaction()?;

        tx.execute(
            "
            INSERT OR REPLACE INTO snapshots (
                id,
                conversation_id,
                file_path,
                content_before,
                content_after,
                created_at,
                operation
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ",
            params![
                &snap.id,
                &snap.conversation_id,
                &snap.file_path,
                &snap.content_before,
                &snap.content_after,
                snap.created_at,
                &snap.operation,
            ],
        )?;

        tx.commit()?;
        Ok(())
    }

    pub fn get_snapshots_for_conversation(&self, conv_id: &str) -> DbResult<Vec<Snapshot>> {
        let tx = self.connection.unchecked_transaction()?;

        let snapshots = {
            let mut statement = tx.prepare(
                "
                SELECT id, conversation_id, file_path, content_before, content_after, created_at, operation
                FROM snapshots
                WHERE conversation_id = ?1
                ORDER BY created_at DESC
                ",
            )?;

            let rows = statement.query_map(params![conv_id], |row| {
                Ok(Snapshot {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    file_path: row.get(2)?,
                    content_before: row.get(3)?,
                    content_after: row.get(4)?,
                    created_at: row.get(5)?,
                    operation: row.get(6)?,
                })
            })?;

            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            items
        };

        tx.commit()?;
        Ok(snapshots)
    }

    pub fn get_latest_snapshot(&self, file_path: &str) -> DbResult<Option<Snapshot>> {
        let tx = self.connection.unchecked_transaction()?;

        let snapshot = tx
            .query_row(
                "
                SELECT id, conversation_id, file_path, content_before, content_after, created_at, operation
                FROM snapshots
                WHERE file_path = ?1
                ORDER BY created_at DESC
                LIMIT 1
                ",
                params![file_path],
                |row| {
                    Ok(Snapshot {
                        id: row.get(0)?,
                        conversation_id: row.get(1)?,
                        file_path: row.get(2)?,
                        content_before: row.get(3)?,
                        content_after: row.get(4)?,
                        created_at: row.get(5)?,
                        operation: row.get(6)?,
                    })
                },
            )
            .optional()?;

        tx.commit()?;
        Ok(snapshot)
    }
}

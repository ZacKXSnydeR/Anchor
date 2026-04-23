use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::json;

use crate::storage::db::{AnchorDb, Conversation};
use crate::wal::reader::WalReader;

type RecoveryResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug, Clone, Serialize)]
pub struct RecoveryReport {
    pub recovered_count: usize,
    pub failed_count: usize,
    pub details: Vec<String>,
}

pub struct RecoveryEngine {
    antigravity_dir: PathBuf,
    anchor_db_path: PathBuf,
}

impl RecoveryEngine {
    pub fn new(anchor_db_path: PathBuf) -> RecoveryResult<Self> {
        let home = dirs::home_dir().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "Could not determine home directory for recovery",
            )
        })?;

        Ok(Self {
            antigravity_dir: home.join(".antigravity"),
            anchor_db_path,
        })
    }

    pub fn with_antigravity_dir(antigravity_dir: PathBuf, anchor_db_path: PathBuf) -> Self {
        Self {
            antigravity_dir,
            anchor_db_path,
        }
    }

    pub fn check_and_recover(&self) -> RecoveryResult<RecoveryReport> {
        let mut details = Vec::new();
        let context_corruption = detect_corruption(&self.antigravity_dir);
        let vscdb_incomplete = self.is_state_vscdb_incomplete()?;

        if !context_corruption && !vscdb_incomplete {
            details.push("No corruption detected".to_string());
            return Ok(RecoveryReport {
                recovered_count: 0,
                failed_count: 0,
                details,
            });
        }

        if context_corruption {
            details.push(
                "Corruption detected: context_state is missing/empty while .pb files exist"
                    .to_string(),
            );
        }
        if vscdb_incomplete {
            details.push(
                "Corruption detected: state.vscdb trajectorySummaries appears incomplete"
                    .to_string(),
            );
        }

        let mut recovered_count = 0usize;
        let mut failed_count = 0usize;

        let context_state_dir = self.antigravity_dir.join("context_state");
        fs::create_dir_all(&context_state_dir)?;

        let pb_files = collect_pb_files(&self.antigravity_dir.join("conversations"))?;
        let db = AnchorDb::initialize(&self.anchor_db_path)?;

        for pb_path in pb_files {
            match self.recover_conversation_from_pb(&db, &context_state_dir, &pb_path) {
                Ok(detail) => {
                    recovered_count += 1;
                    details.push(detail);
                }
                Err(err) => {
                    failed_count += 1;
                    details.push(format!(
                        "Failed to recover from {}: {}",
                        pb_path.display(),
                        err
                    ));
                }
            }
        }

        let wal_rebuild_details = self.rebuild_context_index_from_wal(&context_state_dir)?;
        details.extend(wal_rebuild_details);

        Ok(RecoveryReport {
            recovered_count,
            failed_count,
            details,
        })
    }

    fn recover_conversation_from_pb(
        &self,
        db: &AnchorDb,
        context_state_dir: &Path,
        pb_path: &Path,
    ) -> RecoveryResult<String> {
        let conv_id = pb_path
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Invalid conversation file name: {}", pb_path.display()),
                )
            })?
            .to_string();

        let pb_bytes = fs::read(pb_path)?;
        let now = unix_ts()?;

        let existing = db.get_conversation(&conv_id)?;
        if existing.is_none() {
            let conversation = Conversation {
                id: conv_id.clone(),
                title: Some(format!("Recovered {}", conv_id)),
                created_at: now,
                updated_at: now,
                workspace: None,
                messages: json!([]),
                metadata: json!({
                    "recovered_from": pb_path.display().to_string(),
                    "pb_size": pb_bytes.len(),
                    "recovered_at": now,
                }),
            };
            db.save_conversation(&conversation)?;
        }

        let context_index_path = context_state_dir.join(format!("{}.json", conv_id));
        let context_payload = json!({
            "conversation_id": conv_id,
            "pb_path": pb_path.display().to_string(),
            "pb_size": pb_bytes.len(),
            "indexed_at": now,
        });
        let serialized = serde_json::to_vec_pretty(&context_payload)?;
        fs::write(&context_index_path, serialized)?;

        Ok(format!(
            "Recovered conversation index from {}",
            pb_path.display()
        ))
    }

    fn rebuild_context_index_from_wal(
        &self,
        context_state_dir: &Path,
    ) -> RecoveryResult<Vec<String>> {
        let mut details = Vec::new();
        let mut reader = WalReader::from_path(&self.anchor_db_path)?;
        let entries = reader.read_all()?;

        let mut verified_entries = Vec::new();
        let mut invalid_count = 0usize;

        for entry in entries {
            if reader.verify_checksum(&entry) {
                verified_entries.push(json!({
                    "id": entry.id,
                    "timestamp": entry.timestamp,
                    "entry_type": format!("{:?}", entry.entry_type),
                    "payload": entry.payload,
                }));
            } else {
                invalid_count += 1;
            }
        }

        let wal_index_path = context_state_dir.join("wal_rebuild.json");
        let serialized = serde_json::to_vec_pretty(&verified_entries)?;
        fs::write(&wal_index_path, serialized)?;

        details.push(format!(
            "Rebuilt WAL index with {} verified entries",
            verified_entries.len()
        ));
        if invalid_count > 0 {
            details.push(format!(
                "Skipped {} WAL entries due to checksum mismatch",
                invalid_count
            ));
        }

        Ok(details)
    }

    fn is_state_vscdb_incomplete(&self) -> RecoveryResult<bool> {
        let db_path = self.antigravity_dir.join("state.vscdb");
        if !db_path.exists() {
            return Ok(true);
        }

        let connection = Connection::open(&db_path)?;

        let value: Option<String> = connection
            .query_row(
                "
                SELECT value
                FROM ItemTable
                WHERE key LIKE '%trajectorySummaries%'
                LIMIT 1
                ",
                [],
                |row| row.get(0),
            )
            .ok();

        let is_incomplete =
            value.is_none() || value.as_deref().is_some_and(|v| v.trim().is_empty());
        Ok(is_incomplete)
    }
}

pub fn detect_corruption(antigravity_dir: &Path) -> bool {
    let context_state_dir = antigravity_dir.join("context_state");
    let conversations_dir = antigravity_dir.join("conversations");

    let context_empty_or_missing = if !context_state_dir.exists() {
        true
    } else {
        match fs::read_dir(&context_state_dir) {
            Ok(mut entries) => entries.next().is_none(),
            Err(_) => true,
        }
    };

    let has_pb = has_pb_files(&conversations_dir).unwrap_or(false);
    context_empty_or_missing && has_pb
}

fn collect_pb_files(root: &Path) -> RecoveryResult<Vec<PathBuf>> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut collected = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.is_dir() {
                stack.push(path);
                continue;
            }

            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pb"))
            {
                collected.push(path);
            }
        }
    }

    Ok(collected)
}

fn has_pb_files(root: &Path) -> RecoveryResult<bool> {
    if !root.exists() {
        return Ok(false);
    }

    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }

            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pb"))
            {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

fn unix_ts() -> RecoveryResult<i64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    Ok(duration.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{detect_corruption, RecoveryEngine};
    use crate::storage::db::AnchorDb;

    /// Verifies corruption detection when context_state is empty but PB files exist.
    #[test]
    fn test_detect_corruption_empty_context_state() -> Result<(), Box<dyn Error + Send + Sync>> {
        let antigravity_dir = temp_dir_path("recovery-corrupt")?;
        let context_state = antigravity_dir.join("context_state");
        let conversations = antigravity_dir.join("conversations");

        fs::create_dir_all(&context_state)?;
        fs::create_dir_all(&conversations)?;
        fs::write(conversations.join("conv-1.pb"), b"fake-pb-content")?;

        assert!(detect_corruption(&antigravity_dir));

        cleanup_dir(&antigravity_dir);
        Ok(())
    }

    /// Verifies no corruption signal when both context index and PB files are present.
    #[test]
    fn test_detect_no_corruption_when_healthy() -> Result<(), Box<dyn Error + Send + Sync>> {
        let antigravity_dir = temp_dir_path("recovery-healthy")?;
        let context_state = antigravity_dir.join("context_state");
        let conversations = antigravity_dir.join("conversations");

        fs::create_dir_all(&context_state)?;
        fs::create_dir_all(&conversations)?;
        fs::write(conversations.join("conv-2.pb"), b"fake-pb-content")?;
        fs::write(context_state.join("index.json"), b"{}")?;

        assert!(!detect_corruption(&antigravity_dir));

        cleanup_dir(&antigravity_dir);
        Ok(())
    }

    /// Verifies recovery report serialization contains expected structure fields.
    #[test]
    fn test_recovery_report_structure() -> Result<(), Box<dyn Error + Send + Sync>> {
        let antigravity_dir = temp_dir_path("recovery-report")?;
        let conversations = antigravity_dir.join("conversations");
        fs::create_dir_all(&conversations)?;
        fs::write(conversations.join("conv-3.pb"), b"fake-pb-content")?;

        let db_path = std::env::temp_dir().join(format!(
            "anchor-recovery-db-{}-{}.db",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        ));
        let _db = AnchorDb::initialize(&db_path)?;

        let engine = RecoveryEngine::with_antigravity_dir(antigravity_dir.clone(), db_path.clone());
        let report = engine.check_and_recover()?;

        let serialized = serde_json::to_value(&report)?;
        assert!(serialized.get("recovered_count").is_some());
        assert!(serialized.get("failed_count").is_some());
        assert!(serialized.get("details").is_some());

        let details = serialized
            .get("details")
            .ok_or_else(|| io::Error::other("missing details field"))?
            .as_array()
            .ok_or_else(|| io::Error::other("details field is not an array"))?;
        assert!(!details.is_empty());

        cleanup_dir(&antigravity_dir);
        let _ = fs::remove_file(db_path);
        Ok(())
    }

    /// Creates a unique temporary directory path for isolated recovery tests.
    fn temp_dir_path(prefix: &str) -> Result<PathBuf, Box<dyn Error + Send + Sync>> {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let dir_name = format!("anchor-{}-{}-{}", prefix, std::process::id(), nanos);
        let dir = std::env::temp_dir().join(dir_name);
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// Cleans up a temporary test directory recursively and ignores cleanup failures.
    fn cleanup_dir(path: &PathBuf) {
        let _ = fs::remove_dir_all(path);
    }
}

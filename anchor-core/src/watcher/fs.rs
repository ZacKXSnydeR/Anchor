use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use tokio::sync::mpsc;

use crate::wal::writer::{WalEntry, WalEntryType};

type WatchResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const DEBOUNCE_MS: u64 = 500;

pub struct AnchorWatcher {
    antigravity_dir: PathBuf,
    wal_tx: mpsc::Sender<WalEntry>,
    id_counter: AtomicI64,
}

impl AnchorWatcher {
    pub fn new(wal_tx: mpsc::Sender<WalEntry>) -> WatchResult<Self> {
        let home = dirs::home_dir().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "Could not determine home directory for Antigravity watcher",
            )
        })?;

        Ok(Self {
            antigravity_dir: home.join(".antigravity"),
            wal_tx,
            id_counter: AtomicI64::new(1),
        })
    }

    pub fn with_antigravity_dir(antigravity_dir: PathBuf, wal_tx: mpsc::Sender<WalEntry>) -> Self {
        Self {
            antigravity_dir,
            wal_tx,
            id_counter: AtomicI64::new(1),
        }
    }

    pub async fn watch_antigravity_data_dir(&self) -> WatchResult<()> {
        let (notify_tx, mut notify_rx) = mpsc::channel::<notify::Result<Event>>(512);

        let mut watcher = RecommendedWatcher::new(
            move |result| {
                let _ = notify_tx.blocking_send(result);
            },
            Config::default(),
        )?;

        watcher.watch(&self.antigravity_dir, RecursiveMode::Recursive)?;

        let mut debounce_map: HashMap<String, Instant> = HashMap::new();
        while let Some(event_result) = notify_rx.recv().await {
            let event = match event_result {
                Ok(value) => value,
                Err(_) => continue,
            };

            let event_kind = format!("{:?}", event.kind);
            for path in event.paths {
                if let Some((trigger, entry_type)) =
                    classify_event_path(&self.antigravity_dir, &path)
                {
                    let key = path.to_string_lossy().to_string();
                    let now = Instant::now();
                    let should_skip = debounce_map.get(&key).is_some_and(|last| {
                        now.duration_since(*last) < Duration::from_millis(DEBOUNCE_MS)
                    });

                    if should_skip {
                        continue;
                    }
                    debounce_map.insert(key, now);

                    let timestamp = unix_ts()?;
                    let entry = WalEntry {
                        id: self.next_entry_id(timestamp),
                        timestamp,
                        entry_type,
                        payload: json!({
                            "trigger": trigger,
                            "path": path.display().to_string(),
                            "event_kind": event_kind,
                            "timestamp": timestamp,
                        }),
                    };

                    self.wal_tx.send(entry).await.map_err(|send_err| {
                        io::Error::new(
                            io::ErrorKind::BrokenPipe,
                            format!("Failed to send watcher event to WAL writer: {}", send_err),
                        )
                    })?;
                }
            }
        }

        Ok(())
    }

    fn next_entry_id(&self, timestamp: i64) -> i64 {
        let seq = self.id_counter.fetch_add(1, Ordering::Relaxed);
        timestamp.saturating_mul(1000).saturating_add(seq)
    }
}

fn classify_event_path(base_dir: &Path, path: &Path) -> Option<(&'static str, WalEntryType)> {
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pb"))
    {
        return Some(("conversation_backup", WalEntryType::Conversation));
    }

    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("state.vscdb"))
    {
        return Some(("db_snapshot", WalEntryType::Snapshot));
    }

    let context_state = base_dir.join("context_state");
    if path.starts_with(&context_state) {
        return Some(("index_snapshot", WalEntryType::Snapshot));
    }

    None
}

fn unix_ts() -> WatchResult<i64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    Ok(duration.as_secs() as i64)
}

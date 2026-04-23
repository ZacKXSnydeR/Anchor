use std::error::Error;
use std::io;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::wal::writer::{checksum_for_payload, ensure_wal_table, WalEntry, WalEntryType};

type WalResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

pub struct WalReader {
    connection: Connection,
}

impl WalReader {
    pub fn new(connection: Connection) -> WalResult<Self> {
        ensure_wal_table(&connection)?;
        Ok(Self { connection })
    }

    pub fn from_path<P: AsRef<Path>>(db_path: P) -> WalResult<Self> {
        let connection = Connection::open(db_path.as_ref())?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        Self::new(connection)
    }

    pub fn read_since(&mut self, timestamp: i64) -> WalResult<Vec<WalEntry>> {
        let tx = self.connection.transaction()?;
        ensure_wal_table(&tx)?;

        let entries = {
            let mut statement = tx.prepare(
                "
                SELECT id, ts, entry_type, payload
                FROM wal_log
                WHERE ts >= ?1
                ORDER BY ts ASC, id ASC
                ",
            )?;

            let rows = statement.query_map(params![timestamp], |row| {
                let id: i64 = row.get(0)?;
                let ts: i64 = row.get(1)?;
                let entry_type_raw: String = row.get(2)?;
                let payload_raw: String = row.get(3)?;
                Ok((id, ts, entry_type_raw, payload_raw))
            })?;

            let mut items = Vec::new();
            for row in rows {
                let (id, ts, entry_type_raw, payload_raw) = row?;
                let entry_type = parse_entry_type(&entry_type_raw)?;
                let payload = serde_json::from_str(&payload_raw)?;

                items.push(WalEntry {
                    id,
                    timestamp: ts,
                    entry_type,
                    payload,
                });
            }

            items
        };

        tx.commit()?;
        Ok(entries)
    }

    pub fn read_all(&mut self) -> WalResult<Vec<WalEntry>> {
        let tx = self.connection.transaction()?;
        ensure_wal_table(&tx)?;

        let entries = {
            let mut statement = tx.prepare(
                "
                SELECT id, ts, entry_type, payload
                FROM wal_log
                ORDER BY ts ASC, id ASC
                ",
            )?;

            let rows = statement.query_map([], |row| {
                let id: i64 = row.get(0)?;
                let ts: i64 = row.get(1)?;
                let entry_type_raw: String = row.get(2)?;
                let payload_raw: String = row.get(3)?;
                Ok((id, ts, entry_type_raw, payload_raw))
            })?;

            let mut items = Vec::new();
            for row in rows {
                let (id, ts, entry_type_raw, payload_raw) = row?;
                let entry_type = parse_entry_type(&entry_type_raw)?;
                let payload = serde_json::from_str(&payload_raw)?;

                items.push(WalEntry {
                    id,
                    timestamp: ts,
                    entry_type,
                    payload,
                });
            }

            items
        };

        tx.commit()?;
        Ok(entries)
    }

    pub fn verify_checksum(&mut self, entry: &WalEntry) -> bool {
        self.verify_checksum_inner(entry).unwrap_or(false)
    }

    fn verify_checksum_inner(&mut self, entry: &WalEntry) -> WalResult<bool> {
        let tx = self.connection.transaction()?;
        ensure_wal_table(&tx)?;

        let stored_checksum: Option<String> = tx
            .query_row(
                "SELECT checksum FROM wal_log WHERE id = ?1",
                params![entry.id],
                |row| row.get(0),
            )
            .optional()?;

        let payload = serde_json::to_string(&entry.payload)?;
        let computed = checksum_for_payload(&payload);
        tx.commit()?;

        Ok(stored_checksum.is_some_and(|value| value == computed))
    }
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

use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anchor_core::api::ipc::IpcServer;
use anchor_core::tools::mcp_server::AnchorMcpServer;
use anchor_core::wal::checkpoint::run_checkpoint_loop;
use log::{error, info, warn};
use rusqlite::Connection;
use tokio::sync::broadcast;

type AppResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

enum DaemonEvent {
    ShutdownSignal,
    ServerStopped,
    CheckpointStopped,
}

#[tokio::main]
async fn main() -> AppResult<()> {
    init_logger();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mcp_mode = args.iter().any(|arg| arg == "--mcp-mode");
    let mcp_test_mode = args.iter().any(|arg| arg == "--test");

    if mcp_mode && mcp_test_mode {
        return run_mcp_test().await;
    }

    if mcp_mode {
        return run_mcp_server().await;
    }

    run_daemon().await
}

fn init_logger() {
    let default_level = std::env::var("ANCHOR_LOG").unwrap_or_else(|_| "info".to_string());
    let _ =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(default_level))
            .try_init();
}

async fn run_mcp_server() -> AppResult<()> {
    let workspace = std::env::var("ANCHOR_WORKSPACE").ok().map(PathBuf::from);
    let server = AnchorMcpServer::new(workspace);
    server.run().await?;
    Ok(())
}

async fn run_mcp_test() -> AppResult<()> {
    let workspace = std::env::var("ANCHOR_WORKSPACE").ok().map(PathBuf::from);
    let server = AnchorMcpServer::new(workspace);
    server.run_test().await?;
    Ok(())
}

async fn run_daemon() -> AppResult<()> {
    info!("Starting anchor-core daemon");

    let anchor_dir = resolve_anchor_dir()?;
    fs::create_dir_all(&anchor_dir)?;
    info!("Anchor data directory ready at {}", anchor_dir.display());

    let db_path = anchor_dir.join("anchor.db");
    let _db_keepalive = initialize_database(&db_path)?;
    info!("SQLite opened in WAL mode at {}", db_path.display());

    let server = IpcServer::new(db_path.clone());
    let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
    let checkpoint_shutdown_rx = shutdown_tx.subscribe();

    let mut server_task = tokio::spawn(async move { server.run(shutdown_rx).await });
    let checkpoint_db_path = db_path.clone();
    let mut checkpoint_task = tokio::spawn(async move {
        run_checkpoint_loop(checkpoint_db_path, checkpoint_shutdown_rx).await
    });

    let event = tokio::select! {
        signal_result = tokio::signal::ctrl_c() => {
            signal_result.map_err(|err| {
                    error!("Failed to listen for Ctrl+C: {}", err);
                    boxed_error(err)
                })?;

            info!("Ctrl+C received, initiating graceful shutdown");
            DaemonEvent::ShutdownSignal
        }
        server_result = &mut server_task => {
            let run_result = server_result.map_err(boxed_error)?;
            run_result?;

            warn!("IPC server exited before shutdown signal");
            DaemonEvent::ServerStopped
        }
        checkpoint_result = &mut checkpoint_task => {
            let run_result = checkpoint_result.map_err(boxed_error)?;
            run_result?;

            warn!("Checkpoint loop exited before shutdown signal");
            DaemonEvent::CheckpointStopped
        }
    };

    if matches!(
        event,
        DaemonEvent::ServerStopped | DaemonEvent::CheckpointStopped
    ) {
        return Ok(());
    }

    if shutdown_tx.send(()).is_err() {
        warn!("IPC server was already stopped before shutdown signal was sent");
    }

    let run_result = server_task.await.map_err(boxed_error)?;
    run_result?;

    let checkpoint_result = checkpoint_task.await.map_err(boxed_error)?;
    checkpoint_result?;

    info!("anchor-core daemon stopped cleanly");
    Ok(())
}

fn resolve_anchor_dir() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "Could not determine home directory for Anchor storage",
        )
    })?;

    Ok(home.join(".anchor"))
}

fn initialize_database(db_path: &Path) -> AppResult<Connection> {
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

        CREATE TABLE IF NOT EXISTS wal_log (
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            entry_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            checksum TEXT NOT NULL
        );
        ",
    )?;

    Ok(connection)
}

fn boxed_error<E>(err: E) -> Box<dyn Error + Send + Sync>
where
    E: Error + Send + Sync + 'static,
{
    Box::new(err)
}

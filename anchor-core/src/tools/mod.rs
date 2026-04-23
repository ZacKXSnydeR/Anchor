use std::error::Error;
use std::path::PathBuf;

pub mod edit_file;
pub mod mcp_server;
pub mod read_file;
pub mod tool_registry;
pub mod write_file;

pub(crate) mod daemon_client;

pub type ToolResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

pub(crate) fn resolve_tool_path(path: &str, workspace: &Option<PathBuf>) -> ToolResult<PathBuf> {
    let input = PathBuf::from(path);
    if input.is_absolute() {
        return Ok(input);
    }

    if let Some(workspace_path) = workspace {
        return Ok(workspace_path.join(input));
    }

    Ok(std::env::current_dir()?.join(input))
}

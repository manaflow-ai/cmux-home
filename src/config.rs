use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(crate) struct PersistedState {
    pub(crate) draft: Option<PersistedDraft>,
    #[serde(default)]
    pub(crate) stashes: Vec<PersistedDraft>,
    #[serde(default)]
    pub(crate) history: Vec<PersistedDraft>,
    #[serde(default)]
    pub(crate) provider: Option<String>,
    #[serde(default)]
    pub(crate) plan_mode: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct AppConfig {
    #[serde(default)]
    pub(crate) agents: AgentConfig,
    #[serde(default)]
    pub(crate) rename: RenameConfig,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct AgentConfig {
    #[serde(default)]
    pub(crate) codex: AgentCommandConfig,
    #[serde(default)]
    pub(crate) claude: AgentCommandConfig,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct AgentCommandConfig {
    pub(crate) command: Option<String>,
    pub(crate) plan_command: Option<String>,
    pub(crate) submit_command: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct RenameConfig {
    pub(crate) command: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct PersistedDraft {
    pub(crate) lines: Vec<String>,
    pub(crate) image_paths: Vec<String>,
    pub(crate) provider: String,
    pub(crate) plan_mode: bool,
    pub(crate) saved_at_ms: u64,
}

pub(crate) fn state_path() -> PathBuf {
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(data_home).join("cmux-home/state.json");
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local/share/cmux-home/state.json")
}

pub(crate) fn load_persisted_state(path: &PathBuf) -> PersistedState {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub(crate) fn load_config(path: Option<&PathBuf>) -> AppConfig {
    path.and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

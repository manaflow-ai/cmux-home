use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::{Frame, Terminal};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tui_textarea::{CursorMove, TextArea};

const COMPOSER_PLACEHOLDER: &str = "describe a task for a new workspace";
const COMPOSER_PROMPT: &str = "❯ ";

#[derive(Parser, Debug)]
#[command(about = "Minimal cmux workspace launcher and status TUI")]
struct Args {
    #[arg(long, env = "CMUX_SOCKET_PATH")]
    socket: Option<String>,

    #[arg(
        long,
        default_value = "codex {prompt}",
        env = "CMUX_AGENT_TUI_CODEX_COMMAND"
    )]
    codex_command: String,

    #[arg(
        long,
        default_value = "codex {prompt}",
        env = "CMUX_AGENT_TUI_CODEX_PLAN_COMMAND"
    )]
    codex_plan_command: String,

    #[arg(
        long,
        default_value = "claude {prompt}",
        env = "CMUX_AGENT_TUI_CLAUDE_COMMAND"
    )]
    claude_command: String,

    #[arg(
        long,
        default_value = "claude --permission-mode plan {prompt}",
        env = "CMUX_AGENT_TUI_CLAUDE_PLAN_COMMAND"
    )]
    claude_plan_command: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentKind {
    Codex,
    Claude,
}

impl AgentKind {
    fn toggle(self) -> Self {
        match self {
            AgentKind::Codex => AgentKind::Claude,
            AgentKind::Claude => AgentKind::Codex,
        }
    }

    fn label(self) -> &'static str {
        match self {
            AgentKind::Codex => "codex",
            AgentKind::Claude => "claude",
        }
    }

    fn from_label(label: &str) -> Option<Self> {
        match label {
            "codex" => Some(AgentKind::Codex),
            "claude" => Some(AgentKind::Claude),
            _ => None,
        }
    }

    fn color(self) -> Color {
        match self {
            AgentKind::Codex => Color::Rgb(102, 217, 239),
            AgentKind::Claude => Color::Rgb(215, 119, 87),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum AgentState {
    Empty,
    Idle,
    Working,
    NeedsAttention,
    Unknown,
}

impl AgentState {
    fn label(self) -> &'static str {
        match self {
            AgentState::Empty => "empty",
            AgentState::Idle => "idle",
            AgentState::Working => "working",
            AgentState::NeedsAttention => "needs attention",
            AgentState::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Default)]
struct WorkspaceStatus {
    id: String,
    title: String,
    latest_message: String,
    selected: bool,
    pinned: bool,
    statuses: HashMap<String, String>,
    unread_notifications: usize,
    updated_at: Option<Instant>,
}

impl WorkspaceStatus {
    fn agent_state(&self) -> AgentState {
        if self.unread_notifications > 0 {
            return AgentState::NeedsAttention;
        }

        let mut saw_status = false;
        for (key, value) in &self.statuses {
            let key = key.to_ascii_lowercase();
            let value = value.to_ascii_lowercase();
            let is_agent = key == "codex" || key == "claude" || key == "claude_code";
            if !is_agent {
                continue;
            }
            saw_status = true;
            if contains_any(
                &value,
                &[
                    "error", "failed", "failure", "blocked", "denied", "rejected",
                ],
            ) {
                return AgentState::NeedsAttention;
            }
            if contains_any(&value, &["running", "working", "thinking", "busy"]) {
                return AgentState::Working;
            }
            if contains_any(&value, &["idle", "done", "complete", "completed"]) {
                return AgentState::Idle;
            }
        }

        if saw_status {
            AgentState::Unknown
        } else {
            AgentState::Empty
        }
    }

    fn fingerprint(&self) -> String {
        let mut statuses = self
            .statuses
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>();
        statuses.sort();
        format!(
            "{}|{}|{}|{}|{}",
            self.title,
            self.latest_message,
            self.agent_state().label(),
            self.unread_notifications,
            statuses.join("|")
        )
    }
}

#[derive(Debug)]
enum UiEvent {
    CmuxEvent(EventFrame),
    Snapshot(Result<RefreshSnapshot, String>),
    WorkspaceSnapshot(Result<WorkspaceRefresh, String>),
    StreamError(String),
}

#[derive(Debug)]
enum RefreshRequest {
    All(String),
    Workspace {
        workspace_id: String,
        reason: String,
    },
}

#[derive(Debug)]
struct RefreshSnapshot {
    reason: String,
    workspaces: Vec<WorkspaceStatus>,
    loaded_at: Instant,
}

#[derive(Debug)]
struct WorkspaceRefresh {
    reason: String,
    workspace_id: String,
    workspace: Option<WorkspaceStatus>,
    loaded_at: Instant,
}

#[derive(Debug)]
enum KeyAction {
    Continue,
    Quit,
    Refresh(String),
}

struct App {
    socket_path: String,
    codex_template: String,
    codex_plan_template: String,
    claude_template: String,
    claude_plan_template: String,
    provider: AgentKind,
    plan_mode: bool,
    show_shortcuts: bool,
    workspaces: Vec<WorkspaceStatus>,
    selected: usize,
    list_scroll: usize,
    view_mode: ViewMode,
    image_paths: Vec<String>,
    stashes: Vec<PersistedDraft>,
    state_path: PathBuf,
    collapsed_groups: HashSet<AgentState>,
    composer: TextArea<'static>,
    composer_mode: ComposerMode,
    status_line: String,
    last_quit_tap: Option<(char, Instant)>,
    last_refresh: Option<Instant>,
    started_at: Instant,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ComposerMode {
    NewWorkspace,
    RenameWorkspace(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ViewMode {
    Workspaces,
    Stashes,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct PersistedState {
    draft: Option<PersistedDraft>,
    stashes: Vec<PersistedDraft>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    plan_mode: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PersistedDraft {
    lines: Vec<String>,
    image_paths: Vec<String>,
    provider: String,
    plan_mode: bool,
    saved_at_ms: u64,
}

impl App {
    fn new(args: Args) -> Self {
        let socket_path = args
            .socket
            .or_else(|| std::env::var("CMUX_SOCKET").ok())
            .unwrap_or_else(|| "/tmp/cmux.sock".to_string());
        let state_path = state_path();
        let persisted = load_persisted_state(&state_path);
        let mut app = Self {
            socket_path,
            codex_template: args.codex_command,
            codex_plan_template: args.codex_plan_command,
            claude_template: args.claude_command,
            claude_plan_template: args.claude_plan_command,
            provider: AgentKind::Codex,
            plan_mode: false,
            show_shortcuts: false,
            workspaces: Vec::new(),
            selected: 0,
            list_scroll: 0,
            view_mode: ViewMode::Workspaces,
            image_paths: Vec::new(),
            stashes: persisted.stashes,
            state_path,
            collapsed_groups: HashSet::new(),
            composer: new_composer(),
            composer_mode: ComposerMode::NewWorkspace,
            status_line: "starting".to_string(),
            last_quit_tap: None,
            last_refresh: None,
            started_at: Instant::now(),
        };
        if let Some(provider) = persisted
            .provider
            .as_deref()
            .and_then(AgentKind::from_label)
        {
            app.provider = provider;
        }
        if let Some(plan_mode) = persisted.plan_mode {
            app.plan_mode = plan_mode;
        }
        if let Some(draft) = persisted.draft {
            app.restore_draft(draft);
            app.status_line = "restored draft".to_string();
        }
        app
    }

    fn selected_workspace(&self) -> Option<&WorkspaceStatus> {
        if self.view_mode != ViewMode::Workspaces {
            return None;
        }
        self.selected_workspace_index()
            .and_then(|index| self.workspaces.get(index))
    }

    fn selected_workspace_index(&self) -> Option<usize> {
        if self.view_mode != ViewMode::Workspaces {
            return None;
        }
        match self.selected_visible_row()? {
            WorkspaceListRow::Workspace(index) => Some(index),
            WorkspaceListRow::Header(_, _) => None,
            WorkspaceListRow::Blank => None,
        }
    }

    fn selected_group(&self) -> Option<AgentState> {
        if self.view_mode != ViewMode::Workspaces {
            return None;
        }
        match self.selected_visible_row()? {
            WorkspaceListRow::Header(group, _) => Some(group),
            WorkspaceListRow::Workspace(_) => None,
            WorkspaceListRow::Blank => None,
        }
    }

    fn selected_visible_row(&self) -> Option<WorkspaceListRow> {
        visible_rows(&self.workspaces, &self.collapsed_groups)
            .into_iter()
            .nth(self.selected)
    }

    fn apply_refresh(&mut self, snapshot: RefreshSnapshot) {
        let previously_selected_id = self.selected_workspace().map(|ws| ws.id.clone());
        let previous = self
            .workspaces
            .iter()
            .map(|workspace| {
                (
                    workspace.id.clone(),
                    (workspace.fingerprint(), workspace.updated_at),
                )
            })
            .collect::<HashMap<_, _>>();
        self.workspaces = snapshot
            .workspaces
            .into_iter()
            .map(|mut workspace| {
                workspace.updated_at = previous
                    .get(&workspace.id)
                    .and_then(|(fingerprint, updated_at)| {
                        (fingerprint == &workspace.fingerprint()).then_some(*updated_at)
                    })
                    .flatten()
                    .or(Some(snapshot.loaded_at));
                workspace
            })
            .collect();
        if self.view_mode == ViewMode::Workspaces {
            let visible = visible_rows(&self.workspaces, &self.collapsed_groups);
            self.selected = previously_selected_id
                .and_then(|id| {
                    visible.iter().position(|row| match row {
                        WorkspaceListRow::Workspace(index) => {
                            self.workspaces.get(*index).map(|workspace| &workspace.id) == Some(&id)
                        }
                        WorkspaceListRow::Header(_, _) => false,
                        WorkspaceListRow::Blank => false,
                    })
                })
                .or_else(|| {
                    self.workspaces
                        .iter()
                        .position(|workspace| workspace.selected)
                        .and_then(|workspace_index| {
                            visible.iter().position(|row| {
                                matches!(row, WorkspaceListRow::Workspace(index) if *index == workspace_index)
                            })
                        })
                })
                .unwrap_or(0);
            if self.selected >= visible.len() {
                self.selected = visible.len().saturating_sub(1);
            }
        } else {
            self.selected = self.selected.min(self.stashes.len().saturating_sub(1));
        }
        self.clamp_list_scroll(1);
        self.last_refresh = Some(snapshot.loaded_at);
        self.status_line = format!("{} workspaces ({})", self.workspaces.len(), snapshot.reason);
    }

    fn apply_workspace_refresh(&mut self, snapshot: WorkspaceRefresh) {
        match snapshot.workspace {
            Some(mut refreshed) => {
                let previous = self
                    .workspaces
                    .iter()
                    .find(|workspace| workspace.id == refreshed.id);
                refreshed.updated_at = previous
                    .and_then(|workspace| {
                        (workspace.fingerprint() == refreshed.fingerprint())
                            .then_some(workspace.updated_at)
                    })
                    .flatten()
                    .or(Some(snapshot.loaded_at));
                if let Some(existing) = self
                    .workspaces
                    .iter_mut()
                    .find(|workspace| workspace.id == refreshed.id)
                {
                    *existing = refreshed;
                } else {
                    self.workspaces.push(refreshed);
                }
            }
            None => {
                self.workspaces
                    .retain(|workspace| workspace.id != snapshot.workspace_id);
            }
        }
        if self.view_mode == ViewMode::Workspaces {
            self.selected = self.selected.min(
                visible_rows(&self.workspaces, &self.collapsed_groups)
                    .len()
                    .saturating_sub(1),
            );
            self.clamp_list_scroll(1);
        }
        self.last_refresh = Some(snapshot.loaded_at);
        self.status_line = snapshot.reason;
    }

    fn apply_cmux_event(&mut self, frame: &EventFrame) -> Option<RefreshRequest> {
        match frame.name.as_deref() {
            Some("workspace.created") => {
                let Some(workspace_id) = event_workspace_id(frame) else {
                    return Some(RefreshRequest::All(event_name(frame)));
                };
                if self
                    .workspaces
                    .iter()
                    .any(|workspace| workspace.id == workspace_id)
                {
                    return None;
                }
                self.workspaces.push(WorkspaceStatus {
                    id: workspace_id.to_string(),
                    title: event_title(frame)
                        .unwrap_or_else(|| workspace_id.chars().take(8).collect()),
                    latest_message: event_description(frame)
                        .unwrap_or_else(|| "standing by for task".to_string()),
                    selected: frame
                        .payload
                        .get("selected")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    pinned: false,
                    statuses: HashMap::new(),
                    unread_notifications: 0,
                    updated_at: Some(Instant::now()),
                });
                Some(RefreshRequest::Workspace {
                    workspace_id: workspace_id.to_string(),
                    reason: "workspace created".to_string(),
                })
            }
            Some("workspace.selected") => {
                let selected_id = event_workspace_id(frame).map(str::to_string);
                let previous_id = frame
                    .payload
                    .get("previous_workspace_id")
                    .and_then(Value::as_str);
                for workspace in &mut self.workspaces {
                    if Some(workspace.id.as_str()) == selected_id.as_deref() {
                        workspace.selected = true;
                        if let Some(title) = event_title(frame) {
                            workspace.title = title;
                        }
                    } else if Some(workspace.id.as_str()) == previous_id {
                        workspace.selected = false;
                    }
                }
                None
            }
            Some("workspace.renamed") => {
                let workspace_id = frame
                    .payload
                    .pointer("/result/workspace_id")
                    .and_then(Value::as_str)
                    .or(frame.workspace_id.as_deref());
                let title = frame
                    .payload
                    .pointer("/result/title")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        frame
                            .payload
                            .pointer("/params/title")
                            .and_then(Value::as_str)
                    });
                let (Some(workspace_id), Some(title)) = (workspace_id, title) else {
                    return Some(RefreshRequest::All(event_name(frame)));
                };
                if let Some(workspace) = self
                    .workspaces
                    .iter_mut()
                    .find(|workspace| workspace.id == workspace_id)
                {
                    workspace.title = title.to_string();
                    workspace.updated_at = Some(Instant::now());
                    return None;
                }
                Some(RefreshRequest::Workspace {
                    workspace_id: workspace_id.to_string(),
                    reason: "workspace renamed".to_string(),
                })
            }
            Some("workspace.closed") | Some("workspace.deleted") => {
                let Some(workspace_id) = event_workspace_id(frame) else {
                    return Some(RefreshRequest::All(event_name(frame)));
                };
                self.workspaces
                    .retain(|workspace| workspace.id != workspace_id);
                if self.view_mode == ViewMode::Workspaces {
                    self.selected = self.selected.min(
                        visible_rows(&self.workspaces, &self.collapsed_groups)
                            .len()
                            .saturating_sub(1),
                    );
                    self.clamp_list_scroll(1);
                }
                None
            }
            Some("workspace.action") => {
                if self.patch_workspace_action(frame) {
                    None
                } else {
                    event_workspace_id(frame).map(|workspace_id| RefreshRequest::Workspace {
                        workspace_id: workspace_id.to_string(),
                        reason: "workspace action".to_string(),
                    })
                }
            }
            Some("notification.created") => {
                if notification_is_unread(frame) {
                    self.adjust_unread(event_workspace_id(frame), 1);
                }
                None
            }
            Some("notification.removed") => {
                if notification_is_unread(frame) {
                    self.adjust_unread(event_workspace_id(frame), -1);
                }
                None
            }
            Some("notification.read") | Some("notification.cleared") => {
                let count = frame
                    .payload
                    .get("count")
                    .and_then(Value::as_i64)
                    .unwrap_or(1);
                self.adjust_unread(event_workspace_id(frame), -count);
                None
            }
            Some("sidebar.metadata.updated") => {
                if self.patch_sidebar_status(frame, true) {
                    None
                } else {
                    event_workspace_id(frame).map(|workspace_id| RefreshRequest::Workspace {
                        workspace_id: workspace_id.to_string(),
                        reason: "sidebar updated".to_string(),
                    })
                }
            }
            Some("sidebar.metadata.cleared") | Some("sidebar.reset") => {
                if self.patch_sidebar_status(frame, false) {
                    None
                } else {
                    event_workspace_id(frame).map(|workspace_id| RefreshRequest::Workspace {
                        workspace_id: workspace_id.to_string(),
                        reason: "sidebar cleared".to_string(),
                    })
                }
            }
            Some("surface.input_sent")
            | Some("surface.key_sent")
            | Some("surface.created")
            | Some("surface.closed")
            | Some("surface.selected")
            | Some("surface.focused")
            | Some("surface.action")
            | Some("surface.moved")
            | Some("surface.reordered")
            | Some("pane.created")
            | Some("pane.closed")
            | Some("pane.focused")
            | Some("pane.resized")
            | Some("pane.swapped")
            | Some("pane.broken")
            | Some("pane.joined") => {
                event_workspace_id(frame).map(|workspace_id| RefreshRequest::Workspace {
                    workspace_id: workspace_id.to_string(),
                    reason: event_name(frame),
                })
            }
            Some(_) => Some(RefreshRequest::All(event_name(frame))),
            None => Some(RefreshRequest::All("event".to_string())),
        }
    }

    fn adjust_unread(&mut self, workspace_id: Option<&str>, delta: i64) -> bool {
        let Some(workspace_id) = workspace_id else {
            return false;
        };
        let Some(workspace) = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
        else {
            return false;
        };
        if delta >= 0 {
            workspace.unread_notifications = workspace
                .unread_notifications
                .saturating_add(delta as usize);
        } else {
            workspace.unread_notifications = workspace
                .unread_notifications
                .saturating_sub(delta.unsigned_abs() as usize);
        }
        workspace.updated_at = Some(Instant::now());
        true
    }

    fn patch_sidebar_status(&mut self, frame: &EventFrame, updated: bool) -> bool {
        let Some(workspace_id) = event_workspace_id(frame) else {
            return false;
        };
        let Some(workspace) = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
        else {
            return false;
        };
        if frame.name.as_deref() == Some("sidebar.reset") {
            workspace.statuses.clear();
            workspace.updated_at = Some(Instant::now());
            return true;
        }
        let Some(args) = frame.payload.get("args").and_then(Value::as_str) else {
            return false;
        };
        let words = shell_words(args);
        let Some(key) = words.first().cloned() else {
            return false;
        };
        if updated {
            let value = words.get(1).cloned().unwrap_or_default();
            workspace.statuses.insert(key, value);
        } else {
            workspace.statuses.remove(&key);
        }
        workspace.updated_at = Some(Instant::now());
        true
    }

    fn patch_workspace_action(&mut self, frame: &EventFrame) -> bool {
        let Some(workspace_id) = event_workspace_id(frame) else {
            return false;
        };
        let Some(action) = frame
            .payload
            .pointer("/params/action")
            .and_then(Value::as_str)
        else {
            return false;
        };
        let Some(workspace) = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
        else {
            return false;
        };
        match action {
            "pin" => workspace.pinned = true,
            "unpin" => workspace.pinned = false,
            _ => return false,
        }
        workspace.updated_at = Some(Instant::now());
        true
    }

    fn submit_new_workspace(&mut self) -> Result<()> {
        let prompt = self.composer.lines().join("\n").trim().to_string();
        let command = self.render_agent_command(&prompt);
        let title = if prompt.is_empty() {
            self.agent_label()
        } else {
            format!("{}: {}", self.agent_label(), one_line_preview(&prompt, 42))
        };
        let mut client = CmuxClient::new(self.socket_path.clone());
        let created = client.v2(
            "workspace.create",
            json!({
                "title": title,
                "description": prompt,
                "initial_command": command,
                "focus": false,
            }),
        )?;
        let workspace_id = string_field(&created, "workspace_id")
            .ok_or_else(|| anyhow!("workspace.create did not return workspace_id"))?;
        if !prompt.is_empty() {
            let _ = client.v2(
                "workspace.prompt_submit",
                json!({ "workspace_id": workspace_id, "message": prompt }),
            );
        }
        self.composer = new_composer();
        self.image_paths.clear();
        self.composer_mode = ComposerMode::NewWorkspace;
        self.status_line = format!("started {} workspace", self.agent_label());
        Ok(())
    }

    fn submit_rename_workspace(&mut self, workspace_id: String) -> Result<()> {
        let title = self.composer.lines().join(" ").trim().to_string();
        if title.is_empty() {
            self.status_line = "rename cancelled".to_string();
        } else {
            let mut client = CmuxClient::new(self.socket_path.clone());
            client.v2(
                "workspace.rename",
                json!({
                    "workspace_id": workspace_id,
                    "title": title,
                }),
            )?;
            if let Some(workspace) = self
                .workspaces
                .iter_mut()
                .find(|workspace| workspace.id == workspace_id)
            {
                workspace.title = title;
                workspace.updated_at = Some(Instant::now());
            }
            self.status_line = "renamed workspace".to_string();
        }
        self.reset_composer();
        Ok(())
    }

    fn begin_rename_selected_workspace(&mut self) -> bool {
        let Some(workspace) = self.selected_workspace().cloned() else {
            self.status_line = "select a workspace to rename".to_string();
            return false;
        };
        self.composer = composer_from_lines(vec![workspace.title]);
        self.composer.select_all();
        self.composer_mode = ComposerMode::RenameWorkspace(workspace.id);
        self.status_line = "renaming workspace".to_string();
        true
    }

    fn toggle_pin_selected_workspace(&mut self) -> Result<()> {
        let Some(workspace) = self.selected_workspace().cloned() else {
            self.status_line = "select a workspace to pin".to_string();
            return Ok(());
        };
        let action = if workspace.pinned { "unpin" } else { "pin" };
        let mut client = CmuxClient::new(self.socket_path.clone());
        client.v2(
            "workspace.action",
            json!({
                "workspace_id": workspace.id,
                "action": action,
            }),
        )?;
        self.status_line = format!("{action}ned workspace");
        Ok(())
    }

    fn reset_composer(&mut self) {
        self.composer = new_composer();
        self.image_paths.clear();
        self.composer_mode = ComposerMode::NewWorkspace;
    }

    fn restore_latest_stash(&mut self) {
        let Some(draft) = self.stashes.last().cloned() else {
            self.status_line = "no stashes".to_string();
            return;
        };
        let count = self.stashes.len();
        self.restore_draft(draft);
        self.view_mode = ViewMode::Workspaces;
        self.selected = 0;
        self.list_scroll = 0;
        self.status_line = format!("restored stash {count}");
    }

    fn restore_selected_stash(&mut self) {
        let Some(draft) = self.stashes.get(self.selected).cloned() else {
            self.status_line = "select a stash".to_string();
            return;
        };
        let count = self.selected + 1;
        self.restore_draft(draft);
        self.view_mode = ViewMode::Workspaces;
        self.selected = 0;
        self.list_scroll = 0;
        self.status_line = format!("restored stash {count}");
    }

    fn open_stash_view(&mut self) {
        self.view_mode = ViewMode::Stashes;
        self.selected = self.selected.min(self.stashes.len().saturating_sub(1));
        self.list_scroll = 0;
        self.status_line = format!("{} stashes", self.stashes.len());
    }

    fn open_workspace_view(&mut self) {
        self.view_mode = ViewMode::Workspaces;
        self.selected = 0;
        self.list_scroll = 0;
        self.status_line = "main".to_string();
    }

    fn restore_draft(&mut self, draft: PersistedDraft) {
        self.composer = composer_from_lines(non_empty_lines(draft.lines));
        self.image_paths = draft.image_paths;
        self.provider = AgentKind::from_label(&draft.provider).unwrap_or(AgentKind::Codex);
        self.plan_mode = draft.plan_mode;
        self.composer_mode = ComposerMode::NewWorkspace;
    }

    fn current_draft(&self) -> Option<PersistedDraft> {
        if !self.composer_has_input() && self.image_paths.is_empty() {
            return None;
        }
        Some(PersistedDraft {
            lines: self.composer.lines().to_vec(),
            image_paths: self.image_paths.clone(),
            provider: self.provider.label().to_string(),
            plan_mode: self.plan_mode,
            saved_at_ms: now_millis(),
        })
    }

    fn persist_state(&self) {
        let state = PersistedState {
            draft: self.current_draft(),
            stashes: self.stashes.clone(),
            provider: Some(self.provider.label().to_string()),
            plan_mode: Some(self.plan_mode),
        };
        if let Some(parent) = self.state_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(&state) {
            let _ = fs::write(&self.state_path, bytes);
        }
    }

    fn open_selected_workspace(&mut self) -> Result<()> {
        let Some(workspace_id) = self
            .selected_workspace()
            .map(|workspace| workspace.id.clone())
        else {
            return Ok(());
        };
        let mut client = CmuxClient::new(self.socket_path.clone());
        client.v2(
            "workspace.select",
            json!({
                "workspace_id": workspace_id,
            }),
        )?;
        Ok(())
    }

    fn open_visible_selectable(&mut self, ordinal: usize) -> Result<bool> {
        let rows = visible_rows(&self.workspaces, &self.collapsed_groups);
        let Some(row_index) = rows
            .iter()
            .enumerate()
            .filter(|(_, row)| matches!(row, WorkspaceListRow::Workspace(_)))
            .nth(ordinal.saturating_sub(1))
            .map(|(index, _)| index)
        else {
            return Ok(false);
        };
        self.selected = row_index;
        self.open_selected_workspace()?;
        Ok(true)
    }

    fn record_quit_tap(&mut self, ch: char) -> bool {
        let now = Instant::now();
        let should_quit = self
            .last_quit_tap
            .map(|(last_ch, last_at)| {
                last_ch == ch && now.duration_since(last_at) <= Duration::from_millis(700)
            })
            .unwrap_or(false);
        self.last_quit_tap = Some((ch, now));
        if !should_quit {
            self.status_line = format!("press ctrl+{ch} to quit");
        }
        should_quit
    }

    fn composer_has_text(&self) -> bool {
        self.composer
            .lines()
            .iter()
            .any(|line| !line.trim().is_empty())
    }

    fn composer_has_input(&self) -> bool {
        self.composer.lines().len() > 1 || self.composer.lines().iter().any(|line| !line.is_empty())
    }

    fn composer_is_active(&self) -> bool {
        self.composer_has_input() || matches!(self.composer_mode, ComposerMode::RenameWorkspace(_))
    }

    fn composer_height(&self, screen_height: u16) -> u16 {
        if self.composer_is_active() {
            let max_height = ((u32::from(screen_height) * 3) / 4).max(1) as u16;
            (self.composer.lines().len() as u16).clamp(1, max_height)
        } else {
            1
        }
    }

    fn help_height(&self) -> u16 {
        if self.show_shortcuts {
            2
        } else {
            1
        }
    }

    fn bottom_reserved_height(&self, screen_height: u16) -> u16 {
        self.composer_height(screen_height) + self.help_height() + 2
    }

    fn select_previous(&mut self) {
        if self.view_mode == ViewMode::Stashes {
            self.selected = self.selected.saturating_sub(1);
            return;
        }
        let rows = visible_rows(&self.workspaces, &self.collapsed_groups);
        self.selected = selectable_row_before(&rows, self.selected).unwrap_or(self.selected);
    }

    fn select_next(&mut self) {
        if self.view_mode == ViewMode::Stashes {
            self.selected = self
                .selected
                .saturating_add(1)
                .min(self.stashes.len().saturating_sub(1));
            return;
        }
        let rows = visible_rows(&self.workspaces, &self.collapsed_groups);
        self.selected = selectable_row_after(&rows, self.selected).unwrap_or(self.selected);
    }

    fn scroll_list(&mut self, delta: isize, viewport_height: u16) {
        let max_scroll = self.max_list_scroll(viewport_height);
        self.list_scroll = if delta.is_negative() {
            self.list_scroll.saturating_sub(delta.unsigned_abs())
        } else {
            self.list_scroll
                .saturating_add(delta as usize)
                .min(max_scroll)
        };
    }

    fn clamp_list_scroll(&mut self, viewport_height: u16) {
        self.list_scroll = self.list_scroll.min(self.max_list_scroll(viewport_height));
    }

    fn ensure_selected_visible(&mut self, viewport_height: u16) {
        let height = usize::from(viewport_height.max(1));
        if self.selected < self.list_scroll {
            self.list_scroll = self.selected;
        } else if self.selected >= self.list_scroll.saturating_add(height) {
            self.list_scroll = self.selected.saturating_add(1).saturating_sub(height);
        }
        self.clamp_list_scroll(viewport_height);
    }

    fn max_list_scroll(&self, viewport_height: u16) -> usize {
        if self.view_mode == ViewMode::Stashes {
            let rows = usize::from(viewport_height.saturating_sub(1).max(1));
            return self.stashes.len().saturating_sub(rows);
        }
        visible_rows(&self.workspaces, &self.collapsed_groups)
            .len()
            .saturating_sub(usize::from(viewport_height.max(1)))
    }

    fn toggle_selected_group(&mut self) -> bool {
        let Some(group) = self.selected_group() else {
            return false;
        };
        if !self.collapsed_groups.insert(group) {
            self.collapsed_groups.remove(&group);
        }
        let max = visible_rows(&self.workspaces, &self.collapsed_groups)
            .len()
            .saturating_sub(1);
        self.selected = self.selected.min(max);
        true
    }

    fn agent_label(&self) -> String {
        if self.plan_mode {
            format!("{} plan", self.provider.label())
        } else {
            self.provider.label().to_string()
        }
    }

    fn provider_toggle_label(&self) -> &'static str {
        self.provider.toggle().label()
    }

    fn provider_toggle_kind(&self) -> AgentKind {
        self.provider.toggle()
    }

    fn plan_toggle_label(&self) -> &'static str {
        if self.plan_mode {
            "build"
        } else {
            "plan"
        }
    }

    fn render_agent_command(&self, prompt: &str) -> String {
        let template = match self.provider {
            AgentKind::Codex if self.plan_mode => &self.codex_plan_template,
            AgentKind::Codex => &self.codex_template,
            AgentKind::Claude if self.plan_mode => &self.claude_plan_template,
            AgentKind::Claude => &self.claude_template,
        };
        let prompt = self.command_prompt(prompt);
        let rendered = template.replace("{prompt}", &shell_quote(&prompt));
        rendered.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn command_prompt(&self, prompt: &str) -> String {
        if self.plan_mode && self.provider == AgentKind::Codex && !prompt.is_empty() {
            format!(
                "Plan mode: propose a concise implementation plan first. Do not edit files or run mutating commands until the user approves.\n\n{prompt}"
            )
        } else {
            prompt.to_string()
        }
    }
}

fn new_composer() -> TextArea<'static> {
    let mut composer = TextArea::default();
    composer.set_placeholder_text("");
    composer.set_cursor_line_style(Style::default());
    composer
}

fn composer_from_lines(lines: Vec<String>) -> TextArea<'static> {
    let mut composer = TextArea::new(lines);
    composer.set_placeholder_text("");
    composer.set_cursor_line_style(Style::default());
    composer
}

fn non_empty_lines(mut lines: Vec<String>) -> Vec<String> {
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn state_path() -> PathBuf {
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(data_home).join("cmux-home/state.json");
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local/share/cmux-home/state.json")
}

fn load_persisted_state(path: &PathBuf) -> PersistedState {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

struct CmuxClient {
    path: String,
}

impl CmuxClient {
    fn new(path: String) -> Self {
        Self { path }
    }

    fn v2(&mut self, method: &str, params: Value) -> Result<Value> {
        let request = json!({
            "id": format!("cmux-home-{}", method),
            "method": method,
            "params": params,
        });
        let response = self.send_line(&request.to_string())?;
        let value: Value = serde_json::from_str(response.trim())
            .with_context(|| format!("invalid JSON response for {method}: {response}"))?;
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            bail!("{} failed: {}", method, value);
        }
        Ok(value.get("result").cloned().unwrap_or(Value::Null))
    }

    fn v1(&mut self, command: &str) -> Result<String> {
        self.send_line(command)
    }

    fn send_line(&mut self, line: &str) -> Result<String> {
        let mut stream =
            UnixStream::connect(&self.path).with_context(|| format!("connect {}", self.path))?;
        stream
            .set_read_timeout(Some(Duration::from_millis(1500)))
            .context("set read timeout")?;
        stream
            .write_all(format!("{line}\n").as_bytes())
            .context("write socket command")?;

        let mut response = Vec::new();
        let mut buf = [0_u8; 4096];
        let mut saw_newline = false;
        loop {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    response.extend_from_slice(&buf[..n]);
                    if response.contains(&b'\n') {
                        saw_newline = true;
                        if is_complete_single_line_response(&response) {
                            break;
                        }
                        stream
                            .set_read_timeout(Some(Duration::from_millis(120)))
                            .ok();
                    }
                }
                Err(err)
                    if err.kind() == std::io::ErrorKind::WouldBlock
                        || err.kind() == std::io::ErrorKind::TimedOut =>
                {
                    if saw_newline {
                        break;
                    }
                    return Err(err).context("read socket response");
                }
                Err(err) => return Err(err).context("read socket response"),
            }
        }
        String::from_utf8(response).context("socket response was not UTF-8")
    }
}

fn main() -> Result<()> {
    let args = Args::parse();
    let mut app = App::new(args);
    let (ui_tx, ui_rx) = mpsc::channel();
    let (refresh_tx, refresh_rx) = mpsc::channel();
    spawn_event_stream(app.socket_path.clone(), ui_tx.clone());
    spawn_refresh_worker(app.socket_path.clone(), refresh_rx, ui_tx);
    let _ = refresh_tx.send(RefreshRequest::All("startup".to_string()));

    run_tui(&mut app, ui_rx, refresh_tx)
}

fn run_tui(app: &mut App, rx: Receiver<UiEvent>, refresh_tx: Sender<RefreshRequest>) -> Result<()> {
    enable_raw_mode().context("enable raw mode")?;
    let mut stdout = std::io::stdout();
    execute!(
        stdout,
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste
    )
    .context("enter alternate screen")?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).context("create terminal")?;

    let result = (|| -> Result<()> {
        let mut pending_refresh: Option<RefreshRequest> = None;
        let mut last_refresh_request = Instant::now();
        loop {
            terminal.draw(|frame| draw(frame, app))?;

            while let Ok(ui_event) = rx.try_recv() {
                match ui_event {
                    UiEvent::CmuxEvent(frame) => {
                        pending_refresh =
                            merge_refresh_request(pending_refresh, app.apply_cmux_event(&frame));
                    }
                    UiEvent::Snapshot(Ok(snapshot)) => app.apply_refresh(snapshot),
                    UiEvent::Snapshot(Err(err)) => {
                        app.status_line = format!("refresh failed: {err}");
                    }
                    UiEvent::WorkspaceSnapshot(Ok(snapshot)) => {
                        app.apply_workspace_refresh(snapshot)
                    }
                    UiEvent::WorkspaceSnapshot(Err(err)) => {
                        app.status_line = format!("refresh failed: {err}");
                    }
                    UiEvent::StreamError(err) => app.status_line = format!("event stream: {err}"),
                }
            }

            if event::poll(Duration::from_millis(16))? {
                match event::read()? {
                    Event::Key(key) => {
                        if key.kind != KeyEventKind::Press {
                            continue;
                        }
                        match handle_key(app, key)? {
                            KeyAction::Continue => {}
                            KeyAction::Quit => break,
                            KeyAction::Refresh(reason) => {
                                pending_refresh = merge_refresh_request(
                                    pending_refresh,
                                    Some(RefreshRequest::All(reason)),
                                );
                            }
                        }
                        app.persist_state();
                    }
                    Event::Mouse(mouse) => {
                        let size = terminal.size()?;
                        handle_mouse(app, mouse, Rect::new(0, 0, size.width, size.height));
                    }
                    Event::Paste(text) => {
                        handle_paste(app, &text);
                        app.persist_state();
                    }
                    _ => {}
                }
            }

            if pending_refresh.is_some()
                && last_refresh_request.elapsed() >= Duration::from_millis(250)
            {
                if let Some(reason) = pending_refresh.take() {
                    let _ = refresh_tx.send(reason);
                    last_refresh_request = Instant::now();
                }
            }
        }
        Ok(())
    })();

    disable_raw_mode().ok();
    execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        DisableBracketedPaste,
        LeaveAlternateScreen
    )
    .ok();
    terminal.show_cursor().ok();
    result
}

fn handle_key(app: &mut App, key: KeyEvent) -> Result<KeyAction> {
    match key {
        KeyEvent {
            code: KeyCode::Char(ch @ ('c' | 'd')),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            return if app.record_quit_tap(ch) {
                Ok(KeyAction::Quit)
            } else {
                Ok(KeyAction::Continue)
            };
        }
        KeyEvent {
            code: KeyCode::Char('q'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => return Ok(KeyAction::Quit),
        KeyEvent {
            code: KeyCode::Char('s'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            if app.view_mode == ViewMode::Stashes {
                app.restore_selected_stash();
            } else {
                app.restore_latest_stash();
            }
        }
        KeyEvent {
            code: KeyCode::Char('y'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            app.restore_latest_stash();
        }
        KeyEvent {
            code: KeyCode::Esc, ..
        } if app.show_shortcuts => {
            app.show_shortcuts = false;
            if app.view_mode != ViewMode::Workspaces {
                app.open_workspace_view();
            }
        }
        KeyEvent {
            code: KeyCode::Esc, ..
        } if app.view_mode == ViewMode::Stashes => {
            app.open_workspace_view();
        }
        _ if app.composer_is_active() => return handle_composer_key(app, key),
        KeyEvent {
            code: KeyCode::Char('r'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            app.begin_rename_selected_workspace();
        }
        KeyEvent {
            code: KeyCode::Char('t'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            app.toggle_pin_selected_workspace()?;
            return Ok(KeyAction::Refresh("pin toggled".to_string()));
        }
        KeyEvent {
            code: KeyCode::Char(ch @ '1'..='6'),
            modifiers: KeyModifiers::ALT,
            ..
        } => {
            let ordinal = ch.to_digit(10).unwrap_or(0) as usize;
            if app.open_visible_selectable(ordinal)? {
                return Ok(KeyAction::Continue);
            }
        }
        KeyEvent {
            code: KeyCode::Char('?'),
            modifiers: KeyModifiers::NONE,
            ..
        } if !app.composer_is_active() => {
            app.show_shortcuts = !app.show_shortcuts;
        }
        KeyEvent {
            code: KeyCode::BackTab,
            ..
        }
        | KeyEvent {
            code: KeyCode::Tab,
            modifiers: KeyModifiers::SHIFT,
            ..
        } => {
            if app.composer_is_active() {
                app.composer.insert_newline();
            } else {
                app.plan_mode = !app.plan_mode;
            }
        }
        KeyEvent {
            code: KeyCode::Char('j'),
            modifiers: KeyModifiers::CONTROL,
            ..
        }
        | KeyEvent {
            code: KeyCode::Enter,
            modifiers: KeyModifiers::SHIFT,
            ..
        } => {
            app.composer.insert_newline();
        }
        KeyEvent {
            code: KeyCode::Tab, ..
        } => {
            app.provider = app.provider.toggle();
        }
        KeyEvent {
            code: KeyCode::Backspace,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !delete_image_token_before_cursor(&mut app.composer) {
                app.composer.input(key);
            }
        }
        KeyEvent {
            code: KeyCode::Delete,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !delete_image_token_after_cursor(&mut app.composer) {
                app.composer.input(key);
            }
        }
        KeyEvent {
            code: KeyCode::Left,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !move_across_image_token(&mut app.composer, CursorMove::Back) {
                app.composer.input(key);
            }
        }
        KeyEvent {
            code: KeyCode::Right,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !move_across_image_token(&mut app.composer, CursorMove::Forward) {
                app.composer.input(key);
            }
        }
        KeyEvent {
            code: KeyCode::Up,
            modifiers: KeyModifiers::NONE,
            ..
        }
        | KeyEvent {
            code: KeyCode::Char('p'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            app.select_previous();
        }
        KeyEvent {
            code: KeyCode::Down,
            modifiers: KeyModifiers::NONE,
            ..
        }
        | KeyEvent {
            code: KeyCode::Char('n'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            app.select_next();
        }
        KeyEvent {
            code: KeyCode::Enter,
            modifiers: KeyModifiers::NONE,
            ..
        } if app.view_mode == ViewMode::Stashes => {
            app.restore_selected_stash();
        }
        KeyEvent {
            code: KeyCode::Enter,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if app.composer_has_text() {
                app.submit_new_workspace()?;
                return Ok(KeyAction::Refresh("workspace created".to_string()));
            }
            if app.toggle_selected_group() {
                return Ok(KeyAction::Continue);
            }
            app.open_selected_workspace()?;
        }
        KeyEvent {
            code: KeyCode::Esc, ..
        } if app.composer_is_active() => {
            app.reset_composer();
        }
        KeyEvent {
            code: KeyCode::Char('x'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            app.status_line = if app.selected_group().is_some() {
                "delete all is not wired yet".to_string()
            } else {
                "delete is not wired yet".to_string()
            };
        }
        _ => {
            app.composer.input(key);
            normalize_composer_image_paths(app);
        }
    }
    Ok(KeyAction::Continue)
}

fn handle_composer_key(app: &mut App, key: KeyEvent) -> Result<KeyAction> {
    match key {
        KeyEvent {
            code: KeyCode::Enter,
            modifiers: KeyModifiers::NONE,
            ..
        } => match app.composer_mode.clone() {
            ComposerMode::NewWorkspace if app.composer_has_text() => {
                if handle_composer_command(app) {
                    return Ok(KeyAction::Continue);
                }
                app.submit_new_workspace()?;
                return Ok(KeyAction::Refresh("workspace created".to_string()));
            }
            ComposerMode::RenameWorkspace(workspace_id) => {
                app.submit_rename_workspace(workspace_id)?;
                return Ok(KeyAction::Refresh("workspace renamed".to_string()));
            }
            ComposerMode::NewWorkspace => {}
        },
        KeyEvent {
            code: KeyCode::Char('j'),
            modifiers: KeyModifiers::CONTROL,
            ..
        }
        | KeyEvent {
            code: KeyCode::Enter,
            modifiers: KeyModifiers::SHIFT,
            ..
        } => {
            app.composer.insert_newline();
        }
        KeyEvent {
            code: KeyCode::BackTab,
            ..
        }
        | KeyEvent {
            code: KeyCode::Tab,
            modifiers: KeyModifiers::SHIFT,
            ..
        } => {
            app.plan_mode = !app.plan_mode;
        }
        KeyEvent {
            code: KeyCode::Tab, ..
        } => {
            app.provider = app.provider.toggle();
        }
        KeyEvent {
            code: KeyCode::Esc, ..
        } => {
            app.reset_composer();
        }
        KeyEvent {
            code: KeyCode::Backspace,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !delete_image_token_before_cursor(&mut app.composer) {
                app.composer.input(key);
            }
        }
        KeyEvent {
            code: KeyCode::Delete,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !delete_image_token_after_cursor(&mut app.composer) {
                app.composer.input(key);
            }
        }
        KeyEvent {
            code: KeyCode::Left,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !move_across_image_token(&mut app.composer, CursorMove::Back) {
                app.composer.input(key);
            }
        }
        KeyEvent {
            code: KeyCode::Right,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !move_across_image_token(&mut app.composer, CursorMove::Forward) {
                app.composer.input(key);
            }
        }
        KeyEvent {
            code: KeyCode::Char(' '),
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !open_image_token_at_cursor(app) {
                app.composer.input(key);
                normalize_composer_image_paths(app);
            }
        }
        KeyEvent {
            code: KeyCode::Char('a'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            move_to_line_start_or_previous_line(&mut app.composer);
        }
        KeyEvent {
            code: KeyCode::Char('e'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            move_to_line_end_or_next_line(&mut app.composer);
        }
        _ => {
            app.composer.input(key);
            normalize_composer_image_paths(app);
        }
    }
    Ok(KeyAction::Continue)
}

fn handle_composer_command(app: &mut App) -> bool {
    if app.composer_mode != ComposerMode::NewWorkspace {
        return false;
    }

    let text = app.composer.lines().join("\n").trim().to_string();
    if text == "/stash" {
        app.reset_composer();
        app.open_stash_view();
        return true;
    }

    if text == "/stash save" {
        app.status_line = "nothing to stash".to_string();
        return true;
    }

    if let Some(rest) = text.strip_prefix("/stash save ") {
        let draft_text = rest.trim();
        if draft_text.is_empty() {
            app.status_line = "nothing to stash".to_string();
        } else {
            app.stashes.push(PersistedDraft {
                lines: draft_text.lines().map(str::to_string).collect(),
                image_paths: Vec::new(),
                provider: app.provider.label().to_string(),
                plan_mode: app.plan_mode,
                saved_at_ms: now_millis(),
            });
            app.reset_composer();
            app.status_line = format!("stashed draft {}", app.stashes.len());
        }
        return true;
    }

    false
}

fn handle_mouse(app: &mut App, mouse: MouseEvent, area: Rect) {
    let reserved_bottom = app.bottom_reserved_height(area.height);
    let workspace_end = area.height.saturating_sub(reserved_bottom);
    if mouse.row >= workspace_end {
        return;
    }

    match mouse.kind {
        MouseEventKind::ScrollUp => {
            app.scroll_list(-3, workspace_end);
        }
        MouseEventKind::ScrollDown => {
            app.scroll_list(3, workspace_end);
        }
        MouseEventKind::Down(MouseButton::Left) => {
            if app.view_mode == ViewMode::Stashes {
                if mouse.row > 0 {
                    let row = app
                        .list_scroll
                        .saturating_add(usize::from(mouse.row.saturating_sub(1)));
                    app.selected = row.min(app.stashes.len().saturating_sub(1));
                }
                return;
            }
            let visible_index = app.list_scroll.saturating_add(usize::from(mouse.row));
            if matches!(
                visible_rows(&app.workspaces, &app.collapsed_groups)
                    .into_iter()
                    .nth(visible_index),
                Some(WorkspaceListRow::Header(_, _) | WorkspaceListRow::Workspace(_))
            ) {
                app.selected = visible_index;
            }
        }
        _ => {}
    }
}

fn handle_paste(app: &mut App, text: &str) {
    let words = shell_words(text);
    let mut saw_image = false;
    let mut rendered = Vec::new();
    for word in words {
        let path = normalize_pasted_path(&word);
        if is_image_path(&path) {
            app.image_paths.push(path);
            rendered.push(format!("[Image #{}]", app.image_paths.len()));
            saw_image = true;
        } else {
            rendered.push(word);
        }
    }

    if saw_image {
        app.composer.insert_str(rendered.join(" "));
    } else {
        app.composer.insert_str(text);
    }
}

fn normalize_composer_image_paths(app: &mut App) {
    let (cursor_row, _) = app.composer.cursor();
    let mut changed = false;
    let mut cursor_col = 0;
    let lines = app
        .composer
        .lines()
        .iter()
        .enumerate()
        .map(|(row, line)| {
            let words = shell_words(line);
            let mut saw_image = false;
            let mut rendered = Vec::new();
            for word in words {
                let path = normalize_pasted_path(&word);
                if is_image_path(&path) {
                    app.image_paths.push(path);
                    rendered.push(format!("[Image #{}]", app.image_paths.len()));
                    saw_image = true;
                } else {
                    rendered.push(word);
                }
            }
            if saw_image {
                changed = true;
                let next = rendered.join(" ");
                if row == cursor_row {
                    cursor_col = next.chars().count();
                }
                next
            } else {
                if row == cursor_row {
                    cursor_col = line.chars().count();
                }
                line.clone()
            }
        })
        .collect::<Vec<_>>();

    if !changed {
        return;
    }

    app.composer = composer_from_lines(lines);
    for _ in 0..cursor_row {
        app.composer.move_cursor(CursorMove::Down);
    }
    for _ in 0..cursor_col {
        app.composer.move_cursor(CursorMove::Forward);
    }
}

fn shell_words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in text.trim().chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if quote == Some(ch) {
            quote = None;
            continue;
        }
        if quote.is_none() && (ch == '\'' || ch == '"') {
            quote = Some(ch);
            continue;
        }
        if quote.is_none() && ch.is_whitespace() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn normalize_pasted_path(word: &str) -> String {
    let trimmed = word.trim().trim_matches(['\r', '\n']);
    if let Some(rest) = trimmed.strip_prefix("file://") {
        percent_decode(rest)
    } else {
        trimmed.to_string()
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push(hi * 16 + lo);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).unwrap_or_else(|_| text.to_string())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn is_image_path(path: &str) -> bool {
    let path = std::path::Path::new(path);
    if !path.is_file() {
        return false;
    }
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "heif" | "tiff" | "bmp"
            )
        })
        .unwrap_or(false)
}

fn delete_image_token_before_cursor(textarea: &mut TextArea<'static>) -> bool {
    let Some((line, _, col)) = composer_line_at_cursor(textarea) else {
        return false;
    };
    let Some((start, end)) = image_token_ranges(&line)
        .into_iter()
        .find(|(start, end)| col > *start && col <= *end)
    else {
        return false;
    };
    delete_current_line_range(textarea, col, start, end);
    true
}

fn delete_image_token_after_cursor(textarea: &mut TextArea<'static>) -> bool {
    let Some((line, _, col)) = composer_line_at_cursor(textarea) else {
        return false;
    };
    let Some((start, end)) = image_token_ranges(&line)
        .into_iter()
        .find(|(start, end)| col >= *start && col < *end)
    else {
        return false;
    };
    delete_current_line_range(textarea, col, start, end);
    true
}

fn move_across_image_token(textarea: &mut TextArea<'static>, movement: CursorMove) -> bool {
    let Some((line, _, col)) = composer_line_at_cursor(textarea) else {
        return false;
    };
    let ranges = image_token_ranges(&line);
    match movement {
        CursorMove::Back => {
            if let Some((start, _)) = ranges
                .into_iter()
                .find(|(start, end)| col > *start && col <= *end)
            {
                move_cursor_to_col(textarea, col, start);
                return true;
            }
        }
        CursorMove::Forward => {
            if let Some((_, end)) = ranges
                .into_iter()
                .find(|(start, end)| col >= *start && col < *end)
            {
                move_cursor_to_col(textarea, col, end);
                return true;
            }
        }
        _ => {}
    }
    false
}

fn composer_line_at_cursor(textarea: &TextArea<'static>) -> Option<(String, usize, usize)> {
    let (row, col) = textarea.cursor();
    textarea
        .lines()
        .get(row)
        .map(|line| (line.clone(), row, col))
}

fn delete_current_line_range(
    textarea: &mut TextArea<'static>,
    current_col: usize,
    start: usize,
    end: usize,
) {
    move_cursor_to_col(textarea, current_col, start);
    for _ in start..end {
        textarea.delete_next_char();
    }
}

fn move_cursor_to_col(textarea: &mut TextArea<'static>, current_col: usize, target_col: usize) {
    if current_col > target_col {
        for _ in target_col..current_col {
            textarea.move_cursor(CursorMove::Back);
        }
    } else {
        for _ in current_col..target_col {
            textarea.move_cursor(CursorMove::Forward);
        }
    }
}

fn move_to_line_start_or_previous_line(textarea: &mut TextArea<'static>) {
    let Some((_, row, col)) = composer_line_at_cursor(textarea) else {
        return;
    };
    if col == 0 && row > 0 {
        textarea.move_cursor(CursorMove::Up);
        textarea.move_cursor(CursorMove::Head);
    } else {
        textarea.move_cursor(CursorMove::Head);
    }
}

fn move_to_line_end_or_next_line(textarea: &mut TextArea<'static>) {
    let Some((line, row, col)) = composer_line_at_cursor(textarea) else {
        return;
    };
    let line_len = line.chars().count();
    if col == line_len && row + 1 < textarea.lines().len() {
        textarea.move_cursor(CursorMove::Down);
        textarea.move_cursor(CursorMove::End);
    } else {
        textarea.move_cursor(CursorMove::End);
    }
}

fn open_image_token_at_cursor(app: &mut App) -> bool {
    let Some(image_index) = image_token_at_cursor(&app.composer) else {
        return false;
    };
    let Some(path) = app.image_paths.get(image_index).cloned() else {
        app.status_line = format!("missing image {}", image_index + 1);
        return true;
    };
    match Command::new("open").arg(&path).spawn() {
        Ok(_) => app.status_line = format!("opened image {}", image_index + 1),
        Err(err) => app.status_line = format!("open image failed: {err}"),
    }
    true
}

fn image_token_at_cursor(textarea: &TextArea<'static>) -> Option<usize> {
    let (line, _, col) = composer_line_at_cursor(textarea)?;
    image_token_refs(&line)
        .into_iter()
        .find(|(start, end, _)| col >= *start && col <= *end)
        .and_then(|(_, _, number)| number.checked_sub(1))
}

fn image_token_ranges(line: &str) -> Vec<(usize, usize)> {
    image_token_refs(line)
        .into_iter()
        .map(|(start, end, _)| (start, end))
        .collect()
}

fn image_token_refs(line: &str) -> Vec<(usize, usize, usize)> {
    let chars = line.chars().collect::<Vec<_>>();
    let mut ranges = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if chars.get(index..index + 8) == Some(&['[', 'I', 'm', 'a', 'g', 'e', ' ', '#']) {
            let mut end = index + 8;
            let digit_start = end;
            while end < chars.len() && chars[end].is_ascii_digit() {
                end += 1;
            }
            if end > digit_start && chars.get(end) == Some(&']') {
                let number = chars[digit_start..end]
                    .iter()
                    .collect::<String>()
                    .parse::<usize>()
                    .unwrap_or(0);
                ranges.push((index, end + 1, number));
                index = end + 1;
                continue;
            }
        }
        index += 1;
    }
    ranges
}

fn draw(frame: &mut Frame<'_>, app: &mut App) {
    let screen_height = frame.area().height;
    let composer_height = app.composer_height(screen_height);
    let help_height = app.help_height();
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(8),
            Constraint::Length(1),
            Constraint::Length(composer_height),
            Constraint::Length(1),
            Constraint::Length(help_height),
        ])
        .split(frame.area());

    draw_workspaces(frame, areas[0], app);
    draw_separator(frame, areas[1]);
    draw_composer(frame, areas[2], app);
    draw_separator(frame, areas[3]);
    draw_help(frame, areas[4], app);
    let (row, col) = app.composer.cursor();
    let visible_start = composer_visible_start(app, areas[2].height as usize);
    let visible_row = row.saturating_sub(visible_start);
    let prompt_width = if row == 0 {
        COMPOSER_PROMPT.chars().count()
    } else {
        2
    };
    let cursor_col = if app.composer_is_active() { col } else { 0 };
    let x = areas[2].x + prompt_width as u16 + cursor_col as u16;
    let y = areas[2].y + visible_row as u16;
    if x < areas[2].right() && y < areas[2].bottom() {
        frame.set_cursor_position((x, y));
    }
}

fn draw_composer(frame: &mut Frame<'_>, area: Rect, app: &App) {
    if !app.composer_is_active() {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(COMPOSER_PROMPT, muted_style()),
                Span::styled(COMPOSER_PLACEHOLDER, muted_style()),
            ])),
            area,
        );
        return;
    }

    let visible_start = composer_visible_start(app, area.height as usize);
    let lines = app
        .composer
        .lines()
        .iter()
        .enumerate()
        .skip(visible_start)
        .take(area.height as usize)
        .map(|(index, text)| {
            let prompt = if index == 0 { COMPOSER_PROMPT } else { "  " };
            render_composer_line(app, index, prompt, text)
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), area);
}

fn render_composer_line<'a>(
    app: &App,
    row: usize,
    prompt: &'static str,
    text: &'a str,
) -> Line<'a> {
    let (_, cursor_col) = app.composer.cursor();
    let mut spans = vec![Span::styled(prompt, muted_style())];
    if let Some((selection_start, selection_end)) = composer_selection_for_row(app, row, text) {
        append_selected_text_spans(&mut spans, text, selection_start, selection_end);
        return Line::from(spans);
    }

    let refs = image_token_refs(text);
    if refs.is_empty() {
        spans.push(Span::styled(text.to_string(), input_style()));
        return Line::from(spans);
    }

    let cursor_row = app.composer.cursor().0;
    let chars = text.chars().collect::<Vec<_>>();
    let mut cursor = 0;
    for (start, end, _) in refs {
        if cursor < start {
            spans.push(Span::styled(
                chars[cursor..start].iter().collect::<String>(),
                input_style(),
            ));
        }
        let selected = cursor_row == row && cursor_col >= start && cursor_col <= end;
        spans.push(Span::styled(
            chars[start..end].iter().collect::<String>(),
            image_token_style(selected),
        ));
        cursor = end;
    }
    if cursor < chars.len() {
        spans.push(Span::styled(
            chars[cursor..].iter().collect::<String>(),
            input_style(),
        ));
    }
    Line::from(spans)
}

fn composer_selection_for_row(app: &App, row: usize, text: &str) -> Option<(usize, usize)> {
    let ((start_row, start_col), (end_row, end_col)) = app.composer.selection_range()?;
    if row < start_row || row > end_row {
        return None;
    }

    let line_len = text.chars().count();
    let start = if row == start_row { start_col } else { 0 }.min(line_len);
    let end = if row == end_row { end_col } else { line_len }.min(line_len);
    (start < end).then_some((start, end))
}

fn append_selected_text_spans<'a>(
    spans: &mut Vec<Span<'a>>,
    text: &'a str,
    selection_start: usize,
    selection_end: usize,
) {
    let chars = text.chars().collect::<Vec<_>>();
    if selection_start > 0 {
        spans.push(Span::styled(
            chars[..selection_start].iter().collect::<String>(),
            input_style(),
        ));
    }
    spans.push(Span::styled(
        chars[selection_start..selection_end]
            .iter()
            .collect::<String>(),
        selection_style(),
    ));
    if selection_end < chars.len() {
        spans.push(Span::styled(
            chars[selection_end..].iter().collect::<String>(),
            input_style(),
        ));
    }
}

fn composer_visible_start(app: &App, height: usize) -> usize {
    let (row, _) = app.composer.cursor();
    row.saturating_add(1).saturating_sub(height.max(1))
}

fn draw_workspaces(frame: &mut Frame<'_>, area: Rect, app: &mut App) {
    if app.view_mode == ViewMode::Stashes {
        draw_stashes(frame, area, app);
        return;
    }
    app.ensure_selected_visible(area.height);
    let spinner_tick = (app.started_at.elapsed().as_millis() / 140) as usize;
    let lines = visible_rows(&app.workspaces, &app.collapsed_groups)
        .into_iter()
        .enumerate()
        .skip(app.list_scroll)
        .take(area.height as usize)
        .map(|row| match row {
            (_, WorkspaceListRow::Blank) => Line::raw(""),
            (row_index, WorkspaceListRow::Header(_, label)) => {
                render_group_header(label, row_index == app.selected, area.width as usize)
            }
            (row_index, WorkspaceListRow::Workspace(index)) => render_workspace_row(
                app.workspaces.get(index),
                row_index == app.selected,
                area.width as usize,
                spinner_tick,
            ),
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_stashes(frame: &mut Frame<'_>, area: Rect, app: &mut App) {
    if area.height == 0 {
        return;
    }
    let viewport = area.height.saturating_sub(1).max(1);
    let viewport_rows = usize::from(viewport);
    if app.selected < app.list_scroll {
        app.list_scroll = app.selected;
    } else if app.selected >= app.list_scroll.saturating_add(viewport_rows) {
        app.list_scroll = app.selected.saturating_add(1).saturating_sub(viewport_rows);
    }
    app.list_scroll = app
        .list_scroll
        .min(app.stashes.len().saturating_sub(viewport_rows));
    let mut lines = vec![Line::from(Span::styled(
        format!("Stashes ({})", app.stashes.len()),
        muted_style(),
    ))];

    if app.stashes.is_empty() {
        lines.push(Line::from(Span::styled("  no stashes", muted_style())));
    } else {
        lines.extend(
            app.stashes
                .iter()
                .enumerate()
                .skip(app.list_scroll)
                .take(viewport as usize)
                .map(|(index, stash)| {
                    render_stash_row(index, stash, index == app.selected, area.width as usize)
                }),
        );
    }
    frame.render_widget(Paragraph::new(lines), area);
}

fn render_stash_row(
    index: usize,
    stash: &PersistedDraft,
    selected: bool,
    width: usize,
) -> Line<'static> {
    let preview = one_line_preview(&stash.lines.join(" "), width.saturating_sub(18).max(8));
    let images = if stash.image_paths.is_empty() {
        String::new()
    } else {
        format!(" · {} images", stash.image_paths.len())
    };
    let label = format!("{:>3}  {preview}{images}", index + 1);
    let content = truncate(&label, width);
    let trailing = width.saturating_sub(content.chars().count());
    let style = if selected {
        selected_title_style()
    } else {
        muted_style()
    };
    Line::from(Span::styled(
        format!("{content}{}", " ".repeat(trailing)),
        style,
    ))
}

#[derive(Clone)]
enum WorkspaceListRow {
    Header(AgentState, String),
    Workspace(usize),
    Blank,
}

fn visible_rows(
    workspaces: &[WorkspaceStatus],
    collapsed_groups: &HashSet<AgentState>,
) -> Vec<WorkspaceListRow> {
    let groups = [
        (AgentState::NeedsAttention, "Needs input"),
        (AgentState::Working, "Working"),
        (AgentState::Idle, "Completed"),
    ];
    let mut rows = Vec::new();
    for (group_state, label) in groups {
        let indexes = workspaces
            .iter()
            .enumerate()
            .filter_map(|(index, workspace)| {
                (display_group(workspace.agent_state()) == group_state).then_some(index)
            })
            .collect::<Vec<_>>();
        if indexes.is_empty() {
            continue;
        }
        if !rows.is_empty() {
            rows.push(WorkspaceListRow::Blank);
        }
        let collapsed = collapsed_groups.contains(&group_state);
        let suffix = if collapsed { " collapsed" } else { "" };
        rows.push(WorkspaceListRow::Header(
            group_state,
            format!("{label} ({}){suffix}", indexes.len()),
        ));
        if !collapsed {
            rows.extend(indexes.into_iter().map(WorkspaceListRow::Workspace));
        }
    }
    rows
}

fn selectable_row_before(rows: &[WorkspaceListRow], selected: usize) -> Option<usize> {
    (0..selected)
        .rev()
        .find(|index| is_selectable_row(rows.get(*index)))
}

fn selectable_row_after(rows: &[WorkspaceListRow], selected: usize) -> Option<usize> {
    ((selected + 1)..rows.len()).find(|index| is_selectable_row(rows.get(*index)))
}

fn is_selectable_row(row: Option<&WorkspaceListRow>) -> bool {
    matches!(
        row,
        Some(WorkspaceListRow::Header(_, _) | WorkspaceListRow::Workspace(_))
    )
}

fn display_group(state: AgentState) -> AgentState {
    match state {
        AgentState::NeedsAttention => AgentState::NeedsAttention,
        AgentState::Working => AgentState::Working,
        AgentState::Idle | AgentState::Empty | AgentState::Unknown => AgentState::Idle,
    }
}

fn render_group_header(label: String, selected: bool, width: usize) -> Line<'static> {
    let style = if selected {
        selected_title_style()
    } else {
        muted_style()
    };
    Line::from(Span::styled(format!("{label:<width$}"), style))
}

fn render_workspace_row(
    workspace: Option<&WorkspaceStatus>,
    selected: bool,
    width: usize,
    spinner_tick: usize,
) -> Line<'static> {
    let Some(workspace) = workspace else {
        return Line::raw("");
    };
    let state = workspace.agent_state();
    let age = workspace
        .updated_at
        .map(time_ago)
        .unwrap_or_else(|| "-".to_string());
    let group = display_group(state);
    let unread = if workspace.unread_notifications > 0 || group == AgentState::NeedsAttention {
        "  ∙"
    } else {
        "   "
    };
    let spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let marker = match group {
        AgentState::Working => spinner[spinner_tick % spinner.len()],
        AgentState::NeedsAttention => " ",
        _ => "∙",
    };
    let unread_width = unread.chars().count();
    let marker_width = marker.chars().count() + 1;
    let title_width = 28;
    let fixed_width = unread_width + marker_width + title_width + 2 + age.chars().count();
    let message_width = width.saturating_sub(fixed_width).max(8);
    let title = format!("{:<title_width$}", truncate(&workspace.title, title_width));
    let message = truncate(&workspace.latest_message, message_width);
    let gap = width
        .saturating_sub(unread_width + marker_width + title_width + 1 + message.chars().count())
        .saturating_sub(age.chars().count())
        .max(1);
    let base_style = if selected {
        selected_style()
    } else {
        muted_style()
    };
    let pad = " ".repeat(gap);
    let trailing = width.saturating_sub(
        unread_width
            + marker_width
            + title_width
            + 1
            + message.chars().count()
            + pad.len()
            + age.chars().count(),
    );
    let mut spans = vec![
        Span::styled(unread.to_string(), unread_style(selected)),
        Span::styled(format!("{marker} "), base_style),
    ];
    spans.push(Span::styled(
        title,
        if selected {
            selected_title_style()
        } else {
            base_style
        },
    ));
    spans.extend([
        Span::styled(format!(" {message}"), base_style),
        Span::styled(pad, base_style),
        Span::styled(age, base_style),
        Span::styled(" ".repeat(trailing), base_style),
    ]);
    Line::from(spans)
}

fn muted_style() -> Style {
    Style::default().fg(Color::Rgb(153, 153, 153))
}

fn selected_style() -> Style {
    Style::default()
        .fg(Color::Rgb(153, 153, 153))
        .bg(Color::Rgb(55, 55, 55))
}

fn selected_title_style() -> Style {
    Style::default()
        .fg(Color::Rgb(230, 230, 230))
        .bg(Color::Rgb(55, 55, 55))
}

fn input_style() -> Style {
    Style::default().fg(Color::Rgb(230, 230, 230))
}

fn image_token_style(selected: bool) -> Style {
    let style = Style::default().fg(Color::Rgb(86, 156, 214));
    if selected {
        style.bg(Color::Rgb(55, 55, 55))
    } else {
        style
    }
}

fn selection_style() -> Style {
    Style::default()
        .fg(Color::Rgb(245, 245, 245))
        .bg(Color::Rgb(70, 70, 70))
}

fn agent_style(kind: AgentKind, selected: bool) -> Style {
    let style = Style::default().fg(kind.color());
    if selected {
        style.bg(Color::Rgb(55, 55, 55))
    } else {
        style
    }
}

fn unread_style(selected: bool) -> Style {
    let style = Style::default().fg(Color::Rgb(86, 156, 214));
    if selected {
        style.bg(Color::Rgb(55, 55, 55))
    } else {
        style
    }
}

fn draw_separator(frame: &mut Frame<'_>, area: Rect) {
    let line = "─".repeat(area.width as usize);
    frame.render_widget(Paragraph::new(line).style(muted_style()), area);
}

fn draw_help(frame: &mut Frame<'_>, area: Rect, app: &App) {
    if app.show_shortcuts {
        let lines = vec![
            Line::from(Span::styled(
                "  ctrl+r to rename          ctrl+t to pin to top    ctrl+q to quit",
                muted_style(),
            )),
            Line::from(Span::styled(
                "  ctrl+s restore stash      alt+1-6 to open         esc/? to main",
                muted_style(),
            )),
        ];
        frame.render_widget(Paragraph::new(lines), area);
        return;
    }

    if app.view_mode == ViewMode::Stashes {
        frame.render_widget(
            Paragraph::new("  enter restore · ctrl+s restore · esc main · ? shortcuts")
                .style(muted_style()),
            area,
        );
        return;
    }

    if app.status_line.starts_with("press ctrl+") {
        frame.render_widget(
            Paragraph::new(format!("  {}", app.status_line)).style(muted_style()),
            area,
        );
        return;
    }

    if app.composer_is_active() {
        match &app.composer_mode {
            ComposerMode::RenameWorkspace(_) => {
                frame.render_widget(
                    Paragraph::new("  renaming workspace · enter rename · esc cancel")
                        .style(muted_style()),
                    area,
                );
            }
            ComposerMode::NewWorkspace => {
                let plan_label = app.plan_toggle_label();
                let plan_style = if plan_label == "plan" {
                    purple_style()
                } else {
                    muted_style()
                };
                let toggle_kind = app.provider_toggle_kind();
                let help = Line::from(vec![
                    Span::styled(
                        "  enter create · ctrl+s restore stash · tab ",
                        muted_style(),
                    ),
                    Span::styled(
                        app.provider_toggle_label().to_string(),
                        agent_style(toggle_kind, false),
                    ),
                    Span::styled(" · shift+tab ", muted_style()),
                    Span::styled(plan_label.to_string(), plan_style),
                    Span::styled(" · esc clear", muted_style()),
                ]);
                frame.render_widget(Paragraph::new(help), area);
            }
        }
        return;
    }

    let prefix = if app.selected_group().is_some() {
        "  enter to collapse · ctrl+x to delete all"
    } else {
        "  enter to open · space to reply · ctrl+x to delete"
    };
    let plan_label = app.plan_toggle_label();
    let plan_style = if plan_label == "plan" {
        purple_style()
    } else {
        muted_style()
    };
    let toggle_kind = app.provider_toggle_kind();
    let help = Line::from(vec![
        Span::styled(prefix.to_string(), muted_style()),
        Span::styled(" · tab ", muted_style()),
        Span::styled(
            app.provider_toggle_label().to_string(),
            agent_style(toggle_kind, false),
        ),
        Span::styled(" · shift+tab ", muted_style()),
        Span::styled(plan_label.to_string(), plan_style),
        Span::styled(" · ? for shortcuts", muted_style()),
    ]);
    frame.render_widget(Paragraph::new(help), area);
}

fn purple_style() -> Style {
    Style::default().fg(Color::Rgb(175, 150, 255))
}

fn merge_refresh_request(
    current: Option<RefreshRequest>,
    next: Option<RefreshRequest>,
) -> Option<RefreshRequest> {
    match (current, next) {
        (Some(RefreshRequest::All(reason)), _) => Some(RefreshRequest::All(reason)),
        (_, Some(RefreshRequest::All(reason))) => Some(RefreshRequest::All(reason)),
        (_, Some(next)) => Some(next),
        (current, None) => current,
    }
}

fn spawn_refresh_worker(
    socket_path: String,
    requests: Receiver<RefreshRequest>,
    tx: Sender<UiEvent>,
) {
    thread::spawn(move || {
        while let Ok(mut request) = requests.recv() {
            while let Ok(next_request) = requests.try_recv() {
                request = merge_refresh_request(Some(request), Some(next_request)).unwrap();
            }
            match request {
                RefreshRequest::All(reason) => {
                    let result = load_workspaces(&socket_path)
                        .map(|workspaces| RefreshSnapshot {
                            reason,
                            workspaces,
                            loaded_at: Instant::now(),
                        })
                        .map_err(|err| err.to_string());
                    let _ = tx.send(UiEvent::Snapshot(result));
                }
                RefreshRequest::Workspace {
                    workspace_id,
                    reason,
                } => {
                    let result = load_workspace(&socket_path, &workspace_id)
                        .map(|workspace| WorkspaceRefresh {
                            reason,
                            workspace_id,
                            workspace,
                            loaded_at: Instant::now(),
                        })
                        .map_err(|err| err.to_string());
                    let _ = tx.send(UiEvent::WorkspaceSnapshot(result));
                }
            }
        }
    });
}

fn load_workspaces(socket_path: &str) -> Result<Vec<WorkspaceStatus>> {
    let mut client = CmuxClient::new(socket_path.to_string());
    let workspaces_payload = client.v2("workspace.list", json!({}))?;
    let unread_by_workspace = unread_notifications_by_workspace(
        client
            .v2("notification.list", json!({}))
            .unwrap_or_else(|_| json!({ "notifications": [] })),
    );

    let mut next = Vec::new();
    let workspaces = workspaces_payload
        .get("workspaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for item in workspaces {
        if let Some(workspace) = workspace_from_list_item(
            &mut client,
            &item,
            unread_by_workspace
                .get(string_field(&item, "id").as_deref().unwrap_or(""))
                .copied()
                .unwrap_or(0),
        ) {
            next.push(workspace);
        }
    }

    Ok(next)
}

fn load_workspace(socket_path: &str, workspace_id: &str) -> Result<Option<WorkspaceStatus>> {
    let mut client = CmuxClient::new(socket_path.to_string());
    let workspaces_payload = client.v2("workspace.list", json!({}))?;
    let unread_by_workspace = unread_notifications_by_workspace(
        client
            .v2("notification.list", json!({}))
            .unwrap_or_else(|_| json!({ "notifications": [] })),
    );
    let item = workspaces_payload
        .get("workspaces")
        .and_then(Value::as_array)
        .and_then(|workspaces| {
            workspaces
                .iter()
                .find(|item| string_field(item, "id").as_deref() == Some(workspace_id))
        });
    let Some(item) = item else {
        return Ok(None);
    };
    Ok(workspace_from_list_item(
        &mut client,
        item,
        unread_by_workspace.get(workspace_id).copied().unwrap_or(0),
    ))
}

fn workspace_from_list_item(
    client: &mut CmuxClient,
    item: &Value,
    unread_notifications: usize,
) -> Option<WorkspaceStatus> {
    let id = string_field(item, "id").unwrap_or_default();
    if id.is_empty() {
        return None;
    }
    let description = string_field(item, "description");
    let latest_message = client
        .v2(
            "surface.read_text",
            json!({
                "workspace_id": id,
                "lines": 60,
                "scrollback": true,
            }),
        )
        .ok()
        .and_then(|payload| string_field(&payload, "text"))
        .and_then(|screen| latest_message_from_screen(&screen))
        .or_else(|| description.clone())
        .unwrap_or_else(|| "standing by for task".to_string());
    let mut workspace = WorkspaceStatus {
        id: id.clone(),
        title: string_field(item, "title").unwrap_or_else(|| id.chars().take(8).collect()),
        latest_message,
        selected: item
            .get("selected")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pinned: item.get("pinned").and_then(Value::as_bool).unwrap_or(false),
        statuses: HashMap::new(),
        unread_notifications,
        updated_at: None,
    };
    if let Ok(sidebar) = client.v1(&format!("sidebar_state --tab={id}")) {
        workspace.statuses = parse_sidebar_statuses(&sidebar);
    }
    Some(workspace)
}

fn spawn_event_stream(socket_path: String, tx: Sender<UiEvent>) {
    thread::spawn(move || loop {
        if let Err(err) = run_event_stream_once(&socket_path, &tx) {
            let _ = tx.send(UiEvent::StreamError(err.to_string()));
            thread::sleep(Duration::from_secs(1));
        }
    });
}

fn run_event_stream_once(socket_path: &str, tx: &Sender<UiEvent>) -> Result<()> {
    let mut stream =
        UnixStream::connect(socket_path).with_context(|| format!("connect {socket_path}"))?;
    let request = json!({
        "id": "cmux-home-events",
        "method": "events.stream",
        "params": {
            "include_heartbeats": true,
            "categories": ["workspace", "sidebar", "notification", "surface", "pane"]
        }
    });
    stream
        .write_all(format!("{request}\n").as_bytes())
        .context("write events.stream request")?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        let count = reader.read_line(&mut line).context("read event frame")?;
        if count == 0 {
            bail!("event stream closed");
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let frame: EventFrame = serde_json::from_str(trimmed).unwrap_or_default();
        match frame.kind.as_deref() {
            Some("event") => {
                let _ = tx.send(UiEvent::CmuxEvent(frame));
            }
            Some("ack") => {}
            Some("heartbeat") => {}
            Some("error") => bail!("{trimmed}"),
            _ => {}
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct EventFrame {
    #[serde(rename = "type")]
    kind: Option<String>,
    name: Option<String>,
    workspace_id: Option<String>,
    #[serde(default)]
    payload: Value,
}

fn event_name(frame: &EventFrame) -> String {
    frame.name.clone().unwrap_or_else(|| "event".to_string())
}

fn event_workspace_id(frame: &EventFrame) -> Option<&str> {
    frame
        .workspace_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .or_else(|| frame.payload.get("workspace_id").and_then(Value::as_str))
        .or_else(|| {
            frame
                .payload
                .pointer("/result/workspace_id")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            frame
                .payload
                .pointer("/params/workspace_id")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            frame
                .payload
                .get("args")
                .and_then(Value::as_str)
                .and_then(workspace_id_from_args)
        })
}

fn event_title(frame: &EventFrame) -> Option<String> {
    frame
        .payload
        .get("custom_title")
        .and_then(Value::as_str)
        .or_else(|| frame.payload.get("title").and_then(Value::as_str))
        .or_else(|| {
            frame
                .payload
                .pointer("/result/title")
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

fn event_description(frame: &EventFrame) -> Option<String> {
    frame
        .payload
        .get("description")
        .and_then(Value::as_str)
        .or_else(|| {
            frame
                .payload
                .pointer("/result/description")
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

fn notification_is_unread(frame: &EventFrame) -> bool {
    frame
        .payload
        .get("is_read")
        .and_then(Value::as_bool)
        .map(|is_read| !is_read)
        .unwrap_or(true)
}

fn workspace_id_from_args(args: &str) -> Option<&str> {
    let words = shell_words(args);
    let id = words
        .iter()
        .find_map(|word| {
            word.strip_prefix("--tab=")
                .or_else(|| word.strip_prefix("--workspace="))
        })
        .or_else(|| {
            words.windows(2).find_map(|pair| {
                (pair[0] == "--tab" || pair[0] == "--workspace").then_some(pair[1].as_str())
            })
        });
    id.map(|id| {
        let offset = args.find(id).unwrap_or(0);
        &args[offset..offset + id.len()]
    })
}

fn unread_notifications_by_workspace(payload: Value) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    let Some(items) = payload.get("notifications").and_then(Value::as_array) else {
        return counts;
    };
    for item in items {
        if item.get("is_read").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if let Some(workspace_id) = string_field(item, "workspace_id") {
            *counts.entry(workspace_id).or_insert(0) += 1;
        }
    }
    counts
}

fn parse_sidebar_statuses(text: &str) -> HashMap<String, String> {
    let mut statuses = HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !line.starts_with("  ") {
            continue;
        }
        let Some((key, rest)) = trimmed.split_once('=') else {
            continue;
        };
        let value = rest
            .split(" icon=")
            .next()
            .unwrap_or(rest)
            .split(" color=")
            .next()
            .unwrap_or(rest)
            .split(" url=")
            .next()
            .unwrap_or(rest)
            .split(" priority=")
            .next()
            .unwrap_or(rest)
            .trim()
            .to_string();
        statuses.insert(key.to_string(), value);
    }
    statuses
}

fn latest_message_from_screen(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .map(|line| {
            line.trim()
                .trim_start_matches('›')
                .trim_start_matches('❯')
                .trim()
        })
        .find(|line| is_message_preview_line(line))
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn is_message_preview_line(line: &str) -> bool {
    if line.is_empty() {
        return false;
    }
    if line.chars().all(|ch| ch == '─' || ch == '-' || ch == '—') {
        return false;
    }
    let lower = line.to_ascii_lowercase();
    !contains_any(
        &lower,
        &[
            "enter to open",
            "enter to create",
            "ctrl+x",
            "context ",
            "gpt-",
            "opus ",
            "working (",
            "esc to interrupt",
            "cmux-home",
            "minimal cmux workspace launcher",
        ],
    )
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

fn one_line_preview(text: &str, max_chars: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&collapsed, max_chars)
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    if max_chars <= 1 {
        return "…".to_string();
    }
    format!(
        "{}…",
        text.chars()
            .take(max_chars.saturating_sub(1))
            .collect::<String>()
    )
}

fn time_ago(instant: Instant) -> String {
    let elapsed = instant.elapsed();
    let seconds = elapsed.as_secs();
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 60 * 60 {
        format!("{}m", seconds / 60)
    } else if seconds < 60 * 60 * 24 {
        format!("{}h", seconds / 60 / 60)
    } else {
        format!("{}d", seconds / 60 / 60 / 24)
    }
}

fn shell_quote(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn is_complete_single_line_response(data: &[u8]) -> bool {
    if !data.contains(&b'\n') {
        return false;
    }
    let Ok(response) = std::str::from_utf8(data) else {
        return false;
    };
    let normalized = response.trim();
    if normalized.is_empty() || normalized.contains('\n') {
        return false;
    }
    normalized == "OK"
        || normalized == "PONG"
        || normalized.starts_with("OK ")
        || normalized.starts_with("ERROR:")
        || serde_json::from_str::<Value>(normalized).is_ok()
}

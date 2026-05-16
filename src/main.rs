use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

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
use ignore::WalkBuilder;
use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config as FuzzyConfig, Matcher as FuzzyMatcher, Utf32Str};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::{Frame, Terminal};
use serde_json::{json, Value};
use tui_textarea::{CursorMove, TextArea};

mod cmux_client;
mod commands;
mod config;
mod events;
mod model;
mod skills;
mod util;

use cmux_client::CmuxClient;
use commands::{
    configure_workspace_hook_command, render_command_template, render_command_template_parts,
    write_submit_payload, SubmitPayload,
};
use config::{load_config, load_persisted_state, state_path, PersistedDraft, PersistedState};
use events::{
    event_name, event_title, event_workspace_id, notification_is_unread,
    preserve_optimistic_submission, workspace_from_created_event, EventFrame,
};
use model::{
    display_group, AgentKind, AgentState, ConversationActor, ConversationSnapshot, WorkspaceStatus,
};
use skills::{load_skill_entries, SkillEntry};
use util::{
    contains_any, now_millis, one_line_preview, shell_quote, shell_words, time_ago, truncate,
    user_home,
};

const COMPOSER_PLACEHOLDER: &str = "describe a task for a new workspace";
const COMPOSER_PROMPT: &str = "❯ ";
const COMPOSER_CONTINUATION_PROMPT: &str = "  ";
const MAX_AUTOCOMPLETE_ROWS: usize = 8;
const MAX_AUTOCOMPLETE_ITEMS: usize = 100;
const MAX_FILE_REFERENCES: usize = 20_000;
const COMMAND_SUGGESTIONS: &[CommandSuggestion] = &[
    CommandSuggestion {
        command: "/history",
        detail: "previous prompts",
    },
    CommandSuggestion {
        command: "/stash",
        detail: "saved drafts",
    },
    CommandSuggestion {
        command: "/stash save",
        detail: "save text as stash",
    },
];

#[derive(Clone, Copy)]
struct CommandSuggestion {
    command: &'static str,
    detail: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CommandSuggestionMatch {
    command: &'static str,
    detail: &'static str,
    positions: Vec<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum AutocompleteKind {
    Command,
    File,
    Skill,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AutocompleteItem {
    kind: AutocompleteKind,
    label: String,
    label_match_positions: Vec<usize>,
    insert_text: String,
    detail: String,
    detail_match_positions: Vec<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FuzzyMatch {
    score: u32,
    positions: Vec<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ComposerReferenceKind {
    Command,
    File,
    Skill,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ComposerHighlightRange {
    start: usize,
    end: usize,
    kind: ComposerReferenceKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FocusTarget {
    MainContent,
    Autocomplete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SelectionDirection {
    Previous,
    Next,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AutocompleteMarker {
    Slash,
    Dollar,
    At,
}

impl AutocompleteMarker {
    fn as_char(self) -> char {
        match self {
            Self::Slash => '/',
            Self::Dollar => '$',
            Self::At => '@',
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AutocompleteQuery {
    marker: AutocompleteMarker,
    raw: String,
    search: String,
    row: usize,
    start_col: usize,
    end_col: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct SelectionState {
    selected: usize,
    scroll: usize,
}

impl SelectionState {
    fn clamp(&mut self, len: usize) {
        if len == 0 {
            self.selected = 0;
            self.scroll = 0;
            return;
        }
        self.selected = self.selected.min(len.saturating_sub(1));
        self.scroll = self.scroll.min(len.saturating_sub(1));
    }

    fn select_previous(&mut self, len: usize) {
        self.clamp(len);
        self.selected = self.selected.saturating_sub(1);
    }

    fn select_next(&mut self, len: usize) {
        self.clamp(len);
        self.selected = self.selected.saturating_add(1).min(len.saturating_sub(1));
    }

    fn ensure_visible(&mut self, viewport_height: usize, len: usize) {
        self.clamp(len);
        let height = viewport_height.max(1);
        if self.selected < self.scroll {
            self.scroll = self.selected;
        } else if self.selected >= self.scroll.saturating_add(height) {
            self.scroll = self.selected.saturating_add(1).saturating_sub(height);
        }
        self.scroll = self.scroll.min(len.saturating_sub(height));
    }
}

#[derive(Parser, Debug)]
#[command(about = "Minimal cmux workspace launcher and status TUI")]
struct Args {
    #[arg(long, env = "CMUX_SOCKET_PATH")]
    socket: Option<String>,

    #[arg(long, env = "CMUX_AGENT_TUI_WORKSPACE_CWD")]
    workspace_cwd: Option<String>,

    #[arg(long, env = "CMUX_HOME_CONFIG")]
    config: Option<PathBuf>,

    #[arg(long, default_value = "codex", env = "CMUX_AGENT_TUI_CODEX_COMMAND")]
    codex_command: String,

    #[arg(
        long,
        default_value = "codex",
        env = "CMUX_AGENT_TUI_CODEX_PLAN_COMMAND"
    )]
    codex_plan_command: String,

    #[arg(long, default_value = "claude", env = "CMUX_AGENT_TUI_CLAUDE_COMMAND")]
    claude_command: String,

    #[arg(
        long,
        default_value = "claude --permission-mode plan",
        env = "CMUX_AGENT_TUI_CLAUDE_PLAN_COMMAND"
    )]
    claude_plan_command: String,
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
    workspace_cwd: String,
    codex_bin: String,
    claude_bin: String,
    terminal_path: Option<String>,
    codex_env_args: String,
    claude_env_args: String,
    codex_template: String,
    codex_plan_template: String,
    codex_submit_template: Option<String>,
    claude_template: String,
    claude_plan_template: String,
    claude_submit_template: Option<String>,
    rename_template: Option<String>,
    skills: Vec<SkillEntry>,
    file_references: Vec<FileReference>,
    provider: AgentKind,
    plan_mode: bool,
    show_shortcuts: bool,
    workspaces: Vec<WorkspaceStatus>,
    selected: usize,
    list_scroll: usize,
    focus_target: FocusTarget,
    autocomplete: SelectionState,
    view_mode: ViewMode,
    image_paths: Vec<String>,
    selected_image: Option<ImageSelection>,
    stashes: Vec<PersistedDraft>,
    history: Vec<PersistedDraft>,
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
    History,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ImageSelection {
    row: usize,
    start: usize,
    end: usize,
    image_index: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileReference {
    path: String,
}

impl App {
    fn new(args: Args) -> Self {
        let socket_path = args
            .socket
            .or_else(|| std::env::var("CMUX_SOCKET").ok())
            .unwrap_or_else(|| "/tmp/cmux.sock".to_string());
        let workspace_cwd = args
            .workspace_cwd
            .or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|path| path.display().to_string())
            })
            .unwrap_or_else(|| ".".to_string());
        let state_path = state_path();
        let persisted = load_persisted_state(&state_path);
        let config = load_config(args.config.as_ref());
        let skills = load_skill_entries(&workspace_cwd);
        let file_references = load_file_references(&workspace_cwd);
        let codex_bin = resolve_agent_executable("codex", "CMUX_HOME_CODEX_BIN");
        let claude_bin = resolve_agent_executable("claude", "CMUX_HOME_CLAUDE_BIN");
        let terminal_path = std::env::var("PATH").ok();
        let codex_env_args = env_args(&["CODEX_HOME"]);
        let claude_env_args = env_args(&["CLAUDE_CONFIG_DIR", "CLAUDE_HOME"]);
        let mut app = Self {
            socket_path,
            workspace_cwd,
            codex_bin,
            claude_bin,
            terminal_path,
            codex_env_args,
            claude_env_args,
            codex_template: config.agents.codex.command.unwrap_or(args.codex_command),
            codex_plan_template: config
                .agents
                .codex
                .plan_command
                .unwrap_or(args.codex_plan_command),
            codex_submit_template: config.agents.codex.submit_command,
            claude_template: config.agents.claude.command.unwrap_or(args.claude_command),
            claude_plan_template: config
                .agents
                .claude
                .plan_command
                .unwrap_or(args.claude_plan_command),
            claude_submit_template: config.agents.claude.submit_command,
            rename_template: config.rename.command,
            skills,
            file_references,
            provider: AgentKind::Codex,
            plan_mode: false,
            show_shortcuts: false,
            workspaces: Vec::new(),
            selected: 0,
            list_scroll: 0,
            focus_target: FocusTarget::MainContent,
            autocomplete: SelectionState::default(),
            view_mode: ViewMode::Workspaces,
            image_paths: Vec::new(),
            selected_image: None,
            stashes: persisted.stashes,
            history: persisted.history,
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
            .map(|workspace| (workspace.id.clone(), workspace.clone()))
            .collect::<HashMap<_, _>>();
        self.workspaces = snapshot
            .workspaces
            .into_iter()
            .map(|mut workspace| {
                if let Some(existing) = previous.get(&workspace.id) {
                    preserve_optimistic_submission(existing, &mut workspace);
                    workspace.updated_at = (existing.fingerprint() == workspace.fingerprint())
                        .then_some(existing.updated_at)
                        .flatten()
                        .or(Some(snapshot.loaded_at));
                } else {
                    workspace.updated_at = Some(snapshot.loaded_at);
                }
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
            self.selected = self
                .selected
                .min(self.active_draft_list_len().saturating_sub(1));
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
                if let Some(existing) = previous {
                    preserve_optimistic_submission(existing, &mut refreshed);
                    refreshed.updated_at = (existing.fingerprint() == refreshed.fingerprint())
                        .then_some(existing.updated_at)
                        .flatten()
                        .or(Some(snapshot.loaded_at));
                } else {
                    refreshed.updated_at = Some(snapshot.loaded_at);
                }
                if let Some(existing) = self
                    .workspaces
                    .iter_mut()
                    .find(|workspace| workspace.id == refreshed.id)
                {
                    *existing = refreshed;
                } else {
                    self.workspaces.insert(0, refreshed);
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
                self.workspaces
                    .insert(0, workspace_from_created_event(frame, workspace_id));
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
        let images = self.image_paths.clone();
        let start_prompt = self.agent_start_prompt(&prompt, &images);
        let latest_message = if prompt.is_empty() {
            "standing by for task".to_string()
        } else {
            one_line_preview(&prompt, 120)
        };
        let title = if prompt.is_empty() {
            self.agent_label()
        } else {
            format!("{}: {}", self.agent_label(), one_line_preview(&prompt, 42))
        };
        let (command, command_accepts_prompt) = self.render_agent_command(&images, &start_prompt);
        let mut params = json!({
            "title": title,
            "description": prompt,
            "initial_command": command,
            "cwd": self.workspace_cwd,
            "focus": false,
        });
        if let Some(path) = self.terminal_path.as_deref() {
            params["initial_env"] = json!({ "PATH": path });
        }
        let mut client = CmuxClient::new(self.socket_path.clone());
        let created = client.v2("workspace.create", params)?;
        let workspace_id = string_field(&created, "workspace_id")
            .ok_or_else(|| anyhow!("workspace.create did not return workspace_id"))?;
        let _ = client.v1("refresh-surfaces");
        self.upsert_optimistic_workspace(workspace_id.clone(), title.clone(), latest_message);
        self.select_workspace_by_id(&workspace_id);
        if !command_accepts_prompt {
            self.spawn_submit_hook(&workspace_id, &prompt, &title, &images);
        }
        self.spawn_rename_hook(&workspace_id, &prompt, &title);
        if !prompt.is_empty() || !images.is_empty() {
            let _ = client.v2(
                "workspace.prompt_submit",
                json!({ "workspace_id": workspace_id, "message": prompt }),
            );
        }
        self.record_prompt_history(&prompt, &images);
        self.composer = new_composer();
        self.image_paths.clear();
        self.composer_mode = ComposerMode::NewWorkspace;
        self.status_line = format!("started {} workspace", self.agent_label());
        Ok(())
    }

    fn upsert_optimistic_workspace(
        &mut self,
        workspace_id: String,
        title: String,
        latest_message: String,
    ) {
        let workspace = WorkspaceStatus {
            id: workspace_id.clone(),
            title,
            latest_message: latest_message.clone(),
            selected: false,
            pinned: false,
            statuses: HashMap::new(),
            unread_notifications: 0,
            conversation: Some(ConversationSnapshot {
                actor: ConversationActor::User,
                preview: latest_message.clone(),
                modified_at: SystemTime::now(),
            }),
            updated_at: Some(Instant::now()),
        };
        if let Some(existing) = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
        {
            *existing = workspace;
        } else {
            self.workspaces.insert(0, workspace);
        }
    }

    fn select_workspace_by_id(&mut self, workspace_id: &str) {
        let Some(workspace_index) = self
            .workspaces
            .iter()
            .position(|workspace| workspace.id == workspace_id)
        else {
            return;
        };
        let group = display_group(self.workspaces[workspace_index].agent_state());
        self.collapsed_groups.remove(&group);
        if let Some(row_index) =
            visible_rows(&self.workspaces, &self.collapsed_groups)
                .iter()
                .position(|row| matches!(row, WorkspaceListRow::Workspace(index) if *index == workspace_index))
        {
            self.selected = row_index;
        }
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
        self.selected_image = None;
        self.composer_mode = ComposerMode::NewWorkspace;
        self.sync_focus_after_composer_change();
    }

    fn stash_current_draft(&mut self) {
        let Some(draft) = self.current_draft() else {
            self.status_line = "nothing to stash".to_string();
            return;
        };
        self.stashes.push(draft);
        self.reset_composer();
        self.status_line = format!("stashed draft {}", self.stashes.len());
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

    fn restore_selected_history(&mut self) {
        let Some(draft) = self.history.get(self.selected).cloned() else {
            self.status_line = "select a prompt".to_string();
            return;
        };
        let count = self.selected + 1;
        self.restore_draft(draft);
        self.view_mode = ViewMode::Workspaces;
        self.selected = 0;
        self.list_scroll = 0;
        self.status_line = format!("restored prompt {count}");
    }

    fn open_stash_view(&mut self) {
        self.view_mode = ViewMode::Stashes;
        self.selected = self.selected.min(self.stashes.len().saturating_sub(1));
        self.list_scroll = 0;
        self.focus_target = FocusTarget::MainContent;
        self.status_line = format!("{} stashes", self.stashes.len());
    }

    fn open_history_view(&mut self) {
        self.view_mode = ViewMode::History;
        self.selected = 0;
        self.list_scroll = 0;
        self.focus_target = FocusTarget::MainContent;
        self.status_line = format!("{} prompts", self.history.len());
    }

    fn open_workspace_view(&mut self) {
        self.view_mode = ViewMode::Workspaces;
        self.selected = 0;
        self.list_scroll = 0;
        self.focus_target = FocusTarget::MainContent;
        self.status_line = "main".to_string();
    }

    fn restore_draft(&mut self, draft: PersistedDraft) {
        self.composer = composer_from_lines(non_empty_lines(draft.lines));
        self.image_paths = draft.image_paths;
        self.selected_image = None;
        self.provider = AgentKind::from_label(&draft.provider).unwrap_or(AgentKind::Codex);
        self.plan_mode = draft.plan_mode;
        self.composer_mode = ComposerMode::NewWorkspace;
        self.sync_focus_after_composer_change();
    }

    fn record_prompt_history(&mut self, prompt: &str, images: &[String]) {
        if prompt.trim().is_empty() && images.is_empty() {
            return;
        }
        let lines = if prompt.is_empty() {
            vec![String::new()]
        } else {
            prompt.lines().map(str::to_string).collect()
        };
        self.history.insert(
            0,
            draft_from_parts(lines, images.to_vec(), self.provider, self.plan_mode),
        );
    }

    fn current_draft(&self) -> Option<PersistedDraft> {
        if !self.composer_has_input() && self.image_paths.is_empty() {
            return None;
        }
        Some(draft_from_parts(
            self.composer.lines().to_vec(),
            self.image_paths.clone(),
            self.provider,
            self.plan_mode,
        ))
    }

    fn persist_state(&self) {
        let state = PersistedState {
            draft: self.current_draft(),
            stashes: self.stashes.clone(),
            history: self.history.clone(),
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

    fn autocomplete_query(&self) -> Option<AutocompleteQuery> {
        if self.composer_mode != ComposerMode::NewWorkspace {
            return None;
        }
        autocomplete_query_at_cursor(&self.composer)
    }

    fn autocomplete_items(&self) -> Vec<AutocompleteItem> {
        let Some(query) = self.autocomplete_query() else {
            return Vec::new();
        };
        let mut items = Vec::new();
        match query.marker {
            AutocompleteMarker::Slash => {
                items.extend(command_suggestions_for_query(&query.raw).into_iter().map(
                    |suggestion| {
                        let insert_text = if suggestion.command == "/stash save" {
                            "/stash save ".to_string()
                        } else {
                            suggestion.command.to_string()
                        };
                        AutocompleteItem {
                            kind: AutocompleteKind::Command,
                            label: suggestion.command.to_string(),
                            label_match_positions: suggestion.positions,
                            insert_text,
                            detail: suggestion.detail.to_string(),
                            detail_match_positions: Vec::new(),
                        }
                    },
                ));
                items.extend(self.skill_autocomplete_items(&query));
            }
            AutocompleteMarker::Dollar => items.extend(self.skill_autocomplete_items(&query)),
            AutocompleteMarker::At => items.extend(self.file_autocomplete_items(&query)),
        }
        items.truncate(MAX_AUTOCOMPLETE_ITEMS);
        items
    }

    fn skill_autocomplete_items(&self, query: &AutocompleteQuery) -> Vec<AutocompleteItem> {
        let search = query.search.trim();
        if search.contains(char::is_whitespace) {
            return Vec::new();
        }
        let pattern = fuzzy_pattern(search);
        let mut matcher = fuzzy_matcher(false);
        let mut buf = Vec::new();
        let mut positions = Vec::new();
        let mut matches = self
            .skills
            .iter()
            .filter_map(|skill| {
                let candidate = if skill.description.is_empty() {
                    skill.name.clone()
                } else {
                    format!("{} {}", skill.name, skill.description)
                };
                let full_match = fuzzy_match_candidate(
                    &pattern,
                    &mut matcher,
                    &candidate,
                    &mut buf,
                    &mut positions,
                )?;
                let title_match = fuzzy_match_candidate(
                    &pattern,
                    &mut matcher,
                    &skill.name,
                    &mut buf,
                    &mut positions,
                );
                let name = skill.name.to_ascii_lowercase();
                let search = search.to_ascii_lowercase();
                let source_match = skill
                    .sources
                    .iter()
                    .any(|source| source.contains(self.provider.label()));
                let prefix_match = search.is_empty() || name.starts_with(&search);
                let title_score = title_match.as_ref().map(|item| item.score).unwrap_or(0);
                let score = full_match.score + title_score.saturating_mul(3);
                Some((score, source_match, prefix_match, title_match, skill))
            })
            .collect::<Vec<_>>();
        matches.sort_by(
            |(score_a, source_a, prefix_a, _, skill_a),
             (score_b, source_b, prefix_b, _, skill_b)| {
                score_b
                    .cmp(score_a)
                    .then_with(|| source_b.cmp(source_a))
                    .then_with(|| prefix_b.cmp(prefix_a))
                    .then_with(|| skill_a.priority.cmp(&skill_b.priority))
                    .then_with(|| skill_a.name.cmp(&skill_b.name))
            },
        );
        let marker = query.marker.as_char();
        matches
            .into_iter()
            .map(|(_, _, _, title_match, skill)| {
                let source = skill.sources.join(", ");
                let detail = if skill.description.is_empty() {
                    format!("skill · {source}")
                } else {
                    format!("skill · {source} · {}", skill.description)
                };
                AutocompleteItem {
                    kind: AutocompleteKind::Skill,
                    label: format!("{marker}{}", skill.name),
                    label_match_positions: title_match
                        .map(|item| shift_positions(&item.positions, 1))
                        .unwrap_or_default(),
                    insert_text: format!("{marker}{} ", skill.name),
                    detail,
                    detail_match_positions: Vec::new(),
                }
            })
            .collect()
    }

    fn file_autocomplete_items(&self, query: &AutocompleteQuery) -> Vec<AutocompleteItem> {
        let search = query.search.trim();
        if search.contains(char::is_whitespace) {
            return Vec::new();
        }
        let pattern = fuzzy_pattern(search);
        let mut matcher = fuzzy_matcher(true);
        let mut buf = Vec::new();
        let mut positions = Vec::new();
        let mut matches = self
            .file_references
            .iter()
            .filter_map(|file| {
                let path_match = fuzzy_match_candidate(
                    &pattern,
                    &mut matcher,
                    &file.path,
                    &mut buf,
                    &mut positions,
                )?;
                let title = file_reference_title(&file.path);
                let title_match =
                    fuzzy_match_candidate(&pattern, &mut matcher, title, &mut buf, &mut positions);
                let title_lower = title.to_ascii_lowercase();
                let search_lower = search.to_ascii_lowercase();
                let title_rank =
                    file_title_rank(&search_lower, &title_lower, title_match.is_some());
                let path_depth = file_path_depth(&file.path);
                let mut score = path_match.score;
                if let Some(title_match) = title_match.as_ref() {
                    score = score.saturating_add(title_match.score.saturating_mul(5));
                    if title_rank == 4 {
                        score = score.saturating_add(20_000);
                    } else if title_rank == 3 {
                        score = score.saturating_add(10_000);
                    } else if title_rank == 2 {
                        score = score.saturating_add(5_000);
                    }
                }
                Some((title_rank, path_depth, score, path_match, title_match, file))
            })
            .collect::<Vec<_>>();
        matches.sort_by(
            |(title_rank_a, depth_a, score_a, _, _, file_a),
             (title_rank_b, depth_b, score_b, _, _, file_b)| {
                title_rank_b
                    .cmp(title_rank_a)
                    .then_with(|| depth_a.cmp(depth_b))
                    .then_with(|| score_b.cmp(score_a))
                    .then_with(|| file_a.path.len().cmp(&file_b.path.len()))
                    .then_with(|| file_a.path.cmp(&file_b.path))
            },
        );
        matches
            .into_iter()
            .take(MAX_AUTOCOMPLETE_ITEMS)
            .map(|(_, _, _, path_match, title_match, file)| {
                let title = file_reference_title(&file.path);
                AutocompleteItem {
                    kind: AutocompleteKind::File,
                    label: format!("@{title}"),
                    label_match_positions: title_match
                        .map(|item| shift_positions(&item.positions, 1))
                        .unwrap_or_default(),
                    insert_text: format!("@{} ", file.path),
                    detail: file.path.clone(),
                    detail_match_positions: path_match.positions,
                }
            })
            .collect()
    }

    fn autocomplete_is_active(&self) -> bool {
        self.autocomplete_query().is_some()
    }

    fn sync_focus_after_composer_change(&mut self) {
        if self.autocomplete_is_active() {
            self.focus_target = FocusTarget::Autocomplete;
            self.clamp_autocomplete_selection();
        } else if self.focus_target == FocusTarget::Autocomplete {
            self.focus_target = FocusTarget::MainContent;
            self.autocomplete = SelectionState::default();
        }
    }

    fn clamp_autocomplete_selection(&mut self) {
        let len = self.autocomplete_items().len();
        self.autocomplete.clamp(len);
    }

    fn select_previous_autocomplete(&mut self) {
        let len = self.autocomplete_items().len();
        self.autocomplete.select_previous(len);
    }

    fn select_next_autocomplete(&mut self) {
        let len = self.autocomplete_items().len();
        self.autocomplete.select_next(len);
    }

    fn move_focused_selection(&mut self, direction: SelectionDirection) -> bool {
        if self.focus_target == FocusTarget::Autocomplete && self.autocomplete_is_active() {
            match direction {
                SelectionDirection::Previous => self.select_previous_autocomplete(),
                SelectionDirection::Next => self.select_next_autocomplete(),
            }
            return true;
        }
        match direction {
            SelectionDirection::Previous => self.select_previous_main(),
            SelectionDirection::Next => self.select_next_main(),
        }
        true
    }

    fn composer_height(&self, screen_height: u16, screen_width: u16) -> u16 {
        if self.composer_is_active() {
            let max_height = ((u32::from(screen_height) * 3) / 4).max(1) as u16;
            (composer_visual_line_count(self, screen_width) as u16).clamp(1, max_height)
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

    fn bottom_reserved_height(&self, screen_height: u16, screen_width: u16) -> u16 {
        self.composer_height(screen_height, screen_width) + self.help_height() + 2
    }

    fn select_previous(&mut self) {
        self.move_focused_selection(SelectionDirection::Previous);
    }

    fn select_next(&mut self) {
        self.move_focused_selection(SelectionDirection::Next);
    }

    fn select_previous_main(&mut self) {
        if matches!(self.view_mode, ViewMode::Stashes | ViewMode::History) {
            self.selected = self.selected.saturating_sub(1);
            return;
        }
        let rows = visible_rows(&self.workspaces, &self.collapsed_groups);
        self.selected = selectable_row_before(&rows, self.selected).unwrap_or(self.selected);
    }

    fn select_next_main(&mut self) {
        if matches!(self.view_mode, ViewMode::Stashes | ViewMode::History) {
            self.selected = self
                .selected
                .saturating_add(1)
                .min(self.active_draft_list_len().saturating_sub(1));
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
        if matches!(self.view_mode, ViewMode::Stashes | ViewMode::History) {
            let rows = usize::from(viewport_height.saturating_sub(1).max(1));
            return self.active_draft_list_len().saturating_sub(rows);
        }
        visible_rows(&self.workspaces, &self.collapsed_groups)
            .len()
            .saturating_sub(usize::from(viewport_height.max(1)))
    }

    fn active_draft_list_len(&self) -> usize {
        match self.view_mode {
            ViewMode::Workspaces => 0,
            ViewMode::Stashes => self.stashes.len(),
            ViewMode::History => self.history.len(),
        }
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

    fn toggle_provider(&mut self) {
        self.provider = self.provider.toggle();
        self.status_line = format!("agent {}", self.agent_label());
    }

    fn toggle_plan_mode(&mut self) {
        self.plan_mode = !self.plan_mode;
        self.status_line = format!("mode {}", self.agent_label());
    }

    fn agent_start_prompt(&self, prompt: &str, images: &[String]) -> String {
        let mut message = prompt.to_string();
        if self.provider != AgentKind::Codex && !images.is_empty() {
            if !message.is_empty() {
                message.push_str("\n\n");
            }
            message.push_str("Attached images:");
            for image in images {
                message.push('\n');
                message.push_str(image);
            }
        }
        message
    }

    fn render_agent_command(&self, images: &[String], prompt: &str) -> (String, bool) {
        let template = match self.provider {
            AgentKind::Codex if self.plan_mode => &self.codex_plan_template,
            AgentKind::Codex => &self.codex_template,
            AgentKind::Claude if self.plan_mode => &self.claude_plan_template,
            AgentKind::Claude => &self.claude_template,
        };
        let accepts_prompt = template.contains("{prompt}");
        let image_args = images
            .iter()
            .map(|path| format!("--image {}", shell_quote(path)))
            .collect::<Vec<_>>()
            .join(" ");
        let command = render_command_template_parts(
            template,
            &[
                ("workspace_cwd", &self.workspace_cwd),
                ("prompt", prompt),
                ("codex_bin", &self.codex_bin),
                ("claude_bin", &self.claude_bin),
                (
                    "terminal_path",
                    self.terminal_path.as_deref().unwrap_or_default(),
                ),
            ],
            &[
                ("image_args", &image_args),
                ("codex_env", &self.codex_env_args),
                ("claude_env", &self.claude_env_args),
            ],
        );
        (command, accepts_prompt)
    }

    fn submit_template(&self) -> Option<&str> {
        match self.provider {
            AgentKind::Codex => self.codex_submit_template.as_deref(),
            AgentKind::Claude => self.claude_submit_template.as_deref(),
        }
    }

    fn spawn_submit_hook(&self, workspace_id: &str, prompt: &str, title: &str, images: &[String]) {
        let Some(template) = self.submit_template() else {
            return;
        };
        if template.trim().is_empty() {
            return;
        }
        let mode = if self.plan_mode { "plan" } else { "build" };
        let Ok(payload_path) = write_submit_payload(SubmitPayload {
            workspace_id,
            prompt,
            title,
            agent: self.provider.label(),
            mode,
            workspace_cwd: &self.workspace_cwd,
            socket: &self.socket_path,
            images,
        }) else {
            return;
        };
        let payload_path_string = payload_path.display().to_string();
        let rendered = render_command_template(
            template,
            &[
                ("payload", &payload_path_string),
                ("workspace_id", workspace_id),
                ("socket", &self.socket_path),
            ],
        );
        let mut command = Command::new("sh");
        configure_workspace_hook_command(
            &mut command,
            &rendered,
            &self.workspace_cwd,
            &self.socket_path,
            workspace_id,
        );
        let _ = command.spawn();
    }

    fn spawn_rename_hook(&self, workspace_id: &str, prompt: &str, title: &str) {
        let Some(template) = self.rename_template.as_deref() else {
            return;
        };
        if template.trim().is_empty() {
            return;
        }
        let mode = if self.plan_mode { "plan" } else { "build" };
        let rendered = render_command_template(
            template,
            &[
                ("workspace_id", workspace_id),
                ("prompt", prompt),
                ("title", title),
                ("agent", self.provider.label()),
                ("mode", mode),
                ("workspace_cwd", &self.workspace_cwd),
                ("socket", &self.socket_path),
            ],
        );
        let mut command = Command::new("sh");
        configure_workspace_hook_command(
            &mut command,
            &rendered,
            &self.workspace_cwd,
            &self.socket_path,
            workspace_id,
        );
        let _ = command.spawn();
    }
}

fn new_composer() -> TextArea<'static> {
    configure_composer(TextArea::default())
}

fn composer_from_lines(lines: Vec<String>) -> TextArea<'static> {
    configure_composer(TextArea::new(lines))
}

fn configure_composer(mut composer: TextArea<'static>) -> TextArea<'static> {
    composer.set_placeholder_text("");
    composer.set_cursor_line_style(Style::default());
    composer
}

fn autocomplete_query_at_cursor(textarea: &TextArea<'static>) -> Option<AutocompleteQuery> {
    let (line, row, col) = composer_line_at_cursor(textarea)?;
    let chars = line.chars().collect::<Vec<_>>();
    let cursor = col.min(chars.len());
    if cursor == 0 {
        return None;
    }

    let mut start_col = cursor;
    while start_col > 0 && !chars[start_col - 1].is_whitespace() {
        start_col -= 1;
    }
    let raw = chars[start_col..cursor].iter().collect::<String>();
    let marker = match raw.chars().next()? {
        '/' => AutocompleteMarker::Slash,
        '$' => AutocompleteMarker::Dollar,
        '@' => AutocompleteMarker::At,
        _ => return None,
    };

    Some(AutocompleteQuery {
        marker,
        search: raw.chars().skip(1).collect::<String>(),
        raw,
        row,
        start_col,
        end_col: cursor,
    })
}

fn load_file_references(workspace_cwd: &str) -> Vec<FileReference> {
    let root = PathBuf::from(workspace_cwd);
    let mut builder = WalkBuilder::new(&root);
    builder
        .standard_filters(true)
        .hidden(true)
        .follow_links(false)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                ".git" | ".next" | ".turbo" | ".venv" | "DerivedData" | "node_modules" | "target"
            )
        });

    let mut files = Vec::new();
    for entry in builder.build().flatten() {
        if files.len() >= MAX_FILE_REFERENCES {
            break;
        }
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            continue;
        }
        let path = entry.path();
        let relative = path.strip_prefix(&root).unwrap_or(path);
        let display = relative.to_string_lossy().replace('\\', "/");
        if display.is_empty() {
            continue;
        }
        files.push(FileReference { path: display });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

fn fuzzy_pattern(query: &str) -> Pattern {
    Pattern::new(
        query.trim(),
        CaseMatching::Ignore,
        Normalization::Smart,
        AtomKind::Fuzzy,
    )
}

fn fuzzy_matcher(path_mode: bool) -> FuzzyMatcher {
    let mut config = if path_mode {
        FuzzyConfig::DEFAULT.match_paths()
    } else {
        FuzzyConfig::DEFAULT
    };
    if !path_mode {
        config.prefer_prefix = true;
    }
    FuzzyMatcher::new(config)
}

fn fuzzy_match_candidate(
    pattern: &Pattern,
    matcher: &mut FuzzyMatcher,
    candidate: &str,
    buf: &mut Vec<char>,
    positions: &mut Vec<u32>,
) -> Option<FuzzyMatch> {
    positions.clear();
    let score = pattern.indices(Utf32Str::new(candidate, buf), matcher, positions)?;
    positions.sort_unstable();
    positions.dedup();
    Some(FuzzyMatch {
        score,
        positions: positions
            .iter()
            .map(|position| *position as usize)
            .collect(),
    })
}

fn shift_positions(positions: &[usize], offset: usize) -> Vec<usize> {
    positions
        .iter()
        .map(|position| position.saturating_add(offset))
        .collect()
}

fn file_reference_title(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn file_title_rank(search_lower: &str, title_lower: &str, title_matches: bool) -> u8 {
    if search_lower.is_empty() {
        return 0;
    }
    if title_lower == search_lower {
        4
    } else if title_lower.starts_with(search_lower) {
        3
    } else if title_lower.contains(search_lower) {
        2
    } else if title_matches {
        1
    } else {
        0
    }
}

fn file_path_depth(path: &str) -> usize {
    path.chars().filter(|ch| *ch == '/').count()
}

fn resolve_agent_executable(name: &str, override_env: &str) -> String {
    if let Some(value) = std::env::var_os(override_env) {
        let path = PathBuf::from(value);
        if is_executable_file(&path) {
            return path.display().to_string();
        }
    }
    if name == "claude" {
        if let Some(path) = resolve_executable_with_filter(name, |path| {
            !path
                .to_string_lossy()
                .contains("/Applications/cmux.app/Contents/Resources/bin/")
        }) {
            return path;
        }
    }
    resolve_executable_with_filter(name, |_| true).unwrap_or_else(|| name.to_string())
}

fn resolve_executable_with_filter<F>(name: &str, filter: F) -> Option<String>
where
    F: Fn(&Path) -> bool,
{
    if name.contains('/') {
        let path = Path::new(name);
        return (is_executable_file(path) && filter(path)).then(|| name.to_string());
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if is_executable_file(&candidate) && filter(&candidate) {
            return Some(candidate.display().to_string());
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn env_args(names: &[&str]) -> String {
    names
        .iter()
        .filter_map(|name| {
            let value = std::env::var(name).ok()?;
            (!value.is_empty()).then(|| format!("{name}={}", shell_quote(&value)))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn non_empty_lines(mut lines: Vec<String>) -> Vec<String> {
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn draft_from_parts(
    lines: Vec<String>,
    image_paths: Vec<String>,
    provider: AgentKind,
    plan_mode: bool,
) -> PersistedDraft {
    PersistedDraft {
        lines,
        image_paths,
        provider: provider.label().to_string(),
        plan_mode,
        saved_at_ms: now_millis(),
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
                app.stash_current_draft();
            }
        }
        KeyEvent {
            code: KeyCode::Char('y'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            app.status_line = "use /stash to restore".to_string();
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
        } if matches!(app.view_mode, ViewMode::Stashes | ViewMode::History) => {
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
                app.toggle_plan_mode();
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
            app.sync_focus_after_composer_change();
        }
        KeyEvent {
            code: KeyCode::Tab, ..
        }
        | KeyEvent {
            code: KeyCode::Char('\t'),
            ..
        }
        | KeyEvent {
            code: KeyCode::Char('i'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            if !complete_autocomplete_selection(app) {
                app.toggle_provider();
            }
        }
        KeyEvent {
            code: KeyCode::Backspace,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if delete_image_token_before_cursor(&mut app.composer) {
                app.selected_image = None;
                app.sync_focus_after_composer_change();
            } else {
                app.selected_image = None;
                app.composer.input(key);
                app.sync_focus_after_composer_change();
            }
        }
        KeyEvent {
            code: KeyCode::Delete,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if delete_image_token_after_cursor(&mut app.composer) {
                app.selected_image = None;
                app.sync_focus_after_composer_change();
            } else {
                app.selected_image = None;
                app.composer.input(key);
                app.sync_focus_after_composer_change();
            }
        }
        KeyEvent {
            code: KeyCode::Left,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !navigate_image_token(app, CursorMove::Back) {
                app.composer.input(key);
                app.sync_focus_after_composer_change();
            }
        }
        KeyEvent {
            code: KeyCode::Right,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !navigate_image_token(app, CursorMove::Forward) {
                app.composer.input(key);
                app.sync_focus_after_composer_change();
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
        } if app.view_mode == ViewMode::History => {
            app.restore_selected_history();
        }
        KeyEvent {
            code: KeyCode::Enter,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if app.composer_has_text() {
                app.submit_new_workspace()?;
                return Ok(KeyAction::Continue);
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
            app.selected_image = None;
            app.composer.input(key);
            normalize_composer_image_paths(app);
            app.sync_focus_after_composer_change();
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
                if complete_autocomplete_selection(app) {
                    return Ok(KeyAction::Continue);
                }
                if handle_composer_command(app) {
                    return Ok(KeyAction::Continue);
                }
                app.submit_new_workspace()?;
                return Ok(KeyAction::Continue);
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
            app.sync_focus_after_composer_change();
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
            app.toggle_plan_mode();
        }
        KeyEvent {
            code: KeyCode::Tab, ..
        }
        | KeyEvent {
            code: KeyCode::Char('\t'),
            ..
        }
        | KeyEvent {
            code: KeyCode::Char('i'),
            modifiers: KeyModifiers::CONTROL,
            ..
        } => {
            if !complete_autocomplete_selection(app) {
                app.toggle_provider();
            }
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
            if delete_image_token_before_cursor(&mut app.composer) {
                app.selected_image = None;
                app.sync_focus_after_composer_change();
            } else {
                app.selected_image = None;
                app.composer.input(key);
                app.sync_focus_after_composer_change();
            }
        }
        KeyEvent {
            code: KeyCode::Delete,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if delete_image_token_after_cursor(&mut app.composer) {
                app.selected_image = None;
                app.sync_focus_after_composer_change();
            } else {
                app.selected_image = None;
                app.composer.input(key);
                app.sync_focus_after_composer_change();
            }
        }
        KeyEvent {
            code: KeyCode::Left,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !navigate_image_token(app, CursorMove::Back) {
                app.composer.input(key);
                app.sync_focus_after_composer_change();
            }
        }
        KeyEvent {
            code: KeyCode::Right,
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !navigate_image_token(app, CursorMove::Forward) {
                app.composer.input(key);
                app.sync_focus_after_composer_change();
            }
        }
        KeyEvent {
            code: KeyCode::Left | KeyCode::Right | KeyCode::Up | KeyCode::Down,
            modifiers: KeyModifiers::SHIFT,
            ..
        } => {
            app.selected_image = None;
            app.composer.input(key);
            app.sync_focus_after_composer_change();
        }
        KeyEvent {
            code: KeyCode::Char(' '),
            modifiers: KeyModifiers::NONE,
            ..
        } => {
            if !open_image_token_at_cursor(app) {
                app.selected_image = None;
                app.composer.input(key);
                normalize_composer_image_paths(app);
                app.sync_focus_after_composer_change();
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
        } if app.autocomplete_is_active() => {
            app.focus_target = FocusTarget::Autocomplete;
            app.select_previous_autocomplete();
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
        } if app.autocomplete_is_active() => {
            app.focus_target = FocusTarget::Autocomplete;
            app.select_next_autocomplete();
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
            app.selected_image = None;
            app.composer.input(key);
            normalize_composer_image_paths(app);
            app.sync_focus_after_composer_change();
        }
    }
    Ok(KeyAction::Continue)
}

fn handle_composer_command(app: &mut App) -> bool {
    if app.composer_mode != ComposerMode::NewWorkspace {
        return false;
    }

    let text = app.composer.lines().join("\n").trim().to_string();
    if text == "/history" {
        app.reset_composer();
        app.open_history_view();
        return true;
    }

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
            app.stashes.push(draft_from_parts(
                draft_text.lines().map(str::to_string).collect(),
                Vec::new(),
                app.provider,
                app.plan_mode,
            ));
            app.reset_composer();
            app.status_line = format!("stashed draft {}", app.stashes.len());
        }
        return true;
    }

    if text.starts_with('/') || text.starts_with('$') {
        if complete_autocomplete_selection(app) {
            return true;
        }
        app.status_line = "unknown command".to_string();
        return true;
    }

    false
}

fn complete_autocomplete_selection(app: &mut App) -> bool {
    let Some(query) = app.autocomplete_query() else {
        return false;
    };
    let items = app.autocomplete_items();
    let Some(item) = items.get(app.autocomplete.selected).cloned() else {
        return false;
    };
    let current_text = app.composer.lines().join("\n").trim().to_string();
    if item.kind == AutocompleteKind::Command && current_text == item.insert_text.trim_end() {
        return false;
    }
    let mut lines = app.composer.lines().to_vec();
    let Some(line) = lines.get_mut(query.row) else {
        return false;
    };
    let chars = line.chars().collect::<Vec<_>>();
    let start_col = query.start_col.min(chars.len());
    let end_col = query.end_col.min(chars.len()).max(start_col);
    let before = chars[..start_col].iter().collect::<String>();
    let mut after = chars[end_col..].iter().collect::<String>();
    if item.insert_text.ends_with(' ') && after.chars().next().is_some_and(char::is_whitespace) {
        after = after.chars().skip(1).collect::<String>();
    }
    *line = format!("{before}{}{after}", item.insert_text);

    let cursor_col = start_col + item.insert_text.chars().count();
    app.composer = composer_from_lines(lines);
    for _ in 0..query.row {
        app.composer.move_cursor(CursorMove::Down);
    }
    for _ in 0..cursor_col {
        app.composer.move_cursor(CursorMove::Forward);
    }
    app.selected_image = None;
    app.status_line = match item.kind {
        AutocompleteKind::Command => format!("command {}", item.label),
        AutocompleteKind::File => format!("file {}", item.label),
        AutocompleteKind::Skill => format!("skill {}", item.label),
    };
    app.sync_focus_after_composer_change();
    true
}

fn command_suggestions_for_query(query: &str) -> Vec<CommandSuggestionMatch> {
    let search = query.trim_start().trim_start_matches('/').trim();
    let pattern = fuzzy_pattern(search);
    let mut matcher = fuzzy_matcher(false);
    let mut buf = Vec::new();
    let mut positions = Vec::new();
    let mut matches = COMMAND_SUGGESTIONS
        .iter()
        .copied()
        .filter_map(|suggestion| {
            let candidate = suggestion.command.trim_start_matches('/');
            let match_item =
                fuzzy_match_candidate(&pattern, &mut matcher, candidate, &mut buf, &mut positions)?;
            Some((match_item.score, match_item.positions, suggestion))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|(score_a, _, suggestion_a), (score_b, _, suggestion_b)| {
        score_b
            .cmp(score_a)
            .then_with(|| suggestion_a.command.len().cmp(&suggestion_b.command.len()))
            .then_with(|| suggestion_a.command.cmp(suggestion_b.command))
    });
    matches
        .into_iter()
        .map(|(_, positions, suggestion)| CommandSuggestionMatch {
            command: suggestion.command,
            detail: suggestion.detail,
            positions: shift_positions(&positions, 1),
        })
        .collect()
}

fn handle_mouse(app: &mut App, mouse: MouseEvent, area: Rect) {
    let reserved_bottom = app.bottom_reserved_height(area.height, area.width);
    let workspace_end = area.height.saturating_sub(reserved_bottom);
    if mouse.row >= workspace_end {
        return;
    }
    let autocomplete_rows = autocomplete_height(app, workspace_end);
    let autocomplete_start = workspace_end.saturating_sub(autocomplete_rows);

    match mouse.kind {
        MouseEventKind::ScrollUp => {
            if app.autocomplete_is_active() && mouse.row >= autocomplete_start {
                app.autocomplete.scroll = app.autocomplete.scroll.saturating_sub(3);
            } else {
                app.scroll_list(-3, autocomplete_start);
            }
        }
        MouseEventKind::ScrollDown => {
            if app.autocomplete_is_active() && mouse.row >= autocomplete_start {
                let len = app.autocomplete_items().len();
                app.autocomplete.scroll = app.autocomplete.scroll.saturating_add(3).min(len);
            } else {
                app.scroll_list(3, autocomplete_start);
            }
        }
        MouseEventKind::Down(MouseButton::Left) => {
            if app.autocomplete_is_active() && mouse.row >= autocomplete_start {
                let relative = usize::from(mouse.row.saturating_sub(autocomplete_start));
                if relative > 0 {
                    let index = app.autocomplete.scroll.saturating_add(relative - 1);
                    let len = app.autocomplete_items().len();
                    if index < len {
                        app.autocomplete.selected = index;
                        app.focus_target = FocusTarget::Autocomplete;
                    }
                }
                return;
            }
            if matches!(app.view_mode, ViewMode::Stashes | ViewMode::History) {
                if mouse.row > 0 {
                    let row = app
                        .list_scroll
                        .saturating_add(usize::from(mouse.row.saturating_sub(1)));
                    app.selected = row.min(app.active_draft_list_len().saturating_sub(1));
                    app.focus_target = FocusTarget::MainContent;
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
                app.focus_target = FocusTarget::MainContent;
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
        let mut insertion = rendered.join(" ");
        insertion.push(' ');
        app.composer.insert_str(&insertion);
        app.selected_image = None;
    } else {
        app.selected_image = None;
        app.composer.insert_str(text);
    }
    app.sync_focus_after_composer_change();
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
                let mut next = rendered.join(" ");
                next.push(' ');
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
    select_image_token_at_cursor(app);
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

fn navigate_image_token(app: &mut App, movement: CursorMove) -> bool {
    if let Some(selection) = app.selected_image.take() {
        let current_col = app.composer.cursor().1;
        let target = match movement {
            CursorMove::Back => selection.start,
            CursorMove::Forward => selection.end,
            _ => return false,
        };
        move_cursor_to_col(&mut app.composer, current_col, target);
        return true;
    }

    let Some((line, row, col)) = composer_line_at_cursor(&app.composer) else {
        return false;
    };
    let ranges = image_token_refs(&line);
    match movement {
        CursorMove::Back => {
            if let Some((start, end, image_number)) = ranges
                .into_iter()
                .find(|(start, end, _)| col > *start && col <= *end)
            {
                app.selected_image =
                    image_number
                        .checked_sub(1)
                        .map(|image_index| ImageSelection {
                            row,
                            start,
                            end,
                            image_index,
                        });
                return true;
            }
        }
        CursorMove::Forward => {
            if let Some((start, end, image_number)) = ranges
                .into_iter()
                .find(|(start, end, _)| col >= *start && col < *end)
            {
                app.selected_image =
                    image_number
                        .checked_sub(1)
                        .map(|image_index| ImageSelection {
                            row,
                            start,
                            end,
                            image_index,
                        });
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
    let Some(image_index) = app
        .selected_image
        .as_ref()
        .map(|selection| selection.image_index)
        .or_else(|| image_token_at_cursor(&app.composer))
    else {
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

fn select_image_token_at_cursor(app: &mut App) -> bool {
    let Some((line, row, col)) = composer_line_at_cursor(&app.composer) else {
        app.selected_image = None;
        return false;
    };
    let Some((start, end, image_number)) = image_token_refs(&line)
        .into_iter()
        .find(|(_, end, _)| col == *end)
        .or_else(|| {
            image_token_refs(&line)
                .into_iter()
                .find(|(start, end, _)| col > *start && col < *end)
        })
    else {
        app.selected_image = None;
        return false;
    };
    app.selected_image = image_number
        .checked_sub(1)
        .map(|image_index| ImageSelection {
            row,
            start,
            end,
            image_index,
        });
    app.selected_image.is_some()
}

fn image_token_at_cursor(textarea: &TextArea<'static>) -> Option<usize> {
    let (line, _, col) = composer_line_at_cursor(textarea)?;
    image_token_refs(&line)
        .into_iter()
        .find(|(start, end, _)| col > *start && col < *end)
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
    let screen_width = frame.area().width;
    let composer_height = app.composer_height(screen_height, screen_width);
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
    let (row, _) = app.composer.cursor();
    let visible_start = composer_visible_start(app, areas[2].height as usize, areas[2].width);
    let (cursor_visual_row, cursor_visual_col) =
        composer_cursor_visual_position(app, areas[2].width);
    let visible_row = cursor_visual_row.saturating_sub(visible_start);
    let prompt_width = composer_prompt_width(row);
    let cursor_col = if app.composer_is_active() {
        cursor_visual_col
    } else {
        0
    };
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

    let visible_start = composer_visible_start(app, area.height as usize, area.width);
    let lines = wrapped_composer_lines(app, area.width)
        .into_iter()
        .skip(visible_start)
        .take(area.height as usize)
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), area);
}

fn wrapped_composer_lines(app: &App, width: u16) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for (row, text) in app.composer.lines().iter().enumerate() {
        let text_width = composer_text_width(width, row);
        let content = render_composer_content_spans(app, row, text);
        let chunks = wrap_spans(content, text_width);
        for (chunk_index, chunk) in chunks.into_iter().enumerate() {
            let prompt = if row == 0 && chunk_index == 0 {
                COMPOSER_PROMPT
            } else {
                COMPOSER_CONTINUATION_PROMPT
            };
            let mut spans = vec![Span::styled(prompt, muted_style())];
            spans.extend(chunk);
            lines.push(Line::from(spans));
        }
    }
    if lines.is_empty() {
        lines.push(Line::raw(""));
    }
    lines
}

fn render_composer_content_spans(app: &App, row: usize, text: &str) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    if let Some((selection_start, selection_end)) = composer_selection_for_row(app, row, text) {
        append_selected_text_spans(&mut spans, text, selection_start, selection_end);
        return spans;
    }

    let image_refs = image_token_refs(text);
    let reference_refs = composer_reference_ranges(app, text);
    if image_refs.is_empty() && reference_refs.is_empty() {
        spans.push(Span::styled(text.to_string(), input_style()));
        return spans;
    }

    let chars = text.chars().collect::<Vec<_>>();
    let image_ranges = image_refs
        .into_iter()
        .map(|(start, end, image_number)| (start, end, Some(image_number), None))
        .chain(
            reference_refs
                .into_iter()
                .map(|range| (range.start, range.end, None, Some(range.kind))),
        )
        .collect::<Vec<_>>();
    let mut ranges = image_ranges;
    ranges.sort_by_key(|(start, end, _, _)| (*start, *end));
    let mut cursor = 0;
    for (start, end, image_number, reference_kind) in ranges {
        if start < cursor || start >= end || end > chars.len() {
            continue;
        }
        if cursor < start {
            spans.push(Span::styled(
                chars[cursor..start].iter().collect::<String>(),
                input_style(),
            ));
        }
        let style = if let Some(image_number) = image_number {
            let selected = app.selected_image.as_ref().is_some_and(|selection| {
                selection.row == row
                    && selection.start == start
                    && selection.end == end
                    && Some(selection.image_index) == image_number.checked_sub(1)
            });
            image_token_style(selected)
        } else if let Some(kind) = reference_kind {
            composer_reference_style(kind)
        } else {
            input_style()
        };
        spans.push(Span::styled(
            chars[start..end].iter().collect::<String>(),
            style,
        ));
        cursor = end;
    }
    if cursor < chars.len() {
        spans.push(Span::styled(
            chars[cursor..].iter().collect::<String>(),
            input_style(),
        ));
    }
    spans
}

fn wrap_spans(spans: Vec<Span<'static>>, width: usize) -> Vec<Vec<Span<'static>>> {
    let width = width.max(1);
    let mut rows = vec![Vec::new()];
    let mut col = 0;
    for span in spans {
        let style = span.style;
        let content = span.content.to_string();
        for ch in content.chars() {
            if col >= width {
                rows.push(Vec::new());
                col = 0;
            }
            rows.last_mut()
                .expect("wrapped composer rows are initialized")
                .push(Span::styled(ch.to_string(), style));
            col += 1;
        }
    }
    rows
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

fn append_selected_text_spans(
    spans: &mut Vec<Span<'static>>,
    text: &str,
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

fn composer_reference_ranges(app: &App, text: &str) -> Vec<ComposerHighlightRange> {
    let chars = text.chars().collect::<Vec<_>>();
    let mut ranges = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let marker = chars[index];
        if !matches!(marker, '$' | '/' | '@')
            || (index > 0 && !chars[index - 1].is_whitespace())
            || index + 1 >= chars.len()
            || chars[index + 1].is_whitespace()
        {
            index += 1;
            continue;
        }

        let mut end = index + 1;
        while end < chars.len() && !chars[end].is_whitespace() {
            end += 1;
        }
        let body = chars[index + 1..end].iter().collect::<String>();
        let kind = match marker {
            '@' => Some(ComposerReferenceKind::File),
            '$' => Some(ComposerReferenceKind::Skill),
            '/' if command_name_exists(&body) => Some(ComposerReferenceKind::Command),
            '/' if skill_name_exists(&app.skills, &body) => Some(ComposerReferenceKind::Skill),
            '/' => Some(ComposerReferenceKind::Command),
            _ => None,
        };
        if let Some(kind) = kind {
            ranges.push(ComposerHighlightRange {
                start: index,
                end,
                kind,
            });
        }
        index = end;
    }
    ranges
}

fn command_name_exists(name: &str) -> bool {
    let command = format!("/{name}");
    COMMAND_SUGGESTIONS
        .iter()
        .any(|suggestion| suggestion.command == command)
}

fn skill_name_exists(skills: &[SkillEntry], name: &str) -> bool {
    skills
        .iter()
        .any(|skill| skill.name.eq_ignore_ascii_case(name))
}

fn composer_prompt_width(row: usize) -> usize {
    if row == 0 {
        COMPOSER_PROMPT.chars().count()
    } else {
        COMPOSER_CONTINUATION_PROMPT.chars().count()
    }
}

fn composer_text_width(width: u16, row: usize) -> usize {
    usize::from(width)
        .saturating_sub(composer_prompt_width(row))
        .max(1)
}

fn visual_line_count_for_text(text: &str, width: usize) -> usize {
    let len = text.chars().count();
    if len == 0 {
        1
    } else {
        len.div_ceil(width.max(1))
    }
}

fn composer_visual_line_count(app: &App, width: u16) -> usize {
    app.composer
        .lines()
        .iter()
        .enumerate()
        .map(|(row, text)| visual_line_count_for_text(text, composer_text_width(width, row)))
        .sum::<usize>()
        .max(1)
}

fn composer_cursor_visual_position(app: &App, width: u16) -> (usize, usize) {
    let (cursor_row, cursor_col) = app.composer.cursor();
    let visual_row_before_cursor = app
        .composer
        .lines()
        .iter()
        .enumerate()
        .take(cursor_row)
        .map(|(row, text)| visual_line_count_for_text(text, composer_text_width(width, row)))
        .sum::<usize>();
    let text_width = composer_text_width(width, cursor_row);
    let (row_offset, col_offset) = if cursor_col > 0 && cursor_col % text_width == 0 {
        ((cursor_col - 1) / text_width, text_width.saturating_sub(1))
    } else {
        (cursor_col / text_width, cursor_col % text_width)
    };
    (visual_row_before_cursor + row_offset, col_offset)
}

fn composer_visible_start(app: &App, height: usize, width: u16) -> usize {
    let (cursor_row, _) = composer_cursor_visual_position(app, width);
    cursor_row.saturating_add(1).saturating_sub(height.max(1))
}

fn draw_workspaces(frame: &mut Frame<'_>, area: Rect, app: &mut App) {
    if app.view_mode == ViewMode::Stashes {
        draw_draft_list(
            frame,
            area,
            app,
            "Stashes",
            "no stashes",
            app.stashes.clone(),
        );
        return;
    }
    if app.view_mode == ViewMode::History {
        draw_draft_list(
            frame,
            area,
            app,
            "History",
            "no previous prompts",
            app.history.clone(),
        );
        return;
    }
    if app.autocomplete_is_active() {
        let suggestions_height = autocomplete_height(app, area.height);
        if suggestions_height == 0 || suggestions_height >= area.height {
            draw_autocomplete(frame, area, app);
            return;
        }
        let areas = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1), Constraint::Length(suggestions_height)])
            .split(area);
        draw_workspace_list(frame, areas[0], app);
        draw_autocomplete(frame, areas[1], app);
        return;
    }
    draw_workspace_list(frame, area, app);
}

fn draw_workspace_list(frame: &mut Frame<'_>, area: Rect, app: &mut App) {
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

fn autocomplete_height(app: &App, available_height: u16) -> u16 {
    if !app.autocomplete_is_active() {
        return 0;
    }
    let row_count = app.autocomplete_items().len().max(1);
    let desired = (row_count + 1).min(MAX_AUTOCOMPLETE_ROWS + 1) as u16;
    desired.min(available_height.saturating_sub(1))
}

fn draw_autocomplete(frame: &mut Frame<'_>, area: Rect, app: &mut App) {
    let items = app.autocomplete_items();
    let viewport = area.height.saturating_sub(1) as usize;
    app.autocomplete.ensure_visible(viewport, items.len());
    let title = match app.autocomplete_query().map(|query| query.marker) {
        Some(AutocompleteMarker::Dollar) => "Skills",
        Some(AutocompleteMarker::At) => "Files",
        _ => "Commands and skills",
    };
    let mut lines = vec![Line::from(Span::styled(title, muted_style()))];
    if items.is_empty() {
        lines.push(Line::from(Span::styled("  no matches", muted_style())));
    } else {
        lines.extend(
            items
                .into_iter()
                .enumerate()
                .skip(app.autocomplete.scroll)
                .take(viewport)
                .map(|(index, item)| {
                    render_autocomplete_row(
                        &item,
                        index == app.autocomplete.selected,
                        area.width as usize,
                    )
                }),
        );
    }
    frame.render_widget(Paragraph::new(lines), area);
}

fn render_autocomplete_row(item: &AutocompleteItem, selected: bool, width: usize) -> Line<'static> {
    let marker = match item.kind {
        AutocompleteKind::Command => "cmd",
        AutocompleteKind::File => "file",
        AutocompleteKind::Skill => "skill",
    };
    let label_width = 24;
    let marker_width = 7;
    let detail_width = width.saturating_sub(label_width + marker_width).max(8);
    let (label, label_positions) =
        truncate_end_with_positions(&item.label, &item.label_match_positions, label_width);
    let label = format!("{label:<label_width$}");
    let (detail, detail_positions) = if item.kind == AutocompleteKind::File {
        truncate_middle_with_positions(&item.detail, &item.detail_match_positions, detail_width)
    } else {
        truncate_end_with_positions(&item.detail, &item.detail_match_positions, detail_width)
    };
    let content_width = marker_width + label_width + detail.chars().count();
    let trailing = width.saturating_sub(content_width);
    let base_style = if selected {
        selected_style()
    } else {
        muted_style()
    };
    let label_style = if selected {
        selected_title_style()
    } else {
        input_style()
    };
    let mut spans = vec![Span::styled(format!("  {marker:<4} "), base_style)];
    spans.extend(highlighted_text_spans(
        &label,
        &label_positions,
        label_style,
        autocomplete_match_style(selected),
    ));
    spans.extend(highlighted_text_spans(
        &detail,
        &detail_positions,
        base_style,
        autocomplete_match_style(selected),
    ));
    spans.push(Span::styled(" ".repeat(trailing), base_style));
    Line::from(spans)
}

fn highlighted_text_spans(
    text: &str,
    positions: &[usize],
    normal_style: Style,
    match_style: Style,
) -> Vec<Span<'static>> {
    if positions.is_empty() {
        return vec![Span::styled(text.to_string(), normal_style)];
    }
    let position_set = positions.iter().copied().collect::<HashSet<_>>();
    let mut spans = Vec::new();
    let mut current = String::new();
    let mut current_is_match = false;
    for (index, ch) in text.chars().enumerate() {
        let is_match = position_set.contains(&index);
        if current.is_empty() {
            current_is_match = is_match;
        } else if is_match != current_is_match {
            spans.push(Span::styled(
                std::mem::take(&mut current),
                if current_is_match {
                    match_style
                } else {
                    normal_style
                },
            ));
            current_is_match = is_match;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        spans.push(Span::styled(
            current,
            if current_is_match {
                match_style
            } else {
                normal_style
            },
        ));
    }
    spans
}

fn truncate_end_with_positions(
    text: &str,
    positions: &[usize],
    max_chars: usize,
) -> (String, Vec<usize>) {
    let char_count = text.chars().count();
    if char_count <= max_chars {
        return (text.to_string(), positions.to_vec());
    }
    if max_chars <= 1 {
        return ("…".to_string(), Vec::new());
    }
    let keep = max_chars.saturating_sub(1);
    let truncated = format!("{}…", text.chars().take(keep).collect::<String>());
    let positions = positions
        .iter()
        .copied()
        .filter(|position| *position < keep)
        .collect();
    (truncated, positions)
}

fn truncate_middle_with_positions(
    text: &str,
    positions: &[usize],
    max_chars: usize,
) -> (String, Vec<usize>) {
    let chars = text.chars().collect::<Vec<_>>();
    let char_count = chars.len();
    if char_count <= max_chars {
        return (text.to_string(), positions.to_vec());
    }
    if max_chars <= 1 {
        return ("…".to_string(), Vec::new());
    }
    let available = max_chars.saturating_sub(1);
    let front = available / 2;
    let back = available.saturating_sub(front);
    let back_start = char_count.saturating_sub(back);
    let truncated = format!(
        "{}…{}",
        chars[..front].iter().collect::<String>(),
        chars[back_start..].iter().collect::<String>()
    );
    let positions = positions
        .iter()
        .filter_map(|position| {
            if *position < front {
                Some(*position)
            } else if *position >= back_start {
                Some(front + 1 + position.saturating_sub(back_start))
            } else {
                None
            }
        })
        .collect();
    (truncated, positions)
}

fn autocomplete_match_style(selected: bool) -> Style {
    let style = Style::default()
        .fg(Color::Rgb(86, 156, 214))
        .add_modifier(Modifier::BOLD);
    if selected {
        style.bg(Color::Rgb(55, 55, 55))
    } else {
        style
    }
}

fn draw_draft_list(
    frame: &mut Frame<'_>,
    area: Rect,
    app: &mut App,
    title: &str,
    empty_label: &str,
    drafts: Vec<PersistedDraft>,
) {
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
        .min(drafts.len().saturating_sub(viewport_rows));
    let mut lines = vec![Line::from(Span::styled(
        format!("{title} ({})", drafts.len()),
        muted_style(),
    ))];

    if drafts.is_empty() {
        lines.push(Line::from(Span::styled(
            format!("  {empty_label}"),
            muted_style(),
        )));
    } else {
        lines.extend(
            drafts
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

fn composer_reference_style(kind: ComposerReferenceKind) -> Style {
    match kind {
        ComposerReferenceKind::Command => purple_style(),
        ComposerReferenceKind::File => Style::default().fg(Color::Rgb(86, 156, 214)),
        ComposerReferenceKind::Skill => Style::default().fg(Color::Rgb(175, 150, 255)),
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
                "  ctrl+s to stash           alt+1-6 to open         esc/? to main",
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

    if app.view_mode == ViewMode::History {
        frame.render_widget(
            Paragraph::new("  enter restore · esc main · ? shortcuts").style(muted_style()),
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
                if app.autocomplete_is_active() {
                    let mut help_spans = current_agent_mode_spans(app);
                    help_spans.push(Span::styled(
                        " · enter/tab complete · ctrl+n/p select · esc clear",
                        muted_style(),
                    ));
                    frame.render_widget(Paragraph::new(Line::from(help_spans)), area);
                    return;
                }
                let mut help_spans = current_agent_mode_spans(app);
                help_spans.extend([
                    Span::styled(
                        " · enter create · ctrl+s stash · tab switch agent",
                        muted_style(),
                    ),
                    Span::styled(" · shift+tab switch mode", muted_style()),
                    Span::styled(" · esc clear", muted_style()),
                ]);
                frame.render_widget(Paragraph::new(Line::from(help_spans)), area);
            }
        }
        return;
    }

    let prefix = if app.selected_group().is_some() {
        "  enter to collapse · ctrl+x to delete all"
    } else {
        "  enter to open · space to reply · ctrl+x to delete"
    };
    let mut help_spans = current_agent_mode_spans(app);
    help_spans.extend([
        Span::styled(format!(" · {}", prefix.trim()), muted_style()),
        Span::styled(" · tab switch agent", muted_style()),
        Span::styled(" · shift+tab switch mode", muted_style()),
        Span::styled(" · ? for shortcuts", muted_style()),
    ]);
    frame.render_widget(Paragraph::new(Line::from(help_spans)), area);
}

fn current_agent_mode_spans(app: &App) -> Vec<Span<'static>> {
    vec![
        Span::styled("  ", muted_style()),
        Span::styled(
            app.provider.label().to_string(),
            agent_style(app.provider, false),
        ),
        Span::styled(" ".to_string(), muted_style()),
        Span::styled(
            if app.plan_mode { "plan" } else { "build" }.to_string(),
            if app.plan_mode {
                purple_style()
            } else {
                build_style()
            },
        ),
    ]
}

fn build_style() -> Style {
    Style::default().fg(Color::Rgb(124, 189, 107))
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
    let workspaces = workspaces_payload
        .get("workspaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let conversations_by_workspace = load_conversations_by_workspace(&mut client, &workspaces);

    let mut next = Vec::new();
    for item in workspaces {
        let unread_notifications = workspace_item_keys(&item)
            .iter()
            .find_map(|key| unread_by_workspace.get(key))
            .copied()
            .unwrap_or(0);
        let conversation = workspace_item_keys(&item)
            .iter()
            .find_map(|key| conversations_by_workspace.get(key));
        if let Some(workspace) =
            workspace_from_list_item(&mut client, &item, unread_notifications, conversation)
        {
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
    let workspaces = workspaces_payload
        .get("workspaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let item = workspaces
        .iter()
        .find(|item| {
            workspace_item_keys(item)
                .iter()
                .any(|key| key == workspace_id)
        })
        .cloned();
    let Some(item) = item else {
        return Ok(None);
    };
    let conversations_by_workspace =
        load_conversations_by_workspace(&mut client, std::slice::from_ref(&item));
    let unread_notifications = workspace_item_keys(&item)
        .iter()
        .find_map(|key| unread_by_workspace.get(key))
        .copied()
        .unwrap_or(0);
    let conversation = workspace_item_keys(&item)
        .iter()
        .find_map(|key| conversations_by_workspace.get(key));
    Ok(workspace_from_list_item(
        &mut client,
        &item,
        unread_notifications,
        conversation,
    ))
}

fn workspace_from_list_item(
    client: &mut CmuxClient,
    item: &Value,
    unread_notifications: usize,
    conversation: Option<&ConversationSnapshot>,
) -> Option<WorkspaceStatus> {
    let id = workspace_primary_id(item).unwrap_or_default();
    if id.is_empty() {
        return None;
    }
    let description = string_field(item, "description");
    let conversation = conversation.cloned();
    let latest_message = conversation
        .as_ref()
        .map(|snapshot| snapshot.preview.clone())
        .filter(|preview| !preview.is_empty())
        .or_else(|| {
            client
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
        })
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
        conversation,
        updated_at: None,
    };
    if let Ok(sidebar) = client.v1(&format!("sidebar_state --tab={id}")) {
        workspace.statuses = parse_sidebar_statuses(&sidebar);
    }
    Some(workspace)
}

fn workspace_primary_id(item: &Value) -> Option<String> {
    string_field(item, "id").or_else(|| string_field(item, "ref"))
}

fn workspace_item_keys(item: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    for key in ["id", "ref"] {
        if let Some(value) = string_field(item, key) {
            if !keys.contains(&value) {
                keys.push(value);
            }
        }
    }
    keys
}

fn workspace_item_ref(item: &Value) -> Option<String> {
    string_field(item, "ref").or_else(|| string_field(item, "id"))
}

fn workspace_item_cwd(item: &Value) -> Option<String> {
    string_field(item, "current_directory").or_else(|| string_field(item, "cwd"))
}

#[derive(Default)]
struct TopConversationRefs {
    codex_sessions_by_workspace: HashMap<String, HashSet<String>>,
    claude_workspaces: HashSet<String>,
}

fn load_conversations_by_workspace(
    client: &mut CmuxClient,
    workspaces: &[Value],
) -> HashMap<String, ConversationSnapshot> {
    let top_command = if workspaces.len() == 1 {
        workspace_item_ref(&workspaces[0])
            .map(|workspace_ref| {
                format!("top --workspace {workspace_ref} --processes --format tsv")
            })
            .unwrap_or_else(|| "top --all --processes --format tsv".to_string())
    } else {
        "top --all --processes --format tsv".to_string()
    };
    let top = client.v1(&top_command).unwrap_or_default();
    let top_refs = parse_top_conversation_refs(&top);
    let mut conversations = HashMap::new();

    let codex_conversations = load_codex_conversations(&top_refs.codex_sessions_by_workspace);
    for item in workspaces {
        let Some(workspace_ref) = workspace_item_ref(item) else {
            continue;
        };
        let Some(session_ids) = top_refs.codex_sessions_by_workspace.get(&workspace_ref) else {
            continue;
        };
        let best = session_ids
            .iter()
            .filter_map(|session_id| codex_conversations.get(session_id))
            .max_by_key(|snapshot| snapshot.modified_at);
        if let Some(snapshot) = best.cloned() {
            insert_conversation_for_workspace(item, snapshot, &mut conversations);
        }
    }

    let mut claude_cwd_counts: HashMap<String, usize> = HashMap::new();
    for item in workspaces {
        let Some(workspace_ref) = workspace_item_ref(item) else {
            continue;
        };
        if !top_refs.claude_workspaces.contains(&workspace_ref) {
            continue;
        }
        if let Some(cwd) = workspace_item_cwd(item) {
            *claude_cwd_counts.entry(cwd).or_insert(0) += 1;
        }
    }

    for item in workspaces {
        let Some(workspace_ref) = workspace_item_ref(item) else {
            continue;
        };
        if !top_refs.claude_workspaces.contains(&workspace_ref) {
            continue;
        }
        let Some(cwd) = workspace_item_cwd(item) else {
            continue;
        };
        if claude_cwd_counts.get(&cwd).copied().unwrap_or(0) != 1 {
            continue;
        }
        if let Some(snapshot) = load_latest_claude_conversation_for_cwd(&cwd) {
            insert_conversation_for_workspace(item, snapshot, &mut conversations);
        }
    }

    conversations
}

fn insert_conversation_for_workspace(
    item: &Value,
    snapshot: ConversationSnapshot,
    conversations: &mut HashMap<String, ConversationSnapshot>,
) {
    for key in workspace_item_keys(item) {
        conversations.insert(key, snapshot.clone());
    }
}

fn parse_top_conversation_refs(text: &str) -> TopConversationRefs {
    let mut refs = TopConversationRefs::default();
    for line in text.lines() {
        let cols = line.split('\t').collect::<Vec<_>>();
        if cols.len() < 6 {
            continue;
        }
        let kind = cols[3];
        let id = cols[4];
        let parent = cols[5];
        if kind != "tag" || !parent.starts_with("workspace:") {
            continue;
        }
        if let Some(session_id) = extract_codex_session_id(id) {
            refs.codex_sessions_by_workspace
                .entry(parent.to_string())
                .or_default()
                .insert(session_id);
        }
        if id.contains(":tag:claude") {
            refs.claude_workspaces.insert(parent.to_string());
        }
    }
    refs
}

fn extract_codex_session_id(value: &str) -> Option<String> {
    let (_, rest) = value.split_once("codex.")?;
    let session_id = rest
        .chars()
        .take_while(|ch| ch.is_ascii_hexdigit() || *ch == '-')
        .collect::<String>();
    (session_id.len() >= 32).then_some(session_id)
}

fn load_codex_conversations(
    sessions_by_workspace: &HashMap<String, HashSet<String>>,
) -> HashMap<String, ConversationSnapshot> {
    let wanted = sessions_by_workspace
        .values()
        .flat_map(|ids| ids.iter().cloned())
        .collect::<HashSet<_>>();
    if wanted.is_empty() {
        return HashMap::new();
    }
    let mut paths_by_session = HashMap::new();
    for root in codex_session_roots() {
        collect_matching_session_files(&root, &wanted, &mut paths_by_session);
    }
    let mut conversations = HashMap::new();
    for (session_id, path) in paths_by_session {
        if let Some(snapshot) = parse_codex_conversation_file(&path) {
            conversations.insert(session_id, snapshot);
        }
    }
    conversations
}

fn codex_session_roots() -> Vec<PathBuf> {
    let Some(codex_home) = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| user_home().map(|home| home.join(".codex")))
    else {
        return Vec::new();
    };
    vec![
        codex_home.join("sessions"),
        codex_home.join("archived_sessions"),
    ]
}

fn collect_matching_session_files(
    dir: &Path,
    wanted: &HashSet<String>,
    paths_by_session: &mut HashMap<String, PathBuf>,
) {
    if paths_by_session.len() == wanted.len() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_matching_session_files(&path, wanted, paths_by_session);
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        for session_id in wanted {
            if paths_by_session.contains_key(session_id) {
                continue;
            }
            if file_name.contains(session_id) {
                paths_by_session.insert(session_id.clone(), path.clone());
            }
        }
    }
}

fn load_latest_claude_conversation_for_cwd(cwd: &str) -> Option<ConversationSnapshot> {
    let claude_home = std::env::var_os("CLAUDE_HOME")
        .map(PathBuf::from)
        .or_else(|| user_home().map(|home| home.join(".claude")))?;
    let project_dir = claude_home
        .join("projects")
        .join(claude_project_dir_name(cwd));
    let latest = latest_jsonl_file(&project_dir)?;
    parse_claude_conversation_file(&latest)
}

fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| {
            if ch == '/' || ch.is_whitespace() {
                '-'
            } else {
                ch
            }
        })
        .collect()
}

fn latest_jsonl_file(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .filter_map(|path| {
            let modified_at = fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified_at, path))
        })
        .max_by_key(|(modified_at, _)| *modified_at)
        .map(|(_, path)| path)
}

fn parse_codex_conversation_file(path: &Path) -> Option<ConversationSnapshot> {
    parse_conversation_file(path, |value| {
        let event_type = value.get("type").and_then(Value::as_str);
        let payload = value.get("payload")?;
        let payload_type = payload.get("type").and_then(Value::as_str);
        if event_type == Some("event_msg") && payload_type == Some("user_message") {
            return Some((
                ConversationActor::User,
                payload
                    .get("message")
                    .and_then(value_preview)
                    .or_else(|| payload.get("text_elements").and_then(value_preview))
                    .unwrap_or_default(),
            ));
        }
        if event_type == Some("response_item") && payload_type == Some("message") {
            let role = payload.get("role").and_then(Value::as_str)?;
            let actor = match role {
                "user" => ConversationActor::User,
                "assistant" => ConversationActor::Assistant,
                _ => return None,
            };
            return Some((
                actor,
                payload
                    .get("content")
                    .and_then(value_preview)
                    .unwrap_or_default(),
            ));
        }
        None
    })
}

fn parse_claude_conversation_file(path: &Path) -> Option<ConversationSnapshot> {
    parse_conversation_file(path, |value| {
        let role = value
            .pointer("/message/role")
            .and_then(Value::as_str)
            .or_else(|| value.get("type").and_then(Value::as_str))?;
        let actor = match role {
            "user" => ConversationActor::User,
            "assistant" => ConversationActor::Assistant,
            _ => return None,
        };
        let content = value
            .pointer("/message/content")
            .or_else(|| value.get("content"))?;
        if actor == ConversationActor::User && claude_user_content_is_tool_result(content) {
            return None;
        }
        let preview = value_preview(content).unwrap_or_default();
        if actor == ConversationActor::Assistant && preview.is_empty() {
            return None;
        }
        Some((actor, preview))
    })
}

fn parse_conversation_file<F>(path: &Path, mut parse_line: F) -> Option<ConversationSnapshot>
where
    F: FnMut(&Value) -> Option<(ConversationActor, String)>,
{
    let modified_at = fs::metadata(path).ok()?.modified().ok()?;
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut last_actor = None;
    let mut last_preview = String::new();
    for line in reader.lines().map_while(std::result::Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some((actor, preview)) = parse_line(&value) else {
            continue;
        };
        last_actor = Some(actor);
        if !preview.is_empty() {
            last_preview = preview;
        }
    }
    Some(ConversationSnapshot {
        actor: last_actor?,
        preview: last_preview,
        modified_at,
    })
}

fn value_preview(value: &Value) -> Option<String> {
    let mut parts = Vec::new();
    collect_value_text(value, &mut parts);
    let preview = parts.join(" ");
    (!preview.trim().is_empty()).then(|| one_line_preview(&preview, 240))
}

fn collect_value_text(value: &Value, parts: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            if !text.trim().is_empty() {
                parts.push(text.clone());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_value_text(item, parts);
            }
        }
        Value::Object(object) => {
            if object
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| matches!(kind, "tool_result" | "tool_use" | "function_call"))
            {
                return;
            }
            for key in ["text", "content", "message"] {
                if let Some(value) = object.get(key) {
                    collect_value_text(value, parts);
                }
            }
        }
        _ => {}
    }
}

fn claude_user_content_is_tool_result(value: &Value) -> bool {
    let Value::Array(items) = value else {
        return false;
    };
    !items.is_empty()
        && items.iter().all(|item| {
            item.get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind == "tool_result")
        })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_session_ids_from_top_tags() {
        let top = "\
0.0\t0\t0\ttag\tworkspace:ABC:tag:codex.019e266c-c7de-7052-b819-bcf5df17ada5\tworkspace:84\t\n\
0.0\t0\t0\ttag\tworkspace:ABC:tag:claude_code\tworkspace:40\tRunning\n";
        let refs = parse_top_conversation_refs(top);

        assert!(refs
            .codex_sessions_by_workspace
            .get("workspace:84")
            .is_some_and(|sessions| sessions.contains("019e266c-c7de-7052-b819-bcf5df17ada5")));
        assert!(refs.claude_workspaces.contains("workspace:40"));
    }

    #[test]
    fn ignores_claude_tool_result_user_messages() {
        let content = json!([
            {
                "type": "tool_result",
                "content": "command output"
            }
        ]);

        assert!(claude_user_content_is_tool_result(&content));
        assert!(value_preview(&content).is_none());
    }

    #[test]
    fn extracts_text_preview_from_message_content() {
        let content = json!([
            {
                "type": "text",
                "text": "hello\nworld"
            },
            {
                "type": "tool_use",
                "input": "ignored"
            }
        ]);

        assert_eq!(value_preview(&content).as_deref(), Some("hello world"));
    }

    #[test]
    fn created_workspace_event_starts_in_working_group() {
        let frame = EventFrame {
            kind: Some("event".to_string()),
            name: Some("workspace.created".to_string()),
            workspace_id: Some("workspace:1".to_string()),
            payload: json!({
                "workspace_id": "workspace:1",
                "title": "codex: fix submit flicker",
                "selected": false
            }),
        };

        let workspace = workspace_from_created_event(&frame, "workspace:1");

        assert_eq!(workspace.latest_message, "fix submit flicker");
        assert_eq!(display_group(workspace.agent_state()), AgentState::Working);
    }

    #[test]
    fn plain_created_workspace_event_does_not_fake_agent_work() {
        let frame = EventFrame {
            kind: Some("event".to_string()),
            name: Some("workspace.created".to_string()),
            workspace_id: Some("workspace:1".to_string()),
            payload: json!({
                "workspace_id": "workspace:1",
                "title": "shell",
                "selected": false
            }),
        };

        let workspace = workspace_from_created_event(&frame, "workspace:1");

        assert_eq!(workspace.latest_message, "starting workspace");
        assert!(workspace.conversation.is_none());
        assert_eq!(display_group(workspace.agent_state()), AgentState::Idle);
    }

    #[test]
    fn empty_refresh_preserves_recent_optimistic_submission() {
        let existing = WorkspaceStatus {
            id: "workspace:1".to_string(),
            title: "codex: fix submit flicker".to_string(),
            latest_message: "fix submit flicker".to_string(),
            conversation: Some(ConversationSnapshot {
                actor: ConversationActor::User,
                preview: "fix submit flicker".to_string(),
                modified_at: SystemTime::now(),
            }),
            ..WorkspaceStatus::default()
        };
        let mut refreshed = WorkspaceStatus {
            id: "workspace:1".to_string(),
            title: "codex: fix submit flicker".to_string(),
            latest_message: "standing by for task".to_string(),
            ..WorkspaceStatus::default()
        };

        preserve_optimistic_submission(&existing, &mut refreshed);

        assert_eq!(refreshed.latest_message, "fix submit flicker");
        assert_eq!(display_group(refreshed.agent_state()), AgentState::Working);
    }

    #[test]
    fn opening_history_selects_first_prompt() {
        let mut app = App::new(Args {
            socket: Some("/tmp/cmux-home-test.sock".to_string()),
            workspace_cwd: Some(".".to_string()),
            config: None,
            codex_command: "codex".to_string(),
            codex_plan_command: "codex".to_string(),
            claude_command: "claude".to_string(),
            claude_plan_command: "claude --permission-mode plan".to_string(),
        });
        app.history = vec![
            draft_from_parts(
                vec!["first".to_string()],
                Vec::new(),
                AgentKind::Codex,
                false,
            ),
            draft_from_parts(
                vec!["second".to_string()],
                Vec::new(),
                AgentKind::Codex,
                false,
            ),
        ];
        app.selected = 7;
        app.list_scroll = 4;

        app.open_history_view();

        assert_eq!(app.view_mode, ViewMode::History);
        assert_eq!(app.selected, 0);
        assert_eq!(app.list_scroll, 0);
    }

    #[test]
    fn autocomplete_query_works_inside_non_empty_composer() {
        let mut composer = composer_from_lines(vec!["please use $ver".to_string()]);
        composer.move_cursor(CursorMove::End);

        let query = autocomplete_query_at_cursor(&composer).expect("query");

        assert_eq!(query.marker, AutocompleteMarker::Dollar);
        assert_eq!(query.raw, "$ver");
        assert_eq!(query.search, "ver");
        assert_eq!(query.row, 0);
        assert_eq!(query.start_col, 11);
        assert_eq!(query.end_col, 15);
    }

    #[test]
    fn skill_completion_replaces_current_token_only() {
        let mut app = App::new(Args {
            socket: Some("/tmp/cmux-home-test.sock".to_string()),
            workspace_cwd: Some(".".to_string()),
            config: None,
            codex_command: "codex".to_string(),
            codex_plan_command: "codex".to_string(),
            claude_command: "claude".to_string(),
            claude_plan_command: "claude --permission-mode plan".to_string(),
        });
        app.skills = vec![SkillEntry {
            name: "verify".to_string(),
            description: String::new(),
            sources: vec!["codex".to_string()],
            priority: 0,
            path: PathBuf::from("/tmp/verify/SKILL.md"),
        }];
        app.composer = composer_from_lines(vec!["please use $ver now".to_string()]);
        app.composer.move_cursor(CursorMove::End);
        for _ in 0..4 {
            app.composer.move_cursor(CursorMove::Back);
        }

        assert!(complete_autocomplete_selection(&mut app));

        assert_eq!(
            app.composer.lines(),
            &["please use $verify now".to_string()]
        );
    }

    #[test]
    fn slash_skill_completion_uses_slash_prefix_inline() {
        let mut app = App::new(Args {
            socket: Some("/tmp/cmux-home-test.sock".to_string()),
            workspace_cwd: Some(".".to_string()),
            config: None,
            codex_command: "codex".to_string(),
            codex_plan_command: "codex".to_string(),
            claude_command: "claude".to_string(),
            claude_plan_command: "claude --permission-mode plan".to_string(),
        });
        app.skills = vec![SkillEntry {
            name: "review".to_string(),
            description: String::new(),
            sources: vec!["codex".to_string()],
            priority: 0,
            path: PathBuf::from("/tmp/review/SKILL.md"),
        }];
        app.composer = composer_from_lines(vec!["run /rev".to_string()]);
        app.composer.move_cursor(CursorMove::End);

        assert!(complete_autocomplete_selection(&mut app));

        assert_eq!(app.composer.lines(), &["run /review ".to_string()]);
    }

    #[test]
    fn at_file_completion_replaces_current_token_only() {
        let mut app = App::new(Args {
            socket: Some("/tmp/cmux-home-test.sock".to_string()),
            workspace_cwd: Some(".".to_string()),
            config: None,
            codex_command: "codex".to_string(),
            codex_plan_command: "codex".to_string(),
            claude_command: "claude".to_string(),
            claude_plan_command: "claude --permission-mode plan".to_string(),
        });
        app.file_references = vec![FileReference {
            path: "src/main.rs".to_string(),
        }];
        app.composer = composer_from_lines(vec!["read @main".to_string()]);
        app.composer.move_cursor(CursorMove::End);

        assert!(complete_autocomplete_selection(&mut app));

        assert_eq!(app.composer.lines(), &["read @src/main.rs ".to_string()]);
    }

    #[test]
    fn file_completion_biases_title_matches() {
        let mut app = App::new(Args {
            socket: Some("/tmp/cmux-home-test.sock".to_string()),
            workspace_cwd: Some(".".to_string()),
            config: None,
            codex_command: "codex".to_string(),
            codex_plan_command: "codex".to_string(),
            claude_command: "claude".to_string(),
            claude_plan_command: "claude --permission-mode plan".to_string(),
        });
        app.file_references = vec![
            FileReference {
                path: "references/gstack/CLAUDE.md".to_string(),
            },
            FileReference {
                path: "CLAUDE.md".to_string(),
            },
        ];
        app.composer = composer_from_lines(vec!["@CLAUDE.md".to_string()]);
        app.composer.move_cursor(CursorMove::End);

        let items = app.autocomplete_items();

        assert_eq!(
            items.first().map(|item| item.label.as_str()),
            Some("@CLAUDE.md")
        );
        assert_eq!(
            items.first().map(|item| item.detail.as_str()),
            Some("CLAUDE.md")
        );
        assert_eq!(
            items.get(1).map(|item| item.detail.as_str()),
            Some("references/gstack/CLAUDE.md")
        );
        assert!(!items
            .first()
            .map(|item| item.label_match_positions.is_empty())
            .unwrap_or(true));
    }

    #[test]
    fn middle_truncation_keeps_front_and_end() {
        let (text, positions) =
            truncate_middle_with_positions("references/qstack/CLAUDE.md.file", &[0, 19, 24], 18);

        assert!(text.starts_with("referenc"));
        assert!(text.ends_with(".md.file"));
        assert!(text.contains('…'));
        assert!(positions.contains(&0));
    }

    #[test]
    fn composer_reference_ranges_classify_inline_refs() {
        let mut app = App::new(Args {
            socket: Some("/tmp/cmux-home-test.sock".to_string()),
            workspace_cwd: Some(".".to_string()),
            config: None,
            codex_command: "codex".to_string(),
            codex_plan_command: "codex".to_string(),
            claude_command: "claude".to_string(),
            claude_plan_command: "claude --permission-mode plan".to_string(),
        });
        app.skills = vec![SkillEntry {
            name: "verify".to_string(),
            description: String::new(),
            sources: vec!["codex".to_string()],
            priority: 0,
            path: PathBuf::from("/tmp/verify/SKILL.md"),
        }];

        let ranges = composer_reference_ranges(&app, "use $verify @src/main.rs /history /verify");

        assert_eq!(
            ranges.iter().map(|range| range.kind).collect::<Vec<_>>(),
            vec![
                ComposerReferenceKind::Skill,
                ComposerReferenceKind::File,
                ComposerReferenceKind::Command,
                ComposerReferenceKind::Skill,
            ]
        );
    }

    #[test]
    fn command_suggestions_fuzzy_match_command_names() {
        let suggestions = command_suggestions_for_query("/hs");

        assert_eq!(
            suggestions.first().map(|suggestion| suggestion.command),
            Some("/history")
        );
    }
}

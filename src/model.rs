use std::collections::HashMap;
use std::time::{Instant, SystemTime};

use ratatui::style::Color;

use crate::util::contains_any;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AgentKind {
    Codex,
    Claude,
}

impl AgentKind {
    pub(crate) fn toggle(self) -> Self {
        match self {
            AgentKind::Codex => AgentKind::Claude,
            AgentKind::Claude => AgentKind::Codex,
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            AgentKind::Codex => "codex",
            AgentKind::Claude => "claude",
        }
    }

    pub(crate) fn from_label(label: &str) -> Option<Self> {
        match label {
            "codex" => Some(AgentKind::Codex),
            "claude" => Some(AgentKind::Claude),
            _ => None,
        }
    }

    pub(crate) fn color(self) -> Color {
        match self {
            AgentKind::Codex => Color::Rgb(102, 217, 239),
            AgentKind::Claude => Color::Rgb(215, 119, 87),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum AgentState {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConversationActor {
    User,
    Assistant,
}

impl ConversationActor {
    fn label(self) -> &'static str {
        match self {
            ConversationActor::User => "user",
            ConversationActor::Assistant => "assistant",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ConversationSnapshot {
    pub(crate) actor: ConversationActor,
    pub(crate) preview: String,
    pub(crate) modified_at: SystemTime,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct WorkspaceStatus {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) latest_message: String,
    pub(crate) selected: bool,
    pub(crate) pinned: bool,
    pub(crate) statuses: HashMap<String, String>,
    pub(crate) unread_notifications: usize,
    pub(crate) conversation: Option<ConversationSnapshot>,
    pub(crate) updated_at: Option<Instant>,
}

impl WorkspaceStatus {
    pub(crate) fn agent_state(&self) -> AgentState {
        if self.unread_notifications > 0 {
            return AgentState::NeedsAttention;
        }

        let mut saw_status = false;
        let mut saw_idle = false;
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
                saw_idle = true;
            }
        }

        match self.conversation.as_ref().map(|snapshot| snapshot.actor) {
            Some(ConversationActor::Assistant) => return AgentState::NeedsAttention,
            Some(ConversationActor::User) => return AgentState::Working,
            None => {}
        }

        if saw_idle {
            return AgentState::Idle;
        }

        if saw_status {
            AgentState::Unknown
        } else {
            AgentState::Empty
        }
    }

    pub(crate) fn fingerprint(&self) -> String {
        let mut statuses = self
            .statuses
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>();
        statuses.sort();
        format!(
            "{}|{}|{}|{}|{}|{}",
            self.title,
            self.latest_message,
            self.agent_state().label(),
            self.unread_notifications,
            self.conversation
                .as_ref()
                .map(|snapshot| snapshot.actor.label())
                .unwrap_or("none"),
            statuses.join("|")
        )
    }
}

pub(crate) fn display_group(state: AgentState) -> AgentState {
    match state {
        AgentState::NeedsAttention => AgentState::NeedsAttention,
        AgentState::Working => AgentState::Working,
        AgentState::Idle | AgentState::Empty | AgentState::Unknown => AgentState::Idle,
    }
}

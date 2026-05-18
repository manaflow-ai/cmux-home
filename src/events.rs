use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime};

use serde::Deserialize;
use serde_json::Value;

use crate::model::{ConversationActor, ConversationSnapshot, WorkspaceStatus};
use crate::util::{one_line_preview, shell_words};

#[derive(Debug, Default, Deserialize)]
pub(crate) struct EventFrame {
    #[serde(rename = "type")]
    pub(crate) kind: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) workspace_id: Option<String>,
    #[serde(default)]
    pub(crate) payload: Value,
}

pub(crate) fn event_name(frame: &EventFrame) -> String {
    frame.name.clone().unwrap_or_else(|| "event".to_string())
}

pub(crate) fn event_workspace_id(frame: &EventFrame) -> Option<&str> {
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

pub(crate) fn event_title(frame: &EventFrame) -> Option<String> {
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

pub(crate) fn event_description(frame: &EventFrame) -> Option<String> {
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

pub(crate) fn workspace_from_created_event(
    frame: &EventFrame,
    workspace_id: &str,
) -> WorkspaceStatus {
    let title = event_title(frame).unwrap_or_else(|| workspace_id.chars().take(8).collect());
    let optimistic_preview = event_description(frame)
        .filter(|description| !description.trim().is_empty())
        .map(|description| one_line_preview(&description, 120))
        .or_else(|| prompt_preview_from_title(&title));
    let latest_message = optimistic_preview
        .clone()
        .unwrap_or_else(|| "starting workspace".to_string());
    WorkspaceStatus {
        id: workspace_id.to_string(),
        title,
        latest_message: latest_message.clone(),
        selected: frame
            .payload
            .get("selected")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pinned: false,
        statuses: HashMap::new(),
        unread_notifications: 0,
        conversation: optimistic_preview.map(|preview| ConversationSnapshot {
            actor: ConversationActor::User,
            preview,
            modified_at: SystemTime::now(),
        }),
        updated_at: Some(Instant::now()),
    }
}

fn prompt_preview_from_title(title: &str) -> Option<String> {
    let (_, prompt) = title.split_once(':')?;
    let prompt = prompt.trim();
    (!prompt.is_empty()).then(|| one_line_preview(prompt, 120))
}

pub(crate) fn preserve_optimistic_submission(
    existing: &WorkspaceStatus,
    refreshed: &mut WorkspaceStatus,
) {
    if refreshed.conversation.is_some()
        || refreshed.unread_notifications > 0
        || has_agent_status(&refreshed.statuses)
    {
        return;
    }
    let Some(conversation) = existing.conversation.as_ref() else {
        return;
    };
    if conversation.actor != ConversationActor::User
        || conversation
            .modified_at
            .elapsed()
            .unwrap_or(Duration::from_secs(0))
            > Duration::from_secs(300)
    {
        return;
    }
    refreshed.conversation = Some(conversation.clone());
    if refreshed.latest_message.trim().is_empty()
        || refreshed.latest_message == "standing by for task"
    {
        refreshed.latest_message = existing.latest_message.clone();
    }
}

fn has_agent_status(statuses: &HashMap<String, String>) -> bool {
    statuses.keys().any(|key| {
        let key = key.to_ascii_lowercase();
        key == "codex" || key == "claude" || key == "claude_code"
    })
}

pub(crate) fn notification_is_unread(frame: &EventFrame) -> bool {
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

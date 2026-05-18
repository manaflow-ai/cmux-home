use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::util::{now_millis, shell_quote};

#[derive(Serialize)]
pub(crate) struct SubmitPayload<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) prompt: &'a str,
    pub(crate) title: &'a str,
    pub(crate) agent: &'a str,
    pub(crate) mode: &'a str,
    pub(crate) workspace_cwd: &'a str,
    pub(crate) socket: &'a str,
    pub(crate) images: &'a [String],
}

pub(crate) fn configure_workspace_hook_command(
    command: &mut Command,
    rendered: &str,
    workspace_cwd: &str,
    socket_path: &str,
    workspace_id: &str,
) {
    command
        .arg("-lc")
        .arg(rendered)
        .current_dir(workspace_cwd)
        .env("CMUX_SOCKET_PATH", socket_path)
        .env("CMUX_WORKSPACE_ID", workspace_id)
        .env_remove("CMUX_SURFACE_ID")
        .env_remove("CMUX_TAB_ID")
        .env_remove("CMUX_PANEL_ID")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
}

pub(crate) fn render_command_template(template: &str, values: &[(&str, &str)]) -> String {
    render_command_template_parts(template, values, &[])
}

pub(crate) fn render_command_template_parts(
    template: &str,
    quoted_values: &[(&str, &str)],
    raw_values: &[(&str, &str)],
) -> String {
    let mut rendered = template.to_string();
    for (key, value) in quoted_values {
        rendered = rendered.replace(&format!("{{{key}}}"), &shell_quote(value));
    }
    for (key, value) in raw_values {
        rendered = rendered.replace(&format!("{{{key}}}"), value);
    }
    rendered
}

pub(crate) fn write_submit_payload(payload: SubmitPayload<'_>) -> Result<PathBuf> {
    let safe_workspace = payload
        .workspace_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .take(48)
        .collect::<String>();
    let path = std::env::temp_dir().join(format!(
        "cmux-home-submit-{}-{}-{}.json",
        std::process::id(),
        now_millis(),
        safe_workspace
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .with_context(|| format!("create submit payload {}", path.display()))?;
    let bytes = serde_json::to_vec_pretty(&payload).context("serialize submit payload")?;
    file.write_all(&bytes)
        .with_context(|| format!("write submit payload {}", path.display()))?;
    Ok(path)
}

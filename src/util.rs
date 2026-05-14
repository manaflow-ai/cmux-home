use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub(crate) fn one_line_preview(text: &str, max_chars: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&collapsed, max_chars)
}

pub(crate) fn truncate(text: &str, max_chars: usize) -> String {
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

pub(crate) fn time_ago(instant: Instant) -> String {
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

pub(crate) fn shell_quote(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    format!("'{}'", text.replace('\'', "'\\''"))
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub(crate) fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

pub(crate) fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

pub(crate) fn shell_words(text: &str) -> Vec<String> {
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

pub(crate) fn is_complete_single_line_response(data: &[u8]) -> bool {
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
        || serde_json::from_str::<serde_json::Value>(normalized).is_ok()
}

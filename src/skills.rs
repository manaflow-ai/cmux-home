use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::util::one_line_preview;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SkillEntry {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) sources: Vec<String>,
    pub(crate) priority: usize,
    pub(crate) path: PathBuf,
}

pub(crate) fn load_skill_entries(workspace_cwd: &str) -> Vec<SkillEntry> {
    let mut by_name = HashMap::new();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let workspace = PathBuf::from(workspace_cwd);

    scan_skill_root(
        &workspace.join(".codex/skills"),
        "codex project",
        0,
        &mut by_name,
    );
    scan_skill_root(
        &workspace.join(".claude/skills"),
        "claude project",
        0,
        &mut by_name,
    );
    scan_skill_root(
        &workspace.join(".agents/skills"),
        "agents project",
        1,
        &mut by_name,
    );
    scan_skill_root(&workspace.join("skills"), "project", 1, &mut by_name);

    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|home| home.join(".codex")));
    if let Some(codex_home) = codex_home {
        scan_skill_root(&codex_home.join("skills"), "codex", 2, &mut by_name);
        scan_skill_root(
            &codex_home.join("skills/.system"),
            "codex system",
            4,
            &mut by_name,
        );
        scan_plugin_skill_roots(
            &codex_home.join("plugins/cache"),
            "codex plugin",
            5,
            &mut by_name,
        );
    }

    if let Some(home) = home.as_ref() {
        scan_skill_root(&home.join(".agents/skills"), "agents", 3, &mut by_name);
    }

    let claude_home = std::env::var_os("CLAUDE_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|home| home.join(".claude")));
    if let Some(claude_home) = claude_home {
        scan_skill_root(&claude_home.join("skills"), "claude", 2, &mut by_name);
        scan_plugin_skill_roots(
            &claude_home.join("plugins/cache"),
            "claude plugin",
            5,
            &mut by_name,
        );
        scan_plugin_skill_roots(
            &claude_home.join("plugins/marketplaces"),
            "claude marketplace",
            5,
            &mut by_name,
        );
    }

    let mut skills = by_name.into_values().collect::<Vec<SkillEntry>>();
    skills.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| a.name.cmp(&b.name))
    });
    skills
}

fn scan_plugin_skill_roots(
    root: &Path,
    source: &str,
    priority: usize,
    by_name: &mut HashMap<String, SkillEntry>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        scan_skill_root(&path.join("skills"), source, priority, by_name);
        scan_skill_root(&path, source, priority + 1, by_name);
    }
}

fn scan_skill_root(
    root: &Path,
    source: &str,
    priority: usize,
    by_name: &mut HashMap<String, SkillEntry>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_path = path.join("SKILL.md");
        if !skill_path.is_file() {
            continue;
        }
        if let Some(skill) = parse_skill_entry(&skill_path, source, priority) {
            merge_skill_entry(by_name, skill);
        }
    }
}

fn merge_skill_entry(by_name: &mut HashMap<String, SkillEntry>, skill: SkillEntry) {
    let key = skill.name.to_ascii_lowercase();
    if let Some(existing) = by_name.get_mut(&key) {
        for source in skill.sources {
            if !existing.sources.contains(&source) {
                existing.sources.push(source);
            }
        }
        if skill.priority < existing.priority
            || (existing.description.is_empty() && !skill.description.is_empty())
        {
            existing.description = skill.description;
            existing.priority = skill.priority;
            existing.path = skill.path;
        }
        return;
    }
    by_name.insert(key, skill);
}

fn parse_skill_entry(path: &PathBuf, source: &str, priority: usize) -> Option<SkillEntry> {
    let body = fs::read_to_string(path).ok()?;
    let fallback_name = path.parent()?.file_name()?.to_string_lossy().to_string();
    let mut name = String::new();
    let mut description = String::new();

    if let Some(frontmatter) = markdown_frontmatter(&body) {
        for line in frontmatter.lines() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let value = unquote_yaml_scalar(value.trim());
            match key.trim() {
                "name" if !value.is_empty() => name = value,
                "description" if !value.is_empty() => description = value,
                _ => {}
            }
        }
    }

    if name.is_empty() {
        name = fallback_name;
    }
    if description.is_empty() {
        description = markdown_first_text_line(&body).unwrap_or_default();
    }
    description = one_line_preview(&description, 120);

    Some(SkillEntry {
        name,
        description,
        sources: vec![source.to_string()],
        priority,
        path: path.clone(),
    })
}

fn markdown_frontmatter(body: &str) -> Option<&str> {
    let rest = body.strip_prefix("---\n")?;
    let (frontmatter, _) = rest.split_once("\n---")?;
    Some(frontmatter)
}

fn markdown_first_text_line(body: &str) -> Option<String> {
    body.lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && *line != "---"
                && !line.starts_with('#')
                && !line.starts_with("name:")
                && !line.starts_with("description:")
        })
        .map(str::to_string)
        .next()
}

fn unquote_yaml_scalar(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        let first = bytes[0];
        let last = bytes[value.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

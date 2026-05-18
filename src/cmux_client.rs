use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::util::is_complete_single_line_response;

pub(crate) struct CmuxClient {
    path: String,
}

impl CmuxClient {
    pub(crate) fn new(path: String) -> Self {
        Self { path }
    }

    pub(crate) fn v2(&mut self, method: &str, params: Value) -> Result<Value> {
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

    pub(crate) fn v1(&mut self, command: &str) -> Result<String> {
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

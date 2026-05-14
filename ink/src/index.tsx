import React from "react";
import { render } from "ink";
import { App } from "./App.js";

interface ParsedArgs {
  socketPath?: string;
  cwd?: string;
  showHelp: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const args: ParsedArgs = { showHelp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--socket" || arg === "-s") {
      args.socketPath = argv[i + 1];
      i += 1;
    } else if (arg === "--cwd") {
      args.cwd = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.showHelp = true;
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      "cmux-home — TUI for browsing cmux workspaces and starting agent tasks.",
      "",
      "Usage:",
      "  cmux-home [--socket <path>] [--cwd <path>]",
      "",
      "Env:",
      "  CMUX_SOCKET_PATH    override default socket (falls back to /tmp/cmux.sock).",
      "  CMUX_AGENT_TUI_CODEX_COMMAND / *_PLAN_COMMAND      override codex command.",
      "  CMUX_AGENT_TUI_CLAUDE_COMMAND / *_PLAN_COMMAND     override claude command.",
      "",
    ].join("\n"),
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.showHelp) {
  printHelp();
  process.exit(0);
}

const app = render(
  <App socketPath={args.socketPath} cwd={args.cwd} />,
  { exitOnCtrlC: false, patchConsole: false },
);

const cleanup = (): void => {
  app.unmount();
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

await app.waitUntilExit();

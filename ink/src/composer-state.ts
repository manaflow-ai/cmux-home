export interface ComposerCursor {
  readonly row: number;
  readonly col: number;
}

export interface ComposerState {
  readonly lines: ReadonlyArray<string>;
  readonly cursor: ComposerCursor;
}

export const EMPTY_COMPOSER: ComposerState = {
  lines: [""],
  cursor: { row: 0, col: 0 },
};

export function composerFromLines(lines: ReadonlyArray<string>): ComposerState {
  const normalized = lines.length === 0 ? [""] : lines.map((l) => l);
  const lastRow = normalized.length - 1;
  return {
    lines: normalized,
    cursor: { row: lastRow, col: [...(normalized[lastRow] ?? "")].length },
  };
}

export function composerText(state: ComposerState): string {
  return state.lines.join("\n");
}

export function composerHasInput(state: ComposerState): boolean {
  if (state.lines.length > 1) return true;
  return state.lines.some((l) => l.length > 0);
}

export function composerHasText(state: ComposerState): boolean {
  return state.lines.some((l) => l.trim().length > 0);
}

export function insertText(state: ComposerState, text: string): ComposerState {
  if (!text) return state;
  const segments = text.split("\n");
  let lines = state.lines.slice();
  let { row, col } = state.cursor;
  const current = lines[row] ?? "";
  const chars = [...current];
  const before = chars.slice(0, col).join("");
  const after = chars.slice(col).join("");
  if (segments.length === 1) {
    const next = before + segments[0]! + after;
    lines[row] = next;
    col = col + [...segments[0]!].length;
  } else {
    const head = before + segments[0]!;
    const tail = segments[segments.length - 1]! + after;
    const middle = segments.slice(1, -1);
    const newLines = [head, ...middle, tail];
    lines = [
      ...lines.slice(0, row),
      ...newLines,
      ...lines.slice(row + 1),
    ];
    row = row + newLines.length - 1;
    col = [...segments[segments.length - 1]!].length;
  }
  return { lines, cursor: { row, col } };
}

export function insertNewline(state: ComposerState): ComposerState {
  return insertText(state, "\n");
}

export function backspace(state: ComposerState): ComposerState {
  let lines = state.lines.slice();
  let { row, col } = state.cursor;
  if (col > 0) {
    const chars = [...(lines[row] ?? "")];
    chars.splice(col - 1, 1);
    lines[row] = chars.join("");
    col -= 1;
  } else if (row > 0) {
    const prev = lines[row - 1] ?? "";
    const curr = lines[row] ?? "";
    col = [...prev].length;
    lines[row - 1] = prev + curr;
    lines = [...lines.slice(0, row), ...lines.slice(row + 1)];
    row -= 1;
  }
  return { lines, cursor: { row, col } };
}

export function deleteForward(state: ComposerState): ComposerState {
  let lines = state.lines.slice();
  const { row, col } = state.cursor;
  const chars = [...(lines[row] ?? "")];
  if (col < chars.length) {
    chars.splice(col, 1);
    lines[row] = chars.join("");
    return { lines, cursor: { row, col } };
  }
  if (row < lines.length - 1) {
    const merged = (lines[row] ?? "") + (lines[row + 1] ?? "");
    lines[row] = merged;
    lines = [...lines.slice(0, row + 1), ...lines.slice(row + 2)];
  }
  return { lines, cursor: { row, col } };
}

export function moveLeft(state: ComposerState): ComposerState {
  let { row, col } = state.cursor;
  if (col > 0) col -= 1;
  else if (row > 0) {
    row -= 1;
    col = [...(state.lines[row] ?? "")].length;
  }
  return { ...state, cursor: { row, col } };
}

export function moveRight(state: ComposerState): ComposerState {
  let { row, col } = state.cursor;
  const lineLen = [...(state.lines[row] ?? "")].length;
  if (col < lineLen) col += 1;
  else if (row < state.lines.length - 1) {
    row += 1;
    col = 0;
  }
  return { ...state, cursor: { row, col } };
}

export function moveUp(state: ComposerState): ComposerState {
  let { row, col } = state.cursor;
  if (row === 0) {
    col = 0;
  } else {
    row -= 1;
    const lineLen = [...(state.lines[row] ?? "")].length;
    col = Math.min(col, lineLen);
  }
  return { ...state, cursor: { row, col } };
}

export function moveDown(state: ComposerState): ComposerState {
  let { row, col } = state.cursor;
  if (row === state.lines.length - 1) {
    col = [...(state.lines[row] ?? "")].length;
  } else {
    row += 1;
    const lineLen = [...(state.lines[row] ?? "")].length;
    col = Math.min(col, lineLen);
  }
  return { ...state, cursor: { row, col } };
}

export function moveHome(state: ComposerState): ComposerState {
  return { ...state, cursor: { row: state.cursor.row, col: 0 } };
}

export function moveEnd(state: ComposerState): ComposerState {
  const lineLen = [...(state.lines[state.cursor.row] ?? "")].length;
  return { ...state, cursor: { row: state.cursor.row, col: lineLen } };
}

export function killToEndOfLine(state: ComposerState): ComposerState {
  const lines = state.lines.slice();
  const chars = [...(lines[state.cursor.row] ?? "")];
  lines[state.cursor.row] = chars.slice(0, state.cursor.col).join("");
  return { ...state, lines };
}

export function killToStartOfLine(state: ComposerState): ComposerState {
  const lines = state.lines.slice();
  const chars = [...(lines[state.cursor.row] ?? "")];
  lines[state.cursor.row] = chars.slice(state.cursor.col).join("");
  return { lines, cursor: { row: state.cursor.row, col: 0 } };
}

export function killWordBackward(state: ComposerState): ComposerState {
  let { row, col } = state.cursor;
  if (col === 0) return backspace(state);
  const chars = [...(state.lines[row] ?? "")];
  // skip trailing whitespace
  let end = col;
  while (end > 0 && /\s/.test(chars[end - 1] ?? "")) end -= 1;
  let start = end;
  while (start > 0 && !/\s/.test(chars[start - 1] ?? "")) start -= 1;
  const next = chars.slice(0, start).concat(chars.slice(col)).join("");
  const lines = state.lines.slice();
  lines[row] = next;
  return { lines, cursor: { row, col: start } };
}

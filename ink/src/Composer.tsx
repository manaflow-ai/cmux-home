import React from "react";
import { Box, Text } from "ink";
import {
  COLORS,
  COMPOSER_CONTINUATION_PROMPT,
  COMPOSER_PLACEHOLDER,
  COMPOSER_PROMPT,
} from "./format.js";
import type { ComposerState } from "./composer-state.js";

export interface ComposerProps {
  readonly state: ComposerState;
  readonly active: boolean;
  readonly width: number;
  readonly maxHeight: number;
}

function visualLines(state: ComposerState, width: number): {
  rows: { rowIndex: number; chunkIndex: number; chars: string[]; isContinuation: boolean }[];
  cursorVisual: { row: number; col: number };
} {
  const rows: { rowIndex: number; chunkIndex: number; chars: string[]; isContinuation: boolean }[] = [];
  let cursorVisual = { row: 0, col: 0 };
  let visualRow = 0;
  state.lines.forEach((line, rowIndex) => {
    const promptWidth =
      rowIndex === 0 ? [...COMPOSER_PROMPT].length : [...COMPOSER_CONTINUATION_PROMPT].length;
    const textWidth = Math.max(1, width - promptWidth);
    const chars = [...line];
    const chunkCount = Math.max(1, Math.ceil(chars.length / textWidth));
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const slice = chars.slice(
        chunkIndex * textWidth,
        chunkIndex * textWidth + textWidth,
      );
      rows.push({
        rowIndex,
        chunkIndex,
        chars: slice,
        isContinuation: !(rowIndex === 0 && chunkIndex === 0),
      });
      if (
        rowIndex === state.cursor.row &&
        state.cursor.col >= chunkIndex * textWidth &&
        state.cursor.col < (chunkIndex + 1) * textWidth + (chunkIndex === chunkCount - 1 ? 1 : 0)
      ) {
        cursorVisual = {
          row: visualRow + chunkIndex,
          col: state.cursor.col - chunkIndex * textWidth,
        };
      }
    }
    visualRow += chunkCount;
  });
  return { rows, cursorVisual };
}

export function Composer({
  state,
  active,
  width,
  maxHeight,
}: ComposerProps): React.JSX.Element {
  if (!active) {
    return (
      <Box>
        <Text color={COLORS.muted}>
          {COMPOSER_PROMPT}
          {COMPOSER_PLACEHOLDER}
        </Text>
      </Box>
    );
  }
  const { rows, cursorVisual } = visualLines(state, Math.max(1, width));
  const height = Math.max(1, Math.min(maxHeight, rows.length));
  // Scroll so the cursor row is the last visible row when overflow happens.
  const visibleStart = Math.max(0, cursorVisual.row + 1 - height);
  const visible = rows.slice(visibleStart, visibleStart + height);

  return (
    <Box flexDirection="column">
      {visible.map((row, idx) => {
        const isCursorRow = idx === cursorVisual.row - visibleStart;
        const prompt = row.isContinuation ? COMPOSER_CONTINUATION_PROMPT : COMPOSER_PROMPT;
        const chars = row.chars.slice();
        const cursorColInChunk = isCursorRow ? cursorVisual.col : -1;
        const before = chars.slice(0, Math.max(0, cursorColInChunk)).join("");
        const afterStart = Math.max(0, cursorColInChunk + (cursorColInChunk < chars.length ? 1 : 0));
        const after = chars.slice(afterStart).join("");
        const atChar = cursorColInChunk >= 0 && cursorColInChunk < chars.length
          ? chars[cursorColInChunk] ?? " "
          : " ";
        return (
          <Box key={`${row.rowIndex}-${row.chunkIndex}-${idx}`}>
            <Text color={COLORS.muted}>{prompt}</Text>
            <Text color={COLORS.inputFg}>{before}</Text>
            {isCursorRow ? (
              <Text color={COLORS.inputFg} inverse>
                {atChar}
              </Text>
            ) : null}
            <Text color={COLORS.inputFg}>{after}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

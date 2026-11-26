import React, { useReducer, useRef } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { PromptBuffer } from "./buffer.ts";
import { CompletionMenu } from "./completion.ts";
import type { PromptRequest, UiStore } from "./store.ts";

interface Props {
  store: UiStore;
  request: PromptRequest;
}

/**
 * The input line: cursor rendering, history, completion menu and the
 * Ctrl+C/Ctrl+D semantics.
 *
 * Ink delivers decoded key events, so there is no escape-sequence parsing here;
 * paste arrives separately through `usePaste`.
 */
export function PromptInput({ store, request }: Props): React.JSX.Element {
  const buffer = useRef(new PromptBuffer()).current;
  const menu = useRef(new CompletionMenu(buffer, request.completer)).current;
  const historyIndex = useRef(-1);
  const draft = useRef("");
  const killRing = useRef("");
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  const insert = (text: string): void => {
    buffer.insert(text);
    menu.dismiss();
    redraw();
  };

  useInput((input, key) => {
    // Ink reports Alt+Enter as meta+return and Ctrl+J as a bare "\n": both
    // mean "new line" in a multi-line prompt.
    if ((key.return && key.meta) || input === "\n") {
      buffer.insert("\n");
      menu.dismiss();
      redraw();
      return;
    }

    // Terminals (and test harnesses) can coalesce typed text and Enter into a
    // single read. Ink then reports the whole chunk as one key, so split on
    // carriage returns instead of dropping the submit.
    if (!key.return && input.includes("\r")) {
      const head = input.split("\r")[0] ?? "";
      if (head) buffer.insert(head.replace(/[\u0000-\u001f\u007f]/g, ""));
      store.submit(buffer.value);
      return;
    }

    // Ctrl+C clears the line; on an empty line it aborts the prompt.
    if (key.ctrl && input === "c") {
      if (buffer.value.length === 0) {
        store.cancel();
        return;
      }
      buffer.set("");
      menu.dismiss();
      redraw();
      return;
    }

    if (key.ctrl && input === "d") {
      if (buffer.value.length === 0) store.cancel();
      else buffer.deleteForward();
      redraw();
      return;
    }

    if (key.return) {
      if (key.meta || key.shift) {
        buffer.insert("\n");
        redraw();
        return;
      }
      store.submit(buffer.value);
      return;
    }

    if (key.tab) {
      menu.tab(key.shift);
      redraw();
      return;
    }

    if (key.escape) {
      menu.dismiss();
      redraw();
      return;
    }

    if (key.upArrow) {
      if (menu.isOpen) menu.move(-1);
      else historyPrev();
      redraw();
      return;
    }
    if (key.downArrow) {
      if (menu.isOpen) menu.move(1);
      else historyNext();
      redraw();
      return;
    }

    if (key.leftArrow) {
      buffer.left();
      redraw();
      return;
    }
    if (key.rightArrow) {
      buffer.right();
      redraw();
      return;
    }

    if (key.backspace || key.delete) {
      if (key.delete) buffer.deleteForward();
      else buffer.backspace();
      redraw();
      return;
    }

    if (key.ctrl && input === "a") {
      buffer.start();
      redraw();
      return;
    }
    if (key.ctrl && input === "e") {
      buffer.end();
      redraw();
      return;
    }
    if (key.ctrl && input === "b") {
      buffer.left();
      redraw();
      return;
    }
    if (key.ctrl && input === "f") {
      buffer.right();
      redraw();
      return;
    }
    if (key.ctrl && input === "u") {
      killRing.current = buffer.killToStart();
      redraw();
      return;
    }
    if (key.ctrl && input === "k") {
      killRing.current = buffer.killToEnd();
      redraw();
      return;
    }
    if (key.ctrl && input === "w") {
      buffer.deleteWordBackKeepSpace();
      redraw();
      return;
    }
    if (key.ctrl && input === "y") {
      if (killRing.current) buffer.insert(killRing.current);
      redraw();
      return;
    }
    if (key.ctrl && input === "j") {
      buffer.insert("\n");
      redraw();
      return;
    }
    if (key.meta && input === "b") {
      buffer.wordLeft();
      redraw();
      return;
    }
    if (key.meta && input === "f") {
      buffer.wordRight();
      redraw();
      return;
    }

    // Ignore control chords we do not handle, so they do not insert letters.
    if (key.ctrl || key.escape) return;

    if (input) insert(input);
  });

  usePaste((text) => {
    buffer.insert(text);
    menu.dismiss();
    redraw();
  });

  const historyPrev = (): void => {
    const history = request.history;
    if (history.length === 0) return;
    if (historyIndex.current === -1) {
      draft.current = buffer.value;
      historyIndex.current = history.length - 1;
    } else if (historyIndex.current > 0) {
      historyIndex.current--;
    } else {
      return;
    }
    buffer.set(history[historyIndex.current]!);
    menu.dismiss();
  };

  const historyNext = (): void => {
    const history = request.history;
    if (historyIndex.current === -1) return;
    if (historyIndex.current < history.length - 1) {
      historyIndex.current++;
      buffer.set(history[historyIndex.current]!);
    } else {
      historyIndex.current = -1;
      buffer.set(draft.current);
    }
    menu.dismiss();
  };

  const display = request.mask ? "•".repeat([...buffer.value].length) : buffer.value;
  const cursor = request.mask
    ? [...buffer.value.slice(0, buffer.cursor)].length
    : buffer.cursor;

  const before = display.slice(0, cursor);
  const at = display.slice(cursor, cursor + 1);
  const after = display.slice(cursor + 1);
  const cursorChar = at === "" || at === "\n" ? " " : at;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={request.tone === "prompt" ? "green" : "cyan"}>
          {request.tone === "prompt" ? "› " : request.text}
        </Text>
        <Text>
          {before}
          <Text inverse>{cursorChar}</Text>
          {at === "\n" ? "\n" : ""}
          {after}
        </Text>
      </Box>

      {request.placeholder && buffer.value.length === 0 ? (
        <Box paddingLeft={2}>
          <Text dimColor>{request.placeholder}</Text>
        </Box>
      ) : null}

      {menu.isOpen ? <Menu menu={menu} /> : null}
    </Box>
  );
}

function Menu({ menu }: { menu: CompletionMenu }): React.JSX.Element {
  const maxVisible = 8;
  const start = Math.min(
    Math.max(0, menu.index - maxVisible + 1),
    Math.max(0, menu.items.length - maxVisible),
  );
  const visible = menu.items.slice(start, start + maxVisible);
  const width = Math.min(34, Math.max(...visible.map((item) => (item.label ?? item.value).length), 6));

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {visible.map((item, offset) => {
        const selected = start + offset === menu.index;
        const label = (item.label ?? item.value).padEnd(width, " ");
        return (
          <Text key={`${item.value}-${offset}`} {...(selected ? { inverse: true } : { dimColor: true })}>
            {label}
            {item.hint ? (
              <Text dimColor inverse={false}>
                {" "}
                {item.hint}
              </Text>
            ) : null}
          </Text>
        );
      })}
      {menu.items.length > maxVisible ? (
        <Text dimColor>
          {start + 1}-{start + visible.length}/{menu.items.length} · ↑↓ move · tab next · esc close
        </Text>
      ) : null}
    </Box>
  );
}
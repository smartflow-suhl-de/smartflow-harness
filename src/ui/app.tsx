import React, { useSyncExternalStore } from "react";
import { Box, Text, Static, useInput } from "ink";
import { PromptInput } from "./prompt-input.tsx";
import type { Status, TranscriptItem, UiStore } from "./store.ts";

export function App({ store }: { store: UiStore }): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getState);

  // Only active while the agent works: a prompt handles its own Ctrl+C.
  useInput(
    (_input, key) => {
      if (key.ctrl && _input === "c") store.interrupt();
    },
    { isActive: !state.prompt && state.busy },
  );

  return (
    <Box flexDirection="column">
      <Static items={state.items}>
        {(item) => <TranscriptItem key={item.id} item={item} />}
      </Static>

      {state.live ? (
        <Box paddingLeft={0}>
          <Text dimColor>  {state.live}</Text>
        </Box>
      ) : null}

      {state.prompt ? (
        <PromptInput key={state.prompt.id} store={store} request={state.prompt} />
      ) : state.busy ? (
        <Box>
          <Text dimColor>  working… ctrl+c to interrupt</Text>
        </Box>
      ) : null}

      <StatusBar status={state.status} />
    </Box>
  );
}

function TranscriptItem({ item }: { item: TranscriptItem }): React.JSX.Element {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>
            ❯{" "}
          </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1} flexDirection="column">
          <Text>{item.text}</Text>
        </Box>
      );
    case "tool":
      return (
        <Box paddingLeft={2}>
          <Text color={item.ok ? undefined : "red"} dimColor={item.ok}>
            {item.ok ? "✓" : "✗"} {item.label ?? "tool"}
            {item.text ? ` ${item.text}` : ""}
          </Text>
        </Box>
      );
    case "error":
      return (
        <Box>
          <Text color="red">error: {item.text}</Text>
        </Box>
      );
    case "notice":
      return (
        <Box>
          <Text dimColor>{item.text}</Text>
        </Box>
      );
    case "info":
      return (
        <Box marginTop={1}>
          <Text>{item.text}</Text>
        </Box>
      );
  }
}

function StatusBar({ status }: { status: Status }): React.JSX.Element {
  const parts = [
    status.provider,
    status.model,
    status.mode,
    status.connected ? null : "not connected",
    status.inputTokens > 0 || status.outputTokens > 0
      ? `↑${status.inputTokens} ↓${status.outputTokens}`
      : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <Box marginTop={1}>
      <Text dimColor>{parts.join(" · ")}</Text>
    </Box>
  );
}
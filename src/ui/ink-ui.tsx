import React from "react";
import { render } from "ink";
import { App } from "./app.tsx";
import type { Status } from "./store.ts";
import { UiStore } from "./store.ts";
import type { AskOptions, Ui } from "./ui.ts";

export interface InkUi {
  ui: Ui;
  store: UiStore;
  unmount(): Promise<void>;
}

/** Wipe the terminal so only the app is visible, not the shell history. */
export function clearScreen(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\u001b[2J\u001b[3J\u001b[H");
}

/** Start the Ink app and expose it through the plain `Ui` interface. */
export function createInkUi(status: Status): InkUi {
  const store = new UiStore(status);
  clearScreen();
  const instance = render(<App store={store} />, { exitOnCtrlC: false });

  const ui: Ui = {
    ask: (text: string, opts: AskOptions = {}) => store.ask(text, opts),
    addItem: (kind, text, opts) => store.addItem(kind, text, opts),
    setLive: (text) => store.setLive(text),
    setBusy: (busy) => store.setBusy(busy),
    updateStatus: (patch) => store.updateStatus(patch),
    clear: () => {
      store.clearItems();
      instance.clear();
    },
    onInterrupt: (handler) => store.onInterrupt(handler),
    dispose: async () => {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };

  return {
    ui,
    store,
    unmount: async () => {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}
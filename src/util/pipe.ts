interface ErrorStream {
  on(event: "error", handler: (error: NodeJS.ErrnoException) => void): unknown;
}

/**
 * `harness | head` and `grep -q` close the pipe early. That is normal for a
 * CLI, not an error: exit quietly instead of crashing with EPIPE.
 */
export function installPipeGuards(
  streams: ErrorStream[],
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  for (const stream of streams) {
    stream.on("error", (error) => {
      if (error.code === "EPIPE") {
        exit(0);
        return;
      }
      throw error;
    });
  }
}
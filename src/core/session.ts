import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Message } from "./types.ts";

export interface SessionMeta {
  id: string;
  createdAt: string;
  cwd: string;
  title?: string;
  parentId?: string;
}

interface TranscriptLine {
  ts: string;
  message: Message;
}

/**
 * A session is a transcript plus a small amount of metadata.
 *
 * Storage is append-only JSONL: crash-safe, greppable, easy to diff, and
 * trivially resumable/forkable. No database until you actually need queries.
 */
export class Session {
  readonly meta: SessionMeta;
  readonly messages: Message[] = [];
  private readonly file: string;

  constructor(meta: SessionMeta, file: string, messages: Message[] = []) {
    this.meta = meta;
    this.file = file;
    this.messages.push(...messages);
  }

  static async create(opts: { cwd: string; dir?: string; title?: string; parentId?: string }): Promise<Session> {
    const dir = opts.dir ?? join(opts.cwd, ".harness", "sessions");
    await mkdir(dir, { recursive: true });
    const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 6);
    const file = join(dir, `${id}.jsonl`);
    const meta: SessionMeta = {
      id,
      createdAt: new Date().toISOString(),
      cwd: resolve(opts.cwd),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    };
    await appendFile(file, JSON.stringify({ meta }) + "\n", "utf8");
    return new Session(meta, file);
  }

  static createEphemeral(opts: { cwd: string; title?: string; parentId?: string }): Session {
    const id = "ephemeral-" + randomUUID().slice(0, 8);
    const meta: SessionMeta = {
      id,
      createdAt: new Date().toISOString(),
      cwd: resolve(opts.cwd),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    };
    const session = new Session(meta, "");
    session.append = async (msg: Message) => {
      session.messages.push(msg);
    };
    return session;
  }

  static async load(path: string): Promise<Session> {
    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter(Boolean);
    const first = JSON.parse(lines[0]!) as { meta: SessionMeta };
    const messages: Message[] = [];
    for (const line of lines.slice(1)) {
      try {
        messages.push((JSON.parse(line) as TranscriptLine).message);
      } catch {
        // A torn last line (killed process) is expected; skip it.
      }
    }
    return new Session(first.meta, path, messages);
  }

  get path(): string {
    return this.file;
  }

  async append(message: Message): Promise<void> {
    this.messages.push(message);
    const line: TranscriptLine = { ts: new Date().toISOString(), message };
    await appendFile(this.file, JSON.stringify(line) + "\n", "utf8");
  }

  /** Replace the in-memory transcript after compaction (file keeps history). */
  replaceMessages(messages: Message[]): void {
    this.messages.length = 0;
    this.messages.push(...messages);
  }
}
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Credential store for keys collected by `/connect`.
 *
 * Kept out of harness.json on purpose: project config is committed, this file
 * is machine-local and written with mode 0600. Environment variables still win
 * over anything stored here.
 */
export interface Credentials {
  providers: Record<string, { apiKey: string; updatedAt: string }>;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HARNESS_HOME ?? join(homedir(), ".config", "harness"), "credentials.json");
}

export async function loadCredentials(env: NodeJS.ProcessEnv = process.env): Promise<Credentials> {
  try {
    const text = await readFile(credentialsPath(env), "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && "providers" in parsed) {
      const providers = (parsed as Credentials).providers;
      if (providers && typeof providers === "object") return { providers };
    }
  } catch {
    // Missing or corrupt store: start empty rather than failing to launch.
  }
  return { providers: {} };
}

export async function saveCredential(
  name: string,
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = credentialsPath(env);
  const store = await loadCredentials(env);
  store.providers[name] = { apiKey, updatedAt: new Date().toISOString() };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  // writeFile only applies mode on creation; enforce it for existing files.
  await chmod(path, 0o600).catch(() => {});
}

export async function deleteCredential(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const store = await loadCredentials(env);
  if (!store.providers[name]) return false;
  delete store.providers[name];
  const path = credentialsPath(env);
  await writeFile(path, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return true;
}
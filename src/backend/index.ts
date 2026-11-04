import type { Backend } from "./types";

export async function createBackend(): Promise<Backend> {
  if ((window as any).__TAURI_INTERNALS__) {
    const { TauriBackend } = await import("./tauri");
    return new TauriBackend();
  }
  const { HttpBackend } = await import("./http");
  return new HttpBackend();
}

export * from "./types";

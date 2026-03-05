import type { RivianStorage } from "./types.js";

const STORAGE_KEY = "rivian_sdk_tokens";

export class InMemoryStorage implements RivianStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

export { STORAGE_KEY };

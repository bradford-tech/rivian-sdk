export interface RivianTokens {
  csrfToken: string;
  appSessionToken: string;
  userSessionToken: string;
}

export interface LoginResult {
  otpRequired: boolean;
  otpToken?: string;
}

export interface RivianStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface ClientConfig {
  auth?: {
    storage?: RivianStorage;
  };
}

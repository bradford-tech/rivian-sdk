import { Authentication } from "./client/sdk.gen.js";
import { STORAGE_KEY } from "./storage.js";
import type { LoginResult, RivianStorage, RivianTokens } from "./types.js";
import type { Client } from "./client/client/index.js";

export class RivianAuth {
  private tokens: Partial<RivianTokens> = {};
  private storage: RivianStorage;

  constructor(
    private client: Client,
    storage?: RivianStorage,
  ) {
    this.storage = storage ?? {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
  }

  async restore(): Promise<void> {
    const stored = await this.storage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        this.tokens = JSON.parse(stored) as Partial<RivianTokens>;
      } catch {
        // Invalid stored data — ignore
      }
    }
  }

  async login(email: string, password: string): Promise<LoginResult> {
    // Step 1: Get CSRF token
    const csrfResult = await Authentication.createCsrfToken({
      client: this.client,
      body: {
        operationName: "CreateCSRFToken",
        variables: [],
        query:
          "mutation CreateCSRFToken { createCsrfToken { __typename csrfToken appSessionToken } }",
      },
    });

    const csrfData = csrfResult.data?.data?.createCsrfToken;
    if (!csrfData?.csrfToken || !csrfData?.appSessionToken) {
      throw new Error("Failed to obtain CSRF token");
    }

    this.tokens.csrfToken = csrfData.csrfToken;
    this.tokens.appSessionToken = csrfData.appSessionToken;

    // Step 2: Login
    const loginResult = await Authentication.login({
      client: this.client,
      body: {
        operationName: "Login",
        variables: { email, password },
        query:
          "mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { __typename ... on MobileLoginResponse { accessToken refreshToken userSessionToken } ... on MobileMFALoginResponse { otpToken } } }",
      },
      headers: {
        "a-sess": csrfData.appSessionToken,
        "csrf-token": csrfData.csrfToken,
        "apollographql-client-name": "com.rivian.android.consumer",
      },
    });

    const loginData = loginResult.data;

    // Check for MFA response
    const mfaData = loginData as
      | { data?: { login?: { otpToken?: string } } }
      | undefined;
    if (mfaData?.data?.login?.otpToken) {
      await this.persistTokens();
      return {
        otpRequired: true,
        otpToken: mfaData.data.login.otpToken,
      };
    }

    // Non-MFA: extract user session token
    const sessionData = loginData as
      | {
          data?: {
            loginWithOTP?: { userSessionToken?: string };
          };
        }
      | undefined;
    const userSessionToken = sessionData?.data?.loginWithOTP?.userSessionToken;
    if (!userSessionToken) {
      throw new Error("Login failed: no session token received");
    }

    this.tokens.userSessionToken = userSessionToken;
    await this.persistTokens();

    return { otpRequired: false };
  }

  async verifyOtp(
    email: string,
    otpCode: string,
    otpToken: string,
  ): Promise<void> {
    if (!this.tokens.csrfToken || !this.tokens.appSessionToken) {
      throw new Error("Must call login() before verifyOtp()");
    }

    const result = await Authentication.loginWithOtp({
      client: this.client,
      body: {
        operationName: "LoginWithOTP",
        variables: { email, otpCode, otpToken },
        query:
          "mutation LoginWithOTP($email: String!, $otpCode: String!, $otpToken: String!) { loginWithOTP(email: $email, otpCode: $otpCode, otpToken: $otpToken) { __typename accessToken refreshToken userSessionToken } }",
      },
      headers: {
        "a-sess": this.tokens.appSessionToken,
        "csrf-token": this.tokens.csrfToken,
        "apollographql-client-name": "com.rivian.android.consumer",
      },
    });

    const userSessionToken = result.data?.data?.loginWithOTP?.userSessionToken;
    if (!userSessionToken) {
      throw new Error("OTP verification failed: no session token received");
    }

    this.tokens.userSessionToken = userSessionToken;
    await this.persistTokens();
  }

  setTokens(tokens: RivianTokens): void {
    this.tokens = { ...tokens };
    void this.persistTokens();
  }

  getTokens(): Partial<RivianTokens> {
    return { ...this.tokens };
  }

  get isAuthenticated(): boolean {
    return Boolean(
      this.tokens.csrfToken &&
        this.tokens.appSessionToken &&
        this.tokens.userSessionToken,
    );
  }

  async logout(): Promise<void> {
    this.tokens = {};
    await this.storage.removeItem(STORAGE_KEY);
  }

  /** @internal */
  getHeaderTokens(): {
    csrfToken?: string;
    appSessionToken?: string;
    userSessionToken?: string;
  } {
    return this.tokens;
  }

  private async persistTokens(): Promise<void> {
    await this.storage.setItem(STORAGE_KEY, JSON.stringify(this.tokens));
  }
}

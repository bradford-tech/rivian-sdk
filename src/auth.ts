import type { Client } from "./client/client/index.js";
import { STORAGE_KEY } from "./storage.js";
import type { LoginResult, RivianStorage, RivianTokens } from "./types.js";

interface GraphQLResult<T> {
  data?: T;
}

interface CsrfTokenData {
  createCsrfToken?: {
    csrfToken?: string;
    appSessionToken?: string;
  };
}

interface LoginData {
  login?: { otpToken?: string };
  loginWithOTP?: { userSessionToken?: string };
}

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
    const csrfResult = await this.client.post<
      GraphQLResult<CsrfTokenData>,
      unknown,
      false
    >({
      url: "/gateway/graphql#CreateCSRFToken",
      body: {
        operationName: "CreateCSRFToken",
        variables: [],
        query:
          "mutation CreateCSRFToken { createCsrfToken { __typename csrfToken appSessionToken } }",
      },
      headers: {
        "Content-Type": "application/json",
      },
    });

    const csrfData = csrfResult.data?.data?.createCsrfToken;
    if (!csrfData?.csrfToken || !csrfData?.appSessionToken) {
      throw new Error("Failed to obtain CSRF token");
    }

    this.tokens.csrfToken = csrfData.csrfToken;
    this.tokens.appSessionToken = csrfData.appSessionToken;

    // Step 2: Login
    const loginResult = await this.client.post<
      GraphQLResult<LoginData>,
      unknown,
      false
    >({
      url: "/gateway/graphql#Login",
      body: {
        operationName: "Login",
        variables: { email, password },
        query:
          "mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { __typename ... on MobileLoginResponse { accessToken refreshToken userSessionToken } ... on MobileMFALoginResponse { otpToken } } }",
      },
      headers: {
        "Content-Type": "application/json",
        "a-sess": csrfData.appSessionToken,
        "csrf-token": csrfData.csrfToken,
        "apollographql-client-name": "com.rivian.android.consumer",
      },
    });

    const loginData = loginResult.data?.data;

    // Check for MFA response
    if (loginData?.login?.otpToken) {
      await this.persistTokens();
      return {
        otpRequired: true,
        otpToken: loginData.login.otpToken,
      };
    }

    // Non-MFA: extract user session token
    const userSessionToken = loginData?.loginWithOTP?.userSessionToken;
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

    const result = await this.client.post<
      GraphQLResult<LoginData>,
      unknown,
      false
    >({
      url: "/gateway/graphql#LoginWithOTP",
      body: {
        operationName: "LoginWithOTP",
        variables: { email, otpCode, otpToken },
        query:
          "mutation LoginWithOTP($email: String!, $otpCode: String!, $otpToken: String!) { loginWithOTP(email: $email, otpCode: $otpCode, otpToken: $otpToken) { __typename accessToken refreshToken userSessionToken } }",
      },
      headers: {
        "Content-Type": "application/json",
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

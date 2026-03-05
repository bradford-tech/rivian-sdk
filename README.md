# @bradford-tech/rivian-sdk

Unofficial TypeScript SDK for the Rivian API. Provides typed methods for vehicle info, charging, controls, trip planning, and more — with built-in authentication handling.

> **Disclaimer:** This is an unofficial, community-maintained SDK. It is not affiliated with, endorsed by, or supported by Rivian Automotive. Use at your own risk.

## Install

```sh
npm install @bradford-tech/rivian-sdk
```

Requires Node.js 20 or later.

## Quick Start

```typescript
import { createClient } from "@bradford-tech/rivian-sdk";

const rivian = await createClient();

// Authenticate
const result = await rivian.auth.login("you@example.com", "your-password");

if (result.otpRequired) {
  // MFA is enabled — verify with the code from your authenticator app
  await rivian.auth.verifyOtp("you@example.com", "123456", result.otpToken!);
}

// Now make authenticated requests
const vehicle = await rivian.vehicleInfo.getVehicle({
  body: {
    operationName: "GetVehicle",
    variables: {},
    query: "query GetVehicle { currentUser { vehicles { id name } } }",
  },
});
```

## Authentication

The SDK handles the full auth flow: CSRF token acquisition, login, and optional MFA verification. Auth headers (`a-sess`, `u-sess`, `csrf-token`) are automatically injected into all subsequent requests via a request interceptor.

### Login

```typescript
const result = await rivian.auth.login("you@example.com", "your-password");

if (result.otpRequired) {
  // Prompt user for their OTP code, then verify
  await rivian.auth.verifyOtp("you@example.com", otpCode, result.otpToken!);
}

console.log(rivian.auth.isAuthenticated); // true
```

### Manual Token Management

If you already have tokens (e.g., from a previous session or another source), you can set them directly:

```typescript
rivian.auth.setTokens({
  csrfToken: "...",
  appSessionToken: "...",
  userSessionToken: "...",
});
```

You can also read the current tokens:

```typescript
const tokens = rivian.auth.getTokens();
```

### Logout

```typescript
await rivian.auth.logout();
```

Clears tokens from memory and storage.

## Session Persistence

By default, tokens are stored in memory and lost when the process exits. To persist sessions across restarts, pass a storage implementation to `createClient()`.

The storage interface is intentionally simple — any object with `getItem`, `setItem`, and `removeItem` works. Methods can return synchronously or return a `Promise`.

### Node.js (file-based)

```typescript
import { createClient } from "@bradford-tech/rivian-sdk";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const fileStorage = {
  getItem(key: string) {
    try {
      return readFileSync(`./tokens/${key}`, "utf-8");
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string) {
    writeFileSync(`./tokens/${key}`, value);
  },
  removeItem(key: string) {
    try {
      unlinkSync(`./tokens/${key}`);
    } catch {
      // ignore
    }
  },
};

const rivian = await createClient({ auth: { storage: fileStorage } });
```

### React Native (AsyncStorage)

```typescript
import { createClient } from "@bradford-tech/rivian-sdk";
import AsyncStorage from "@react-native-async-storage/async-storage";

const rivian = await createClient({
  auth: { storage: AsyncStorage },
});
```

### Browser (localStorage)

```typescript
const rivian = await createClient({
  auth: { storage: localStorage },
});
```

## API Reference

The client exposes the following namespaces, each mapping to a group of API operations.

### `rivian.auth`

Hand-written auth layer. See [Authentication](#authentication) above.

| Method                                | Description                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `login(email, password)`              | Authenticate with email and password. Returns `{ otpRequired, otpToken? }`. |
| `verifyOtp(email, otpCode, otpToken)` | Complete MFA login with an OTP code.                                        |
| `setTokens(tokens)`                   | Set tokens manually.                                                        |
| `getTokens()`                         | Get current tokens.                                                         |
| `logout()`                            | Clear all tokens from memory and storage.                                   |
| `isAuthenticated`                     | `true` if all three session tokens are present.                             |

### `rivian.account`

| Method                         | Description                    |
| ------------------------------ | ------------------------------ |
| `getUserInfo()`                | Get user account information   |
| `currentUserForLogin()`        | Get current user configuration |
| `vehicleOrders()`              | List vehicle orders            |
| `delivery()`                   | Get delivery information       |
| `order()`                      | Get order details              |
| `searchOrders()`               | Search retail orders           |
| `user()`                       | Get user info for orders       |
| `paymentMethods()`             | Get payment methods            |
| `transactionStatus()`          | Get transaction status         |
| `financeSummary()`             | Get finance summary            |
| `getProvisionedCampSpeakers()` | List provisioned camp speakers |
| `getRegisteredWallboxes()`     | List registered wallboxes      |

### `rivian.charging`

| Method                           | Description                       |
| -------------------------------- | --------------------------------- |
| `getLiveSessionData()`           | Get live charging session data    |
| `getLiveSessionHistory()`        | Get live charging session history |
| `getCompletedSessionSummaries()` | Get completed session summaries   |
| `getNonRivianUserSession()`      | Get non-Rivian charging session   |
| `getChargingSchedule()`          | Get charging schedule             |
| `setChargingSchedule()`          | Set charging schedule             |
| `getWallboxStatus()`             | Get wallbox status                |
| `updateWallbox()`                | Update wallbox name               |
| `chargerDetails()`               | Get charger details               |
| `checkByRivianId()`              | Check linked third-party accounts |
| `getLinkedEmailForRivianId()`    | Get linked third-party email      |

### `rivian.vehicleInfo`

| Method                            | Description                      |
| --------------------------------- | -------------------------------- |
| `getVehicle()`                    | Get vehicle details              |
| `getVehicleState()`               | Get vehicle state                |
| `getVehicleLastConnection()`      | Get last cloud connection time   |
| `getOtaUpdateDetails()`           | Get OTA update details           |
| `getVehicleImages()`              | Get vehicle images               |
| `getVehicleWheelImage()`          | Get wheel image                  |
| `getEstimatedRange()`             | Get estimated range              |
| `setVehicleName()`                | Set vehicle name                 |
| `supportedFeatures()`             | Get supported features           |
| `registerPushNotificationToken()` | Register push notification token |

### `rivian.vehicleControls`

| Method                             | Description                     |
| ---------------------------------- | ------------------------------- |
| `sendVehicleCommand()`             | Send a command to the vehicle   |
| `getVehicleCommand()`              | Get command status              |
| `enrollPhone()`                    | Enroll a phone key              |
| `disenrollPhone()`                 | Disenroll a phone key           |
| `parseAndShareLocationToVehicle()` | Share a location to the vehicle |

### `rivian.tripPlanning`

| Method                 | Description                     |
| ---------------------- | ------------------------------- |
| `places()`             | Search for places               |
| `planTrip()`           | Plan a trip with charging stops |
| `saveTrip()`           | Save a trip                     |
| `getSavedTrips()`      | Get saved trips                 |
| `getTrailerProfiles()` | Get trailer towing profiles     |

### `rivian.gearShop`

| Method                       | Description                      |
| ---------------------------- | -------------------------------- |
| `searchShopProductsBySkus()` | Search gear shop products by SKU |
| `searchShopPricingBySku()`   | Get pricing for a gear shop item |

### `rivian.configurator`

| Method                   | Description                      |
| ------------------------ | -------------------------------- |
| `getConfiguratorImage()` | Get a vehicle configurator image |

## How It Works

The Rivian API is GraphQL-over-REST — each operation sends a GraphQL query as a POST body to a REST endpoint. The SDK provides typed wrappers so you don't need to construct these queries by hand.

The generated code lives in `src/client/` and is committed to the repo. The hand-written auth layer (`src/auth.ts`) and client factory (`src/index.ts`) wrap the generated classes with a cleaner interface.

Runtime dependencies are minimal: [`ofetch`](https://github.com/unjs/ofetch) for HTTP and [`zod`](https://zod.dev) for response validation.

## Types

All request and response types are re-exported from the package:

```typescript
import type {
  GetVehicleStateData,
  RivianTokens,
  LoginResult,
} from "@bradford-tech/rivian-sdk";
```

## Contributing

```sh
git clone https://github.com/bradford-tech/rivian-sdk.git
cd rivian-sdk
npm install

# Regenerate SDK from OpenAPI spec
npm run generate

# Type-check, lint, format
npm run check

# Build
npm run build
```

## License

MIT

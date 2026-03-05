import { client } from "./client/client.gen.js";
import {
  Account,
  Charging,
  Configurator,
  GearShop,
  TripPlanning,
  VehicleControls,
  VehicleInfo,
} from "./client/sdk.gen.js";
import { RivianAuth } from "./auth.js";
import { InMemoryStorage } from "./storage.js";
import type { ClientConfig } from "./types.js";

export interface RivianClient {
  readonly auth: RivianAuth;
  readonly account: typeof Account;
  readonly charging: typeof Charging;
  readonly configurator: typeof Configurator;
  readonly gearShop: typeof GearShop;
  readonly tripPlanning: typeof TripPlanning;
  readonly vehicleControls: typeof VehicleControls;
  readonly vehicleInfo: typeof VehicleInfo;
}

export async function createClient(config?: ClientConfig): Promise<RivianClient> {
  const storage = config?.auth?.storage ?? new InMemoryStorage();

  const auth = new RivianAuth(client, storage);
  await auth.restore();

  client.interceptors.request.use((request) => {
    const tokens = auth.getHeaderTokens();
    if (tokens.appSessionToken) {
      request.headers.set("a-sess", tokens.appSessionToken);
    }
    if (tokens.userSessionToken) {
      request.headers.set("u-sess", tokens.userSessionToken);
    }
    if (tokens.csrfToken) {
      request.headers.set("csrf-token", tokens.csrfToken);
    }
    return request;
  });

  return {
    auth,
    account: Account,
    charging: Charging,
    configurator: Configurator,
    gearShop: GearShop,
    tripPlanning: TripPlanning,
    vehicleControls: VehicleControls,
    vehicleInfo: VehicleInfo,
  };
}

export type { ClientConfig, LoginResult, RivianStorage, RivianTokens } from "./types.js";
export type * from "./client/types.gen.js";

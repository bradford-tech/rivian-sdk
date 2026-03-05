import { client } from "./client/client.gen.js";
import type { Config } from "./client/client/index.js";
import {
  Account,
  Authentication,
  Charging,
  Configurator,
  GearShop,
  TripPlanning,
  VehicleControls,
  VehicleInfo,
} from "./client/sdk.gen.js";
import type { ClientOptions } from "./client/types.gen.js";

export class RivianClient {
  constructor(config: Config<ClientOptions>) {
    client.setConfig(config);
  }

  get authentication() {
    return Authentication;
  }
  get account() {
    return Account;
  }
  get charging() {
    return Charging;
  }
  get vehicleControls() {
    return VehicleControls;
  }
  get vehicleInfo() {
    return VehicleInfo;
  }
  get tripPlanning() {
    return TripPlanning;
  }
  get gearShop() {
    return GearShop;
  }
  get configurator() {
    return Configurator;
  }
}

export type * from "./client/types.gen.js";

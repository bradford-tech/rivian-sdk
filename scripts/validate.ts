import { readFileSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import {
  createClient,
  type RivianClient,
  type RivianStorage,
} from "../src/index.js";

// ── File Storage ──────────────────────────────────────────────────────

const TOKEN_FILE = ".rivian-tokens.json";

class FileStorage implements RivianStorage {
  getItem(key: string): string | null {
    try {
      const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as Record<
        string,
        string
      >;
      return data[key] ?? null;
    } catch {
      return null;
    }
  }

  setItem(key: string, value: string): void {
    let data: Record<string, string> = {};
    try {
      data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as Record<
        string,
        string
      >;
    } catch {
      // file doesn't exist yet
    }
    data[key] = value;
    writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2) + "\n");
  }

  removeItem(key: string): void {
    try {
      const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as Record<
        string,
        string
      >;
      delete data[key];
      writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2) + "\n");
    } catch {
      // nothing to remove
    }
  }
}

// ── Types ──────────────────────────────────────────────────────────────

type Outcome =
  | "PASS"
  | "SCHEMA_MISMATCH"
  | "API_ERROR"
  | "SDK_ERROR"
  | "SKIPPED";

interface EndpointResult {
  namespace: string;
  name: string;
  outcome: Outcome;
  detail?: string;
  response?: unknown;
}

interface ValidationContext {
  vehicleId?: string;
  orderId?: string;
  wallboxId?: string;
}

interface EndpointDef {
  namespace: string;
  name: string;
  conditional?: keyof ValidationContext;
  call: (client: RivianClient, ctx: ValidationContext) => Promise<unknown>;
}

// ── Auth ───────────────────────────────────────────────────────────────

async function authenticate(): Promise<RivianClient> {
  const email = process.env.RIVIAN_EMAIL;
  const password = process.env.RIVIAN_PASSWORD;
  if (!email || !password) {
    console.error("Missing RIVIAN_EMAIL or RIVIAN_PASSWORD in environment");
    process.exit(1);
  }

  const storage = new FileStorage();
  const rivian = await createClient({ auth: { storage } });

  // If tokens were restored from file, skip login
  if (rivian.auth.isAuthenticated) {
    console.log("Using cached tokens from", TOKEN_FILE, "\n");
    return rivian;
  }

  const loginResult = await rivian.auth.login(email, password);

  if (loginResult.otpRequired) {
    if (!loginResult.otpToken) {
      console.error("OTP required but no otpToken received from login");
      process.exit(1);
    }
    const rl = readline.createInterface({ input, output });
    const otpCode = await rl.question("Enter OTP code: ");
    rl.close();
    await rivian.auth.verifyOtp(email, otpCode, loginResult.otpToken);
  }

  console.log(
    "Authenticated successfully (tokens cached to",
    TOKEN_FILE,
    ")\n",
  );
  return rivian;
}

// ── Runner ─────────────────────────────────────────────────────────────

async function runEndpoint(
  def: EndpointDef,
  client: RivianClient,
  ctx: ValidationContext,
): Promise<EndpointResult> {
  if (def.conditional) {
    const needed = def.conditional;
    if (!ctx[needed]) {
      return {
        namespace: def.namespace,
        name: def.name,
        outcome: "SKIPPED",
        detail: `needs ${needed}`,
      };
    }
  }

  try {
    const response = await def.call(client, ctx);
    return {
      namespace: def.namespace,
      name: def.name,
      outcome: "PASS",
      response,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (error && typeof error === "object" && "issues" in error) {
      const issues = (
        error as {
          issues: Array<{ path: (string | number)[]; message: string }>;
        }
      ).issues;
      const details = issues
        .map((i) => `  → ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      return {
        namespace: def.namespace,
        name: def.name,
        outcome: "SCHEMA_MISMATCH",
        detail: details,
      };
    }

    if (
      message.includes("graphql") ||
      message.includes("GraphQL") ||
      message.includes("Not authorized")
    ) {
      return {
        namespace: def.namespace,
        name: def.name,
        outcome: "API_ERROR",
        detail: message,
      };
    }

    return {
      namespace: def.namespace,
      name: def.name,
      outcome: "SDK_ERROR",
      detail: message,
    };
  }
}

// ── Report ─────────────────────────────────────────────────────────────

function printReport(results: EndpointResult[]): void {
  const icons: Record<Outcome, string> = {
    PASS: "✓",
    SCHEMA_MISMATCH: "✗",
    API_ERROR: "⚠",
    SDK_ERROR: "✗",
    SKIPPED: "⊘",
  };

  console.log("\nRivian SDK Validation Report");
  console.log("============================\n");

  let currentNamespace = "";
  for (const r of results) {
    if (r.namespace !== currentNamespace) {
      currentNamespace = r.namespace;
      console.log(`${currentNamespace}`);
    }
    const icon = icons[r.outcome];
    const pad = 35 - r.name.length;
    console.log(
      `  ${icon} ${r.name}${" ".repeat(Math.max(1, pad))}${r.outcome}`,
    );
    if (r.detail) {
      for (const line of r.detail.split("\n")) {
        console.log(`    ${line}`);
      }
    }
  }

  const counts: Record<Outcome, number> = {
    PASS: 0,
    SCHEMA_MISMATCH: 0,
    API_ERROR: 0,
    SDK_ERROR: 0,
    SKIPPED: 0,
  };
  for (const r of results) counts[r.outcome]++;

  console.log(
    `\nSummary: ${counts.PASS} PASS | ${counts.SCHEMA_MISMATCH} SCHEMA_MISMATCH | ${counts.API_ERROR} API_ERROR | ${counts.SDK_ERROR} SDK_ERROR | ${counts.SKIPPED} SKIPPED`,
  );
}

// ── Snapshots ──────────────────────────────────────────────────────────

async function saveSnapshots(results: EndpointResult[]): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir("snapshots", { recursive: true });

  for (const r of results) {
    if (r.response === undefined) continue;
    const filename = `snapshots/${r.namespace}.${r.name}.json`;
    const snapshot = {
      timestamp: new Date().toISOString(),
      outcome: r.outcome,
      response: r.response,
    };
    await writeFile(filename, JSON.stringify(snapshot, null, 2) + "\n");
  }

  console.log(`\nSnapshots saved to snapshots/`);
}

// ── Endpoint Registry ──────────────────────────────────────────────────

const endpoints: EndpointDef[] = [
  // ── Account ────────────────────────────────────────────────────────
  {
    namespace: "Account",
    name: "getUserInfo",
    call: (c) =>
      c.account.getUserInfo({
        body: {
          operationName: "getUserInfo",
          query:
            "query getUserInfo { currentUser { __typename id firstName lastName email address { __typename id types line1 line2 city state postalCode country } vehicles { __typename id name owner roles vin vas { vasVehicleId vehiclePublicKey } vehicle { __typename model modelYear } settings { name { value } } } enrolledPhones { vas { vasPhoneId publicKey } enrolled { deviceType deviceName vehicleId identityId shortName } } pendingInvites { id invitedByFirstName role status vehicleId vehicleModel email } } }",
        },
      }),
  },
  {
    namespace: "Account",
    name: "currentUserForLogin",
    call: (c) =>
      c.account.currentUserForLogin({
        body: {
          operationName: "CurrentUserForLogin",
          query:
            "query CurrentUserForLogin { currentUser { __typename id firstName lastName email address { __typename id types line1 line2 city state postalCode country } vehicles { __typename id name owner roles vin vas { vasVehicleId vehiclePublicKey } vehicle { __typename model modelYear mobileConfiguration { __typename trimOption { __typename optionId optionName } exteriorColorOption { __typename optionId optionName } interiorColorOption { __typename optionId optionName } driveSystemOption { __typename optionId optionName } tonneauOption { __typename optionId optionName } wheelOption { __typename optionId optionName } driveSystemDriveModes driveSystemTowingDriveModes maxVehiclePower chargePort } deviceSlots { phone { max free } } cccCapable cccReady cccEnabled legacyEnabled otaEarlyAccessStatus } settings { name { value } } } enrolledPhones { vas { vasPhoneId publicKey } enrolled { deviceType deviceName vehicleId identityId shortName } } pendingInvites { id invitedByFirstName role status vehicleId vehicleModel email } } }",
        },
      }),
  },
  {
    namespace: "Account",
    name: "vehicleOrders",
    call: (c) =>
      c.account.vehicleOrders({
        body: {
          operationName: "vehicleOrders",
          query:
            "query vehicleOrders { orders { data { id state configurationStatus fulfillmentSummaryStatus items { configuration { options { optionId optionName optionDetails { name attrs } groupId groupName type price { amount } } } } orderDate storeId type currency locale } } }",
        },
      }),
  },
  {
    namespace: "Account",
    name: "delivery",
    conditional: "orderId",
    call: (c, ctx) =>
      c.account.delivery({
        body: {
          operationName: "delivery",
          variables: { orderId: ctx.orderId! },
          query:
            "query delivery($orderId: String!) { delivery(orderId: $orderId) { __typename status carrier deliveryAddress { __typename addressLine1 addressLine2 city state country zipcode } appointmentDetails { __typename appointmentId startDateTime endDateTime timeZone } vehicleVIN } }",
        },
      }),
  },
  {
    namespace: "Account",
    name: "order",
    conditional: "orderId",
    call: (c, ctx) =>
      c.account.order({
        body: {
          operationName: "order",
          variables: { orderId: ctx.orderId! },
          query:
            "query order($orderId: String!) { order(orderId: $orderId) { vin state billingAddress { firstName lastName line1 line2 city state country postalCode } shippingAddress { firstName lastName line1 line2 city state country postalCode } orderCancelDate orderEmail currency locale storeId type subtotal discountTotal taxTotal feesTotal paidTotal remainingTotal outstandingBalance costAfterCredits totalPrice orderDate } }",
        },
      }),
  },
  {
    namespace: "Account",
    name: "searchOrders",
    call: (c) =>
      c.account.searchOrders({
        body: {
          operationName: "searchOrders",
          variables: {
            orderTypes: ["VEHICLE"],
            pageInfo: { from: 0, size: 10 },
          },
          query:
            "query searchOrders($orderTypes: [String], $orderStates: [String], $dateRange: DateRange, $pageInfo: PageInfoInput) { searchOrders(orderTypes: $orderTypes, orderStates: $orderStates, dateRange: $dateRange, pageInfo: $pageInfo) { total data { id type state currency locale orderDate } } }",
        },
      }),
  },
  {
    namespace: "Account",
    name: "user",
    call: (c) =>
      c.account.user({
        body: {
          operationName: "user",
          query:
            "query user { user { userId firstName lastName email address { country } vehicles { id name vin } } }",
        },
      }),
  },
  {
    namespace: "Account",
    name: "paymentMethods",
    call: (c) =>
      c.account.paymentMethods({
        body: {
          operationName: "paymentMethods",
          query:
            "query paymentMethods { paymentMethods { id type default card { last4 expiryDate brand } } }",
        },
      }),
  },
  {
    namespace: "Account",
    name: "transactionStatus",
    conditional: "orderId",
    call: (c, ctx) =>
      c.account.transactionStatus({
        body: {
          operationName: "transactionStatus",
          variables: { orderId: ctx.orderId! },
          query:
            "query transactionStatus($orderId: String!) { transactionStatus(orderId: $orderId) { titleAndReg { sourceStatus { status details } consumerStatus { displayOrder current complete locked inProgress notStarted error } } tradeIn { sourceStatus { status details } consumerStatus { displayOrder current complete locked inProgress notStarted error } } finance { sourceStatus { status details } consumerStatus { displayOrder current complete locked inProgress notStarted error } } delivery { sourceStatus { status details } consumerStatus { displayOrder current complete locked inProgress notStarted error } } insurance { sourceStatus { status details } consumerStatus { displayOrder current complete locked inProgress notStarted error } } payment { sourceStatus { status details } consumerStatus { displayOrder current complete locked inProgress notStarted error } } } }",
        },
      }),
  },
  {
    namespace: "Account",
    name: "financeSummary",
    conditional: "orderId",
    call: (c, ctx) =>
      c.account.financeSummary({
        body: {
          operationName: "financeSummary",
          variables: { orderId: ctx.orderId! },
          query:
            "query financeSummary($orderId: String!) { financeSummary(orderId: $orderId) { status } }",
        },
      }),
  },
  {
    namespace: "Account",
    name: "getProvisionedCampSpeakers",
    call: (c) =>
      c.account.getProvisionedCampSpeakers({
        body: {
          operationName: "getProvisionedCampSpeakers",
          query:
            "query getProvisionedCampSpeakers { currentUser { __typename id vehicles { __typename id vehicle { __typename model } } } }",
        },
      }),
  },
  {
    namespace: "Account",
    name: "getRegisteredWallboxes",
    call: (c) =>
      c.account.getRegisteredWallboxes({
        body: {
          operationName: "getRegisteredWallboxes",
          query:
            "query getRegisteredWallboxes { getRegisteredWallboxes { __typename wallboxId userId wifiId name linked latitude longitude chargingStatus power currentVoltage currentAmps softwareVersion model serialNumber maxPower maxVoltage maxAmps } }",
        },
      }),
  },

  // ── Charging ───────────────────────────────────────────────────────
  {
    namespace: "Charging",
    name: "getCompletedSessionSummaries",
    call: (c) =>
      c.charging.getCompletedSessionSummaries({
        body: {
          operationName: "getCompletedSessionSummaries",
          query:
            "query getCompletedSessionSummaries { getCompletedSessionSummaries { chargerType currencyCode paidTotal startInstant endInstant totalEnergyKwh rangeAddedKm city transactionId vehicleId vehicleName vendor isRoamingNetwork isPublic isHomeCharger meta { transactionIdGroupingKey dataSources } } }",
        },
      }),
  },
  {
    namespace: "Charging",
    name: "getLiveSessionData",
    conditional: "vehicleId",
    call: (c, ctx) =>
      c.charging.getLiveSessionData({
        body: {
          operationName: "getLiveSessionData",
          variables: { vehicleId: ctx.vehicleId! },
          query:
            "query getLiveSessionData($vehicleId: String!) { getLiveSessionData(vehicleId: $vehicleId) { isRivianCharger isFreeSession vehicleChargerState { timeStamp value } chargerId startTime timeElapsed timeRemaining { timeStamp value } kilometersChargedPerHour { timeStamp value } power { timeStamp value } rangeAddedThisSession { timeStamp value } totalChargedEnergy { timeStamp value } currentPrice } }",
        },
      }),
  },
  {
    namespace: "Charging",
    name: "getLiveSessionHistory",
    conditional: "vehicleId",
    call: (c, ctx) =>
      c.charging.getLiveSessionHistory({
        body: {
          operationName: "getLiveSessionHistory",
          variables: { vehicleId: ctx.vehicleId! },
          query:
            "query getLiveSessionHistory($vehicleId: String!) { getLiveSessionHistory(vehicleId: $vehicleId) { chartData { soc kw } } }",
        },
      }),
  },
  {
    namespace: "Charging",
    name: "getNonRivianUserSession",
    call: (c) =>
      c.charging.getNonRivianUserSession({
        body: {
          operationName: "getNonRivianUserSession",
          query:
            "query getNonRivianUserSession { getNonRivianUserSession { chargerId } }",
        },
      }),
  },
  {
    namespace: "Charging",
    name: "checkByRivianId",
    call: (c) =>
      c.charging.checkByRivianId({
        body: {
          operationName: "CheckByRivianId",
          query: "query CheckByRivianId { checkByRivianId }",
        },
      }),
  },
  {
    namespace: "Charging",
    name: "getLinkedEmailForRivianId",
    call: (c) =>
      c.charging.getLinkedEmailForRivianId({
        body: {
          operationName: "GetLinkedEmailForRivianId",
          query:
            "query GetLinkedEmailForRivianId { getLinkedEmailForRivianId }",
        },
      }),
  },
  {
    namespace: "Charging",
    name: "getWallboxStatus",
    conditional: "wallboxId",
    call: (c, ctx) =>
      c.charging.getWallboxStatus({
        body: {
          operationName: "getWallboxStatus",
          variables: { wallboxId: ctx.wallboxId! },
          query:
            "query getWallboxStatus($wallboxId: String!) { getWallboxStatus(wallboxId: $wallboxId) { __typename wallboxId userId wifiId name linked latitude longitude chargingStatus power currentVoltage currentAmps softwareVersion model serialNumber maxPower maxVoltage maxAmps } }",
        },
      }),
  },
  {
    namespace: "Charging",
    name: "getChargingSchedule",
    conditional: "vehicleId",
    call: (c, ctx) =>
      c.charging.getChargingSchedule({
        body: {
          operationName: "getChargingSchedule",
          variables: { vehicleId: ctx.vehicleId! },
          query:
            "query getChargingSchedule($vehicleId: String!) { getChargingSchedule(vehicleId: $vehicleId) { startTime duration location { latitude longitude } amperage enabled weekDays } }",
        },
      }),
  },

  // ── VehicleInfo ────────────────────────────────────────────────────
  {
    namespace: "VehicleInfo",
    name: "getVehicleState",
    conditional: "vehicleId",
    call: (c, ctx) =>
      c.vehicleInfo.getVehicleState({
        body: {
          operationName: "GetVehicleState",
          variables: { vehicleID: ctx.vehicleId! },
          query:
            "query GetVehicleState($vehicleID: String!) { vehicleState(id: $vehicleID) { __typename gnssLocation { latitude longitude timeStamp isAuthorized } gnssSpeed { timeStamp value } gnssAltitude { timeStamp value } doorFrontLeftLocked { timeStamp value } doorFrontLeftClosed { timeStamp value } doorFrontRightLocked { timeStamp value } doorFrontRightClosed { timeStamp value } doorRearLeftLocked { timeStamp value } doorRearLeftClosed { timeStamp value } doorRearRightLocked { timeStamp value } doorRearRightClosed { timeStamp value } windowFrontLeftClosed { timeStamp value } windowFrontRightClosed { timeStamp value } windowRearLeftClosed { timeStamp value } windowRearRightClosed { timeStamp value } closureFrunkLocked { timeStamp value } closureFrunkClosed { timeStamp value } closureLiftgateLocked { timeStamp value } closureLiftgateClosed { timeStamp value } closureTailgateLocked { timeStamp value } closureTailgateClosed { timeStamp value } batteryLevel { timeStamp value } batteryLimit { timeStamp value } chargerState { timeStamp value } chargerStatus { timeStamp value } distanceToEmpty { timeStamp value } powerState { timeStamp value } vehicleMileage { timeStamp value } otaCurrentVersion { timeStamp value } otaAvailableVersion { timeStamp value } otaStatus { timeStamp value } cabinClimateInteriorTemperature { timeStamp value } cabinPreconditioningStatus { timeStamp value } driveMode { timeStamp value } gearStatus { timeStamp value } } }",
        },
      }),
  },
  {
    namespace: "VehicleInfo",
    name: "getVehicleLastConnection",
    conditional: "vehicleId",
    call: (c, ctx) =>
      c.vehicleInfo.getVehicleLastConnection({
        body: {
          operationName: "GetVehicleLastConnection",
          variables: { vehicleID: ctx.vehicleId! },
          query:
            "query GetVehicleLastConnection($vehicleID: String!) { vehicleState(id: $vehicleID) { __typename cloudConnection { lastSync } } }",
        },
      }),
  },
  {
    namespace: "VehicleInfo",
    name: "getVehicle",
    conditional: "vehicleId",
    call: (c, ctx) =>
      c.vehicleInfo.getVehicle({
        body: {
          operationName: "getVehicle",
          variables: { getVehicleId: ctx.vehicleId! },
          query:
            "query getVehicle($getVehicleId: String) { getVehicle(id: $getVehicleId) { invitedUsers { __typename firstName lastName email roles userId } } }",
        },
      }),
  },
  {
    namespace: "VehicleInfo",
    name: "getOtaUpdateDetails",
    conditional: "vehicleId",
    call: (c, ctx) =>
      c.vehicleInfo.getOtaUpdateDetails({
        body: {
          operationName: "getOTAUpdateDetails",
          variables: { vehicleId: ctx.vehicleId! },
          query:
            "query getOTAUpdateDetails($vehicleId: String!) { getOTAUpdateDetails(vehicleId: $vehicleId) { url version locale } }",
        },
      }),
  },
  {
    namespace: "VehicleInfo",
    name: "getEstimatedRange",
    conditional: "vehicleId",
    call: (c, ctx) =>
      c.vehicleInfo.getEstimatedRange({
        body: {
          operationName: "getEstimatedRange",
          variables: { vehicleId: ctx.vehicleId!, startSoc: 80 },
          query:
            "query getEstimatedRange($vehicleId: String!, $startSoc: Float!, $driveMode: String, $trailerProfile: String) { getEstimatedRange(vehicleId: $vehicleId, startSoc: $startSoc, driveMode: $driveMode, trailerProfile: $trailerProfile) { conservativeRange { estimatedRangeMi estimatedRangeKm } } }",
        },
      }),
  },
  {
    namespace: "VehicleInfo",
    name: "supportedFeatures",
    call: (c) =>
      c.vehicleInfo.supportedFeatures({
        body: {
          operationName: "SupportedFeatures",
          query:
            "query SupportedFeatures { vehicleState { supportedFeatures { name status } } }",
        },
      }),
  },

  // ── TripPlanning ───────────────────────────────────────────────────
  {
    namespace: "TripPlanning",
    name: "getSavedTrips",
    call: (c) =>
      c.tripPlanning.getSavedTrips({
        body: {
          operationName: "getSavedTrips",
          query:
            "query getSavedTrips { getSavedTrips { id name startingSOC stops { name latitude longitude } driveMode departureTime } }",
        },
      }),
  },
  {
    namespace: "TripPlanning",
    name: "getTrailerProfiles",
    conditional: "vehicleId",
    call: (c, ctx) =>
      c.tripPlanning.getTrailerProfiles({
        body: {
          operationName: "getTrailerProfiles",
          variables: { getVehicleId: ctx.vehicleId! },
          query:
            "query getTrailerProfiles($getVehicleId: String) { getVehicle(id: $getVehicleId) { trailerProfiles { __typename rangeStatus weight onRoadEfficiency offRoadEfficiency name } } }",
        },
      }),
  },

  // ── GearShop ───────────────────────────────────────────────────────
  {
    namespace: "GearShop",
    name: "searchShopProductsBySkus",
    call: (c) =>
      c.gearShop.searchShopProductsBySkus({
        body: {
          operationName: "searchShopProductsBySkus",
          variables: {
            country: "US",
            skus: ["RAN-1001"],
            pageInfo: { from: 0, size: 5 },
          },
          query:
            "query searchShopProductsBySkus($country: String, $skus: [String!]!, $pageInfo: PageInfoInput) { searchShopProductsBySkus(country: $country, skus: $skus, pageInfo: $pageInfo) { total data { sku title description price { amount currency } images { alt url } } } }",
        },
      }),
  },
  {
    namespace: "GearShop",
    name: "searchShopPricingBySku",
    call: (c) =>
      c.gearShop.searchShopPricingBySku({
        body: {
          operationName: "searchShopPricingBySku",
          variables: {
            country: "US",
            skus: ["RAN-1001"],
            pageInfo: { from: 0, size: 5 },
          },
          query:
            "query searchShopPricingBySku($country: String, $skus: [String!]!, $pageInfo: PageInfoInput) { searchShopPricingBySku(country: $country, skus: $skus, pageInfo: $pageInfo) { total data { sku title price { amount currency } } } }",
        },
      }),
  },
];

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const rivian = await authenticate();

  // Phase 1: Resolve context (using minimal queries)
  const ctx: ValidationContext = {};
  try {
    const userInfo = await rivian.account.getUserInfo({
      body: {
        operationName: "getUserInfo",
        query: "query getUserInfo { currentUser { vehicles { id vin } } }",
      },
    });
    const vehicles = userInfo.data?.data?.currentUser?.vehicles;
    if (vehicles && vehicles.length > 0) {
      ctx.vehicleId = vehicles[0]!.id;
      console.log(`Resolved vehicleId: ${ctx.vehicleId}`);
    }
  } catch (e) {
    console.warn("Could not resolve vehicleId from getUserInfo:", e);
  }

  try {
    const orders = await rivian.account.searchOrders({
      body: {
        operationName: "searchOrders",
        variables: { orderTypes: ["VEHICLE"], pageInfo: { from: 0, size: 1 } },
        query:
          "query searchOrders($orderTypes: [String], $pageInfo: PageInfoInput) { searchOrders(orderTypes: $orderTypes, pageInfo: $pageInfo) { data { id } } }",
      },
    });
    const orderList = (
      orders.data as {
        data?: { searchOrders?: { data?: Array<{ id?: string }> } };
      }
    )?.data?.searchOrders?.data;
    if (orderList && orderList.length > 0) {
      ctx.orderId = orderList[0]!.id;
      console.log(`Resolved orderId: ${ctx.orderId}`);
    }
  } catch (e) {
    console.warn("Could not resolve orderId from searchOrders:", e);
  }

  try {
    const wallboxes = await rivian.account.getRegisteredWallboxes({
      body: {
        operationName: "getRegisteredWallboxes",
        query:
          "query getRegisteredWallboxes { getRegisteredWallboxes { wallboxId } }",
      },
    });
    const wallboxList = wallboxes.data?.data?.getRegisteredWallboxes;
    if (wallboxList && wallboxList.length > 0) {
      ctx.wallboxId = wallboxList[0]!.wallboxId;
      console.log(`Resolved wallboxId: ${ctx.wallboxId}`);
    }
  } catch (e) {
    console.warn("Could not resolve wallboxId:", e);
  }

  console.log("");

  // Phase 2: Run all endpoints
  const results: EndpointResult[] = [];
  for (const ep of endpoints) {
    const result = await runEndpoint(ep, rivian, ctx);
    results.push(result);
  }

  // Phase 3: Report & snapshots
  printReport(results);
  await saveSnapshots(results);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

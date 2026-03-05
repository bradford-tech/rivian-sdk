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
      // Capture the raw response for debugging schema mismatches
      const rawResponse =
        error && typeof error === "object" && "response" in error
          ? (error as { response: unknown }).response
          : undefined;
      return {
        namespace: def.namespace,
        name: def.name,
        outcome: "SCHEMA_MISMATCH",
        detail: details,
        response: rawResponse,
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
            "query vehicleOrders { orders { __typename data { __typename id state } } }",
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
            orderTypes: ["RETAIL"],
            orderStates: null,
            pageInfo: { from: 0, size: 5 },
            dateRange: null,
            sortFields: { orderDate: "DESC" },
          },
          query:
            "query searchOrders($input: UserOrderSearchInput!) { searchOrders(input: $input) { total data { id type orderDate state fulfillmentSummaryStatus items { id title type sku __typename } __typename } __typename } }",
        },
        headers: { "dc-cid": "m-ios-rivian" },
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
            "query user { user { email { email } phone { formatted } firstName lastName addresses { id type line1 line2 city state country postalCode } userId vehicles { id highestPriorityRole __typename } } }",
        },
        headers: { "dc-cid": "m-ios-rivian" },
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
            "query getLiveSessionData($vehicleId: ID) { getLiveSessionData(vehicleId: $vehicleId) { isRivianCharger isFreeSession vehicleChargerState { value updatedAt } chargerId startTime timeElapsed timeRemaining { value updatedAt } kilometersChargedPerHour { value updatedAt } power { value updatedAt } rangeAddedThisSession { value updatedAt } totalChargedEnergy { value updatedAt } currentPrice } }",
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
            "query getLiveSessionHistory($vehicleId: ID) { getLiveSessionHistory(vehicleId: $vehicleId) { chartData { kw time } } }",
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
          query: "query CheckByRivianId { chargepoint { checkByRivianId } }",
        },
      }),
  },
  {
    namespace: "Charging",
    name: "getLinkedEmailForRivianId",
    call: (c) =>
      c.charging.getLinkedEmailForRivianId({
        body: {
          operationName: "getLinkedEmailForRivianId",
          query:
            "query getLinkedEmailForRivianId { chargepoint { getLinkedEmailForRivianId { email } } }",
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
          operationName: "GetChargingSchedule",
          variables: { vehicleId: ctx.vehicleId! },
          query:
            "query GetChargingSchedule($vehicleId: String!) { getVehicle(id: $vehicleId) { chargingSchedules { startTime duration location { latitude longitude } amperage enabled weekDays } } }",
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
          operationName: "GetVehicle",
          variables: { getVehicleId: ctx.vehicleId! },
          query:
            "query GetVehicle($getVehicleId: String) { getVehicle(id: $getVehicleId) { __typename invitedUsers { __typename ... on ProvisionedUser { devices { __typename type mappedIdentityId id hrid deviceName isPaired isEnabled } firstName lastName email roles userId } ... on UnprovisionedUser { email inviteId status } } } }",
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
            "query getOTAUpdateDetails($vehicleId: String!) { getVehicle(id: $vehicleId) { availableOTAUpdateDetails { url version locale } currentOTAUpdateDetails { url version locale } } }",
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
          operationName: "GetEstimatedRange",
          variables: { vehicleId: ctx.vehicleId!, startSoc: 80 },
          query:
            "query GetEstimatedRange($vehicleId: String!, $startSoc: Float!, $driveMode: String, $trailerProfile: String) { getVehicle(id: $vehicleId) { __typename estimatedRange(startSoc: $startSoc driveMode: $driveMode trailerProfile: $trailerProfile) } }",
        },
        headers: { "dc-cid": "m-android" },
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
            "query SupportedFeatures { currentUser { vehicles { id vehicle { vehicleState { supportedFeatures { name status } } } } } }",
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
            "query getSavedTrips { getSavedTrips { id name startingSOC stops { name location { latitude longitude } targetArrivalSOCPercent type placeId { value dataProvider } } driveMode networkPreferences { networkId preference } trailerProfile avoidAdapterRequired createdAt updatedAt departureTime } }",
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
          operationName: "GetTrailerProfiles",
          variables: { getVehicleId: ctx.vehicleId! },
          query:
            "query GetTrailerProfiles($getVehicleId: String!) { getVehicle(id: $getVehicleId) { trailerProfiles { trailerDefault { __typename rangeStatus weight onRoadEfficiency offRoadEfficiency name } trailer1 { __typename rangeStatus weight onRoadEfficiency offRoadEfficiency name } trailer2 { __typename rangeStatus weight onRoadEfficiency offRoadEfficiency name } trailer3 { __typename rangeStatus weight onRoadEfficiency offRoadEfficiency name } } } }",
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
          operationName: "SearchShopProductsBySkus",
          variables: {
            country: "US",
            skus: ["ACERRCK001"],
            pageInfo: { from: 0, size: 5 },
          },
          query:
            'query SearchShopProductsBySkus($country: String! = "US", $skus: [String!]!, $pageInfo: ElasticSearchPageInput) { searchProducts(input: {storeType: ONLINE_STORE, country: $country, pageInfo: $pageInfo, filters: {skus: $skus}}) { total data { ... on ChildProduct { sku title price { listPrice { amount currency } } __typename } ... on StandaloneProduct { sku title price { listPrice { amount currency } } __typename } __typename } __typename } }',
        },
        headers: {
          "csrf-token": "",
          "dc-cid": "m-ios-rivian",
          "x-datadog-origin": "rum",
        },
      }),
  },
  {
    namespace: "GearShop",
    name: "searchShopPricingBySku",
    call: (c) =>
      c.gearShop.searchShopPricingBySku({
        body: {
          operationName: "SearchShopPricingBySku",
          variables: {
            country: "US",
            skus: ["ACERRCK001"],
            pageInfo: { from: 0, size: 5 },
          },
          query:
            'query SearchShopPricingBySku($country: String! = "US", $skus: [String!]!, $pageInfo: ElasticSearchPageInput) { searchProducts(input: {storeType: ONLINE_STORE, country: $country, pageInfo: $pageInfo, filters: {skus: $skus}}) { total data { ... on ChildProduct { sku price { listPrice { amount currency } } __typename } ... on StandaloneProduct { sku price { listPrice { amount currency } } __typename } __typename } __typename } }',
        },
        headers: {
          "csrf-token": "",
          "dc-cid": "m-ios-rivian",
          "x-datadog-origin": "rum",
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
        variables: {
          orderTypes: ["VEHICLE"],
          orderStates: null,
          pageInfo: { from: 0, size: 1 },
          dateRange: null,
          sortFields: { orderDate: "DESC" },
        },
        query:
          "query searchOrders($input: UserOrderSearchInput!) { searchOrders(input: $input) { data { id } } }",
      },
      headers: { "dc-cid": "m-ios-rivian" },
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

import { Command } from "commander";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";

// Import from SDK — single source of truth for program logic
import {
  ApiKeyManagerSDK,
  hashApiKey,
  findServiceConfigPDA,
  findApiKeyPDA,
  formatPermissions,
} from "./sdk";

// ============================================================================
// CLI-only Helpers (presentation / parsing — not duplicated from SDK)
// ============================================================================

function formatWindow(seconds: number): string {
  if (seconds === 60) return "per minute";
  if (seconds === 3600) return "per hour";
  if (seconds === 86400) return "per day";
  return `per ${seconds}s`;
}

function formatTimestamp(ts: number): string {
  if (ts === 0) return "Never";
  return new Date(ts * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function formatAge(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - ts);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function getConnection(cluster: string): Connection {
  const validClusters = ["localnet", "devnet", "mainnet", "testnet"];
  if (!validClusters.includes(cluster)) {
    console.error(chalk.red(`  Invalid cluster: ${cluster}. Use: ${validClusters.join(", ")}`));
    process.exit(1);
  }
  const url =
    cluster === "devnet"
      ? clusterApiUrl("devnet")
      : cluster === "mainnet"
        ? clusterApiUrl("mainnet-beta")
        : cluster === "testnet"
          ? clusterApiUrl("testnet")
          : "http://localhost:8899";
  return new Connection(url, "confirmed");
}

function loadKeypair(keypairPath?: string): Keypair {
  const p =
    keypairPath ||
    path.join(
      process.env.HOME || "",
      ".config",
      "solana",
      "id.json"
    );
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!Array.isArray(raw) || raw.length !== 64) {
      throw new Error("Keypair file must contain a JSON array of 64 bytes");
    }
    return Keypair.fromSecretKey(Buffer.from(raw));
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      console.error(chalk.red(`\n  Keypair file not found: ${p}`));
      console.error(chalk.yellow(`  Run 'solana-keygen new' or specify --keypair <path>\n`));
    } else {
      console.error(chalk.red(`\n  Failed to load keypair from ${p}: ${err.message}\n`));
    }
    process.exit(1);
  }
}

function explorerUrl(tx: string, cluster: string): string {
  if (cluster === "localnet") {
    return `https://explorer.solana.com/tx/${tx}?cluster=custom&customUrl=http://localhost:8899`;
  }
  if (cluster === "mainnet") {
    return `https://explorer.solana.com/tx/${tx}`;
  }
  return `https://explorer.solana.com/tx/${tx}?cluster=${cluster}`;
}

/** Parse permission input — accepts numeric (0-15) or named values (READ, WRITE, READ|WRITE, ALL). */
function parsePermissions(value: string): number {
  // Try numeric first
  const num = Number(value);
  if (!isNaN(num) && Number.isInteger(num) && num >= 0 && num <= 15) return num;

  // Named permissions: "READ", "READ|WRITE", "READ,WRITE,DELETE", "ALL"
  const names: Record<string, number> = {
    READ: 1, WRITE: 2, DELETE: 4, ADMIN: 8, ALL: 15,
  };
  const parts = value.toUpperCase().split(/[|,+]/);
  let mask = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    if (!(trimmed in names)) {
      console.error(
        chalk.red(
          `\n  Unknown permission: "${trimmed}". Valid: READ, WRITE, DELETE, ADMIN, ALL (or numeric 0-15)\n`
        )
      );
      process.exit(1);
    }
    mask |= names[trimmed];
  }
  return mask;
}

/** Parse integer with NaN guard, negative check, float check, and u32 overflow check. */
function parseIntSafe(value: string, fieldName: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    console.error(
      chalk.red(`\n  Invalid ${fieldName}: "${value}" must be a non-negative integer.\n`)
    );
    process.exit(1);
  }
  if (n > 4294967295) {
    console.error(
      chalk.red(`\n  Invalid ${fieldName}: "${value}" exceeds maximum (4294967295).\n`)
    );
    process.exit(1);
  }
  return n;
}

/** Create an SDK instance from CLI parent options. Exits on failure. */
function initSdk(parentOpts: { cluster: string; keypair?: string }): { sdk: ApiKeyManagerSDK; wallet: Keypair; cluster: string } {
  const connection = getConnection(parentOpts.cluster);
  const wallet = loadKeypair(parentOpts.keypair);
  try {
    const sdk = new ApiKeyManagerSDK(connection, wallet);
    return { sdk, wallet, cluster: parentOpts.cluster };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(chalk.red(`\n  Failed to initialize SDK: ${msg}`));
    console.error(chalk.yellow(`  Run 'anchor build' to generate the IDL file.\n`));
    process.exit(1);
  }
}

// ============================================================================
// CLI Setup
// ============================================================================

const program = new Command();
program.version("1.0.0").description("On-chain API Key Manager CLI — manage API keys on Solana");

program
  .option("-c, --cluster <cluster>", "Solana cluster (localnet|devnet|mainnet)", "devnet")
  .option("-k, --keypair <path>", "Path to keypair file");

// ============================================================================
// create-service
// ============================================================================
program
  .command("create-service")
  .description("Create a new API service")
  .requiredOption("-n, --name <name>", "Service name (1-32 chars)")
  .option("-m, --max-keys <number>", "Maximum API keys", "100")
  .option("-r, --rate-limit <number>", "Default rate limit per window", "1000")
  .option(
    "-w, --window <seconds>",
    "Rate limit window: 60 (minute), 3600 (hour), 86400 (day)",
    "3600"
  )
  .action(async (opts) => {
    const { sdk, cluster } = initSdk(program.opts());

    // Client-side validation with friendly error messages
    const maxKeysVal = parseIntSafe(opts.maxKeys, "max-keys");
    const rateLimitVal = parseIntSafe(opts.rateLimit, "rate-limit");
    const windowVal = parseIntSafe(opts.window, "window");
    if (![60, 3600, 86400].includes(windowVal)) {
      console.error(chalk.red("\n  Window must be 60 (minute), 3600 (hour), or 86400 (day).\n"));
      process.exit(1);
    }
    if (maxKeysVal === 0 || maxKeysVal > 10000) {
      console.error(chalk.red("\n  Max keys must be 1-10,000.\n"));
      process.exit(1);
    }
    if (rateLimitVal === 0) {
      console.error(chalk.red("\n  Rate limit must be > 0.\n"));
      process.exit(1);
    }
    if (Buffer.byteLength(opts.name, "utf-8") === 0 || Buffer.byteLength(opts.name, "utf-8") > 32) {
      console.error(chalk.red("\n  Service name must be 1-32 bytes.\n"));
      process.exit(1);
    }

    const [servicePDA] = sdk.getServiceConfigPDA();
    console.log(chalk.blue("\n  Creating service...\n"));
    console.log(`  Name:        ${opts.name}`);
    console.log(`  Max keys:    ${maxKeysVal}`);
    console.log(`  Rate limit:  ${rateLimitVal} req ${formatWindow(windowVal)}`);
    console.log(`  Service PDA: ${servicePDA.toBase58()}`);

    try {
      const { signature } = await sdk.initializeService({
        name: opts.name,
        maxKeys: maxKeysVal,
        defaultRateLimit: rateLimitVal,
        rateLimitWindow: windowVal,
      });

      console.log(chalk.green(`\n  Service created!`));
      console.log(`  Transaction: ${signature}`);
      console.log(`  Explorer:    ${explorerUrl(signature, cluster)}\n`);
    } catch (e: unknown) {
      const anchorErr = e as { error?: { errorCode?: { code: string } }; message?: string };
      const code = anchorErr.error?.errorCode?.code;
      console.log(chalk.red(`\n  Error: ${code || anchorErr.message || String(e)}\n`));
    }
  });

// ============================================================================
// update-service
// ============================================================================
program
  .command("update-service")
  .description("Update service configuration (name, max keys, rate limit, window)")
  .option("-n, --name <name>", "New service name (1-32 chars)")
  .option("-m, --max-keys <number>", "New maximum API keys")
  .option("-r, --rate-limit <number>", "New default rate limit")
  .option("-w, --window <seconds>", "New rate limit window (60, 3600, 86400)")
  .action(async (opts) => {
    const { sdk, cluster } = initSdk(program.opts());

    const maxKeys = opts.maxKeys ? parseIntSafe(opts.maxKeys, "max-keys") : null;
    const rateLimit = opts.rateLimit ? parseIntSafe(opts.rateLimit, "rate-limit") : null;
    const rateLimitWindow = opts.window ? parseIntSafe(opts.window, "window") : null;

    console.log(chalk.blue("\n  Updating service...\n"));
    if (opts.name) console.log(`  Name:       ${opts.name}`);
    if (maxKeys) console.log(`  Max keys:   ${maxKeys}`);
    if (rateLimit) console.log(`  Rate limit: ${rateLimit}`);
    if (opts.window) console.log(`  Window:     ${opts.window}s`);

    try {
      const { signature } = await sdk.updateService({
        name: opts.name || null,
        maxKeys,
        defaultRateLimit: rateLimit,
        rateLimitWindow,
      });

      console.log(chalk.green(`\n  Service updated!`));
      console.log(`  Transaction: ${signature}`);
      console.log(`  Explorer:    ${explorerUrl(signature, cluster)}\n`);
    } catch (e: unknown) {
      const anchorErr = e as { error?: { errorCode?: { code: string } }; message?: string };
      const code = anchorErr.error?.errorCode?.code;
      console.log(chalk.red(`\n  Error: ${code || anchorErr.message || String(e)}\n`));
    }
  });

// ============================================================================
// service-info
// ============================================================================
program
  .command("service-info")
  .description("Display service configuration and statistics")
  .option("--owner <pubkey>", "Service owner public key (defaults to your wallet)")
  .action(async (opts) => {
    const { sdk, wallet } = initSdk(program.opts());

    const ownerPubkey = opts.owner ? new PublicKey(opts.owner) : wallet.publicKey;

    try {
      const service = opts.owner
        ? await sdk.fetchServiceConfigForOwner(ownerPubkey)
        : await sdk.fetchServiceConfig();

      if (!service) {
        console.log(chalk.red("\n  No service found for this wallet.\n"));
        return;
      }

      const [servicePDA] = opts.owner
        ? sdk.getServiceConfigPDAForOwner(ownerPubkey)
        : sdk.getServiceConfigPDA();

      console.log(chalk.blue("\n  Service Configuration\n"));
      console.log(`  Name:              ${service.name}`);
      console.log(`  Owner:             ${service.owner.toBase58()}`);
      console.log(`  Service PDA:       ${servicePDA.toBase58()}`);
      console.log(`  Max keys:          ${service.maxKeys}`);
      console.log(`  Active keys:       ${service.activeKeys}/${service.maxKeys}`);
      console.log(`  Total created:     ${service.totalKeysCreated}`);
      console.log(`  Default rate limit: ${service.defaultRateLimit} req ${formatWindow((service.rateLimitWindow as anchor.BN).toNumber())}`);
      console.log(`  Created:           ${formatTimestamp((service.createdAt as anchor.BN).toNumber())}`);
      console.log();
    } catch (e: unknown) {
      console.log(chalk.red(`\n  Error fetching service: ${e instanceof Error ? e.message : String(e)}\n`));
    }
  });

// ============================================================================
// create-key
// ============================================================================
program
  .command("create-key")
  .description("Create a new API key")
  .option("-l, --label <label>", "Key label (1-32 chars)", "default")
  .option("-p, --permissions <mask>", "Permissions: READ, WRITE, DELETE, ADMIN, ALL (or numeric 0-15, e.g. READ|WRITE)", "READ|WRITE")
  .option("-r, --rate-limit <number>", "Custom rate limit (omit to use service default)")
  .option("-e, --expires <timestamp>", "Unix timestamp for expiry (omit for never)")
  .action(async (opts) => {
    const { sdk, cluster } = initSdk(program.opts());

    const rateLimit = opts.rateLimit ? parseIntSafe(opts.rateLimit, "rate-limit") : null;
    const expiresAt = opts.expires ? parseIntSafe(opts.expires, "expires") : null;
    const permsMask = parsePermissions(opts.permissions);

    // Client-side validation with friendly error messages
    if (Buffer.byteLength(opts.label, "utf-8") === 0 || Buffer.byteLength(opts.label, "utf-8") > 32) {
      console.error(chalk.red("\n  Label must be 1-32 bytes.\n"));
      process.exit(1);
    }
    if (expiresAt !== null && expiresAt <= Math.floor(Date.now() / 1000)) {
      console.error(chalk.red("\n  Expiry timestamp must be in the future.\n"));
      process.exit(1);
    }
    if (rateLimit !== null && rateLimit === 0) {
      console.error(chalk.red("\n  Rate limit must be > 0.\n"));
      process.exit(1);
    }

    console.log(chalk.blue("\n  Creating API key...\n"));

    try {
      const { signature, rawKey, apiKeyAddress } = await sdk.createKey({
        label: opts.label,
        permissionsMask: permsMask,
        rateLimit,
        expiresAt,
      });

      console.log(chalk.green(`  API key created!\n`));
      console.log(chalk.yellow(`  API Key:     ${rawKey}`));
      console.log(`  Label:       ${opts.label}`);
      console.log(`  Permissions: ${formatPermissions(permsMask)} (${permsMask})`);
      console.log(`  Key PDA:     ${apiKeyAddress.toBase58()}`);
      console.log(`  Transaction: ${signature}`);
      console.log(`  Explorer:    ${explorerUrl(signature, cluster)}`);
      console.log(
        chalk.red(`\n  ⚠ Save your API key now! It cannot be recovered.\n`)
      );
    } catch (e: unknown) {
      const anchorErr = e as { error?: { errorCode?: { code: string } }; message?: string };
      const code = anchorErr.error?.errorCode?.code;
      console.log(chalk.red(`\n  Error: ${code || anchorErr.message || String(e)}\n`));
    }
  });

// ============================================================================
// validate-key
// ============================================================================
program
  .command("validate-key")
  .description("Validate an API key — check status, permissions, rate limits")
  .requiredOption("--key <api-key>", "The API key to validate")
  .option("--service-owner <pubkey>", "Service owner public key (defaults to your wallet)")
  .action(async (opts) => {
    const { sdk, wallet } = initSdk(program.opts());

    try {
      let apiKeyAccount;
      let apiKeyPDA: PublicKey;

      if (opts.serviceOwner) {
        // Derive PDA for a different owner's service
        const ownerPubkey = new PublicKey(opts.serviceOwner);
        const [servicePDA] = sdk.getServiceConfigPDAForOwner(ownerPubkey);
        const kh = hashApiKey(opts.key);
        [apiKeyPDA] = findApiKeyPDA(servicePDA, kh, sdk.programId);
        apiKeyAccount = await sdk.fetchApiKeyByAddress(apiKeyPDA);
      } else {
        [apiKeyPDA] = sdk.getApiKeyPDA(opts.key);
        apiKeyAccount = await sdk.fetchApiKey(opts.key);
      }

      if (!apiKeyAccount) {
        console.log(chalk.red("\n  Key not found — invalid API key.\n"));
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const windowElapsed = now - (apiKeyAccount.windowStart as anchor.BN).toNumber();
      const windowSize = (apiKeyAccount.rateLimitWindow as anchor.BN).toNumber();
      const currentUsage =
        windowElapsed >= windowSize ? 0 : apiKeyAccount.windowUsage;
      const remaining = apiKeyAccount.rateLimit - currentUsage;

      const status = apiKeyAccount.revoked
        ? chalk.red("REVOKED")
        : chalk.green("ACTIVE");

      const expiresAt = (apiKeyAccount.expiresAt as anchor.BN).toNumber();
      const isExpired = expiresAt > 0 && now >= expiresAt;
      const expiryStr = expiresAt === 0
        ? "Never"
        : isExpired
          ? chalk.red(`EXPIRED (${formatTimestamp(expiresAt)})`)
          : formatTimestamp(expiresAt);

      console.log(chalk.blue("\n  Key Status\n"));
      console.log(`  Label:        ${apiKeyAccount.label}`);
      console.log(`  Status:       ${status}`);
      console.log(`  Permissions:  ${formatPermissions(apiKeyAccount.permissions)} (${apiKeyAccount.permissions})`);
      console.log(`  Rate Limit:   ${currentUsage}/${apiKeyAccount.rateLimit} ${formatWindow(windowSize)} (${remaining} remaining)`);
      console.log(`  Total Usage:  ${(apiKeyAccount.totalUsage as anchor.BN).toString()}`);
      console.log(`  Last Used:    ${(apiKeyAccount.lastUsedAt as anchor.BN).toNumber() === 0 ? "Never" : formatAge((apiKeyAccount.lastUsedAt as anchor.BN).toNumber())}`);
      console.log(`  Created:      ${formatTimestamp((apiKeyAccount.createdAt as anchor.BN).toNumber())}`);
      console.log(`  Expires:      ${expiryStr}`);
      console.log(`  Key PDA:      ${apiKeyPDA.toBase58()}`);
      console.log();
    } catch (e: unknown) {
      console.log(chalk.red(`\n  Error: ${e instanceof Error ? e.message : String(e)}\n`));
    }
  });

// ============================================================================
// check-permission
// ============================================================================
program
  .command("check-permission")
  .description("Check if a key has a specific permission (on-chain)")
  .requiredOption("--key <api-key>", "The API key")
  .requiredOption("--permission <mask>", "Required permission: 1=READ, 2=WRITE, 4=DELETE, 8=ADMIN")
  .option("--service-owner <pubkey>", "Service owner public key")
  .action(async (opts) => {
    const { sdk, wallet } = initSdk(program.opts());

    const reqPerm = parsePermissions(opts.permission);
    const serviceOwner = opts.serviceOwner ? new PublicKey(opts.serviceOwner) : undefined;

    try {
      await sdk.checkPermission(opts.key, reqPerm, serviceOwner);
      console.log(chalk.green(`\n  ✓ Key has ${formatPermissions(reqPerm)} permission.\n`));
    } catch (e: unknown) {
      const anchorErr = e as { error?: { errorCode?: { code: string } }; message?: string };
      const code = anchorErr.error?.errorCode?.code;
      if (code === "InsufficientPermissions") {
        console.log(chalk.red(`\n  ✗ Key does NOT have ${formatPermissions(reqPerm)} permission.\n`));
      } else if (code === "KeyRevoked") {
        console.log(chalk.red(`\n  ✗ Key is revoked.\n`));
      } else {
        console.log(chalk.red(`\n  Error: ${e instanceof Error ? e.message : String(e)}\n`));
      }
    }
  });

// ============================================================================
// record-usage
// ============================================================================
program
  .command("record-usage")
  .description("Record a usage event for an API key (service owner only)")
  .requiredOption("--key <api-key>", "The API key")
  .action(async (opts) => {
    const { sdk, cluster } = initSdk(program.opts());

    try {
      const { signature } = await sdk.recordUsage(opts.key);

      console.log(chalk.green("\n  Usage recorded!"));
      console.log(`  Transaction: ${signature}`);
      console.log(`  Explorer:    ${explorerUrl(signature, cluster)}\n`);
    } catch (e: unknown) {
      const anchorErr = e as { error?: { errorCode?: { code: string } }; message?: string };
      const code = anchorErr.error?.errorCode?.code;
      console.log(chalk.red(`\n  Error: ${code || anchorErr.message || String(e)}\n`));
    }
  });

// ============================================================================
// revoke-key
// ============================================================================
program
  .command("revoke-key")
  .description("Revoke an API key (service owner only)")
  .requiredOption("--key <api-key>", "The API key to revoke")
  .action(async (opts) => {
    const { sdk, cluster } = initSdk(program.opts());

    try {
      const { signature } = await sdk.revokeKey(opts.key);

      console.log(chalk.green("\n  Key revoked!"));
      console.log(`  Transaction: ${signature}\n`);
    } catch (e: unknown) {
      const anchorErr = e as { error?: { errorCode?: { code: string } }; message?: string };
      const code = anchorErr.error?.errorCode?.code;
      console.log(chalk.red(`\n  Error: ${code || anchorErr.message || String(e)}\n`));
    }
  });

// ============================================================================
// update-key
// ============================================================================
program
  .command("update-key")
  .description("Update an API key's permissions, rate limit, or expiry (service owner only)")
  .requiredOption("--key <api-key>", "The API key to update")
  .option("-p, --permissions <mask>", "New permission bitmask")
  .option("-r, --rate-limit <number>", "New rate limit")
  .option("-e, --expires <timestamp>", "New expiry timestamp")
  .action(async (opts) => {
    const { sdk, cluster } = initSdk(program.opts());

    const permissions = opts.permissions ? parsePermissions(opts.permissions) : null;
    const rateLimit = opts.rateLimit ? parseIntSafe(opts.rateLimit, "rate-limit") : null;
    const expiresAt = opts.expires ? parseIntSafe(opts.expires, "expires") : null;

    try {
      const { signature } = await sdk.updateKey(opts.key, {
        permissionsMask: permissions,
        rateLimit,
        expiresAt,
      });

      console.log(chalk.green("\n  Key updated!"));
      if (permissions !== null) console.log(`  Permissions: ${formatPermissions(permissions)}`);
      if (rateLimit !== null) console.log(`  Rate limit:  ${rateLimit}`);
      if (expiresAt !== null) console.log(`  Expires:     ${formatTimestamp(expiresAt)}`);
      console.log(`  Transaction: ${signature}`);
      console.log(`  Explorer:    ${explorerUrl(signature, cluster)}\n`);
    } catch (e: unknown) {
      const anchorErr = e as { error?: { errorCode?: { code: string } }; message?: string };
      const code = anchorErr.error?.errorCode?.code;
      console.log(chalk.red(`\n  Error: ${code || anchorErr.message || String(e)}\n`));
    }
  });

// ============================================================================
// rotate-key
// ============================================================================
program
  .command("rotate-key")
  .description("Atomically rotate an API key — revokes old key and creates new one in a single transaction")
  .requiredOption("--key <api-key>", "The current API key to rotate")
  .option("-l, --label <label>", "New label (defaults to existing label)")
  .action(async (opts) => {
    const { sdk, cluster } = initSdk(program.opts());

    console.log(chalk.blue("\n  Rotating API key...\n"));

    try {
      const { signature, rawKey } = await sdk.rotateKey(opts.key, {
        newLabel: opts.label,
      });

      console.log(chalk.green("  Key rotated!\n"));
      console.log(chalk.yellow(`  New API Key: ${rawKey}`));
      console.log(`  Old key:     revoked (use close-key to reclaim rent)`);
      console.log(`  Transaction: ${signature}`);
      console.log(`  Explorer:    ${explorerUrl(signature, cluster)}`);
      console.log(
        chalk.red(`\n  ⚠ Save your new API key now! It cannot be recovered.\n`)
      );
    } catch (e: unknown) {
      const anchorErr = e as { error?: { errorCode?: { code: string } }; message?: string };
      const code = anchorErr.error?.errorCode?.code;
      console.log(chalk.red(`\n  Error: ${code || anchorErr.message || String(e)}\n`));
    }
  });

// ============================================================================
// close-key
// ============================================================================
program
  .command("close-key")
  .description("Close an API key account and reclaim rent (service owner only)")
  .requiredOption("--key <api-key>", "The API key to close")
  .action(async (opts) => {
    const { sdk, cluster } = initSdk(program.opts());

    try {
      // Get account lamports before closing to show accurate reclaim amount
      const [apiKeyPDA] = sdk.getApiKeyPDA(opts.key);
      const accountInfo = await sdk.connection.getAccountInfo(apiKeyPDA);
      const rentLamports = accountInfo ? accountInfo.lamports : 0;

      const { signature } = await sdk.closeKey(opts.key);

      console.log(chalk.green("\n  Key closed! Rent reclaimed."));
      console.log(`  Reclaimed:   ~${(rentLamports / 1e9).toFixed(6)} SOL`);
      console.log(`  Transaction: ${signature}`);
      console.log(`  Explorer:    ${explorerUrl(signature, cluster)}\n`);
    } catch (e: unknown) {
      const anchorErr = e as { error?: { errorCode?: { code: string } }; message?: string };
      const code = anchorErr.error?.errorCode?.code;
      console.log(chalk.red(`\n  Error: ${code || anchorErr.message || String(e)}\n`));
    }
  });

// ============================================================================
// list-keys
// ============================================================================
program
  .command("list-keys")
  .description("List all API keys for a service")
  .option("--owner <pubkey>", "Service owner public key (defaults to your wallet)")
  .action(async (opts) => {
    const { sdk, wallet } = initSdk(program.opts());

    const ownerPubkey = opts.owner ? new PublicKey(opts.owner) : wallet.publicKey;

    try {
      const service = opts.owner
        ? await sdk.fetchServiceConfigForOwner(ownerPubkey)
        : await sdk.fetchServiceConfig();

      if (!service) {
        console.log(chalk.red("\n  No service found for this wallet.\n"));
        return;
      }

      console.log(chalk.blue(`\n  Service: ${service.name}`));
      console.log(
        `  Active keys: ${service.activeKeys}/${service.maxKeys} | Total created: ${service.totalKeysCreated}`
      );

      const [servicePDA] = opts.owner
        ? sdk.getServiceConfigPDAForOwner(ownerPubkey)
        : sdk.getServiceConfigPDA();

      const keys = await sdk.fetchAllApiKeysForService(servicePDA);

      if (keys.length === 0) {
        console.log("  No keys found.\n");
        return;
      }

      console.log(`\n  ${"Label".padEnd(20)} ${"Status".padEnd(10)} ${"Permissions".padEnd(20)} ${"Usage".padEnd(15)} ${"Last Used".padEnd(15)}`);
      console.log(`  ${"─".repeat(80)}`);

      for (const { account, publicKey } of keys) {
        const status = account.revoked
          ? chalk.red("REVOKED")
          : chalk.green("ACTIVE ");
        const lastUsed = (account.lastUsedAt as anchor.BN).toNumber();

        console.log(
          `  ${account.label.padEnd(20)} ${status}   ${formatPermissions(account.permissions).padEnd(20)} ${String(account.windowUsage).padEnd(3)}/${String(account.rateLimit).padEnd(8)} ${lastUsed === 0 ? "Never" : formatAge(lastUsed)}`
        );
      }
      console.log();
    } catch (e: unknown) {
      console.log(chalk.red(`\n  Error: ${e instanceof Error ? e.message : String(e)}\n`));
    }
  });

// ============================================================================
// export (JSON output for integration)
// ============================================================================
program
  .command("export")
  .description("Export service and key data as JSON (for dashboards, CI/CD, monitoring)")
  .option("--owner <pubkey>", "Service owner public key (defaults to your wallet)")
  .option("--pretty", "Pretty-print JSON output", false)
  .action(async (opts) => {
    const { sdk, wallet } = initSdk(program.opts());
    const parentOpts = program.opts();

    const ownerPubkey = opts.owner ? new PublicKey(opts.owner) : wallet.publicKey;

    try {
      const service = opts.owner
        ? await sdk.fetchServiceConfigForOwner(ownerPubkey)
        : await sdk.fetchServiceConfig();

      if (!service) {
        console.error(JSON.stringify({ error: "No service found for this wallet" }));
        process.exit(1);
      }

      const [servicePDA] = opts.owner
        ? sdk.getServiceConfigPDAForOwner(ownerPubkey)
        : sdk.getServiceConfigPDA();

      const keys = await sdk.fetchAllApiKeysForService(servicePDA);

      const now = Math.floor(Date.now() / 1000);

      const output = {
        service: {
          address: servicePDA.toBase58(),
          owner: service.owner.toBase58(),
          name: service.name,
          maxKeys: service.maxKeys,
          activeKeys: service.activeKeys,
          totalKeysCreated: service.totalKeysCreated,
          defaultRateLimit: service.defaultRateLimit,
          rateLimitWindow: (service.rateLimitWindow as anchor.BN).toNumber(),
          createdAt: (service.createdAt as anchor.BN).toNumber(),
        },
        keys: keys.map(({ account, publicKey }) => {
          const windowSize = (account.rateLimitWindow as anchor.BN).toNumber();
          const windowElapsed = now - (account.windowStart as anchor.BN).toNumber();
          const currentUsage = windowElapsed >= windowSize ? 0 : account.windowUsage;

          return {
            address: publicKey.toBase58(),
            label: account.label,
            permissions: account.permissions,
            permissionNames: formatPermissions(account.permissions),
            rateLimit: account.rateLimit,
            currentWindowUsage: currentUsage,
            remainingUsage: account.rateLimit - currentUsage,
            totalUsage: (account.totalUsage as anchor.BN).toNumber(),
            revoked: account.revoked,
            expiresAt: (account.expiresAt as anchor.BN).toNumber(),
            expired: (account.expiresAt as anchor.BN).toNumber() > 0 && now >= (account.expiresAt as anchor.BN).toNumber(),
            createdAt: (account.createdAt as anchor.BN).toNumber(),
            lastUsedAt: (account.lastUsedAt as anchor.BN).toNumber(),
          };
        }),
        exportedAt: now,
        cluster: parentOpts.cluster,
      };

      const indent = opts.pretty ? 2 : undefined;
      console.log(JSON.stringify(output, null, indent));
    } catch (e: unknown) {
      console.error(JSON.stringify({ error: `Failed to fetch service: ${e instanceof Error ? e.message : String(e)}` }));
      process.exit(1);
    }
  });

// ============================================================================
// Parse
// ============================================================================

program.parse(process.argv);

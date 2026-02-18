import { Command } from "commander";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  clusterApiUrl,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";

// Program ID — matches deployed program
const PROGRAM_ID = new PublicKey(
  "v73KoPncjCfhWRkf2QPag15NcFx3oMsRevYtYoGReju"
);

// ============================================================================
// Helpers
// ============================================================================

function formatPermissions(mask: number): string {
  const perms: string[] = [];
  if (mask & 1) perms.push("READ");
  if (mask & 2) perms.push("WRITE");
  if (mask & 4) perms.push("DELETE");
  if (mask & 8) perms.push("ADMIN");
  return perms.length > 0 ? perms.join("|") : "NONE";
}

function formatWindow(seconds: number): string {
  if (seconds === 60) return "per minute";
  if (seconds === 3600) return "per hour";
  if (seconds === 86400) return "per day";
  return `per ${seconds}s`;
}

function formatTimestamp(ts: number): string {
  if (ts === 0) return "Never";
  return new Date(ts * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function formatAge(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const IDL_PATH = path.join(__dirname, "../../target/idl/api_key_manager.json");

function getConnection(cluster: string): Connection {
  const url =
    cluster === "devnet"
      ? clusterApiUrl("devnet")
      : cluster === "mainnet"
        ? clusterApiUrl("mainnet-beta")
        : "http://localhost:8899";
  return new Connection(url, "confirmed");
}

function loadKeypair(keypairPath?: string): Keypair {
  const p =
    keypairPath ||
    path.join(
      process.env.HOME || "~",
      ".config",
      "solana",
      "id.json"
    );
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Keypair.fromSecretKey(Buffer.from(raw));
}

function hashApiKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

function generateApiKey(): string {
  return `sk_${randomBytes(32).toString("hex")}`;
}

function findServicePDA(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("service"), owner.toBuffer()],
    PROGRAM_ID
  );
}

function findApiKeyPDA(
  service: PublicKey,
  keyHash: Buffer
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("apikey"), service.toBuffer(), keyHash],
    PROGRAM_ID
  );
}

async function getProgram(
  connection: Connection,
  wallet: Keypair
): Promise<anchor.Program> {
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
  return new anchor.Program(idl, provider);
}

function explorerUrl(tx: string, cluster: string): string {
  return `https://explorer.solana.com/tx/${tx}?cluster=${cluster}`;
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
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const [servicePDA] = findServicePDA(wallet.publicKey);

    console.log(chalk.blue("\n  Creating service...\n"));
    console.log(`  Name:        ${opts.name}`);
    console.log(`  Max keys:    ${opts.maxKeys}`);
    console.log(`  Rate limit:  ${opts.rateLimit} req ${formatWindow(parseInt(opts.window))}`);
    console.log(`  Service PDA: ${servicePDA.toBase58()}`);

    const tx = await prog.methods
      .initializeService(
        opts.name,
        parseInt(opts.maxKeys),
        parseInt(opts.rateLimit),
        new anchor.BN(parseInt(opts.window))
      )
      .accounts({
        serviceConfig: servicePDA,
        owner: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

    console.log(chalk.green(`\n  Service created!`));
    console.log(`  Transaction: ${tx}`);
    console.log(`  Explorer:    ${explorerUrl(tx, parentOpts.cluster)}\n`);
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
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const [servicePDA] = findServicePDA(wallet.publicKey);

    const name = opts.name || null;
    const maxKeys = opts.maxKeys ? parseInt(opts.maxKeys) : null;
    const rateLimit = opts.rateLimit ? parseInt(opts.rateLimit) : null;
    const window = opts.window ? new anchor.BN(parseInt(opts.window)) : null;

    console.log(chalk.blue("\n  Updating service...\n"));
    if (name) console.log(`  Name:       ${name}`);
    if (maxKeys) console.log(`  Max keys:   ${maxKeys}`);
    if (rateLimit) console.log(`  Rate limit: ${rateLimit}`);
    if (opts.window) console.log(`  Window:     ${opts.window}s`);

    const tx = await prog.methods
      .updateService(name, maxKeys, rateLimit, window)
      .accounts({
        serviceConfig: servicePDA,
        owner: wallet.publicKey,
      })
      .signers([wallet])
      .rpc();

    console.log(chalk.green(`\n  Service updated!`));
    console.log(`  Transaction: ${tx}`);
    console.log(`  Explorer:    ${explorerUrl(tx, parentOpts.cluster)}\n`);
  });

// ============================================================================
// service-info
// ============================================================================
program
  .command("service-info")
  .description("Display service configuration and statistics")
  .option("--owner <pubkey>", "Service owner public key (defaults to your wallet)")
  .action(async (opts) => {
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const ownerPubkey = opts.owner ? new PublicKey(opts.owner) : wallet.publicKey;
    const [servicePDA] = findServicePDA(ownerPubkey);

    try {
      const service = await (prog.account as any).serviceConfig.fetch(servicePDA);

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
    } catch {
      console.log(chalk.red("\n  No service found for this wallet.\n"));
    }
  });

// ============================================================================
// create-key
// ============================================================================
program
  .command("create-key")
  .description("Create a new API key")
  .option("-l, --label <label>", "Key label (1-32 chars)", "default")
  .option("-p, --permissions <mask>", "Permission bitmask: 1=READ, 2=WRITE, 4=DELETE, 8=ADMIN", "3")
  .option("-r, --rate-limit <number>", "Custom rate limit (omit to use service default)")
  .option("-e, --expires <timestamp>", "Unix timestamp for expiry (omit for never)")
  .action(async (opts) => {
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const [servicePDA] = findServicePDA(wallet.publicKey);
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash);

    const rateLimit = opts.rateLimit ? parseInt(opts.rateLimit) : null;
    const expiresAt = opts.expires ? new anchor.BN(parseInt(opts.expires)) : null;
    const permsMask = parseInt(opts.permissions);

    console.log(chalk.blue("\n  Creating API key...\n"));

    const tx = await prog.methods
      .createKey(
        Array.from(keyHash),
        opts.label,
        permsMask,
        rateLimit,
        expiresAt
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

    console.log(chalk.green(`  API key created!\n`));
    console.log(chalk.yellow(`  API Key:     ${rawKey}`));
    console.log(`  Label:       ${opts.label}`);
    console.log(`  Permissions: ${formatPermissions(permsMask)} (${permsMask})`);
    console.log(`  Key PDA:     ${apiKeyPDA.toBase58()}`);
    console.log(`  Transaction: ${tx}`);
    console.log(`  Explorer:    ${explorerUrl(tx, parentOpts.cluster)}`);
    console.log(
      chalk.red(`\n  ⚠ Save your API key now! It cannot be recovered.\n`)
    );
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
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const ownerPubkey = opts.serviceOwner ? new PublicKey(opts.serviceOwner) : wallet.publicKey;
    const [servicePDA] = findServicePDA(ownerPubkey);
    const keyHash = hashApiKey(opts.key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash);

    try {
      const apiKeyAccount = await (prog.account as any).apiKey.fetch(apiKeyPDA);

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
    } catch (e: any) {
      if (e.message?.includes("Account does not exist")) {
        console.log(chalk.red("\n  Key not found — invalid API key.\n"));
      } else {
        console.log(chalk.red(`\n  Error: ${e.message}\n`));
      }
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
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const ownerPubkey = opts.serviceOwner ? new PublicKey(opts.serviceOwner) : wallet.publicKey;
    const [servicePDA] = findServicePDA(ownerPubkey);
    const keyHash = hashApiKey(opts.key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash);

    const reqPerm = parseInt(opts.permission);

    try {
      await prog.methods
        .checkPermission(reqPerm)
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
        })
        .rpc();

      console.log(chalk.green(`\n  ✓ Key has ${formatPermissions(reqPerm)} permission.\n`));
    } catch (e: any) {
      const code = e.error?.errorCode?.code;
      if (code === "InsufficientPermissions") {
        console.log(chalk.red(`\n  ✗ Key does NOT have ${formatPermissions(reqPerm)} permission.\n`));
      } else if (code === "KeyRevoked") {
        console.log(chalk.red(`\n  ✗ Key is revoked.\n`));
      } else {
        console.log(chalk.red(`\n  Error: ${e.message}\n`));
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
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const [servicePDA] = findServicePDA(wallet.publicKey);
    const keyHash = hashApiKey(opts.key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash);

    const tx = await prog.methods
      .recordUsage(Array.from(keyHash))
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: wallet.publicKey,
      })
      .signers([wallet])
      .rpc();

    console.log(chalk.green("\n  Usage recorded!"));
    console.log(`  Transaction: ${tx}`);
    console.log(`  Explorer:    ${explorerUrl(tx, parentOpts.cluster)}\n`);
  });

// ============================================================================
// revoke-key
// ============================================================================
program
  .command("revoke-key")
  .description("Revoke an API key (service owner only)")
  .requiredOption("--key <api-key>", "The API key to revoke")
  .action(async (opts) => {
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const [servicePDA] = findServicePDA(wallet.publicKey);
    const keyHash = hashApiKey(opts.key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash);

    const tx = await prog.methods
      .revokeKey()
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: wallet.publicKey,
      })
      .signers([wallet])
      .rpc();

    console.log(chalk.green("\n  Key revoked!"));
    console.log(`  Transaction: ${tx}\n`);
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
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const [servicePDA] = findServicePDA(wallet.publicKey);
    const keyHash = hashApiKey(opts.key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash);

    const permissions = opts.permissions ? parseInt(opts.permissions) : null;
    const rateLimit = opts.rateLimit ? parseInt(opts.rateLimit) : null;
    const expiresAt = opts.expires ? new anchor.BN(parseInt(opts.expires)) : null;

    const tx = await prog.methods
      .updateKey(permissions, rateLimit, expiresAt)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: wallet.publicKey,
      })
      .signers([wallet])
      .rpc();

    console.log(chalk.green("\n  Key updated!"));
    if (permissions !== null) console.log(`  Permissions: ${formatPermissions(permissions)}`);
    if (rateLimit !== null) console.log(`  Rate limit:  ${rateLimit}`);
    if (expiresAt !== null) console.log(`  Expires:     ${formatTimestamp(expiresAt.toNumber())}`);
    console.log(`  Transaction: ${tx}`);
    console.log(`  Explorer:    ${explorerUrl(tx, parentOpts.cluster)}\n`);
  });

// ============================================================================
// close-key
// ============================================================================
program
  .command("close-key")
  .description("Close an API key account and reclaim rent (service owner only)")
  .requiredOption("--key <api-key>", "The API key to close")
  .action(async (opts) => {
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const [servicePDA] = findServicePDA(wallet.publicKey);
    const keyHash = hashApiKey(opts.key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash);

    const balBefore = await connection.getBalance(wallet.publicKey);

    const tx = await prog.methods
      .closeKey()
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: wallet.publicKey,
      })
      .signers([wallet])
      .rpc();

    const balAfter = await connection.getBalance(wallet.publicKey);
    const reclaimed = (balAfter - balBefore) / 1e9;

    console.log(chalk.green("\n  Key closed! Rent reclaimed."));
    console.log(`  Reclaimed:   ~${reclaimed.toFixed(6)} SOL`);
    console.log(`  Transaction: ${tx}`);
    console.log(`  Explorer:    ${explorerUrl(tx, parentOpts.cluster)}\n`);
  });

// ============================================================================
// list-keys
// ============================================================================
program
  .command("list-keys")
  .description("List all API keys for a service")
  .option("--owner <pubkey>", "Service owner public key (defaults to your wallet)")
  .action(async (opts) => {
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const ownerPubkey = opts.owner ? new PublicKey(opts.owner) : wallet.publicKey;
    const [servicePDA] = findServicePDA(ownerPubkey);

    try {
      const service = await (prog.account as any).serviceConfig.fetch(servicePDA);
      console.log(chalk.blue(`\n  Service: ${service.name}`));
      console.log(
        `  Active keys: ${service.activeKeys}/${service.maxKeys} | Total created: ${service.totalKeysCreated}`
      );
    } catch {
      console.log(chalk.red("\n  No service found for this wallet.\n"));
      return;
    }

    const accounts = await (prog.account as any).apiKey.all([
      {
        memcmp: {
          offset: 8,
          bytes: servicePDA.toBase58(),
        },
      },
    ]);

    if (accounts.length === 0) {
      console.log("  No keys found.\n");
      return;
    }

    console.log(`\n  ${"Label".padEnd(20)} ${"Status".padEnd(10)} ${"Permissions".padEnd(20)} ${"Usage".padEnd(15)} ${"Last Used".padEnd(15)}`);
    console.log(`  ${"─".repeat(80)}`);

    for (const { account, publicKey } of accounts) {
      const status = account.revoked
        ? chalk.red("REVOKED")
        : chalk.green("ACTIVE ");
      const windowSize = (account.rateLimitWindow as anchor.BN).toNumber();
      const lastUsed = (account.lastUsedAt as anchor.BN).toNumber();

      console.log(
        `  ${account.label.padEnd(20)} ${status}   ${formatPermissions(account.permissions).padEnd(20)} ${String(account.windowUsage).padEnd(3)}/${String(account.rateLimit).padEnd(8)} ${lastUsed === 0 ? "Never" : formatAge(lastUsed)}`
      );
    }
    console.log();
  });

// ============================================================================
// Parse
// ============================================================================

program.parse(process.argv);

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

// Program ID — update after deployment
const PROGRAM_ID = new PublicKey(
  "v73KoPncjCfhWRkf2QPag15NcFx3oMsRevYtYoGReju"
);

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

const program = new Command();
program.version("0.1.0").description("On-chain API Key Manager CLI");

// Global options
program
  .option("-c, --cluster <cluster>", "Solana cluster", "devnet")
  .option("-k, --keypair <path>", "Path to keypair file");

// ============================================================================
// create-service
// ============================================================================
program
  .command("create-service")
  .description("Create a new API service")
  .requiredOption("-n, --name <name>", "Service name (max 32 chars)")
  .option("-m, --max-keys <number>", "Maximum API keys", "100")
  .option("-r, --rate-limit <number>", "Default rate limit per window", "1000")
  .option(
    "-w, --window <seconds>",
    "Rate limit window (60, 3600, 86400)",
    "3600"
  )
  .action(async (opts) => {
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const [servicePDA] = findServicePDA(wallet.publicKey);

    console.log(chalk.blue("Creating service..."));
    console.log(`  Name: ${opts.name}`);
    console.log(`  Max keys: ${opts.maxKeys}`);
    console.log(`  Rate limit: ${opts.rateLimit} req/${opts.window}s`);
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

    console.log(chalk.green(`\nService created!`));
    console.log(`  Transaction: ${tx}`);
    console.log(
      `  Explorer: https://explorer.solana.com/tx/${tx}?cluster=${parentOpts.cluster}`
    );
  });

// ============================================================================
// create-key
// ============================================================================
program
  .command("create-key")
  .description("Create a new API key")
  .option("-l, --label <label>", "Key label", "default")
  .option("-p, --permissions <mask>", "Permission bitmask (1=R,2=W,4=D,8=A)", "3")
  .option("-r, --rate-limit <number>", "Custom rate limit (0 = use service default)")
  .option("-e, --expires <timestamp>", "Unix timestamp for expiry (0 = never)")
  .action(async (opts) => {
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const [servicePDA] = findServicePDA(wallet.publicKey);
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash);

    console.log(chalk.blue("Creating API key..."));

    const rateLimit = opts.rateLimit ? parseInt(opts.rateLimit) : null;
    const expiresAt = opts.expires ? new anchor.BN(parseInt(opts.expires)) : null;

    const tx = await prog.methods
      .createKey(
        Array.from(keyHash),
        opts.label,
        parseInt(opts.permissions),
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

    console.log(chalk.green(`\nAPI key created!`));
    console.log(chalk.yellow(`  API Key: ${rawKey}`));
    console.log(`  Key Hash: ${keyHash.toString("hex")}`);
    console.log(`  Key PDA: ${apiKeyPDA.toBase58()}`);
    console.log(`  Label: ${opts.label}`);
    console.log(`  Permissions: ${opts.permissions}`);
    console.log(`  Transaction: ${tx}`);
    console.log(
      `  Explorer: https://explorer.solana.com/tx/${tx}?cluster=${parentOpts.cluster}`
    );
    console.log(
      chalk.red(
        `\n  IMPORTANT: Save your API key! It cannot be recovered.`
      )
    );
  });

// ============================================================================
// validate-key
// ============================================================================
program
  .command("validate-key")
  .description("Validate an API key (check if active and within rate limits)")
  .requiredOption("--key <api-key>", "The API key to validate")
  .requiredOption("--service-owner <pubkey>", "Service owner public key")
  .action(async (opts) => {
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const ownerPubkey = new PublicKey(opts.serviceOwner);
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

      console.log(chalk.blue("Key Status:"));
      console.log(`  Label: ${apiKeyAccount.label}`);
      console.log(
        `  Status: ${apiKeyAccount.revoked ? chalk.red("REVOKED") : chalk.green("ACTIVE")}`
      );
      console.log(`  Permissions: ${apiKeyAccount.permissions}`);
      console.log(
        `  Rate Limit: ${currentUsage}/${apiKeyAccount.rateLimit} (window: ${windowSize}s)`
      );
      console.log(`  Total Usage: ${(apiKeyAccount.totalUsage as anchor.BN).toString()}`);
      console.log(
        `  Expires: ${(apiKeyAccount.expiresAt as anchor.BN).toNumber() === 0 ? "Never" : new Date((apiKeyAccount.expiresAt as anchor.BN).toNumber() * 1000).toISOString()}`
      );
    } catch (e: any) {
      if (e.message?.includes("Account does not exist")) {
        console.log(chalk.red("Key not found — invalid API key"));
      } else {
        console.log(chalk.red(`Error: ${e.message}`));
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

    console.log(chalk.green("Usage recorded!"));
    console.log(`  Transaction: ${tx}`);
    console.log(
      `  Explorer: https://explorer.solana.com/tx/${tx}?cluster=${parentOpts.cluster}`
    );
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

    console.log(chalk.green("Key revoked!"));
    console.log(`  Transaction: ${tx}`);
  });

// ============================================================================
// update-key
// ============================================================================
program
  .command("update-key")
  .description("Update an API key's permissions or rate limit (service owner only)")
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

    console.log(chalk.green("Key updated!"));
    console.log(`  Transaction: ${tx}`);
    console.log(
      `  Explorer: https://explorer.solana.com/tx/${tx}?cluster=${parentOpts.cluster}`
    );
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

    const tx = await prog.methods
      .closeKey()
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: wallet.publicKey,
      })
      .signers([wallet])
      .rpc();

    console.log(chalk.green("Key closed! Rent reclaimed."));
    console.log(`  Transaction: ${tx}`);
    console.log(
      `  Explorer: https://explorer.solana.com/tx/${tx}?cluster=${parentOpts.cluster}`
    );
  });

// ============================================================================
// list-keys (off-chain read)
// ============================================================================
program
  .command("list-keys")
  .description("List all API keys for your service (by reading on-chain accounts)")
  .action(async () => {
    const parentOpts = program.opts();
    const connection = getConnection(parentOpts.cluster);
    const wallet = loadKeypair(parentOpts.keypair);
    const prog = await getProgram(connection, wallet);

    const [servicePDA] = findServicePDA(wallet.publicKey);

    try {
      const service = await (prog.account as any).serviceConfig.fetch(servicePDA);
      console.log(chalk.blue(`Service: ${service.name}`));
      console.log(
        `  Active keys: ${service.activeKeys}/${service.maxKeys}`
      );
      console.log(`  Total created: ${service.totalKeysCreated}`);
    } catch {
      console.log(chalk.red("No service found for your wallet."));
      return;
    }

    // Fetch all ApiKey accounts for this service
    const accounts = await (prog.account as any).apiKey.all([
      {
        memcmp: {
          offset: 8, // discriminator
          bytes: servicePDA.toBase58(),
        },
      },
    ]);

    if (accounts.length === 0) {
      console.log("  No keys found.");
      return;
    }

    for (const { account, publicKey } of accounts) {
      const status = account.revoked
        ? chalk.red("REVOKED")
        : chalk.green("ACTIVE");
      console.log(
        `\n  ${status} ${account.label} (${publicKey.toBase58().slice(0, 8)}...)`
      );
      console.log(`    Permissions: ${account.permissions}`);
      console.log(
        `    Usage: ${account.windowUsage}/${account.rateLimit} (window), ${(account.totalUsage as anchor.BN).toString()} (total)`
      );
    }
  });

program.parse(process.argv);

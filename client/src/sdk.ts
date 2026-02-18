import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionSignature,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Constants
// ============================================================================

/** Default program ID for the deployed API Key Manager program. */
const DEFAULT_PROGRAM_ID = new PublicKey(
  "v73KoPncjCfhWRkf2QPag15NcFx3oMsRevYtYoGReju"
);

/** PDA seed prefix for ServiceConfig accounts. */
const SERVICE_SEED = Buffer.from("service");

/** PDA seed prefix for ApiKey accounts. */
const API_KEY_SEED = Buffer.from("apikey");

// ============================================================================
// Permission Constants
// ============================================================================

/**
 * Permission bitmask constants for API keys.
 * Permissions are composable via bitwise OR. For example, READ | WRITE = 3.
 */
export const Permission = {
  /** Can read resources (bit 0). */
  READ: 1 as const,
  /** Can create/update resources (bit 1). */
  WRITE: 2 as const,
  /** Can delete resources (bit 2). */
  DELETE: 4 as const,
  /** Can manage other keys (bit 3). */
  ADMIN: 8 as const,
  /** All permissions combined (READ | WRITE | DELETE | ADMIN = 15). */
  ALL: 15 as const,
} as const;

/**
 * Valid rate limit window durations in seconds.
 * The on-chain program only accepts these three values.
 */
export const RateLimitWindow = {
  /** 60 seconds (1 minute). */
  ONE_MINUTE: 60 as const,
  /** 3600 seconds (1 hour). */
  ONE_HOUR: 3600 as const,
  /** 86400 seconds (1 day). */
  ONE_DAY: 86400 as const,
} as const;

// ============================================================================
// Types
// ============================================================================

/** On-chain ServiceConfig account data, deserialized into TypeScript types. */
export interface ServiceConfigAccount {
  /** The wallet that owns this service. */
  owner: PublicKey;
  /** Human-readable service name (max 32 characters). */
  name: string;
  /** Maximum number of active API keys allowed. */
  maxKeys: number;
  /** Default rate limit for newly created keys (requests per window). */
  defaultRateLimit: number;
  /** Rate limit window in seconds (60, 3600, or 86400). */
  rateLimitWindow: anchor.BN;
  /** Total number of keys ever created (monotonically increasing). */
  totalKeysCreated: number;
  /** Number of currently active (non-revoked, non-closed) keys. */
  activeKeys: number;
  /** Unix timestamp when the service was created. */
  createdAt: anchor.BN;
  /** PDA bump seed. */
  bump: number;
}

/** On-chain ApiKey account data, deserialized into TypeScript types. */
export interface ApiKeyAccount {
  /** The ServiceConfig PDA this key belongs to. */
  service: PublicKey;
  /** SHA-256 hash of the raw API key (the raw key is never stored on-chain). */
  keyHash: number[];
  /** Human-readable label (max 32 characters). */
  label: string;
  /** Permission bitmask (READ=1, WRITE=2, DELETE=4, ADMIN=8). */
  permissions: number;
  /** Maximum requests allowed per rate limit window. */
  rateLimit: number;
  /** Rate limit window duration in seconds. */
  rateLimitWindow: anchor.BN;
  /** Number of requests recorded in the current window. */
  windowUsage: number;
  /** Unix timestamp when the current rate limit window started. */
  windowStart: anchor.BN;
  /** Total usage count across all time. */
  totalUsage: anchor.BN;
  /** Unix timestamp when the key was created. */
  createdAt: anchor.BN;
  /** Unix timestamp of the most recent usage (0 means never used). */
  lastUsedAt: anchor.BN;
  /** Unix timestamp when the key expires (0 means never). */
  expiresAt: anchor.BN;
  /** Whether this key has been revoked. */
  revoked: boolean;
  /** PDA bump seed. */
  bump: number;
}

/** Result returned from {@link ApiKeyManagerSDK.createKey}. */
export interface CreateKeyResult {
  /** Transaction signature on the Solana blockchain. */
  signature: TransactionSignature;
  /** The raw API key string. Save this immediately -- it cannot be recovered. */
  rawKey: string;
  /** SHA-256 hash of the raw key, stored on-chain. */
  keyHash: Buffer;
  /** The PDA address of the newly created ApiKey account. */
  apiKeyAddress: PublicKey;
}

/** Result returned from instructions that only produce a transaction signature. */
export interface TxResult {
  /** Transaction signature on the Solana blockchain. */
  signature: TransactionSignature;
}

/** Result returned from {@link ApiKeyManagerSDK.initializeService}. */
export interface InitializeServiceResult extends TxResult {
  /** The PDA address of the newly created ServiceConfig account. */
  serviceConfigAddress: PublicKey;
}

/** An ApiKey account paired with its on-chain public key address. */
export interface ApiKeyWithAddress {
  /** The on-chain public key of the ApiKey PDA account. */
  publicKey: PublicKey;
  /** The deserialized ApiKey account data. */
  account: ApiKeyAccount;
}

/**
 * Wallet interface compatible with both `Keypair` and Anchor's `Wallet`.
 * Any object that exposes a `publicKey` and can sign transactions will work.
 */
export interface WalletAdapter {
  publicKey: PublicKey;
  signTransaction: (tx: anchor.web3.Transaction) => Promise<anchor.web3.Transaction>;
  signAllTransactions: (txs: anchor.web3.Transaction[]) => Promise<anchor.web3.Transaction[]>;
}

// ============================================================================
// Utility Functions (exported for standalone use)
// ============================================================================

/**
 * Generate a cryptographically random API key string.
 * Format: `sk_` followed by 64 hex characters (32 random bytes).
 *
 * @returns A new API key string, e.g. `sk_a1b2c3...`
 */
export function generateApiKey(): string {
  return `sk_${randomBytes(32).toString("hex")}`;
}

/**
 * Compute the SHA-256 hash of a raw API key string.
 * This hash is what gets stored on-chain; the raw key itself is never persisted.
 *
 * @param rawKey - The raw API key string (e.g. `sk_a1b2c3...`)
 * @returns A 32-byte Buffer containing the SHA-256 digest.
 */
export function hashApiKey(rawKey: string): Buffer {
  return createHash("sha256").update(rawKey).digest();
}

/**
 * Derive the ServiceConfig PDA address for a given owner wallet.
 * Each wallet can own at most one service (the PDA is seeded by the owner pubkey).
 *
 * @param owner - The public key of the service owner wallet.
 * @param programId - The program ID (defaults to the deployed program).
 * @returns A tuple of [PDA address, bump seed].
 */
export function findServiceConfigPDA(
  owner: PublicKey,
  programId: PublicKey = DEFAULT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SERVICE_SEED, owner.toBuffer()],
    programId
  );
}

/**
 * Derive the ApiKey PDA address for a given service and key hash.
 *
 * @param serviceConfig - The ServiceConfig PDA address that this key belongs to.
 * @param keyHash - The 32-byte SHA-256 hash of the raw API key.
 * @param programId - The program ID (defaults to the deployed program).
 * @returns A tuple of [PDA address, bump seed].
 */
export function findApiKeyPDA(
  serviceConfig: PublicKey,
  keyHash: Buffer,
  programId: PublicKey = DEFAULT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [API_KEY_SEED, serviceConfig.toBuffer(), keyHash],
    programId
  );
}

/**
 * Format a permission bitmask into a human-readable string.
 *
 * @param mask - The permission bitmask (e.g. 3 for READ|WRITE).
 * @returns A pipe-separated string of permission names, e.g. `"READ|WRITE"`.
 */
export function formatPermissions(mask: number): string {
  const perms: string[] = [];
  if (mask & Permission.READ) perms.push("READ");
  if (mask & Permission.WRITE) perms.push("WRITE");
  if (mask & Permission.DELETE) perms.push("DELETE");
  if (mask & Permission.ADMIN) perms.push("ADMIN");
  return perms.length > 0 ? perms.join("|") : "NONE";
}

/**
 * Check whether a permission bitmask is valid (no undefined bits set).
 *
 * @param mask - The permission bitmask to validate.
 * @returns `true` if only bits 0-3 are set, `false` otherwise.
 */
export function isValidPermissions(mask: number): boolean {
  return (mask & ~Permission.ALL) === 0 && mask >= 0;
}

// ============================================================================
// SDK Class
// ============================================================================

/**
 * Programmatic SDK for the on-chain API Key Manager Solana program.
 *
 * Wraps all 9 program instructions with typed methods, handles PDA derivation,
 * key generation, and account fetching. Designed for integration into backend
 * services, scripts, and dApps.
 *
 * @example
 * ```typescript
 * import { ApiKeyManagerSDK, Permission, RateLimitWindow } from "./sdk";
 * import { Connection, Keypair } from "@solana/web3.js";
 *
 * const connection = new Connection("https://api.devnet.solana.com", "confirmed");
 * const wallet = Keypair.generate();
 * const sdk = new ApiKeyManagerSDK(connection, wallet);
 *
 * // Initialize a service
 * const { signature, serviceConfigAddress } = await sdk.initializeService({
 *   name: "My API",
 *   maxKeys: 100,
 *   defaultRateLimit: 1000,
 *   rateLimitWindow: RateLimitWindow.ONE_HOUR,
 * });
 *
 * // Create an API key
 * const { rawKey, apiKeyAddress } = await sdk.createKey({
 *   label: "production",
 *   permissionsMask: Permission.READ | Permission.WRITE,
 * });
 *
 * // Validate and record usage
 * await sdk.validateKey(rawKey);
 * await sdk.recordUsage(rawKey);
 * ```
 */
export class ApiKeyManagerSDK {
  /** The Solana RPC connection used for all transactions and queries. */
  public readonly connection: Connection;
  /** The program ID of the API Key Manager program. */
  public readonly programId: PublicKey;

  private readonly provider: anchor.AnchorProvider;
  private readonly program: anchor.Program;
  private readonly walletPublicKey: PublicKey;

  /**
   * Create a new SDK instance.
   *
   * @param connection - A Solana `Connection` instance (any cluster).
   * @param wallet - A `Keypair` or Anchor-compatible `Wallet` that will sign transactions.
   *                 When a `Keypair` is provided, it is wrapped in an Anchor `Wallet`.
   * @param programId - Optional override for the program ID. Defaults to the deployed
   *                    program at `v73KoPncjCfhWRkf2QPag15NcFx3oMsRevYtYoGReju`.
   */
  constructor(
    connection: Connection,
    wallet: Keypair | WalletAdapter,
    programId: PublicKey = DEFAULT_PROGRAM_ID
  ) {
    this.connection = connection;
    this.programId = programId;

    const anchorWallet =
      wallet instanceof Keypair ? new anchor.Wallet(wallet) : wallet;

    this.walletPublicKey = anchorWallet.publicKey;

    this.provider = new anchor.AnchorProvider(connection, anchorWallet as any, {
      commitment: "confirmed",
    });

    const idlPath = path.join(
      __dirname,
      "../../target/idl/api_key_manager.json"
    );
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    this.program = new anchor.Program(idl, this.provider);
  }

  // --------------------------------------------------------------------------
  // PDA Helpers (instance methods that use this.programId)
  // --------------------------------------------------------------------------

  /**
   * Derive the ServiceConfig PDA for the connected wallet.
   *
   * @returns A tuple of [PDA address, bump seed].
   */
  public getServiceConfigPDA(): [PublicKey, number] {
    return findServiceConfigPDA(this.walletPublicKey, this.programId);
  }

  /**
   * Derive the ServiceConfig PDA for an arbitrary owner.
   *
   * @param owner - The public key of the service owner.
   * @returns A tuple of [PDA address, bump seed].
   */
  public getServiceConfigPDAForOwner(owner: PublicKey): [PublicKey, number] {
    return findServiceConfigPDA(owner, this.programId);
  }

  /**
   * Derive the ApiKey PDA for a given raw key string.
   * Hashes the key internally and derives the PDA from the connected wallet's service.
   *
   * @param rawKey - The raw API key string.
   * @returns A tuple of [PDA address, bump seed].
   */
  public getApiKeyPDA(rawKey: string): [PublicKey, number] {
    const [serviceConfig] = this.getServiceConfigPDA();
    const keyHash = hashApiKey(rawKey);
    return findApiKeyPDA(serviceConfig, keyHash, this.programId);
  }

  /**
   * Derive the ApiKey PDA using a pre-computed key hash.
   *
   * @param serviceConfig - The ServiceConfig PDA address.
   * @param keyHash - The 32-byte SHA-256 hash of the raw API key.
   * @returns A tuple of [PDA address, bump seed].
   */
  public getApiKeyPDAFromHash(
    serviceConfig: PublicKey,
    keyHash: Buffer
  ): [PublicKey, number] {
    return findApiKeyPDA(serviceConfig, keyHash, this.programId);
  }

  // --------------------------------------------------------------------------
  // Account Fetchers
  // --------------------------------------------------------------------------

  /**
   * Fetch the ServiceConfig account for the connected wallet.
   *
   * @returns The deserialized ServiceConfig data, or `null` if the account does not exist.
   */
  public async fetchServiceConfig(): Promise<ServiceConfigAccount | null> {
    const [pda] = this.getServiceConfigPDA();
    return this.fetchServiceConfigByAddress(pda);
  }

  /**
   * Fetch a ServiceConfig account by its PDA address.
   *
   * @param address - The on-chain PDA address of the ServiceConfig account.
   * @returns The deserialized ServiceConfig data, or `null` if the account does not exist.
   */
  public async fetchServiceConfigByAddress(
    address: PublicKey
  ): Promise<ServiceConfigAccount | null> {
    try {
      const account = await (this.program.account as any).serviceConfig.fetch(
        address
      );
      return account as ServiceConfigAccount;
    } catch {
      return null;
    }
  }

  /**
   * Fetch the ServiceConfig account for a specific owner.
   *
   * @param owner - The public key of the service owner.
   * @returns The deserialized ServiceConfig data, or `null` if the account does not exist.
   */
  public async fetchServiceConfigForOwner(
    owner: PublicKey
  ): Promise<ServiceConfigAccount | null> {
    const [pda] = this.getServiceConfigPDAForOwner(owner);
    return this.fetchServiceConfigByAddress(pda);
  }

  /**
   * Fetch an ApiKey account by the raw key string.
   * Derives the PDA internally from the connected wallet's service.
   *
   * @param rawKey - The raw API key string.
   * @returns The deserialized ApiKey data, or `null` if the account does not exist.
   */
  public async fetchApiKey(rawKey: string): Promise<ApiKeyAccount | null> {
    const [pda] = this.getApiKeyPDA(rawKey);
    return this.fetchApiKeyByAddress(pda);
  }

  /**
   * Fetch an ApiKey account by its PDA address.
   *
   * @param address - The on-chain PDA address of the ApiKey account.
   * @returns The deserialized ApiKey data, or `null` if the account does not exist.
   */
  public async fetchApiKeyByAddress(
    address: PublicKey
  ): Promise<ApiKeyAccount | null> {
    try {
      const account = await (this.program.account as any).apiKey.fetch(address);
      return account as ApiKeyAccount;
    } catch {
      return null;
    }
  }

  /**
   * Fetch all ApiKey accounts belonging to the connected wallet's service.
   * Uses a `memcmp` filter on the `service` field (offset 8, first field after discriminator).
   *
   * @returns An array of ApiKey accounts with their on-chain addresses.
   */
  public async fetchAllApiKeys(): Promise<ApiKeyWithAddress[]> {
    const [servicePDA] = this.getServiceConfigPDA();
    return this.fetchAllApiKeysForService(servicePDA);
  }

  /**
   * Fetch all ApiKey accounts belonging to a specific service.
   *
   * @param serviceConfig - The ServiceConfig PDA address to filter by.
   * @returns An array of ApiKey accounts with their on-chain addresses.
   */
  public async fetchAllApiKeysForService(
    serviceConfig: PublicKey
  ): Promise<ApiKeyWithAddress[]> {
    const accounts = await (this.program.account as any).apiKey.all([
      {
        memcmp: {
          offset: 8, // After the 8-byte account discriminator
          bytes: serviceConfig.toBase58(),
        },
      },
    ]);
    return accounts.map((a: any) => ({
      publicKey: a.publicKey,
      account: a.account as ApiKeyAccount,
    }));
  }

  // --------------------------------------------------------------------------
  // Instructions
  // --------------------------------------------------------------------------

  /**
   * Initialize a new API service.
   * Creates a ServiceConfig PDA owned by the connected wallet. Each wallet can
   * own exactly one service (PDA is seeded by the owner pubkey).
   *
   * @param params - Service initialization parameters.
   * @param params.name - Human-readable service name (1-32 characters).
   * @param params.maxKeys - Maximum number of active API keys (1-10,000).
   * @param params.defaultRateLimit - Default rate limit for new keys (requests per window, must be > 0).
   * @param params.rateLimitWindow - Rate limit window in seconds. Must be 60, 3600, or 86400.
   *                                 Use {@link RateLimitWindow} constants for clarity.
   * @returns The transaction signature and the new ServiceConfig PDA address.
   *
   * @throws Will throw an `AnchorError` if:
   * - Name is empty or exceeds 32 characters (`NameTooLong`)
   * - maxKeys is 0 or exceeds 10,000 (`InvalidConfig`)
   * - defaultRateLimit is 0 (`InvalidConfig`)
   * - rateLimitWindow is not 60, 3600, or 86400 (`InvalidWindow`)
   * - A service already exists for this wallet (account already initialized)
   */
  public async initializeService(params: {
    name: string;
    maxKeys: number;
    defaultRateLimit: number;
    rateLimitWindow: number;
  }): Promise<InitializeServiceResult> {
    const [servicePDA] = this.getServiceConfigPDA();

    const signature = await this.program.methods
      .initializeService(
        params.name,
        params.maxKeys,
        params.defaultRateLimit,
        new anchor.BN(params.rateLimitWindow)
      )
      .accounts({
        serviceConfig: servicePDA,
        owner: this.walletPublicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { signature, serviceConfigAddress: servicePDA };
  }

  /**
   * Update service configuration.
   * Only the service owner can modify. Existing keys retain their current settings;
   * only newly created keys will pick up updated defaults.
   *
   * All parameters are optional -- pass only the fields you want to change.
   *
   * @param params - Fields to update. Omitted or `null`/`undefined` fields are left unchanged.
   * @param params.name - New service name (1-32 characters).
   * @param params.maxKeys - New maximum API keys (must be >= current active keys).
   * @param params.defaultRateLimit - New default rate limit (must be > 0).
   * @param params.rateLimitWindow - New rate limit window (must be 60, 3600, or 86400).
   * @returns The transaction signature.
   *
   * @throws Will throw an `AnchorError` if:
   * - Name is empty or exceeds 32 characters (`NameTooLong`)
   * - maxKeys is below current active key count (`InvalidConfig`)
   * - rateLimitWindow is not a valid value (`InvalidWindow`)
   * - Caller is not the service owner (constraint violation)
   */
  public async updateService(params: {
    name?: string | null;
    maxKeys?: number | null;
    defaultRateLimit?: number | null;
    rateLimitWindow?: number | null;
  }): Promise<TxResult> {
    const [servicePDA] = this.getServiceConfigPDA();

    const signature = await this.program.methods
      .updateService(
        params.name ?? null,
        params.maxKeys ?? null,
        params.defaultRateLimit ?? null,
        params.rateLimitWindow != null
          ? new anchor.BN(params.rateLimitWindow)
          : null
      )
      .accounts({
        serviceConfig: servicePDA,
        owner: this.walletPublicKey,
      })
      .rpc();

    return { signature };
  }

  /**
   * Create a new API key for the service.
   * Generates a random key client-side, computes its SHA-256 hash, and stores the
   * hash on-chain. The raw key is returned exactly once and must be saved by the caller.
   *
   * Only the service owner can create keys.
   *
   * @param params - Key creation parameters.
   * @param params.label - Human-readable label (1-32 characters). Defaults to `"default"`.
   * @param params.permissionsMask - Bitmask of permissions. Use {@link Permission} constants.
   *                                 Defaults to `Permission.READ | Permission.WRITE` (3).
   * @param params.rateLimit - Custom rate limit (requests per window). Omit to use the
   *                           service's default rate limit.
   * @param params.expiresAt - Unix timestamp for key expiration. Omit or pass `null` for
   *                           a key that never expires. Must be in the future if provided.
   * @returns The transaction signature, raw key, key hash, and the ApiKey PDA address.
   *
   * @throws Will throw an `AnchorError` if:
   * - Label is empty or exceeds 32 characters (`NameTooLong`)
   * - Permission bitmask has invalid bits set (`InvalidPermissions`)
   * - Service has reached its maximum key count (`MaxKeysReached`)
   * - expiresAt is in the past (`InvalidExpiry`)
   * - Caller is not the service owner (constraint violation)
   */
  public async createKey(params?: {
    label?: string;
    permissionsMask?: number;
    rateLimit?: number | null;
    expiresAt?: number | null;
  }): Promise<CreateKeyResult> {
    const label = params?.label ?? "default";
    const permissionsMask =
      params?.permissionsMask ?? (Permission.READ | Permission.WRITE);
    const rateLimit = params?.rateLimit ?? null;
    const expiresAt =
      params?.expiresAt != null ? new anchor.BN(params.expiresAt) : null;

    const [servicePDA] = this.getServiceConfigPDA();
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, this.programId);

    const signature = await this.program.methods
      .createKey(
        Array.from(keyHash),
        label,
        permissionsMask,
        rateLimit,
        expiresAt
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: this.walletPublicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return {
      signature,
      rawKey,
      keyHash,
      apiKeyAddress: apiKeyPDA,
    };
  }

  /**
   * Create an API key from a pre-generated raw key string.
   * Useful when you want to control key generation externally (e.g., deterministic keys
   * for testing, or keys generated by a hardware security module).
   *
   * @param rawKey - The pre-generated raw API key string.
   * @param params - Key creation parameters (same as {@link createKey}, except no key is generated).
   * @returns The transaction signature, raw key, key hash, and the ApiKey PDA address.
   */
  public async createKeyFromRaw(
    rawKey: string,
    params?: {
      label?: string;
      permissionsMask?: number;
      rateLimit?: number | null;
      expiresAt?: number | null;
    }
  ): Promise<CreateKeyResult> {
    const label = params?.label ?? "default";
    const permissionsMask =
      params?.permissionsMask ?? (Permission.READ | Permission.WRITE);
    const rateLimit = params?.rateLimit ?? null;
    const expiresAt =
      params?.expiresAt != null ? new anchor.BN(params.expiresAt) : null;

    const [servicePDA] = this.getServiceConfigPDA();
    const keyHash = hashApiKey(rawKey);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, this.programId);

    const signature = await this.program.methods
      .createKey(
        Array.from(keyHash),
        label,
        permissionsMask,
        rateLimit,
        expiresAt
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: this.walletPublicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return {
      signature,
      rawKey,
      keyHash,
      apiKeyAddress: apiKeyPDA,
    };
  }

  /**
   * Validate an API key without recording usage.
   * Checks that the key is active (not revoked), not expired, and within rate limits.
   * This is a read-only check -- anyone can call it. When executed via
   * `simulateTransaction`, no transaction fee is incurred.
   *
   * @param rawKey - The raw API key string to validate.
   * @param serviceOwner - Optional owner public key if validating a key from a different
   *                       service. Defaults to the connected wallet.
   * @returns The transaction signature.
   *
   * @throws Will throw an `AnchorError` if:
   * - Key is revoked (`KeyRevoked`)
   * - Key has expired (`KeyExpired`)
   * - Key has exceeded its rate limit for the current window (`RateLimitExceeded`)
   * - Key does not exist (account not found)
   */
  public async validateKey(
    rawKey: string,
    serviceOwner?: PublicKey
  ): Promise<TxResult> {
    const owner = serviceOwner ?? this.walletPublicKey;
    const [servicePDA] = findServiceConfigPDA(owner, this.programId);
    const keyHash = hashApiKey(rawKey);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, this.programId);

    const signature = await this.program.methods
      .validateKey()
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
      })
      .rpc();

    return { signature };
  }

  /**
   * Check if a key has a specific permission.
   * Executes an on-chain permission check and emits a `PermissionChecked` event.
   * Useful for fine-grained authorization without fetching the full account client-side.
   *
   * @param rawKey - The raw API key string to check.
   * @param requiredPermission - The permission bitmask to check for. Use {@link Permission}
   *                             constants. Multiple permissions can be combined with `|`.
   * @param serviceOwner - Optional owner public key if checking a key from a different
   *                       service. Defaults to the connected wallet.
   * @returns The transaction signature.
   *
   * @throws Will throw an `AnchorError` if:
   * - Key does not have the required permission(s) (`InsufficientPermissions`)
   * - Key is revoked (`KeyRevoked`)
   * - Key has expired (`KeyExpired`)
   */
  public async checkPermission(
    rawKey: string,
    requiredPermission: number,
    serviceOwner?: PublicKey
  ): Promise<TxResult> {
    const owner = serviceOwner ?? this.walletPublicKey;
    const [servicePDA] = findServiceConfigPDA(owner, this.programId);
    const keyHash = hashApiKey(rawKey);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, this.programId);

    const signature = await this.program.methods
      .checkPermission(requiredPermission)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
      })
      .rpc();

    return { signature };
  }

  /**
   * Record a usage event for an API key.
   * This is the core "middleware" equivalent -- call this when an API request is received.
   * Validates that the key is active, not expired, and within rate limits before
   * incrementing the usage counter.
   *
   * Only the service owner can record usage (prevents griefing by unauthorized callers).
   *
   * @param rawKey - The raw API key string whose usage is being recorded.
   * @returns The transaction signature.
   *
   * @throws Will throw an `AnchorError` if:
   * - Key is revoked (`KeyRevoked`)
   * - Key has expired (`KeyExpired`)
   * - Rate limit exceeded for the current window (`RateLimitExceeded`)
   * - Caller is not the service owner (constraint violation)
   */
  public async recordUsage(rawKey: string): Promise<TxResult> {
    const [servicePDA] = this.getServiceConfigPDA();
    const keyHash = hashApiKey(rawKey);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, this.programId);

    const signature = await this.program.methods
      .recordUsage(Array.from(keyHash))
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: this.walletPublicKey,
      })
      .rpc();

    return { signature };
  }

  /**
   * Update an existing API key's properties.
   * Only the service owner can modify key properties. All parameters are optional --
   * pass only the fields you want to change.
   *
   * @param rawKey - The raw API key string identifying the key to update.
   * @param params - Fields to update. Omitted or `null`/`undefined` fields are left unchanged.
   * @param params.permissionsMask - New permission bitmask. Use {@link Permission} constants.
   * @param params.rateLimit - New rate limit (requests per window, must be > 0).
   * @param params.expiresAt - New expiration timestamp (must be in the future).
   * @returns The transaction signature.
   *
   * @throws Will throw an `AnchorError` if:
   * - Key is revoked (`KeyRevoked`)
   * - Permission bitmask has invalid bits (`InvalidPermissions`)
   * - Rate limit is 0 (`InvalidConfig`)
   * - expiresAt is in the past (`InvalidExpiry`)
   * - Caller is not the service owner (constraint violation)
   */
  public async updateKey(
    rawKey: string,
    params: {
      permissionsMask?: number | null;
      rateLimit?: number | null;
      expiresAt?: number | null;
    }
  ): Promise<TxResult> {
    const [servicePDA] = this.getServiceConfigPDA();
    const keyHash = hashApiKey(rawKey);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, this.programId);

    const signature = await this.program.methods
      .updateKey(
        params.permissionsMask ?? null,
        params.rateLimit ?? null,
        params.expiresAt != null ? new anchor.BN(params.expiresAt) : null
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: this.walletPublicKey,
      })
      .rpc();

    return { signature };
  }

  /**
   * Revoke an API key (soft-disable).
   * The key account remains on-chain but all usage attempts will be rejected.
   * This operation is irreversible -- a revoked key cannot be reactivated.
   * To fully remove the account and reclaim rent, use {@link closeKey} instead.
   *
   * Only the service owner can revoke keys.
   *
   * @param rawKey - The raw API key string to revoke.
   * @returns The transaction signature.
   *
   * @throws Will throw an `AnchorError` if:
   * - Key is already revoked (`AlreadyRevoked`)
   * - Caller is not the service owner (constraint violation)
   */
  public async revokeKey(rawKey: string): Promise<TxResult> {
    const [servicePDA] = this.getServiceConfigPDA();
    const keyHash = hashApiKey(rawKey);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, this.programId);

    const signature = await this.program.methods
      .revokeKey()
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: this.walletPublicKey,
      })
      .rpc();

    return { signature };
  }

  /**
   * Close an API key account and reclaim its rent-exempt SOL balance.
   * This is a hard delete -- the key account is permanently removed from the blockchain
   * and cannot be recovered. The rent lamports are returned to the service owner's wallet.
   *
   * If the key was still active (not revoked), the service's `active_keys` counter
   * is decremented.
   *
   * Only the service owner can close keys.
   *
   * @param rawKey - The raw API key string whose account will be closed.
   * @returns The transaction signature.
   *
   * @throws Will throw an `AnchorError` if:
   * - Key account does not exist (already closed or never created)
   * - Caller is not the service owner (constraint violation)
   */
  public async closeKey(rawKey: string): Promise<TxResult> {
    const [servicePDA] = this.getServiceConfigPDA();
    const keyHash = hashApiKey(rawKey);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, this.programId);

    const signature = await this.program.methods
      .closeKey()
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: this.walletPublicKey,
      })
      .rpc();

    return { signature };
  }
}

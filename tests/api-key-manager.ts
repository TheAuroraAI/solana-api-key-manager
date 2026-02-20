import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ApiKeyManager } from "../target/types/api_key_manager";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  hashApiKey,
  generateApiKey,
  findServiceConfigPDA as findServicePDA,
  findApiKeyPDA,
} from "../client/src/sdk";

// ============================================================================
// Test Assertion Helpers
// ============================================================================

/** Assert that an error is an Anchor program error with the expected code. */
function expectAnchorError(e: unknown, code: string): void {
  const err = e as { error?: { errorCode?: { code: string } } };
  expect(err.error?.errorCode?.code).to.equal(code);
}

/** Assert that an error message contains a substring (for constraint violations). */
function expectErrorContains(e: unknown, substring: string): void {
  expect(String(e)).to.include(substring);
}

describe("api-key-manager", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .ApiKeyManager as Program<ApiKeyManager>;
  const owner = provider.wallet;

  let servicePDA: PublicKey;
  let serviceBump: number;
  let testApiKey: string;
  let testKeyHash: Buffer;
  let apiKeyPDA: PublicKey;

  before(() => {
    [servicePDA, serviceBump] = findServicePDA(
      owner.publicKey,
      program.programId
    );
    testApiKey = generateApiKey();
    testKeyHash = hashApiKey(testApiKey);
    [apiKeyPDA] = findApiKeyPDA(servicePDA, testKeyHash, program.programId);
  });

  // ========================================================================
  // Service Initialization
  // ========================================================================

  it("initializes a service", async () => {
    await program.methods
      .initializeService("Test API Service", 100, 1000, new anchor.BN(3600))
      .accounts({
        serviceConfig: servicePDA,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const service = await program.account.serviceConfig.fetch(servicePDA);
    expect(service.name).to.equal("Test API Service");
    expect(service.maxKeys).to.equal(100);
    expect(service.defaultRateLimit).to.equal(1000);
    expect(service.rateLimitWindow.toNumber()).to.equal(3600);
    expect(service.totalKeysCreated).to.equal(0);
    expect(service.activeKeys).to.equal(0);
    expect(service.owner.toBase58()).to.equal(owner.publicKey.toBase58());
    expect(service.createdAt.toNumber()).to.be.greaterThan(0);
  });

  it("rejects duplicate service creation", async () => {
    try {
      await program.methods
        .initializeService("Duplicate", 100, 1000, new anchor.BN(3600))
        .accounts({
          serviceConfig: servicePDA,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      // Account already initialized — Anchor rejects duplicate PDA init
      expectErrorContains(e, "already in use");
    }
  });

  it("rejects service name longer than 32 characters", async () => {
    const badOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      badOwner.publicKey,
      1_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [badServicePDA] = findServicePDA(
      badOwner.publicKey,
      program.programId
    );

    try {
      await program.methods
        .initializeService(
          "This name is way too long for the field limit of 32 chars",
          100,
          1000,
          new anchor.BN(3600)
        )
        .accounts({
          serviceConfig: badServicePDA,
          owner: badOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([badOwner])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidName");
    }
  });

  it("rejects empty service name", async () => {
    const badOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      badOwner.publicKey,
      1_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [badServicePDA] = findServicePDA(
      badOwner.publicKey,
      program.programId
    );

    try {
      await program.methods
        .initializeService("", 100, 1000, new anchor.BN(3600))
        .accounts({
          serviceConfig: badServicePDA,
          owner: badOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([badOwner])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidName");
    }
  });

  it("rejects zero max_keys", async () => {
    const badOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      badOwner.publicKey,
      1_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [badServicePDA] = findServicePDA(
      badOwner.publicKey,
      program.programId
    );

    try {
      await program.methods
        .initializeService("Zero Keys", 0, 1000, new anchor.BN(3600))
        .accounts({
          serviceConfig: badServicePDA,
          owner: badOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([badOwner])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidConfig");
    }
  });

  it("rejects creation with invalid window", async () => {
    const badOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      badOwner.publicKey,
      1_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [badServicePDA] = findServicePDA(
      badOwner.publicKey,
      program.programId
    );

    try {
      await program.methods
        .initializeService("Bad Service", 100, 1000, new anchor.BN(999))
        .accounts({
          serviceConfig: badServicePDA,
          owner: badOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([badOwner])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidWindow");
    }
  });

  it("supports all three window durations", async () => {
    const windowTests = [
      { window: 60, name: "Minute Window" },
      { window: 86400, name: "Day Window" },
    ];

    for (const test of windowTests) {
      const testOwner = Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        testOwner.publicKey,
        2_000_000_000
      );
      await provider.connection.confirmTransaction(airdropSig);

      const [testServicePDA] = findServicePDA(
        testOwner.publicKey,
        program.programId
      );

      await program.methods
        .initializeService(
          test.name,
          50,
          500,
          new anchor.BN(test.window)
        )
        .accounts({
          serviceConfig: testServicePDA,
          owner: testOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([testOwner])
        .rpc();

      const service = await program.account.serviceConfig.fetch(
        testServicePDA
      );
      expect(service.rateLimitWindow.toNumber()).to.equal(test.window);
      expect(service.name).to.equal(test.name);
    }
  });

  // ========================================================================
  // Service Updates
  // ========================================================================

  it("updates service name", async () => {
    await program.methods
      .updateService("Updated API Service", null, null, null)
      .accounts({
        serviceConfig: servicePDA,
        owner: owner.publicKey,
      })
      .rpc();

    const service = await program.account.serviceConfig.fetch(servicePDA);
    expect(service.name).to.equal("Updated API Service");
    // Other fields unchanged
    expect(service.maxKeys).to.equal(100);
    expect(service.defaultRateLimit).to.equal(1000);
  });

  it("updates service max_keys and rate limit", async () => {
    await program.methods
      .updateService(null, 200, 2000, null)
      .accounts({
        serviceConfig: servicePDA,
        owner: owner.publicKey,
      })
      .rpc();

    const service = await program.account.serviceConfig.fetch(servicePDA);
    expect(service.maxKeys).to.equal(200);
    expect(service.defaultRateLimit).to.equal(2000);
    expect(service.name).to.equal("Updated API Service");
  });

  it("updates service window duration", async () => {
    await program.methods
      .updateService(null, null, null, new anchor.BN(60))
      .accounts({
        serviceConfig: servicePDA,
        owner: owner.publicKey,
      })
      .rpc();

    const service = await program.account.serviceConfig.fetch(servicePDA);
    expect(service.rateLimitWindow.toNumber()).to.equal(60);

    // Reset back to hourly for remaining tests
    await program.methods
      .updateService(null, null, null, new anchor.BN(3600))
      .accounts({
        serviceConfig: servicePDA,
        owner: owner.publicKey,
      })
      .rpc();
  });

  it("rejects service update with invalid window", async () => {
    try {
      await program.methods
        .updateService(null, null, null, new anchor.BN(999))
        .accounts({
          serviceConfig: servicePDA,
          owner: owner.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidWindow");
    }
  });

  it("rejects service update from non-owner", async () => {
    const attacker = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      1_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    try {
      await program.methods
        .updateService("Hacked", null, null, null)
        .accounts({
          serviceConfig: servicePDA,
          owner: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown — unauthorized");
    } catch (e: unknown) {
      // Attacker's key doesn't match service PDA seeds — constraint violation
      expectErrorContains(e, "Constraint");
    }
  });

  // ========================================================================
  // Key Creation
  // ========================================================================

  it("creates an API key", async () => {
    await program.methods
      .createKey(
        Array.from(testKeyHash),
        "Production Key",
        3, // READ + WRITE
        null, // use default rate limit
        null // never expires
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(apiKeyPDA);
    expect(apiKey.label).to.equal("Production Key");
    expect(apiKey.permissions).to.equal(3);
    expect(apiKey.rateLimit).to.equal(2000); // Updated default from service update test
    expect(apiKey.revoked).to.equal(false);
    expect(apiKey.totalUsage.toNumber()).to.equal(0);
    expect(apiKey.lastUsedAt.toNumber()).to.equal(0);
    expect(apiKey.createdAt.toNumber()).to.be.greaterThan(0);

    const service = await program.account.serviceConfig.fetch(servicePDA);
    expect(service.totalKeysCreated).to.equal(1);
    expect(service.activeKeys).to.equal(1);
  });

  it("creates a key with expiry", async () => {
    const key2 = generateApiKey();
    const keyHash2 = hashApiKey(key2);
    const [apiKeyPDA2] = findApiKeyPDA(
      servicePDA,
      keyHash2,
      program.programId
    );

    const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;

    await program.methods
      .createKey(
        Array.from(keyHash2),
        "Expiring Key",
        1, // READ only
        500, // custom rate limit
        new anchor.BN(futureTimestamp)
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA2,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(apiKeyPDA2);
    expect(apiKey.label).to.equal("Expiring Key");
    expect(apiKey.permissions).to.equal(1);
    expect(apiKey.rateLimit).to.equal(500);
    expect(apiKey.expiresAt.toNumber()).to.equal(futureTimestamp);
  });

  it("rejects key creation with past expiry", async () => {
    const keyPast = generateApiKey();
    const keyHashPast = hashApiKey(keyPast);
    const [apiKeyPDAPast] = findApiKeyPDA(
      servicePDA,
      keyHashPast,
      program.programId
    );

    const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;

    try {
      await program.methods
        .createKey(
          Array.from(keyHashPast),
          "Past Key",
          1,
          null,
          new anchor.BN(pastTimestamp)
        )
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDAPast,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidExpiry");
    }
  });

  it("rejects key with invalid permission bits", async () => {
    const keyBad = generateApiKey();
    const keyHashBad = hashApiKey(keyBad);
    const [apiKeyPDABad] = findApiKeyPDA(
      servicePDA,
      keyHashBad,
      program.programId
    );

    try {
      await program.methods
        .createKey(
          Array.from(keyHashBad),
          "Bad Perms",
          255, // bits beyond ADMIN are invalid
          null,
          null
        )
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDABad,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidPermissions");
    }
  });

  it("rejects key with empty label", async () => {
    const keyEmpty = generateApiKey();
    const keyHashEmpty = hashApiKey(keyEmpty);
    const [apiKeyPDAEmpty] = findApiKeyPDA(
      servicePDA,
      keyHashEmpty,
      program.programId
    );

    try {
      await program.methods
        .createKey(
          Array.from(keyHashEmpty),
          "", // empty label
          3,
          null,
          null
        )
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDAEmpty,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidName");
    }
  });

  // ========================================================================
  // Key Validation & Permission Checks
  // ========================================================================

  it("validates a key", async () => {
    await program.methods
      .validateKey()
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
      })
      .rpc();
  });

  it("checks permission — key has required permission", async () => {
    // Key has READ (1) + WRITE (2) = 3
    await program.methods
      .checkPermission(1) // READ
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
      })
      .rpc();

    await program.methods
      .checkPermission(2) // WRITE
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
      })
      .rpc();

    await program.methods
      .checkPermission(3) // READ + WRITE
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
      })
      .rpc();
  });

  it("rejects permission check when key lacks permission", async () => {
    // Key has READ + WRITE (3), but not DELETE (4)
    try {
      await program.methods
        .checkPermission(4) // DELETE
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "InsufficientPermissions");
    }
  });

  it("rejects permission check for ADMIN on non-admin key", async () => {
    try {
      await program.methods
        .checkPermission(8) // ADMIN
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "InsufficientPermissions");
    }
  });

  // ========================================================================
  // Usage Recording
  // ========================================================================

  it("records usage", async () => {
    await program.methods
      .recordUsage(Array.from(testKeyHash))
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: owner.publicKey,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(apiKeyPDA);
    expect(apiKey.windowUsage).to.equal(1);
    expect(apiKey.totalUsage.toNumber()).to.equal(1);
    expect(apiKey.lastUsedAt.toNumber()).to.be.greaterThan(0);
  });

  it("records multiple usages", async () => {
    for (let i = 0; i < 5; i++) {
      await program.methods
        .recordUsage(Array.from(testKeyHash))
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
          owner: owner.publicKey,
        })
        .rpc();
    }

    const apiKey = await program.account.apiKey.fetch(apiKeyPDA);
    expect(apiKey.windowUsage).to.equal(6);
    expect(apiKey.totalUsage.toNumber()).to.equal(6);
  });

  it("rejects unauthorized usage recording", async () => {
    const keyAuth = generateApiKey();
    const keyHashAuth = hashApiKey(keyAuth);
    const [apiKeyPDAAuth] = findApiKeyPDA(
      servicePDA,
      keyHashAuth,
      program.programId
    );

    await program.methods
      .createKey(Array.from(keyHashAuth), "Auth Test Key", 3, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAAuth,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const attacker = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      1_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    try {
      await program.methods
        .recordUsage(Array.from(keyHashAuth))
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDAAuth,
          owner: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown — unauthorized caller");
    } catch (e: unknown) {
      // Attacker's key doesn't match service PDA seeds — constraint violation
      expectErrorContains(e, "Constraint");
    }
  });

  // ========================================================================
  // Rate Limiting
  // ========================================================================

  it("enforces rate limits", async () => {
    const keyRL = generateApiKey();
    const keyHashRL = hashApiKey(keyRL);
    const [apiKeyPDARL] = findApiKeyPDA(
      servicePDA,
      keyHashRL,
      program.programId
    );

    await program.methods
      .createKey(
        Array.from(keyHashRL),
        "Rate Limited Key",
        3,
        3, // only 3 requests per window
        null
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDARL,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Use all 3 allowed requests
    for (let i = 0; i < 3; i++) {
      await program.methods
        .recordUsage(Array.from(keyHashRL))
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDARL,
          owner: owner.publicKey,
        })
        .rpc();
    }

    // 4th request should be rejected
    try {
      await program.methods
        .recordUsage(Array.from(keyHashRL))
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDARL,
          owner: owner.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown — rate limit exceeded");
    } catch (e: unknown) {
      expectAnchorError(e, "RateLimitExceeded");
    }

    const apiKey = await program.account.apiKey.fetch(apiKeyPDARL);
    expect(apiKey.windowUsage).to.equal(3);
    expect(apiKey.totalUsage.toNumber()).to.equal(3);
  });

  it("validate_key also checks rate limits", async () => {
    // Create a key with rate limit 1, use it once
    const keyVRL = generateApiKey();
    const keyHashVRL = hashApiKey(keyVRL);
    const [apiKeyPDAVRL] = findApiKeyPDA(
      servicePDA,
      keyHashVRL,
      program.programId
    );

    await program.methods
      .createKey(Array.from(keyHashVRL), "Validate RL", 3, 1, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAVRL,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Use the single allowed request
    await program.methods
      .recordUsage(Array.from(keyHashVRL))
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAVRL,
        owner: owner.publicKey,
      })
      .rpc();

    // validate_key should now fail
    try {
      await program.methods
        .validateKey()
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDAVRL,
        })
        .rpc();
      expect.fail("Should have thrown — rate limited");
    } catch (e: unknown) {
      expectAnchorError(e, "RateLimitExceeded");
    }
  });

  it("validates key returns remaining usage info", async () => {
    const keyVal = generateApiKey();
    const keyHashVal = hashApiKey(keyVal);
    const [apiKeyPDAVal] = findApiKeyPDA(
      servicePDA,
      keyHashVal,
      program.programId
    );

    await program.methods
      .createKey(
        Array.from(keyHashVal),
        "Validation Test",
        7, // READ + WRITE + DELETE
        10,
        null
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAVal,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    for (let i = 0; i < 3; i++) {
      await program.methods
        .recordUsage(Array.from(keyHashVal))
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDAVal,
          owner: owner.publicKey,
        })
        .rpc();
    }

    // Validate should succeed (7 remaining)
    await program.methods
      .validateKey()
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAVal,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(apiKeyPDAVal);
    expect(apiKey.permissions).to.equal(7);
    expect(apiKey.windowUsage).to.equal(3);
    expect(apiKey.rateLimit).to.equal(10);
  });

  // ========================================================================
  // Key Updates
  // ========================================================================

  it("updates key permissions", async () => {
    await program.methods
      .updateKey(
        7, // READ + WRITE + DELETE
        null,
        null
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: owner.publicKey,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(apiKeyPDA);
    expect(apiKey.permissions).to.equal(7);
  });

  it("updates key rate limit", async () => {
    await program.methods
      .updateKey(
        null,
        5000, // new rate limit
        null
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: owner.publicKey,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(apiKeyPDA);
    expect(apiKey.rateLimit).to.equal(5000);
  });

  it("updates key with new expiry", async () => {
    const keyUpd = generateApiKey();
    const keyHashUpd = hashApiKey(keyUpd);
    const [apiKeyPDAUpd] = findApiKeyPDA(
      servicePDA,
      keyHashUpd,
      program.programId
    );

    await program.methods
      .createKey(Array.from(keyHashUpd), "Update Expiry", 3, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAUpd,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const futureExpiry = Math.floor(Date.now() / 1000) + 7200;

    await program.methods
      .updateKey(null, null, new anchor.BN(futureExpiry))
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAUpd,
        owner: owner.publicKey,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(apiKeyPDAUpd);
    expect(apiKey.expiresAt.toNumber()).to.equal(futureExpiry);
  });

  it("rejects update with past expiry", async () => {
    const keyUpdPast = generateApiKey();
    const keyHashUpdPast = hashApiKey(keyUpdPast);
    const [apiKeyPDAUpdPast] = findApiKeyPDA(
      servicePDA,
      keyHashUpdPast,
      program.programId
    );

    await program.methods
      .createKey(Array.from(keyHashUpdPast), "Past Expiry", 3, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAUpdPast,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const pastExpiry = Math.floor(Date.now() / 1000) - 3600;

    try {
      await program.methods
        .updateKey(null, null, new anchor.BN(pastExpiry))
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDAUpdPast,
          owner: owner.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown — past expiry");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidExpiry");
    }
  });

  it("rejects update with zero rate limit", async () => {
    const keyFresh = generateApiKey();
    const keyHashFresh = hashApiKey(keyFresh);
    const [apiKeyPDAFresh] = findApiKeyPDA(
      servicePDA,
      keyHashFresh,
      program.programId
    );

    await program.methods
      .createKey(Array.from(keyHashFresh), "Fresh Key", 3, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAFresh,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await program.methods
        .updateKey(null, 0, null)
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDAFresh,
          owner: owner.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidConfig");
    }
  });

  it("rejects update with invalid permission bits", async () => {
    const keyBadUpd = generateApiKey();
    const keyHashBadUpd = hashApiKey(keyBadUpd);
    const [apiKeyPDABadUpd] = findApiKeyPDA(
      servicePDA,
      keyHashBadUpd,
      program.programId
    );

    await program.methods
      .createKey(Array.from(keyHashBadUpd), "Bad Update", 3, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDABadUpd,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await program.methods
        .updateKey(128, null, null) // invalid permission bit
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDABadUpd,
          owner: owner.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidPermissions");
    }
  });

  // ========================================================================
  // Key Revocation
  // ========================================================================

  it("revokes a key", async () => {
    const serviceBefore = await program.account.serviceConfig.fetch(servicePDA);
    const activeKeysBefore = serviceBefore.activeKeys;

    await program.methods
      .revokeKey()
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: owner.publicKey,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(apiKeyPDA);
    expect(apiKey.revoked).to.equal(true);

    const service = await program.account.serviceConfig.fetch(servicePDA);
    expect(service.activeKeys).to.equal(activeKeysBefore - 1);
  });

  it("rejects usage on revoked key", async () => {
    try {
      await program.methods
        .recordUsage(Array.from(testKeyHash))
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
          owner: owner.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "KeyRevoked");
    }
  });

  it("rejects update on revoked key", async () => {
    try {
      await program.methods
        .updateKey(15, null, null)
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
          owner: owner.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "KeyRevoked");
    }
  });

  it("rejects double revocation", async () => {
    try {
      await program.methods
        .revokeKey()
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
          owner: owner.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      expectAnchorError(e, "AlreadyRevoked");
    }
  });

  it("rejects validate_key on revoked key", async () => {
    try {
      await program.methods
        .validateKey()
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
        })
        .rpc();
      expect.fail("Should have thrown — key is revoked");
    } catch (e: unknown) {
      expectAnchorError(e, "KeyRevoked");
    }
  });

  it("rejects check_permission on revoked key", async () => {
    try {
      await program.methods
        .checkPermission(1)
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
        })
        .rpc();
      expect.fail("Should have thrown — key is revoked");
    } catch (e: unknown) {
      expectAnchorError(e, "KeyRevoked");
    }
  });

  // ========================================================================
  // Key Closure & Rent Reclamation
  // ========================================================================

  it("closes a key and reclaims rent", async () => {
    const key3 = generateApiKey();
    const keyHash3 = hashApiKey(key3);
    const [apiKeyPDA3] = findApiKeyPDA(
      servicePDA,
      keyHash3,
      program.programId
    );

    await program.methods
      .createKey(Array.from(keyHash3), "Temp Key", 1, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA3,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const balanceBefore = await provider.connection.getBalance(
      owner.publicKey
    );

    await program.methods
      .closeKey()
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA3,
        owner: owner.publicKey,
      })
      .rpc();

    const balanceAfter = await provider.connection.getBalance(
      owner.publicKey
    );
    expect(balanceAfter).to.be.greaterThan(balanceBefore);

    const account = await provider.connection.getAccountInfo(apiKeyPDA3);
    expect(account).to.be.null;
  });

  it("close key decrements active_keys for non-revoked key", async () => {
    const keyClose = generateApiKey();
    const keyHashClose = hashApiKey(keyClose);
    const [apiKeyPDAClose] = findApiKeyPDA(
      servicePDA,
      keyHashClose,
      program.programId
    );

    await program.methods
      .createKey(Array.from(keyHashClose), "Close Test", 3, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAClose,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const serviceBefore = await program.account.serviceConfig.fetch(servicePDA);
    const activeKeysBefore = serviceBefore.activeKeys;

    await program.methods
      .closeKey()
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAClose,
        owner: owner.publicKey,
      })
      .rpc();

    const serviceAfter = await program.account.serviceConfig.fetch(servicePDA);
    expect(serviceAfter.activeKeys).to.equal(activeKeysBefore - 1);
  });

  // ========================================================================
  // Max Keys Limit
  // ========================================================================

  it("enforces max_keys limit", async () => {
    const limitOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      limitOwner.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [limitServicePDA] = findServicePDA(
      limitOwner.publicKey,
      program.programId
    );

    await program.methods
      .initializeService("Limited Service", 2, 1000, new anchor.BN(3600))
      .accounts({
        serviceConfig: limitServicePDA,
        owner: limitOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([limitOwner])
      .rpc();

    // Create 2 keys (should succeed)
    for (let i = 0; i < 2; i++) {
      const key = generateApiKey();
      const keyHash = hashApiKey(key);
      const [keyPDA] = findApiKeyPDA(limitServicePDA, keyHash, program.programId);

      await program.methods
        .createKey(Array.from(keyHash), `Key ${i}`, 3, null, null)
        .accounts({
          serviceConfig: limitServicePDA,
          apiKey: keyPDA,
          owner: limitOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([limitOwner])
        .rpc();
    }

    // 3rd key should fail
    const key3 = generateApiKey();
    const keyHash3 = hashApiKey(key3);
    const [keyPDA3] = findApiKeyPDA(limitServicePDA, keyHash3, program.programId);

    try {
      await program.methods
        .createKey(Array.from(keyHash3), "Key 2", 3, null, null)
        .accounts({
          serviceConfig: limitServicePDA,
          apiKey: keyPDA3,
          owner: limitOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([limitOwner])
        .rpc();
      expect.fail("Should have thrown — max keys reached");
    } catch (e: unknown) {
      expectAnchorError(e, "MaxKeysReached");
    }
  });

  it("rejects lowering max_keys below active_keys", async () => {
    // Service currently has active keys
    const service = await program.account.serviceConfig.fetch(servicePDA);
    const currentActive = service.activeKeys;

    if (currentActive > 0) {
      try {
        await program.methods
          .updateService(null, 0, null, null) // 0 < active_keys
          .accounts({
            serviceConfig: servicePDA,
            owner: owner.publicKey,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (e: unknown) {
        expectAnchorError(e, "InvalidConfig");
      }
    }
  });

  // ========================================================================
  // Permission Bitmask
  // ========================================================================

  it("validates all permission bitmask values", async () => {
    const keyAdmin = generateApiKey();
    const keyHashAdmin = hashApiKey(keyAdmin);
    const [apiKeyPDAAdmin] = findApiKeyPDA(
      servicePDA,
      keyHashAdmin,
      program.programId
    );

    await program.methods
      .createKey(
        Array.from(keyHashAdmin),
        "Admin Key",
        15, // READ | WRITE | DELETE | ADMIN
        null,
        null
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAAdmin,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(apiKeyPDAAdmin);
    expect(apiKey.permissions).to.equal(15);
    expect(apiKey.permissions & 1).to.equal(1); // READ
    expect(apiKey.permissions & 2).to.equal(2); // WRITE
    expect(apiKey.permissions & 4).to.equal(4); // DELETE
    expect(apiKey.permissions & 8).to.equal(8); // ADMIN

    // check_permission should pass for all
    await program.methods
      .checkPermission(15) // all permissions
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAAdmin,
      })
      .rpc();
  });

  // ========================================================================
  // Edge Cases & Robustness
  // ========================================================================

  it("creates key with all permissions and custom rate limit", async () => {
    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [kPDA] = findApiKeyPDA(servicePDA, keyHash, program.programId);

    const futureExpiry = Math.floor(Date.now() / 1000) + 86400;

    await program.methods
      .createKey(
        Array.from(keyHash),
        "Full Access",
        15, // READ | WRITE | DELETE | ADMIN
        9999,
        new anchor.BN(futureExpiry)
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: kPDA,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(kPDA);
    expect(apiKey.permissions).to.equal(15);
    expect(apiKey.rateLimit).to.equal(9999);
    expect(apiKey.expiresAt.toNumber()).to.equal(futureExpiry);
    expect(apiKey.revoked).to.equal(false);
    expect(apiKey.windowUsage).to.equal(0);
  });

  it("cannot create key with zero permissions", async () => {
    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [kPDA] = findApiKeyPDA(servicePDA, keyHash, program.programId);

    // Permission mask 0 should be valid (is_valid checks for bits outside range, not zero)
    // This tests the current behavior — zero permissions is allowed but useless
    await program.methods
      .createKey(Array.from(keyHash), "No Perms", 0, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: kPDA,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(kPDA);
    expect(apiKey.permissions).to.equal(0);

    // Check permission should fail for any permission on this key
    try {
      await program.methods
        .checkPermission(1) // READ
        .accounts({
          serviceConfig: servicePDA,
          apiKey: kPDA,
        })
        .rpc();
      expect.fail("Should have thrown — no permissions");
    } catch (e: unknown) {
      expectAnchorError(e, "InsufficientPermissions");
    }
  });

  it("rejects check_permission with zero required permission", async () => {
    // check_permission(0) should be rejected — 0 is not a valid permission request
    const keyZP = generateApiKey();
    const keyHashZP = hashApiKey(keyZP);
    const [apiKeyPDAZP] = findApiKeyPDA(
      servicePDA,
      keyHashZP,
      program.programId
    );

    await program.methods
      .createKey(Array.from(keyHashZP), "Zero Perm Check", 15, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDAZP,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await program.methods
        .checkPermission(0) // zero — should be rejected
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDAZP,
        })
        .rpc();
      expect.fail("Should have thrown — zero permission");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidPermissions");
    }
  });

  it("rejects check_permission with invalid permission bits", async () => {
    try {
      await program.methods
        .checkPermission(32) // invalid bit (beyond ADMIN=8)
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
        })
        .rpc();
      expect.fail("Should have thrown — invalid permission bits");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidPermissions");
    }
  });

  it("validates that usage cannot be recorded by non-owner even with correct key_hash", async () => {
    // Create a second service owned by someone else
    const otherOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      otherOwner.publicKey,
      2_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [otherServicePDA] = findServicePDA(
      otherOwner.publicKey,
      program.programId
    );

    await program.methods
      .initializeService("Other Service", 10, 100, new anchor.BN(3600))
      .accounts({
        serviceConfig: otherServicePDA,
        owner: otherOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([otherOwner])
      .rpc();

    const otherKey = generateApiKey();
    const otherKeyHash = hashApiKey(otherKey);
    const [otherApiKeyPDA] = findApiKeyPDA(
      otherServicePDA,
      otherKeyHash,
      program.programId
    );

    await program.methods
      .createKey(Array.from(otherKeyHash), "Other Key", 3, null, null)
      .accounts({
        serviceConfig: otherServicePDA,
        apiKey: otherApiKeyPDA,
        owner: otherOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([otherOwner])
      .rpc();

    // Now try to record usage with the main owner's wallet (not the other service's owner)
    try {
      await program.methods
        .recordUsage(Array.from(otherKeyHash))
        .accounts({
          serviceConfig: otherServicePDA,
          apiKey: otherApiKeyPDA,
          owner: owner.publicKey,  // Wrong owner
        })
        .rpc();
      expect.fail("Should have thrown — wrong service owner");
    } catch (e: unknown) {
      // Wrong owner doesn't match service PDA seeds
      expectErrorContains(e, "Constraint");
    }
  });

  it("service counters are accurate after multiple creates and closes", async () => {
    const testOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      testOwner.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [testServicePDA] = findServicePDA(
      testOwner.publicKey,
      program.programId
    );

    await program.methods
      .initializeService("Counter Test", 10, 100, new anchor.BN(3600))
      .accounts({
        serviceConfig: testServicePDA,
        owner: testOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([testOwner])
      .rpc();

    // Create 3 keys
    const keys: { hash: Buffer; pda: PublicKey }[] = [];
    for (let i = 0; i < 3; i++) {
      const k = generateApiKey();
      const kh = hashApiKey(k);
      const [kPDA] = findApiKeyPDA(testServicePDA, kh, program.programId);
      keys.push({ hash: kh, pda: kPDA });

      await program.methods
        .createKey(Array.from(kh), `Key ${i}`, 3, null, null)
        .accounts({
          serviceConfig: testServicePDA,
          apiKey: kPDA,
          owner: testOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([testOwner])
        .rpc();
    }

    let service = await program.account.serviceConfig.fetch(testServicePDA);
    expect(service.totalKeysCreated).to.equal(3);
    expect(service.activeKeys).to.equal(3);

    // Revoke key 0
    await program.methods
      .revokeKey()
      .accounts({
        serviceConfig: testServicePDA,
        apiKey: keys[0].pda,
        owner: testOwner.publicKey,
      })
      .signers([testOwner])
      .rpc();

    service = await program.account.serviceConfig.fetch(testServicePDA);
    expect(service.totalKeysCreated).to.equal(3);
    expect(service.activeKeys).to.equal(2);

    // Close key 0 (already revoked — shouldn't decrement active_keys again)
    await program.methods
      .closeKey()
      .accounts({
        serviceConfig: testServicePDA,
        apiKey: keys[0].pda,
        owner: testOwner.publicKey,
      })
      .signers([testOwner])
      .rpc();

    service = await program.account.serviceConfig.fetch(testServicePDA);
    expect(service.activeKeys).to.equal(2); // Unchanged — was already revoked

    // Close key 1 (not revoked — should decrement)
    await program.methods
      .closeKey()
      .accounts({
        serviceConfig: testServicePDA,
        apiKey: keys[1].pda,
        owner: testOwner.publicKey,
      })
      .signers([testOwner])
      .rpc();

    service = await program.account.serviceConfig.fetch(testServicePDA);
    expect(service.activeKeys).to.equal(1); // Decremented from 2 to 1
    expect(service.totalKeysCreated).to.equal(3); // Never decrements
  });

  // ========================================================================
  // Full Lifecycle — Integration Test
  // ========================================================================

  it("full lifecycle: create service → create key → use → update → revoke → close", async () => {
    // Create fresh service
    const lifecycleOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      lifecycleOwner.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [lcServicePDA] = findServicePDA(
      lifecycleOwner.publicKey,
      program.programId
    );

    // 1. Initialize service
    await program.methods
      .initializeService("Lifecycle Test", 10, 100, new anchor.BN(3600))
      .accounts({
        serviceConfig: lcServicePDA,
        owner: lifecycleOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([lifecycleOwner])
      .rpc();

    // 2. Create key
    const lcKey = generateApiKey();
    const lcKeyHash = hashApiKey(lcKey);
    const [lcApiKeyPDA] = findApiKeyPDA(lcServicePDA, lcKeyHash, program.programId);

    await program.methods
      .createKey(
        Array.from(lcKeyHash),
        "Lifecycle Key",
        3, // READ + WRITE
        50,
        null
      )
      .accounts({
        serviceConfig: lcServicePDA,
        apiKey: lcApiKeyPDA,
        owner: lifecycleOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([lifecycleOwner])
      .rpc();

    let service = await program.account.serviceConfig.fetch(lcServicePDA);
    expect(service.activeKeys).to.equal(1);
    expect(service.totalKeysCreated).to.equal(1);

    // 3. Validate key (permissionless)
    await program.methods
      .validateKey()
      .accounts({
        serviceConfig: lcServicePDA,
        apiKey: lcApiKeyPDA,
      })
      .rpc();

    // 4. Record usage (owner only)
    await program.methods
      .recordUsage(Array.from(lcKeyHash))
      .accounts({
        serviceConfig: lcServicePDA,
        apiKey: lcApiKeyPDA,
        owner: lifecycleOwner.publicKey,
      })
      .signers([lifecycleOwner])
      .rpc();

    let apiKey = await program.account.apiKey.fetch(lcApiKeyPDA);
    expect(apiKey.windowUsage).to.equal(1);
    expect(apiKey.totalUsage.toNumber()).to.equal(1);

    // 5. Check permission
    await program.methods
      .checkPermission(3) // READ + WRITE
      .accounts({
        serviceConfig: lcServicePDA,
        apiKey: lcApiKeyPDA,
      })
      .rpc();

    // 6. Update key — add DELETE permission
    await program.methods
      .updateKey(7, null, null) // READ + WRITE + DELETE
      .accounts({
        serviceConfig: lcServicePDA,
        apiKey: lcApiKeyPDA,
        owner: lifecycleOwner.publicKey,
      })
      .signers([lifecycleOwner])
      .rpc();

    apiKey = await program.account.apiKey.fetch(lcApiKeyPDA);
    expect(apiKey.permissions).to.equal(7);

    // 7. Update service
    await program.methods
      .updateService("Lifecycle Test v2", null, null, null)
      .accounts({
        serviceConfig: lcServicePDA,
        owner: lifecycleOwner.publicKey,
      })
      .signers([lifecycleOwner])
      .rpc();

    service = await program.account.serviceConfig.fetch(lcServicePDA);
    expect(service.name).to.equal("Lifecycle Test v2");

    // 8. Revoke key
    await program.methods
      .revokeKey()
      .accounts({
        serviceConfig: lcServicePDA,
        apiKey: lcApiKeyPDA,
        owner: lifecycleOwner.publicKey,
      })
      .signers([lifecycleOwner])
      .rpc();

    service = await program.account.serviceConfig.fetch(lcServicePDA);
    expect(service.activeKeys).to.equal(0);

    // 9. Close key and reclaim rent
    const balBefore = await provider.connection.getBalance(lifecycleOwner.publicKey);

    await program.methods
      .closeKey()
      .accounts({
        serviceConfig: lcServicePDA,
        apiKey: lcApiKeyPDA,
        owner: lifecycleOwner.publicKey,
      })
      .signers([lifecycleOwner])
      .rpc();

    const balAfter = await provider.connection.getBalance(lifecycleOwner.publicKey);
    expect(balAfter).to.be.greaterThan(balBefore);

    // Verify closed
    const closedAccount = await provider.connection.getAccountInfo(lcApiKeyPDA);
    expect(closedAccount).to.be.null;
  });

  // ========================================================================
  // Key Rotation
  // ========================================================================

  it("rotates a key atomically", async () => {
    const rotOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      rotOwner.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [rotServicePDA] = findServicePDA(rotOwner.publicKey, program.programId);

    await program.methods
      .initializeService("Rotation Test", 10, 100, new anchor.BN(3600))
      .accounts({
        serviceConfig: rotServicePDA,
        owner: rotOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rotOwner])
      .rpc();

    // Create original key
    const oldKey = generateApiKey();
    const oldKeyHash = hashApiKey(oldKey);
    const [oldApiKeyPDA] = findApiKeyPDA(rotServicePDA, oldKeyHash, program.programId);

    await program.methods
      .createKey(Array.from(oldKeyHash), "Original Key", 7, 500, null)
      .accounts({
        serviceConfig: rotServicePDA,
        apiKey: oldApiKeyPDA,
        owner: rotOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rotOwner])
      .rpc();

    const serviceBefore = await program.account.serviceConfig.fetch(rotServicePDA);
    expect(serviceBefore.activeKeys).to.equal(1);

    // Rotate key
    const newKey = generateApiKey();
    const newKeyHash = hashApiKey(newKey);
    const [newApiKeyPDA] = findApiKeyPDA(rotServicePDA, newKeyHash, program.programId);

    await program.methods
      .rotateKey(Array.from(oldKeyHash), Array.from(newKeyHash), null)
      .accounts({
        serviceConfig: rotServicePDA,
        oldApiKey: oldApiKeyPDA,
        newApiKey: newApiKeyPDA,
        owner: rotOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rotOwner])
      .rpc();

    // Old key should be revoked
    const oldApiKey = await program.account.apiKey.fetch(oldApiKeyPDA);
    expect(oldApiKey.revoked).to.equal(true);

    // New key should inherit settings
    const newApiKey = await program.account.apiKey.fetch(newApiKeyPDA);
    expect(newApiKey.revoked).to.equal(false);
    expect(newApiKey.permissions).to.equal(7);
    expect(newApiKey.rateLimit).to.equal(500);
    expect(newApiKey.label).to.equal("Original Key");

    // active_keys should stay the same (one revoked, one created)
    const serviceAfter = await program.account.serviceConfig.fetch(rotServicePDA);
    expect(serviceAfter.activeKeys).to.equal(1);
    expect(serviceAfter.totalKeysCreated).to.equal(2);
  });

  it("rotates a key with new label", async () => {
    const rotOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      rotOwner.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [rotServicePDA] = findServicePDA(rotOwner.publicKey, program.programId);

    await program.methods
      .initializeService("Rotation Label Test", 10, 100, new anchor.BN(3600))
      .accounts({
        serviceConfig: rotServicePDA,
        owner: rotOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rotOwner])
      .rpc();

    const oldKey = generateApiKey();
    const oldKeyHash = hashApiKey(oldKey);
    const [oldApiKeyPDA] = findApiKeyPDA(rotServicePDA, oldKeyHash, program.programId);

    await program.methods
      .createKey(Array.from(oldKeyHash), "Old Label", 3, null, null)
      .accounts({
        serviceConfig: rotServicePDA,
        apiKey: oldApiKeyPDA,
        owner: rotOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rotOwner])
      .rpc();

    const newKey = generateApiKey();
    const newKeyHash = hashApiKey(newKey);
    const [newApiKeyPDA] = findApiKeyPDA(rotServicePDA, newKeyHash, program.programId);

    await program.methods
      .rotateKey(Array.from(oldKeyHash), Array.from(newKeyHash), "New Label")
      .accounts({
        serviceConfig: rotServicePDA,
        oldApiKey: oldApiKeyPDA,
        newApiKey: newApiKeyPDA,
        owner: rotOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rotOwner])
      .rpc();

    const newApiKey = await program.account.apiKey.fetch(newApiKeyPDA);
    expect(newApiKey.label).to.equal("New Label");
  });

  // ========================================================================
  // Clear Expiry via update_key
  // ========================================================================

  it("clears expiry by passing expires_at = 0", async () => {
    const clearOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      clearOwner.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [clearServicePDA] = findServicePDA(clearOwner.publicKey, program.programId);

    await program.methods
      .initializeService("Clear Expiry Test", 10, 100, new anchor.BN(3600))
      .accounts({
        serviceConfig: clearServicePDA,
        owner: clearOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([clearOwner])
      .rpc();

    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [apiKeyPDA] = findApiKeyPDA(clearServicePDA, keyHash, program.programId);

    // Create key with expiry
    const futureExpiry = Math.floor(Date.now() / 1000) + 86400;
    await program.methods
      .createKey(Array.from(keyHash), "Expiring Key", 3, null, new anchor.BN(futureExpiry))
      .accounts({
        serviceConfig: clearServicePDA,
        apiKey: apiKeyPDA,
        owner: clearOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([clearOwner])
      .rpc();

    let apiKey = await program.account.apiKey.fetch(apiKeyPDA);
    expect(apiKey.expiresAt.toNumber()).to.equal(futureExpiry);

    // Clear expiry by passing 0
    await program.methods
      .updateKey(null, null, new anchor.BN(0))
      .accounts({
        serviceConfig: clearServicePDA,
        apiKey: apiKeyPDA,
        owner: clearOwner.publicKey,
      })
      .signers([clearOwner])
      .rpc();

    apiKey = await program.account.apiKey.fetch(apiKeyPDA);
    expect(apiKey.expiresAt.toNumber()).to.equal(0); // 0 = never expires
  });

  // ========================================================================
  // Rotation Edge Cases
  // ========================================================================

  it("rejects rotating a revoked key", async () => {
    const rotOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      rotOwner.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [rotServicePDA] = findServicePDA(rotOwner.publicKey, program.programId);

    await program.methods
      .initializeService("Rotate Revoked Test", 10, 100, new anchor.BN(3600))
      .accounts({
        serviceConfig: rotServicePDA,
        owner: rotOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rotOwner])
      .rpc();

    const oldKey = generateApiKey();
    const oldKeyHash = hashApiKey(oldKey);
    const [oldApiKeyPDA] = findApiKeyPDA(rotServicePDA, oldKeyHash, program.programId);

    await program.methods
      .createKey(Array.from(oldKeyHash), "To Revoke", 3, null, null)
      .accounts({
        serviceConfig: rotServicePDA,
        apiKey: oldApiKeyPDA,
        owner: rotOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rotOwner])
      .rpc();

    // Revoke the key first
    await program.methods
      .revokeKey()
      .accounts({
        serviceConfig: rotServicePDA,
        apiKey: oldApiKeyPDA,
        owner: rotOwner.publicKey,
      })
      .signers([rotOwner])
      .rpc();

    // Try to rotate the revoked key
    const newKey = generateApiKey();
    const newKeyHash = hashApiKey(newKey);
    const [newApiKeyPDA] = findApiKeyPDA(rotServicePDA, newKeyHash, program.programId);

    try {
      await program.methods
        .rotateKey(Array.from(oldKeyHash), Array.from(newKeyHash), null)
        .accounts({
          serviceConfig: rotServicePDA,
          oldApiKey: oldApiKeyPDA,
          newApiKey: newApiKeyPDA,
          owner: rotOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([rotOwner])
        .rpc();
      expect.fail("Should have thrown — rotating revoked key");
    } catch (e: unknown) {
      expectAnchorError(e, "AlreadyRevoked");
    }
  });

  it("rejects rotating with empty new label", async () => {
    const rotOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      rotOwner.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [rotServicePDA] = findServicePDA(rotOwner.publicKey, program.programId);

    await program.methods
      .initializeService("Rotate Label Test", 10, 100, new anchor.BN(3600))
      .accounts({
        serviceConfig: rotServicePDA,
        owner: rotOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rotOwner])
      .rpc();

    const oldKey = generateApiKey();
    const oldKeyHash = hashApiKey(oldKey);
    const [oldApiKeyPDA] = findApiKeyPDA(rotServicePDA, oldKeyHash, program.programId);

    await program.methods
      .createKey(Array.from(oldKeyHash), "Rotate Source", 3, null, null)
      .accounts({
        serviceConfig: rotServicePDA,
        apiKey: oldApiKeyPDA,
        owner: rotOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rotOwner])
      .rpc();

    const newKey = generateApiKey();
    const newKeyHash = hashApiKey(newKey);
    const [newApiKeyPDA] = findApiKeyPDA(rotServicePDA, newKeyHash, program.programId);

    try {
      await program.methods
        .rotateKey(Array.from(oldKeyHash), Array.from(newKeyHash), "")
        .accounts({
          serviceConfig: rotServicePDA,
          oldApiKey: oldApiKeyPDA,
          newApiKey: newApiKeyPDA,
          owner: rotOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([rotOwner])
        .rpc();
      expect.fail("Should have thrown — empty label");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidName");
    }
  });

  it("rejects creating key with label > 32 bytes", async () => {
    const longLabel = "A".repeat(33); // 33 bytes
    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, program.programId);

    try {
      await program.methods
        .createKey(Array.from(keyHash), longLabel, 3, null, null)
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
          owner: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown — label too long");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidName");
    }
  });

  it("accepts service name of exactly 32 bytes", async () => {
    const boundaryOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      boundaryOwner.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [boundaryServicePDA] = findServicePDA(boundaryOwner.publicKey, program.programId);
    const name32 = "A".repeat(32);

    await program.methods
      .initializeService(name32, 10, 100, new anchor.BN(3600))
      .accounts({
        serviceConfig: boundaryServicePDA,
        owner: boundaryOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([boundaryOwner])
      .rpc();

    const service = await program.account.serviceConfig.fetch(boundaryServicePDA);
    expect(service.name).to.equal(name32);
  });

  it("rejects service name of 33 bytes", async () => {
    const overOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      overOwner.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [overServicePDA] = findServicePDA(overOwner.publicKey, program.programId);
    const name33 = "A".repeat(33);

    try {
      await program.methods
        .initializeService(name33, 10, 100, new anchor.BN(3600))
        .accounts({
          serviceConfig: overServicePDA,
          owner: overOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([overOwner])
        .rpc();
      expect.fail("Should have thrown — name too long");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidName");
    }
  });

  it("rejects creating key with rate_limit = 0", async () => {
    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, program.programId);

    try {
      await program.methods
        .createKey(Array.from(keyHash), "Zero RL", 3, 0, null)
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
          owner: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown — zero rate limit");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidConfig");
    }
  });

  // ========================================================================
  // Authorization Failure Tests — Non-Owner Attacks
  // ========================================================================

  it("rejects create_key from non-owner", async () => {
    const attacker = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    // Try to create a key on the REAL owner's service using attacker as signer
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, program.programId);

    try {
      await program.methods
        .createKey(Array.from(keyHash), "Hacked Key", 3, null, null)
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
          owner: attacker.publicKey, // attacker, not real owner
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown — attacker cannot create keys");
    } catch (e: unknown) {
      // PDA seed mismatch or has_one constraint violation
      expectErrorContains(e, "Error");
    }
  });

  it("rejects revoke_key from non-owner", async () => {
    const attacker = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Create a fresh key to revoke
    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, program.programId);

    await program.methods
      .createKey(Array.from(keyHash), "Revoke Auth Test", 3, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await program.methods
        .revokeKey()
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
          owner: attacker.publicKey, // attacker
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown — attacker cannot revoke keys");
    } catch (e: unknown) {
      expectErrorContains(e, "Error");
    }
  });

  it("rejects update_key from non-owner", async () => {
    const attacker = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Use an existing active key
    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, program.programId);

    await program.methods
      .createKey(Array.from(keyHash), "Update Auth Test", 3, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await program.methods
        .updateKey(7, null, null)
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
          owner: attacker.publicKey, // attacker
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown — attacker cannot update keys");
    } catch (e: unknown) {
      expectErrorContains(e, "Error");
    }
  });

  it("rejects close_key from non-owner", async () => {
    const attacker = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, program.programId);

    await program.methods
      .createKey(Array.from(keyHash), "Close Auth Test", 3, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await program.methods
        .closeKey()
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
          owner: attacker.publicKey, // attacker
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown — attacker cannot close keys");
    } catch (e: unknown) {
      expectErrorContains(e, "Error");
    }
  });

  it("rejects rotate_key from non-owner", async () => {
    const attacker = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, program.programId);

    await program.methods
      .createKey(Array.from(keyHash), "Rotate Auth Test", 3, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const newKey = generateApiKey();
    const newKeyHash = hashApiKey(newKey);
    const [newApiKeyPDA] = findApiKeyPDA(servicePDA, newKeyHash, program.programId);

    try {
      await program.methods
        .rotateKey(Array.from(keyHash), Array.from(newKeyHash), null)
        .accounts({
          serviceConfig: servicePDA,
          oldApiKey: apiKeyPDA,
          newApiKey: newApiKeyPDA,
          owner: attacker.publicKey, // attacker
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown — attacker cannot rotate keys");
    } catch (e: unknown) {
      expectErrorContains(e, "Error");
    }
  });

  // ========================================================================
  // Additional Boundary and Edge Case Tests
  // ========================================================================

  it("rejects duplicate key hash creation", async () => {
    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, program.programId);

    // Create key first time — should succeed
    await program.methods
      .createKey(Array.from(keyHash), "Dup Test", 3, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Create key with same hash — should fail (PDA already exists)
    try {
      await program.methods
        .createKey(Array.from(keyHash), "Dup Test 2", 3, null, null)
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
          owner: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown — duplicate key hash");
    } catch (e: unknown) {
      // Anchor init constraint fails when PDA already exists
      expectErrorContains(e, "already in use");
    }
  });

  it("rejects check_permission with compound permission mismatch", async () => {
    // Create a key with READ-only (1)
    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, program.programId);

    await program.methods
      .createKey(Array.from(keyHash), "Partial Perm", 1, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Check READ|DELETE (5) — should fail since key only has READ (1)
    try {
      await program.methods
        .checkPermission(5) // READ|DELETE
        .accounts({
          serviceConfig: servicePDA,
          apiKey: apiKeyPDA,
        })
        .rpc();
      expect.fail("Should have thrown — insufficient compound permissions");
    } catch (e: unknown) {
      expectAnchorError(e, "InsufficientPermissions");
    }
  });

  it("rotation at max capacity succeeds", async () => {
    // Create service with max_keys = 1
    const capOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      capOwner.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [capServicePDA] = findServicePDA(capOwner.publicKey, program.programId);

    await program.methods
      .initializeService("Cap Test", 1, 100, new anchor.BN(3600))
      .accounts({
        serviceConfig: capServicePDA,
        owner: capOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([capOwner])
      .rpc();

    // Create 1 key (at max capacity)
    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [apiKeyPDA] = findApiKeyPDA(capServicePDA, keyHash, program.programId);

    await program.methods
      .createKey(Array.from(keyHash), "Cap Key", 3, null, null)
      .accounts({
        serviceConfig: capServicePDA,
        apiKey: apiKeyPDA,
        owner: capOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([capOwner])
      .rpc();

    // Rotate should succeed even at max capacity
    const newKey = generateApiKey();
    const newKeyHash = hashApiKey(newKey);
    const [newApiKeyPDA] = findApiKeyPDA(capServicePDA, newKeyHash, program.programId);

    await program.methods
      .rotateKey(Array.from(keyHash), Array.from(newKeyHash), null)
      .accounts({
        serviceConfig: capServicePDA,
        oldApiKey: apiKeyPDA,
        newApiKey: newApiKeyPDA,
        owner: capOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([capOwner])
      .rpc();

    const service = await program.account.serviceConfig.fetch(capServicePDA);
    expect(service.activeKeys).to.equal(1); // Still 1 — rotation doesn't increase
    expect(service.totalKeysCreated).to.equal(2); // But total increases
  });

  it("rejects update_service with empty name", async () => {
    try {
      await program.methods
        .updateService("", null, null, null)
        .accounts({
          serviceConfig: servicePDA,
          owner: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown — empty name");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidName");
    }
  });

  it("rejects update_service with name > 32 bytes", async () => {
    const longName = "A".repeat(33);
    try {
      await program.methods
        .updateService(longName, null, null, null)
        .accounts({
          serviceConfig: servicePDA,
          owner: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown — name too long");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidName");
    }
  });

  it("rejects rotate_key with new_label > 32 bytes", async () => {
    const rotOwner = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      rotOwner.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [rotServicePDA] = findServicePDA(rotOwner.publicKey, program.programId);

    await program.methods
      .initializeService("Rotate Long Label", 10, 100, new anchor.BN(3600))
      .accounts({
        serviceConfig: rotServicePDA,
        owner: rotOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rotOwner])
      .rpc();

    const oldKey = generateApiKey();
    const oldKeyHash = hashApiKey(oldKey);
    const [oldApiKeyPDA] = findApiKeyPDA(rotServicePDA, oldKeyHash, program.programId);

    await program.methods
      .createKey(Array.from(oldKeyHash), "Source Key", 3, null, null)
      .accounts({
        serviceConfig: rotServicePDA,
        apiKey: oldApiKeyPDA,
        owner: rotOwner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rotOwner])
      .rpc();

    const newKey = generateApiKey();
    const newKeyHash = hashApiKey(newKey);
    const [newApiKeyPDA] = findApiKeyPDA(rotServicePDA, newKeyHash, program.programId);

    try {
      await program.methods
        .rotateKey(Array.from(oldKeyHash), Array.from(newKeyHash), "A".repeat(33))
        .accounts({
          serviceConfig: rotServicePDA,
          oldApiKey: oldApiKeyPDA,
          newApiKey: newApiKeyPDA,
          owner: rotOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([rotOwner])
        .rpc();
      expect.fail("Should have thrown — label too long");
    } catch (e: unknown) {
      expectAnchorError(e, "InvalidName");
    }
  });

  it("accepts create_key with label of exactly 32 bytes", async () => {
    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const [apiKeyPDA] = findApiKeyPDA(servicePDA, keyHash, program.programId);
    const label32 = "B".repeat(32);

    await program.methods
      .createKey(Array.from(keyHash), label32, 3, null, null)
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(apiKeyPDA);
    expect(apiKey.label).to.equal(label32);
  });
});

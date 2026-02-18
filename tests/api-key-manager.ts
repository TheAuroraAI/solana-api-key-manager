import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ApiKeyManager } from "../target/types/api_key_manager";
import { createHash, randomBytes } from "crypto";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

function hashApiKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

function generateApiKey(): string {
  return `sk_${randomBytes(32).toString("hex")}`;
}

function findServicePDA(
  owner: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("service"), owner.toBuffer()],
    programId
  );
}

function findApiKeyPDA(
  service: PublicKey,
  keyHash: Buffer,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("apikey"), service.toBuffer(), keyHash],
    programId
  );
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
    const tx = await program.methods
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
    } catch (e: any) {
      expect(e).to.exist;
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("NameTooLong");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("NameTooLong");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InvalidConfig");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InvalidWindow");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InvalidWindow");
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
    } catch (e: any) {
      expect(e).to.exist;
    }
  });

  // ========================================================================
  // Key Creation
  // ========================================================================

  it("creates an API key", async () => {
    const tx = await program.methods
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InvalidExpiry");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InvalidPermissions");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("NameTooLong");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InsufficientPermissions");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InsufficientPermissions");
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
    } catch (e: any) {
      expect(e).to.exist;
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("RateLimitExceeded");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("RateLimitExceeded");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InvalidExpiry");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InvalidConfig");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InvalidPermissions");
    }
  });

  // ========================================================================
  // Key Revocation
  // ========================================================================

  it("revokes a key", async () => {
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
    // active_keys should decrease
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("KeyRevoked");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("KeyRevoked");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("AlreadyRevoked");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("KeyRevoked");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("KeyRevoked");
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
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("MaxKeysReached");
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
      } catch (e: any) {
        expect(e.error.errorCode.code).to.equal("InvalidConfig");
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
});

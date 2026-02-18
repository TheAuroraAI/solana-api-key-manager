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
  });

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
    expect(apiKey.rateLimit).to.equal(1000);
    expect(apiKey.revoked).to.equal(false);
    expect(apiKey.totalUsage.toNumber()).to.equal(0);

    // Check service updated
    const service = await program.account.serviceConfig.fetch(servicePDA);
    expect(service.totalKeysCreated).to.equal(1);
    expect(service.activeKeys).to.equal(1);
  });

  it("validates a key", async () => {
    await program.methods
      .validateKey()
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
      })
      .rpc();
  });

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

  it("updates key permissions", async () => {
    await program.methods
      .updateKey(
        7, // READ + WRITE + DELETE
        2000, // new rate limit
        null // no expiry change
      )
      .accounts({
        serviceConfig: servicePDA,
        apiKey: apiKeyPDA,
        owner: owner.publicKey,
      })
      .rpc();

    const apiKey = await program.account.apiKey.fetch(apiKeyPDA);
    expect(apiKey.permissions).to.equal(7);
    expect(apiKey.rateLimit).to.equal(2000);
  });

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
    expect(service.activeKeys).to.equal(0);
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

  it("creates a key with expiry", async () => {
    const key2 = generateApiKey();
    const keyHash2 = hashApiKey(key2);
    const [apiKeyPDA2] = findApiKeyPDA(
      servicePDA,
      keyHash2,
      program.programId
    );

    const futureTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

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

  it("closes a key and reclaims rent", async () => {
    const key3 = generateApiKey();
    const keyHash3 = hashApiKey(key3);
    const [apiKeyPDA3] = findApiKeyPDA(
      servicePDA,
      keyHash3,
      program.programId
    );

    // Create key
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

    // Close key
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

    // Verify account is closed
    const account = await provider.connection.getAccountInfo(apiKeyPDA3);
    expect(account).to.be.null;
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
      // Expected — PDA already initialized
      expect(e).to.exist;
    }
  });

  it("rejects creation with invalid window", async () => {
    // Need a different owner for a new service
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

  it("rejects key creation with past expiry", async () => {
    const keyPast = generateApiKey();
    const keyHashPast = hashApiKey(keyPast);
    const [apiKeyPDAPast] = findApiKeyPDA(
      servicePDA,
      keyHashPast,
      program.programId
    );

    const pastTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

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

  it("rejects update with zero rate limit", async () => {
    // Create a fresh key for this test
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

  it("rejects unauthorized usage recording", async () => {
    // Create a fresh key
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

    // Try to record usage as a non-owner
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
      // Should fail due to has_one = owner constraint or PDA seed mismatch
      expect(e).to.exist;
    }
  });

  it("enforces rate limits", async () => {
    // Create a key with very low rate limit (3 per window)
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

    // Verify counts
    const apiKey = await program.account.apiKey.fetch(apiKeyPDARL);
    expect(apiKey.windowUsage).to.equal(3);
    expect(apiKey.totalUsage.toNumber()).to.equal(3);
  });

  it("validates key returns remaining usage info", async () => {
    // Create a key and use it partially
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

    // Record 3 usages
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

  it("enforces max_keys limit", async () => {
    // Create a service with max_keys = 2
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

  it("validates all permission bitmask values", async () => {
    // Create key with ADMIN permission (8) and full permissions (15)
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
  });

  it("close key decrements active_keys for non-revoked key", async () => {
    // Create a key, then close it without revoking first
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

    // Close without revoking
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

  it("rejects validate_key on revoked key", async () => {
    // apiKeyPDA was revoked earlier in the test suite
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

  it("update key with new expiry", async () => {
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

  it("supports all three window durations", async () => {
    // Create services with each window type to verify they're accepted
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
});

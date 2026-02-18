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
          caller: owner.publicKey,
          service: servicePDA,
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
          caller: owner.publicKey,
          service: servicePDA,
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
});

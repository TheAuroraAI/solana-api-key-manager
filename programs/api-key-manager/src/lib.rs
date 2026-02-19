//! # On-Chain API Key Manager
//!
//! A Solana program that implements API key management — the same pattern used by
//! Stripe, OpenAI, AWS, and every SaaS platform — entirely on-chain.
//!
//! ## Architecture
//!
//! - **ServiceConfig PDA** `[b"service", owner]`: One per wallet. Stores service name,
//!   key limits, rate limit defaults. The service owner manages all keys.
//!
//! - **ApiKey PDA** `[b"apikey", service, key_hash]`: One per API key. Stores the
//!   SHA-256 hash (never the raw key), permissions bitmask, rate limit counters,
//!   expiry timestamp, and revocation status.
//!
//! ## Trust Model
//!
//! Unlike Web2 where the operator controls the database and can silently modify keys,
//! all state here is publicly verifiable. Users can independently check their key's
//! configuration, permissions, usage, and rate limit status on-chain.
//!
//! ## Key Design Decisions
//!
//! 1. Raw API keys never touch the chain — only SHA-256 hashes are stored
//! 2. Permission bitmask (`u16`) for compact, composable access control
//! 3. Fixed-window rate limiting (60s/3600s/86400s) — no micro-windows
//! 4. Owner-gated `record_usage` prevents usage griefing attacks
//! 5. One service per wallet (PDA seeded by owner pubkey)
//! 6. `validate_key` and `check_permission` are free via RPC simulation

use anchor_lang::prelude::*;

declare_id!("7uXfzJUYdVT3sENNzNcUPk7upa3RUzjB8weCBEeFQt58");

/// Permission bits for API keys.
/// Uses a bitmask for composable permissions in a single u16 field.
/// Mirrors Unix permission model — each bit enables one capability.
pub mod permissions {
    pub const READ: u16 = 1 << 0;   // 0b0001 — Can read resources
    pub const WRITE: u16 = 1 << 1;  // 0b0010 — Can create/update resources
    pub const DELETE: u16 = 1 << 2; // 0b0100 — Can delete resources
    pub const ADMIN: u16 = 1 << 3;  // 0b1000 — Can manage other keys

    /// All valid permission bits ORed together
    pub const ALL: u16 = READ | WRITE | DELETE | ADMIN;

    /// Check if a permission mask is valid (no bits set outside defined range)
    pub fn is_valid(mask: u16) -> bool {
        mask & !ALL == 0
    }
}

/// Rate limit window durations in seconds.
/// Fixed windows prevent abuse via micro-windows that could bypass rate limits.
pub mod windows {
    pub const ONE_MINUTE: i64 = 60;
    pub const ONE_HOUR: i64 = 3600;
    pub const ONE_DAY: i64 = 86400;

    pub fn is_valid(window: i64) -> bool {
        window == ONE_MINUTE || window == ONE_HOUR || window == ONE_DAY
    }
}

#[program]
pub mod api_key_manager {
    use super::*;

    /// Initialize a new API service. Creates a ServiceConfig PDA owned by the caller.
    /// Each wallet can own one service (PDA seeded by owner pubkey).
    pub fn initialize_service(
        ctx: Context<InitializeService>,
        name: String,
        max_keys: u32,
        default_rate_limit: u32,
        rate_limit_window: i64,
    ) -> Result<()> {
        require!(name.len() > 0 && name.len() <= 32, ApiKeyError::InvalidName);
        require!(max_keys > 0 && max_keys <= 10_000, ApiKeyError::InvalidConfig);
        require!(default_rate_limit > 0, ApiKeyError::InvalidConfig);
        require!(windows::is_valid(rate_limit_window), ApiKeyError::InvalidWindow);

        let service = &mut ctx.accounts.service_config;
        service.owner = ctx.accounts.owner.key();
        service.name = name;
        service.max_keys = max_keys;
        service.default_rate_limit = default_rate_limit;
        service.rate_limit_window = rate_limit_window;
        service.total_keys_created = 0;
        service.active_keys = 0;
        service.created_at = Clock::get()?.unix_timestamp;
        service.bump = ctx.bumps.service_config;

        emit!(ServiceCreated {
            service: service.key(),
            owner: service.owner,
            name: service.name.clone(),
            max_keys,
            rate_limit_window,
        });

        Ok(())
    }

    /// Update service configuration. Only the service owner can modify.
    /// Allows changing name, max_keys, default_rate_limit, and window without
    /// redeploying. Existing keys keep their current settings.
    pub fn update_service(
        ctx: Context<UpdateService>,
        name: Option<String>,
        max_keys: Option<u32>,
        default_rate_limit: Option<u32>,
        rate_limit_window: Option<i64>,
    ) -> Result<()> {
        let service = &mut ctx.accounts.service_config;

        if let Some(n) = name {
            require!(n.len() > 0 && n.len() <= 32, ApiKeyError::InvalidName);
            service.name = n;
        }
        if let Some(mk) = max_keys {
            require!(mk > 0 && mk <= 10_000, ApiKeyError::InvalidConfig);
            require!(mk >= service.active_keys, ApiKeyError::InvalidConfig);
            service.max_keys = mk;
        }
        if let Some(drl) = default_rate_limit {
            require!(drl > 0, ApiKeyError::InvalidConfig);
            service.default_rate_limit = drl;
        }
        if let Some(w) = rate_limit_window {
            require!(windows::is_valid(w), ApiKeyError::InvalidWindow);
            service.rate_limit_window = w;
        }

        emit!(ServiceUpdated {
            service: service.key(),
            name: service.name.clone(),
            max_keys: service.max_keys,
            default_rate_limit: service.default_rate_limit,
            rate_limit_window: service.rate_limit_window,
        });

        Ok(())
    }

    /// Create a new API key for a service. Only the service owner can create keys.
    /// The `key_hash` is a SHA-256 hash of the actual API key (kept off-chain).
    /// The raw key is generated client-side, shown to the user once, then discarded.
    pub fn create_key(
        ctx: Context<CreateKey>,
        key_hash: [u8; 32],
        label: String,
        permissions_mask: u16,
        rate_limit: Option<u32>,
        expires_at: Option<i64>,
    ) -> Result<()> {
        require!(label.len() > 0 && label.len() <= 32, ApiKeyError::InvalidName);
        require!(permissions::is_valid(permissions_mask), ApiKeyError::InvalidPermissions);

        let service = &mut ctx.accounts.service_config;
        require!(
            service.active_keys < service.max_keys,
            ApiKeyError::MaxKeysReached
        );

        let clock = Clock::get()?;
        if let Some(exp) = expires_at {
            require!(exp > clock.unix_timestamp, ApiKeyError::InvalidExpiry);
        }

        let effective_rate_limit = rate_limit.unwrap_or(service.default_rate_limit);
        require!(effective_rate_limit > 0, ApiKeyError::InvalidConfig);

        let api_key = &mut ctx.accounts.api_key;
        api_key.service = service.key();
        api_key.key_hash = key_hash;
        api_key.label = label;
        api_key.permissions = permissions_mask;
        api_key.rate_limit = effective_rate_limit;
        api_key.rate_limit_window = service.rate_limit_window;
        api_key.window_start = clock.unix_timestamp;
        api_key.window_usage = 0;
        api_key.total_usage = 0;
        api_key.created_at = clock.unix_timestamp;
        api_key.last_used_at = 0;
        api_key.expires_at = expires_at.unwrap_or(0); // 0 = never expires
        api_key.revoked = false;
        api_key.bump = ctx.bumps.api_key;

        service.total_keys_created = service
            .total_keys_created
            .checked_add(1)
            .ok_or(ApiKeyError::Overflow)?;
        service.active_keys = service
            .active_keys
            .checked_add(1)
            .ok_or(ApiKeyError::Overflow)?;

        emit!(KeyCreated {
            service: service.key(),
            key_hash,
            label: api_key.label.clone(),
            permissions: permissions_mask,
            rate_limit: api_key.rate_limit,
            expires_at: api_key.expires_at,
        });

        Ok(())
    }

    /// Record a usage event for an API key. Validates the key is active and within rate limits.
    /// This is the core "middleware" equivalent — call this when an API request is made.
    /// Only the service owner can record usage (prevents griefing by unauthorized callers).
    pub fn record_usage(ctx: Context<RecordUsage>, key_hash: [u8; 32]) -> Result<()> {
        let api_key = &mut ctx.accounts.api_key;

        // Check key is not revoked
        require!(!api_key.revoked, ApiKeyError::KeyRevoked);

        // Check expiry
        let clock = Clock::get()?;
        if api_key.expires_at > 0 {
            require!(
                clock.unix_timestamp < api_key.expires_at,
                ApiKeyError::KeyExpired
            );
        }

        // Check rate limit window — reset if window has passed
        let window_elapsed = clock
            .unix_timestamp
            .saturating_sub(api_key.window_start);
        if window_elapsed >= api_key.rate_limit_window {
            // New window
            api_key.window_start = clock.unix_timestamp;
            api_key.window_usage = 0;
        }

        // Check rate limit
        require!(
            api_key.window_usage < api_key.rate_limit,
            ApiKeyError::RateLimitExceeded
        );

        // Record usage with checked arithmetic
        api_key.window_usage = api_key
            .window_usage
            .checked_add(1)
            .ok_or(ApiKeyError::Overflow)?;
        api_key.total_usage = api_key
            .total_usage
            .checked_add(1)
            .ok_or(ApiKeyError::Overflow)?;
        api_key.last_used_at = clock.unix_timestamp;

        emit!(UsageRecorded {
            service: api_key.service,
            key_hash,
            window_usage: api_key.window_usage,
            total_usage: api_key.total_usage,
        });

        Ok(())
    }

    /// Validate a key without recording usage. Returns success if key is valid, errors otherwise.
    /// This is a read-only check — anyone can call it. No transaction fee needed if called
    /// via simulation (RPC `simulateTransaction`).
    pub fn validate_key(ctx: Context<ValidateKey>) -> Result<()> {
        let api_key = &ctx.accounts.api_key;

        require!(!api_key.revoked, ApiKeyError::KeyRevoked);

        let clock = Clock::get()?;
        if api_key.expires_at > 0 {
            require!(
                clock.unix_timestamp < api_key.expires_at,
                ApiKeyError::KeyExpired
            );
        }

        // Check current window usage
        let window_elapsed = clock.unix_timestamp.saturating_sub(api_key.window_start);
        let current_usage = if window_elapsed >= api_key.rate_limit_window {
            0 // Would be reset on next record_usage
        } else {
            api_key.window_usage
        };

        require!(
            current_usage < api_key.rate_limit,
            ApiKeyError::RateLimitExceeded
        );

        emit!(KeyValidated {
            service: api_key.service,
            key_hash: api_key.key_hash,
            permissions: api_key.permissions,
            remaining_usage: api_key.rate_limit.saturating_sub(current_usage),
        });

        Ok(())
    }

    /// Check if a key has a specific permission. Emits a result event.
    /// Useful for fine-grained authorization checks without reading the full account client-side.
    /// Note: This checks revocation, expiry, and permissions but NOT rate limits.
    /// Use `validate_key` + `record_usage` for rate-limit-aware validation.
    pub fn check_permission(ctx: Context<ValidateKey>, required_permission: u16) -> Result<()> {
        let api_key = &ctx.accounts.api_key;

        require!(!api_key.revoked, ApiKeyError::KeyRevoked);

        let clock = Clock::get()?;
        if api_key.expires_at > 0 {
            require!(
                clock.unix_timestamp < api_key.expires_at,
                ApiKeyError::KeyExpired
            );
        }

        require!(
            api_key.permissions & required_permission == required_permission,
            ApiKeyError::InsufficientPermissions
        );

        emit!(PermissionChecked {
            service: api_key.service,
            key_hash: api_key.key_hash,
            required: required_permission,
            granted: true,
        });

        Ok(())
    }

    /// Revoke an API key. Only the service owner can revoke keys.
    /// This is a soft-disable — the key account still exists but usage is rejected.
    pub fn revoke_key(ctx: Context<RevokeKey>) -> Result<()> {
        let api_key = &mut ctx.accounts.api_key;
        require!(!api_key.revoked, ApiKeyError::AlreadyRevoked);

        api_key.revoked = true;

        let service = &mut ctx.accounts.service_config;
        service.active_keys = service
            .active_keys
            .checked_sub(1)
            .ok_or(ApiKeyError::Overflow)?;

        emit!(KeyRevoked {
            service: service.key(),
            key_hash: api_key.key_hash,
            total_usage: api_key.total_usage,
        });

        Ok(())
    }

    /// Update permissions, rate limit, or expiry for an existing key.
    /// Only the service owner can modify key properties.
    pub fn update_key(
        ctx: Context<UpdateKey>,
        permissions_mask: Option<u16>,
        rate_limit: Option<u32>,
        expires_at: Option<i64>,
    ) -> Result<()> {
        let api_key = &mut ctx.accounts.api_key;
        require!(!api_key.revoked, ApiKeyError::KeyRevoked);

        if let Some(perms) = permissions_mask {
            require!(permissions::is_valid(perms), ApiKeyError::InvalidPermissions);
            api_key.permissions = perms;
        }
        if let Some(limit) = rate_limit {
            require!(limit > 0, ApiKeyError::InvalidConfig);
            api_key.rate_limit = limit;
        }
        if let Some(exp) = expires_at {
            if exp == 0 {
                // Special case: 0 clears the expiry (key becomes non-expiring)
                api_key.expires_at = 0;
            } else {
                let clock = Clock::get()?;
                require!(exp > clock.unix_timestamp, ApiKeyError::InvalidExpiry);
                api_key.expires_at = exp;
            }
        }

        emit!(KeyUpdated {
            service: api_key.service,
            key_hash: api_key.key_hash,
            permissions: api_key.permissions,
            rate_limit: api_key.rate_limit,
            expires_at: api_key.expires_at,
        });

        Ok(())
    }

    /// Atomically rotate an API key: revoke the old key and create a new one in a single
    /// transaction. Preserves the label, permissions, rate limit, and expiry from the old key.
    /// This ensures zero-downtime key rotation with no window where both keys are active.
    pub fn rotate_key(
        ctx: Context<RotateKey>,
        _old_key_hash: [u8; 32],
        new_key_hash: [u8; 32],
        new_label: Option<String>,
    ) -> Result<()> {
        let old_key = &mut ctx.accounts.old_api_key;
        require!(!old_key.revoked, ApiKeyError::AlreadyRevoked);

        // Revoke old key
        old_key.revoked = true;

        // Create new key inheriting old key's settings
        let clock = Clock::get()?;
        let new_key = &mut ctx.accounts.new_api_key;
        new_key.service = old_key.service;
        new_key.key_hash = new_key_hash;
        new_key.label = if let Some(label) = new_label {
            require!(label.len() > 0 && label.len() <= 32, ApiKeyError::InvalidName);
            label
        } else {
            old_key.label.clone()
        };
        new_key.permissions = old_key.permissions;
        new_key.rate_limit = old_key.rate_limit;
        new_key.rate_limit_window = old_key.rate_limit_window;
        new_key.window_start = clock.unix_timestamp;
        new_key.window_usage = 0;
        new_key.total_usage = 0;
        new_key.created_at = clock.unix_timestamp;
        new_key.last_used_at = 0;
        new_key.expires_at = old_key.expires_at;
        new_key.revoked = false;
        new_key.bump = ctx.bumps.new_api_key;

        // total_keys_created increments, active_keys stays the same (one revoked, one created)
        let service = &mut ctx.accounts.service_config;
        service.total_keys_created = service
            .total_keys_created
            .checked_add(1)
            .ok_or(ApiKeyError::Overflow)?;

        emit!(KeyRevoked {
            service: service.key(),
            key_hash: old_key.key_hash,
            total_usage: old_key.total_usage,
        });
        emit!(KeyCreated {
            service: service.key(),
            key_hash: new_key_hash,
            label: new_key.label.clone(),
            permissions: new_key.permissions,
            rate_limit: new_key.rate_limit,
            expires_at: new_key.expires_at,
        });

        Ok(())
    }

    /// Close an API key account and reclaim rent. Only the service owner can close keys.
    /// The account's rent-exempt balance is returned to the owner's wallet.
    /// This is a hard delete — the key cannot be recovered after closing.
    pub fn close_key(ctx: Context<CloseKey>) -> Result<()> {
        let service = &mut ctx.accounts.service_config;
        let api_key = &ctx.accounts.api_key;

        if !api_key.revoked {
            service.active_keys = service
                .active_keys
                .checked_sub(1)
                .ok_or(ApiKeyError::Overflow)?;
        }

        emit!(KeyClosed {
            service: service.key(),
            key_hash: api_key.key_hash,
            total_usage: api_key.total_usage,
        });

        Ok(())
    }

}

// ============================================================================
// Account structs
// ============================================================================

#[account]
#[derive(InitSpace)]
pub struct ServiceConfig {
    /// The wallet that owns this service and can manage keys
    pub owner: Pubkey,
    /// Human-readable service name (max 32 chars)
    #[max_len(32)]
    pub name: String,
    /// Maximum number of active API keys allowed
    pub max_keys: u32,
    /// Default rate limit for new keys (requests per window)
    pub default_rate_limit: u32,
    /// Rate limit window in seconds (60, 3600, or 86400)
    pub rate_limit_window: i64,
    /// Total keys ever created (monotonic counter)
    pub total_keys_created: u32,
    /// Currently active (non-revoked, non-closed) keys
    pub active_keys: u32,
    /// Unix timestamp when service was created
    pub created_at: i64,
    /// PDA bump seed
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ApiKey {
    /// The service this key belongs to
    pub service: Pubkey,
    /// SHA-256 hash of the actual API key (raw key never stored on-chain)
    pub key_hash: [u8; 32],
    /// Human-readable label for this key (max 32 chars)
    #[max_len(32)]
    pub label: String,
    /// Permission bitmask (READ=1, WRITE=2, DELETE=4, ADMIN=8)
    pub permissions: u16,
    /// Maximum requests allowed per window
    pub rate_limit: u32,
    /// Rate limit window in seconds
    pub rate_limit_window: i64,
    /// Usage count in current window
    pub window_usage: u32,
    /// Timestamp when current rate limit window started
    pub window_start: i64,
    /// Total usage across all time
    pub total_usage: u64,
    /// Unix timestamp when key was created
    pub created_at: i64,
    /// Unix timestamp of most recent usage (0 = never used)
    pub last_used_at: i64,
    /// Unix timestamp when key expires (0 = never)
    pub expires_at: i64,
    /// Whether this key has been revoked
    pub revoked: bool,
    /// PDA bump seed
    pub bump: u8,
}

// ============================================================================
// Instruction account contexts
// ============================================================================

#[derive(Accounts)]
pub struct InitializeService<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + ServiceConfig::INIT_SPACE,
        seeds = [b"service", owner.key().as_ref()],
        bump
    )]
    pub service_config: Account<'info, ServiceConfig>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateService<'info> {
    #[account(
        mut,
        seeds = [b"service", owner.key().as_ref()],
        bump = service_config.bump,
        has_one = owner
    )]
    pub service_config: Account<'info, ServiceConfig>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(key_hash: [u8; 32])]
pub struct CreateKey<'info> {
    #[account(
        mut,
        seeds = [b"service", owner.key().as_ref()],
        bump = service_config.bump,
        has_one = owner
    )]
    pub service_config: Account<'info, ServiceConfig>,
    #[account(
        init,
        payer = owner,
        space = 8 + ApiKey::INIT_SPACE,
        seeds = [b"apikey", service_config.key().as_ref(), &key_hash],
        bump
    )]
    pub api_key: Account<'info, ApiKey>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(key_hash: [u8; 32])]
pub struct RecordUsage<'info> {
    #[account(
        seeds = [b"service", owner.key().as_ref()],
        bump = service_config.bump,
        has_one = owner
    )]
    pub service_config: Account<'info, ServiceConfig>,
    #[account(
        mut,
        seeds = [b"apikey", service_config.key().as_ref(), &key_hash],
        bump = api_key.bump,
    )]
    pub api_key: Account<'info, ApiKey>,
    /// Only the service owner can record usage (prevents griefing)
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct ValidateKey<'info> {
    #[account(
        seeds = [b"service", service_config.owner.as_ref()],
        bump = service_config.bump
    )]
    pub service_config: Account<'info, ServiceConfig>,
    #[account(
        seeds = [b"apikey", service_config.key().as_ref(), &api_key.key_hash],
        bump = api_key.bump
    )]
    pub api_key: Account<'info, ApiKey>,
}

#[derive(Accounts)]
pub struct RevokeKey<'info> {
    #[account(
        mut,
        seeds = [b"service", owner.key().as_ref()],
        bump = service_config.bump,
        has_one = owner
    )]
    pub service_config: Account<'info, ServiceConfig>,
    #[account(
        mut,
        seeds = [b"apikey", service_config.key().as_ref(), &api_key.key_hash],
        bump = api_key.bump
    )]
    pub api_key: Account<'info, ApiKey>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateKey<'info> {
    #[account(
        seeds = [b"service", owner.key().as_ref()],
        bump = service_config.bump,
        has_one = owner
    )]
    pub service_config: Account<'info, ServiceConfig>,
    #[account(
        mut,
        seeds = [b"apikey", service_config.key().as_ref(), &api_key.key_hash],
        bump = api_key.bump
    )]
    pub api_key: Account<'info, ApiKey>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(old_key_hash: [u8; 32], new_key_hash: [u8; 32])]
pub struct RotateKey<'info> {
    #[account(
        mut,
        seeds = [b"service", owner.key().as_ref()],
        bump = service_config.bump,
        has_one = owner
    )]
    pub service_config: Account<'info, ServiceConfig>,
    #[account(
        mut,
        seeds = [b"apikey", service_config.key().as_ref(), &old_key_hash],
        bump = old_api_key.bump
    )]
    pub old_api_key: Account<'info, ApiKey>,
    #[account(
        init,
        payer = owner,
        space = 8 + ApiKey::INIT_SPACE,
        seeds = [b"apikey", service_config.key().as_ref(), &new_key_hash],
        bump
    )]
    pub new_api_key: Account<'info, ApiKey>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseKey<'info> {
    #[account(
        mut,
        seeds = [b"service", owner.key().as_ref()],
        bump = service_config.bump,
        has_one = owner
    )]
    pub service_config: Account<'info, ServiceConfig>,
    #[account(
        mut,
        seeds = [b"apikey", service_config.key().as_ref(), &api_key.key_hash],
        bump = api_key.bump,
        close = owner
    )]
    pub api_key: Account<'info, ApiKey>,
    #[account(mut)]
    pub owner: Signer<'info>,
}


// ============================================================================
// Events — emitted for off-chain indexing (Helius, Shyft, geyser plugins)
// ============================================================================

#[event]
pub struct ServiceCreated {
    pub service: Pubkey,
    pub owner: Pubkey,
    pub name: String,
    pub max_keys: u32,
    pub rate_limit_window: i64,
}

#[event]
pub struct ServiceUpdated {
    pub service: Pubkey,
    pub name: String,
    pub max_keys: u32,
    pub default_rate_limit: u32,
    pub rate_limit_window: i64,
}

#[event]
pub struct KeyCreated {
    pub service: Pubkey,
    pub key_hash: [u8; 32],
    pub label: String,
    pub permissions: u16,
    pub rate_limit: u32,
    pub expires_at: i64,
}

#[event]
pub struct UsageRecorded {
    pub service: Pubkey,
    pub key_hash: [u8; 32],
    pub window_usage: u32,
    pub total_usage: u64,
}

#[event]
pub struct KeyValidated {
    pub service: Pubkey,
    pub key_hash: [u8; 32],
    pub permissions: u16,
    pub remaining_usage: u32,
}

#[event]
pub struct PermissionChecked {
    pub service: Pubkey,
    pub key_hash: [u8; 32],
    pub required: u16,
    pub granted: bool,
}

#[event]
pub struct KeyRevoked {
    pub service: Pubkey,
    pub key_hash: [u8; 32],
    pub total_usage: u64,
}

#[event]
pub struct KeyUpdated {
    pub service: Pubkey,
    pub key_hash: [u8; 32],
    pub permissions: u16,
    pub rate_limit: u32,
    pub expires_at: i64,
}

#[event]
pub struct KeyClosed {
    pub service: Pubkey,
    pub key_hash: [u8; 32],
    pub total_usage: u64,
}


// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum ApiKeyError {
    #[msg("Name must be 1-32 characters")]
    InvalidName,
    #[msg("Invalid configuration value")]
    InvalidConfig,
    #[msg("Rate limit window must be 60, 3600, or 86400 seconds")]
    InvalidWindow,
    #[msg("Maximum number of API keys reached")]
    MaxKeysReached,
    #[msg("API key has been revoked")]
    KeyRevoked,
    #[msg("API key has expired")]
    KeyExpired,
    #[msg("Rate limit exceeded for current window")]
    RateLimitExceeded,
    #[msg("Invalid expiry timestamp (must be in the future)")]
    InvalidExpiry,
    #[msg("Key is already revoked")]
    AlreadyRevoked,
    #[msg("Invalid service account")]
    InvalidService,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Permission bitmask contains invalid bits")]
    InvalidPermissions,
    #[msg("Key does not have the required permission")]
    InsufficientPermissions,
}

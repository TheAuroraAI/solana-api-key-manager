use anchor_lang::prelude::*;

declare_id!("v73KoPncjCfhWRkf2QPag15NcFx3oMsRevYtYoGReju");

/// Permission bits for API keys
pub mod permissions {
    pub const READ: u16 = 1 << 0;
    pub const WRITE: u16 = 1 << 1;
    pub const DELETE: u16 = 1 << 2;
    pub const ADMIN: u16 = 1 << 3;
}

/// Rate limit window durations in seconds
pub mod windows {
    pub const ONE_MINUTE: i64 = 60;
    pub const ONE_HOUR: i64 = 3600;
    pub const ONE_DAY: i64 = 86400;
}

#[program]
pub mod api_key_manager {
    use super::*;

    /// Initialize a new API service. Creates a ServiceConfig PDA owned by the caller.
    pub fn initialize_service(
        ctx: Context<InitializeService>,
        name: String,
        max_keys: u32,
        default_rate_limit: u32,
        rate_limit_window: i64,
    ) -> Result<()> {
        require!(name.len() <= 32, ApiKeyError::NameTooLong);
        require!(max_keys > 0, ApiKeyError::InvalidConfig);
        require!(default_rate_limit > 0, ApiKeyError::InvalidConfig);
        require!(
            rate_limit_window == windows::ONE_MINUTE
                || rate_limit_window == windows::ONE_HOUR
                || rate_limit_window == windows::ONE_DAY,
            ApiKeyError::InvalidWindow
        );

        let service = &mut ctx.accounts.service_config;
        service.owner = ctx.accounts.owner.key();
        service.name = name;
        service.max_keys = max_keys;
        service.default_rate_limit = default_rate_limit;
        service.rate_limit_window = rate_limit_window;
        service.total_keys_created = 0;
        service.active_keys = 0;
        service.bump = ctx.bumps.service_config;

        emit!(ServiceCreated {
            service: service.key(),
            owner: service.owner,
            name: service.name.clone(),
        });

        Ok(())
    }

    /// Create a new API key for a service. Only the service owner can create keys.
    /// The `key_hash` is a SHA-256 hash of the actual API key (kept off-chain).
    pub fn create_key(
        ctx: Context<CreateKey>,
        key_hash: [u8; 32],
        label: String,
        permissions_mask: u16,
        rate_limit: Option<u32>,
        expires_at: Option<i64>,
    ) -> Result<()> {
        require!(label.len() <= 32, ApiKeyError::NameTooLong);

        let service = &mut ctx.accounts.service_config;
        require!(
            service.active_keys < service.max_keys,
            ApiKeyError::MaxKeysReached
        );

        let clock = Clock::get()?;
        if let Some(exp) = expires_at {
            require!(exp > clock.unix_timestamp, ApiKeyError::InvalidExpiry);
        }

        let api_key = &mut ctx.accounts.api_key;
        api_key.service = service.key();
        api_key.key_hash = key_hash;
        api_key.label = label;
        api_key.permissions = permissions_mask;
        api_key.rate_limit = rate_limit.unwrap_or(service.default_rate_limit);
        api_key.rate_limit_window = service.rate_limit_window;
        api_key.window_start = clock.unix_timestamp;
        api_key.window_usage = 0;
        api_key.total_usage = 0;
        api_key.created_at = clock.unix_timestamp;
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

        emit!(UsageRecorded {
            service: api_key.service,
            key_hash,
            window_usage: api_key.window_usage,
            total_usage: api_key.total_usage,
        });

        Ok(())
    }

    /// Validate a key without recording usage. Returns success if key is valid, errors otherwise.
    /// Useful for read-only validation checks.
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
            remaining_usage: api_key.rate_limit - current_usage,
        });

        Ok(())
    }

    /// Revoke an API key. Only the service owner can revoke keys.
    pub fn revoke_key(ctx: Context<RevokeKey>) -> Result<()> {
        let api_key = &mut ctx.accounts.api_key;
        require!(!api_key.revoked, ApiKeyError::AlreadyRevoked);

        api_key.revoked = true;

        let service = &mut ctx.accounts.service_config;
        service.active_keys = service.active_keys.saturating_sub(1);

        emit!(KeyRevoked {
            service: service.key(),
            key_hash: api_key.key_hash,
        });

        Ok(())
    }

    /// Update permissions and rate limit for an existing key.
    pub fn update_key(
        ctx: Context<UpdateKey>,
        permissions_mask: Option<u16>,
        rate_limit: Option<u32>,
        expires_at: Option<i64>,
    ) -> Result<()> {
        let api_key = &mut ctx.accounts.api_key;
        require!(!api_key.revoked, ApiKeyError::KeyRevoked);

        if let Some(perms) = permissions_mask {
            api_key.permissions = perms;
        }
        if let Some(limit) = rate_limit {
            require!(limit > 0, ApiKeyError::InvalidConfig);
            api_key.rate_limit = limit;
        }
        if let Some(exp) = expires_at {
            let clock = Clock::get()?;
            require!(exp > clock.unix_timestamp, ApiKeyError::InvalidExpiry);
            api_key.expires_at = exp;
        }

        emit!(KeyUpdated {
            service: api_key.service,
            key_hash: api_key.key_hash,
            permissions: api_key.permissions,
            rate_limit: api_key.rate_limit,
        });

        Ok(())
    }

    /// Close an API key account and reclaim rent. Only the service owner can close keys.
    pub fn close_key(ctx: Context<CloseKey>) -> Result<()> {
        let service = &mut ctx.accounts.service_config;
        let api_key = &ctx.accounts.api_key;

        if !api_key.revoked {
            service.active_keys = service.active_keys.saturating_sub(1);
        }

        emit!(KeyClosed {
            service: service.key(),
            key_hash: api_key.key_hash,
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
    /// Human-readable service name
    #[max_len(32)]
    pub name: String,
    /// Maximum number of active API keys allowed
    pub max_keys: u32,
    /// Default rate limit for new keys (requests per window)
    pub default_rate_limit: u32,
    /// Rate limit window in seconds (60, 3600, or 86400)
    pub rate_limit_window: i64,
    /// Total keys ever created
    pub total_keys_created: u32,
    /// Currently active (non-revoked, non-closed) keys
    pub active_keys: u32,
    /// PDA bump seed
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ApiKey {
    /// The service this key belongs to
    pub service: Pubkey,
    /// SHA-256 hash of the actual API key
    pub key_hash: [u8; 32],
    /// Human-readable label for this key
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
// Events
// ============================================================================

#[event]
pub struct ServiceCreated {
    pub service: Pubkey,
    pub owner: Pubkey,
    pub name: String,
}

#[event]
pub struct KeyCreated {
    pub service: Pubkey,
    pub key_hash: [u8; 32],
    pub label: String,
    pub permissions: u16,
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
pub struct KeyRevoked {
    pub service: Pubkey,
    pub key_hash: [u8; 32],
}

#[event]
pub struct KeyUpdated {
    pub service: Pubkey,
    pub key_hash: [u8; 32],
    pub permissions: u16,
    pub rate_limit: u32,
}

#[event]
pub struct KeyClosed {
    pub service: Pubkey,
    pub key_hash: [u8; 32],
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum ApiKeyError {
    #[msg("Name exceeds 32 characters")]
    NameTooLong,
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
    #[msg("Invalid expiry timestamp")]
    InvalidExpiry,
    #[msg("Key is already revoked")]
    AlreadyRevoked,
    #[msg("Invalid service account")]
    InvalidService,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#!/usr/bin/env python3
"""
Generate hackathon pitch video for Solana API Key Manager.
Uses edge-tts for narration + Pillow for slides + ffmpeg for compositing.
"""

import asyncio
import os
import subprocess
import sys
from pathlib import Path

# Ensure we can import from venv
sys.path.insert(0, '/opt/autonomous-ai/venv/lib/python3.12/site-packages')

from PIL import Image, ImageDraw, ImageFont

# Configuration
WIDTH, HEIGHT = 1920, 1080
VOICE = "en-US-AndrewMultilingualNeural"
RATE = "-3%"
OUTPUT_DIR = Path("/tmp/hackathon-video")
FINAL_OUTPUT = Path("/opt/autonomous-ai/repos/solana-api-key-manager/hackathon_pitch_v2.mp4")

# Colors (Solana theme)
BG = (10, 10, 15)
SURFACE = (18, 18, 26)
ACCENT = (153, 69, 255)  # Solana purple
GREEN = (20, 241, 149)   # Solana green
WHITE = (228, 228, 231)
MUTED = (113, 113, 122)
ORANGE = (245, 158, 11)
RED = (239, 68, 68)

# Slides: (title, bullet_points, narration)
SLIDES = [
    {
        "title": "On-Chain API Key Management",
        "subtitle": "Replacing PostgreSQL + Redis with Solana",
        "bullets": [],
        "narration": (
            "Every SaaS product uses API keys. Stripe, OpenAI, AWS. "
            "The pattern is simple: generate a key, hash it, store it, check permissions on every request. "
            "But there's a trust problem. The operator controls the database. "
            "They can silently change your permissions, reset your rate limits, or revoke your key. "
            "You have no way to verify any of it. "
            "We rebuilt this entire system as a Solana program."
        ),
        "layout": "hero"
    },
    {
        "title": "The Migration",
        "subtitle": "Same patterns, verifiable enforcement",
        "bullets": [
            ("PostgreSQL tables", "→  Program Derived Addresses (PDAs)"),
            ("Redis counters", "→  On-chain usage tracking"),
            ("API Gateway middleware", "→  Free RPC simulation"),
            ("Operator trust", "→  Cryptographic verification"),
        ],
        "narration": (
            "PostgreSQL tables become Program Derived Addresses — deterministic, "
            "program-owned, publicly readable. "
            "Redis rate counters move on-chain where they can't be silently reset. "
            "API gateway middleware is replaced by free RPC simulations. "
            "The trust model flips: instead of trusting the operator, "
            "anyone can verify state directly on the blockchain."
        ),
        "layout": "comparison"
    },
    {
        "title": "10 On-Chain Instructions",
        "subtitle": "Full CRUD lifecycle for API keys",
        "bullets": [
            ("initialize_service", "Create your service config (PDA)"),
            ("create_key / rotate_key", "Issue and rotate API keys"),
            ("validate_key", "Check key validity — FREE via RPC"),
            ("check_permission", "Bitwise auth check — FREE via RPC"),
            ("record_usage", "Rate limit enforcement on-chain"),
            ("update_key / revoke_key / close_key", "Full key lifecycle"),
        ],
        "narration": (
            "Ten instructions mirror the full REST API lifecycle. "
            "The key insight: validation and permission checks are completely free. "
            "They run as RPC simulations — no fee, no signature. "
            "Only writes cost anything, about five millionths of a SOL per request."
        ),
        "layout": "list"
    },
    {
        "title": "464x Cheaper",
        "subtitle": "Real cost comparison at production scale",
        "bullets": [
            ("AWS Stack", "$1,044/month"),
            ("", "RDS, ElastiCache, ALB, ECS Fargate, CloudWatch"),
            ("Solana On-Chain", "$2.25/month"),
            ("", "Key rent (reclaimable) + usage writes"),
        ],
        "narration": (
            "A traditional AWS stack costs about a thousand dollars a month. "
            "RDS, ElastiCache, load balancer, Fargate, monitoring. "
            "The Solana version: two dollars twenty-five cents. "
            "Key creation costs half a cent in rent, which is reclaimable. "
            "Validation reads are free. "
            "That's a four hundred sixty-four times cost reduction — "
            "twelve thousand dollars saved annually."
        ),
        "layout": "cost"
    },
    {
        "title": "Trust Model Revolution",
        "subtitle": "From 'trust us' to 'verify on-chain'",
        "bullets": [
            ("Permission changes", "Signed transactions, publicly visible"),
            ("Rate limits", "Enforced by program logic, not middleware"),
            ("Usage data", "Immutable on-chain counters"),
            ("Audit trail", "Permanent, on-chain, anyone can read"),
        ],
        "narration": (
            "The real value is the trust model change. "
            "In Web2, if Stripe changes your rate limit, you discover it when requests fail. "
            "On-chain, you see the change before it affects you. "
            "Every permission change is a signed transaction on a public ledger. "
            "Every usage record is immutable. "
            "This is what migration to Solana means: "
            "turning trust assumptions into cryptographic guarantees."
        ),
        "layout": "trust"
    },
    {
        "title": "Production Quality",
        "subtitle": "52 tests • 1,070-line SDK • 13 CLI commands",
        "bullets": [
            ("52 integration tests", "All passing on local validator"),
            ("TypeScript SDK", "1,070 lines, full CRUD + simulation"),
            ("CLI tool", "13 commands for service management"),
            ("Security", "Hash-based storage, owner-gated writes, checked arithmetic"),
        ],
        "narration": (
            "This isn't a proof of concept. "
            "Fifty-two tests, all passing. "
            "A thousand-line TypeScript SDK. Thirteen CLI commands. "
            "Hash-based key storage matching Stripe's pattern. "
            "Owner-gated writes. Checked arithmetic. No dependencies beyond Anchor."
        ),
        "layout": "stats"
    },
    {
        "title": "Try It Yourself",
        "subtitle": "theauroraai.github.io/solana-api-key-manager",
        "bullets": [
            ("Interactive dashboard", "Create, validate, and manage keys in-browser"),
            ("GitHub", "github.com/TheAuroraAI/solana-api-key-manager"),
            ("Program ID", "v73KoPncjCfhWRkf2QPag15NcFx3oMsRevYtYoGReju"),
        ],
        "narration": (
            "Try it yourself. There's an interactive dashboard where you can "
            "create keys, validate them, and test rate limiting in your browser. "
            "Full source on GitHub. "
            "The same patterns developers already know, "
            "with verifiable enforcement on Solana. "
            "Thank you."
        ),
        "layout": "cta"
    },
]


def get_font(size, bold=False):
    """Get a font, falling back to default if needed."""
    font_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for path in font_paths:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_gradient_bg(draw, width, height):
    """Draw a subtle gradient background."""
    for y in range(height):
        r = int(BG[0] + (SURFACE[0] - BG[0]) * (y / height) * 0.3)
        g = int(BG[1] + (SURFACE[1] - BG[1]) * (y / height) * 0.3)
        b = int(BG[2] + (SURFACE[2] - BG[2]) * (y / height) * 0.3)
        draw.line([(0, y), (width, y)], fill=(r, g, b))


def draw_accent_line(draw, x, y, length):
    """Draw a gradient accent line."""
    for i in range(length):
        t = i / length
        r = int(ACCENT[0] + (GREEN[0] - ACCENT[0]) * t)
        g = int(ACCENT[1] + (GREEN[1] - ACCENT[1]) * t)
        b = int(ACCENT[2] + (GREEN[2] - ACCENT[2]) * t)
        draw.line([(x + i, y), (x + i, y + 3)], fill=(r, g, b))


def create_slide(slide_data, index, total):
    """Create a single slide image."""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(img)
    draw_gradient_bg(draw, WIDTH, HEIGHT)

    title_font = get_font(56, bold=True)
    subtitle_font = get_font(28)
    bullet_font = get_font(26, bold=True)
    detail_font = get_font(24)
    small_font = get_font(18)

    layout = slide_data.get("layout", "default")

    if layout == "hero":
        # Center title with large text
        title = slide_data["title"]
        bbox = draw.textbbox((0, 0), title, font=get_font(72, bold=True))
        tw = bbox[2] - bbox[0]
        draw.text(((WIDTH - tw) // 2, 300), title, fill=WHITE, font=get_font(72, bold=True))

        draw_accent_line(draw, (WIDTH - 400) // 2, 400, 400)

        sub = slide_data["subtitle"]
        bbox = draw.textbbox((0, 0), sub, font=get_font(32))
        sw = bbox[2] - bbox[0]
        draw.text(((WIDTH - sw) // 2, 430), sub, fill=MUTED, font=get_font(32))

        # Badges at bottom
        badges = ["Solana", "Anchor", "Rust", "TypeScript", "52 Tests"]
        bx = (WIDTH - len(badges) * 180) // 2
        for badge in badges:
            draw.rounded_rectangle([(bx, 550), (bx + 160, 590)], radius=15, outline=ACCENT, width=1)
            bbox = draw.textbbox((0, 0), badge, font=small_font)
            bw = bbox[2] - bbox[0]
            draw.text((bx + (160 - bw) // 2, 560), badge, fill=GREEN, font=small_font)
            bx += 180

    elif layout == "cost":
        # Title
        draw.text((120, 80), slide_data["title"], fill=WHITE, font=title_font)
        draw_accent_line(draw, 120, 150, 300)
        draw.text((120, 170), slide_data["subtitle"], fill=MUTED, font=subtitle_font)

        # Cost cards
        # AWS card
        draw.rounded_rectangle([(120, 260), (880, 520)], radius=16, fill=SURFACE, outline=(30, 30, 46))
        draw.text((180, 290), "Traditional AWS Stack", fill=MUTED, font=detail_font)
        draw.text((180, 340), "$1,044", fill=RED, font=get_font(80, bold=True))
        draw.text((520, 380), "/month", fill=MUTED, font=detail_font)
        draw.text((180, 450), "RDS + ElastiCache + ALB + ECS Fargate", fill=MUTED, font=small_font)

        # Solana card
        draw.rounded_rectangle([(960, 260), (1720, 520)], radius=16, fill=SURFACE, outline=(30, 30, 46))
        draw.text((1020, 290), "Solana On-Chain", fill=MUTED, font=detail_font)
        draw.text((1020, 340), "$2.25", fill=GREEN, font=get_font(80, bold=True))
        draw.text((1360, 380), "/month", fill=MUTED, font=detail_font)
        draw.text((1020, 450), "Key rent (reclaimable) + usage writes", fill=MUTED, font=small_font)

        # Arrow
        draw.text((890, 360), "→", fill=ACCENT, font=get_font(60, bold=True))

        # Savings banner
        draw.rounded_rectangle([(120, 560), (1720, 700)], radius=16, fill=(20, 241, 149, 10), outline=(20, 241, 149))
        draw.text((480, 590), "464x cheaper  •  $12,501 annual savings", fill=GREEN, font=get_font(36, bold=True))

    else:
        # Standard layout
        draw.text((120, 80), slide_data["title"], fill=WHITE, font=title_font)
        draw_accent_line(draw, 120, 150, 300)
        draw.text((120, 170), slide_data["subtitle"], fill=MUTED, font=subtitle_font)

        y = 260
        for bullet in slide_data.get("bullets", []):
            if isinstance(bullet, tuple):
                label, detail = bullet
                if label:
                    # Bullet with arrow notation
                    draw.rounded_rectangle([(120, y), (140, y + 20)], radius=4, fill=ACCENT)
                    draw.text((160, y - 4), label, fill=WHITE, font=bullet_font)
                    if "→" in detail:
                        parts = detail.split("→")
                        draw.text((160, y + 32), detail, fill=GREEN, font=detail_font)
                    else:
                        draw.text((160, y + 32), detail, fill=MUTED, font=detail_font)
                    y += 90
                else:
                    draw.text((180, y - 10), detail, fill=MUTED, font=small_font)
                    y += 40

    # Slide counter
    counter = f"{index + 1} / {total}"
    draw.text((WIDTH - 120, HEIGHT - 50), counter, fill=MUTED, font=small_font)

    # Solana logo area (text)
    draw.text((120, HEIGHT - 50), "Solana API Key Manager", fill=(60, 60, 80), font=small_font)

    return img


async def generate_audio(text, output_path, voice=VOICE, rate=RATE):
    """Generate audio using edge-tts."""
    import edge_tts
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await communicate.save(output_path)


def get_audio_duration(path):
    """Get audio duration in seconds using ffprobe."""
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True
    )
    return float(result.stdout.strip())


async def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("Generating Hackathon Pitch Video")
    print("=" * 60)

    # Step 1: Generate all slide images
    print("\n[1/4] Creating slides...")
    for i, slide in enumerate(SLIDES):
        img = create_slide(slide, i, len(SLIDES))
        img.save(OUTPUT_DIR / f"slide_{i:02d}.png")
        print(f"  Slide {i+1}/{len(SLIDES)}: {slide['title']}")

    # Step 2: Generate all audio files
    print("\n[2/4] Generating narration with edge-tts...")
    for i, slide in enumerate(SLIDES):
        audio_path = OUTPUT_DIR / f"audio_{i:02d}.mp3"
        await generate_audio(slide["narration"], str(audio_path))
        duration = get_audio_duration(audio_path)
        print(f"  Segment {i+1}/{len(SLIDES)}: {duration:.1f}s — {slide['title']}")

    # Step 3: Create video segments (slide + audio)
    print("\n[3/4] Compositing video segments...")
    segments = []
    total_duration = 0
    for i in range(len(SLIDES)):
        audio_path = OUTPUT_DIR / f"audio_{i:02d}.mp3"
        slide_path = OUTPUT_DIR / f"slide_{i:02d}.png"
        segment_path = OUTPUT_DIR / f"segment_{i:02d}.mp4"

        duration = get_audio_duration(audio_path)
        # Add 0.5s padding at start and end
        total_dur = duration + 1.0
        total_duration += total_dur

        subprocess.run([
            "ffmpeg", "-y",
            "-loop", "1", "-i", str(slide_path),
            "-i", str(audio_path),
            "-filter_complex",
            f"[0:v]scale=1920:1080,format=yuv420p,fade=in:st=0:d=0.4,fade=out:st={total_dur-0.4}:d=0.4[v];"
            f"[1:a]adelay=500|500,apad[a]",
            "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-t", str(total_dur),
            "-shortest",
            str(segment_path)
        ], capture_output=True, check=True)

        segments.append(segment_path)
        print(f"  Segment {i+1}: {total_dur:.1f}s")

    # Step 4: Concatenate all segments
    print(f"\n[4/4] Concatenating {len(segments)} segments (total: {total_duration:.1f}s)...")
    concat_file = OUTPUT_DIR / "concat.txt"
    with open(concat_file, 'w') as f:
        for seg in segments:
            f.write(f"file '{seg}'\n")

    subprocess.run([
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", str(concat_file),
        "-c:v", "libx264", "-preset", "medium", "-crf", "22",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(FINAL_OUTPUT)
    ], capture_output=True, check=True)

    final_duration = get_audio_duration(FINAL_OUTPUT)
    final_size = FINAL_OUTPUT.stat().st_size / (1024 * 1024)

    print(f"\n{'=' * 60}")
    print(f"Video generated: {FINAL_OUTPUT}")
    print(f"Duration: {final_duration:.1f}s ({final_duration/60:.1f} min)")
    print(f"Size: {final_size:.1f} MB")
    print(f"Resolution: 1920x1080")
    print(f"Voice: {VOICE}")
    print(f"{'=' * 60}")

    if final_duration > 180:
        print(f"\n⚠️  WARNING: Video is {final_duration:.0f}s — exceeds 3 minute limit!")
        print("Consider trimming narration text.")
    elif final_duration > 240:
        print(f"\n⚠️  WARNING: Video is {final_duration:.0f}s — exceeds 4 minute limit!")
    else:
        print(f"\n✓ Video is within time limit.")


if __name__ == "__main__":
    asyncio.run(main())

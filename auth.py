"""
auth.py — Google OAuth Handler for NexChat
Uses Authlib to verify Google ID tokens from the frontend.
"""

import requests
from config import Config

GOOGLE_TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo"
GOOGLE_USERINFO_URL   = "https://www.googleapis.com/oauth2/v3/userinfo"


def verify_google_token(id_token: str) -> dict | None:
    """
    Verify a Google ID token received from the frontend (Google One Tap / OAuth).
    Returns user info dict or None if invalid.

    Returned dict keys:
        sub      — Google user ID (unique)
        email    — Gmail address
        name     — Full name
        picture  — Avatar URL
        email_verified — bool
    """
    try:
        resp = requests.get(
            GOOGLE_TOKEN_INFO_URL,
            params={"id_token": id_token},
            timeout=5,
        )
        if resp.status_code != 200:
            return None

        info = resp.json()

        # Validate audience matches our client ID
        if info.get("aud") != Config.GOOGLE_CLIENT_ID:
            print(f"[OAuth] Token audience mismatch: {info.get('aud')}")
            return None

        if not info.get("email_verified"):
            return None

        return {
            "sub":            info.get("sub"),
            "email":          info.get("email"),
            "name":           info.get("name", info.get("email", "").split("@")[0]),
            "picture":        info.get("picture", ""),
            "email_verified": True,
        }

    except Exception as e:
        print(f"[OAuth] verify_google_token error: {e}")
        return None


def get_username_from_google_info(info: dict) -> str:
    """
    Derive a clean username from Google user info.
    Uses the part before @ in email, sanitized.
    e.g. 'agastinjebakumar6@gmail.com' → 'agastinjeba'
    """
    raw = info.get("email", "user").split("@")[0]
    # Keep only alphanumeric + underscore, max 20 chars
    clean = "".join(c for c in raw if c.isalnum() or c == "_")[:20]
    return clean or "user"

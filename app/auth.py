import hashlib
import json
import os
from pathlib import Path
from typing import Tuple

USERS_FILE = Path("data/users.json")

APPROVED_USERS = [
    u.strip()
    for u in os.environ.get("APPROVED_USERS", "jason").split(",")
    if u.strip()
]


def _ensure_users_file():
    if not USERS_FILE.exists():
        USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
        USERS_FILE.write_text(json.dumps({}, indent=2))


def hash_pw(pw: str) -> str:
    return hashlib.sha256(pw.encode("utf-8")).hexdigest()


def load_users() -> dict:
    _ensure_users_file()
    try:
        return json.loads(USERS_FILE.read_text())
    except json.JSONDecodeError:
        return {}


def save_users(users: dict):
    USERS_FILE.write_text(json.dumps(users, indent=2, sort_keys=True))


def verify(username: str, password: str) -> Tuple[bool, bool]:
    """Returns (success, was_first_login_setting_pw).
    If the username is approved but has no stored hash, the first
    successful submission sets the password (Summer pattern).
    """
    if username not in APPROVED_USERS:
        return False, False
    users = load_users()
    stored = users.get(username, "")
    if not stored:
        users[username] = hash_pw(password)
        save_users(users)
        return True, True
    return stored == hash_pw(password), False

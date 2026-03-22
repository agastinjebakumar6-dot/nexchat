"""
database.py — NexChat v3 Database Layer
New: pinned_messages, invite_links, message deleted flag, reactions
"""

import sqlite3, datetime, secrets
from config import Config


def get_sqlite_conn():
    conn = sqlite3.connect(Config.SQLITE_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_sqlite():
    conn = get_sqlite_conn()
    cur  = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            user_id    INTEGER PRIMARY KEY AUTOINCREMENT,
            username   TEXT    UNIQUE NOT NULL,
            email      TEXT    UNIQUE NOT NULL,
            password   TEXT    DEFAULT '',
            google_id  TEXT    DEFAULT '',
            avatar_url TEXT    DEFAULT '',
            bio        TEXT    DEFAULT '',
            status     TEXT    DEFAULT 'offline',
            theme      TEXT    DEFAULT 'dark',
            pub_key    TEXT    DEFAULT '',
            first_msg  INTEGER DEFAULT 0,
            created_at TEXT    DEFAULT (datetime('now'))
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS rooms (
            room_id    INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name  TEXT    UNIQUE NOT NULL,
            room_type  TEXT    DEFAULT 'public',
            invite_code TEXT   DEFAULT '',
            created_at TEXT    DEFAULT (datetime('now'))
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            message_id   INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id      INTEGER NOT NULL,
            sender_id    INTEGER NOT NULL,
            message_text TEXT,
            file_name    TEXT    DEFAULT NULL,
            file_size    INTEGER DEFAULT NULL,
            msg_type     TEXT    DEFAULT 'text',
            is_deleted   INTEGER DEFAULT 0,
            is_encrypted INTEGER DEFAULT 0,
            pinned       INTEGER DEFAULT 0,
            timestamp    TEXT    DEFAULT (datetime('now')),
            FOREIGN KEY (room_id)   REFERENCES rooms(room_id),
            FOREIGN KEY (sender_id) REFERENCES users(user_id)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS reactions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            emoji      TEXT    NOT NULL,
            created_at TEXT    DEFAULT (datetime('now')),
            UNIQUE(message_id, user_id, emoji),
            FOREIGN KEY (message_id) REFERENCES messages(message_id),
            FOREIGN KEY (user_id)    REFERENCES users(user_id)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS pinned_messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id    INTEGER NOT NULL,
            message_id INTEGER NOT NULL,
            pinned_by  INTEGER NOT NULL,
            pinned_at  TEXT    DEFAULT (datetime('now')),
            UNIQUE(room_id, message_id)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS invite_links (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            code       TEXT    UNIQUE NOT NULL,
            room_name  TEXT    NOT NULL,
            created_by TEXT    NOT NULL,
            uses       INTEGER DEFAULT 0,
            max_uses   INTEGER DEFAULT 100,
            expires_at TEXT    DEFAULT NULL,
            created_at TEXT    DEFAULT (datetime('now'))
        )
    """)

    for room_name in Config.DEFAULT_ROOMS:
        cur.execute(
            "INSERT OR IGNORE INTO rooms (room_name, room_type) VALUES (?, 'public')",
            (room_name,)
        )

    conn.commit()
    conn.close()
    print("[SQLite] Tables initialized ✓")


# ── Users ──────────────────────────────────────────────
def create_user(username, email, hashed_password='', google_id='', avatar_url=''):
    conn = get_sqlite_conn()
    try:
        conn.execute(
            """INSERT INTO users (username, email, password, google_id, avatar_url)
               VALUES (?, ?, ?, ?, ?)""",
            (username, email, hashed_password, google_id, avatar_url)
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()


def get_user_by_username(username):
    conn = get_sqlite_conn()
    row  = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_user_by_email(email):
    conn = get_sqlite_conn()
    row  = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_user_by_google_id(google_id):
    conn = get_sqlite_conn()
    row  = conn.execute("SELECT * FROM users WHERE google_id=?", (google_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_user_by_id(user_id):
    conn = get_sqlite_conn()
    row  = conn.execute("SELECT * FROM users WHERE user_id=?", (user_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def update_user_profile(user_id, bio='', avatar_url=''):
    conn = get_sqlite_conn()
    conn.execute("UPDATE users SET bio=?, avatar_url=? WHERE user_id=?",
                 (bio, avatar_url, user_id))
    conn.commit()
    conn.close()


def set_user_status(username, status):
    conn = get_sqlite_conn()
    conn.execute("UPDATE users SET status=? WHERE username=?", (status, username))
    conn.commit()
    conn.close()


def update_user_theme(username, theme):
    conn = get_sqlite_conn()
    conn.execute("UPDATE users SET theme=? WHERE username=?", (theme, username))
    conn.commit()
    conn.close()


def save_user_public_key(username, pub_key):
    """Store user's E2E public key"""
    conn = get_sqlite_conn()
    conn.execute("UPDATE users SET pub_key=? WHERE username=?", (pub_key, username))
    conn.commit()
    conn.close()


def mark_first_message(username):
    """Mark that user has sent their first message (for confetti)"""
    conn = get_sqlite_conn()
    conn.execute("UPDATE users SET first_msg=1 WHERE username=?", (username,))
    conn.commit()
    conn.close()


def has_sent_first_message(username):
    conn = get_sqlite_conn()
    row  = conn.execute("SELECT first_msg FROM users WHERE username=?", (username,)).fetchone()
    conn.close()
    return bool(row['first_msg']) if row else False


# ── Rooms ──────────────────────────────────────────────
def get_all_rooms():
    conn = get_sqlite_conn()
    rows = conn.execute("SELECT * FROM rooms WHERE room_type='public'").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_room_by_name(room_name):
    conn = get_sqlite_conn()
    row  = conn.execute("SELECT * FROM rooms WHERE room_name=?", (room_name,)).fetchone()
    conn.close()
    return dict(row) if row else None


# ── Messages ──────────────────────────────────────────
def save_message_sqlite(room_name, sender_id, message_text,
                        file_name=None, file_size=None, msg_type='text', is_encrypted=0):
    conn = get_sqlite_conn()
    room = conn.execute("SELECT room_id FROM rooms WHERE room_name=?", (room_name,)).fetchone()
    if not room:
        conn.close()
        return None
    cur = conn.execute(
        """INSERT INTO messages
           (room_id, sender_id, message_text, file_name, file_size, msg_type, is_encrypted)
           VALUES (?,?,?,?,?,?,?)""",
        (room['room_id'], sender_id, message_text, file_name, file_size, msg_type, is_encrypted)
    )
    conn.commit()
    msg_id = cur.lastrowid
    conn.close()
    return msg_id


def get_recent_messages_sqlite(room_name, limit=50):
    conn = get_sqlite_conn()
    rows = conn.execute(
        """SELECT m.message_id, u.username, u.avatar_url,
                  m.message_text, m.file_name, m.file_size,
                  m.msg_type, m.timestamp, m.is_deleted, m.is_encrypted, m.pinned
           FROM messages m
           JOIN users u ON m.sender_id = u.user_id
           JOIN rooms  r ON m.room_id  = r.room_id
           WHERE r.room_name=?
           ORDER BY m.timestamp DESC LIMIT ?""",
        (room_name, limit)
    ).fetchall()
    conn.close()
    return [dict(r) for r in reversed(rows)]


def delete_message_for_everyone(message_id, requester_username):
    """Mark message as deleted — only sender can delete"""
    conn = get_sqlite_conn()
    user = conn.execute("SELECT user_id FROM users WHERE username=?",
                        (requester_username,)).fetchone()
    if not user:
        conn.close()
        return False
    msg = conn.execute(
        "SELECT sender_id FROM messages WHERE message_id=?", (message_id,)
    ).fetchone()
    if not msg or msg['sender_id'] != user['user_id']:
        conn.close()
        return False
    conn.execute(
        "UPDATE messages SET is_deleted=1, message_text='This message was deleted' WHERE message_id=?",
        (message_id,)
    )
    conn.commit()
    conn.close()
    return True


# ── Pin messages ──────────────────────────────────────
def pin_message(room_name, message_id, pinned_by_username):
    conn = get_sqlite_conn()
    room = conn.execute("SELECT room_id FROM rooms WHERE room_name=?", (room_name,)).fetchone()
    user = conn.execute("SELECT user_id FROM users WHERE username=?", (pinned_by_username,)).fetchone()
    if not room or not user:
        conn.close()
        return False
    try:
        conn.execute(
            "INSERT OR IGNORE INTO pinned_messages (room_id, message_id, pinned_by) VALUES (?,?,?)",
            (room['room_id'], message_id, user['user_id'])
        )
        conn.execute("UPDATE messages SET pinned=1 WHERE message_id=?", (message_id,))
        conn.commit()
        return True
    except Exception:
        return False
    finally:
        conn.close()


def unpin_message(room_name, message_id):
    conn = get_sqlite_conn()
    room = conn.execute("SELECT room_id FROM rooms WHERE room_name=?", (room_name,)).fetchone()
    if not room:
        conn.close()
        return False
    conn.execute("DELETE FROM pinned_messages WHERE room_id=? AND message_id=?",
                 (room['room_id'], message_id))
    conn.execute("UPDATE messages SET pinned=0 WHERE message_id=?", (message_id,))
    conn.commit()
    conn.close()
    return True


def get_pinned_messages(room_name):
    conn = get_sqlite_conn()
    rows = conn.execute(
        """SELECT m.message_id, u.username, m.message_text, m.msg_type, m.timestamp
           FROM pinned_messages pm
           JOIN messages m ON pm.message_id = m.message_id
           JOIN users   u ON m.sender_id    = u.user_id
           JOIN rooms   r ON pm.room_id     = r.room_id
           WHERE r.room_name=? AND m.is_deleted=0
           ORDER BY pm.pinned_at DESC""",
        (room_name,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── Invite links ───────────────────────────────────────
def create_invite_link(room_name, created_by, max_uses=100, hours_valid=72):
    code       = secrets.token_urlsafe(12)
    expires_at = (datetime.datetime.utcnow() +
                  datetime.timedelta(hours=hours_valid)).isoformat()
    conn = get_sqlite_conn()
    conn.execute(
        """INSERT INTO invite_links (code, room_name, created_by, max_uses, expires_at)
           VALUES (?,?,?,?,?)""",
        (code, room_name, created_by, max_uses, expires_at)
    )
    conn.commit()
    conn.close()
    return code


def validate_invite_link(code):
    conn  = get_sqlite_conn()
    row   = conn.execute("SELECT * FROM invite_links WHERE code=?", (code,)).fetchone()
    conn.close()
    if not row:
        return None
    invite = dict(row)
    if invite['uses'] >= invite['max_uses']:
        return None
    if invite['expires_at']:
        expires = datetime.datetime.fromisoformat(invite['expires_at'])
        if datetime.datetime.utcnow() > expires:
            return None
    return invite


def use_invite_link(code):
    conn = get_sqlite_conn()
    conn.execute("UPDATE invite_links SET uses = uses + 1 WHERE code=?", (code,))
    conn.commit()
    conn.close()


# ── Reactions ─────────────────────────────────────────
def add_reaction(message_id, user_id, emoji):
    conn = get_sqlite_conn()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?,?,?)",
            (message_id, user_id, emoji)
        )
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()


def remove_reaction(message_id, user_id, emoji):
    conn = get_sqlite_conn()
    conn.execute("DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?",
                 (message_id, user_id, emoji))
    conn.commit()
    conn.close()


def get_reactions_for_message(message_id):
    conn = get_sqlite_conn()
    rows = conn.execute(
        """SELECT emoji, COUNT(*) as count,
                  GROUP_CONCAT(u.username) as users
           FROM reactions r JOIN users u ON r.user_id=u.user_id
           WHERE r.message_id=?
           GROUP BY emoji""",
        (message_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── MongoDB ────────────────────────────────────────────
_mongo_db = None

def get_mongo_db():
    global _mongo_db
    if _mongo_db is None:
        try:
            from pymongo import MongoClient
            client    = MongoClient(Config.MONGO_URI, serverSelectionTimeoutMS=3000)
            client.server_info()
            _mongo_db = client[Config.MONGO_DB_NAME]
            _mongo_db.messages.create_index([("room", 1), ("timestamp", -1)])
            print("[MongoDB] Connected ✓")
        except Exception as e:
            print(f"[MongoDB] Unavailable: {e}")
            _mongo_db = None
    return _mongo_db


def log_message_mongo(room, sender, message_text, msg_type='text', file_info=None, is_encrypted=False):
    db = get_mongo_db()
    if db is None:
        return None
    try:
        doc = {
            "room": room, "sender": sender,
            "message_text": message_text, "msg_type": msg_type,
            "file_info": file_info, "is_encrypted": is_encrypted,
            "timestamp": datetime.datetime.utcnow(),
        }
        return str(db.messages.insert_one(doc).inserted_id)
    except Exception as e:
        print(f"[MongoDB] log error: {e}")
        return None


def get_messages_from_mongo(room, limit=50):
    db = get_mongo_db()
    if db is None:
        return []
    try:
        docs = list(db.messages.find({"room": room}, {"_id": 0})
                      .sort("timestamp", -1).limit(limit))
        docs.reverse()
        for d in docs:
            if isinstance(d.get("timestamp"), datetime.datetime):
                d["timestamp"] = d["timestamp"].strftime("%Y-%m-%d %H:%M")
        return docs
    except Exception as e:
        print(f"[MongoDB] get error: {e}")
        return []


def get_mongo_stats():
    db = get_mongo_db()
    if db is None:
        return {"status": "disconnected"}
    try:
        return {
            "status": "connected",
            "total_messages": db.messages.count_documents({}),
            "active_rooms":   db.messages.distinct("room"),
        }
    except:
        return {"status": "error"}

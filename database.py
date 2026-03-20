"""
database.py — NexChat Database Layer
SQLite: Users, Rooms, Messages, Reactions
MongoDB: Message logs
"""

import sqlite3
import datetime
from config import Config


# ══════════════════════════════════════════
#  SQLite
# ══════════════════════════════════════════

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
            created_at TEXT    DEFAULT (datetime('now'))
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS rooms (
            room_id    INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name  TEXT    UNIQUE NOT NULL,
            room_type  TEXT    DEFAULT 'public',
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

    for room_name in Config.DEFAULT_ROOMS:
        cur.execute(
            "INSERT OR IGNORE INTO rooms (room_name, room_type) VALUES (?, 'public')",
            (room_name,)
        )

    conn.commit()
    conn.close()
    print("[SQLite] Tables initialized ✓")


# ── Users
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
    conn.execute(
        "UPDATE users SET bio=?, avatar_url=? WHERE user_id=?",
        (bio, avatar_url, user_id)
    )
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


# ── Rooms
def get_all_rooms():
    conn = get_sqlite_conn()
    rows = conn.execute("SELECT * FROM rooms WHERE room_type='public'").fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── Messages
def save_message_sqlite(room_name, sender_id, message_text,
                         file_name=None, file_size=None, msg_type='text'):
    conn = get_sqlite_conn()
    room = conn.execute(
        "SELECT room_id FROM rooms WHERE room_name=?", (room_name,)
    ).fetchone()
    if not room:
        conn.close()
        return None
    cur = conn.execute(
        """INSERT INTO messages
           (room_id, sender_id, message_text, file_name, file_size, msg_type)
           VALUES (?,?,?,?,?,?)""",
        (room['room_id'], sender_id, message_text, file_name, file_size, msg_type)
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
                  m.msg_type, m.timestamp
           FROM messages m
           JOIN users u ON m.sender_id = u.user_id
           JOIN rooms  r ON m.room_id  = r.room_id
           WHERE r.room_name=?
           ORDER BY m.timestamp DESC LIMIT ?""",
        (room_name, limit)
    ).fetchall()
    conn.close()
    return [dict(r) for r in reversed(rows)]


# ── Reactions
def add_reaction(message_id, user_id, emoji):
    conn = get_sqlite_conn()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?,?,?)",
            (message_id, user_id, emoji)
        )
        conn.commit()
        action = 'added'
    except Exception:
        action = 'error'
    finally:
        conn.close()
    return action


def remove_reaction(message_id, user_id, emoji):
    conn = get_sqlite_conn()
    conn.execute(
        "DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?",
        (message_id, user_id, emoji)
    )
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


# ══════════════════════════════════════════
#  MongoDB
# ══════════════════════════════════════════

_mongo_db = None

def get_mongo_db():
    global _mongo_db
    if _mongo_db is None:
        try:
            from pymongo import MongoClient
            client = MongoClient(Config.MONGO_URI, serverSelectionTimeoutMS=3000)
            client.server_info()
            _mongo_db = client[Config.MONGO_DB_NAME]
            _mongo_db.messages.create_index([("room", 1), ("timestamp", -1)])
            print("[MongoDB] Connected ✓")
        except Exception as e:
            print(f"[MongoDB] Unavailable: {e}")
            _mongo_db = None
    return _mongo_db


def log_message_mongo(room, sender, message_text, msg_type='text', file_info=None):
    db = get_mongo_db()
    if db is None:
        return None
    try:
        doc = {
            "room": room, "sender": sender,
            "message_text": message_text, "msg_type": msg_type,
            "file_info": file_info, "timestamp": datetime.datetime.utcnow(),
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
            "active_rooms": db.messages.distinct("room"),
        }
    except:
        return {"status": "error"}

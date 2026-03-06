"""
app.py — NexChat Backend v2
New: Google OAuth login, message reactions, profile update,
     theme preference saved server-side.
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_bcrypt import Bcrypt
from flask_jwt_extended import (
    JWTManager, create_access_token,
    jwt_required, get_jwt_identity
)
from flask_cors import CORS
import datetime, os

from config   import Config
from database import (
    init_sqlite,
    create_user, get_user_by_username, get_user_by_email,
    get_user_by_google_id, get_user_by_id,
    set_user_status, update_user_profile, update_user_theme,
    get_all_rooms, save_message_sqlite, get_recent_messages_sqlite,
    add_reaction, remove_reaction, get_reactions_for_message,
    log_message_mongo, get_messages_from_mongo, get_mongo_stats,
)
from auth import verify_google_token, get_username_from_google_info

# ── App setup
app = Flask(__name__, static_folder='frontend', static_url_path='')
app.config.from_object(Config)
app.config['JWT_SECRET_KEY'] = Config.JWT_SECRET_KEY
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = datetime.timedelta(seconds=Config.JWT_ACCESS_TOKEN_EXPIRES)

CORS(app, resources={r"/api/*": {"origins": Config.CORS_ALLOWED_ORIGINS}})
bcrypt   = Bcrypt(app)
jwt      = JWTManager(app)
socketio = SocketIO(
    app,
    cors_allowed_origins=Config.CORS_ALLOWED_ORIGINS,
    async_mode='gevent',
    logger=False, engineio_logger=False
)

connected_users = {}   # username → sid
sid_to_user     = {}   # sid → username
typing_users    = {}   # room → set(username)


# ── Serve frontend
@app.route('/')
def index():
    return send_from_directory('frontend', 'index.html')


# ══════════════════════════════════════
#  AUTH — Email/Password
# ══════════════════════════════════════

@app.route('/api/register', methods=['POST'])
def register():
    data     = request.get_json()
    username = data.get('username', '').strip()
    email    = data.get('email', '').strip()
    password = data.get('password', '')

    if not username or not email or not password:
        return jsonify({"error": "All fields are required."}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400

    hashed = bcrypt.generate_password_hash(password).decode('utf-8')
    ok     = create_user(username, email, hashed_password=hashed)
    if not ok:
        return jsonify({"error": "Username or email already exists."}), 409

    token = create_access_token(identity=username)
    return jsonify({"token": token, "username": username, "avatar_url": ""}), 201


@app.route('/api/login', methods=['POST'])
def login():
    data     = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '')

    user = get_user_by_username(username)
    if not user or not bcrypt.check_password_hash(user['password'], password):
        return jsonify({"error": "Invalid credentials."}), 401

    token = create_access_token(identity=username)
    return jsonify({
        "token":      token,
        "username":   username,
        "avatar_url": user.get('avatar_url', ''),
        "bio":        user.get('bio', ''),
        "email":      user.get('email', ''),
    }), 200


# ══════════════════════════════════════
#  AUTH — Google OAuth
# ══════════════════════════════════════

@app.route('/api/auth/google', methods=['POST'])
def google_auth():
    """
    Frontend sends Google ID token after user signs in with Google.
    We verify it, create/fetch user, return JWT.
    """
    data     = request.get_json()
    id_token = data.get('id_token', '')

    if not id_token:
        return jsonify({"error": "No token provided."}), 400

    # Verify with Google
    ginfo = verify_google_token(id_token)
    if not ginfo:
        return jsonify({"error": "Invalid Google token."}), 401

    google_id = ginfo['sub']
    email     = ginfo['email']
    name      = ginfo['name']
    picture   = ginfo['picture']

    # Check if user exists (by google_id first, then email)
    user = get_user_by_google_id(google_id)
    if not user:
        user = get_user_by_email(email)

    if not user:
        # New user — create account
        username = get_username_from_google_info(ginfo)
        # Ensure unique username
        base     = username
        i        = 1
        while get_user_by_username(username):
            username = f"{base}{i}"; i += 1

        create_user(username, email, google_id=google_id, avatar_url=picture)
        user = get_user_by_username(username)

    username  = user['username']
    token     = create_access_token(identity=username)

    return jsonify({
        "token":      token,
        "username":   username,
        "avatar_url": user.get('avatar_url', picture),
        "bio":        user.get('bio', ''),
        "email":      email,
        "name":       name,
    }), 200


# ══════════════════════════════════════
#  PROFILE
# ══════════════════════════════════════

@app.route('/api/profile', methods=['GET'])
@jwt_required()
def get_profile():
    username = get_jwt_identity()
    user     = get_user_by_username(username)
    if not user:
        return jsonify({"error": "User not found."}), 404
    return jsonify({
        "username":   user['username'],
        "email":      user['email'],
        "avatar_url": user['avatar_url'],
        "bio":        user['bio'],
        "theme":      user['theme'],
        "created_at": user['created_at'],
    }), 200


@app.route('/api/profile', methods=['PUT'])
@jwt_required()
def update_profile():
    username = get_jwt_identity()
    data     = request.get_json()
    bio      = data.get('bio', '')
    avatar   = data.get('avatar_url', '')
    user     = get_user_by_username(username)
    if not user:
        return jsonify({"error": "User not found."}), 404
    update_user_profile(user['user_id'], bio, avatar)
    return jsonify({"message": "Profile updated."}), 200


@app.route('/api/theme', methods=['POST'])
@jwt_required()
def save_theme():
    username = get_jwt_identity()
    theme    = request.get_json().get('theme', 'dark')
    update_user_theme(username, theme)
    return jsonify({"message": "Theme saved."}), 200


# ══════════════════════════════════════
#  ROOMS & MESSAGES
# ══════════════════════════════════════

@app.route('/api/rooms', methods=['GET'])
@jwt_required()
def get_rooms():
    return jsonify(get_all_rooms()), 200


@app.route('/api/messages/<room_name>', methods=['GET'])
@jwt_required()
def get_messages(room_name):
    limit = request.args.get('limit', 50, type=int)
    mongo = get_messages_from_mongo(room_name, limit)
    if mongo:
        return jsonify({"source": "mongodb", "messages": mongo}), 200
    sqlite = get_recent_messages_sqlite(room_name, limit)
    return jsonify({"source": "sqlite", "messages": sqlite}), 200


@app.route('/api/stats', methods=['GET'])
@jwt_required()
def get_stats():
    return jsonify({
        "online_users": len(connected_users),
        "mongodb":      get_mongo_stats(),
    }), 200


# ══════════════════════════════════════
#  WEBSOCKET EVENTS
# ══════════════════════════════════════

@socketio.on('connect')
def on_connect():
    print(f"[WS] Client connected: {request.sid}")


@socketio.on('disconnect')
def on_disconnect():
    sid      = request.sid
    username = sid_to_user.pop(sid, None)
    if username:
        connected_users.pop(username, None)
        set_user_status(username, 'offline')
        for room in typing_users:
            typing_users[room].discard(username)
        emit('user_offline', {"username": username}, broadcast=True)


@socketio.on('authenticate')
def on_authenticate(data):
    from flask_jwt_extended import decode_token
    try:
        token_data = decode_token(data.get('token', ''))
        username   = token_data['sub']
    except Exception:
        emit('auth_error', {"error": "Invalid token."})
        return

    sid = request.sid
    connected_users[username] = sid
    sid_to_user[sid]          = username
    set_user_status(username, 'online')

    emit('authenticated', {
        "username":     username,
        "online_users": list(connected_users.keys()),
    })
    emit('user_online', {"username": username}, broadcast=True, include_self=False)


@socketio.on('join_room')
def on_join_room(data):
    room     = data.get('room', 'general')
    username = sid_to_user.get(request.sid)
    if not username:
        return
    join_room(room)

    history = get_messages_from_mongo(room, 50)
    if not history:
        raw     = get_recent_messages_sqlite(room, 50)
        history = [
            {
                "room":         room,
                "sender":       r['username'],
                "avatar_url":   r.get('avatar_url', ''),
                "message_text": r['message_text'],
                "msg_type":     r['msg_type'],
                "file_info":    {"name": r['file_name'], "size": r['file_size']}
                                if r['file_name'] else None,
                "timestamp":    r['timestamp'],
                "message_id":   r['message_id'],
            }
            for r in raw
        ]

    emit('room_history', {"room": room, "messages": history})
    emit('user_joined', {"username": username, "room": room}, to=room, include_self=False)


@socketio.on('leave_room')
def on_leave_room(data):
    room     = data.get('room')
    username = sid_to_user.get(request.sid)
    if room and username:
        leave_room(room)
        emit('user_left', {"username": username, "room": room}, to=room)
        typing_users.get(room, set()).discard(username)


@socketio.on('send_message')
def on_send_message(data):
    username  = sid_to_user.get(request.sid)
    if not username:
        return
    room      = data.get('room', 'general')
    text      = data.get('text', '').strip()
    msg_type  = data.get('msg_type', 'text')
    file_info = data.get('file_info', None)
    if not text and not file_info:
        return

    now_str   = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M")
    user_row  = get_user_by_username(username)
    sender_id = user_row['user_id'] if user_row else 0
    avatar    = user_row.get('avatar_url', '') if user_row else ''

    fn  = file_info.get('name')  if file_info else None
    fsz = file_info.get('size')  if file_info else None
    msg_id = save_message_sqlite(room, sender_id, text, fn, fsz, msg_type)
    log_message_mongo(room, username, text, msg_type, file_info)

    payload = {
        "message_id":   msg_id,
        "room":         room,
        "sender":       username,
        "avatar_url":   avatar,
        "message_text": text,
        "msg_type":     msg_type,
        "file_info":    file_info,
        "timestamp":    now_str,
    }
    emit('new_message', payload, to=room)

    if room in typing_users:
        typing_users[room].discard(username)
        _broadcast_typing(room)


@socketio.on('react_message')
def on_react_message(data):
    """data = { message_id, emoji, action: 'add'|'remove' }"""
    username   = sid_to_user.get(request.sid)
    room       = data.get('room')
    if not username or not room:
        return

    user       = get_user_by_username(username)
    if not user:
        return

    message_id = data.get('message_id')
    emoji      = data.get('emoji')
    action     = data.get('action', 'add')

    if action == 'add':
        add_reaction(message_id, user['user_id'], emoji)
    else:
        remove_reaction(message_id, user['user_id'], emoji)

    reactions = get_reactions_for_message(message_id)
    emit('reaction_update', {
        "message_id": message_id,
        "reactions":  reactions,
        "room":       room,
    }, to=room)


@socketio.on('typing')
def on_typing(data):
    username = sid_to_user.get(request.sid)
    room     = data.get('room')
    if username and room:
        if room not in typing_users:
            typing_users[room] = set()
        typing_users[room].add(username)
        _broadcast_typing(room)


@socketio.on('stop_typing')
def on_stop_typing(data):
    username = sid_to_user.get(request.sid)
    room     = data.get('room')
    if username and room and room in typing_users:
        typing_users[room].discard(username)
        _broadcast_typing(room)


def _broadcast_typing(room):
    emit('typing_update', {
        "room":   room,
        "typers": list(typing_users.get(room, set()))
    }, to=room)


@socketio.on('read_receipt')
def on_read_receipt(data):
    emit('message_read', data, to=data.get('room'))


# ── Entry point
if __name__ == '__main__':
    print("=" * 50)
    print("  NexChat v2 — Flask-SocketIO")
    print("  http://localhost:5000")
    print("=" * 50)
    init_sqlite()
    socketio.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=False)

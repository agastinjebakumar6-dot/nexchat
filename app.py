"""
app.py — NexChat v3 Backend
New features:
  - Voice messages (base64 audio over WebSocket)
  - Invite links (generate + validate)
  - Pin / Unpin messages
  - Delete for everyone
  - Confetti trigger on first message
  - E2E encryption key exchange
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_bcrypt import Bcrypt
from flask_jwt_extended import (
    JWTManager, create_access_token,
    jwt_required, get_jwt_identity, decode_token
)
from flask_cors import CORS
import datetime, os

from config   import Config
from database import (
    init_sqlite,
    create_user, get_user_by_username, get_user_by_email,
    get_user_by_google_id, get_user_by_id,
    set_user_status, update_user_profile, update_user_theme,
    save_user_public_key, mark_first_message, has_sent_first_message,
    get_all_rooms, get_room_by_name,
    save_message_sqlite, get_recent_messages_sqlite,
    delete_message_for_everyone,
    pin_message, unpin_message, get_pinned_messages,
    create_invite_link, validate_invite_link, use_invite_link,
    add_reaction, remove_reaction, get_reactions_for_message,
    log_message_mongo, get_messages_from_mongo, get_mongo_stats,
)
from auth import verify_google_token, get_username_from_google_info

# ── App setup ─────────────────────────────────────────
app = Flask(__name__, static_folder='frontend', static_url_path='')
app.config.from_object(Config)
app.config['JWT_SECRET_KEY'] = Config.JWT_SECRET_KEY
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = datetime.timedelta(
    seconds=Config.JWT_ACCESS_TOKEN_EXPIRES)

CORS(app, resources={r"/api/*": {"origins": Config.CORS_ALLOWED_ORIGINS}})
bcrypt   = Bcrypt(app)
jwt      = JWTManager(app)
socketio = SocketIO(
    app, cors_allowed_origins=Config.CORS_ALLOWED_ORIGINS,
    async_mode='gevent', logger=False, engineio_logger=False,
    max_http_buffer_size=10 * 1024 * 1024   # 10 MB for voice/files
)

connected_users = {}   # username → sid
sid_to_user     = {}   # sid → username
typing_users    = {}   # room → set(username)
user_pubkeys    = {}   # username → public_key (in-memory cache)


# ── Frontend ──────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory('frontend', 'index.html')


# ══════════════════════════════════════════════════════
#  AUTH
# ══════════════════════════════════════════════════════
@app.route('/api/register', methods=['POST'])
def register():
    data     = request.get_json()
    username = data.get('username', '').strip()
    email    = data.get('email', '').strip()
    password = data.get('password', '')
    if not username or not email or not password:
        return jsonify({"error": "All fields required."}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be 8+ characters."}), 400
    hashed = bcrypt.generate_password_hash(password).decode('utf-8')
    ok = create_user(username, email, hashed_password=hashed)
    if not ok:
        return jsonify({"error": "Username or email already exists."}), 409
    token = create_access_token(identity=username)
    return jsonify({"token": token, "username": username, "avatar_url": ""}), 201


@app.route('/api/login', methods=['POST'])
def login():
    data     = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '')
    user     = get_user_by_username(username)
    if not user or not bcrypt.check_password_hash(user['password'], password):
        return jsonify({"error": "Invalid credentials."}), 401
    token = create_access_token(identity=username)
    return jsonify({
        "token":      token, "username":   username,
        "avatar_url": user.get('avatar_url', ''),
        "bio":        user.get('bio', ''),
        "email":      user.get('email', ''),
    }), 200


@app.route('/api/auth/google', methods=['POST'])
def google_auth():
    data      = request.get_json()
    id_token  = data.get('id_token', '')
    userinfo  = data.get('userinfo', None)
    if userinfo and userinfo.get('email'):
        ginfo = {
            'sub':            userinfo.get('sub', userinfo.get('email')),
            'email':          userinfo.get('email'),
            'name':           userinfo.get('name', userinfo.get('email','').split('@')[0]),
            'picture':        userinfo.get('picture', ''),
            'email_verified': True,
        }
    else:
        ginfo = verify_google_token(id_token)
        if not ginfo:
            return jsonify({"error": "Invalid Google token."}), 401

    google_id = ginfo['sub']
    email     = ginfo['email']
    picture   = ginfo['picture']

    user = get_user_by_google_id(google_id) or get_user_by_email(email)
    if not user:
        username = get_username_from_google_info(ginfo)
        base = username; i = 1
        while get_user_by_username(username):
            username = f"{base}{i}"; i += 1
        create_user(username, email, google_id=google_id, avatar_url=picture)
        user = get_user_by_username(username)

    token = create_access_token(identity=user['username'])
    return jsonify({
        "token":      token, "username":   user['username'],
        "avatar_url": user.get('avatar_url', picture),
        "bio":        user.get('bio', ''),
        "email":      email,
    }), 200


# ── Profile ───────────────────────────────────────────
@app.route('/api/profile', methods=['GET'])
@jwt_required()
def get_profile():
    username = get_jwt_identity()
    user = get_user_by_username(username)
    if not user:
        return jsonify({"error": "User not found."}), 404
    return jsonify({
        "username":   user['username'], "email":      user['email'],
        "avatar_url": user['avatar_url'], "bio":       user['bio'],
        "theme":      user['theme'],      "created_at":user['created_at'],
    }), 200


@app.route('/api/profile', methods=['PUT'])
@jwt_required()
def update_profile():
    username = get_jwt_identity()
    data     = request.get_json()
    user     = get_user_by_username(username)
    if not user:
        return jsonify({"error": "User not found."}), 404
    update_user_profile(user['user_id'], data.get('bio',''), data.get('avatar_url',''))
    return jsonify({"message": "Profile updated."}), 200


@app.route('/api/theme', methods=['POST'])
@jwt_required()
def save_theme():
    username = get_jwt_identity()
    update_user_theme(username, request.get_json().get('theme', 'dark'))
    return jsonify({"message": "Theme saved."}), 200


# ── E2E Encryption key exchange ───────────────────────
@app.route('/api/keys/publish', methods=['POST'])
@jwt_required()
def publish_pubkey():
    """Store user's ECDH public key (JWK format) server-side for key exchange"""
    username = get_jwt_identity()
    pub_key  = request.get_json().get('pub_key', '')
    if not pub_key:
        return jsonify({"error": "No key provided."}), 400
    save_user_public_key(username, pub_key)
    user_pubkeys[username] = pub_key
    # Broadcast to all connected users so they can do key exchange
    socketio.emit('pubkey_update', {"username": username, "pub_key": pub_key})
    return jsonify({"message": "Public key stored."}), 200


@app.route('/api/keys/<username>', methods=['GET'])
@jwt_required()
def get_pubkey(username):
    """Get another user's public key for E2E encryption"""
    user = get_user_by_username(username)
    if not user:
        return jsonify({"error": "User not found."}), 404
    return jsonify({"username": username, "pub_key": user.get('pub_key', '')}), 200


# ── Invite links ──────────────────────────────────────
@app.route('/api/invite/create', methods=['POST'])
@jwt_required()
def create_invite():
    username  = get_jwt_identity()
    data      = request.get_json()
    room_name = data.get('room', 'general')
    max_uses  = data.get('max_uses', 100)
    hours     = data.get('hours_valid', 72)
    code      = create_invite_link(room_name, username, max_uses, hours)
    base_url  = request.host_url.rstrip('/')
    return jsonify({
        "code":     code,
        "link":     f"{base_url}/join/{code}",
        "room":     room_name,
        "expires":  f"{hours} hours",
    }), 200


@app.route('/join/<code>')
def join_via_invite(code):
    """Redirect to frontend with invite code"""
    return send_from_directory('frontend', 'index.html')


@app.route('/api/invite/validate/<code>', methods=['GET'])
def validate_invite(code):
    invite = validate_invite_link(code)
    if not invite:
        return jsonify({"error": "Invalid or expired invite link."}), 404
    return jsonify({
        "valid":    True,
        "room":     invite['room_name'],
        "uses":     invite['uses'],
        "max_uses": invite['max_uses'],
    }), 200


@app.route('/api/invite/use/<code>', methods=['POST'])
@jwt_required()
def use_invite(code):
    invite = validate_invite_link(code)
    if not invite:
        return jsonify({"error": "Invalid or expired invite link."}), 404
    use_invite_link(code)
    return jsonify({"room": invite['room_name']}), 200


# ── Rooms & Messages ─────────────────────────────────
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


@app.route('/api/messages/<int:message_id>/pin', methods=['POST'])
@jwt_required()
def api_pin_message(message_id):
    username  = get_jwt_identity()
    room_name = request.get_json().get('room', 'general')
    ok = pin_message(room_name, message_id, username)
    return jsonify({"message": "Pinned."}), 200 if ok else (jsonify({"error":"Failed"}), 400)


@app.route('/api/messages/<int:message_id>/unpin', methods=['POST'])
@jwt_required()
def api_unpin_message(message_id):
    room_name = request.get_json().get('room', 'general')
    ok = unpin_message(room_name, message_id)
    return jsonify({"message": "Unpinned."}), 200 if ok else (jsonify({"error":"Failed"}), 400)


@app.route('/api/rooms/<room_name>/pinned', methods=['GET'])
@jwt_required()
def api_pinned_messages(room_name):
    return jsonify(get_pinned_messages(room_name)), 200


@app.route('/api/stats', methods=['GET'])
@jwt_required()
def get_stats():
    return jsonify({
        "online_users": len(connected_users),
        "mongodb":      get_mongo_stats(),
    }), 200


# ══════════════════════════════════════════════════════
#  WEBSOCKET EVENTS
# ══════════════════════════════════════════════════════
@socketio.on('connect')
def on_connect():
    print(f"[WS] Connected: {request.sid}")


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
                "message_id":   r['message_id'],
                "room":         room,
                "sender":       r['username'],
                "avatar_url":   r.get('avatar_url', ''),
                "message_text": r['message_text'],
                "msg_type":     r['msg_type'],
                "is_deleted":   r['is_deleted'],
                "is_encrypted": r['is_encrypted'],
                "pinned":       r['pinned'],
                "file_info":    {"name": r['file_name'], "size": r['file_size']}
                                if r['file_name'] else None,
                "timestamp":    r['timestamp'],
            }
            for r in raw
        ]

    pinned = get_pinned_messages(room)
    emit('room_history', {"room": room, "messages": history, "pinned": pinned})
    emit('user_joined', {"username": username, "room": room}, to=room, include_self=False)


@socketio.on('leave_room')
def on_leave_room(data):
    room = data.get('room')
    username = sid_to_user.get(request.sid)
    if room and username:
        leave_room(room)
        emit('user_left', {"username": username, "room": room}, to=room)
        typing_users.get(room, set()).discard(username)


@socketio.on('send_message')
def on_send_message(data):
    username = sid_to_user.get(request.sid)
    if not username:
        return
    room         = data.get('room', 'general')
    text         = data.get('text', '').strip()
    msg_type     = data.get('msg_type', 'text')    # text|voice|file|encrypted
    file_info    = data.get('file_info', None)
    is_encrypted = 1 if msg_type == 'encrypted' else 0

    if not text and not file_info:
        return

    now_str   = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M")
    user_row  = get_user_by_username(username)
    sender_id = user_row['user_id'] if user_row else 0
    avatar    = user_row.get('avatar_url', '') if user_row else ''

    fn   = file_info.get('name') if file_info else None
    fsz  = file_info.get('size') if file_info else None
    db_type = 'text' if msg_type == 'encrypted' else msg_type

    msg_id = save_message_sqlite(room, sender_id, text, fn, fsz, db_type, is_encrypted)
    log_message_mongo(room, username, text, db_type, file_info, bool(is_encrypted))

    # First message confetti check
    is_first = False
    if not has_sent_first_message(username):
        mark_first_message(username)
        is_first = True

    payload = {
        "message_id":   msg_id,
        "room":         room,
        "sender":       username,
        "avatar_url":   avatar,
        "message_text": text,
        "msg_type":     msg_type,
        "file_info":    file_info,
        "is_encrypted": is_encrypted,
        "is_first_msg": is_first,
        "timestamp":    now_str,
    }
    emit('new_message', payload, to=room)

    if room in typing_users:
        typing_users[room].discard(username)
        _broadcast_typing(room)


@socketio.on('delete_message')
def on_delete_message(data):
    """Delete a message for everyone"""
    username   = sid_to_user.get(request.sid)
    message_id = data.get('message_id')
    room       = data.get('room')
    if not username or not message_id:
        return
    ok = delete_message_for_everyone(message_id, username)
    if ok:
        emit('message_deleted', {
            "message_id": message_id,
            "room":       room,
            "deleted_by": username,
        }, to=room)


@socketio.on('pin_message')
def on_pin_message(data):
    username   = sid_to_user.get(request.sid)
    message_id = data.get('message_id')
    room       = data.get('room')
    action     = data.get('action', 'pin')   # pin|unpin
    if not username or not message_id:
        return
    if action == 'pin':
        ok = pin_message(room, message_id, username)
    else:
        ok = unpin_message(room, message_id)
    if ok:
        pinned = get_pinned_messages(room)
        emit('pin_update', {
            "room":       room,
            "pinned":     pinned,
            "action":     action,
            "message_id": message_id,
            "by":         username,
        }, to=room)


@socketio.on('react_message')
def on_react_message(data):
    username   = sid_to_user.get(request.sid)
    room       = data.get('room')
    if not username or not room:
        return
    user = get_user_by_username(username)
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


@socketio.on('read_receipt')
def on_read_receipt(data):
    emit('message_read', data, to=data.get('room'))


@socketio.on('e2e_key_exchange')
def on_key_exchange(data):
    """Forward encrypted key to a specific user"""
    from_user = sid_to_user.get(request.sid)
    to_user   = data.get('to')
    if not from_user or not to_user:
        return
    to_sid = connected_users.get(to_user)
    if to_sid:
        emit('e2e_key_received', {
            "from":       from_user,
            "pub_key":    data.get('pub_key'),
            "enc_key":    data.get('enc_key'),
        }, to=to_sid)


def _broadcast_typing(room):
    emit('typing_update', {
        "room":   room,
        "typers": list(typing_users.get(room, set())),
    }, to=room)


# ── Entry ─────────────────────────────────────────────
if __name__ == '__main__':
    print("=" * 50)
    print("  NexChat v3 — Flask-SocketIO")
    print("  http://localhost:5000")
    print("=" * 50)
    init_sqlite()
    socketio.run(app, host='0.0.0.0',
                 port=int(os.environ.get('PORT', 5000)),
                 debug=False)

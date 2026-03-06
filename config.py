"""
config.py — NexChat Configuration
"""
import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    # ── Flask
    SECRET_KEY         = os.getenv('SECRET_KEY', 'nexchat-super-secret-key-change-in-prod')

    # ── JWT
    JWT_SECRET_KEY     = os.getenv('JWT_SECRET_KEY', 'nexchat-jwt-secret-change-in-prod')
    JWT_ACCESS_TOKEN_EXPIRES = 86400   # 24 hours

    # ── SQLite
    SQLITE_DB_PATH     = os.getenv('SQLITE_DB_PATH', 'nexchat.db')

    # ── MongoDB
    MONGO_URI          = os.getenv('MONGO_URI', 'mongodb://localhost:27017/')
    MONGO_DB_NAME      = os.getenv('MONGO_DB_NAME', 'nexchat')

    # ── Google OAuth
    # Get these from: https://console.cloud.google.com/
    GOOGLE_CLIENT_ID   = os.getenv('GOOGLE_CLIENT_ID', '')
    GOOGLE_CLIENT_SECRET = os.getenv('GOOGLE_CLIENT_SECRET', '')

    # ── SocketIO
    CORS_ALLOWED_ORIGINS = os.getenv('CORS_ORIGINS', '*')

    # ── Default rooms
    DEFAULT_ROOMS = ['general', 'random', 'tech']


    CORS_ALLOWED_ORIGINS = "*"

import json
import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
USER_DATA_DIR = Path(os.environ.get('APPDATA', '')) / 'magnify-pos'
DB_PATH = USER_DATA_DIR / 'magnify_waiter.db'
STARTUP_LOG_PATH = USER_DATA_DIR / 'startup.log'
OUTPUT_PATH = ROOT / '.tmp-waiter-live-local.json'


def parse_json(value):
    if not isinstance(value, str):
        return None
    try:
        return json.loads(value)
    except Exception:
        return None


def redact_session_value(key, value):
    parsed = parse_json(value)
    if isinstance(parsed, dict):
        clone = dict(parsed)
        for secret_key in ('token', 'accessToken', 'refreshToken'):
            if isinstance(clone.get(secret_key), str):
                clone[secret_key] = '[REDACTED]'
        return clone
    if 'token' in str(key).lower():
        return '[REDACTED]'
    return value


def fetch_all(cursor, query, params=()):
    cursor.execute(query, params)
    columns = [column[0] for column in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def main():
    result = {
        'devicePaths': {
            'userDataDir': str(USER_DATA_DIR),
            'dbPath': str(DB_PATH),
            'dbExists': DB_PATH.exists(),
            'startupLogPath': str(STARTUP_LOG_PATH),
            'startupLogExists': STARTUP_LOG_PATH.exists(),
        },
        'tables': [],
        'sessionRows': [],
        'configRows': [],
        'orderCounts': {'totalOrders': 0, 'unsyncedOrders': 0},
        'latestOrders': [],
        'recentLogs': [],
        'startupLogTail': [],
    }

    if not DB_PATH.exists():
        raise FileNotFoundError(f'Desktop DB not found at {DB_PATH}')

    connection = sqlite3.connect(f'file:{DB_PATH.as_posix()}?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    try:
        cursor = connection.cursor()
        result['tables'] = [row['name'] for row in fetch_all(cursor, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]

        if 'session' in result['tables']:
            session_rows = fetch_all(cursor, 'SELECT key, value FROM session ORDER BY key')
            result['sessionRows'] = [
                {'key': row['key'], 'value': redact_session_value(row['key'], row['value'])}
                for row in session_rows
            ]

        if 'restaurant_config' in result['tables']:
            config_rows = fetch_all(cursor, 'SELECT key, value FROM restaurant_config ORDER BY key')
            normalized_config = []
            for row in config_rows:
                value = row['value']
                if row['key'] == 'branches':
                    value = parse_json(value) or value
                normalized_config.append({'key': row['key'], 'value': value})
            result['configRows'] = normalized_config

        if 'orders' in result['tables']:
            counts = fetch_all(cursor, 'SELECT COUNT(*) AS totalOrders, SUM(CASE WHEN COALESCE(CAST(synced AS INTEGER), 0) = 0 THEN 1 ELSE 0 END) AS unsyncedOrders FROM orders')[0]
            result['orderCounts'] = {
                'totalOrders': counts['totalOrders'] or 0,
                'unsyncedOrders': counts['unsyncedOrders'] or 0,
            }
            result['latestOrders'] = fetch_all(
                cursor,
                '''
                SELECT id, order_number, status, synced, restaurant_id, branch_id, table_name, created_by_name, created_at, updated_at
                FROM orders
                ORDER BY datetime(created_at) DESC
                LIMIT 5
                ''',
            )

        if 'app_logs' in result['tables']:
            result['recentLogs'] = fetch_all(
                cursor,
                '''
                SELECT id, level, scope, message, details, created_at
                FROM app_logs
                WHERE scope IN ('sync', 'order', 'auth', 'cancel')
                   OR message LIKE '%sync%'
                   OR message LIKE '%order%'
                   OR message LIKE '%auth%'
                ORDER BY datetime(created_at) DESC
                LIMIT 20
                ''',
            )
    finally:
        connection.close()

    if STARTUP_LOG_PATH.exists():
        result['startupLogTail'] = [line for line in STARTUP_LOG_PATH.read_text(encoding='utf-8', errors='replace').splitlines() if line][-40:]

    OUTPUT_PATH.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()

-- Google SSO 対応。
-- users に google_sub / email を追加し、未使用の session_id を削除する。
--
-- session_id は UNIQUE 制約付きなので ALTER TABLE DROP COLUMN では消せず
-- (SQLite: "cannot drop UNIQUE column")、テーブルの作り直しが必要になる。
-- ところが threads が users を FK 参照しているため、素直に DROP TABLE users を
-- すると D1 のコミット時 FK チェックに引っかかる。PRAGMA defer_foreign_keys を
-- 使っても、DROP で発生した違反カウントは親テーブルを作り直しても解消されない。
--
-- そこで子テーブルの行を一旦退避して空にし、users を誰も参照していない状態を
-- 作ってから作り直し、最後に同じテーブルへ書き戻す。書き戻しによって
-- 保留中の FK 違反が解消されるため、コミット時のチェックを通る。
-- SELECT * / INSERT ... SELECT * を使うことで、列構成に依存せず動作する。
PRAGMA defer_foreign_keys = on;

-- 1. 子テーブルを退避(制約なしのプレーンなテーブルにコピー)
CREATE TABLE _bk_notes AS SELECT * FROM notes;
CREATE TABLE _bk_messages AS SELECT * FROM messages;
CREATE TABLE _bk_threads AS SELECT * FROM threads;

-- 2. 子側から順に空にする(この順序を守らないと余計な FK 違反が発生する)
DELETE FROM notes;
DELETE FROM messages;
DELETE FROM threads;

-- 3. users を作り直す。既存ユーザーは threads の持ち主として残すため、
--    実在の Google アカウントと衝突しないプレースホルダ値を入れて温存する。
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  memory TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users_new (id, google_sub, email, name, memory, created_at, updated_at)
  SELECT id, 'legacy:' || id, 'legacy+' || id || '@invalid.local', name, memory, created_at, updated_at
  FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- DROP TABLE で消えたトリガーを貼り直す
CREATE TRIGGER trigger_users_updated_at AFTER UPDATE ON users
BEGIN
  UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- 4. 退避した行を書き戻す(親→子の順)
INSERT INTO threads SELECT * FROM _bk_threads;
INSERT INTO messages SELECT * FROM _bk_messages;
INSERT INTO notes SELECT * FROM _bk_notes;

DROP TABLE _bk_threads;
DROP TABLE _bk_messages;
DROP TABLE _bk_notes;

-- 5. セッション。id はセッショントークンの SHA-256 hex。
--    生のトークンは Cookie にしか存在せず、DB が漏れても復元できない。
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);

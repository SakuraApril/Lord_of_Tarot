-- ============================================================
-- Lord of Tarot · MySQL 8.0 表结构
-- 由 PostgreSQL 迁移而来，迁移说明见 docs/mysql-migration.md
--
-- 与 PG 版的主要差异：
--   1. SERIAL                    → INT AUTO_INCREMENT
--   2. UUID + gen_random_uuid()  → CHAR(36) DEFAULT (UUID())   （需 MySQL 8.0.13+）
--   3. TEXT + UNIQUE             → VARCHAR(191) + UNIQUE       （MySQL 索引需要长度）
--   4. TIMESTAMP DEFAULT NOW()   → DATETIME DEFAULT CURRENT_TIMESTAMP
--   5. credit_transactions.change → delta （CHANGE 是 MySQL 保留字）
--   6. 新增 idempotency_keys / reading_tasks 两张表（幂等 + 异步任务）
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id             INT NOT NULL AUTO_INCREMENT,
  uuid           CHAR(36)     NOT NULL DEFAULT (UUID()),
  email          VARCHAR(191) NOT NULL,
  username       VARCHAR(64)  NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  credits        INT          NOT NULL DEFAULT 3,
  email_verified TINYINT      NOT NULL DEFAULT 0,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_uuid (uuid),
  UNIQUE KEY uk_users_email (email),
  UNIQUE KEY uk_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS readings (
  id          INT          NOT NULL AUTO_INCREMENT,
  user_id     INT          NOT NULL,
  question    TEXT         NOT NULL,
  spread_type VARCHAR(16)  NOT NULL,
  cards_json  TEXT         NOT NULL,
  ai_response MEDIUMTEXT   NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_readings_user (user_id, created_at),
  CONSTRAINT fk_readings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_tokens (
  id         INT          NOT NULL AUTO_INCREMENT,
  user_id    INT          NOT NULL,
  token      VARCHAR(64)  NOT NULL,
  type       VARCHAR(32)  NOT NULL,
  expires_at DATETIME     NOT NULL,
  used       TINYINT      NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_email_tokens_token (token),
  KEY idx_email_tokens_user (user_id),
  CONSTRAINT fk_email_tokens_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS coupons (
  id         INT          NOT NULL AUTO_INCREMENT,
  code       VARCHAR(64)  NOT NULL,
  credits    INT          NOT NULL DEFAULT 1,
  used       TINYINT      NOT NULL DEFAULT 0,
  used_by    INT          NULL,
  used_at    DATETIME     NULL,
  expires_at DATETIME     NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_coupons_code (code),
  CONSTRAINT fk_coupons_user FOREIGN KEY (used_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS credit_transactions (
  id         INT          NOT NULL AUTO_INCREMENT,
  user_id    INT          NOT NULL,
  delta      INT          NOT NULL COMMENT '额度变化量，正为增加负为扣减（PG 版叫 change，CHANGE 是 MySQL 保留字）',
  balance    INT          NOT NULL COMMENT '变动后的余额快照',
  source     VARCHAR(32)  NOT NULL,
  ref_id     INT          NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_credit_transactions_user (user_id, created_at),
  CONSTRAINT fk_credit_transactions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_logs (
  id         INT          NOT NULL AUTO_INCREMENT,
  user_id    INT          NOT NULL,
  ip         VARCHAR(64)  NOT NULL,
  user_agent VARCHAR(512) NULL,
  location   VARCHAR(128) NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_login_logs_user (user_id, created_at),
  CONSTRAINT fk_login_logs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pending_registrations (
  id            INT          NOT NULL AUTO_INCREMENT,
  email         VARCHAR(191) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  username      VARCHAR(64)  NOT NULL,
  token         VARCHAR(64)  NOT NULL,
  expires_at    DATETIME     NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_pending_email (email),
  UNIQUE KEY uk_pending_token (token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 幂等表：客户端每次请求带 request_id，主键冲突即视为重复提交
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  request_id    VARCHAR(64) NOT NULL,
  user_id       INT         NOT NULL,
  endpoint      VARCHAR(64) NOT NULL,
  status        ENUM('processing','done','failed') NOT NULL DEFAULT 'processing',
  response_json MEDIUMTEXT  NULL,
  created_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id),
  KEY idx_idem_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 异步解读任务表：接口只负责入队，worker 消费后回写
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reading_tasks (
  id          INT          NOT NULL AUTO_INCREMENT,
  task_id     CHAR(36)     NOT NULL,
  user_id     INT          NOT NULL,
  question    TEXT         NOT NULL,
  cards_json  TEXT         NOT NULL,
  status      ENUM('queued','processing','done','failed') NOT NULL DEFAULT 'queued',
  reading_id  INT          NULL,
  ai_response MEDIUMTEXT   NULL,
  error       VARCHAR(255) NULL,
  attempts    INT          NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_task_id (task_id),
  KEY idx_task_user (user_id, created_at),
  KEY idx_task_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

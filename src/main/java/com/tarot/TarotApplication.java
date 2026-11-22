package com.tarot;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Lord of Tarot 后端（Spring Boot）
 *
 * 与 legacy-node/ 里的 Node 版实现同一套接口：
 *   POST /api/auth/login | /api/auth/logout | GET /api/auth/me
 *   GET  /api/user/credits | POST /api/user/redeem | GET /api/user/credit-transactions
 *   GET  /api/user/history/{id}            （Redis 缓存）
 *   POST /api/reading/async                （幂等 + 扣额度 + 投 MQ）
 *   GET  /api/reading/task/{taskId}
 *   GET  /api/cards | /api/spreads | /api/health
 */
@SpringBootApplication
public class TarotApplication {
    public static void main(String[] args) {
        SpringApplication.run(TarotApplication.class, args);
    }
}

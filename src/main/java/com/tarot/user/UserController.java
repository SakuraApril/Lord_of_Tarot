package com.tarot.user;

import com.tarot.common.Json;
import com.tarot.common.RedisKeys;
import com.tarot.common.RedisSupport;
import com.tarot.common.UserContext;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * 额度 / 兑换码 / 流水 / 历史详情（历史详情走 Redis 缓存）
 */
@RestController
@RequestMapping("/api/user")
public class UserController {

    private final JdbcTemplate jdbc;
    private final RedisSupport redis;
    private final long cacheTtl;
    private final long cacheJitter;

    public UserController(JdbcTemplate jdbc,
                          RedisSupport redis,
                          @Value("${app.cache.reading-ttl-seconds}") long cacheTtl,
                          @Value("${app.cache.reading-jitter-seconds}") long cacheJitter) {
        this.jdbc = jdbc;
        this.redis = redis;
        this.cacheTtl = cacheTtl;
        this.cacheJitter = cacheJitter;
    }

    @GetMapping("/credits")
    public Map<String, Object> credits() {
        Long credits = jdbc.queryForObject(
                "SELECT credits FROM users WHERE id = ?", Long.class, UserContext.requireUserId());
        return Map.of("credits", credits == null ? 0 : credits);
    }

    /**
     * 兑换码：条件更新防重复使用 → 加额度 → 写流水 → 清用户缓存
     */
    @PostMapping("/redeem")
    @Transactional
    public ResponseEntity<?> redeem(@RequestBody Map<String, String> body) {
        String raw = body.get("code");
        if (raw == null || raw.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "请输入兑换码"));
        }
        String code = raw.trim().toUpperCase();
        long userId = UserContext.requireUserId();
        String uuid = UserContext.get().uuid();

        int updated = jdbc.update("""
                UPDATE coupons SET used = 1, used_by = ?, used_at = NOW()
                WHERE code = ? AND used = 0 AND (expires_at IS NULL OR expires_at > NOW())
                """, userId, code);

        if (updated == 0) {
            List<Map<String, Object>> rows = jdbc.queryForList(
                    "SELECT used, expires_at FROM coupons WHERE code = ?", code);
            if (rows.isEmpty()) return ResponseEntity.badRequest().body(Map.of("error", "无效的兑换码"));
            if (((Number) rows.get(0).get("used")).intValue() == 1) {
                return ResponseEntity.badRequest().body(Map.of("error", "该兑换码已被使用"));
            }
            return ResponseEntity.badRequest().body(Map.of("error", "兑换失败，请稍后重试"));
        }

        Map<String, Object> coupon = jdbc.queryForMap("SELECT id, credits FROM coupons WHERE code = ?", code);
        int add = ((Number) coupon.get("credits")).intValue();
        jdbc.update("UPDATE users SET credits = credits + ?, updated_at = NOW() WHERE id = ?", add, userId);
        Integer balance = jdbc.queryForObject("SELECT credits FROM users WHERE id = ?", Integer.class, userId);
        jdbc.update("""
                INSERT INTO credit_transactions (user_id, delta, balance, source, ref_id)
                VALUES (?, ?, ?, 'redeem', ?)
                """, userId, add, balance, ((Number) coupon.get("id")).longValue());

        redis.delete(RedisKeys.user(uuid));   // 额度变了，用户快照要失效

        return ResponseEntity.ok(Map.of(
                "message", "兑换成功",
                "credits", balance == null ? 0 : balance,
                "added", add));
    }

    @GetMapping("/credit-transactions")
    public Map<String, Object> transactions(@RequestParam(defaultValue = "1") int page,
                                            @RequestParam(defaultValue = "20") int limit) {
        long userId = UserContext.requireUserId();
        int offset = Math.max(0, (page - 1) * limit);
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT id, delta AS `change`, balance, source, ref_id, created_at
                FROM credit_transactions WHERE user_id = ?
                ORDER BY created_at DESC LIMIT ? OFFSET ?
                """, userId, limit, offset);
        Long total = jdbc.queryForObject(
                "SELECT COUNT(*) FROM credit_transactions WHERE user_id = ?", Long.class, userId);
        return Map.of("transactions", rows, "total", total == null ? 0 : total, "page", page);
    }

    /** 历史详情：cache-aside（空值缓存防穿透、互斥锁重建防击穿、TTL 抖动防雪崩） */
    @GetMapping("/history/{id}")
    public ResponseEntity<?> history(@PathVariable long id) {
        long userId = UserContext.requireUserId();
        String key = RedisKeys.reading(userId, id);

        var cached = redis.cacheAside(key, cacheTtl, cacheJitter, () -> {
            List<Map<String, Object>> rows = jdbc.queryForList(
                    "SELECT * FROM readings WHERE id = ? AND user_id = ?", id, userId);
            return rows.isEmpty() ? null : rows.get(0);
        }, Map.class);

        ResponseEntity.BodyBuilder builder = ResponseEntity.ok()
                .header("X-Cache", cached.hit() ? "HIT" : "MISS");
        if (cached.value() == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).header("X-Cache", cached.hit() ? "HIT" : "MISS")
                    .body(Map.of("error", "记录不存在"));
        }
        return builder.body(Map.of("reading", cached.value()));
    }
}

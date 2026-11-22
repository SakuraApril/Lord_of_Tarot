package com.tarot.common;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Redis 缓存与限流（与 Node 版同一套 key 与 Lua 脚本）
 */
@Component
public class RedisSupport {

    /** 空值标记：查不到也缓存一个，防止穿透 */
    public static final String NULL_MARKER = "\u0000__NULL__";

    /**
     * 限流计数脚本：INCR + PEXPIRE 原子执行。
     * 为什么用 Lua：两条命令之间进程崩了会留下「有计数、没 TTL」的 key，导致永久封禁。
     */
    private static final DefaultRedisScript<List> WINDOW_SCRIPT = new DefaultRedisScript<>("""
            local count = redis.call('INCR', KEYS[1])
            if count == 1 then
              redis.call('PEXPIRE', KEYS[1], ARGV[1])
            end
            local ttl = redis.call('PTTL', KEYS[1])
            if ttl < 0 then
              redis.call('PEXPIRE', KEYS[1], ARGV[1])
              ttl = tonumber(ARGV[1])
            end
            return { count, ttl }
            """, List.class);

    private final StringRedisTemplate redis;

    public RedisSupport(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /** 返回 {计数, 剩余秒数} */
    @SuppressWarnings("unchecked")
    public long[] incrWindow(String key, long windowSeconds) {
        List<Long> result = (List<Long>) redis.execute(
                WINDOW_SCRIPT, List.of(key), String.valueOf(windowSeconds * 1000));
        long count = result != null && !result.isEmpty() ? result.get(0) : 0L;
        long ttlMs = result != null && result.size() > 1 ? result.get(1) : windowSeconds * 1000;
        return new long[]{count, Math.max(1, ttlMs / 1000)};
    }

    public void setEx(String key, String value, Duration ttl) {
        redis.opsForValue().set(key, value, ttl);
    }

    public String get(String key) {
        return redis.opsForValue().get(key);
    }

    public void delete(String key) {
        redis.delete(key);
    }

    public boolean exists(String key) {
        return Boolean.TRUE.equals(redis.hasKey(key));
    }

    /** 抢锁：SET NX PX，成功返回 true */
    public boolean tryLock(String key, Duration ttl) {
        return Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(key, "1", ttl));
    }

    /**
     * cache-aside 读：命中返回；未命中抢锁回源；空值写短 TTL 防穿透；TTL 加抖动防雪崩。
     */
    public <T> Cached<T> cacheAside(String key, long ttlSeconds, long jitterSeconds, Loader<T> loader, Class<T> type) {
        String raw = get(key);
        if (raw != null) {
            if (NULL_MARKER.equals(raw)) return new Cached<>(null, true, true);
            try {
                return new Cached<>(Json.MAPPER.readValue(raw, type), true, false);
            } catch (Exception ignored) {
                // 反序列化失败就当未命中
            }
        }

        String lockKey = key + ":lock";
        boolean locked = tryLock(lockKey, Duration.ofSeconds(3));
        if (!locked) {
            sleep(60);
            String retry = get(key);
            if (retry != null && !NULL_MARKER.equals(retry)) {
                try {
                    return new Cached<>(Json.MAPPER.readValue(retry, type), true, false);
                } catch (Exception ignored) { }
            }
            return new Cached<>(loader.load(), false, false);
        }

        try {
            T value = loader.load();
            if (value == null) {
                setEx(key, NULL_MARKER, Duration.ofSeconds(Math.max(5, ttlSeconds / 4)));
            } else {
                long ttl = ttlSeconds + ThreadLocalRandom.current().nextLong(Math.max(1, jitterSeconds));
                setEx(key, Json.MAPPER.writeValueAsString(value), Duration.ofSeconds(ttl));
            }
            return new Cached<>(value, false, false);
        } catch (Exception e) {
            throw new RuntimeException("缓存回源失败", e);
        } finally {
            delete(lockKey);
        }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    @FunctionalInterface
    public interface Loader<T> { T load(); }

    public record Cached<T>(T value, boolean hit, boolean empty) {}
}

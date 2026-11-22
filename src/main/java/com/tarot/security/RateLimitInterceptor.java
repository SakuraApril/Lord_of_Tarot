package com.tarot.security;

import com.tarot.common.Json;
import com.tarot.common.RedisKeys;
import com.tarot.common.RedisSupport;
import com.tarot.common.UserContext;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 限流拦截器
 *
 * 分层策略（和 Node 版一致）：
 *   静态只读接口（/api/cards、/api/spreads、/api/health）→ 进程内计数，不碰 Redis
 *   有成本的接口（login / redeem / reading）→ Redis + Lua 原子计数，多实例共享
 *
 * Redis 不可用时放行：限流是保护措施，不能反过来把业务卡死。
 */
@Component
public class RateLimitInterceptor implements HandlerInterceptor {

    private record Rule(String scope, long windowSeconds, long max, boolean useRedis) {}

    private static final Map<String, Rule> RULES = new LinkedHashMap<>();

    static {
        RULES.put("/api/auth/login", new Rule("auth", 900, 500, true));
        RULES.put("/api/auth/logout", new Rule("auth", 900, 500, true));
        RULES.put("/api/user/redeem", new Rule("redeem", 60, 3, true));
        RULES.put("/api/reading", new Rule("reading", 300, 15, true));
        RULES.put("/api/", new Rule("api", 900, 200, false));
    }

    private final RedisSupport redis;
    private final Map<String, long[]> localBuckets = new ConcurrentHashMap<>();

    public RateLimitInterceptor(RedisSupport redis) {
        this.redis = redis;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        String path = request.getRequestURI();
        Rule rule = resolve(path);
        if (rule == null) return true;

        // 轮询任务状态是 GET，不占用起卦额度
        if (rule.scope().equals("reading") && !"POST".equalsIgnoreCase(request.getMethod())) {
            return true;
        }

        String identity = request.getHeader("Authorization");
        if (identity == null) identity = clientIp(request);
        if (rule.scope().equals("reading") || rule.scope().equals("redeem")) {
            // 按用户维度限流：先从 token 里拿 uuid，失败退回 IP
            String uuid = tryReadUuid(request);
            if (uuid != null) identity = uuid;
        }

        long count;
        long ttl;
        if (rule.useRedis()) {
            long[] r = redis.incrWindow(RedisKeys.rateLimit(rule.scope(), identity), rule.windowSeconds());
            count = r[0];
            ttl = r[1];
            response.setHeader("X-RateLimit-Scope", "redis");
        } else {
            long now = System.currentTimeMillis() / 1000;
            String key = rule.scope() + ":" + clientIp(request);
            long[] bucket = localBuckets.computeIfAbsent(key, k -> new long[]{now, 0});
            synchronized (bucket) {
                if (now - bucket[0] >= rule.windowSeconds()) {
                    bucket[0] = now;
                    bucket[1] = 0;
                }
                bucket[1]++;
                count = bucket[1];
                ttl = Math.max(1, bucket[0] + rule.windowSeconds() - now);
            }
            response.setHeader("X-RateLimit-Scope", "local");
        }

        response.setHeader("X-RateLimit-Limit", String.valueOf(rule.max()));
        response.setHeader("X-RateLimit-Remaining", String.valueOf(Math.max(0, rule.max() - count)));
        response.setHeader("X-RateLimit-Reset", String.valueOf(ttl));

        if (count > rule.max()) {
            response.setStatus(429);
            response.setHeader("Retry-After", String.valueOf(ttl));
            response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write(Json.MAPPER.writeValueAsString(Map.of(
                    "error", "请求过于频繁，请 " + ttl + " 秒后再试",
                    "code", "RATE_LIMITED",
                    "scope", rule.scope(),
                    "retryAfter", ttl)));
            return false;
        }
        return true;
    }

    private Rule resolve(String path) {
        // 精确匹配优先，其次最长前缀
        Rule best = null;
        int bestLen = -1;
        for (Map.Entry<String, Rule> e : RULES.entrySet()) {
            String prefix = e.getKey();
            boolean match = prefix.endsWith("/") ? path.startsWith(prefix) : path.equals(prefix);
            if (match && prefix.length() > bestLen) {
                best = e.getValue();
                bestLen = prefix.length();
            }
        }
        return best;
    }

    private String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) return forwarded.split(",")[0].trim();
        return request.getRemoteAddr();
    }

    private String tryReadUuid(HttpServletRequest request) {
        UserContext.CurrentUser u = UserContext.get();
        if (u != null) return u.uuid();
        return null;
    }
}

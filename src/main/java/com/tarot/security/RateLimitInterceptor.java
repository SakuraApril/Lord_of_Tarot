package com.tarot.security;

import com.tarot.common.Json;
import com.tarot.common.RedisKeys;
import com.tarot.common.RedisSupport;
import com.tarot.common.UserContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 限流拦截器
 *
 * 分层策略（和 legacy-node 版一致）：
 *   静态只读接口（/api/cards、/api/spreads、/api/health）→ 进程内计数，不碰 Redis
 *   有成本的接口（login / redeem / reading）→ Redis + Lua 原子计数，多实例共享
 *
 * 上限由配置注入（app.rate-limit.*），压测时用环境变量调大，线上用默认值。
 * Redis 不可用时放行：限流是保护措施，不能反过来把业务卡死。
 */
@Component
public class RateLimitInterceptor implements HandlerInterceptor {

    private record Rule(String scope, long windowSeconds, long max, boolean useRedis) {}

    private final RedisSupport redis;
    private final Map<String, Rule> rules = new LinkedHashMap<>();
    private final Map<String, long[]> localBuckets = new ConcurrentHashMap<>();

    public RateLimitInterceptor(RedisSupport redis,
                                @Value("${app.rate-limit.api-max:200}") long apiMax,
                                @Value("${app.rate-limit.auth-max:500}") long authMax,
                                @Value("${app.rate-limit.redeem-max:3}") long redeemMax,
                                @Value("${app.rate-limit.reading-max:15}") long readingMax) {
        this.redis = redis;
        rules.put("/api/auth/login", new Rule("auth", 900, authMax, true));
        rules.put("/api/auth/logout", new Rule("auth", 900, authMax, true));
        rules.put("/api/user/redeem", new Rule("redeem", 60, redeemMax, true));
        rules.put("/api/reading", new Rule("reading", 300, readingMax, true));
        rules.put("/api/", new Rule("api", 900, apiMax, false));
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        String path = request.getRequestURI();
        Rule rule = resolve(path);
        if (rule == null) return true;

        // 轮询任务状态是 GET，不占用起卦额度
        if ("reading".equals(rule.scope()) && !"POST".equalsIgnoreCase(request.getMethod())) {
            return true;
        }

        String identity = request.getHeader("Authorization");
        if (identity == null) identity = clientIp(request);
        if ("reading".equals(rule.scope()) || "redeem".equals(rule.scope())) {
            UserContext.CurrentUser u = UserContext.get();
            if (u != null) identity = u.uuid();
        }

        long count;
        long ttl;
        if (rule.useRedis()) {
            long[] r;
            try {
                r = redis.incrWindow(RedisKeys.rateLimit(rule.scope(), identity), rule.windowSeconds());
            } catch (Exception e) {
                return true;   // Redis 故障 → 放行
            }
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

    /** 精确匹配优先，其次最长前缀 */
    private Rule resolve(String path) {
        Rule best = null;
        int bestLen = -1;
        for (Map.Entry<String, Rule> e : rules.entrySet()) {
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
}

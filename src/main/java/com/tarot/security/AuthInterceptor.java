package com.tarot.security;

import com.tarot.common.Json;
import com.tarot.common.JwtService;
import com.tarot.common.RedisKeys;
import com.tarot.common.RedisSupport;
import com.tarot.common.UserContext;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * 鉴权拦截器（对应 Node 版的 authGuard + session.js）
 *
 * 流程：解析 JWT → 查 jti 黑名单 → 取用户快照（Redis，5 分钟）→ 未命中查库并回填
 * 通过后写入 UserContext（ThreadLocal），请求结束务必清理。
 */
@Component
public class AuthInterceptor implements HandlerInterceptor {

    private static final long USER_TTL_SECONDS = 300;

    private final JwtService jwt;
    private final RedisSupport redis;
    private final JdbcTemplate jdbc;

    public AuthInterceptor(JwtService jwt, RedisSupport redis, JdbcTemplate jdbc) {
        this.jwt = jwt;
        this.redis = redis;
        this.jdbc = jdbc;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) return true;

        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            return reject(response, "请先登录");
        }

        Claims claims;
        try {
            claims = jwt.parse(header.substring(7));
        } catch (Exception e) {
            return reject(response, "登录已过期，请重新登录");
        }

        String jti = claims.get("jti", String.class);
        if (jti != null && redis.exists(RedisKeys.revoked(jti))) {
            return reject(response, "登录已过期，请重新登录");
        }

        String uuid = claims.getSubject();
        UserContext.CurrentUser user = loadUser(uuid, response);
        if (user == null) {
            return reject(response, "用户不存在");
        }
        UserContext.set(user);
        return true;
    }

    private UserContext.CurrentUser loadUser(String uuid, HttpServletResponse response) {
        String cached = redis.get(RedisKeys.user(uuid));
        if (cached != null) {
            response.setHeader("X-Auth-Cache", "HIT");
            try {
                @SuppressWarnings("unchecked")
                Map<String, Object> m = Json.MAPPER.readValue(cached, Map.class);
                return new UserContext.CurrentUser(
                        ((Number) m.get("id")).longValue(),
                        (String) m.get("uuid"),
                        (String) m.get("email"),
                        (String) m.get("username"),
                        ((Number) m.get("credits")).intValue());
            } catch (Exception ignored) {
                // 缓存坏了就回源
            }
        }

        response.setHeader("X-Auth-Cache", "MISS");
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT id, uuid, email, username, credits FROM users WHERE uuid = ?", uuid);
        if (rows.isEmpty()) return null;

        Map<String, Object> row = rows.get(0);
        UserContext.CurrentUser user = new UserContext.CurrentUser(
                ((Number) row.get("id")).longValue(),
                (String) row.get("uuid"),
                (String) row.get("email"),
                (String) row.get("username"),
                ((Number) row.get("credits")).intValue());

        try {
            redis.setEx(RedisKeys.user(uuid), Json.MAPPER.writeValueAsString(row), Duration.ofSeconds(USER_TTL_SECONDS));
        } catch (Exception ignored) { }
        return user;
    }

    private boolean reject(HttpServletResponse response, String message) throws Exception {
        response.setStatus(401);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write(Json.MAPPER.writeValueAsString(Map.of("error", message)));
        return false;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) {
        UserContext.clear();
    }
}

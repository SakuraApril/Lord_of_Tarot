package com.tarot.auth;

import com.tarot.common.Json;
import com.tarot.common.JwtService;
import com.tarot.common.RedisKeys;
import com.tarot.common.RedisSupport;
import com.tarot.common.UserContext;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 登录 / 登出 / 当前用户
 *
 * 与 Node 版一致：bcrypt 校验密码，签发带 jti 的 JWT；
 * 登出把 jti 写进 Redis 黑名单（TTL 到 token 过期为止），并清掉用户快照。
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final JdbcTemplate jdbc;
    private final JwtService jwt;
    private final RedisSupport redis;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    public AuthController(JdbcTemplate jdbc, JwtService jwt, RedisSupport redis) {
        this.jdbc = jdbc;
        this.jwt = jwt;
        this.redis = redis;
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody Map<String, String> body, HttpServletRequest request) {
        String login = body.get("login");
        String password = body.get("password");
        if (login == null || password == null || login.isBlank() || password.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "请输入登录凭证和密码"));
        }

        String sql = login.contains("@")
                ? "SELECT id, uuid, email, username, password_hash, credits, email_verified FROM users WHERE email = ?"
                : "SELECT id, uuid, email, username, password_hash, credits, email_verified FROM users WHERE username = ?";
        List<Map<String, Object>> rows = jdbc.queryForList(sql, login);
        if (rows.isEmpty() || !encoder.matches(password, (String) rows.get(0).get("password_hash"))) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("error", "账号或密码错误"));
        }

        Map<String, Object> user = rows.get(0);
        long userId = ((Number) user.get("id")).longValue();
        String uuid = (String) user.get("uuid");
        String email = (String) user.get("email");

        String token = jwt.sign(userId, uuid, email);

        // 登录日志（与 Node 版保持同一张表）
        try {
            jdbc.update("INSERT INTO login_logs (user_id, ip, user_agent) VALUES (?, ?, ?)",
                    userId,
                    clientIp(request),
                    String.valueOf(request.getHeader("User-Agent")));
        } catch (Exception ignored) { }

        Map<String, Object> resp = new HashMap<>();
        resp.put("token", token);
        resp.put("user", Map.of(
                "id", userId,
                "uuid", uuid,
                "email", email,
                "username", user.get("username"),
                "credits", user.get("credits")));
        return ResponseEntity.ok(resp);
    }

    @PostMapping("/logout")
    public ResponseEntity<?> logout(HttpServletRequest request) {
        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            return ResponseEntity.ok(Map.of("ok", true, "note", "未携带 token"));
        }
        try {
            Claims claims = jwt.parse(header.substring(7));
            String jti = claims.get("jti", String.class);
            long ttl = Math.max(1, (claims.getExpiration().getTime() - System.currentTimeMillis()) / 1000);
            if (jti != null) {
                redis.setEx(RedisKeys.revoked(jti), "1", Duration.ofSeconds(ttl));
            }
            redis.delete(RedisKeys.user(claims.getSubject()));
            return ResponseEntity.ok(Map.of("ok", true, "revoked", jti != null, "ttl", ttl));
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("error", "令牌无效"));
        }
    }

    @GetMapping("/me")
    public ResponseEntity<?> me() {
        UserContext.CurrentUser u = UserContext.get();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("error", "请先登录"));
        return ResponseEntity.ok(Map.of(
                "id", u.id(), "uuid", u.uuid(), "email", u.email(),
                "username", u.username(), "credits", u.credits()));
    }

    private String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) return forwarded.split(",")[0].trim();
        return request.getRemoteAddr();
    }
}
